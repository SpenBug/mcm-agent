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
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const dirOnly = process.argv.includes('--dir');

/**
 * 必须在**真 Node** 下跑；如果发现自己跑在 Electron 包装的 node 里，用真 Node 重启自己。
 *
 * 现象（本机真实踩过两次）：`node` 指向 DSH 的 node.cmd，实际执行体是
 * `DSH Desktop.exe`（一个 Electron）。Electron 给 fs 打过补丁，凡是路径以
 * `.asar` 结尾的都按 asar 归档处理 —— 于是 electron-builder 写
 * `resources/default_app.asar` 时报 "Invalid package"，
 * 错误信息完全指不到根因，看起来像磁盘或依赖坏了。
 *
 * 同一个坑还会让 electron-builder 的 CLI 参数解析失败（yargs 把脚本路径
 * 当成多余位置参数），所以这里也不走 CLI。
 */
function isRealNode(exe) {
  try {
    // 问它自己有没有 electron 版本位 —— 比按路径名猜可靠：
    // 装在不叫 nodejs 的目录里的 Electron 包装、或反过来真 Node 放在 DSH 目录下，
    // 用正则筛路径都会判错。
    //
    // ⚠️ 必须带 ELECTRON_RUN_AS_NODE=1 探测：否则候选里如果有真正的 Electron
    // 可执行文件（比如 node_modules/electron/dist/electron.exe），
    // `-p` 会被它当成普通启动参数，**直接弹出一个 GUI 窗口**。
    // 带着这个变量时 Electron 以 Node 模式运行，只回显结果，不开窗。
    const r = spawnSync(exe, ['-p', 'process.versions.electron ? 1 : 0'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10000,
    });
    return r.status === 0 && r.stdout.trim() === '0';
  } catch {
    return false;
  }
}

function ensureRealNode() {
  if (isRealNode(process.execPath)) return;          // 已经在真 Node 下

  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [
    process.env.NODE_EXE,
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ].filter(Boolean);

  const real = candidates.find((c) => {
    try {
      return fs.existsSync(c) && isRealNode(c);
    } catch {
      return false;
    }
  });

  if (!real) {
    console.error(
      '[build] 当前 node 是 Electron 包装的（' + process.execPath + '），\n' +
      '        它会拦掉 .asar 写入，导致打包报 "Invalid package"。\n' +
      '        请装 Node.js，或显式指定：$env:NODE_EXE="C:\\Program Files\\nodejs\\node.exe"',
    );
    process.exit(1);
  }

  console.log(`[build] 当前 node 是 Electron 包装，改用真 Node 重启：${real}`);
  const r = spawnSync(real, [path.join(__dirname, 'build.js'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  process.exit(r.status ?? 1);
}

/**
 * 清掉上一次打包的残留。
 *
 * 两件事：
 *  1. electron-builder 失败会留下 `win-unpacked.tmp` / `win-undefined-unpacked`
 *     这类半成品目录，下次打包遇到同名目录行为不稳定 —— 直接删。
 *  2. dist/ 里躺着**改名前的旧产物**（`数模工坊 Setup 1.0.0.exe`，旧品牌旧图标），
 *     发版时很容易拿错包。但这些是已经花时间和带宽构建出来的交付物，
 *     **不能替用户删** —— 移到 dist/_stale/ 里，让 dist 根目录只剩当前版本。
 */
function cleanStale() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return;

  const staleDir = path.join(distDir, '_stale');
  for (const name of fs.readdirSync(distDir)) {
    const p = path.join(distDir, name);
    if (name === '_stale') continue;

    if (name.endsWith('.tmp') || name === 'win-undefined-unpacked' || name.includes('-undefined.')) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`[build] 清理半成品：${name}`);
      continue;
    }

    const pkg = require(path.join(ROOT, 'package.json'));
    const isOldBrand = /数模工坊/.test(name);
    const isOldVersion = name.includes('1.0.0') && pkg.version !== '1.0.0';
    if (isOldBrand || isOldVersion) {
      fs.mkdirSync(staleDir, { recursive: true });
      fs.renameSync(p, path.join(staleDir, name));
      console.log(`[build] 旧产物移入 dist/_stale/：${name}${isOldBrand ? '（改名前品牌）' : ''}`);
    }
  }
}

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

/**
 * 同步等待。
 * Atomics.wait 可以，但它在 Electron 主线程上会抛 "not supported" ——
 * 本脚本正常已经重启用真 Node 跑（见 ensureRealNode），但万一还是 Electron，
 * 退路用忙等：只在 500ms 粒度的重试里用，不会长时间占 CPU。
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 忙等，最多 ms 毫秒 */ }
  }
}

/**
 * 等可能被占用的资源文件解锁。
 *
 * Windows 上打包常撞到 `EBUSY: resource busy or locked` —— 杀毒软件、
 * 资源管理器预览、或 IDE/agent 的文件索引会临时抓住 resources/brand/*.png。
 * 这不是配置错误，重试就好；但让人对着一个看不懂的 EBUSY 猜根因很浪费，
 * 所以这里主动等它放开，并把还在占用的一起报出来。
 */
function waitForUnlocked(files, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const stillLocked = [];
  for (const f of files) {
    let ok = false;
    while (!ok && Date.now() < deadline) {
      try {
        const h = fs.openSync(f, 'r+');
        fs.closeSync(h);
        ok = true;
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
          sleepSync(500);
        } else {
          ok = true;   // 文件不存在之类的其他问题，交给 electron-builder 报
        }
      }
    }
    if (!ok) stillLocked.push(f);
  }
  if (stillLocked.length) {
    console.warn('[build] 以下文件仍被占用，打包可能失败（关掉预览窗口/杀毒实时扫描后重试）：');
    for (const f of stillLocked) console.warn('  ' + path.relative(ROOT, f));
  }
  return stillLocked.length === 0;
}

/** 收集 extraResources 里的文件（这些是打包时最容易被占用的） */
function collectResourceFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  for (const item of (require(path.join(ROOT, 'package.json')).build.extraResources || [])) {
    walk(path.join(ROOT, item.from));
  }
  return out;
}

async function main() {
  ensureRealNode();
  cleanStale();
  checkIconsOrAbort();
  waitForUnlocked(collectResourceFiles());

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
