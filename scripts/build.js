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
 *   node scripts/build.js --no-icon-check   # 跳过图标新鲜度检查（不建议）
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const dirOnly = process.argv.includes('--dir');

/**
 * 打包前确认图标产物与形状真源一致。
 *
 * 为什么值得拦在这里：上一轮真实发生过"马头路径改了、build/icon.png 还是旧的 ∑
 * 六边形，照常打包发了版"。本机无 GPU 时普通窗口截图会静默失败，
 * 所以过期只能靠**内容指纹**发现 —— 让它挡住发版，比事后看图发现强得多。
 */
function checkIconsOrAbort() {
  if (process.argv.includes('--no-icon-check')) {
    console.log('[build] 已跳过图标新鲜度检查（--no-icon-check）');
    return;
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'icon-check.js')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const stale = (r.stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('✗'));
    console.error('[build] 图标产物与品牌形状不一致，已中止打包：');
    for (const l of stale) console.error('  ' + l.trim());
    console.error('\n  修复：npm run brand && npm run icon');
    console.error('  确实要跳过（不推荐）：node scripts/build.js --no-icon-check');
    process.exit(1);
  }
  console.log('[build] 图标新鲜度检查通过');
}

async function main() {
  checkIconsOrAbort();

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
