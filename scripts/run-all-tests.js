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
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
  ['工具沙箱与执行器', 'scripts/test-tools.js'],
  ['Agent 循环', 'scripts/test-agent-loop.js'],
  ['授权与卡密', 'scripts/license-test.js'],
  ['赛事日历', 'scripts/competitions-test.js'],
  ['AI 使用声明', 'scripts/ai-declare-test.js'],
  ['工作区快照', 'scripts/snapshot-test.js'],
];

const results = [];
for (const [label, file] of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n▶ ${label}  (${file})\n${'='.repeat(60)}\n`);
  const r = spawnSync(process.execPath, [path.join(ROOT, file)], {
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
