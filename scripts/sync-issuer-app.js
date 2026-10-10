#!/usr/bin/env node
'use strict';

/**
 * 把签发核心与它依赖的数据源同步进独立应用（tools/issuer-app/vendor/）。
 *
 * 为什么需要同步而不是直接 require 上层目录：
 * 独立应用打包成 asar 之后，**没法用相对路径爬到仓库外的文件**。
 * 所以必须在打包前把这些文件复制进去。
 *
 * 为什么是"生成 + 守卫"而不是手写副本：
 * 手抄一份必然漂移。本仓库已经栽过三次（单赛卡签成全能包、台账列错位、
 * keygen 少 3 个赛事还是旧价）。这里照抄 sync-keygen-options.js 的模式：
 * 生成器 + `--check` 模式挂进 npm test，改了真源忘了同步就直接红。
 *
 * 用法：
 *   node scripts/sync-issuer-app.js           # 同步（写文件）
 *   node scripts/sync-issuer-app.js --check   # 只校验，漂移则退出码 1
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'tools', 'issuer-app');
const VENDOR = path.join(APP, 'vendor');
const CHECK = process.argv.includes('--check');

/**
 * 要同步的文件清单。
 *
 * ⚠️ 只放**数据与算法**，绝不放私钥、台账或任何带用户数据的文件。
 * 下面有一条硬检查：vendor 里出现 PRIVATE KEY 就失败。
 */
const FILES = [
  ['tools/issuer-core.js', 'vendor/issuer-core.js'],
  ['src/main/competitions.js', 'vendor/competitions.js'],
  ['src/main/license.js', 'vendor/license.js'],
];

/**
 * 同步时要改写的 require 路径。
 *
 * core 里对 competitions / license 的引用是相对仓库布局写的
 * （`path.join(__dirname, '..', 'src', 'main', ...)`），进了 asar 就失效。
 * 这里把它们重写成同目录引用 —— 只改这一处，别的不动。
 */
function rewriteForVendor(rel, src) {
  if (rel !== 'vendor/issuer-core.js') return src;
  let out = src;
  // 默认参数里的 fallback require
  out = out.replace(
    /require\(path\.join\(__dirname,\s*'\.\.',\s*'src',\s*'main',\s*'competitions'\)\)/g,
    "require('./competitions')",
  );
  out = out.replace(
    /require\(path\.join\(__dirname,\s*'\.\.',\s*'src',\s*'main',\s*'license'\)\)/g,
    "require('./license')",
  );
  return out;
}

/** 给每个生成文件加一条"别手改"横幅 */
function withBanner(rel, body) {
  const banner = [
    '/*',
    ` * ⚠️ 自动生成，请勿手改 —— 由 scripts/sync-issuer-app.js 从 ${rel.replace(/^vendor\//, '')} 同步。`,
    ' * 改这里会在下次同步时被覆盖，且 npm test 的「签发器应用同源」守卫会报漂移。',
    ' */',
    '',
  ].join('\n');
  return banner + body;
}

let fail = 0;
let wrote = 0;
let same = 0;

for (const [srcRel, dstRel] of FILES) {
  const srcPath = path.join(ROOT, srcRel);
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ 源文件不存在：${srcRel}`);
    fail += 1;
    continue;
  }
  const raw = fs.readFileSync(srcPath, 'utf8');
  const want = withBanner(dstRel, rewriteForVendor(dstRel, raw));
  const dstPath = path.join(APP, dstRel);
  const has = fs.existsSync(dstPath);
  const now = has ? fs.readFileSync(dstPath, 'utf8') : null;

  if (now === want) { same += 1; continue; }

  if (CHECK) {
    console.error(`✗ ${dstRel} 与真源不一致（${srcRel}）`);
    console.error('  修法：node scripts/sync-issuer-app.js');
    fail += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, want, 'utf8');
  console.log(`  ${has ? '↻ 更新' : '+ 新增'} ${dstRel}  ← ${srcRel}`);
  wrote += 1;
}

/* ---- 安全闸：vendor 里绝不能出现私钥或台账 ---- */
const FORBIDDEN = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥 PEM' },
  { re: /^card,machine,edition,competition,issuedAt/m, why: '卡密台账表头' },
  { re: /^inviterCode,buyer,competition/m, why: '邀请台账表头' },
];
if (fs.existsSync(VENDOR)) {
  for (const f of fs.readdirSync(VENDOR)) {
    const p = path.join(VENDOR, f);
    if (!fs.statSync(p).isFile()) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const { re, why } of FORBIDDEN) {
      if (re.test(t)) {
        console.error(`✗ vendor/${f} 里出现了${why} —— 签发器应用会被分发，绝不能带这个`);
        fail += 1;
      }
    }
  }
}

if (CHECK) {
  if (fail) { console.error(`\n✗ 签发器应用有 ${fail} 处漂移/违规`); process.exit(1); }
  console.log(`✓ 签发器应用 vendor 与真源一致（${same} 个文件），且不含私钥/台账`);
  process.exit(0);
}

console.log(`\n同步完成：写入 ${wrote} 个，未变 ${same} 个${fail ? `，失败 ${fail}` : ''}`);
process.exit(fail ? 1 : 0);
