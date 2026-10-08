'use strict';

/**
 * 授权模块 —— 卡密 / 一机一码 / 体验版
 *
 * 设计要点（都是踩过坑之后定的）：
 *
 * 1. **卡密本身不含签名**。HMAC 密钥必须放进客户端，能被逆向出来 ——
 *    那等于把发卡权一起发出去了。改成：
 *      卡密 + 机器码 → 云端校验 → 返回 **Ed25519 签名的授权凭证**
 *    客户端只内嵌**公钥**：能验签、不能伪造。私钥永远不进客户端。
 *
 * 2. **机器码只用取到值的硬件项**。取不到就跳过，不拿空串充数 ——
 *    否则两台都取不到主板序列号的机器会算出同一个码。
 *
 * 3. **垃圾值过滤分两类**（实测踩过两次）：
 *    - 前缀类（`To be filled by O.E.M.` 带后缀）→ 必须前缀匹配
 *    - 全等类（`00000000`）→ 必须全等匹配，写成前缀会把合法的
 *      `0000_0000_...` 盘序列号一起误杀，每台 NVMe 机器的指纹都掉一档
 *
 * 4. **体验版防改系统时间**：记 firstRunAt 和 lastSeenAt（只增不减），
 *    已用时 = max(now, lastSeenAt) - firstRunAt。把时间调回去不会续命。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 内嵌公钥 —— 可以进客户端，它只能验签 */
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAwI2vcYAMUpemxNUHfNOsssHDMfSFjEcwDnbSDklhCcU=
-----END PUBLIC KEY-----`;

/**
 * 体验版时长：2 小时。
 *
 * 为什么这么短：数模竞赛是「试一下就知道值不值」的场景，
 * 2 小时够跑通一两个步骤、看到真实产出，但跑不完一个完整任务。
 * 改这个值只影响新用户 —— 已经在计时的用户，firstRunAt 已经写进
 * license.json 了，改常量不会让他们重置。
 */
const TRIAL_MS = 2 * 60 * 60 * 1000;

/** 离线宽限期：授权凭证过期后还能用多久（给用户留出联网复验的余地） */
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// ===========================================================================
// 一、机器指纹
// ===========================================================================

const JUNK_PREFIX = /^(to be filled|default string|none|n\/a|unknown|invalid|not specified)/i;
const JUNK_FULL = /^0+$/;

function isUsable(v) {
  if (!v) return false;
  const t = String(v).trim();
  return t.length > 0 && !JUNK_PREFIX.test(t) && !JUNK_FULL.test(t);
}

/** 读硬件标识。⚠️ 实测 WMI 查询约 1400ms —— 调用方必须缓存，别卡启动 */
function readHardware() {
  if (process.platform !== 'win32') {
    // 非 Windows 走弱标识，够开发用；正式发行只支持 Windows
    return { CPU: os.cpus()[0]?.model || '', BOARD: '', DISK: '' };
  }
  const script = [
    '$c = (Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId;',
    '$b = (Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber;',
    '$d = (Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1).SerialNumber;',
    'Write-Output ("CPU=" + $c); Write-Output ("BOARD=" + $b); Write-Output ("DISK=" + $d);',
  ].join(' ');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });

  const hw = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) hw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return hw;
}

function computeMachineCode(hw) {
  const parts = [];
  if (isUsable(hw.CPU)) parts.push('cpu:' + hw.CPU.trim());
  if (isUsable(hw.BOARD)) parts.push('board:' + hw.BOARD.trim());
  if (isUsable(hw.DISK)) parts.push('disk:' + hw.DISK.trim());
  if (!parts.length) {
    // 兜底：CPU 型号 + 核心数 + 内存。⚠️ 这个组合**不唯一**，
    // 走到这里说明硬件信息全取不到，应提示用户联系客服而不是直接发卡。
    parts.push('fallback:' + (os.cpus()[0]?.model || '') + ':' + os.cpus().length + ':' + os.totalmem());
  }
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return {
    code: hash.slice(0, 16).toUpperCase(),
    parts: parts.length,
    degraded: parts.length < 3,   // 降级：指纹强度不够，激活时要提醒
  };
}

/**
 * 取机器码。
 *
 * ⚠️ 真实硬件指纹**每个进程都重算**，磁盘缓存只做「WMI 读不到时的兜底」。
 * 以前是「有缓存就信缓存」，但缓存是明文 JSON —— 把激活机器的
 * license.json + machine.json 一起拷到新电脑，验签读到的就是别人的机器码，
 * 一机一码直接被克隆。现在新机器上永远先算出自己的码，凭证对不上就失效。
 *
 * WMI 实测约 1.4s，所以进程内 memo：一次启动只算一次，后续全走内存。
 * 磁盘缓存仍保留：① WMI 偶发失败（冷启动常见）时保持机器码稳定；
 * ② 真实指纹与缓存不一致时自愈重写（换硬件 / 拷贝来的旧缓存）。
 */
const memoByDir = new Map();   // userData -> 机器码结果

function getMachineCode(userData, { force = false } = {}) {
  const key = String(userData);
  if (!force && memoByDir.has(key)) return memoByDir.get(key);
  const cacheFile = path.join(userData, 'machine.json');

  const readCache = () => {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && typeof c.code === 'string' && /^[0-9A-F]{16}$/.test(c.code)) return c;
    } catch { /* 没缓存或坏了 */ }
    return null;
  };

  // ① 真实指纹优先；WMI 不可用（沙箱 / 权限受限 / 冷启动超时）才退缓存
  let result = null;
  let fromCache = false;
  try {
    result = computeMachineCode(readHardware());
  } catch { /* 走缓存兜底 */ }
  if (!result) {
    result = readCache();
    fromCache = !!result;
  }
  if (!result) result = computeMachineCode({});   // 最终兜底：降级指纹（degraded=true）

  // 自愈：算出来的码和缓存不一致（换硬件 / 拷贝来的旧缓存）→ 重写缓存
  const cached = readCache();
  if (!cached || cached.code !== result.code) {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    } catch { /* 写不进就算了，下次再算 */ }
  }

  memoByDir.set(key, result);

  // 走了缓存兜底（本轮 WMI 失败）：30 秒后后台再试一次真实指纹，
  // 成功则自愈 —— 避免拷贝来的缓存把会话锁在错误的机器码上
  if (fromCache) {
    setTimeout(() => {
      try { getMachineCode(userData, { force: true }); } catch { /* ignore */ }
    }, 30_000).unref?.();
  }
  return result;
}

// ===========================================================================
// 二、授权凭证（Ed25519）
// ===========================================================================

/**
 * 验签并检查凭证是否可用。
 * @returns {{ok:boolean, payload?:object, why?:string, expired?:boolean}}
 */
function verifyCredential(credential, machineCode, { now = Date.now() } = {}) {
  if (!credential || typeof credential !== 'string') return { ok: false, why: '没有授权凭证' };
  const dot = credential.indexOf('.');
  if (dot <= 0) return { ok: false, why: '凭证格式不对' };

  const body = credential.slice(0, dot);
  const sig = credential.slice(dot + 1);

  let good;
  try {
    good = crypto.verify(null, Buffer.from(body), PUBLIC_KEY_PEM, Buffer.from(sig, 'base64url'));
  } catch {
    return { ok: false, why: '凭证解析失败' };
  }
  if (!good) return { ok: false, why: '签名不合法（凭证被改过）' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, why: '凭证内容解析失败' };
  }

  // 机器绑定：换机就失效
  if (payload.machine && machineCode && payload.machine !== machineCode) {
    return { ok: false, why: '这张授权绑的是另一台电脑' };
  }

  // 过期：给一段离线宽限期，避免断网/服务端故障时用户被直接锁在外面
  const expired = typeof payload.expireAt === 'number' && now > payload.expireAt;
  if (expired && now > payload.expireAt + OFFLINE_GRACE_MS) {
    return { ok: false, expired: true, why: '授权已过期' };
  }

  return { ok: true, payload, expired, why: expired ? '已过期，宽限期内' : undefined };
}

// ===========================================================================
// 三、本地状态存储
// ===========================================================================

function statePath(userData) {
  return path.join(userData, 'license.json');
}

function readState(userData) {
  try {
    return JSON.parse(fs.readFileSync(statePath(userData), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(userData, patch) {
  const next = { ...readState(userData), ...patch };
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(statePath(userData), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* 写不进就维持内存态 */ }
  return next;
}

// ===========================================================================
// 四、体验版
// ===========================================================================

/**
 * 读体验版剩余时长，顺带把 lastSeenAt 推到当前值。
 *
 * ⚠️ lastSeenAt **只增不减** —— 用户把系统时间调回去，剩余时间不会变多。
 * 反过来把时间往未来调，会加速到期（对他自己不利，没人会这么干）。
 */
function touchTrial(userData, { now = Date.now(), autoStart = true } = {}) {
  const st = readState(userData);
  let firstRunAt = st.trialFirstRunAt;
  if (!firstRunAt) {
    if (!autoStart) return { started: false, remainingMs: TRIAL_MS, expired: false };
    firstRunAt = now;
  }
  const lastSeenAt = Math.max(st.trialLastSeenAt || 0, now);
  writeState(userData, { trialFirstRunAt: firstRunAt, trialLastSeenAt: lastSeenAt });

  const elapsed = Math.max(now, lastSeenAt) - firstRunAt;
  const remainingMs = Math.max(0, TRIAL_MS - elapsed);
  return { started: true, firstRunAt, remainingMs, expired: remainingMs <= 0 };
}

/** 格式化成「还剩 5 小时 12 分」 */
function formatRemaining(ms) {
  if (ms <= 0) return '已到期';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `还剩 ${h} 小时 ${m} 分`;
  if (m > 0) return `还剩 ${m} 分`;
  return '不到 1 分钟';
}

// ===========================================================================
// 五、对外：当前授权状态
// ===========================================================================

/**
 * @returns {{mode:'activated'|'trial'|'expired'|'none', ...}}
 */
function getLicenseState(userData, { now = Date.now() } = {}) {
  const st = readState(userData);
  const machine = getMachineCode(userData);

  // ① 有授权凭证？验签 + 查机器绑定 + 查过期
  if (st.credential) {
    const v = verifyCredential(st.credential, machine.code, { now });
    if (v.ok) {
      return {
        mode: 'activated',
        machine: machine.code,
        machineDegraded: machine.degraded,
        card: v.payload.card,
        edition: v.payload.edition || 'pro',
        expireAt: v.payload.expireAt,
        needsRefresh: !!v.expired,      // 过期但还在宽限期 → 该联网复验了
        message: v.expired ? '授权待刷新（宽限期内）' : undefined,
      };
    }
    // 凭证坏了（换机 / 被篡改）→ 落到体验版或过期
  }

  // ② 没有有效凭证 → 看体验版
  const trial = touchTrial(userData, { now });
  if (!trial.expired) {
    return {
      mode: 'trial',
      machine: machine.code,
      machineDegraded: machine.degraded,
      remainingMs: trial.remainingMs,
      remainingText: formatRemaining(trial.remainingMs),
    };
  }

  // ③ 体验版也用完了
  return {
    mode: st.trialFirstRunAt ? 'expired' : 'none',
    machine: machine.code,
    machineDegraded: machine.degraded,
    message: st.trialFirstRunAt ? '体验期已结束' : '未激活',
  };
}

module.exports = {
  TRIAL_MS,
  OFFLINE_GRACE_MS,
  PUBLIC_KEY_PEM,
  readHardware,
  computeMachineCode,
  getMachineCode,
  verifyCredential,
  touchTrial,
  formatRemaining,
  getLicenseState,
  readState,
  writeState,
};
