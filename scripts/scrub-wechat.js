#!/usr/bin/env node
'use strict';

/**
 * 清理界面里的微信号文字（用户要求：只留二维码）。
 *
 * 正式界面 index.html 已手工改过；这里处理两类"副本/工具"残留：
 *   - src/renderer/_pv*.html / _*.html  视觉预览桩（不进包，但将来可能被误用为宣传截图）
 *   - tools/keygen.html  卖家工具的买家备注 placeholder
 *
 * Node 按 utf8 读写 —— PowerShell 会按系统 ANSI 码页搞坏中文（实测踩过）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const DIRS = [path.join(ROOT, 'src', 'renderer'), path.join(ROOT, 'tools')];

let touched = 0;
let hits = 0;
for (const d of DIRS) {
  if (!fs.existsSync(d)) continue;
  for (const file of walk(d)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/xhxc287/.test(src)) continue;

    let out = src;
    // 侧栏 "微信 <b>xhxc287</b>" → 去掉整行（侧栏已有"点这里扫码"）
    out = out.replace(/\s*<div class="sf-social">微信 <b>xhxc287<\/b><\/div>/g, '');
    // 弹窗 "微信 <b>xhxc287</b>"（qm-id）→ 整行去掉
    out = out.replace(/\s*<div class="qm-id">微信 <b>xhxc287<\/b><\/div>/g, '');
    // 激活页 "付款后加微信 xhxc287, 把..." / "微信号 xhxc287..." → 改中性"扫码"
    out = out.replace(/付款后加微信 <b>xhxc287<\/b>，把/g, '付款后扫码加我，把');
    out = out.replace(/微信号 <b>xhxc287<\/b>（[^）]*）<br\s*\/?>/g, '长按识别或截图保存二维码，微信扫码加我<br />');
    out = out.replace(/微信号 <b>xhxc287<\/b>（[^）]*）<br/g, '长按识别或截图保存二维码，微信扫码加我<br');
    // keygen placeholder "张三 / 微信 xhxc287" → "张三 / 微信"
    out = out.replace(/张三 \/ 微信 xhxc287/g, '张三 / 微信');
    // 兜底：任何孤立 xhxc287 残留替换为"扫码加我"
    if (/xhxc287/.test(out)) {
      out = out.replace(/xhxc287/g, '扫码加我');
    }

    if (out !== src) {
      const rel = path.relative(ROOT, file);
      const n = (src.match(/xhxc287/g) || []).length;
      console.log(`${rel}  → ${n} 处`);
      fs.writeFileSync(file, out, 'utf8');
      touched += 1;
      hits += n;
    }
  }
}
console.log(`\n已清理 ${touched} 个文件 / ${hits} 处`);

// 自检：除 smoke.js 的守卫正则（那是故意的反向断言）外，不应再有 xhxc287
const bad = [];
for (const d of DIRS) {
  if (!fs.existsSync(d)) continue;
  for (const file of walk(d)) {
    if (/xhxc287/.test(fs.readFileSync(file, 'utf8'))) bad.push(path.relative(ROOT, file));
  }
}
console.log(bad.length ? '✗ 仍有残留：' + bad.join(', ') : '✓ HTML 内微信号已清空（smoke.js 的守卫正则保留，那是故意的）');
process.exit(bad.length ? 1 : 0);
