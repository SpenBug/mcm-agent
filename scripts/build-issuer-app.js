#!/usr/bin/env node
'use strict';

/**
 * 打包「卡密签发器」独立应用。
 *
 *   node scripts/build-issuer-app.js           # 出 NSIS 安装包 + 便携版到 dist-issuer/
 *   node scripts/build-issuer-app.js --dir     # 只出未打包目录（快，用于验收）
 *
 * 为什么复用仓库根的 node_modules 而不是在 tools/issuer-app/ 里再装一套：
 * electron 约 200MB、electron-builder 又是一大坨。app-builder-lib 支持
 * 用 `projectDir` 指向应用目录、而 electron 依赖从当前 node 的解析路径找，
 * 所以这里保持 cwd 在仓库根、把 projectDir 指到 tools/issuer-app 即可。
 *
 * 与根打包脚本共用两个真实教训（照抄，别重新踩）：
 *  1. 必须在**真 Node** 下跑。node 被 Electron 包装时 fs 被打过补丁，
 *     凡是以 .asar 结尾的路径都按归档处理 → 写 default_app.asar 报
 *     "Invalid package"，错误信息完全指不到根因。
 *  2. Windows 上打包常撞 EBUSY（杀毒/预览/索引临时抓句柄）→ 整轮重试。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'tools', 'issuer-app');
const dirOnly = process.argv.includes('--dir');

/* ---------------------------------------------------------------- 真 Node */

function isRealNode(exe) {
  try {
    // 带 ELECTRON_RUN_AS_NODE 探测：否则候选里若是真正的 electron.exe，
    // `-p` 会被当成普通启动参数，直接弹出一个 GUI 窗口。
    const r = spawnSync(exe, ['-p', 'process.versions.electron ? 1 : 0'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10000,
    });
    return r.status === 0 && r.stdout.trim() === '0';
  } catch { return false; }
}

function ensureRealNode() {
  if (isRealNode(process.execPath)) return;
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [
    process.env.NODE_EXE,
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ].filter(Boolean);
  const real = candidates.find((c) => { try { return fs.existsSync(c) && isRealNode(c); } catch { return false; } });
  if (!real) {
    console.error('[issuer-app] 当前 node 是 Electron 包装的，会拦掉 .asar 写入导致打包报 "Invalid package"。');
    console.error('             请装 Node.js，或显式指定：$env:NODE_EXE="C:\\Program Files\\nodejs\\node.exe"');
    process.exit(1);
  }
  console.log(`[issuer-app] 改用真 Node 重启：${real}`);
  const r = spawnSync(real, [path.join(__dirname, 'build-issuer-app.js'), ...process.argv.slice(2)], {
    stdio: 'inherit', cwd: ROOT,
  });
  process.exit(r.status ?? 1);
}

/* ---------------------------------------------------------------- 前置检查 */

/**
 * 打包前先同步 vendor，并**确认 vendor 里没有私钥/台账**。
 * 签发器是要被分发/拷贝的，一旦把私钥打进去，等于把发卡权送人。
 * 这条检查在 sync-issuer-app.js 里也有，这里再拦一次 —— 打包是最后一道门。
 */
