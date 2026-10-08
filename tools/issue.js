#!/usr/bin/env node
'use strict';

/**
 * 卡密签发工具 —— 只给你（卖家）用，**绝不能发给用户**。
 *
 * 工作方式：
 *   用户把机器码发给你 → 你跑这个工具 → 得到一段卡密 → 发回给用户
 *   用户在 exe 里粘贴 → 客户端用内嵌的公钥验签 → 解锁
 *
 * ⚠️ 这个工具持有**私钥**。它一旦泄露，任何人都能自己发卡。
 *    所以：不放进 exe 打包（package.json 的 files 只含 src/**，天然排除），
 *    keys/ 已在 .gitignore 里。
 *
 * 用法：
 *   node tools/issue.js new --machine 7E84-2A70-F998-6EB7 --days 365
 *   node tools/issue.js new --machine 7E84... --until 2027-09-30 --buyer 张三 --note 微信收款
 *   node tools/issue.js verify <卡密>
 *   node tools/issue.js list
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRIV_PATH = path.join(ROOT, 'keys', 'license-private.pem');
/** 台账路径可用环境变量覆盖 —— 测试要用临时文件，不能污染真台账 */
const LEDGER = process.env.MCM_LEDGER || path.join(__dirname, 'issued.csv');

const argv = process.argv.slice(2);
const cmd = argv[0];

function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
function flag(name) { return argv.includes('--' + name); }

/** 机器码归一化：用户可能发来带横杠/空格/小写的版本 */
function normalizeMachine(s) {
  const t = String(s || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (t.length !== 16) {
    throw new Error(`机器码应该是 16 位十六进制，收到 "${s}"（归一化后 ${t.length} 位）`);
  }
  return t;
}

function pretty(machine) { return machine.match(/.{1,4}/g).join('-'); }

function loadKey() {
  if (!fs.existsSync(PRIV_PATH)) {
    console.error('✗ 找不到私钥：' + PRIV_PATH);
    console.error('  先跑一次密钥生成（或从备份恢复 keys/license-private.pem）。');
    process.exit(2);
  }
  return fs.readFileSync(PRIV_PATH, 'utf8');
}

function sign(payload, priv) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), priv).toString('base64url');
  return body + '.' + sig;
}

// ---------------------------------------------------------------- new
/**
 * 签发一张卡密。**核心逻辑抽成函数**，方便被测试直接调用 ——
 * 测试里不能 spawn 子进程（受限环境会 EBUSY），但必须测到真逻辑，
 * 不能复制一份来测。
 *
 * @returns {{credential:string, payload:object}}
 */
function issue({ machine, days, until, edition = 'pro', buyer = '', note = '', now = Date.now() }) {
  const priv = loadKey();

  const m = normalizeMachine(machine);

  let expireAt;
  if (until) {
    const d = new Date(until + 'T23:59:59');
    if (Number.isNaN(d.getTime())) throw new Error('--until 格式应为 2027-09-30');
    expireAt = d.getTime();
  } else {
    const n = Number(days == null ? 365 : days);
    if (!Number.isFinite(n) || n <= 0) throw new Error('--days 要是正数');
    expireAt = now + n * 24 * 3600 * 1000;
  }

  const seq = (readLedger().length + 1).toString().padStart(4, '0');
  const card = `MCM-${new Date(now).getFullYear()}-${seq}`;

  const payload = { card, machine: m, edition, expireAt, issuedAt: now, buyer };
  const credential = sign(payload, priv);

  appendLedger({
    card, machine: m, edition,
    issuedAt: new Date(now).toISOString(),
    expireAt: new Date(expireAt).toISOString(),
    buyer, note,
  });

  return { credential, payload, expireText: until || `${days == null ? 365 : days} 天` };
}

