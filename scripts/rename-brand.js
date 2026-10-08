#!/usr/bin/env node
'use strict';

/**
 * 品牌改名：阿一古数模 → 阿一古数模。
 *
 * ⚠️ 用 Node 明确按 utf8 读写 —— PowerShell 的 Get-Content/Set-Content
 * 会按系统 ANSI 码页解读 UTF-8，中文直接双重编码损坏（本项目实测踩过）。
 *
 * 用法：
 *   node scripts/rename-brand.js --dry    # 只列出会改哪些文件
 *   node scripts/rename-brand.js          # 实际改写
 *
 * 不动的东西：
 *   - node_modules / dist / dist-new / .git
 *   - _*.html 预览桩（开发用，不进包；但它们引用不到新名字也不影响）
 *     → 实际上还是改，保持一致，免得以后看预览以为没改名
 *   - docs/体检报告-*.md（历史记录，保留当时的名称才符合事实）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

const FROM = '阿一古数模';
const TO = '阿一古数模';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-new', '.git', '__pycache__']);
const EXTS = new Set(['.js', '.html', '.css', '.json', '.md', '.py', '.txt', '.yml', '.yaml', '.bat']);
// 历史文档保留原名（当时的名字就是阿一古数模，改了反而失真）
const SKIP_FILES = [/体检报告/];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

let touched = 0;
let total = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (SKIP_FILES.some((re) => re.test(rel))) continue;

  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(FROM)) continue;

  const out = src.split(FROM).join(TO);
  const n = (src.match(new RegExp(FROM, 'g')) || []).length;
  console.log(`${DRY ? '[dry] ' : ''}${rel}  → ${n} 处`);
  if (!DRY) fs.writeFileSync(file, out, 'utf8');
  touched += 1;
  total += n;
}
console.log(`\n${DRY ? '将修改' : '已修改'} ${touched} 个文件 / ${total} 处`);

// 自检：无残留、无编码损坏
let bad = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (SKIP_FILES.some((re) => re.test(rel))) continue;
  const s = fs.readFileSync(file, 'utf8');
  if (s.includes(FROM)) { console.log('✗ 仍有残留：' + rel); bad += 1; }
  if (s.includes('\uFFFD')) { console.log('✗ 编码损坏：' + rel); bad += 1; }
}
console.log(bad ? `✗ 自检失败 ${bad} 项` : '✓ 自检通过：无残留、无编码损坏');
process.exit(bad ? 1 : 0);
