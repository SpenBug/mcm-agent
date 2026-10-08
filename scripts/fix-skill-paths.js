#!/usr/bin/env node
'use strict';

/**
 * 一次性维护脚本：把技能文档里的 `python skills/mcm-xxx/...` 相对路径
 * 换成 `python "%MCM_SKILL_ROOT%/mcm-xxx/..."`（环境变量由 tools.js 注入，
 * cmd 会展开成绝对路径）。
 *
 * 为什么不用 PowerShell 批处理：PS 的 Get-Content/Set-Content 会按系统 ANSI
 * 码页解读 UTF-8，中文直接双重编码损坏（实测踩过）。Node 明确按 utf8 读写。
 *
 * 用法：node scripts/fix-skill-paths.js [--dry]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'resources', 'skills');
const DRY = process.argv.includes('--dry');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

let changed = 0;
let touched = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('python skills/')) continue;

  let out = src.replace(/python skills\//g, 'python "%MCM_SKILL_ROOT%/');
  // 给这些命令补闭合引号：路径以 .py 结尾，其后是空格 / 行尾 / 反引号
  out = out.replace(/("%MCM_SKILL_ROOT%\/[^\s"`]+\.py)(?=[\s`]|$)/gm, '$1"');

  if (out === src) continue;
  const n = (out.match(/%MCM_SKILL_ROOT%/g) || []).length;
  const rel = path.relative(path.join(__dirname, '..'), file);
  console.log(`${DRY ? '[dry] ' : ''}${rel}  → ${n} 处`);
  if (!DRY) fs.writeFileSync(file, out, 'utf8');
  changed += n;
  touched += 1;
}
console.log(`\n${DRY ? '将修改' : '已修改'} ${touched} 个文件 / ${changed} 处`);

// 自检：确认没有残留，且中文没坏
let bad = 0;
for (const file of walk(ROOT)) {
  const s = fs.readFileSync(file, 'utf8');
  if (s.includes('python skills/')) { console.log('✗ 仍有残留：' + file); bad += 1; }
  if (s.includes('\uFFFD')) { console.log('✗ 有替换字符（编码损坏）：' + file); bad += 1; }
}
console.log(bad ? `✗ 自检失败 ${bad} 项` : '✓ 自检通过：无残留、无编码损坏');
process.exit(bad ? 1 : 0);
