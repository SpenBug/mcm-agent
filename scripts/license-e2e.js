/**
 * 端到端：签发工具产出的卡密，客户端必须认。
 *
 * 这是整条链路上最容易脱节的地方 —— 签发工具和客户端是两套代码，
 * 各自"看起来对"不代表能对接上。必须真跑一遍。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'src', 'main', 'license.js'));

// ⚠️ 不能 spawn 子进程（受限环境会 EBUSY），所以直接 require 工具、
// 调它的真函数 —— 不是复制一份逻辑来测。
const LEDGER = path.join(os.tmpdir(), 'e2e-ledger-' + Date.now() + '.csv');
process.env.MCM_LEDGER = LEDGER;
const issuer = require(path.join(ROOT, 'tools', 'issue.js'));

const MACHINE = '7E842A70F9986EB7';
const OTHER = 'AAAABBBBCCCCDDDD';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

/** 造一个干净的 userData，机器码走缓存避免触发 WMI */
function freshUserData(tag) {
  const d = path.join(os.tmpdir(), 'e2e-' + tag + '-' + Date.now() + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'machine.json'),
    JSON.stringify({ code: MACHINE, parts: 3, degraded: false }), 'utf8');
  return d;
}

function issue(args) { return issuer.issue(args); }

console.log('=== ① 签发 ===');
const r1 = issue({ machine: MACHINE, days: 365, buyer: '端到端测试' });
check('签发出卡密', r1.credential.length > 100, r1.credential.length + ' 字符');
check('卡号格式正确', /^MCM-\d{4}-\d{4}$/.test(r1.payload.card), r1.payload.card);
check('机器码已归一化', r1.payload.machine === MACHINE, r1.payload.machine);
check('台账写进去了', fs.existsSync(LEDGER) && fs.readFileSync(LEDGER, 'utf8').includes(MACHINE));

console.log();
console.log('=== ② 客户端认不认 ===');
const credential = r1.credential;
const T = freshUserData('ok');
check('新机器 → 先给体验版', L.getLicenseState(T).mode === 'trial');

L.writeState(T, { credential });
const st = L.getLicenseState(T);
check('写入卡密后 → activated', st.mode === 'activated', st.mode);
check('  卡号对得上', st.card === r1.payload.card, String(st.card));
check('  机器码对得上', st.machine === MACHINE, String(st.machine));

console.log();
console.log('=== ③ 换台电脑必须失效 ===');
const T2 = freshUserData('other');
fs.writeFileSync(path.join(T2, 'machine.json'), JSON.stringify({ code: OTHER, parts: 3, degraded: false }), 'utf8');
L.writeState(T2, { credential });
const st2 = L.getLicenseState(T2);
check('别的机器上不能激活', st2.mode !== 'activated', st2.mode);

console.log();
console.log('=== ④ 带横杠 / 小写的机器码也能签 ===');
const lower = issue({ machine: '7e84-2a70-f998-6eb7', days: 30 });
check('小写带横杠输入被接受', lower.credential.length > 100);
check('  归一化结果正确', lower.payload.machine === MACHINE, lower.payload.machine);
const T3 = freshUserData('lower');
L.writeState(T3, { credential: lower.credential });
check('  且客户端能认', L.getLicenseState(T3).mode === 'activated');

console.log();
console.log('=== ⑤ 过期与版本 ===');
const short = issue({ machine: MACHINE, days: 1 });
const T4 = freshUserData('short');
L.writeState(T4, { credential: short.credential });
check('1 天有效期的卡现在能激活', L.getLicenseState(T4).mode === 'activated');
// 把"现在"推到 40 天后（超过 1 天有效期 + 7 天宽限）
const later = Date.now() + 40 * 24 * 3600 * 1000;
check('  40 天后失效', L.getLicenseState(T4, { now: later }).mode !== 'activated');

const ent = issue({ machine: MACHINE, days: 365, edition: 'enterprise' });
const T5 = freshUserData('ent');
L.writeState(T5, { credential: ent.credential });
check('版本标识能带过去', L.getLicenseState(T5).edition === 'enterprise', String(L.getLicenseState(T5).edition));

console.log();
console.log('=== ⑥ 用 --until 按赛事周期签 ===');
const ev = issue({ machine: MACHINE, until: '2027-09-30' });
const expDate = new Date(ev.payload.expireAt).toISOString().slice(0, 10);
check('到期日就是 2027-09-30', expDate === '2027-09-30', expDate);

// 清理
for (const d of [T, T2, T3, T4, T5]) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(LEDGER, { force: true });

console.log();
console.log(`  结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
