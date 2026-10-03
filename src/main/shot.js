'use strict';

/**
 * 通用截图工具：把 HTML 文件或 URL 渲染成 PNG。
 * 用于目检 drawio 预览、报告页面等的真实渲染效果。
 *
 * 用法：node scripts/dev.js --shot <file.html|url> <out.png> [width] [height]
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

async function capturePageToFile(target, outPath, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1200,
    height: opts.height || 900,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  try {
    if (/^https?:\/\//.test(target)) {
      await win.loadURL(target);
    } else {
      await win.loadFile(path.resolve(target));
    }
    await new Promise((r) => setTimeout(r, opts.wait || 2000));

    const img = await win.webContents.capturePage();
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, img.toPNG());

    const s = img.getSize();
    return { path: abs, size: `${s.width}x${s.height}` };
  } finally {
    win.destroy();
  }
}

module.exports = { capturePageToFile };
