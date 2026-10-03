'use strict';

/**
 * draw.io 桌面版探测与导出。
 *
 * ⚠️ 关键坑：drawio 用 commander 解析参数，且开了 allowUnknownOption()，
 * 未知开关会被塞进 program.args，导致它把 `--disable-gpu` 当成输入文件而报
 * "input file/directory not found"（源码里只特殊过滤了 `--no-sandbox`）。
 *
 * 正确顺序：**输入文件必须放在最前面**
 *   drawio <input.drawio> --no-sandbox --disable-gpu --export --format pdf --crop --output <out.pdf>
 */

const fs = require('node:fs');
const path = require('node:path');
const { runProcess } = require('../agent/tools');

const EXE_NAME = process.platform === 'win32' ? 'draw.io.exe' : 'draw.io';

/** 常见安装位置 */
function candidatePaths() {
  const out = [];
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';

  out.push(path.join(pf, 'draw.io', EXE_NAME));
  out.push(path.join(pf86, 'draw.io', EXE_NAME));
  if (local) out.push(path.join(local, 'Programs', 'draw.io', EXE_NAME));

  // 便携版 / 自定义目录的常见位置
  for (const drive of ['C:', 'D:', 'E:']) {
    out.push(path.join(drive + '\\', 'Drawio', 'draw.io', EXE_NAME));
    out.push(path.join(drive + '\\', 'draw.io', EXE_NAME));
    out.push(path.join(drive + '\\', 'Program Files', 'draw.io', EXE_NAME));
  }
  return out;
}

/** 从开始菜单快捷方式里挖路径（跨机器最通用，无需 COM） */
function fromStartMenu() {
  const dirs = [
    process.env.ProgramData
      ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      : null,
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      : null,
  ].filter(Boolean);

  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!/draw\.?io/i.test(f) || !f.toLowerCase().endsWith('.lnk')) continue;
      try {
        const buf = fs.readFileSync(path.join(dir, f));
        // .lnk 里存的是 ANSI/UTF-16 明文路径，直接正则挖
        const hit = buf.toString('latin1').match(/[A-Za-z]:\\[^\x00-\x1f"]*draw\.io\.exe/i);
        if (hit) found.push(hit[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return found;
}

let cached = null;

/** 探测 draw.io 可执行文件；返回路径或 null */
function detectDrawio(force = false) {
  if (cached && !force) return cached;

  const tried = [];
  for (const p of [...fromStartMenu(), ...candidatePaths()]) {
    if (p && !tried.includes(p) && fs.existsSync(p)) {
      cached = p;
      return p;
    }
    tried.push(p);
  }
  cached = null;
  return null;
}

/**
 * 导出一张图。
 * @param {string} drawioExe
 * @param {string} inputFile  .drawio 绝对路径
 * @param {string} outputFile 输出绝对路径
 */
async function exportFigure(drawioExe, inputFile, outputFile, opts = {}) {
  const { format = 'pdf', crop = true, scale = 1, timeout = 150000, onOutput } = opts;

  if (!fs.existsSync(inputFile)) throw new Error(`输入文件不存在：${inputFile}`);

  const args = [
    `"${inputFile}"`, // ← 必须在最前
    '--no-sandbox',
    '--disable-gpu',
    '--export',
    '--format',
    format,
  ];
  if (crop && format === 'pdf') args.push('--crop');
  if (scale && scale !== 1 && format !== 'pdf') args.push('--scale', String(scale));
  args.push('--output', `"${outputFile}"`);

  const cmd = `"${drawioExe}" ${args.join(' ')}`;
  const r = await runProcess(cmd, { cwd: path.dirname(inputFile), timeout, shell: true, onOutput });

  const ok = r.code === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0;
  return {
    ok,
    code: r.code,
    command: cmd,
    output: outputFile,
    size: ok ? fs.statSync(outputFile).size : 0,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

module.exports = { detectDrawio, exportFigure, candidatePaths, fromStartMenu };
