'use strict';
/*
 * 把渲染层预览桩里的开发机用户名替换成通用占位。
 *
 * 为什么要管这些不进包的文件：预览桩是"界面渲染副本"，将来拿去做宣传图/商店截图
 * 就会把 C:\Users\92182 印出去（暴露个人身份）。
 *
 * 两种写法都要覆盖（实测踩过：只写一种会漏 3 个文件）：
 *   - 纯文本：C:\Users\92182\Documents\...        （单反斜杠）
 *   - JS 字符串里转义过的：C:\\Users\\92182\\...   （双反斜杠）
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'src', 'renderer');
const USER = '92182';
const REPL = '你的用户名';
/** --check：只校验（CI / npm test），有残留即退出码 1 */
const CHECK = process.argv.includes('--check');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.html'));
let total = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  const before = fs.readFileSync(p, 'utf8');
  // 单反斜杠与双反斜杠两种形态一起换
  const after = before
    .split(`C:\\Users\\${USER}`).join(`C:\\Users\\${REPL}`)     // 双反斜杠（转义写法）
    .split(`C:\\Users\\${USER}`).join(`C:\\Users\\${REPL}`);    // 单反斜杠（纯文本）
  if (after === before) continue;
  const n = (before.match(new RegExp(USER, 'g')) || []).length;
  console.log(`  ${CHECK ? '✗ ' : ''}${f}  → ${n} 处`);
  if (!CHECK) fs.writeFileSync(p, after, 'utf8');
  total += n;
}

if (CHECK) {
  if (total) {
    console.log(`\n✗ 预览桩里仍有 ${total} 处开发机用户名 —— 拿去做宣传图会暴露身份`);
    console.log('  修复：node scripts/scrub-preview-userpath.js');
    process.exit(1);
  }
  console.log('✓ 预览桩无开发机用户名残留');
  process.exit(0);
}
console.log(`合计 ${total} 处`);
