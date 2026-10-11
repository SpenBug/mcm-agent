'use strict';

/**
 * 生成体验版水印用的 logo 位图：resources/brand/wmark-logo.png
 *
 * 只做一件事：把 brand-mark.js 的马头渲成 PNG。
 * **不合成文字、不做裁剪** —— 文字交给 matplotlib / Word 各自用系统字体画。
 *
 * 为什么不在这儿把「阿一古数模」一起画进图里：
 *   上一版这么干，靠扫描不透明像素求包围盒来裁边，结果 offscreen 截图的
 *   实际尺寸与请求尺寸不一致（这个坑 make-icon-lib 顶部就记过），
 *   裁出来是 801x18 的废图。测量与裁剪都是会漂的东西，能不做就不做。
 *   分开之后：logo 是图形（必须用图），文字是文字（各端用自己的字体渲染，
 *   还能跟着 MCM_WATERMARK 环境变量改文案 —— 合成图反而改不了字）。
 *
 * 为什么放 resources/brand/ 而不是引用 build/icon.png：
 *   build/ 不进安装包（package.json 的 extraResources 只带 resources/brand），
 *   Python 侧运行时根本看不到那个文件。
 *
 * 用法：npm run brand:wmark
 * 退出码：自检不过即非零（防"静默坏图"，与 make-icon.js 同一套标准）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { render, audit } = require('./make-icon-lib');

const OUT = path.join(__dirname, '..', 'resources', 'brand', 'wmark-logo.png');
const SIZE = 256;          // 水印里最终只用到 ~10px，256 足够缩放不糊

app.disableHardwareAcceleration();
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  try {
    const img = await render(SIZE, { face: true });
    const a = audit(img);
    const s = img.getSize();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, img.toPNG());
    console.log(`WMARK => ${path.relative(path.join(__dirname, '..'), OUT)}  ${s.width}x${s.height}`);
    console.log(`  自检：底板 ${(a.ratio * 100).toFixed(0)}%  马头 ${(a.brightRatio * 100).toFixed(0)}%  色相 ${a.colors}`);
    if (!a.ok) {
      console.error('✗ 水印 logo 自检未通过（图可能是空的或坏的）');
      app.exit(1);
    }
    app.exit(0);
  } catch (e) {
    console.error('生成失败:', e);
    app.exit(1);
  }
});
