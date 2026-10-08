'use strict';

/**
 * 图标目检表：把定稿图标渲染成 256 / 64 / 32 / 16 四档拼成一张图。
 *
 * 为什么还要它：马头改一次就要确认"缩到 16px 还认得出是马"。
 * 本机普通窗口截图会失败，所以走 offscreen（见 make-icon-lib 的说明）。
 * 产物 build/icon-preview.png 用 read 工具或浏览器打开即可目检。
 *
 * 用法：npm run icon:preview
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const { render } = require('./make-icon-lib');

const OUT = path.join(__dirname, '..', 'build', 'icon-preview.png');
const SIZES = [256, 64, 32, 16];

app.disableHardwareAcceleration();
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  const master = await render(512, { face: true });

  // 横向拼接：每档留 16px 间距，底色用应用深色背景，便于看小尺寸对比度
  const gap = 16;
  const cells = SIZES.map((s) => ({ s, img: master.resize({ width: s, height: s, quality: 'best' }) }));
  const height = 256;
  const width = cells.reduce((a, c) => a + c.s, 0) + gap * (cells.length + 1);

  // ⚠️ Electron 的 bitmap 是 **BGRA** 序（不是 RGBA）。按 RGBA 写底色会得到
  // 棕黑色（#0b1324 被读成 #24130b），一眼就能看出来但很容易误判成"图标坏了"。
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buf[i * 4] = 0x24; buf[i * 4 + 1] = 0x13; buf[i * 4 + 2] = 0x0b; buf[i * 4 + 3] = 255;
  }

  let x = gap;
  for (const c of cells) {
    const bmp = c.img.toBitmap({ width: c.s, height: c.s });
    const oy = Math.floor((height - c.s) / 2);
    for (let row = 0; row < c.s; row += 1) {
      const dst = ((oy + row) * width + x) * 4;
      bmp.copy(buf, dst, row * c.s * 4, (row + 1) * c.s * 4);
    }
    x += c.s + gap;
  }

  const out = nativeImage.createFromBuffer(buf, { width, height });
  fs.writeFileSync(OUT, out.toPNG());
  console.log(`PREVIEW => ${OUT}  (${width}x${height}，尺寸 ${SIZES.join(' / ')}）`);
  app.exit(0);
}).catch((err) => {
  console.error('预览失败:', err);
  app.exit(1);
});
