/**
 * 签发器端到端：起本地服务 → 签一张 → 用客户端的真实逻辑验证它能解锁。
 *
 * ⚠️ 不复制签发逻辑 —— 服务本身 require 的就是 tools/issue.js，
 * 客户端用的是 src/main/license.js，两边都是真货。
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const L = require(path.join(__dirname, '..', 'src', 'main', 'license.js'));

const PORT = 38902;
const TOKEN = 'e2e-token';
process.env.MCM_ISSUER_NO_OPEN = '1';
process.env.MCM_ISSUER_TOKEN = TOKEN;
process.env.MCM_ISSUER_PORT = String(PORT);

// require 即启动服务
require(path.join(__dirname, '..', 'tools', 'issuer.js'));

const MACHINE = '7E842A70F9986EB7';
let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function freshUserData(machine) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'issuer-e2e-'));
  fs.writeFileSync(path.join(d, 'machine.json'),
    JSON.stringify({ code: machine, parts: 3, degraded: false }), 'utf8');
  return d;
}

setTimeout(async () => {
  const base = `http://127.0.0.1:${PORT}`;
  const post = (p, body) => fetch(`${base}${p}?t=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

  console.log('=== ① 鉴权 ===');
  const bad = await fetch(`${base}/api/ledger?t=wrong`);
  check('错 token 被拒（403）', bad.status === 403, String(bad.status));

  console.log();
  console.log('=== ② 签发 ===');
  const r = await post('/api/issue', { machine: MACHINE, days: 365, buyer: 'e2e' });
  check('签发成功', r.ok === true, r.error || '');
  check('机器码归一化成大写带横杠', r.machinePretty === '7E84-2A70-F998-6EB7', String(r.machinePretty));
  check('返回了卡号和到期日', !!r.card && !!r.expireText, r.card + ' / ' + r.expireText);

  console.log();
  console.log('=== ③ 客户端认不认（关键） ===');
  const d1 = freshUserData(MACHINE);
  L.writeState(d1, { credential: r.credential });
  const st = L.getLicenseState(d1);
  check('本机能激活', st.mode === 'activated', st.mode);
  check('  卡号传递正确', st.card === r.card, String(st.card));

  console.log();
  console.log('=== ④ 换台电脑必须失效 ===');
  const d2 = freshUserData('AAAABBBBCCCCDDDD');
  L.writeState(d2, { credential: r.credential });
  check('别的机器激活不了', L.getLicenseState(d2).mode !== 'activated', L.getLicenseState(d2).mode);

  console.log();
  console.log('=== ⑤ 输入容错 ===');
  const r2 = await post('/api/issue', { machine: '7e84-2a70-f998-6eb7', days: 30 });
  check('小写 + 带横杠也接受', r2.ok === true && r2.machine === MACHINE, r2.error || String(r2.machine));
  const r3 = await post('/api/issue', { machine: 'xyz', days: 30 });
  check('无效机器码被拒', r3.ok === false, String(r3.ok));
  const r4 = await post('/api/issue', { machine: MACHINE, days: -5 });
  check('负数天数被拒', r4.ok === false, String(r4.ok));

  fs.rmSync(d1, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });

  console.log();
  console.log(`  结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
}, 800);