function cmdNew() {
  let r;
  try {
    r = issue({
      machine: arg('machine'),
      days: arg('days'),
      until: arg('until'),
      edition: arg('edition', 'pro'),
      buyer: arg('buyer', ''),
      note: arg('note', ''),
    });
  } catch (e) {
    console.error('✗ ' + e.message);
    console.error('  用法：node tools/issue.js new --machine 7E84-2A70-F998-6EB7 --days 365');
    process.exitCode = 2;
    return;
  }

  const { credential, payload } = r;
  console.log('');
  console.log('  ┌─ 卡密已生成 ──────────────────────────────────────');
  console.log('  │ 卡号      ' + payload.card);
  console.log('  │ 机器码    ' + pretty(payload.machine));
  console.log('  │ 版本      ' + payload.edition);
  console.log('  │ 有效期    ' + r.expireText + '（到 ' + new Date(payload.expireAt).toISOString().slice(0, 10) + '）');
  if (payload.buyer) console.log('  │ 买家      ' + payload.buyer);
  console.log('  └───────────────────────────────────────────────────');
  console.log('');
  console.log('  下面这段发给用户，让他在软件里粘贴：');
  console.log('');
  console.log('  ' + '-'.repeat(60));
  console.log(credential);
  console.log('  ' + '-'.repeat(60));
  console.log('');
  console.log('  已记入 ' + path.relative(ROOT, LEDGER));
}

// ------------------------------------------------------------- verify
function cmdVerify() {
  const cred = argv[1] || '';
  if (!cred) { console.error('用法：node tools/issue.js verify <卡密>'); process.exit(2); }
  // 用客户端那套验签逻辑，确保发出去的卡一定能被 exe 认
  const L = require(path.join(ROOT, 'src', 'main', 'license.js'));
  const dot = cred.indexOf('.');
  if (dot <= 0) { console.error('✗ 卡密格式不对'); process.exit(1); }
  let payload;
  try { payload = JSON.parse(Buffer.from(cred.slice(0, dot), 'base64url').toString('utf8')); } catch {
    console.error('✗ 内容解不开'); process.exit(1);
  }
  const v = L.verifyCredential(cred, payload.machine);
  console.log('  签名      ' + (v.ok ? '✓ 有效' : '✗ ' + v.why));
  if (v.payload) {
    console.log('  卡号      ' + v.payload.card);
    console.log('  机器码    ' + pretty(v.payload.machine));
    console.log('  版本      ' + v.payload.edition);
    console.log('  到期      ' + new Date(v.payload.expireAt).toISOString().slice(0, 10));
  }
  process.exit(v.ok ? 0 : 1);
}

// --------------------------------------------------------------- list
function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('card,'));
  return lines.map((l) => l.split(','));
}

function appendLedger(row) {
  if (!fs.existsSync(LEDGER)) {
    fs.writeFileSync(LEDGER, 'card,machine,edition,issuedAt,expireAt,buyer,note\n', 'utf8');
  }
  const esc = (v) => (/[",]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  fs.appendFileSync(LEDGER, [row.card, row.machine, row.edition, row.issuedAt, row.expireAt, row.buyer, row.note].map(esc).join(',') + '\n', 'utf8');
}

function cmdList() {
  const rows = readLedger();
  if (!rows.length) { console.log('  还没发过卡。'); return; }
  console.log('  共 ' + rows.length + ' 张');
  console.log('');
  console.log('  卡号'.padEnd(16) + '机器码'.padEnd(20) + '到期'.padEnd(13) + '买家');
  console.log('  ' + '-'.repeat(58));
  for (const r of rows) {
    console.log('  ' + String(r[0]).padEnd(14) + String(r[1]).padEnd(20)
      + String(r[4] || '').slice(0, 10).padEnd(13) + String(r[5] || ''));
  }
}

// -------------------------------------------------------------- usage
function usage() {
  console.log(`
卡密签发工具

  node tools/issue.js new --machine <机器码> [选项]
      签发一张绑定指定机器的卡密

      --machine  16 位机器码（带不带横杠都行）
      --days     有效天数，默认 365
      --until    指定到期日（如 2027-09-30），优先于 --days
      --edition  版本标识，默认 pro
      --buyer    买家备注，便于对账
      --note     其他备注

  node tools/issue.js verify <卡密>
      校验一张卡密（用客户端同一套验签逻辑，确保 exe 一定认）

  node tools/issue.js list
      列出已签发的卡密

⚠️ 这个工具持有私钥，绝不能发给用户。
`);
}

// 只有直接 `node tools/issue.js` 跑时才执行 CLI。
// 被 require 时（比如测试）只导出函数，不产生副作用。
if (require.main === module) {
  switch (cmd) {
    case 'new': cmdNew(); break;
    case 'verify': cmdVerify(); break;
    case 'list': cmdList(); break;
    default: usage(); break;
  }
}

module.exports = { issue, sign, normalizeMachine, pretty, readLedger, LEDGER };