function syncVendorOrAbort() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-issuer-app.js')], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('[issuer-app] vendor 同步失败：');
    console.error((r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
  console.log('[issuer-app] vendor 已同步');

  const vendor = path.join(APP_DIR, 'vendor');
  const bad = [];
  for (const f of fs.readdirSync(vendor)) {
    const t = fs.readFileSync(path.join(vendor, f), 'utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) bad.push(`${f} 含私钥 PEM`);
    if (/^card,machine,edition,competition,issuedAt/m.test(t)) bad.push(`${f} 含卡密台账`);
  }
  if (bad.length) {
    console.error('[issuer-app] ✗ vendor 里出现了不该打包的东西：');
    for (const b of bad) console.error('    ' + b);
    console.error('  中止打包 —— 签发器会被分发，绝不能带私钥或台账。');
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- 打包 */

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const BUILD_RETRIES = 3;
const RETRY_WAIT_MS = 8000;
const isLockError = (e) => LOCK_CODES.has(e && e.code) || /EBUSY|resource busy|locked/i.test(String((e && e.message) || ''));

async function buildWithRetry(run) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await run(); } catch (err) {
      if (!isLockError(err) || attempt >= BUILD_RETRIES) throw err;
      console.warn(`\n[issuer-app] 资源被临时占用（第 ${attempt}/${BUILD_RETRIES} 次失败）：`
        + `\n  ${String(err.message).split('\n')[0]}\n  ${RETRY_WAIT_MS / 1000}s 后重试…`);
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
}

/** 清掉上一轮的交付物，避免"打包失败但旧包还在、看起来像最新" */
function cleanStale() {
  const out = path.join(ROOT, 'dist-issuer');
  if (!fs.existsSync(out)) return;
  for (const name of fs.readdirSync(out)) {
    if (name === 'win-unpacked' || name.endsWith('.tmp')) {
      fs.rmSync(path.join(out, name), { recursive: true, force: true });
      console.log(`[issuer-app] 清理可再生中间产物：${name}`);
    }
  }
}

async function main() {
  ensureRealNode();
  syncVendorOrAbort();
  cleanStale();

  const { build, Platform, Arch } = require('app-builder-lib');
  const { DIR_TARGET } = require('app-builder-lib/out/core');
  const pkg = require(path.join(APP_DIR, 'package.json'));

  const config = { ...pkg.build };
  // directories.output 是相对**应用目录**的，转成绝对路径免得歧义
  config.directories = { ...config.directories, output: path.join(ROOT, 'dist-issuer') };

  /**
   * 必须显式钉住 electronVersion。
   *
   * 应用自己的 package.json 里**没有** electron 依赖（复用仓库根 node_modules
   * 那一套，避免再下 200MB），而 electron-builder 是从"项目目录的
   * node_modules/electron"推版本的 —— 推不到就报
   * `version ("^44.4.3") is not fixed in project`（根 package.json 里是范围号）。
   * 所以这里读**实际装的那个**版本号显式传进去，保证打出来的包与开发态同版本。
   */
  let electronVersion;
  try {
    electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  } catch {
    console.error('[issuer-app] 读不到 node_modules/electron 版本，先在仓库根跑 npm install');
    process.exit(1);
  }
  config.electronVersion = electronVersion;
  console.log(`[issuer-app] electron ${electronVersion}`);

  let targets;
  if (dirOnly) {
    config.win = { ...config.win, target: undefined };
    targets = Platform.WINDOWS.createTarget([DIR_TARGET], Arch.x64);
  } else {
    targets = Platform.WINDOWS.createTarget(undefined, Arch.x64);
  }

  console.log(`[issuer-app] ${dirOnly ? '仅目录' : '完整安装包'} · 输出 dist-issuer/`);

  const result = await buildWithRetry(() => build({
    targets,
    projectDir: APP_DIR,
    config,
    publish: 'never',
  }));

  console.log('\n[issuer-app] 完成，产物：');
  for (const f of result) console.log('  ' + path.relative(ROOT, f));
  console.log('\n  双击安装包会创建桌面与开始菜单快捷方式。');
  console.log('  便携版可直接拷走，但私钥与台账在 %APPDATA%\\阿一古数模签发器\\。');
}

main().catch((err) => {
  console.error('\n[issuer-app] 失败：');
  console.error(err && err.stack ? err.stack : err);
  try {
    const log = path.join(ROOT, 'dist-issuer', 'build-error.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, String((err && err.stack) || err), 'utf8');
    console.error(`\n  错误原文已写入：${path.relative(ROOT, log)}`);
  } catch { /* ignore */ }
  process.exit(1);
});
