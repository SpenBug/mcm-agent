'use strict';

/**
 * 通用 Electron 脚本启动器：`node scripts/run-electron.js <file.js> [args...]`
 *
 * 为什么单独要一个：dev.js 固定启动整个应用（`electron <项目根>`），
 * 而生成图标这类工具脚本只想跑一个文件。
 * 同时必须清掉 ELECTRON_RUN_AS_NODE —— 带着它 electron.exe 会退化成纯 Node，
 * `nativeImage` / `app` 全都不存在（实测报 "Cannot read properties of undefined"）。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

delete process.env.ELECTRON_RUN_AS_NODE;

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('用法：node scripts/run-electron.js <script.js> [args...]');
  process.exit(2);
}

const electronPath = require('electron');
const child = spawn(electronPath, [path.resolve(script), ...rest], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('启动 Electron 失败：', err.message);
  process.exit(1);
});
