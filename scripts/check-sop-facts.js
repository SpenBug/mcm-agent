#!/usr/bin/env node
'use strict';

/**
 * SOP 文档事实核对：确认 docs/SOP-开发与发版.md 里写的每一条都对得上现实。
 *
 * 为什么需要它：SOP 本身就是"文档"，而文档最容易腐烂 ——
 * 写了 `npm run xxx` 但脚本没加、写了"21 套测试"但已经 23 套、
 * 引用了已删除的文件。这类错误不会报错，只会让照着做的人卡住。
 *
 * 更根本的原因：本 SOP 第零节第 1 条就是「不许凭记忆断言事实」，
 * 那这条纪律必须由机器执行，不能靠自觉 —— 否则文档会自己打自己的脸。
 * （实测：第一次写这份 SOP 时就有 1 处命令写了但 package.json 里没有。）
 *
 * 用法：node scripts/check-sop-facts.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'SOP-开发与发版.md');

if (!fs.existsSync(DOC)) {
  console.error('✗ 找不到 SOP 文档：docs/SOP-开发与发版.md');
  process.exit(1);
}

const doc = fs.readFileSync(DOC, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
};

// ---------- ① 文档里的 npm 命令必须存在 ----------
console.log('=== ① 文档里的 npm 命令 ===');
for (const c of [...new Set([...doc.matchAll(/npm run ([a-z:_-]+)/g)].map((m) => m[1]))]) {
  check(`npm run ${c}`, Object.prototype.hasOwnProperty.call(pkg.scripts, c), 'package.json 里没有');
}
check('npm test', Object.prototype.hasOwnProperty.call(pkg.scripts, 'test'));

// ---------- ② 文档里的脚本 / 源码文件必须存在 ----------
console.log('\n=== ② 文档里引用的文件 ===');
for (const s of [...new Set([...doc.matchAll(/scripts\/([a-z0-9-]+\.(?:js|mjs|ps1))/g)].map((m) => m[1]))]) {
  check(`scripts/${s}`, fs.existsSync(path.join(ROOT, 'scripts', s)));
}
for (const s of [...new Set([...doc.matchAll(/(src\/[a-z0-9/.-]+\.js)/g)].map((m) => m[1]))]) {
  check(s, fs.existsSync(path.join(ROOT, s)));
}
for (const s of [...new Set([...doc.matchAll(/(docs\/[^\s`）)]+\.md)/g)].map((m) => m[1]))]) {
  check(s, fs.existsSync(path.join(ROOT, s)));
}

// ---------- ③ 文档里的数字必须与实际一致 ----------
console.log('\n=== ③ 文档里的数字 ===');
const suiteSrc = fs.readFileSync(path.join(ROOT, 'scripts/run-all-tests.js'), 'utf8');
const suiteCount = [...suiteSrc.matchAll(/\['[^']+', 'scripts\/[^']+'(?:,\s*\[[^\]]*\])?\]/g)].length;
check(`测试套件数 = ${suiteCount}`, doc.includes(`${suiteCount} 套`), '文档数字与 run-all-tests.js 不符');

const tracked = git(['ls-files']).split('\n').length;
check(`跟踪文件数 = ${tracked}`, doc.includes(`${tracked} 个跟踪文件`), '文档数字与实际不符');

const commits = git(['rev-list', '--count', 'HEAD']);
check(`提交数 = ${commits}`, doc.includes(`${commits} 次提交`), '文档数字与实际不符');

check(`版本号 = ${pkg.version}`, doc.includes(pkg.version), '文档版本与 package.json 不符');

// ---------- ④ 守卫表里的脚本必须真支持 --check ----------
console.log('\n=== ④ 守卫脚本的 --check 模式 ===');
const GUARDS = [
  'sync-brand-mark.js', 'scrub-legacy-mark.js', 'fix-skill-relpaths.js',
  'scrub-preview-userpath.js', 'sync-keygen-options.js',
];
for (const g of GUARDS) {
  const p = path.join(ROOT, 'scripts', g);
  if (!fs.existsSync(p)) { check(`${g} 存在`, false); continue; }
  const t = fs.readFileSync(p, 'utf8');
  check(`${g} 支持 --check`, /--check/.test(t), '文档说它支持，实际没有');
  check(`${g} 已挂进套件`, suiteSrc.includes(g), '没挂进 npm test 就等于没有守卫');
}

// ---------- ⑤ 文档里提到的产物命名与 dist 一致 ----------
console.log('\n=== ⑤ 产物命名 ===');
const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  const exes = fs.readdirSync(distDir).filter((f) => f.endsWith('.exe'));
  check(`dist 里的 ${exes.length} 个 exe 都是文档描述的中文命名`,
    exes.every((f) => /^阿一古数模/.test(f)), exes.join(', '));
}

// ---------- ⑥ 速查表里的路径可用 ----------
console.log('\n=== ⑥ 速查表指向的文件 ===');
const quick = doc.slice(doc.indexOf('## 附：文件速查'));
for (const m of quick.matchAll(/`([a-z0-9/.-]+\.js)`/g)) {
  const p = m[1];
  if (p.startsWith('src/') || p.startsWith('resources/')) check(p, fs.existsSync(path.join(ROOT, p)));
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail) {
  console.log('\n  提示：文档与代码不一致时，改哪边都行 —— 但必须一致。');
  console.log('  SOP 的价值全在于"照着做就能成"，一条失效的命令会让整份文档失去信任。');
}
process.exit(fail ? 1 : 0);
