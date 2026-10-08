'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell } = require('electron');

const { PROVIDERS, readConfig, writeConfig, publicConfig } = require('./store');
const { testConnection } = require('./agent/llm');
const { runAgent } = require('./agent/loop');
const { buildSystemPrompt } = require('./agent/prompt');
const py = require('./runtime/python');
const drawio = require('./runtime/drawio');
const { getSkillsRoot, getDefaultWorkspace, getUserDataDir, getBrandDir } = require('./paths');
const license = require('./license');
const snapshot = require('./snapshot');

let currentAbort = null;

function sessionsDir(workspace) {
  return path.join(workspace, '.mcm-agent', 'sessions');
}

function safeName(name) {
  return String(name || '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80);
}

/**
 * 客户按四类分别提交材料。分类是**固定四项**，不接受任意值 ——
 * 否则前端传个 `../..` 就能把文件写到工作区外面去。
 */
const INPUT_CATS = [
  { key: '赛题', label: '竞赛赛题', hint: 'PDF / DOCX / 图片 / 文本' },
  { key: '规范', label: '格式规范', hint: '当届官方规范 / 参赛须知' },
  { key: '模板', label: '论文模板', hint: '.docx / .tex / 模板目录' },
  { key: '数据', label: '赛题数据', hint: 'XLSX / CSV / 压缩包 / 多附件' },
];

/** 只接受四个已知分类；其余一律非法（防路径穿越） */
function safeCatKey(cat) {
  const c = INPUT_CATS.find((x) => x.key === String(cat || ''));
  return c ? c.key : null;
}

function catLabel(cat) {
  const c = INPUT_CATS.find((x) => x.key === String(cat || ''));
  return c ? c.label : '材料';
}

/**
 * 建工作区并预置标准目录。
 *
 * figures/ code/ results/ reports/ 是本流程的约定。不预建的话，
 * 模型写 `savefig('figures/x.png')` 会因父目录不存在直接失败 ——
 * matplotlib 不会自动创建目录，而这类失败很容易被当成"图画不出来"。
 *
 * input/<分类>/ 是客户按四类分别提交材料的地方。
 */
function ensureWorkspaceDirs(ws) {
  fs.mkdirSync(ws, { recursive: true });
  for (const d of ['figures', 'code', 'results', 'reports']) {
    fs.mkdirSync(path.join(ws, d), { recursive: true });
  }
  for (const c of INPUT_CATS) {
    fs.mkdirSync(path.join(ws, 'input', c.key), { recursive: true });
  }
  return ws;
}

/** 同名文件不覆盖，自动加 (2) (3) 后缀 */
function uniquePath(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let i = 2; i < 1000; i += 1) {
    const p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return dest;
}

/** 递归复制目录（Node 16+ 的 cpSync 在 Electron 里可用，但显式递归更可控） */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * 把客户提交的材料复制到 <workspace>/input/<分类>/。
 * 同名自动加序号不覆盖。
 * 返回逐项结果，失败项带原因（前端要如实显示，不能假装都成功了）。
 */
function importInputs(cat, srcPaths) {
  const key = safeCatKey(cat);
  if (!key) return { cat: null, files: [{ ok: false, name: String(cat), error: '未知分类' }] };

  const ws = ensureWorkspaceDirs(readConfig().workspace || getDefaultWorkspace());
  const dir = path.join(ws, 'input', key);
  const list = Array.isArray(srcPaths) ? srcPaths : [];
  const files = [];
  for (const src of list) {
    try {
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        const dest = uniquePath(path.join(dir, path.basename(src)));
        copyDirSync(src, dest);
        files.push({ ok: true, name: path.basename(dest), kind: 'dir', bytes: 0 });
      } else if (st.isFile()) {
        const dest = uniquePath(path.join(dir, path.basename(src)));
        fs.copyFileSync(src, dest);
        files.push({ ok: true, name: path.basename(dest), kind: 'file', bytes: st.size });
      } else {
        files.push({ ok: false, name: path.basename(String(src)), error: '既不是文件也不是目录' });
      }
    } catch (err) {
      files.push({ ok: false, name: path.basename(String(src)), error: err.message });
    }
  }
  return { cat: key, files };
}

