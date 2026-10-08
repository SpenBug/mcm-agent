'use strict';

/**
 * 图标渲染库：把 brand-mark.js 的形状排到圆角底板上，用 offscreen 窗口出位图。
 *
 * 从 make-icon.js 抽出来是因为 src/main/icon.js（兼容老命令 `--make-icon`）
 * 也要用同一套渲染，而 make-icon.js 在模块加载时会跑 app 生命周期，不能被 require。
 *
 * ⚠️ 两个实测坑（都在这台无 GPU 的机器上踩过）：
 *  1. 普通窗口 `capturePage()` 报 ERR_FAILED / UnknownVizError，
 *     只有 `webPreferences.offscreen: true` 能出图（走软件合成器），且透明通道完好。
 *  2. 每出一张图就 destroy 窗口 → 关掉最后一个窗口会触发 Electron 默认的
 *     "所有窗口关闭即退出"，第二张起 loadURL 全报 ERR_FAILED。
 *     调用方必须 `app.on('window-all-closed', e => e.preventDefault())`。
 *  3. 窗口有最小尺寸（要 16px 实际给 33×39），小尺寸一律大图降采样，别开小窗。
 */

const { BrowserWindow } = require('electron');
const {
  HORSE_PATH, FAR_EAR_PATH, MANE_PATH, EYE, NOSTRIL, PALETTE, markDefs,
  MASTER, ICO_SIZES, NO_FACE_MAX,
} = require('../src/main/brand-mark');

module.exports.MASTER = MASTER;
module.exports.ICO_SIZES = ICO_SIZES;
module.exports.NO_FACE_MAX = NO_FACE_MAX;

/**
 * @param {number} size 边长（像素）
 * @param {object} [o]
 * @param {boolean} [o.face] 是否画眼/鼻孔 —— ≤24px 下这两笔只有 1 像素，会糊成脏点，该关
 */
function iconHtml(size, { face = true } = {}) {
  const k = size / 256;
  const r = (v) => +(v * k).toFixed(3);
  const bg = PALETTE.bgStops.map((s) => s.color).join(',');
  const eyes = face
    ? `<circle cx="${EYE.cx}" cy="${EYE.cy}" r="${EYE.r}" fill="${PALETTE.deep}"/>
       <ellipse cx="${NOSTRIL.cx}" cy="${NOSTRIL.cy}" rx="${NOSTRIL.rx}" ry="${NOSTRIL.ry}" transform="rotate(${NOSTRIL.rotate} ${NOSTRIL.cx} ${NOSTRIL.cy})" fill="${PALETTE.deep}" opacity=".85"/>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    .icon{width:${size}px;height:${size}px;border-radius:${r(58)}px;
      background:linear-gradient(150deg,${bg});position:relative}
    .icon::before{content:"";position:absolute;left:0;top:0;width:100%;height:${Math.round(size * 0.58)}px;
      background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,0))}
    svg{position:absolute;left:0;top:0;width:${size}px;height:${size}px}
  </style></head><body><div class="icon">
    <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      <defs>${markDefs()}</defs>
      <path d="${FAR_EAR_PATH}" fill="${PALETTE.farEar}"/>
      <path d="${HORSE_PATH}" fill="url(#lgHorse)"/>
      <path d="${MANE_PATH}" fill="${PALETTE.mane}" opacity=".55"/>
      ${eyes}
    </svg>
  </div></body></html>`;
}

/** 离屏渲染一张图标位图（返回 Electron nativeImage） */
async function render(size, opts = {}) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(iconHtml(size, opts))}`);
    await new Promise((res) => setTimeout(res, 900));
    const img = await win.webContents.capturePage();
    const s = img.getSize();
    const side = Math.min(s.width, s.height);
    // offscreen 截图在 Windows 上会多出 1px（实测 257x256），裁成正方形
    return side === s.width && side === s.height ? img : img.crop({ x: 0, y: 0, width: side, height: side });
  } finally {
    win.destroy();
  }
}

/**
 * 采样自检：底板覆盖率 + 马头白色占比 + 色相数，防"静默坏图"。
 * 阈值依据实测：512px 马头白色占整图 20%，16px 降到 14%，所以门槛取 12%。
 */
function audit(img) {
  const bmp = img.toBitmap({ width: 128, height: 128 });
  let opaque = 0;
  let bright = 0;
  const colors = new Set();
  for (let i = 0; i < bmp.length; i += 4) {
    if (bmp[i + 3] > 200) {
      opaque += 1;
      if (bmp[i] > 185 && bmp[i + 1] > 185 && bmp[i + 2] > 215) bright += 1;
      colors.add(`${bmp[i] >> 4},${bmp[i + 1] >> 4},${bmp[i + 2] >> 4}`);
    }
  }
  const total = bmp.length / 4;
  const ratio = opaque / total;
  const brightRatio = bright / total;
  return { ok: ratio > 0.85 && brightRatio > 0.12 && colors.size > 6, ratio, brightRatio, colors: colors.size };
}

/** Vista+ 的 ICO 可以直接内嵌 PNG，不必转 BMP —— 手写容器省掉外部依赖 */
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);          // type: icon
  head.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = Buffer.alloc(entries.length * 16);
  const body = [];
  entries.forEach((e, i) => {
    const at = i * 16;
    const dim = e.size === 256 ? 0 : e.size;   // 256 在目录里记作 0
    dir.writeUInt8(dim, at);
    dir.writeUInt8(dim, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(e.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
    body.push(e.data);
  });
  return Buffer.concat([head, dir, ...body]);
}

module.exports = { iconHtml, render, audit, buildIco };
