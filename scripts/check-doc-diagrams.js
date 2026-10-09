#!/usr/bin/env node
'use strict';

/**
 * Markdown 图表与换行符预检（推送 GitHub 前跑）。
 *
 * 两类事故靠肉眼审文档审不出来 —— 源码看着完全正常，只有真渲染才知道挂了：
 *
 *  ① Mermaid 节点标签里的**裸尖括号**
 *     `RMS<0.20` 里的 `<` 被 GitHub 当成 HTML 标签开始，整块图渲染失败，
 *     页面上只剩源码文本。这是最高频的事故。
 *
 *  ② **CRLF 换行符**
 *     抽图块的正则是 ```mermaid\n(...)，而 CRLF 文件里是 ```mermaid\r\n，
 *     `\r` 卡在中间导致正则匹配不上 → **整个文件的图块被静默跳过**，
 *     校验器显示"通过"但实际一个都没检查。本仓库 .gitattributes 已锁 LF，
 *     这条检查防止有人用 Windows 工具改文件时把 CRLF 带进来。
 *
 * 合法例外（别误判）：
 *   <br/>  <br>          换行
 *   --> -.-> -> ==>      有向箭头
 *   <--> <-> <==>        双向箭头 ← 实测官方解析器接受，是合法的
 *
 * 用法：node scripts/check-doc-diagrams.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['README.md', 'docs/SOP-开发与发版.md', 'docs/用户指南.md', 'docs/卖家手册.md'];

/** 去掉合法语法后再找残留尖括号 */
function stripLegal(line) {
  return line
    .replace(/<br\s*\/?>/gi, '')      // 换行
    .replace(/<-{1,2}>/g, '')          // <-> <->
    .replace(/<={1,2}>/g, '')          // <=> <==>
    .replace(/-\.->/g, '')             // 虚线箭头
    .replace(/-{1,2}>/g, '')           // --> ->
    .replace(/={1,2}>/g, '');          // ==> =>
}

let pass = 0;
let fail = 0;
let totalBlocks = 0;

console.log('=== ① 换行符（CRLF 会让图块校验静默失配）===');
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const raw = fs.readFileSync(p, 'latin1');
  const crlf = (raw.match(/\r\n/g) || []).length;
  if (crlf) {
    console.log(`  ✗ ${rel}：有 ${crlf} 处 CRLF（应为纯 LF）`);
    console.log('     修正：把文件内容按 \\r\\n → \\n 重写，或检查编辑器设置');
    fail += 1;
  } else {
    console.log(`  ✓ ${rel}`);
    pass += 1;
  }
}

console.log('\n=== ② Mermaid 裸尖括号 ===');
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  if (!blocks.length) continue;
  totalBlocks += blocks.length;
  let bad = 0;
  blocks.forEach((b, i) => {
    b[1].split('\n').forEach((line, n) => {
      if (/[<>]/.test(stripLegal(line))) {
        console.log(`  ✗ ${rel} 块${i + 1} 行${n + 1}: ${line.trim().slice(0, 80)}`);
        bad += 1;
      }
    });
  });
  if (bad) { fail += bad; }
  else { console.log(`  ✓ ${rel}：${blocks.length} 块无裸尖括号`); pass += blocks.length; }
}

console.log(`\n=== ③ 图片引用 ===`);
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  const refs = [...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
    .concat([...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]))
    .filter((u) => !/^https?:/.test(u));
  for (const u of [...new Set(refs)]) {
    const ok = fs.existsSync(path.join(ROOT, decodeURIComponent(u)));
    console.log(`  ${ok ? '✓' : '✗ 不存在'} ${rel} → ${u}`);
    if (ok) pass += 1; else fail += 1;
  }
}

console.log(`\n=== ④ 文内锚点（目录 + 首屏导航等全部 href="#…"）===`);
/** GitHub 锚点规则：小写 → 去掉非（字母数字/空格/连字符/下划线/中日韩）→ 空格转连字符 */
function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
    .replace(/\s+/g, '-');
}
for (const rel of ['README.md']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  const ids = new Set(
    [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => slug(m[2].replace(/\s*#+\s*$/, ''))),
  );
  // 覆盖**所有** in-text 锚点，不只是目录节 ——
  // 实测教训：首屏导航那排 <a href="#…"> 就是被漏掉的"第二处手抄"，
  // 重编号后 4 个锚点在 GitHub 上点了没反应。
  const anchors = [...new Set(
    [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1])
      .concat([...text.matchAll(/<a[^>]+href="#([^"]+)"/g)].map((m) => m[1])),
  )];
  let bad = 0;
  for (const a of anchors) {
    if (!ids.has(a)) { console.log(`  ✗ ${rel}: #${a} 无对应标题`); bad += 1; }
  }
  if (bad) { fail += bad; }
  else { console.log(`  ✓ ${rel}：${anchors.length} 个锚点全部有效（标题 ${ids.size} 个）`); pass += 1; }
}

console.log(`\nmermaid 块总数: ${totalBlocks}   通过项: ${pass}   问题: ${fail}`);
if (fail) {
  console.log('\n  提示：这两类问题在源码里看不出来，只有渲染时才暴露 ——');
  console.log('  裸尖括号改成「低于/大于」等中文表述；CRLF 用 .gitattributes 锁 LF。');
}
process.exit(fail ? 1 : 0);
