#!/usr/bin/env node
'use strict';

/**
 * 打包产物验收：确认该进包的进了、不该进包的没进。
 *
 * 用法：node scripts/verify-package.js [app.asar 路径]
 * 默认检查 dist/win-unpacked/resources/app.asar（npm run pack 的产物）
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const asarPath = process.argv[2] || path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(asarPath)) {
  console.error(`✗ 找不到 ${asarPath}\n  先跑 npm run pack`);
  process.exit(2);
}

const asar = require('@electron/asar');
// 统一成正斜杠，避免 Windows 反斜杠匹配不上
const files = asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/'));
const has = (f) => files.includes(f);

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

console.log(`检查：${path.relative(ROOT, asarPath)}\n`);

console.log('=== ① 本轮新功能必须在包里 ===');
for (const f of [
  '/src/main/competitions.js',
  '/src/main/agent/ai-declare.js',
  '/src/main/license.js',
  '/src/main/agent/prompt.js',
  '/src/renderer/app.js',
  '/src/renderer/index.html',
  '/src/renderer/styles.css',
  '/src/preload/index.js',
  '/src/main/index.js',
  '/src/main/ipc.js',
]) {
  check(f, has(f));
}

console.log('\n=== ② 私钥 / 台账绝不能进包 ===');
const leaked = files.filter((f) => /\.pem$/.test(f) || /issued\.csv$/.test(f) || /\/keys\//.test(f));
check('无 .pem / issued.csv / keys/', leaked.length === 0, leaked.join(', '));
// tools/ 里的签发器也绝不能进包（它含私钥读取逻辑）
const toolsLeak = files.filter((f) => /^\/tools\//.test(f));
check('无 tools/ 签发器', toolsLeak.length === 0, toolsLeak.join(', '));

console.log('\n=== ③ 渲染层预览桩不进包（_ 前缀）===');
const previews = files.filter((f) => /^\/src\/renderer\/_/.test(f));
check('无 _*.html 预览桩', previews.length === 0, previews.slice(0, 3).join(', '));

console.log('\n=== ④ 技能库（extraResources，不在 asar 内）===');
const skillsDir = path.join(path.dirname(asarPath), 'skills');
for (const s of ['mcm-workflow', 'mcm-figure', 'mcm-diagram', 'mcm-tools']) {
  check(`skills/${s}`, fs.existsSync(path.join(skillsDir, s)));
}
check('skills 里无 .pem', !fs.existsSync(skillsDir) || !walkHas(skillsDir, /\.pem$/));
check('skills 里无 __pycache__', !fs.existsSync(skillsDir) || !walkHas(skillsDir, /__pycache__/));

console.log('\n=== ⑤ 品牌资源 ===');
const brandDir = path.join(path.dirname(asarPath), 'brand');
check('brand/wechat-qr.png 在', fs.existsSync(path.join(brandDir, 'wechat-qr.png')));
check('brand/pay-qr.png 不在（打包排除）', !fs.existsSync(path.join(brandDir, 'pay-qr.png')));

/**
 * ⑥ 包内**内容**核对。
 *
 * 上面几项只证明"文件进了包"，证明不了"进的是改过的那版"。
 * 上一轮图标就是这么静默发出去的：文件在包里，内容却是旧的。
 *
 * ⚠️ extractFile 的路径形态：Windows 上 electron-builder 写进 asar 头的是反斜杠，
 * 而且**不能带开头的分隔符** —— @electron/asar 按 path.sep 切段，
 * 开头的 '\' 会切出空段导致查不到（listPackage 返回的却是带前导 \ 的）。
 * 这里统一走 asarPath()，别再手写路径。
 */
console.log('\n=== ⑥ 包内内容 = 当前代码（防"进了包但是旧内容"）===');
const { HORSE_PATH } = require('../src/main/brand-mark');
const asarPath_ = (rel) => rel.replace(/\//g, path.sep);
const read = (rel) => {
  try {
    return asar.extractFile(asarPath, asarPath_(rel)).toString('utf8');
  } catch {
    return null;
  }
};

const html = read('src/renderer/index.html');
check('index.html 可读', html !== null);
if (html) {
  check('界面用的是当前马头形状', html.includes(HORSE_PATH));
  check('界面无旧马头路径', !html.includes('M152 26 C146 36'));
  check('界面无旧 ∑ 图形', !/M170 84 H100/.test(html));
  check('界面无旧品牌名「数模工坊」', !html.includes('数模工坊'));
}

const pathsJs = read('src/main/paths.js');
check('paths.js 有迁移判定 shouldMigrate', pathsJs !== null && pathsJs.includes('function shouldMigrate'));
check('paths.js 认 python-env（不让人重装环境）', pathsJs !== null && pathsJs.includes('hasPythonEnv'));
check('paths.js 认试用锚点（不白送试用）', pathsJs !== null && pathsJs.includes('hasTrialAnchor'));

const brandJs = read('src/main/brand-mark.js');
check('brand-mark.js 进包（形状真源）', brandJs !== null && brandJs.includes('FAR_EAR_PATH'));

const pkgJson = read('package.json');
if (pkgJson) {
  const j = JSON.parse(pkgJson);
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(`版本与仓库一致（${want.version}）`, j.version === want.version, `包内 ${j.version}`);
  check(`产品名 = ${want.productName}`, j.productName === want.productName, `包内 ${j.productName}`);
}

const compJs = read('src/main/competitions.js');
if (compJs) {
  check('赛事数据含大数据赛', compJs.includes('bigdata'));
  check('赛事数据含华数杯', compJs.includes('huashubei') || compJs.includes('华数杯'));
}

console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);

function walkHas(dir, re) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (re.test(p)) return true;
    if (e.isDirectory() && walkHas(p, re)) return true;
  }
  return false;
}
