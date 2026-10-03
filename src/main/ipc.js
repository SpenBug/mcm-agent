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
const { getSkillsRoot, getDefaultWorkspace } = require('./paths');

let currentAbort = null;

function sessionsDir(workspace) {
  return path.join(workspace, '.mcm-agent', 'sessions');
}

function safeName(name) {
  return String(name || '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80);
}

/**
 * 建工作区并预置标准目录。
 *
 * math-modeling 的约定就是 figures/ code/ results/ reports/。不预建的话，
 * 模型写 `savefig('figures/x.png')` 会因父目录不存在直接失败 ——
 * matplotlib 不会自动创建目录，而这类失败很容易被当成"图画不出来"。
 */
function ensureWorkspaceDirs(ws) {
  fs.mkdirSync(ws, { recursive: true });
  for (const d of ['figures', 'code', 'results', 'reports']) {
    fs.mkdirSync(path.join(ws, d), { recursive: true });
  }
  return ws;
}

function registerIpc(getWindow) {
  const send = (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', payload);
  };

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

  ipcMain.handle('workspace:openPath', (_e, rel) => {
    const ws = readConfig().workspace || getDefaultWorkspace();
    const abs = path.resolve(ws, rel || '.');
    shell.openPath(abs);
    return true;
  });

  ipcMain.handle('workspace:reveal', (_e, rel) => {
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

  ipcMain.handle('chat:send', async (_e, { messages, sessionId, title }) => {
    const cfg = readConfig();
    if (!cfg.apiKey) return { ok: false, error: '尚未配置 API Key，请先在设置里填写。' };
    if (!cfg.model) return { ok: false, error: '尚未选择模型。' };

    const ws = ensureWorkspaceDirs(cfg.workspace || getDefaultWorkspace());
    if (!cfg.workspace) writeConfig({ workspace: ws });

    const skillsRoot = getSkillsRoot();
    const system = { role: 'system', content: buildSystemPrompt({ workspace: ws, skillsRoot, config: cfg }) };
    const convo = [system, ...messages];

    currentAbort = new AbortController();
    try {
      const out = await runAgent({
        config: cfg,
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
