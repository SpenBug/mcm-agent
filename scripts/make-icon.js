'use strict';

/**
 * 生成品牌图标：build/icon.svg、build/icon.png、build/icon.ico
 *
 * 为什么不用截图窗口：本机 `capturePage()` 在普通窗口下报 ERR_FAILED /
 * UnknownVizError（无 GPU 环境），导致改了马头路径、icon.png 却还是旧的 ∑
 * 六边形，而且**静默无报错** —— 打包出来的 exe 图标和真实品牌脱节。
 * 实测 offscreen 渲染可以出图，细节见 scripts/make-icon-lib.js。
 *
 * 形状真源在 src/main/brand-mark.js，这里只负责出图与自检，不抄路径。
 *
 * 用法：npm run icon
 * 退出码：任一自检不过即非零（防止坏图标静默进包）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { render, audit, buildIco } = require('./make-icon-lib');
const {
  HORSE_PATH, FAR_EAR_PATH, MANE_PATH, EYE, NOSTRIL, PALETTE,
  MASTER, ICO_SIZES, NO_FACE_MAX, shapeDigest,
} = require('../src/main/brand-mark');

const OUT_DIR = path.join(__dirname, '..', 'build');

/** 矢量交付物（浏览器打开即可目检，也是文档/宣传用的源文件） */
function standaloneSvg() {
  const bg = PALETTE.bgStops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('');
  const body = PALETTE.bodyStops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="阿一古数模">
  <title>阿一古数模</title>
  <defs>
    <linearGradient id="lgBg" x1="0" y1="0" x2="0.85" y2="1">${bg}</linearGradient>
    <linearGradient id="lgHorse" x1="0" y1="0" x2="0.3" y2="1">${body}</linearGradient>
    <linearGradient id="lgGloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="clip"><rect width="256" height="256" rx="58"/></clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="256" height="256" fill="url(#lgBg)"/>
    <rect width="256" height="149" fill="url(#lgGloss)"/>
    <path d="${FAR_EAR_PATH}" fill="${PALETTE.farEar}"/>
    <path d="${HORSE_PATH}" fill="url(#lgHorse)"/>
    <path d="${MANE_PATH}" fill="${PALETTE.mane}" opacity="0.55"/>
    <circle cx="${EYE.cx}" cy="${EYE.cy}" r="${EYE.r}" fill="${PALETTE.deep}"/>
    <ellipse cx="${NOSTRIL.cx}" cy="${NOSTRIL.cy}" rx="${NOSTRIL.rx}" ry="${NOSTRIL.ry}" transform="rotate(${NOSTRIL.rotate} ${NOSTRIL.cx} ${NOSTRIL.cy})" fill="${PALETTE.deep}" opacity="0.85"/>
  </g>
</svg>`;
}

function log(label, a) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${label.padEnd(10)} 底板 ${(a.ratio * 100).toFixed(0)}% 马头 ${(a.brightRatio * 100).toFixed(0)}% 色相 ${a.colors}`);
  return a.ok;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let allOk = true;

  fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), standaloneSvg(), 'utf8');
  console.log('ICON => build/icon.svg');

  const master = await render(MASTER, { face: true });
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), master.toPNG());
  console.log(`ICON => build/icon.png (${master.getSize().width}px)`);
  allOk = log('icon.png', audit(master)) && allOk;

  // ≤24px 用无五官版：那个尺寸下眼睛/鼻孔只有 1 像素，会糊成马脸上的脏点
  const entries = [];
  let noFace = null;
  for (const size of ICO_SIZES) {
    let img;
    if (size <= NO_FACE_MAX) {
      noFace = noFace || (await render(128, { face: false })).resize({ width: 128, height: 128, quality: 'best' });
      img = noFace.resize({ width: size, height: size, quality: 'best' });
    } else {
      img = master.resize({ width: size, height: size, quality: 'best' });
    }
    entries.push({ size, data: img.toPNG() });
    if ([32, 24, 16].includes(size)) allOk = log(`ico ${size}px`, audit(img)) && allOk;
  }

  const ico = buildIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`ICON => build/icon.ico (${ico.length} bytes, ${entries.length} 尺寸)`);

  fs.writeFileSync(path.join(OUT_DIR, 'icon-256.png'), master.resize({ width: 256, height: 256, quality: 'best' }).toPNG());

  // 内容指纹清单：icon-check.js 用它判断"图标是不是由当前形状生成的"。
  // 比 mtime 可靠 —— git clone 后各文件检出顺序是字母序，时间戳先后不可信。
  fs.writeFileSync(
    path.join(OUT_DIR, 'icon-manifest.json'),
    `${JSON.stringify({
      shape: shapeDigest(),
      master: MASTER,
      icoSizes: ICO_SIZES,
      generatedAt: new Date().toISOString().slice(0, 10),
    }, null, 2)}\n`,
    'utf8',
  );
  console.log(`ICON => build/icon-manifest.json (shape ${shapeDigest()})`);

  console.log(allOk ? '\n图标自检通过' : '\n图标自检未通过');
  app.exit(allOk ? 0 : 1);
}

app.disableHardwareAcceleration();
// make-icon-lib 的坑 2：不拦这个，出完第一张图 app 就自己退了
app.on('window-all-closed', (e) => e.preventDefault());
app.whenReady().then(main).catch((err) => {
  console.error('生成图标失败:', err);
  app.exit(1);
});
