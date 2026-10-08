#!/usr/bin/env node
'use strict';

/**
 * 图标预览：把候选马头剪影渲染成 PNG，人工目检用。
 *   node scripts/icon-preview.js
 * 产物：<temp>/ayigu-icon-preview.png
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const { HORSE_PATH, MANE_PATHS } = require('../src/main/icon');

const CANDIDATES = {
  A: HORSE_PATH,
};

function html() {
  const cells = Object.entries(CANDIDATES).map(([name, d]) => `
    <figure>
      <div class="dark">
        <svg viewBox="0 0 256 256">
          <path d="${d}" fill="#ffffff"/>
          <g fill="none" stroke="#2b4179" stroke-width="5" stroke-linecap="round" opacity=".55">
            ${MANE_PATHS.map((p) => `<path d="${p}"/>`).join('')}
          </g>
        </svg>
      </div>
      <figcaption>${name}</figcaption>
    </figure>
  `).join('');

  // 同时渲染小尺寸，检查缩到 32px 还能不能认出是马
  const small = Object.entries(CANDIDATES).map(([name, d]) => `
    <figure>
      <div class="dark sm">
        <svg viewBox="0 0 256 256"><path d="${d}" fill="#ffffff"/></svg>
      </div>
      <figcaption>${name} 32px</figcaption>
    </figure>
  `).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { margin:0; padding:24px; background:#0f172a; color:#e2e8f0;
           font:14px/1.5 "Microsoft YaHei",sans-serif; display:flex; gap:28px; flex-wrap:wrap; }
    figure { margin:0; text-align:center; }
    .dark {
      width:256px; height:256px; border-radius:58px;
      background:linear-gradient(150deg,#4468bd,#2b4179 52%,#1a2545);
      display:flex; align-items:center; justify-content:center;
      box-shadow: inset 0 1.5px 0 rgba(255,255,255,.22);
    }
    .dark svg { width:186px; height:186px; }
    .dark.sm { width:64px; height:64px; border-radius:14px; }
    .dark.sm svg { width:44px; height:44px; }
    figcaption { margin-top:8px; color:#94a3b8; font-size:12px; }
  </style></head><body>${cells}${small}</body></html>`;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 420, show: true, frame: false,
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
  await new Promise((r) => setTimeout(r, 1200));
  const img = await win.webContents.capturePage();
  const out = path.join(os.tmpdir(), 'ayigu-icon-preview.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('PREVIEW => ' + out);
  win.destroy();
  app.quit();
});
