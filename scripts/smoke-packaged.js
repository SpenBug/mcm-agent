#!/usr/bin/env node
'use strict';

/**
 * 对打包产物跑冒烟 —— 发版前验"包里到底能不能跑"。
 *
 * 为什么需要它：开发态冒烟全绿 ≠ 包里能跑。本轮反复栽在这类差异上
 * （图标：文件在包里、内容是旧的，还静默发版）。打包 exe 是 GUI 子系统
 * 程序，Windows 下 stdout 看不见，所以成败判定依赖 smoke 自己
 * 写报告 + 带退出码（见 src/main/smoke-verdict.js）。
 *
 * ⚠️ 本脚本必须清掉 ELECTRON_RUN_AS_NODE —— 和 dev.js 同一个坑：
 * 某些环境（含 CI / 沙箱 / agent 集成终端）会注入 ELECTRON_RUN_AS_NODE=1，
 * 此时 exe 不再加载 app.asar，而是退化成裸 node 去解析命令行参数，
 * `--smoke` 被当成非法 node 选项，**退出码 9 且什么都不写**。
 * 现象看起来像"打包的 exe 坏了"，实际是环境变量，极难定位（本轮实测踩过）。
 *
 * 用法：npm run smoke:packaged   （先 npm run dist 或 npm run pack）
 * 退出码：0 通过 / 1 冒烟失败或报告异常 / 2 环境不满足（没有包）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const REPORT = process.env.MCM_SMOKE_OUT || path.join(os.tmpdir(), 'mcm-smoke-packaged.txt');
const TIMEOUT_MS = 15 * 60 * 1000;

function findExe() {
  if (!fs.existsSync(UNPACKED)) return null;
  // 排除卸载器（若存在）；主程序 exe 以 productName 命名
  const exes = fs.readdirSync(UNPACKED)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .filter((f) => !/unins/i.test(f));
  return exes.length ? path.join(UNPACKED, exes[0]) : null;
}

const exe = findExe();
if (!exe) {
  console.error('✗ 找不到 dist/win-unpacked/*.exe —— 先跑 npm run dist（或 npm run pack）');
  process.exit(2);
}

try { fs.rmSync(REPORT, { force: true }); } catch { /* 旧报告删不掉不影响判定：下面按时间戳核对 */ }

const env = { ...process.env, MCM_SMOKE_OUT: REPORT };
delete env.ELECTRON_RUN_AS_NODE;   // 见文件头注释：不清掉的话 exe 会退化成裸 node

console.log(`[smoke:packaged] ${exe}`);
console.log(`[smoke:packaged] 报告 => ${REPORT}\n`);

const child = spawn(exe, ['--smoke', '--no-gpu'], { env, stdio: 'inherit' });

let settled = false;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  console.error('\n✗ 超时（>15 分钟）未退出，强制结束 —— 多半是窗口卡在某个对话框上');
  try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
}, TIMEOUT_MS);
if (typeof timer.unref === 'function') timer.unref();

child.on('error', (err) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error('✗ 启动失败：', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);

  let text;
  try {
    text = fs.readFileSync(REPORT, 'utf8');
  } catch {
    console.error(
      `\n✗ 读不到报告（${REPORT}）—— 冒烟根本没跑起来。` +
      `\n  退出码 ${code}${signal ? `（信号 ${signal}）` : ''}。` +
      (code === 9
        ? '\n  退出码 9 通常是 ELECTRON_RUN_AS_NODE 没清干净（exe 退化成裸 node，把 --smoke 当成非法参数）。'
        : ''),
    );
    process.exit(1);
  }

  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, 3);
  console.log('\n' + head.join('\n'));

  // 这三条核对是这条命令存在的全部意义：
  // 确认"跑的是包里的 exe"，而不是不小心用开发态 electron 跑了源码
  const header = head.join('\n');
  const problems = [];
  if (!/packaged=true/.test(header)) problems.push('报告里 packaged≠true —— 跑的可能不是打包产物');
  if (!header.includes(exe)) problems.push(`报告里的 execPath 与目标 exe 不一致：${exe}`);
  if (/smoke verdict: FAIL/.test(header)) {
    const at = lines.reduce((last, l, i) => (/^--- \d+ 项失败/.test(l) ? i : last), -1);
    if (at >= 0) console.log('\n' + lines.slice(at).join('\n'));
    problems.push('冒烟判定为 FAIL（明细见上）');
  }

  if (problems.length) {
    console.log('');
    for (const p of problems) console.log('✗ ' + p);
    process.exit(1);
  }

  console.log(`\n✓ 打包产物冒烟通过（${(header.match(/pass=\d+/) || [''])[0]}，退出码 ${code}）`);
  process.exit(0);
});
