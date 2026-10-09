#!/usr/bin/env node
'use strict';

/**
 * 查看 / 清理 dist 占用。
 *
 * 背景：dist 一度涨到 1.2GB，而其中 393MB 是**纯浪费** ——
 * build.js 早期的 cleanStale 把 `win-unpacked/`（每次构建都重新生成的
 * 解包目录）也当"交付物"归档了，于是每轮多存 390MB，里面却只有一个
 * 解包出来的主程序，没有任何安装包。
 * 那个缺陷已在 build.js 修掉（REGENERABLE 直接删），这里提供事后清理。
 *
 * 用法：
 *   node scripts/clean-dist.js           # 只看占用，不动任何文件
 *   node scripts/clean-dist.js --apply   # 实际清理（默认只删可再生的中间产物）
 *   node scripts/clean-dist.js --apply --stale   # 连 _stale 里的旧批次一起清（谨慎）
 *
 * 默认**不删**的东西（怕误删用户交付物）：
 *   · dist/*.exe          当前交付物
 *   · dist/_stale/_legacy 改名前的旧品牌包（用户可能还要发旧版）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APPLY = process.argv.includes('--apply');
const ALSO_STALE = process.argv.includes('--stale');

if (!fs.existsSync(DIST)) {
  console.log('dist/ 不存在（还没打过包）');
  process.exit(0);
}

/** 递归算目录/文件字节数 */
function sizeOf(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) n += sizeOf(path.join(p, e.name));
  return n;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
/** 可再生：删了下次构建会重建 */
const REGENERABLE = /^(win.*-unpacked|.*\.tmp)$/;

console.log('=== dist 占用 ===');
let total = 0;
const removable = [];
const keep = [];

for (const name of fs.readdirSync(DIST)) {
  const p = path.join(DIST, name);
  const n = sizeOf(p);
  total += n;
  const isDir = fs.statSync(p).isDirectory();

  let verdict = '保留';
  if (REGENERABLE.test(name)) { verdict = '可删（可再生）'; removable.push({ p, n, name }); }
  else if (name === '_stale') {
    // _stale 内部逐项判断
    let staleTotal = 0;
    for (const b of fs.readdirSync(p)) {
      const bp = path.join(p, b);
      const bn = sizeOf(bp);
      staleTotal += bn;
      if (b === '_legacy') keep.push({ p: bp, n: bn, name: `_stale/_legacy（旧品牌交付物）` });
      else if (BATCH_RE.test(b)) removable.push({ p: bp, n: bn, name: `_stale/${b}（上一批交付物）` });
    }
    console.log(`  ${name.padEnd(30)} ${mb(staleTotal).padStart(10)}  ${isDir ? '目录' : '文件'}`);
    continue;
  } else if (/\.exe$/.test(name)) { keep.push({ p, n, name: `${name}（当前交付物）` }); }
  else { keep.push({ p, n, name }); }

  console.log(`  ${name.padEnd(30)} ${mb(n).padStart(10)}  ${verdict}`);
}

console.log(`\n  合计 ${mb(total)}`);

if (removable.length) {
  console.log('\n=== 可回收 ===');
  for (const r of removable) console.log(`  ${mb(r.n).padStart(10)}  ${r.name}`);
  const sum = removable.reduce((a, r) => a + r.n, 0);
  console.log(`  ${mb(sum).padStart(10)}  共 ${removable.length} 项`);
}

if (keep.length) {
  console.log('\n=== 保留（默认不动）===');
  for (const k of keep) console.log(`  ${mb(k.n).padStart(10)}  ${k.name}`);
}

if (!APPLY) {
  console.log('\n（只查看。加 --apply 清理"可再生"项；连 _stale 批次一起清加 --stale）');
  process.exit(0);
}

// ---------- 实际清理 ----------
console.log('\n=== 清理 ===');
let freed = 0;
for (const r of removable) {
  const isStaleBatch = /^_stale\//.test(r.name);
  if (isStaleBatch && !ALSO_STALE) {
    console.log(`  跳过（需 --stale）：${r.name}`);
    continue;
  }
  // ⚠️ 删除前确认目标在 dist 之内 —— 绝不删 dist 之外的任何东西
  const rel = path.relative(DIST, r.p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.log(`  ✗ 跳过越界目标：${r.p}`);
    continue;
  }
  fs.rmSync(r.p, { recursive: true, force: true });
  freed += r.n;
  console.log(`  ✓ 删除 ${r.name}（${mb(r.n)}）`);
}
console.log(`\n共释放 ${mb(freed)}`);
console.log(`dist 现在 ${mb(sizeOf(DIST))}`);
