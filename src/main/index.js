'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc');
const { readConfig } = require('./store');

// 兜底开关：虚拟机 / 远程桌面 / 无 GPU 环境下走软件渲染。
//
// 两种触发方式：
//   --no-gpu       开发态用（`electron . --no-gpu` 实测有效）
//   MCM_NO_GPU=1   打包版用这个 ——
//     实测打包后的 exe 会**拒绝任何命令行参数**（连 `--foo` 都报 "bad option" 然后退出），
//     而同一个 electron.exe 直接跑却没这问题。原因没查清（疑似本机沙箱的执行器行为），
//     但结论是明确的：**参数那条路在打包版上走不通，得留一条环境变量的路**。
const noGpu = process.argv.includes('--no-gpu') || process.env.MCM_NO_GPU === '1';
if (noGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  // ⚠️ 这里**绝不能**加 disable-software-rasterizer ——
  // 这个开关的本意就是「退回软件渲染」，再把软件光栅化禁掉就等于没有任何渲染器，
  // 结果是启动几秒后 GPU 进程反复崩溃、应用直接退出（实测：5 秒退出，exit 9）。
  app.commandLine.appendSwitch('in-process-gpu');
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    title: '数模工坊',
    // 窗口底色跟主题走 —— 写死旧色的话，切主题后会先闪一下别的颜色
    backgroundColor: readConfig().theme === 'light' ? '#f7f8fc' : '#070b18',
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
  // 先把随包技能同步到 userData/skills —— 便携版每次启动解压到不同 Temp 目录，
  // 不同步的话技能路径会变，会话历史里的旧路径就失效了
  try {
    require('./paths').syncSkills();
  } catch (err) {
    console.error('[skills] 同步失败:', err.message);
  }

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

  // 宣传素材截图：mock LLM 驱动真实 UI，输出到临时目录
  if (process.argv.includes('--promo-shots')) {
    const { runPromoShots } = require('./promo');
    await runPromoShots(mainWindow);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
