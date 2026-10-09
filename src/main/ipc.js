'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell } = require('electron');

const { PROVIDERS, readConfig, writeConfig, publicConfig } = require('./store');
const { testConnection } = require('./agent/llm');
const { runAgent } = require('./agent/loop');
const { buildSystemPrompt } = require('./agent/prompt');
const sessionTitle = require('./agent/session-title');
const py = require('./runtime/python');
const drawio = require('./runtime/drawio');
const { getSkillsRoot, getDefaultWorkspace, getUserDataDir, getBrandDir } = require('./paths');
const license = require('./license');
const snapshot = require('./snapshot');
const comps = require('./competitions');

let currentAbort = null;

/**
 * 等落盘的 LLM 会话标题：sessionId -> title。
 *
 * 为什么需要它（真实竞态）：会话文件是在 chat:send 里 agent **跑完之后**才写的，
 * 用的是那次调用传入的标题快照；而 LLM 标题几秒就返回了。
 * 不记这一笔的话两种坏结果二选一：
 *   - 标题先写文件、会话还没落盘 → 文件不存在，标题丢失
 *   - 会话后写文件 → 用旧快照把 LLM 标题覆盖回本地兜底
 * 放主进程而不是渲染层，是因为写文件的动作在主进程。
 */
const pendingTitles = new Map();

/** 会话标题上限：chat:send 失败时条目会留下，别让长期运行的进程无限攒 */
const PENDING_TITLE_MAX = 50;

function rememberTitle(sessionId, title) {
  const key = String(sessionId || '');
  // Map 保持插入顺序，满了就丢最旧的一条 —— 旧标题早该随会话落盘了
  while (pendingTitles.size >= PENDING_TITLE_MAX) {
    const oldest = pendingTitles.keys().next();
    if (oldest.done) break;
    pendingTitles.delete(oldest.value);
  }
  pendingTitles.set(key, title);
}

/** 渲染层还没命名时的占位值，见到就当"没有标题" */
const PLACEHOLDER_TITLES = new Set(['', '未命名', '新会话']);

/**
 * 决定会话落盘时用哪个标题，优先级：
 *   LLM 生成的（内存待写） > 渲染层给的 > 主进程按首条消息算的本地标题 > 未命名
 *
 * 为什么本地标题要在**主进程**算而不是让渲染层 await 一个 IPC：
 *   1. 渲染层为了拿到标题，得在发消息前多等一次往返 —— 那段 await 期间
 *      发送锁还没上，用户再按一次就并发跑两轮（这个窗口在快照那步本来就存在，
 *      不该被新功能继续放大）。
 *   2. 谁写文件谁负责算标题，规则只有一份；两边各算必然漂移
 *      —— 本项目这轮已经为手抄数据吃过四次亏。
 *   3. 顺带修掉一个不一致：LLM 失败时磁盘上会退回「新会话」，
 *      而界面显示的是渲染层算的标题，重开软件就变回去了。
 */
