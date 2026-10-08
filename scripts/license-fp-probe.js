/**
 * 机器指纹探测 —— 先验证可行性，再谈集成。
 *
 * 目标：拿到一组**稳定且唯一**的硬件标识，哈希成 16 位机器码。
 * 稳定性要求：同一台机器重复运行结果必须一致；重装系统后也要一致。
 * 因此**不能**用：主机名、用户名、安装时间、网卡 MAC（可改且会随虚拟网卡变）。
 *
 * 取值来源（Windows）：
 *   CPU      Win32_Processor.ProcessorId
 *   主板     Win32_BaseBoard.SerialNumber
 *   系统盘   Win32_DiskDrive（Index=0）.SerialNumber
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');

function ps(script, timeout = 15000) {
  // -NoProfile 很关键：跳过用户 profile，省掉几百毫秒启动开销
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout, windowsHide: true });
  return out.trim();
}

function readHardware() {
  const script = [
    '$c = (Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId;',
    '$b = (Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber;',
    '$d = (Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1).SerialNumber;',
    'Write-Output ("CPU=" + $c);',
    'Write-Output ("BOARD=" + $b);',
    'Write-Output ("DISK=" + $d);',
  ].join(' ');

  const raw = ps(script);
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * 垃圾值过滤 —— 这里踩过两个坑，都实测复现过：
 *
 * ⚠️ 坑 1：写成 /^(...)$/ 全等匹配，抓不住 'To be filled by O.E.M.'
 *          （实际值带后缀）→ 垃圾值照样参与哈希。
 * ⚠️ 坑 2：把 '0+' 当前缀匹配 → 系统盘序列号 '0000_0000_...' 被误杀，
 *          **每台 NVMe 机器的指纹强度都掉一档**。
 *
 * 所以两类要分开：前缀类用前缀匹配，全等类必须全等。
 */
const JUNK_PREFIX = /^(to be filled|default string|none|n\/a|unknown|invalid|not specified)/i;
const JUNK_FULL = /^0+$/;

function isUsable(v) {
  if (!v) return false;
  const t = String(v).trim();
  return t.length > 0 && !JUNK_PREFIX.test(t) && !JUNK_FULL.test(t);
}

function fingerprint(hw) {
  // 只用**确实取到值**的部分参与哈希 —— 取不到就跳过，不要拿空字符串充数，
  // 否则一台取不到主板序列号的机器会和另一台同样取不到的算出同一个码。
  const parts = [];
  if (isUsable(hw.CPU)) parts.push('cpu:' + hw.CPU.trim());
  if (isUsable(hw.BOARD)) parts.push('board:' + hw.BOARD.trim());
  if (isUsable(hw.DISK)) parts.push('disk:' + hw.DISK.trim());
  if (!parts.length) {
    // 兜底：至少用 CPU 型号 + 核心数 + 内存。⚠️ 这个组合**不唯一**，
    // 走到这里说明硬件信息全取不到，应该提示用户联系客服而不是硬发卡。
    parts.push('fallback:' + (os.cpus()[0]?.model || '') + ':' + os.cpus().length + ':' + os.totalmem());
  }
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return { code: hash.slice(0, 16).toUpperCase(), parts, degraded: parts.length < 3 };
}

// ---------- 实测 ----------
console.log('=== 取硬件标识 ===');
const t0 = Date.now();
const hw = readHardware();
const t1 = Date.now();
console.log('  耗时: %d ms', t1 - t0);
for (const [k, v] of Object.entries(hw)) {
  console.log('  %-6s %s', k, v ? v : '（空）');
}

const fp = fingerprint(hw);
console.log();
console.log('=== 机器码 ===');
console.log('  %s', fp.code);
console.log('  参与哈希:', fp.parts.length, '项');
fp.parts.forEach((p) => console.log('    ' + p));

// 稳定性：连跑 3 次看是否一致
console.log();
console.log('=== 稳定性（连跑 3 次）===');
const codes = [];
for (let i = 0; i < 3; i += 1) {
  const t = Date.now();
  const c = fingerprint(readHardware()).code;
  codes.push(c);
  console.log('  第 %d 次: %s  (%d ms)', i + 1, c, Date.now() - t);
}
const stable = codes.every((c) => c === codes[0]);
console.log('  %s 三次一致', stable ? '✓' : '✗');

// 格式化展示（给用户看的版本）
const pretty = fp.code.match(/.{1,4}/g).join('-');
console.log();
console.log('  展示格式:', pretty);
