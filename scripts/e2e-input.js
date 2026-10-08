'use strict';
/**
 * 端到端测试：在真实 Electron 里跑真实主进程 + 真实渲染进程，
 * 点一下四个槽位，看主进程到底有没有收到 input:pick、参数对不对。
 *
 * 跑法: node_modules/electron/dist/electron.exe scripts/e2e-input.js --no-gpu
 * （dialog 被打桩，不会弹真窗口）
 */
const electron = require('electron');
const path = require('node:path');

const { app, BrowserWindow, ipcMain } = electron;

// 沙箱 / 远程桌面环境里 GPU 进程会崩，必须先关硬件加速（和 index.js 里 --no-gpu 一致）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

const L = (s) => console.log(s);

// ---- 先装 ipcMain.handle 记录器（必须在 registerIpc 之前）----
const registered = [];
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => {
  registered.push(ch);
  return origHandle(ch, fn);
};

// ---- 真实主进程 ----
require('../src/main/ipc').registerIpc(() => win);

let win = null;
const dialogCalls = [];

app.whenReady().then(async () => {
  // dialog 打桩放在 ready 之后 —— ready 之前 dialog 可能还没挂上
  electron.dialog.showOpenDialog = async (...args) => {
    dialogCalls.push(args);
    return { canceled: true, filePaths: [] };
  };

  L('=== 主进程 ===');
  L('  通道注册数 = ' + registered.length);
  L('  input:pick 已注册 = ' + registered.includes('input:pick'));
  L('  input:list 已注册 = ' + registered.includes('input:list'));

  win = new BrowserWindow({
    width: 1480, height: 940, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) L('  [渲染进程报错] ' + msg);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));

  const info = await win.webContents.executeJavaScript(`(() => {
    const slots = document.querySelectorAll('.slot');
    return {
      slotCount: slots.length,
      cats: Array.from(slots).map(s => s.dataset.cat),
      quickCards: document.querySelectorAll('.quick-card').length,
      overlay: !!document.querySelector('.drop-overlay'),
    };
  })()`);

  L('=== 渲染层 ===');
  L('  槽位数量 = ' + info.slotCount + '  ' + JSON.stringify(info.cats));
  L('  快捷卡 = ' + info.quickCards);
  L('  拖拽遮罩已建 = ' + info.overlay);

  L('=== 点击测试 ===');
  for (let i = 0; i < info.slotCount; i += 1) {
    const before = dialogCalls.length;
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.slot')[${i}].click(); true;`
    );
    await new Promise((r) => setTimeout(r, 500));
    L(`  点第 ${i + 1} 个 → dialog 被调用: ${dialogCalls.length > before ? '✓' : '✗'}`);
  }

  L('=== dialog 调用详情 ===');
  dialogCalls.forEach((c, i) => {
    const [w, opts] = c;
    L(`  ${i + 1}) 窗口=${w ? '有效' : 'null'}  title=${opts && opts.title}`);
  });

  // ---- 关键场景：重渲染后槽位还能不能点 ----
  // renderMessages() 会 host.innerHTML='' 重建空态，槽位是全新 DOM。
  // 如果事件只在 init 里绑一次，这里就会失效。
  L('=== 重渲染后再点（回归测试）===');
  const beforeRerender = dialogCalls.length;
  await win.webContents.executeJavaScript(
    `document.querySelector('#btnNewSession').click(); true;`
  );
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('.slot')[0].click(); true;`
  );
  await new Promise((r) => setTimeout(r, 500));
  const rerenderOk = dialogCalls.length > beforeRerender;
  L('  新建会话（触发重渲染）后点槽位 → dialog 被调用: ' + (rerenderOk ? '✓' : '✗'));

  const pass = info.slotCount === 4 && dialogCalls.length === 5 && rerenderOk;
  L('=== 结果: ' + (pass ? '✓ 全部通过' : '✗ 有问题') + ' ===');
  app.exit(pass ? 0 : 1);
});
