'use strict';

/**
 * 冒烟测试（由主进程 --smoke 开关触发）：
 * 1) 界面渲染与 DOM 状态 + 截图
 * 2) 后端链路：技能加载、系统提示词装配、工具沙箱、Python 探测
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { app } = require('electron');

const { getSkillsRoot, getDefaultWorkspace, getUserDataDir } = require('./paths');
const { buildSystemPrompt } = require('./agent/prompt');
const { executeTool, TOOL_DEFS } = require('./agent/tools');
const py = require('./runtime/python');
const drawio = require('./runtime/drawio');
const license = require('./license');

/**
 * 冒烟/演示跑之前，先把授权状态换成一张**临时有效凭证**，跑完恢复原状。
 *
 * 为什么必须这么做：冒烟会走真实的 `session:save` / `chat:send`，
 * 而这些通道有授权门禁。开发机的 2 小时体验期一过，门禁就拦掉它们，
 * 报出来的却是「session 保存后可见 ✗」「mock 一个都没收到」这种
 * **指不到根因**的失败 —— 自检体系从此常年飘红。
 *
 * @returns {{restore:Function}} restore() 在 finally 里调用
 */
function withTempLicense() {
  const ud = getUserDataDir();
  const licFile = path.join(ud, 'license.json');
  const backup = fs.existsSync(licFile) ? fs.readFileSync(licFile, 'utf8') : null;

  // 临时凭证：competition 用 all，免得被"当前赛事未解锁"二次拦住
  const machine = license.getMachineCode(ud);
  const privPath = path.join(__dirname, '..', '..', 'keys', 'license-private.pem');
  if (fs.existsSync(privPath)) {
    const priv = fs.readFileSync(privPath, 'utf8');
    const body = Buffer.from(JSON.stringify({
      card: 'SMOKE-TEMP',
      machine: machine.code,
      edition: 'pro',
      competition: 'all',
      issuedAt: Date.now(),
      expireAt: Date.now() + 3600 * 1000,
    })).toString('base64url');
    const sig = crypto.sign(null, Buffer.from(body), priv).toString('base64url');
    license.writeState(ud, { credential: `${body}.${sig}` });
  } else {
    // 没有私钥（比如 CI 上只拷了 src/）→ 退而求其次：把体验锚点重置为"刚开始"
    license.writeState(ud, { credential: '' });
    const mf = path.join(ud, 'machine.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(mf, 'utf8')) || {}; } catch { /* 新建 */ }
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(mf, JSON.stringify({
      ...m,
      trialFirstRunAt: Date.now(),
      trialLastSeenAt: Date.now(),
      trialMachine: machine.code,
    }, null, 2), 'utf8');
  }

  return {
    restore() {
      try {
        if (backup === null) fs.rmSync(licFile, { force: true });
        else fs.writeFileSync(licFile, backup, 'utf8');
      } catch { /* 恢复失败不影响测试结论 */ }
    },
  };
}

async function checkBackend() {
  const out = [];
  const skillsRoot = getSkillsRoot();
  const workspace = getDefaultWorkspace();
  fs.mkdirSync(workspace, { recursive: true });
  const ctx = { workspace, skillsRoot, pythonPath: 'python' };

  out.push(`skillsRoot = ${skillsRoot}`);
  out.push(`  工具数 = ${TOOL_DEFS.length}（${TOOL_DEFS.map((t) => t.function.name).join(', ')}）`);

  const wfSkill = path.join(skillsRoot, 'mcm-workflow', 'SKILL.md');
  const wfCheck = path.join(skillsRoot, 'mcm-workflow', '提交前自检.md');
  const mfSkill = path.join(skillsRoot, 'mcm-figure', 'SKILL.md');
  const mfStyle = path.join(skillsRoot, 'mcm-figure', 'scripts', 'mcm_style.py');
  const mtSkill = path.join(skillsRoot, 'mcm-tools', 'SKILL.md');
  const mtIo = path.join(skillsRoot, 'mcm-tools', 'scripts', 'mcm_io.py');
  const mcmMode = path.join(skillsRoot, 'mcm-diagram', 'references', 'mcm-mode.md');
  const sdScript = path.join(skillsRoot, 'mcm-diagram', 'scripts', 'task_bands.py');
  out.push(`  mcm-workflow/SKILL.md       ${fs.existsSync(wfSkill) ? '✓' : '✗'}   ← 驱动层`);
  out.push(`  mcm-workflow/提交前自检.md    ${fs.existsSync(wfCheck) ? '✓' : '✗'}`);
  out.push(`  mcm-figure/SKILL.md         ${fs.existsSync(mfSkill) ? '✓' : '✗'}   ← 数据图`);
  out.push(`  mcm-figure/mcm_style.py     ${fs.existsSync(mfStyle) ? '✓' : '✗'}`);
  out.push(`  mcm-diagram/mcm-mode.md     ${fs.existsSync(mcmMode) ? '✓' : '✗'}   ← 非数据图`);
  out.push(`  mcm-diagram/task_bands.py   ${fs.existsSync(sdScript) ? '✓' : '✗'}`);
  out.push(`  mcm-tools/SKILL.md          ${fs.existsSync(mtSkill) ? '✓' : '✗'}   ← 工具链`);
  out.push(`  mcm-tools/mcm_io.py         ${fs.existsSync(mtIo) ? '✓' : '✗'}`);

  const prompt = buildSystemPrompt({ workspace, skillsRoot, config: { autoApprove: true } });
  out.push(`systemPrompt 长度 = ${prompt.length} 字符`);
  out.push(`  含「接料建卡」五步流程 = ${prompt.includes('接料建卡')}`);
  out.push(`  含四类输入契约 = ${prompt.includes('客户必须提供的四类输入')}`);
  out.push(`  含提交前自检路由 = ${prompt.includes('提交前自检.md')}`);
  out.push(`  数据图走 mcm-figure = ${prompt.includes('skills/mcm-figure')}`);
  out.push(`  非数据图走 mcm-diagram = ${prompt.includes('skills/mcm-diagram')}`);
  out.push(`  无 scibox 残留 = ${!prompt.includes('scibox')}`);
  out.push(`  含「竞赛模式」= ${prompt.includes('竞赛模式')}`);
  out.push(`  含 fig_roadmap = ${prompt.includes('fig_roadmap')}`);
  out.push(`  含 DRAWIO_REPORT = ${prompt.includes('DRAWIO_REPORT')}`);
  out.push(`  含「不要用 Matplotlib」约束 = ${prompt.includes('不要用 Matplotlib')}`);

  try {
    const r1 = await executeTool('read_file', { path: 'skills/mcm-diagram/references/mcm-mode.md', limit: 2 }, ctx);
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

  // 授权前置：换成临时有效凭证，跑完恢复 —— 否则体验期一过，门禁会把
  // session/chat 全拦掉，报出来的失败指不到根因（详见 withTempLicense 注释）
  const lic = withTempLicense();
  win.webContents.on('console-message', (_e, level, message) => logs.push(`[lvl${level}] ${message}`));
  win.webContents.on('render-process-gone', (_e, d) => logs.push(`RENDER GONE: ${JSON.stringify(d)}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => logs.push(`LOAD FAIL ${code} ${desc}`));

  try {
    await runSmokeBody(win, logs);
  } finally {
    lic.restore();
  }
}

async function runSmokeBody(win, logs) {
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

    // 赛事日历面板：验证状态/倒计时/解锁渲染，以及"设为当前赛事"真的落库
    const cmpDom = await win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('cmpMask')?.classList.add('hidden');
        document.getElementById('btnCompetitions')?.click();
        await new Promise(r => setTimeout(r, 900));
        const items = [...document.querySelectorAll('.cmp-item')];
        const cur = await window.mcm.competitions.list();
        return JSON.stringify({
          open: document.getElementById('cmpPanel')?.classList.contains('open'),
          count: items.length,
          statuses: items.map(i => (i.querySelector('.cmp-status')||{}).textContent).filter(Boolean),
          hasCountdown: items.some(i => i.querySelector('.cmp-count')),
          hasSetBtn: items.some(i => i.querySelector('[data-set]')),
          current: cur.current,
          defaultCurrent: cur.defaultCurrent,
          prices: cur.prices,
          licenseComp: cur.license?.competition,
        });
      })()
    `);
    console.log('===赛事日历面板===');
    console.log(cmpDom);
    const cmp = JSON.parse(cmpDom);
    const cmpChecks = [
      ['面板可打开', cmp.open === true],
      ['渲染出赛事条目', cmp.count >= 5, cmp.count + ' 条'],
      ['状态徽标已渲染', cmp.statuses.length === cmp.count],
      ['报名中的赛事有倒计时', cmp.hasCountdown === true],
      ['有「设为当前赛事」按钮', cmp.hasSetBtn === true],
      ['今天默认当前赛事 = 数维杯', cmp.current === 'shuwei', String(cmp.current)],
      ['价目表带回（国赛 ¥69）', cmp.prices?.cumcm === 69, String(cmp.prices?.cumcm)],
      ['全能包 ¥168', cmp.prices?.all === 168, String(cmp.prices?.all)],
    ];
    let cmpPass = 0;
    for (const [name, ok, detail] of cmpChecks) {
      console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  [${detail}]` : ''}`);
      if (ok) cmpPass += 1;
    }
    console.log(`赛事面板：${cmpPass}/${cmpChecks.length} 通过`);

    // 走完整 IPC 链路验证：配置 / 会话 / 工作区 / 技能 / 中止 / 连通性异常处理
    // ⚠️ 第 7 条要把 apiKey 清空才能测到守卫分支，所以先在主进程备份原值
    const { readConfig: rc, writeConfig: wc } = require('./store');
    const keyBackup = rc().apiKey;
    let ipcDom;
    try {
      ipcDom = await win.webContents.executeJavaScript(`
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
        const mt = sk.skills.find(s => s.id === 'mcm-tools');
        results.push(['技能描述已解析', Boolean(mt && mt.description && mt.files > 0), mt ? mt.files + ' 文件' : '']);

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

        // 7. 未配 Key 时发消息应给出明确提示而非崩溃。
        // ⚠️ 必须先把 key 清空 —— 开发机配置里有真 key 的话，
        // 这条会走到真实网络请求而不是守卫分支，测的就不是守卫了。
        // 原值由主进程在整段 IPC 测试前后备份/恢复（见 runSmokeBody）。
        await window.mcm.config.save({ apiKey: '' });
        let guard = false;
        try {
          const r = await window.mcm.chat.send({ messages: [{ role: 'user', content: 'hi' }] });
          guard = r.ok === false && /API Key/i.test(r.error || '');
        } catch (e) { guard = false; }
        results.push(['未配 Key 有明确提示', guard, '']);

        out.results = results;
        return JSON.stringify(out);
      })()
    `);
    } finally {
      // 恢复开发机的真实 Key（脱敏接口不回传明文，只能在主进程侧还原）
      wc({ apiKey: keyBackup });
    }
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