function resolveSessionTitle(sessionId, title, messages) {
  const pending = pendingTitles.get(String(sessionId || ''));
  if (pending !== undefined) {
    pendingTitles.delete(String(sessionId || ''));
    return pending;
  }
  if (!PLACEHOLDER_TITLES.has(String(title || '').trim())) return title;

  const firstUser = (messages || []).find((m) => m && m.role === 'user');
  const local = firstUser ? sessionTitle.localTitle(firstUser.content) : '';
  return local || title || '未命名';
}

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
   * 当前赛事 id：用户在赛事面板选定的优先；没选 → 最近一场报名中的；
   * 都没有 → null（表示"当前无指定赛事"，不做赛事级门禁）。
   */
  function currentCompetitionId() {
    const cfg = readConfig();
    if (cfg.currentCompetition && comps.get(cfg.currentCompetition)) return cfg.currentCompetition;
    return comps.defaultCurrent();
  }

  /**
   * 授权门禁。
   *
   * ⚠️ 这是**多处埋点**中的一处 —— 只在校验一个地方，改一行前端就绕过去了。
   * 所以在每个"能产出价值"的操作上都查一遍：
   * 发消息、导材料、出图、看产物、存会话、装运行环境。
   *
   * 但 license:* 和 config:* 必须放行 —— 否则用户连激活和配置都做不到。
   *
   * 两层检查：
   *   ① 模式：体验中/已激活 放行，expired/none 拦截；
   *   ② 赛事：已激活的卡只解锁 competition 字段指定的赛事（all 或旧卡=全部），
   *      当前赛事没解锁 → 拦截并给出该赛事价格与切换提示。
   *      体验期**不做赛事限制**（试用可试所有赛事）。
   */
  function licenseBlocked() {
    const st = license.getLicenseState(getUserDataDir());
    if (st.mode === 'expired' || st.mode === 'none') {
      return { blocked: true, mode: st.mode, error: '体验已结束。激活后即可继续使用。' };
    }

    let comp = null;
    if (st.mode === 'activated') {
      const curId = currentCompetitionId();
      if (curId && !comps.unlocks(st.competition, curId)) {
        const c = comps.get(curId);
        comp = { id: c.id, name: c.name, price: c.price, bundlePrice: comps.PRICES.all };
        return {
          blocked: true,
          mode: st.mode,
          competition: comp,
          error: `当前赛事「${c.name}」未解锁（¥${c.price}）。`
            + `请在顶部「赛事」面板切换到已解锁的赛事，或购买本赛事卡密；全能包 ¥${comps.PRICES.all}。`,
        };
      }
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
    // 这张卡解锁的是指定赛事 → 自动把"当前赛事"切过去，避免激活后立刻被赛事门禁拦住
    const competition = v.payload.competition || 'all';
    if (competition !== 'all' && comps.get(competition)) {
      writeConfig({ currentCompetition: competition });
    }
    console.log('[license] 激活成功：' + v.payload.card + '  赛事=' + competition + '  机器码=' + machine.code);
    return { ok: true, ...license.getLicenseState(ud) };
  });

  /* ---------------- 赛事日历 ---------------- */

  /**
   * 赛事列表：状态与倒计时由主进程按当前时间推导（渲染层不自己算，
   * 免得时区/时钟差异两边算得不一样）。
   * 带出当前赛事、默认当前赛事与价目表，渲染层一次拿全。
   */
  ipcMain.handle('competitions:list', () => {
    const st = license.getLicenseState(getUserDataDir());
    const list = comps.list();
    const current = currentCompetitionId();
    return {
      ok: true,
      list,
      current,
      defaultCurrent: comps.defaultCurrent(),
      prices: comps.PRICES,
      license: {
        mode: st.mode,
        competition: st.competition || null,   // null = 未激活（体验期）
        remainingText: st.remainingText,
        card: st.card,
      },
    };
  });

  /** 设为当前赛事（决定门禁用哪一场校验解锁） */
  ipcMain.handle('competition:setCurrent', (_e, id) => {
    const c = comps.get(id);
    if (!c) return { ok: false, error: '未知赛事' };
    writeConfig({ currentCompetition: id });
    return { ok: true, current: id };
  });

  /**
   * 邀请码信息。
   *
   * 邀请码 = **卡号后 6 位**（见 competitions.inviteCodeFromCard）。
   * 未激活（体验期）时没有卡号 → 返回 code: null，界面提示"激活后才有邀请码"。
   *
   * ⚠️ 这里**只读不写**：离线应用无法可靠统计"朋友用了我的码"，
   * 所以不做本地计数（删个文件就绕过了）。减价与送卡由卖家在微信里确认，
   * 软件只负责把码显眼地展示出来、方便用户截图分享。
   */
  ipcMain.handle('invite:info', () => {
    const st = license.getLicenseState(getUserDataDir());
    const card = st.mode === 'activated' ? st.card : null;
    const code = card ? comps.inviteCodeFromCard(card) : null;
    return {
      ok: true,
      code,
      card: card || null,
      activated: st.mode === 'activated',
      rules: comps.INVITE_RULES,
    };
  });

  /**
   * 生成《AI 工具使用详情》草稿（支撑材料用）。
   * 只写草稿到工作区 reports/ 下 —— 工具名称、用途、提示方式这些事实
   * 必须由用户按实际使用情况填，**不替他编造声明**（虚假声明要取消评奖资格）。
   */
  ipcMain.handle('aiDeclare:draft', (_e, payload) => {
    const g = licenseBlocked();
    if (g.blocked) return { ok: false, licenseBlocked: true, error: g.error };
    const ai = require('./agent/ai-declare');
    const compId = currentCompetitionId();
    const text = ai.buildDetailDraft({
      competition: compId,
      tool: payload?.tool,
      purpose: payload?.purpose,
      prompts: payload?.prompts,
      review: payload?.review,
    });
    const ws = readConfig().workspace || getDefaultWorkspace();
    const dir = path.join(ws, 'reports');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'AI工具使用详情草稿.md');
      fs.writeFileSync(out, text, 'utf8');
      return { ok: true, file: path.relative(ws, out).replace(/\\/g, '/'), competition: compId };
    } catch (err) {
      return { ok: false, error: '写入失败：' + err.message };
    }
  });

  /* ---------------- 配置 ---------------- */

  ipcMain.handle('config:get', () => ({
    config: publicConfig(),
    providers: PROVIDERS,
    skillsRoot: getSkillsRoot(),
  }));

  ipcMain.handle('config:save', (_e, patch) => {
    const clean = { ...patch };
    // undefined = 本次不动这个字段（部分更新）；
    // '' = **显式清空**（用户点「清除 Key」或冒烟测试要验未配 Key 的守卫）。
    // 以前两者都当"不改"，导致用户根本清不掉已保存的 Key。
    if (clean.apiKey === undefined) delete clean.apiKey;
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

  /**
   * 用系统浏览器打开外链（赛事官网 / 报名入口）。
   *
   * ⚠️ 只放行 http/https —— 否则渲染层一旦被注入，`file://` / `javascript:`
   * 或本地可执行文件路径都能借这个通道被拉起来。
   * 不强制 https：MathorCup 官网本身就只有 http（http://www.mathorcup.org），
   * 强行要求 https 会让"官网"按钮点不动。
   */
  ipcMain.handle('openExternal', (_e, url) => {
    let u;
    try {
      u = new URL(String(url || ''));
    } catch {
      return { ok: false, error: '链接格式不对' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { ok: false, error: '只允许打开 http/https 链接' };
    }
    shell.openExternal(u.toString());
    return { ok: true };
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
      JSON.stringify({ id: sid, title: resolveSessionTitle(sid, title, messages), messages, updated: Date.now() }, null, 2),
      'utf8'
    );
    return sid;
  });

  ipcMain.handle('session:load', (_e, id) => {
    // 授权门禁：锁定态（体验到期且未激活）不能翻出历史会话全文 ——
    // 侧栏列表还看得到是渲染层的事，内容必须挡住
    const g = licenseBlocked();
    if (g.blocked) return null;
    const ws = readConfig().workspace || getDefaultWorkspace();
    const full = path.join(sessionsDir(ws), `${safeName(id)}.json`);
    if (!fs.existsSync(full)) return null;
    try {
      return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      return null;
    }
  });

  /**
   * 本地兜底标题：纯字符串计算，瞬时返回、不联网、不受授权影响。
   *
   * 为什么要单独一个端点而不是在渲染层重写一遍截断规则：
   * 那样就有两份"标题怎么取"的实现（中英文判定、噪音行过滤、按标点收口），
   * 必然漂移 —— 本项目这轮已经为手抄数据吃过四次亏。
   * 渲染层先拿这个把侧栏填上，再等 LLM 版本回来替换。
   */
  ipcMain.handle('session:title-local', (_e, { text }) => {
    const content = String(text || '').trim();
    if (!content) return { ok: false, code: 'EMPTY_INPUT' };
    const title = sessionTitle.localTitle(content);
    return title ? { ok: true, title } : { ok: false, code: 'EMPTY' };
  });

  /**
   * 生成会话标题（对标 DSH 的 session-title-llm）。
   *
   * ⚠️ 三条实现约束，都是这个功能特有的坑：
   *  1. **不碰 currentAbort** —— 那是对话流的停止句柄。标题是并行发起的辅助调用，
   *     共用会让用户点「停止」时状态错乱，或标题超时误伤正在跑的对话。
   *     generateTitle 内部自带独立 signal，这里直接调用即可。
   *  2. **失败一律返回 {ok:false}**，不抛错也不提示 ——
   *     渲染层已经先给了本地兜底标题，这里失败只是"不替换"，不该打扰用户。
   *  3. 成功后**顺手更新已落盘的会话文件**：会话在 chat:send 里才写盘，
   *     标题却先返回，不补这一笔侧栏会一直显示旧值。
   */
  ipcMain.handle('session:title', async (_e, { sessionId, text }) => {
    { const g = licenseBlocked(); if (g.blocked) return { ok: false, licenseBlocked: true, code: 'LICENSE' }; }

    const content = String(text || '').trim();
    if (!content) return { ok: false, code: 'EMPTY_INPUT' };

    const cfg = readConfig();
    const res = await sessionTitle.generateTitle({
      config: cfg,
      messages: [{ role: 'user', content }],
    });

    if (res.ok && sessionId) {
      rememberTitle(sessionId, res.title);   // 供稍后落盘的 chat:send / session:save 取用
      if (cfg.workspace) {
        try {
          const dir = sessionsDir(ensureWorkspaceDirs(cfg.workspace));
          const file = path.join(dir, `${safeName(sessionId)}.json`);
          if (fs.existsSync(file)) {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            j.title = res.title;
            fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
            pendingTitles.delete(String(sessionId));     // 已写成功，不必再等
          }
        } catch {
          /* 更新落盘失败不影响标题本身已生效；保留在 pendingTitles 里等下次写 */
        }
      }
    }
    return res;
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
        // 标题优先级：内存里等落盘的 LLM 标题 > 渲染层给的 > 主进程本地算 > 未命名。
        // LLM 标题可能在这轮 agent 跑完之前就返回了，但当时会话文件还不存在，
        // 所以只记在了内存里 —— 直接用参数 title 会把它覆盖回本地兜底那条。
        const finalTitle = resolveSessionTitle(sessionId, title, persist);
        fs.writeFileSync(
          path.join(dir, `${safeName(sessionId)}.json`),
          JSON.stringify({ id: sessionId, title: finalTitle, messages: persist, updated: Date.now() }, null, 2),
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
