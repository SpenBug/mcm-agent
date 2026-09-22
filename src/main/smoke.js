'use strict';

/**
 * 冒烟测试（由主进程 --smoke 开关触发）：
 * 1) 界面渲染与 DOM 状态 + 截图
 * 2) 后端链路：技能加载、系统提示词装配、工具沙箱、Python 探测
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { app } = require('electron');

const { getSkillsRoot, getDefaultWorkspace } = require('./paths');
const { buildSystemPrompt } = require('./agent/prompt');
const { executeTool, TOOL_DEFS } = require('./agent/tools');
const py = require('./runtime/python');
const drawio = require('./runtime/drawio');

async function checkBackend() {
  const out = [];
  const skillsRoot = getSkillsRoot();
  const workspace = getDefaultWorkspace();
  fs.mkdirSync(workspace, { recursive: true });
  const ctx = { workspace, skillsRoot, pythonPath: 'python' };

  out.push(`skillsRoot = ${skillsRoot}`);
  out.push(`  工具数 = ${TOOL_DEFS.length}（${TOOL_DEFS.map((t) => t.function.name).join(', ')}）`);

  const mmSkill = path.join(skillsRoot, 'math-modeling', 'SKILL.md');
  const mcmMode = path.join(skillsRoot, 'scibox-diagram', 'references', 'mcm-mode.md');
  const sdScript = path.join(skillsRoot, 'scibox-diagram', 'scripts', 'task_bands.py');
  out.push(`  math-modeling/SKILL.md      ${fs.existsSync(mmSkill) ? '✓' : '✗'}`);
  out.push(`  scibox-diagram/mcm-mode.md  ${fs.existsSync(mcmMode) ? '✓' : '✗'}`);
  out.push(`  scibox-diagram/task_bands.py ${fs.existsSync(sdScript) ? '✓' : '✗'}`);

  const prompt = buildSystemPrompt({ workspace, skillsRoot, config: { autoApprove: true } });
  out.push(`systemPrompt 长度 = ${prompt.length} 字符`);
  out.push(`  含「竞赛模式」= ${prompt.includes('竞赛模式')}`);
  out.push(`  含 fig_roadmap = ${prompt.includes('fig_roadmap')}`);
  out.push(`  含 DRAWIO_REPORT = ${prompt.includes('DRAWIO_REPORT')}`);
  out.push(`  含「不要用 Matplotlib」约束 = ${prompt.includes('不要用 Matplotlib')}`);

  try {
    const r1 = await executeTool('read_file', { path: 'skills/scibox-diagram/references/mcm-mode.md', limit: 2 }, ctx);
    out.push(`read_file(skills/...) => ${String(r1).split('\n')[0].slice(0, 90)}`);
  } catch (e) {
    out.push(`read_file 失败：${e.message}`);
  }

  try {
    await executeTool('write_file', { path: '.selftest/probe.txt', content: 'hello' }, ctx);
    const r2 = await executeTool('list_files', { pattern: '.selftest/*' }, ctx);
    out.push(`write_file + list_files => ${String(r2).replace(/\n/g, ' | ').slice(0, 90)}`);
  } catch (e) {
    out.push(`写入测试失败：${e.message}`);
  }

  try {
    await executeTool('write_file', { path: '../../evil.txt', content: 'x' }, ctx);
    out.push('越界写入防护 => ✗ 未拦截（有问题）');
  } catch (e) {
    out.push(`越界写入防护 => ✓ 已拦截（${e.message.slice(0, 50)}…）`);
  }

  try {
    const pyInfo = await py.detectPython();
    const first = pyInfo[0];
    out.push(`Python 候选 ${pyInfo.length} 个；首选 = ${first ? `${first.exe} ${first.version || ''}` : '未检测到'}`);
    if (first) {
      const deps = await py.checkPackages(first.exe);
      out.push(`  依赖检查：已装 ${(deps.installed || []).length} 项，缺 ${(deps.missing || []).length} 项`);
    }
  } catch (e) {
    out.push(`Python 探测失败：${e.message}`);
  }

  const drawioExe = drawio.detectDrawio(true);
  out.push(`draw.io 桌面版 => ${drawioExe || '未检测到（竞赛模式只能出 .drawio，无法导出 PDF）'}`);

  // draw.io 导出实测（若工作区里已有测试图）
  if (drawioExe) {
    const figDir = path.join(getDefaultWorkspace(), 'figures');
    const src = path.join(figDir, 'fig_roadmap.drawio');
    if (fs.existsSync(src)) {
      // 导出到临时目录，别污染用户工作区
      const outPdf = path.join(require('node:os').tmpdir(), `mcm-drawio-smoke-${Date.now()}.pdf`);
      const r = await drawio.exportFigure(drawioExe, src, outPdf, { format: 'pdf' });
      out.push(
        r.ok
          ? `  导出实测 => ✓ PDF ${(r.size / 1024).toFixed(0)} KB`
          : `  导出实测 => ✗ ${(r.stderr || r.stdout || '未知错误').trim().slice(0, 100)}`
      );
    }
  }

  return out;
}

/**
 * 端到端对话验证：走完整 UI 路径（填输入框 → 点发送），
 * 用一个本地 mock LLM 接住请求，检查用户消息是否真的传到了主进程。
 *
 * 这个用例是为了兜住一类真实 bug：渲染进程在组装 messages 时写错切片，
 * 导致传过去的是空数组 —— 模块级测试（直接调 runAgent）和守卫分支测试
 * 都发现不了。
 */
