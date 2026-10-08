#!/usr/bin/env node
'use strict';

/**
 * 打包入口（替代直接调 electron-builder cli.js）。
 *
 * 为什么不能直接 `node node_modules/electron-builder/cli.js --win`：
 * electron-builder 的 CLI 用 yargs 的 `.strict()` 解析参数，而它把
 * **脚本自身路径**也算进位置参数。正常情况下 node 会把 argv[0] 设成 node 的
 * 可执行文件路径、argv[1] 是脚本路径，yargs 会正确跳过；但本机环境里
 * node 被一层 wrapper 接管（argv[0] 不是 node 路径），于是脚本路径被当成
 * "Unknown argument" 直接退出 —— 报错信息还完全指不到根因。
 *
 * 解决：用 yargs 的 API 直接调用 build()，**完全绕开命令行解析**。
 * 这样不管 node 怎么被包装都能打包。
 *
 * 用法：
 *   node scripts/build.js           # 出 NSIS 安装包 + 便携版
 *   node scripts/build.js --dir     # 只出未打包目录（快，用于验收）
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dirOnly = process.argv.includes('--dir');

async function main() {
  const { build, Platform, Arch } = require('app-builder-lib');
  const { DIR_TARGET } = require('app-builder-lib/out/core');
  const pkg = require(path.join(ROOT, 'package.json'));

  console.log(`[build] ${dirOnly ? '仅目录（跳过 NSIS）' : '完整安装包'} · 输出 dist/`);

  const config = { ...pkg.build };

  // targets 有两种形态：
  //   仅目录 → DIR_TARGET（"dir"），并把 config.win.target 清掉，否则仍会跑 NSIS
  //   完整   → undefined，交给 config.win.target 里的 nsis + portable
  let targets;
  if (dirOnly) {
    config.win = { ...config.win, target: undefined };
    targets = Platform.WINDOWS.createTarget([DIR_TARGET], Arch.x64);
  } else {
    targets = Platform.WINDOWS.createTarget(undefined, Arch.x64);
  }

  const result = await build({
    targets,
    projectDir: ROOT,
    config,
    publish: 'never',
  });

  console.log('\n[build] 完成，产物：');
  for (const f of result) {
    console.log('  ' + path.relative(ROOT, f));
  }
}

main().catch((err) => {
  console.error('\n[build] 失败：');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
