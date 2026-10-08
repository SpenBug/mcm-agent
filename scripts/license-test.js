/**
 * 授权模块测试。
 *
 * ⚠️ 沙箱里 execFileSync 会 EBUSY，所以**预先写好 machine.json 缓存**，
 * 让 getMachineCode 走缓存分支，不触发 WMI 查询。
 * 缓存值是本机实测出来的真实机器码。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../src/main/license');

const REAL_MACHINE = '7E842A70F9986EB7';
const TMP = path.join(os.tmpdir(), 'lic-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'machine.json'),
  JSON.stringify({ code: REAL_MACHINE, parts: 3, degraded: false }), 'utf8');

const priv = fs.readFileSync(path.join(__dirname, '..', 'keys', 'license-private.pem'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), priv).toString('base64url');
  return body + '.' + sig;
}

// ---------- ① 机器指纹 ----------
console.log('=== ① 机器指纹 ===');
const cached = L.getMachineCode(TMP);
// 新语义：真实指纹优先，WMI 读不到（沙箱里 execFileSync 会 EBUSY）才回退缓存 ——
// 缓存不再被无条件信任，license.json + machine.json 双文件克隆会失效
check('硬件读不到时回退缓存', cached.code === REAL_MACHINE, cached.code);
check('同进程二次调用走 memo', L.getMachineCode(TMP).code === REAL_MACHINE);

const base = { CPU: 'BFEBFBFF000906A3', BOARD: 'NBQFH11001336F8CDA3400', DISK: '0000_0000_0000_0001_00A0_7521_32DC_F4DE.' };
check('本机 3 项全参与', L.computeMachineCode(base).parts === 3);
check('本机机器码正确', L.computeMachineCode(base).code === REAL_MACHINE, L.computeMachineCode(base).code);
check('同输入结果稳定', L.computeMachineCode(base).code === L.computeMachineCode({ ...base }).code);
check('换主板会变', L.computeMachineCode({ ...base, BOARD: 'X' }).code !== REAL_MACHINE);
check('主板垃圾值降为 2 项', L.computeMachineCode({ ...base, BOARD: 'To be filled by O.E.M.' }).parts === 2);
check('盘序列号全 0 降为 2 项', L.computeMachineCode({ ...base, DISK: '000000000000' }).parts === 2);
check('全空走兜底且标记降级', L.computeMachineCode({ CPU: '', BOARD: '', DISK: '' }).degraded === true);
check('盘序列号带前导 0 不被误杀', L.computeMachineCode({ ...base, DISK: '0000ABC' }).parts === 3);

// ---------- ② 授权凭证 ----------
console.log();
console.log('=== ② 授权凭证验签 ===');
const now = Date.now();
const future = now + 90 * 24 * 3600 * 1000;
const goodCred = sign({ card: 'MCM-2027-A3F9-8B2E-4C71', machine: REAL_MACHINE, edition: 'pro', expireAt: future, issuedAt: now });

check('正常凭证通过', L.verifyCredential(goodCred, REAL_MACHINE).ok);
check('换台电脑被拒', L.verifyCredential(goodCred, 'AAAAAAAAAAAAAAAA').ok === false);
check('  且理由是机器不匹配', /另一台电脑/.test(L.verifyCredential(goodCred, 'AAAA').why || ''), L.verifyCredential(goodCred, 'AAAA').why);

// 篡改：改 body 但签名不动
const tampered = Buffer.from(JSON.stringify({ card: 'X', machine: REAL_MACHINE, expireAt: 9e15 })).toString('base64url')
  + '.' + goodCred.slice(goodCred.indexOf('.') + 1);
check('篡改内容被签名拦住', L.verifyCredential(tampered, REAL_MACHINE).ok === false);
check('  且理由是签名不合法', /签名/.test(L.verifyCredential(tampered, REAL_MACHINE).why || ''), L.verifyCredential(tampered, REAL_MACHINE).why);

// 伪造：拿客户端里的公钥当私钥签（应该失败）
const forged = (() => {
  const body = Buffer.from(JSON.stringify({ card: 'FAKE', machine: REAL_MACHINE, expireAt: future })).toString('base64url');
  // 攻击者自己生成一对密钥来签 —— 客户端内嵌的是我们的公钥，验不过
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const sig = crypto.sign(null, Buffer.from(body), privateKey).toString('base64url');
  return body + '.' + sig;
})();
check('用别的密钥签的凭证被拒', L.verifyCredential(forged, REAL_MACHINE).ok === false);

// 过期与宽限
const expiredCred = sign({ card: 'C', machine: REAL_MACHINE, expireAt: now - 1000 });
const e = L.verifyCredential(expiredCred, REAL_MACHINE);
check('过期但在宽限期内仍可用', e.ok === true && e.expired === true);
const wayExpired = sign({ card: 'C', machine: REAL_MACHINE, expireAt: now - L.OFFLINE_GRACE_MS - 1000 });
check('超过宽限期被拒', L.verifyCredential(wayExpired, REAL_MACHINE).ok === false);

// ---------- ③ 体验版 ----------
console.log();
console.log('=== ③ 体验版（半天）===');
const T2 = path.join(os.tmpdir(), 'lic-trial-' + Date.now());
fs.mkdirSync(T2, { recursive: true });
fs.writeFileSync(path.join(T2, 'machine.json'), JSON.stringify({ code: REAL_MACHINE, parts: 3, degraded: false }));

const t0 = now;
const a = L.touchTrial(T2, { now: t0 });
check('首次启动自动开始计时', a.started === true && a.remainingMs === L.TRIAL_MS);
check('TRIAL_MS 是 2 小时', L.TRIAL_MS === 2 * 3600 * 1000, String(L.TRIAL_MS / 3600000) + ' 小时');

const b = L.touchTrial(T2, { now: t0 + 30 * 60 * 1000 });   // 半小时后
check('半小时后剩 1.5 小时', Math.round(b.remainingMs / 60000) === 90, Math.round(b.remainingMs / 60000) + ' 分');

// ⚠️ 关键：把系统时间调回去，剩余时间不能变多
const c = L.touchTrial(T2, { now: t0 });                  // 时间倒退回起点
check('系统时间调回去不能续命', c.remainingMs <= b.remainingMs, `${Math.round(c.remainingMs / 60000)}分 vs ${Math.round(b.remainingMs / 60000)}分`);

// 把时间调大 → 加速到期
const d = L.touchTrial(T2, { now: t0 + 3 * 3600 * 1000 });
check('时间调到 3 小时后已到期', d.expired === true && d.remainingMs === 0);

check('格式化：小时', L.formatRemaining(1 * 3600000 + 12 * 60000) === '还剩 1 小时 12 分', L.formatRemaining(1 * 3600000 + 12 * 60000));
check('格式化：分钟', L.formatRemaining(45 * 60000) === '还剩 45 分');
check('格式化：到期', L.formatRemaining(0) === '已到期');

// ---------- ④ 状态机 ----------
console.log();
console.log('=== ④ 授权状态 ===');
const T3 = path.join(os.tmpdir(), 'lic-state-' + Date.now());
fs.mkdirSync(T3, { recursive: true });
fs.writeFileSync(path.join(T3, 'machine.json'), JSON.stringify({ code: REAL_MACHINE, parts: 3, degraded: false }));

check('全新机器 → trial', L.getLicenseState(T3, { now }).mode === 'trial');

L.writeState(T3, { credential: goodCred });
const s2 = L.getLicenseState(T3, { now });
check('写入有效凭证 → activated', s2.mode === 'activated', s2.mode);
check('  带上卡密号', s2.card === 'MCM-2027-A3F9-8B2E-4C71', String(s2.card));

L.writeState(T3, { credential: sign({ card: 'C', machine: 'OTHERMACHINE00000', expireAt: future }) });
check('凭证绑的是别的机器 → 不能激活', L.getLicenseState(T3, { now }).mode !== 'activated');

L.writeState(T3, { credential: '' });
L.writeState(T3, { trialFirstRunAt: now - L.TRIAL_MS - 1000, trialLastSeenAt: now });
check('体验期用完且无凭证 → expired', L.getLicenseState(T3, { now }).mode === 'expired');

fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(T2, { recursive: true, force: true });
fs.rmSync(T3, { recursive: true, force: true });

console.log();
console.log(`  结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
