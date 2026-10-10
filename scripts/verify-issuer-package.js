#!/usr/bin/env node
'use strict';

/**
 * 签发器**打包产物**验收（对 dist-issuer/ 里的东西，不是对源码）。
 *
 *   node scripts/verify-issuer-package.js
 *
 * 三件事必须验，而且只能验打包后的产物：
 *  1. app.asar 里**没有私钥、没有台账、没有开发机路径** ——
 *     签发器是要被分发/拷贝的，带了私钥等于把发卡权送人。
 *  2. 该在的文件都在（少一个 exe 就跑不起来，而 GUI 程序没有 stdout，
 *     出问题只能看到窗口闪一下）。
 *  3. **真跑一次 exe 的 --selftest**，确认打包态的核心链路能工作。
 *
 * 为什么不看源码就够了：源码正确 ≠ 打包正确。asar 布局、vendor 同步、
 * 依赖裁剪都可能只在打包后出问题（本轮实测：require('./vendor/...') 与
 * '../../keys' 两处路径都只在真跑时才暴露）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-issuer');
const UNPACKED = path.join(OUT, 'win-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')); }
}

if (!fs.existsSync(ASAR)) {
  console.error(`✗ 找不到打包产物：${path.relative(ROOT, ASAR)}`);
  console.error('  先跑：npm run issuer:app');
  process.exit(1);
}

/* ---------------------------------------------------------------- ① asar 内容 */

console.log('=== ① app.asar 内容（该有的在、不该有的没有）===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-issuer-'));
try {
  const asarBin = require.resolve('@electron/asar/bin/asar.js');
  execFileSync(process.execPath, [asarBin, 'extract', ASAR, tmp], { stdio: 'pipe' });

  const walk = (dir, base = '') => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const files = walk(tmp);
  console.log(`  asar 内 ${files.length} 个文件：${files.join(', ')}`);

  for (const need of ['package.json', 'src/main.js', 'src/preload.js',
    'src/renderer/index.html', 'src/renderer/app.js',
    'vendor/issuer-core.js', 'vendor/competitions.js', 'vendor/license.js']) {
    check(`含 ${need}`, files.includes(need.replace(/\//g, path.sep)) || files.includes(need));
  }

  /* 私钥 / 台账 / 开发机路径 —— 这三类任何一个出现都是事故 */
  const BAD = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥 PEM'],
    [/^card,machine,edition,competition/m, '卡密台账'],
    [/^inviterCode,buyer,competition/m, '邀请台账'],
    [/D:\\数学建模项目/, '开发机绝对路径'],
    [/C:\\Users\\92182/, '开发机用户名'],
  ];
  let dirty = 0;
  for (const f of files) {
    const p = path.join(tmp, f);
    const buf = fs.readFileSync(p);
    const isText = /\.(js|json|html|css|txt|md)$/.test(f);
    if (!isText) continue;
    const txt = buf.toString('utf8');
    for (const [re, why] of BAD) {
      if (re.test(txt)) { check(`${f} 不含${why}`, false); dirty += 1; }
    }
  }
  check('无敏感内容（私钥/台账/开发机路径）', dirty === 0, dirty ? `${dirty} 处` : '');

  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  check('main 指向 src/main.js', pkg.main === 'src/main.js', pkg.main);
  check('productName 是中文品牌名', pkg.productName === '阿一古数模签发器', pkg.productName);

  /* vendor 能在 asar 布局下加载（require 路径改写是否成功） */
  const vcore = require(path.join(tmp, 'vendor', 'issuer-core.js'));
  check('vendor/issuer-core 可加载', typeof vcore.createIssuer === 'function');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------- ② 产物存在 */

console.log('\n=== ② 交付物 ===');
const exes = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.exe')) : [];
check('有安装包（nsis）', exes.some((f) => /setup/i.test(f)), exes.join(', '));
check('有便携版（portable）', exes.some((f) => /^ayigu-issuer-\d/.test(f)), exes.join(', '));
check('产物名是英文（中文附件名会被 GitHub 吃掉）', exes.every((f) => /^[a-z0-9.-]+\.exe$/i.test(f)), exes.join(', '));

/* ---------------------------------------------------------------- ③ 真跑 exe */

console.log('\n=== ③ 真跑打包 exe 的 --selftest ===');
const exe = path.join(UNPACKED, '阿一古数模签发器.exe');
if (!fs.existsSync(exe)) {
  check('win-unpacked 里的 exe 存在', false, path.relative(ROOT, exe));
} else {
  const report = path.join(os.tmpdir(), `issuer-selftest-${Date.now()}.json`);
  /* ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：带着它 exe 会退化成裸 node，
     --selftest 被当成非法参数，退出码 9 且什么都不写 —— 看起来像包坏了。
     （本机环境默认就设了它，README 里记过这个坑。） */
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const r = spawnSync(exe, ['--selftest', report], { env, encoding: 'utf8', timeout: 120000 });
  check('exe 退出码为 0', r.status === 0, `退出码 ${r.status}`);

  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* 没生成 */ }
  check('生成了自检报告', !!rep, report);
  if (rep) {
    check('报告里 packaged = true（确实跑的是包）', rep.packaged === true, String(rep.packaged));
    check('报告版本号与应用一致', rep.version === JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/issuer-app/package.json'), 'utf8')).version, rep.version);
    check('自检全部通过', rep.failed === 0, `${rep.passed} 通过 / ${rep.failed} 失败`);
    for (const item of rep.results || []) {
      if (!item.ok) check(`  自检项：${item.name}`, false, item.detail);
    }
  }
  try { fs.rmSync(report, { force: true }); } catch { /* ignore */ }
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
if (fail) {
  console.log('\n  提示：改完应用后重新打包：npm run issuer:app');
  console.log('        只改了 tools/issuer-core.js 或 src/main/competitions.js 的话，');
  console.log('        先 npm run issuer:sync 同步 vendor。');
}
process.exit(fail ? 1 : 0);