async function checkChatE2E(win) {
  const out = [];
  const received = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ _raw: body });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'PONG_FROM_MOCK' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { readConfig, writeConfig } = require('./store');
  const backup = readConfig();

  try {
    writeConfig({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'mock-key',
      model: 'mock-model',
      maxIterations: 3,
    });

    // 渲染进程的 state.config 是页面加载时读进来的，主进程改完配置必须重载页面
    // 才会生效（正常使用时是设置面板里 save 后同步更新的，不受影响）。
    win.webContents.reload();
    await new Promise((r) => setTimeout(r, 3500));

    // 从界面发消息（不直接调 IPC，确保覆盖渲染层的组装逻辑）
    const raw = await win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('btnDrawerClose')?.click();
        const input = document.getElementById('input');
        input.value = 'PING_E2E_MARKER';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
        await new Promise(r => setTimeout(r, 5000));
        const userBubbles = [...document.querySelectorAll('.msg.user .bubble')].map(b => b.textContent.trim());
        const asstBubbles = [...document.querySelectorAll('.msg.assistant .bubble')].map(b => b.textContent.trim());
        return JSON.stringify({ userBubbles, asstBubbles });
      })()
    `);
    const ui = JSON.parse(raw);

    const req0 = received[0] || {};
    const msgs = Array.isArray(req0.messages) ? req0.messages : [];
    const userMsg = msgs.find((m) => m.role === 'user');

    out.push(`mock LLM 收到请求 => ${received.length > 0 ? '✓' : '✗ 一个都没收到'}`);
    out.push(`请求含 system prompt => ${msgs.some((m) => m.role === 'system') ? '✓' : '✗'}`);
    out.push(
      `请求含用户消息（关键） => ${
        userMsg && userMsg.content === 'PING_E2E_MARKER'
          ? '✓'
          : `✗ 实际 roles=[${msgs.map((m) => m.role).join(',')}]`
      }`
    );
    out.push(`请求带 7 个 tools 定义 => ${Array.isArray(req0.tools) && req0.tools.length === 7 ? '✓' : `✗ ${req0.tools?.length}`}`);
    out.push(`界面渲染出用户气泡 => ${ui.userBubbles.some((t) => t.includes('PING_E2E_MARKER')) ? '✓' : '✗'}`);
    out.push(`界面收到模型回复 => ${ui.asstBubbles.some((t) => t.includes('PONG_FROM_MOCK')) ? '✓' : '✗'}`);
  } catch (err) {
    out.push(`端到端异常 => ✗ ${err.message}`);
  } finally {
    server.close();
    writeConfig({
      baseUrl: backup.baseUrl,
      apiKey: backup.apiKey,
      model: backup.model,
      maxIterations: backup.maxIterations,
    });
  }

  return out;
}

async function runSmoke(getWindow) {
  const win = getWindow();
  const logs = [];

  win.webContents.on('console-message', (_e, level, message) => logs.push(`[lvl${level}] ${message}`));
  win.webContents.on('render-process-gone', (_e, d) => logs.push(`RENDER GONE: ${JSON.stringify(d)}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => logs.push(`LOAD FAIL ${code} ${desc}`));

  await new Promise((r) => setTimeout(r, 4000));

  try {
    const dom = await win.webContents.executeJavaScript(`
      JSON.stringify({
        title: document.title,
        hasApp: !!document.querySelector('.app'),
        gridCols: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
        wsPath: document.getElementById('wsPath')?.textContent,
        modelBadge: document.getElementById('modelBadge')?.textContent,
        hasEmptyState: !!document.querySelector('.empty-state'),
        quickCards: document.querySelectorAll('.quick-card').length,
        drawerOpen: !document.getElementById('drawer').classList.contains('hidden'),
        providerOptions: document.querySelectorAll('#fProvider option').length,
        bridge: window.mcm ? 'ok' : 'missing'
      })
    `);
    console.log('===界面 DOM===');
    console.log(dom);

    // 打开「运行环境」面板，验证 Python + draw.io 状态能正确渲染
    const envDom = await win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('btnDrawerClose')?.click();
        document.getElementById('btnEnv')?.click();
        await new Promise(r => setTimeout(r, 2500));
        const body = document.getElementById('drawerBody')?.textContent || '';
        return JSON.stringify({
          title: document.getElementById('drawerTitle')?.textContent,
          hasPythonSection: body.includes('Python 运行时'),
          hasDrawioSection: body.includes('draw.io 桌面版'),
          pyReady: body.includes('依赖齐备'),
          drawioReady: body.includes('已检测到'),
          drawioPath: (body.match(/[A-Z]:\\\\[^\\s]*draw\\.io\\.exe/i) || [''])[0]
        });
      })()
    `);
    console.log('===运行环境面板===');
    console.log(envDom);

    // 走完整 IPC 链路验证：配置 / 会话 / 工作区 / 技能 / 中止 / 连通性异常处理
    const ipcDom = await win.webContents.executeJavaScript(`
      (async () => {
        const out = {};
        const results = [];

        // 1. 配置保存 → 读取往返
        const saved = await window.mcm.config.save({ temperature: 0.66, maxIterations: 66 });
        results.push(['config 保存往返', saved.temperature === 0.66 && saved.maxIterations === 66, 'temp=' + saved.temperature]);
        results.push(['config 脱敏', saved.apiKey === undefined && typeof saved.hasApiKey === 'boolean', 'hasApiKey=' + saved.hasApiKey]);
        await window.mcm.config.save({ temperature: 0.3, maxIterations: 80 });

        // 2. 会话持久化全链路
        const sid = 'smoke-' + Date.now();
        await window.mcm.session.save({ id: sid, title: '冒烟测试会话', messages: [{ role: 'user', content: 'hi' }] });
        const list = await window.mcm.session.list();
        results.push(['session 保存后可见', list.some(s => s.id === sid && s.title === '冒烟测试会话'), '共 ' + list.length + ' 条']);
        const loaded = await window.mcm.session.load(sid);
        results.push(['session 内容可读', loaded && loaded.messages && loaded.messages.length === 1, '']);
        await window.mcm.session.remove(sid);
        const list2 = await window.mcm.session.list();
        results.push(['session 删除生效', !list2.some(s => s.id === sid), '']);

        // 3. 工作区
        const ws = await window.mcm.workspace.ensure();
        const files = await window.mcm.workspace.list('');
        results.push(['workspace 可枚举', Array.isArray(files), files.length + ' 项']);
        const txt = await window.mcm.workspace.read('__not_exist__.txt');
        results.push(['workspace 读不存在文件不崩', typeof txt === 'string', '']);

        // 4. 技能枚举
        const sk = await window.mcm.skills.info();
        results.push(['skills 枚举', sk.skills.length >= 2, sk.skills.map(s => s.id).join(', ')]);
        const mm = sk.skills.find(s => s.id === 'math-modeling');
        results.push(['技能描述已解析', Boolean(mm && mm.description && mm.files > 0), mm ? mm.files + ' 文件' : '']);

        // 5. 无任务时中止应无害
        let abortOk = false;
        try { abortOk = await window.mcm.chat.abort(); } catch (e) { abortOk = false; }
        results.push(['chat.abort 空调用无害', abortOk === true, '']);

        // 6. 连通性测试对不可达地址应优雅返回而非抛异常
        let graceful = false;
        try {
          const t = await window.mcm.config.test({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', apiKey: 'x' });
          graceful = t.ok === false && typeof t.error === 'string' && t.error.length > 0;
        } catch (e) { graceful = false; }
        results.push(['连通性失败优雅返回', graceful, '']);

        // 7. 未配 Key 时发消息应给出明确提示而非崩溃
        let guard = false;
        try {
          const r = await window.mcm.chat.send({ messages: [{ role: 'user', content: 'hi' }] });
          guard = r.ok === false && /API Key/.test(r.error || '');
        } catch (e) { guard = false; }
        results.push(['未配 Key 有明确提示', guard, '']);

        out.results = results;
        return JSON.stringify(out);
      })()
    `);
    console.log('===IPC 链路===');
    const ipcParsed = JSON.parse(ipcDom);
    let ipcPass = 0;
    for (const [name, ok, detail] of ipcParsed.results) {
      console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  [${detail}]` : ''}`);
      if (ok) ipcPass += 1;
    }
    console.log(`IPC 结果：${ipcPass}/${ipcParsed.results.length} 通过`);

    // 端到端对话：走完整 UI 路径，用 mock LLM 验证用户消息真的传到了主进程
    // 截图必须放在端到端测试之前 —— 那里会 reload 页面，之后 capturePage
    // 会因渲染状态异常报 UnknownVizError。
    // 打包后 app 目录在 asar 内不可写，截图统一落到临时目录。
    const img = await win.webContents.capturePage();
    const shot = path.join(app.getPath('temp'), 'mcm-agent-smoke.png');
    fs.writeFileSync(shot, img.toPNG());
    console.log(`截图 => ${shot}`);

    console.log('===端到端对话（mock LLM）===');
    const e2e = await checkChatE2E(win);
    e2e.forEach((l) => console.log(l));
  } catch (err) {
    console.log('===界面错误===');
    console.log(err.stack || err.message);
  }

  console.log('===后端链路===');
  const backend = await checkBackend();
  backend.forEach((l) => console.log(l));

  console.log('===渲染进程日志===');
  console.log(logs.length ? logs.join('\n') : '(无控制台输出)');

  setTimeout(() => app.quit(), 400);
}

module.exports = { runSmoke };
