'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc');

// 兜底开关：虚拟机 / 远程桌面 / 无 GPU 环境下加 --no-gpu 走软件渲染
if (process.argv.includes('--no-gpu')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    title: '数模智能体',
    backgroundColor: '#f6f6f3',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  registerIpc(() => mainWindow);

  // 图标生成：electron . --make-icon
  if (process.argv.includes('--make-icon')) {
    const { generateIcon } = require('./icon');
    const out = path.join(__dirname, '..', '..', 'build', 'icon.png');
    const r = await generateIcon(out);
    console.log(`ICON => ${r.path} (${r.size.width}x${r.size.height})`);
    app.quit();
    return;
  }

  // 通用截图：electron . --shot <file|url> <out.png> [w] [h]
  const shotIdx = process.argv.indexOf('--shot');
  if (shotIdx !== -1) {
    const { capturePageToFile } = require('./shot');
    const target = process.argv[shotIdx + 1];
    const out = process.argv[shotIdx + 2];
    const w = Number(process.argv[shotIdx + 3]) || 1200;
    const h = Number(process.argv[shotIdx + 4]) || 900;
    const r = await capturePageToFile(target, out, { width: w, height: h });
    console.log(`SHOT => ${r.path} (${r.size})`);
    app.quit();
    return;
  }

  createWindow();

  if (process.argv.includes('--smoke')) {
    const { runSmoke } = require('./smoke');
    await runSmoke(() => mainWindow);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
