'use strict';

/**
 * 生成应用图标：用 Electron 渲染矢量图标再截图，避免依赖 Pillow / ImageMagick。
 * 产物为 256×256 PNG（带透明圆角），electron-builder 会自动转成多尺寸 .ico。
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

const ICON_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin:0; padding:0; background:transparent; overflow:hidden; }
  .icon {
    width:256px; height:256px; border-radius:58px;
    background:linear-gradient(150deg, #4468bd 0%, #2b4179 52%, #1a2545 100%);
    display:flex; align-items:center; justify-content:center;
    box-shadow: inset 0 1.5px 0 rgba(255,255,255,.22);
    position:relative;
  }
  .icon::after {
    content:""; position:absolute; right:46px; bottom:46px;
    width:20px; height:20px; border-radius:50%;
    background:#e8590c; opacity:.92;
  }
  .sym {
    font-family:"Segoe UI Symbol","Segoe UI",Arial,sans-serif;
    font-size:152px; font-weight:600; color:#fff; line-height:1;
    transform:translate(-6px,-6px);
    text-shadow:0 3px 8px rgba(0,0,0,.22);
  }
</style></head>
<body><div class="icon"><span class="sym">&#8721;</span></div></body></html>`;

async function generateIcon(outPath) {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    x: 40,
    y: 40,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ICON_HTML)}`);
    await new Promise((r) => setTimeout(r, 1400));
    const raw = await win.webContents.capturePage();
    const s = raw.getSize();
    const side = Math.min(s.width, s.height);
    const img = s.width === s.height ? raw : raw.crop({ x: 0, y: 0, width: side, height: side });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, img.toPNG());
    return { path: outPath, size: img.getSize(), raw: `${s.width}x${s.height}` };
  } finally {
    win.destroy();
  }
}

module.exports = { generateIcon };
