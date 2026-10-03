'use strict';

/**
 * 开发态启动包装。
 *
 * 存在的理由：某些环境（含 CI / 沙箱 / 部分 IDE 集成终端）会注入
 * `ELECTRON_RUN_AS_NODE=1`，此时 electron.exe 会以纯 Node 模式运行，
 * `require('electron')` 返回的是 exe 路径字符串而不是 API，主进程会
 * 直接抛 "Cannot read properties of undefined (reading 'whenReady')"。
 * 这里在 spawn 前清掉该变量，保证以 browser 模式启动。
 *
 * 用法：npm start [-- --no-gpu]
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

delete process.env.ELECTRON_RUN_AS_NODE;

const electronPath = require('electron');
const projectRoot = path.join(__dirname, '..');
const args = [projectRoot, ...process.argv.slice(2)];

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('启动 Electron 失败：', err.message);
  process.exit(1);
});
