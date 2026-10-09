#!/usr/bin/env node
'use strict';

/**
 * 聚合测试入口：跑全部**离线**套件（不启动 Electron）。
 *
 * 为什么需要它：以前每套测试各跑各的，改一处只跑一个套件，
 * 很容易出现「tools 绿了但 license 红了」没人发现（上一轮就发生过：
 * 体验锚点改成 machine.json 后 license-test 挂了，直到手动全跑才发现）。
 *
 * 用法：npm test
 * 退出码：任一套件失败即非零，可直接用于 CI / 提交前检查。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
  ['工具沙箱与执行器', 'scripts/test-tools.js'],
  ['路径解析与越界防护', 'scripts/path-resolve-test.js'],
  ['Agent 循环', 'scripts/test-agent-loop.js'],
  ['授权与卡密', 'scripts/license-test.js'],
  ['赛事日历', 'scripts/competitions-test.js'],
  ['AI 使用声明', 'scripts/ai-declare-test.js'],
  ['工作区快照', 'scripts/snapshot-test.js'],
  ['会话标题生成', 'scripts/session-title-test.js'],
  ['输入草稿存储', 'scripts/drafts-test.js'],
  ['引用解析（@{}）', 'scripts/refs-test.js'],
  ['改名后数据目录迁移', 'scripts/migration-test.js'],
  ['品牌标记几何', 'scripts/icon-check.js'],
  ['品牌标记与界面同源', 'scripts/sync-brand-mark.js', ['--check']],
  ['旧品牌符号未复活', 'scripts/scrub-legacy-mark.js', ['--check']],
  ['签发器赛事选项与定价同源', 'scripts/sync-keygen-options.js', ['--check']],
  ['签发器与客户端密钥/定价一致', 'scripts/issuer-consistency-test.js'],
  ['签发器卡号与台账（keygen）', 'scripts/keygen-ledger-test.js'],
];

/**
 * 反向守卫：scripts/ 下每个 *-test.js 都必须出现在 SUITES 里。
 *
 * 为什么需要：本轮真实发生过两次"测试文件写了、跑过一次就忘了挂"，
 * 于是它再也不被执行，看起来"测试全绿"其实少了一整套断言。
 * 靠人记住挂哪个文件是防不住的，所以让漏挂直接变成失败。
 */
function assertNoOrphanTests() {
  const listed = new Set(SUITES.map(([, file]) => path.basename(file)));
  const orphans = fs
    .readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('-test.js') || f.endsWith('.test.js'))
    .filter((f) => !listed.has(f));
  if (orphans.length) {
    console.error('\n✗ 有测试文件没挂进 SUITES，永远不会被跑：');
    for (const o of orphans) console.error(`    scripts/${o}`);
    console.error('  修法：在 SUITES 里加一行 [\'名称\', `scripts/${文件}`]');
    process.exit(1);
  }
}

assertNoOrphanTests();

const results = [];
for (const [label, file, extra = []] of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n▶ ${label}  (${file})\n${'='.repeat(60)}\n`);
  const r = spawnSync(process.execPath, [path.join(ROOT, file), ...extra], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  results.push({ label, file, code: r.status });
}

console.log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
let bad = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) bad += 1;
  console.log(`${ok ? '✓' : '✗'} ${r.label.padEnd(20)} ${ok ? '' : `退出码 ${r.code}`}`);
}
console.log(`\n${results.length - bad}/${results.length} 套件通过`);

if (bad) {
  console.log('\n提示：需要图形界面的端到端检查请单独跑 `npm run smoke`。');
  process.exit(1);
}
console.log('提示：`npm run smoke` 另外覆盖 UI + IPC + 真实导出链路。');
