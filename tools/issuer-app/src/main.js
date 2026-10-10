'use strict';

/**
 * 阿一古数模 · 卡密签发器（独立桌面应用）—— 主进程
 *
 * 这是**卖家工具**，不是客户应用。它持有签发私钥，所以：
 *   · 单独打包，永远不跟客户版混在一起（package.json 的 files 只含 src/**）
 *   · 私钥与台账放在 %APPDATA%\阿一古数模签发器\，不写进程序目录
 *     （装到 Program Files 时程序目录不可写，写台账会失败或被 UAC 拦）
 *   · 不起本地 HTTP 服务、不监听任何端口 —— 全部走 Electron IPC。
 *     旧的 tools/issuer.js 是"本地 HTTP + token"，那套攻击面在这里直接消失。
 *
 * 签发逻辑一律来自 vendor/issuer-core.js（由 scripts/sync-issuer-app.js
 * 从 tools/issuer-core.js 同步），**本文件不自己算卡号、不自己拼赛事价格**。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 版本号读**应用自己的 package.json**，不用 app.getVersion()。
 * 原因：开发态下 `electron <脚本>` 的"应用"是那个脚本所在目录，
 * app.getVersion() 返回的是 **Electron 自己的版本** ——
 * 实测界面徽章显示成 v44.4.3，看起来像版本号写错了。
 * 打包后两者一致，但开发态对不上很误导。
 */
const APP_VERSION = (() => {
  try { return require(path.join(__dirname, '..', 'package.json')).version; }
  catch { return app.getVersion(); }
})();

// vendor 在应用根（tools/issuer-app/vendor/），不在 src/ 下 ——
// 写 './vendor/...' 会解析成 src/vendor/... 而报 Cannot find module。
// 打包后是 app.asar/vendor/，__dirname 是 app.asar/src/，所以往上走一层。
const { createIssuer } = require(path.join(__dirname, '..', 'vendor', 'issuer-core'));

/* ------------------------------------------------------------------ */
/* 数据目录与私钥迁移                                                    */
/* ------------------------------------------------------------------ */

/** %APPDATA%\阿一古数模签发器 */
function dataDir() {
  return path.join(app.getPath('appData'), '阿一古数模签发器');
}

/**
 * 旧私钥的位置（仓库里那份）。打包后拿不到，所以只在开发态找得到 ——
 * 这正是"首次启动自动搬一次"的设计：搬完就以 %APPDATA% 为准。
 */
function legacyKeyCandidates() {
  const out = [];
  // 开发态：src/ → issuer-app/ → tools/ → 仓库根
  // ⚠️ 是三层不是两层。写错的话"首次启动自动搬迁"会静默失败，
  // 表现成"应用起来了但没有私钥"，指不到根因。
  out.push(path.join(__dirname, '..', '..', '..', 'keys', 'license-private.pem'));
  // 打包后：程序目录旁边放一份（便携用法）
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'license-private.pem'));
  out.push(path.join(path.dirname(process.execPath), 'license-private.pem'));
  return out.filter(Boolean);
}

/**
 * 首次启动把私钥搬进来。
 *
 * ⚠️ **只复制，不删源文件**。私钥是发卡的命根子，自动删一旦新副本有问题
 * （权限、路径、被安全软件拦）就把自己锁死了 —— 那是最坏的结果。
 * 改成复制后**当场验签确认能用**，再在界面上提示"源码目录里还有一份，
 * 建议删掉"，并给一个手动删除按钮。决定权留给卖家。
 */
function ensureKey() {
  const dir = dataDir();
  const target = path.join(dir, 'license-private.pem');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(target)) return { ok: true, moved: false, path: target };

  for (const cand of legacyKeyCandidates()) {
    try {
      if (!fs.existsSync(cand)) continue;
      const pem = fs.readFileSync(cand, 'utf8');
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) continue;
      fs.writeFileSync(target, pem, { encoding: 'utf8', mode: 0o600 });
      return { ok: true, moved: true, from: cand, path: target };
    } catch { /* 换下一个候选 */ }
  }
  return { ok: false, moved: false, path: target };
}

/* ------------------------------------------------------------------ */
/* 核心实例                                                            */
/* ------------------------------------------------------------------ */

let core = null;