function registerIpc(getWindow) {
  const send = (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', payload);
  };


  /**
   * 授权门禁。
   *
   * ⚠️ 这是**多处埋点**中的一处 —— 只在校验一个地方，改一行前端就绕过去了。
   * 所以在每个"能产出价值"的操作上都查一遍：
   * 发消息、导材料、出图、看产物、存会话、装运行环境。
   *
   * 但 license:* 和 config:* 必须放行 —— 否则用户连激活和配置都做不到。
   */
  function licenseBlocked() {
    const st = license.getLicenseState(getUserDataDir());
    if (st.mode === 'expired' || st.mode === 'none') {
      return { blocked: true, mode: st.mode, error: '体验已结束。激活后即可继续使用。' };
    }
    // 未拦截时把完整授权状态带回 —— 调用方（如体验版打水印）不用再算一遍
    return { blocked: false, state: st };
  }

  /* ---------------- 授权 ---------------- */

  /** 当前授权状态（activated / trial / expired / none） */
  ipcMain.handle('license:state', () => {
    const st = license.getLicenseState(getUserDataDir());
    return { ok: true, ...st };
  });

  /** 机器码 —— 给用户复制去发给客服 */
  ipcMain.handle('license:machine', () => {
    const m = license.getMachineCode(getUserDataDir());
    return {
      ok: true,
      machine: m.code,
      pretty: m.code.match(/.{1,4}/g).join('-'),
      degraded: m.degraded,   // 硬件信息取不全时指纹强度不够，要提醒用户
    };
  });

  /**
   * 二维码图片（data URL）。
   *   wechat —— 加好友码（**现在只用这个**：付款环节挪到微信里聊了）
   *   pay    —— 收款码，保留但软件里不再展示；打包时也不进包
   * 图片打包在 <resources>/brand/ 下。
   *
   * ⚠️ 默认值必须是 wechat —— pay-qr.png 不进包了，
   * 要是默认走 pay，一个漏传 kind 的调用就会读到不存在的文件。
   */
  ipcMain.handle('license:qr', (_e, kind) => {
    const file = kind === 'pay' ? 'pay-qr.png' : 'wechat-qr.png';
    const f = path.join(getBrandDir(), file);
    try {
      return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64') };
    } catch {
      console.error('[license] 二维码读不到：' + f);
      return { ok: false, error: '二维码图片缺失：' + file };
    }
  });

  /**
   * 用卡密激活。
   *
   * ⚠️ 验签失败时**不告诉用户具体哪里错** —— 否则等于帮攻击者定位问题
   * （"签名不合法" 和 "机器码不匹配" 对破解者是有用信息）。
   * 详细原因只写进日志，界面上统一说"卡密无效"。
   */
  ipcMain.handle('license:activate', (_e, { credential }) => {
    const ud = getUserDataDir();
    const machine = license.getMachineCode(ud);
    const v = license.verifyCredential(credential, machine.code);
    if (!v.ok) {
      console.warn('[license] 激活被拒：' + v.why + '  机器码=' + machine.code);
      return { ok: false, error: '卡密无效，或不是给这台电脑签发的。请核对后重试，或联系客服。' };
    }
    license.writeState(ud, { credential });
    console.log('[license] 激活成功：' + v.payload.card + '  机器码=' + machine.code);
    return { ok: true, ...license.getLicenseState(ud) };
  });

  /* ---------------- 配置 ---------------- */

  ipcMain.handle('config:get', () => ({
    config: publicConfig(),
    providers: PROVIDERS,
    skillsRoot: getSkillsRoot(),
  }));

  ipcMain.handle('config:save', (_e, patch) => {
    const clean = { ...patch };
    if (clean.apiKey === undefined || clean.apiKey === '') delete clean.apiKey;
    writeConfig(clean);
    return publicConfig();
  });

  ipcMain.handle('config:test', async (_e, override) => {
    const cfg = { ...readConfig(), ...(override || {}) };
    if (!cfg.apiKey) cfg.apiKey = readConfig().apiKey;
    try {
      return await testConnection(cfg);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---------------- 工作区 ---------------- */

  ipcMain.handle('workspace:choose', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: '选择工作区目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: readConfig().workspace || getDefaultWorkspace(),
    });
    if (r.canceled || !r.filePaths.length) return null;
    const ws = r.filePaths[0];
    writeConfig({ workspace: ws });
    return ws;
  });

  ipcMain.handle('workspace:ensure', () => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    ensureWorkspaceDirs(ws);
    if (!readConfig().workspace) writeConfig({ workspace: ws });
    return ws;
  });

  /* ---------------- 输入材料（拖拽导入） ----------------
   * 客户把赛题 / 格式规范 / 论文模板 / 赛题数据一起拖进来，
   * 客户按四类分别提交，落在 <workspace>/input/<分类>/。
   * 分槽位的好处：客户一眼知道该给什么，Agent 也不用猜哪份是什么。
   */

  ipcMain.handle('input:list', () => {
    const ws = ensureWorkspaceDirs(readConfig().workspace || getDefaultWorkspace());
    const cats = INPUT_CATS.map((c) => {
      const dir = path.join(ws, 'input', c.key);
      const files = [];
      if (fs.existsSync(dir)) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          let bytes = 0;
          if (e.isFile()) {
            try {
              bytes = fs.statSync(full).size;
            } catch {
              bytes = 0;
            }
          }
          files.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', bytes });
        }
      }
      return { key: c.key, label: c.label, hint: c.hint, files };
    });
    return { dir: 'input', cats };
  });

  ipcMain.handle('input:import', (_e, cat, srcPaths) => {
    const g = licenseBlocked();
    if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error };  // 材料导入
    return importInputs(cat, srcPaths);
  });

  /** 不想拖的时候，走系统选择框 */
  ipcMain.handle('input:pick', async (_e, cat) => {
    const label = catLabel(cat);
    const r = await dialog.showOpenDialog(getWindow(), {
      title: `选择「${label}」的文件`,
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { cat, files: [] };
    return importInputs(cat, r.filePaths);
  });

  ipcMain.handle('input:remove', (_e, cat, name) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const key = safeCatKey(cat);
    if (!key) return { ok: false, error: '未知分类' };
    const dir = path.resolve(path.join(ws, 'input', key));
    const target = path.resolve(dir, String(name || ''));
    // 防越界：目标必须真的在这个分类目录下
    if (path.dirname(target) !== dir) return { ok: false, error: '路径越界' };
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('input:openDir', (_e, cat) => {
    const ws = ensureWorkspaceDirs(readConfig().workspace || getDefaultWorkspace());
    const key = safeCatKey(cat);
    shell.openPath(key ? path.join(ws, 'input', key) : path.join(ws, 'input'));
    return true;
  });

  ipcMain.handle('workspace:list', (_e, rel) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const dir = rel ? path.resolve(ws, rel) : ws;
    if (!path.relative(ws, dir).startsWith('..') === false && path.relative(ws, dir) !== '') {
      return [];
    }
    if (!fs.existsSync(dir)) return [];
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== '.mcm-agent')
      .map((d) => {
        const full = path.join(dir, d.name);
        let size = 0;
        try {
          size = d.isFile() ? fs.statSync(full).size : 0;
        } catch {
          /* ignore */
        }
        return {
          name: d.name,
          rel: path.relative(ws, full).replace(/\\/g, '/'),
          isDir: d.isDirectory(),
          size,
          mtime: (() => {
            try {
              return fs.statSync(full).mtimeMs;
            } catch {
              return 0;
            }
          })(),
        };
      })
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));
    return items;
  });

  /**
   * 在资源管理器里打开工作区内的路径。
   *
   * ⚠️ 越界检查不能少 —— read / dataUrl / reveal 都查了，这里以前漏了：
   * rel 传绝对路径（`C:\\Windows`）或 `..\\..\\..` 时，path.resolve 直接跳出工作区，
   * 于是可以拿这个通道在用户机器上打开任意目录。
   */
  ipcMain.handle('workspace:openPath', (_e, rel) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const abs = path.resolve(ws, rel || '.');
    const relCheck = path.relative(ws, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      return { ok: false, error: '路径越界' };
    }
    shell.openPath(abs);
    return { ok: true };
  });

  ipcMain.handle('workspace:reveal', (_e, rel) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error }; } // 打开产物
    const ws = readConfig().workspace || getDefaultWorkspace();
    shell.showItemInFolder(path.resolve(ws, rel || '.'));
    return true;
  });

  ipcMain.handle('workspace:read', (_e, rel) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const abs = path.resolve(ws, rel || '');
    if (path.relative(ws, abs).startsWith('..')) return '（路径越界）';
    if (!fs.existsSync(abs)) return '（文件不存在）';
    const st = fs.statSync(abs);
    if (st.size > 3 * 1024 * 1024) return `（文件过大：${(st.size / 1048576).toFixed(1)}MB，请用系统程序打开）`;
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch (e) {
      return `（读取失败：${e.message}）`;
    }
  });

  ipcMain.handle('workspace:dataUrl', (_e, rel) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const abs = path.resolve(ws, rel || '');
    if (path.relative(ws, abs).startsWith('..')) return '';
    if (!fs.existsSync(abs)) return '';
    const ext = path.extname(abs).toLowerCase();
    const mime =
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
      }[ext] || 'application/octet-stream';
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length > 40 * 1024 * 1024) return '';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return '';
    }
  });

  /* ---------------- 会话 ---------------- */

  ipcMain.handle('session:list', () => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const dir = sessionsDir(ws);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        let title = f.replace(/\.json$/, '');
        let updated = 0;
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8'));
          title = j.title || title;
          updated = j.updated || fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { id: f.replace(/\.json$/, ''), title, updated };
      })
      .sort((a, b) => b.updated - a.updated);
  });

  ipcMain.handle('session:save', (_e, { id, title, messages }) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error }; } // 保存会话
    const ws = readConfig().workspace || getDefaultWorkspace();
    const dir = sessionsDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    const sid = safeName(id) || `session-${Date.now()}`;
    fs.writeFileSync(
      path.join(dir, `${sid}.json`),
      JSON.stringify({ id: sid, title: title || '未命名', messages, updated: Date.now() }, null, 2),
      'utf8'
    );
    return sid;
  });

  ipcMain.handle('session:load', (_e, id) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const full = path.join(sessionsDir(ws), `${safeName(id)}.json`);
    if (!fs.existsSync(full)) return null;
    try {
      return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('session:delete', (_e, id) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const full = path.join(sessionsDir(ws), `${safeName(id)}.json`);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return true;
  });

  /**
   * 回滚产物：把工作区里在 `since` 之后被创建/修改的文件挪进 _backup/<时间戳>/。
   * 具体逻辑在 ./rollback.js（抽出去是为了能脱离 electron 单测）。
   */
  ipcMain.handle('session:rollback', (_e, { since }) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error }; }
    const ws = readConfig().workspace || getDefaultWorkspace();
    const r = rollbackWorkspace(ws, since);
    if (r.ok && r.moved && r.moved.length) {
      console.log(`[rollback] 移走 ${r.moved.length} 个产物 → ${r.backup}`);
    }
    return r;
  });

  /* ---------------- 工作区快照（回滚用） ----------------
   * 和上面的 session:rollback 是两套东西：
   *   session:rollback  —— 老逻辑，按文件 mtime 把「新产物」挪进 _backup，被覆盖的还原不回来
   *   snapshot:*        —— 每轮开始前整体拍一张，回滚时**整体还原**，覆盖/新增/删除都能回去
   */

  ipcMain.handle('snapshot:create', (_e, meta) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const r = snapshot.createSnapshot(getUserDataDir(), ws, meta || {});
    if (r.ok) {
      console.log(`[snapshot] ${r.id}  ${r.count} 个文件 ${(r.bytes / 1048576).toFixed(1)}MB（硬链接复用 ${r.linked}）`);
    } else {
      console.warn('[snapshot] 拍快照失败：' + r.error);
    }
    return r;
  });

  ipcMain.handle('snapshot:list', () => ({
    ok: true,
    list: snapshot.listSnapshots(getUserDataDir()),
    bytes: snapshot.totalBytes(getUserDataDir()),
    keep: snapshot.KEEP,
  }));

  ipcMain.handle('snapshot:restore', (_e, id) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error }; }
    const ws = readConfig().workspace || getDefaultWorkspace();
    const r = snapshot.restoreSnapshot(getUserDataDir(), id, ws);
    if (r.ok) {
      console.log(`[snapshot] 还原到 ${id}：挪走 ${r.moved} 项，拷回 ${r.restored} 个文件`);
    } else {
      console.warn('[snapshot] 还原失败：' + r.error);
    }
    return r;
  });

  /* ---------------- Python 运行时 ---------------- */

  ipcMain.handle('python:status', async () => {
    const cfg = readConfig();
    const interpreters = await py.detectPython();
    const active = cfg.pythonPath || py.getVenvPython() || interpreters[0]?.exe || '';
    let deps = null;
    if (active) deps = await py.checkPackages(active);
    return { interpreters, active, deps, groups: py.PACKAGE_GROUPS, venvDir: py.getVenvDir() };
  });

  ipcMain.handle('python:setup', async (_e, basePython) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error }; } // 装运行环境
    try {
      const base = basePython || (await py.detectPython())[0]?.exe;
      if (!base) return { ok: false, error: '未检测到系统 Python，请先安装 Python 3.10+' };
      const venvPython = await py.ensureVenv(base, (chunk) => send({ type: 'python:output', ...chunk }));
      const r = await py.installPackages(venvPython, py.ALL_GROUPS, (chunk) => send({ type: 'python:output', ...chunk }));
      writeConfig({ pythonPath: venvPython });
      const deps = await py.checkPackages(venvPython);
      return { ok: r.ok, venvPython, deps };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('python:setPath', (_e, p) => {
    writeConfig({ pythonPath: p });
    return true;
  });

  /* ---------------- draw.io 桌面版 ---------------- */

  ipcMain.handle('drawio:status', () => {
    const exe = drawio.detectDrawio(true);
    return { available: Boolean(exe), path: exe || '', candidates: drawio.candidatePaths() };
  });

  ipcMain.handle('drawio:export', async (_e, { file, format, crop, scale }) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error }; } // 出图
    const ws = readConfig().workspace || getDefaultWorkspace();
    const exe = drawio.detectDrawio();
    if (!exe) {
      return { ok: false, error: '未检测到 draw.io 桌面版。请先安装后重试（https://github.com/jgraph/drawio-desktop/releases）。' };
    }

    const input = path.resolve(ws, file);
    if (path.relative(ws, input).startsWith('..')) return { ok: false, error: '路径越界' };
    if (!fs.existsSync(input)) return { ok: false, error: `文件不存在：${file}` };

    const fmt = format === 'png' ? 'png' : 'pdf';
    const out = input.replace(/\.drawio$/i, fmt === 'pdf' ? '.pdf' : '.png');

    const r = await drawio.exportFigure(exe, input, out, {
      format: fmt,
      crop: crop !== false,
      scale: scale || 1.5,
      onOutput: (chunk) => send({ type: 'drawio:output', ...chunk }),
    });
    return { ...r, file: path.relative(ws, out).replace(/\\/g, '/') };
  });

  /* ---------------- 对话 ---------------- */

  ipcMain.handle('chat:send', async (_e, { messages, sessionId, title, timeoutMs }) => {
    // ⚠️ 授权拦截必须在**主进程** —— 放渲染层的话，改一行前端就绕过去了。
    // 体验期内正常用；到期或未激活直接拒绝。
    const gate = licenseBlocked();
    if (gate.blocked) return { ok: false, licenseBlocked: true, error: gate.error };

    // 体验版给产出加水印。
    //
    // ⚠️ 走环境变量而不是提示词 —— 提示词是"请求 AI 记得加"，它会忘；
    // 环境变量是技能库脚本**自己检查**，AI 绕不过去（除非它不用技能库自己手写绘图）。
    // tools.js 的 runProcess 是 `env: { ...process.env, ... }`，所以在这里设就够了。
    const lic = gate.state;
    if (lic.mode === 'trial') {
      process.env.MCM_TRIAL = '1';
    } else {
      delete process.env.MCM_TRIAL;
    }
    const wm = readConfig().watermark;
    if (wm) process.env.MCM_WATERMARK = String(wm);
    else delete process.env.MCM_WATERMARK;

    const cfg = readConfig();
    if (!cfg.apiKey) return { ok: false, error: '尚未配置 API Key，请先在设置里填写。' };
    if (!cfg.model) return { ok: false, error: '尚未选择模型。' };

    const ws = ensureWorkspaceDirs(cfg.workspace || getDefaultWorkspace());
    if (!cfg.workspace) writeConfig({ workspace: ws });

    const skillsRoot = getSkillsRoot();
    // 单次请求可以覆盖空闲超时（重试卡片用）
    const runCfg = timeoutMs ? { ...cfg, streamIdleMs: timeoutMs } : cfg;
    const system = { role: 'system', content: buildSystemPrompt({ workspace: ws, skillsRoot, config: cfg }) };
    const convo = [system, ...messages];

    currentAbort = new AbortController();
    try {
      const out = await runAgent({
        config: runCfg,
        workspace: ws,
        skillsRoot,
        messages: convo,
        emit: send,
        signal: currentAbort.signal,
        pythonPath: cfg.pythonPath || py.getVenvPython() || 'python',
      });

      // 落盘会话（去掉 system，避免重复注入）
      if (sessionId) {
        const persist = out.messages.filter((m) => m.role !== 'system');
        const dir = sessionsDir(ws);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${safeName(sessionId)}.json`),
          JSON.stringify({ id: sessionId, title: title || '未命名', messages: persist, updated: Date.now() }, null, 2),
          'utf8'
        );
      }
      return { ok: true, messages: out.messages.filter((m) => m.role !== 'system') };
    } catch (err) {
      send({ type: 'error', message: err.message });
      return { ok: false, error: err.message };
    } finally {
      currentAbort = null;
    }
  });

  ipcMain.handle('chat:abort', () => {
    if (currentAbort) currentAbort.abort();
    return true;
  });

  /* ---------------- 技能 ---------------- */

  ipcMain.handle('skills:info', () => {
    const root = getSkillsRoot();
    const out = [];
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const skillMd = path.join(root, d.name, 'SKILL.md');
        let desc = '';
        let name = d.name;
        if (fs.existsSync(skillMd)) {
          const text = fs.readFileSync(skillMd, 'utf8').slice(0, 4000);
          const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
          if (m) {
            const nm = m[1].match(/^name:\s*(.+)$/m);
            const de = m[1].match(/^description:\s*(.+)$/m);
            if (nm) name = nm[1].trim();
            if (de) desc = de[1].trim();
          }
        }
        let files = 0;
        const walk = (p, depth = 0) => {
          if (depth > 6) return;
          let es = [];
          try {
            es = fs.readdirSync(p, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of es) {
            if (e.isDirectory()) walk(path.join(p, e.name), depth + 1);
            else files += 1;
          }
        };
        walk(path.join(root, d.name));
        out.push({ id: d.name, name, description: desc, files });
      }
    }
    return { root, skills: out };
  });
}

module.exports = { registerIpc };
