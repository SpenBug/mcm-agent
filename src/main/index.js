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

// ---------------------------------------------------------------------------
// 单实例锁：双击两次图标 / 点任务栏重复启动时，只保留一个窗口。
// 不加的话两个实例会**同时写 config.json 与 license.json**，
// 后写的覆盖先写的（用户会看到设置莫名其妙回退、体验时长跳变）。
//
// ⚠️ 测试/截图模式（--smoke / --promo-shots / --shot / --make-icon）
// **不加锁**：开发时主窗口往往正开着，加锁会让这些命令直接退出，
// 冒烟测试就永远跑不起来（而且报的是"没输出"，指不到根因）。
// ---------------------------------------------------------------------------
const isUtilityRun = ['--smoke', '--promo-shots', '--shot', '--make-icon']
  .some((f) => process.argv.includes(f));

if (!isUtilityRun) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}

// 全局异常兜底：主进程未捕获的异常默认会**静默**让应用行为异常。
// 至少记下来，方便用户反馈时定位（不弹窗打扰，只写 stderr/日志）。
process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常：', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝：', reason);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    title: '阿一古数模',
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
    // 只放行 https 外链；file:// / javascript: 之类一律拒掉
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * ⚠️ 拦截窗口内导航。
   *
   * 应用是 file:// 加载的单页界面，**任何**把当前窗口导航走的操作都会
   * 让用户失去整个界面（且没有后退按钮可用）。来源有两类：
   *   ① 界面里拖入文件、点了个外部链接 → 走浏览器默认导航
   *   ② 渲染层被注入 → location.href = 'https://...' 直接劫持
   * 这里只允许留在自己的 index.html 上，其余外链交给系统浏览器。
   */
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const isSelf = url.startsWith('file://') && /index\.html(\?|#|$)/.test(url);
    if (isSelf) return;
    e.preventDefault();
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ⚠️ userData 迁移**必须在 app ready 之前**执行 ——
// ready 之后主进程已经按新路径读过 config/license，再改就晚了。
// 老用户（数模工坊 → 阿一古数模）靠它保住卡密、设置与 Python 环境。
try {
  require('./paths').migrateLegacyUserData();
} catch (err) {
  console.error('[paths] 迁移失败（不影响启动）:', err.message);
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

  // 图标改由独立脚本生成（形状真源 src/main/brand-mark.js）：
  // 这里以前自己开一个普通窗口截图，本机无 GPU 会静默失败，
  // 结果 icon.png 停在旧图上还照样打包发版。见 scripts/make-icon.js。
  if (process.argv.includes('--make-icon')) {
    console.log('图标生成已迁移，请跑：npm run icon');
    app.exit(0);
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
