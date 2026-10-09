#!/usr/bin/env node
'use strict';

/**
 * 把渲染层里残留的旧品牌标记 ∑（「数模工坊」）换成马头。
 *
 * 背景：改名成「阿一古数模」时，正文文案全换了，但**图形符号**漏了一大片 ——
 * 助手头像、激活页标记、预览桩里的 logo 都还是 ∑。
 * 头像那条尤其糟：每条回复都显示，是全站出现频率最高的品牌标记。
 *
 * 为什么做成脚本而不是手改：src/renderer 下有 20+ 个预览桩 HTML，
 * 手改必漏；而且没有防复活的机制。跟 scrub-wechat.js 同一个套路。
 *
 * 预览桩里的符号用**内联马头**而不是 <use href="#brandMarkMono">：
 * 大部分桩文件里没有 brand-defs symbol（只有 _pv6-* 有），
 * 指向不存在的 id 会渲染成空白 —— 那比 ∑ 更糟。
 *
 * 用法：
 *   node scripts/scrub-legacy-mark.js          # 写入
 *   node scripts/scrub-legacy-mark.js --check  # 只检查，仍有残留则退出码 1
 */

const fs = require('node:fs');
const path = require('node:path');
const { markBody } = require('../src/main/brand-mark');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src', 'renderer');

/** 单色马头（无五官）—— 小尺寸下五官会糊成脏点 */
const MONO_SVG = `<svg viewBox="0 0 256 256" aria-hidden="true">${markBody({ mane: true, face: false, mono: true })}</svg>`;

/** 只处理这些"文字符号"位置，不碰正文里合法的 ∑（比如数学公式、说明性注释） */
const PATTERNS = [
  [/<span class="logo">∑<\/span>/g, `<span class="logo">${MONO_SVG}</span>`],
  [/<span class="es-mark">∑<\/span>/g, `<span class="es-mark">${MONO_SVG}</span>`],
  [/<span class="lock-mark">∑<\/span>/g, `<span class="lock-mark">${MONO_SVG}</span>`],
  [/<div class="avatar">∑<\/div>/g, `<div class="avatar">${MONO_SVG}</div>`],
];

const check = process.argv.includes('--check');
const files = fs.readdirSync(DIR).filter((f) => /\.(html|js)$/.test(f));

let changed = 0;
const leftovers = [];

for (const f of files) {
  const p = path.join(DIR, f);
  let text = fs.readFileSync(p, 'utf8');
  const before = text;
  for (const [re, repl] of PATTERNS) text = text.replace(re, repl);
  if (text !== before) {
    changed += 1;
    if (!check) fs.writeFileSync(p, text, 'utf8');
    else console.log(`✗ ${f} 仍有旧 ∑ 符号位置待替换`);
  }
  // 替换跑完后还留着 ∑ 的，列出来人工看一眼（可能是数学公式，属正常）
  const rest = (text.match(/∑/g) || []).length;
  if (rest) leftovers.push([f, rest]);
}

if (check) {
  if (changed) {
    console.error(`\n  ${changed} 个文件需要跑 scrub-legacy-mark.js 同步`);
    process.exit(1);
  }
  if (leftovers.length) {
    console.log('  仍有 ∑ 出现（确认是否为数学公式等正当用法）：');
    for (const [f, n] of leftovers) console.log(`    ${f}: ${n} 处`);
  }
  console.log('✓ 旧品牌符号位置已全部替换');
  process.exit(0);
}

console.log(`✓ 已替换 ${changed} 个文件`);
if (leftovers.length) {
  console.log('  以下文件仍含 ∑，请人工确认是否为正当用法（如公式）：');
  for (const [f, n] of leftovers) console.log(`    ${f}: ${n} 处`);
}
