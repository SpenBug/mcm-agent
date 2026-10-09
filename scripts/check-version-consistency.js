#!/usr/bin/env node
'use strict';

/**
 * 版本一致性校验：README 里的下载链接必须与 package.json 的版本对得上。
 *
 * 为什么需要它：发版流程是「bump package.json → 重新打包 → 上传 Release → 更新 README」，
 * 而 README 里的下载直链带版本号（`/download/v1.1.0/...-1.1.0.exe`）。
 * 漏改 README 的后果很隐蔽：**页面看起来正常，但用户点下载拿到的是上一个版本**，
 * 或者直接 404（新 Release 还没建时）。
 *
 * 这类"两处要同时改"的地方靠人记必然漏 —— 本轮已经因为同类问题返工多次
 * （赛事定价手抄三份、图标路径抄三份）。所以让漏改变成测试失败。
 *
 * 用法：
 *   node scripts/check-version-consistency.js          # 校验
 *   node scripts/check-version-consistency.js --fix    # 自动把 README 的版本号改成当前版本
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIX = process.argv.includes('--fix');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

// ---------- ① README 里所有 vX.Y.Z 必须都是当前版本 ----------
const mentioned = [...new Set([...readme.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];
const stale = mentioned.filter((v) => v !== version);

console.log(`package.json 版本 = ${version}`);
console.log(`README 提到的版本 = ${mentioned.join(', ') || '(无)'}`);

let bad = 0;

if (stale.length) {
  bad += 1;
  console.log(`\n✗ README 里有 ${stale.length} 个过期版本号：${stale.join(', ')}`);
  for (const v of stale) {
    // 指出具体位置，便于人工确认不是"历史沿革"性质的提及
    readme.split('\n').forEach((l, i) => {
      if (l.includes(`v${v}`) || l.includes(`-${v}.exe`)) {
        console.log(`    L${i + 1}: ${l.trim().slice(0, 100)}`);
      }
    });
  }
  if (FIX) {
    let out = readme;
    for (const v of stale) {
      out = out.split(`v${v}`).join(`v${version}`);
      out = out.split(`-${v}.exe`).join(`-${version}.exe`);
    }
    fs.writeFileSync(readmePath, out, 'utf8');
    console.log(`\n✓ 已自动替换为 v${version}（请复查 diff 后再提交）`);
    bad = 0;
  }
} else {
  console.log('✓ README 版本号与 package.json 一致');
}

// ---------- ② 下载直链的形态必须正确 ----------
const links = [...readme.matchAll(/https:\/\/github\.com\/[^\s)"']+\/releases\/download\/[^\s)"']+/g)].map((m) => m[0]);
console.log(`\n下载直链 ${links.length} 条：`);
for (const l of links) {
  const m = l.match(/\/download\/(v[\d.]+)\/(.+)$/);
  if (!m) { console.log(`  ⚠️ 形态异常：${l}`); bad += 1; continue; }
  const [, tag, asset] = m;
  const tagOk = tag === `v${version}`;
  // 附件名必须是英文（GitHub 会吃掉中文附件名，实测存成 "-.-1.0.0.exe"）
  const asciiOk = /^[\x20-\x7e]+$/.test(asset);
  const nameOk = asset.includes(version);
  console.log(`  ${tagOk && asciiOk && nameOk ? '✓' : '✗'} ${asset}`);
  if (!tagOk) { console.log(`      tag ${tag} ≠ v${version}`); bad += 1; }
  if (!asciiOk) { console.log('      附件名含非 ASCII —— GitHub 会吃掉中文名'); bad += 1; }
  if (!nameOk) { console.log(`      附件名里没有当前版本号 ${version}`); bad += 1; }
}

console.log(bad ? `\n✗ 版本一致性校验失败（${bad} 项）` : '\n✓ 版本一致性校验通过');
process.exit(bad ? 1 : 0);