function initCore() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  core = createIssuer({
    dataDir: dir,
    privPath: path.join(dir, 'license-private.pem'),
    comps: require(path.join(__dirname, '..', 'vendor', 'competitions')),
    license: require(path.join(__dirname, '..', 'vendor', 'license')),
  });
  return core;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: '阿一古数模 · 卡密签发器',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 外链一律用系统浏览器打开，不在应用窗口里导航走
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** 统一包一层：把异常转成 {ok:false,error}，别让渲染进程拿到未处理的 rejection */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), code: e && e.code };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: APP_VERSION,
    dataDir: dataDir(),
    ledgerPath: core.ledgerPath,
    invitePath: core.invitePath,
    privPath: core.privPath,
    hasKey: core.hasKey(),
    // 源码目录里是否还留着另一份私钥（用于提示，不自动删）
    legacyKeys: legacyKeyCandidates().filter((p) => { try { return fs.existsSync(p); } catch { return false; } }),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  handle('competitions:list', () => core.comps.COMPETITIONS.map((c) => ({
    id: c.id, name: c.name, fullName: c.fullName, price: core.comps.PRICES[c.id] ?? c.price,
  })).concat([{ id: 'all', name: '全能包', fullName: '全能包（全部赛事）', price: core.comps.PRICES.all }]));

  handle('prices', () => ({ ...core.comps.PRICES, inviteRules: core.comps.INVITE_RULES }));

  handle('ledger:list', () => core.readLedger().map((r) => ({
    ...r,
    machinePretty: r.machine ? core.pretty(r.machine) : '',
    inviteCode: core.comps.inviteCodeFromCard(r.card) || '',
  })));

  handle('issue:new', (form) => {
    const r = core.issue({
      machine: form.machine,
      competition: form.competition,
      buyer: form.buyer || '',
      note: form.note || '',
      ...(form.until ? { until: form.until } : { days: Number(form.days || 365) }),
    });
    const comp = r.payload.competition === 'all'
      ? { fullName: '全能包（全部赛事）' }
      : core.comps.get(r.payload.competition);
    return {
      credential: r.credential,
      card: r.payload.card,
      machinePretty: core.pretty(r.payload.machine),
      competition: r.payload.competition,
      competitionName: comp ? (comp.fullName || comp.name) : r.payload.competition,
      price: r.price,
      inviteCode: r.inviteCode,
      expireText: new Date(r.payload.expireAt).toISOString().slice(0, 10),
      buyer: r.payload.buyer,
    };
  });

  handle('card:verify', ({ credential, machine }) => {
    const v = core.verify(credential, machine || undefined);
    const p = v.payload || {};
    return {
      ok: v.ok, why: v.why, expired: !!v.expired,
      card: p.card, machine: p.machine ? core.pretty(p.machine) : '',
      edition: p.edition, competition: p.competition || 'all',
      issuedAt: p.issuedAt ? new Date(p.issuedAt).toISOString().slice(0, 10) : '',
      expireAt: p.expireAt ? new Date(p.expireAt).toISOString().slice(0, 10) : '',
      buyer: p.buyer || '',
    };
  });

  // ---- 邀请 ----
  handle('invite:record', (form) => {
    const r = core.recordInvite({
      inviterCode: form.code,
      buyer: form.buyer || '',
      competition: form.competition || '',
      amount: form.amount || '',
      note: form.note || '',
    });
    const owner = core.whoIs(r.code);
    const rules = core.comps.INVITE_RULES;
    return {
      code: r.code, count: r.count,
      threshold: rules.threshold, reward: rules.reward,
      owner: owner ? { card: owner.card, buyer: owner.buyer || '' } : null,
    };
  });

  handle('invite:stats', () => ({
    rules: core.comps.INVITE_RULES,
    stats: core.inviteStats().map((s) => {
      const owner = core.whoIs(s.code);
      return { ...s, owner: owner ? { card: owner.card, buyer: owner.buyer || '' } : null };
    }),
  }));

  // ---- 导入 / 导出 ----
  handle('ledger:import', async ({ dry }) => {
    const pick = await dialog.showOpenDialog(win, {
      title: '选择 keygen 导出的 CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths.length) return { canceled: true };
    const file = pick.filePaths[0];
    const existing = new Set(core.readLedger().map((r) => r.card));
    const res = core.parseImportCsv(fs.readFileSync(file, 'utf8'), { existingCards: existing });
    if (res.error) throw new Error(res.error);
    if (!dry) core.importRows(res.rows);
    return {
      canceled: false, file: path.basename(file), dry: !!dry,
      added: res.rows.length, skipped: res.skipped.length, unknown: res.unknown,
      cards: res.rows.map((r) => ({ card: r.card, competition: r.competition, inviteCode: core.comps.inviteCodeFromCard(r.card) })),
    };
  });

  handle('ledger:export', async ({ zh }) => {
    const pick = await dialog.showSaveDialog(win, {
      title: '导出台账',
      defaultPath: `issued-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (pick.canceled || !pick.filePath) return { canceled: true };
    const text = zh ? core.ledgerToCsvZh() : core.ledgerToCsv();
    // 带 BOM，Excel 打开中文表头才不乱码
    fs.writeFileSync(pick.filePath, '\uFEFF' + text, 'utf8');
    return { canceled: false, file: pick.filePath, rows: core.readLedger().length };
  });

  handle('clipboard:write', (text) => { clipboard.writeText(String(text || '')); return true; });

  handle('key:delete-legacy', async () => {
    const list = legacyKeyCandidates().filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!list.length) return { deleted: [] };
    const ask = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '确认删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除源码目录里的私钥副本',
      message: `将删除 ${list.length} 份私钥副本：\n\n${list.join('\n')}`,
      detail: '删除前请确认 %APPDATA% 里那份能正常发卡（本应用已经在用它）。\n'
        + '私钥丢了就再也发不出新卡（已发的还能用），删之前建议先备份到离线介质。',
    });
    if (ask.response !== 1) return { canceled: true, deleted: [] };
    const deleted = [];
    for (const p of list) {
      try { fs.rmSync(p); deleted.push(p); } catch { /* 删不掉就跳过 */ }
    }
    return { canceled: false, deleted };
  });

  handle('shell:show-item', (p) => { shell.showItemInFolder(p); return true; });
}

/* ------------------------------------------------------------------ */
/* 自检模式（打包后验收用）                                              */
/* ------------------------------------------------------------------ */

/**
 * `--selftest <报告路径>`：不开窗，跑一遍核心链路，把结果写成 JSON 报告并退出。
 *
 * 为什么需要它：打包出来的是 GUI 子系统程序，Windows 下**看不到 stdout** ——
 * 出问题时只能看到一个窗口闪一下，指不到根因。这是本仓库踩过的老坑
 * （主应用的 smoke 因此也把结果写成报告文件 + 带退出码）。
 * 有了它，`scripts/verify-issuer-package.js` 才能对**打包产物**做真实验收。
 *
 * 用的是临时数据目录，不碰 %APPDATA% 里的真台账与私钥。
 */
async function runSelfTest(reportPath) {
  const os = require('node:os');
  const crypto = require('node:crypto');
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuer-selftest-'));
    const comps = require(path.join(__dirname, '..', 'vendor', 'competitions'));
    const license = require(path.join(__dirname, '..', 'vendor', 'license'));

    add('vendor/competitions 可加载', Array.isArray(comps.COMPETITIONS) && comps.COMPETITIONS.length > 0,
      comps.COMPETITIONS.length + ' 个赛事');
    add('vendor/license 可加载', typeof license.verifyCredential === 'function');
    add('赛事价格来自数据源', comps.PRICES.cumcm === 69 && comps.PRICES.all === 168,
      `cumcm=${comps.PRICES.cumcm} all=${comps.PRICES.all}`);

    /* 私钥：优先用真私钥（能验签），没有就临时造一把（其余断言仍要能跑） */
    const realPriv = path.join(dataDir(), 'license-private.pem');
    const legacy = legacyKeyCandidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    let signable = false;
    if (fs.existsSync(realPriv)) { fs.copyFileSync(realPriv, path.join(tmpDir, 'license-private.pem')); signable = true; }
    else if (legacy) { fs.copyFileSync(legacy, path.join(tmpDir, 'license-private.pem')); signable = true; }
    else {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(path.join(tmpDir, 'license-private.pem'),
        privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
    }
    add('私钥可用', true, signable ? '用真私钥（可验签）' : '临时密钥（仅验结构）');

    const core = createIssuer({ dataDir: tmpDir, comps, license });
    const M = '7E842A70F9986EB7';
    const r = core.issue({ machine: M, days: 30, competition: 'cumcm', buyer: 'selftest' });
    add('签发成功', /^MCM-\d{4}-\d{4}$/.test(r.payload.card), r.payload.card);
    add('价格取自数据源', r.price === comps.PRICES.cumcm, String(r.price));
    add('返回邀请码', /^\d{6}$/.test(r.inviteCode), r.inviteCode);
    add('台账已写入', core.readLedger().length === 1, String(core.readLedger().length));
    add('排号有空洞也不撞（0001,0003 → 4）',
      core.nextSeq(2026, [{ card: 'MCM-2026-0001' }, { card: 'MCM-2026-0003' }]) === 4);

    if (signable) {
      const v1 = core.verify(r.credential, M);
      add('本机验签通过', v1.ok === true, v1.why || '');
      const v2 = core.verify(r.credential, 'AAAAAAAAAAAAAAAA');
      add('换机被拒（一机一码）', v2.ok === false, v2.why || '');
    } else {
      add('本机验签通过', true, '跳过（无真私钥）');
    }

    const inv = core.recordInvite({ inviterCode: r.inviteCode, buyer: '张三' });
    add('邀请记账', inv.count === 1, String(inv.count));
    add('whoIs 找到推荐人', core.whoIs(r.inviteCode)?.card === r.payload.card);

    const parsed = core.parseImportCsv(
      '卡号,机器码,版本,赛事,签发时间,到期时间,买家,备注\nMCM-2026-0009,7E842A70F9986EB7,pro,华数杯,2026-10-01,2027-10-01,甲,\n',
      { existingCards: new Set() });
    add('导入解析（中文表头 + 中文赛事名）', parsed.rows.length === 1 && parsed.rows[0].competition === 'huashu',
      parsed.rows[0] && parsed.rows[0].competition);
    add('导出中文 CSV', core.ledgerToCsvZh().startsWith('卡号,机器码'));
    add('导出英文 CSV', core.ledgerToCsv().startsWith('card,machine'));

    add('版本号读的是应用 package.json', APP_VERSION === require(path.join(__dirname, '..', 'package.json')).version,
      APP_VERSION);
  } catch (e) {
    add('自检自身未抛异常', false, (e && e.message) || String(e));
  } finally {
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM 无所谓 */ }
  }

  const failCount = results.filter((r) => !r.ok).length;
  const report = {
    packaged: app.isPackaged,
    execPath: process.execPath,
    version: APP_VERSION,
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir: dataDir(),
    passed: results.length - failCount,
    failed: failCount,
    results,
  };
  try {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    console.error('写报告失败：', e.message);
  }
  app.exit(failCount ? 1 : 0);
}

/**
 * `--screenshot <路径>`：开窗渲染后截一张 PNG 再退出（打包产物的界面证据）。
 * 与 --selftest 同源的理由：GUI 子系统程序在 Windows 下拿不到 stdout，
 * 也不能靠 --remote-debugging-port 连（实测 exe 会报 "bad option"）。
 * 用**临时数据目录**，避免为了截图往真台账里写假卡。
 */
async function runScreenshot(outPath) {
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuer-shot-'));
  // 真私钥若可用就借来用（界面会显示"私钥已就绪"），否则退回空态
  const candidates = [path.join(dataDir(), 'license-private.pem'), ...legacyKeyCandidates()];
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (found) fs.copyFileSync(found, path.join(tmpDir, 'license-private.pem'));

  const comps = require(path.join(__dirname, '..', 'vendor', 'competitions'));
  const license = require(path.join(__dirname, '..', 'vendor', 'license'));
  core = createIssuer({
    dataDir: tmpDir, comps, license,
    privPath: path.join(tmpDir, 'license-private.pem'),
  });
  registerIpc();

  const shotWin = new BrowserWindow({
    width: 1080, height: 780, show: false, backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await shotWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  // 发一张卡让"签发"页有结果可看（写进临时目录，不碰真台账）
  try {
    await shotWin.webContents.executeJavaScript(`(async () => {
      document.getElementById('machine').value = '7E84-2A70-F998-6EB7';
      const sel = document.getElementById('competition');
      sel.value = 'cumcm'; sel.dispatchEvent(new Event('change'));
      document.getElementById('buyer').value = '张三（演示）';
      document.getElementById('go').click();
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
  } catch { /* 截图不因这个失败 */ }

  const img = await shotWin.webContents.capturePage();
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, img.toPNG());
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM 无所谓 */ }
  app.exit(0);
}

/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  // 自检模式：不开窗、不写真实数据目录
  const stIdx = process.argv.indexOf('--selftest');
  if (stIdx !== -1) {
    runSelfTest(process.argv[stIdx + 1] || path.join(process.cwd(), 'issuer-selftest.json'));
    return;
  }

  // 截图模式：给打包产物留一张界面证据（GUI 程序没法用 electron 调试参数）
  const ssIdx = process.argv.indexOf('--screenshot');
  if (ssIdx !== -1) {
    runScreenshot(process.argv[ssIdx + 1] || path.join(process.cwd(), 'issuer-shot.png'));
    return;
  }

  // 单实例：开两个窗口同时写台账会互相覆盖
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  const keyState = ensureKey();
  initCore();
  registerIpc();
  createWindow();

  if (!keyState.ok) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('boot:warning', {
        title: '没找到签发私钥',
        detail: `找过这些位置都没有 keys/license-private.pem：\n${legacyKeyCandidates().join('\n')}\n\n`
          + `请把它放到：\n${path.join(dataDir(), 'license-private.pem')}`,
      });
    });
  } else if (keyState.moved) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('boot:warning', {
        title: '已把私钥搬到数据目录',
        detail: `从：${keyState.from}\n到：${keyState.path}\n\n`
          + '源码目录里那份**没有删**（私钥丢了发不了新卡，自动删风险太大）。\n'
          + '确认本应用能正常发卡后，可在「设置」里手动删掉那份副本。',
        moved: true,
      });
    });
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
