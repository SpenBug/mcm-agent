'use strict';

/**
 * 生成应用图标：用 Electron 渲染矢量图标再截图，避免依赖 Pillow / ImageMagick。
 * 产物为 256×256 PNG（带透明圆角），electron-builder 会自动转成多尺寸 .ico。
 *
 * 图形：**侧面马头剪影**（面向左）—— 阿一古数模的品牌标记。
 * 与国际象棋的马同一路数：轮廓简洁、小尺寸下仍可辨认。
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

/** 马头剪影路径（viewBox 0 0 256 256，朝左）。
 *
 *  按马头侧面的解剖比例构造（顺时针，从耳尖起）：
 *    耳尖(152,26) → 额(114,76) → 鼻梁(58,118) → 口鼻最前端(38,142)
 *    → 下颌(90,174) → 喉(92,200) → 颈前(96,216) → 颈底(170,216)
 *    → 颈后上行(176,162 → 160,92) → 枕部(150,60) → 回耳尖
 *
 *  ⚠️ 改完必须跑 `python scripts/icon-geometry-check.py` 验证：
 *  早先手写的一版自交且只有 1760px²（细长条不是马头），就是靠它查出来的。
 *  本机 capturePage 报 UnknownVizError 截不了图，几何断言是唯一自动防线；
 *  目检用浏览器打开 build/icon-preview.html。 */
const HORSE_PATH = [
  'M152 26',                                  // 耳尖
  'C146 36 142 46 138 56',                    // 耳前缘下滑
  'C130 62 122 68 114 76',                    // 额头
  'C98 88 78 104 58 118',                     // 鼻梁
  'C46 126 39 133 38 142',                    // 口鼻最前端
  'C37 152 45 160 57 164',                    // 口鼻下缘圆转
  'C69 168 81 170 90 174',                    // 下颌
  'C94 182 93 192 92 200',                    // 喉部
  'L96 216',                                  // 颈前下段
  'L170 216',                                 // 颈底
  'C176 200 178 182 176 162',                 // 颈后下段上行
  'C172 136 166 110 160 92',                  // 颈后中段
  'C156 80 152 70 150 60',                    // 枕部
  'C152 48 152 36 152 26',                    // 耳后回到耳尖
  'Z',
].join(' ');

/** 鬃毛：贴在颈后的两道流线（比主体略深，制造层次） */
const MANE_PATHS = [
  'M160 92 C166 112 170 136 172 158',
  'M150 68 C156 84 160 102 162 120',
];

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
  svg { width:186px; height:186px; transform:translate(-4px,-2px); }
</style></head>
<body><div class="icon">
  <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#dbe4ff"/>
      </linearGradient>
    </defs>
    <path d="${HORSE_PATH}" fill="url(#g)"/>
    <g fill="none" stroke="#2b4179" stroke-width="5" stroke-linecap="round" opacity=".55">
      ${MANE_PATHS.map((d) => `<path d="${d}"/>`).join('')}
    </g>
  </svg>
</div></body></html>`;

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

module.exports = { generateIcon, HORSE_PATH, MANE_PATHS };
