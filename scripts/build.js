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
 * 打包前把 dist/ 里已有的产物全部挪进 dist/_stale/<时间戳>/。
 *
 * 为什么连"当前版本号"的产物也要挪：本轮真实差点踩到 ——
 * dist/ 里躺着一个同名的 1.1.0 包，但它不含这轮的新功能。
 * 如果打包中途失败（网络断了就是这样），dist/ 根目录仍然有"看起来是最新"的包，
 * 拿去发版就是带着旧功能发布，而且版本号完全对得上，谁都发现不了。
 * 挪空之后，打包失败 = dist/ 是空的，状态一眼可分辨。
 *
 * 为什么不直接删：那是用户花时间与带宽构建出来的交付物。
 * 但全留着会每轮堆 ~225MB，所以只保留最近 STALE_KEEP 批。
 */
// 只保留最近 1 批：一批就有安装包 + 便携版 + 解包目录 ≈ 350MB。
// 注意 dist/ 已被 gitignore，git 里没有副本，所以这里删掉就是真没了 ——
// 因此只删"本脚本自己生成的时间戳批次"，其余一律不碰（见下面的 _legacy）。
const STALE_KEEP = 1;
/** 本脚本生成的批次目录名（ISO 时间戳，把 : 和 . 换成 - 以便做文件名） */
const BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

function cleanStale() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return;

  // 1. 半成品目录：electron-builder 失败留下的，行为不稳定，直接删
  for (const name of fs.readdirSync(distDir)) {
    if (name.endsWith('.tmp') || name === 'win-undefined-unpacked' || name.includes('-undefined.')) {
      fs.rmSync(path.join(distDir, name), { recursive: true, force: true });
      console.log(`[build] 清理半成品：${name}`);
    }
  }

  const staleRoot = path.join(distDir, '_stale');

  // 2. 已有产物整体挪走
  const movable = fs.readdirSync(distDir).filter((n) => n !== '_stale');
  if (movable.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const batch = path.join(staleRoot, stamp);
    fs.mkdirSync(batch, { recursive: true });
    for (const name of movable) fs.renameSync(path.join(distDir, name), path.join(batch, name));
    console.log(`[build] ${movable.length} 项已有产物移入 dist/_stale/${stamp}/`);
  }

  // 3. 上一版方案是把旧产物直接丢在 _stale/ 下面（不带批次目录）。
  //    那些是用户的交付物，**不能因为"看起来不像本脚本生成的"就被清理逻辑删掉**，
  //    所以收进 _legacy/ 永久保留。
  if (fs.existsSync(staleRoot)) {
    for (const e of fs.readdirSync(staleRoot)) {
      if (e === '_legacy' || BATCH_RE.test(e)) continue;
      const legacy = path.join(staleRoot, '_legacy');
      fs.mkdirSync(legacy, { recursive: true });
      const to = path.join(legacy, e);
      if (fs.existsSync(to)) {
        console.log(`[build] _legacy/ 下已有同名条目，保留原样不覆盖：${e}`);
        continue;
      }
      fs.renameSync(path.join(staleRoot, e), to);
      console.log(`[build] 历史产物收进 dist/_stale/_legacy/：${e}`);
    }
  }

  // 4. 只清理本脚本生成的时间戳批次，保留最近 STALE_KEEP 批
  if (fs.existsSync(staleRoot)) {
    const batches = fs.readdirSync(staleRoot).filter((n) => BATCH_RE.test(n)).sort().reverse();
    for (const old of batches.slice(STALE_KEEP)) {
      fs.rmSync(path.join(staleRoot, old), { recursive: true, force: true });
      console.log(`[build] 清掉更早的一批旧产物：_stale/${old}`);
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

/**
 * 撞 EBUSY 就重试整轮打包。
 *
 * Windows 上打包常撞到 `EBUSY: resource busy or locked`（拷贝
 * resources/brand/*.png 时）—— 杀毒实时扫描、资源管理器预览、
 * IDE/agent 的文件索引会**临时**抓住文件几秒。
 *
 * ⚠️ 为什么不是"打包前等它解锁"：那样只在开始前看一眼，
 * 而锁是几分钟后拷贝时才出现的（本轮实测：预检查全过，build 照样 EBUSY）。
 * 瞬时锁只能靠重试，不能靠事前的单次探测。
 */
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const BUILD_RETRIES = 3;
const RETRY_WAIT_MS = 8000;

function isLockError(err) {
  const msg = String((err && (err.message || err.code)) || '');
  return LOCK_CODES.has(err && err.code) || /EBUSY|resource busy|locked/i.test(msg);
}

async function buildWithRetry(run) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isLockError(err) || attempt >= BUILD_RETRIES) throw err;
      console.warn(
        `\n[build] 资源文件被临时占用（第 ${attempt}/${BUILD_RETRIES} 次尝试失败）：` +
        `\n  ${String(err.message).split('\n')[0]}` +
        `\n  多为杀毒/预览/文件索引瞬时抓句柄所致，${RETRY_WAIT_MS / 1000}s 后自动重试…`,
      );
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
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
  // 事前探测只当"提前告知"用（能提前发现被长期占住的文件），
  // 真正兜住瞬时锁的是下面的 buildWithRetry。
  waitForUnlocked(collectResourceFiles());

  const { build, Platform, Arch } = require('app-builder-lib');
  const { DIR_TARGET } = require('app-builder-lib/out/core');
  const pkg = require(path.join(ROOT, 'package.json'));

  // targets 有两种形态：
  //   仅目录 → DIR_TARGET（"dir"），并把 config.win.target 清掉，否则仍会跑 NSIS
  //   完整   → undefined，交给 config.win.target 里的 nsis + portable
  const config = { ...pkg.build };
  let targets;
  if (dirOnly) {
    config.win = { ...config.win, target: undefined };
    targets = Platform.WINDOWS.createTarget([DIR_TARGET], Arch.x64);
  } else {
    targets = Platform.WINDOWS.createTarget(undefined, Arch.x64);
  }

  console.log(`[build] ${dirOnly ? '仅目录（跳过 NSIS）' : '完整安装包'} · 输出 dist/`);

  const result = await buildWithRetry(() => build({
    targets,
    projectDir: ROOT,
    config,
    publish: 'never',
  }));

  console.log('\n[build] 完成，产物：');
  for (const f of result) {
    console.log('  ' + path.relative(ROOT, f));
  }
}

main().catch((err) => {
  console.error('\n[build] 失败：');
  console.error(err && err.stack ? err.stack : err);
  if (isLockError(err)) {
    console.error('\n  重试 ' + BUILD_RETRIES + ' 次仍被占用。请手动排除：');
    console.error('  · 关掉资源管理器里正在预览该 PNG 的窗口');
    console.error('  · 杀毒软件把项目目录加入实时扫描排除项');
    console.error('  · 确认没有正在运行的 阿一古数模.exe / 上一轮打包进程');
  }
  process.exit(1);
});
