#!/usr/bin/env node
'use strict';

/**
 * 卡密签发工具（命令行）—— 只给你（卖家）用，**绝不能发给用户**。
 *
 * 工作方式：
 *   用户把机器码发给你 → 你跑这个工具 → 得到一段卡密 → 发回给用户
 *   用户在 exe 里粘贴 → 客户端用内嵌的公钥验签 → 解锁
 *
 * ⚠️ 这个工具持有**私钥**。它一旦泄露，任何人都能自己发卡。
 *    所以：不放进 exe 打包（package.json 的 files 只含 src/**，天然排除），
 *    keys/ 已在 .gitignore 里。
 *
 * 本文件只负责**解析命令行与打印**。所有数据与算法在 tools/issuer-core.js，
 * 由命令行 / 旧 HTTP 版 / 独立桌面应用共用一份 —— 入口多了就必然漂移，
 * 这个仓库已经因此栽过三次（见 scripts/issuer-consistency-test.js）。
 *
 * 用法：
 *   node tools/issue.js new --machine 7E84-2A70-F998-6EB7 --days 365
 *   node tools/issue.js new --machine 7E84... --until 2027-09-30 --buyer 张三 --note 微信收款
 *   node tools/issue.js verify <卡密>
 *   node tools/issue.js list
 *   node tools/issue.js invite 260005 --buyer 张三
 *   node tools/issue.js invites
 *   node tools/issue.js import <keygen导出的.csv>
 */

const fs = require('node:fs');
const path = require('node:path');

const { createIssuer } = require('./issuer-core');

const ROOT = path.join(__dirname, '..');
const PRIV_PATH = path.join(ROOT, 'keys', 'license-private.pem');
/**
 * 台账路径可用环境变量覆盖 —— 测试要用临时文件，不能污染真台账。
 * ⚠️ 这是**模块加载时**定下的（与历史行为一致）：测试必须在 require 之前设好
 * MCM_LEDGER，否则会写到真实台账上。scripts/issuer-consistency-test.js 依赖这一点。
 */
const LEDGER = process.env.MCM_LEDGER || path.join(__dirname, 'issued.csv');
const INVITE_LEDGER = process.env.MCM_INVITE_LEDGER || path.join(__dirname, 'invites.csv');

const core = createIssuer({
  dataDir: __dirname,
  privPath: PRIV_PATH,
  ledgerPath: LEDGER,
  invitePath: INVITE_LEDGER,
});

const argv = process.argv.slice(2);
const cmd = argv[0];

function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
function flag(name) { return argv.includes('--' + name); }

const { issue, pretty, readLedger, nextSeq, normalizeMachine } = core;
const comps = core.comps;

// ---------------------------------------------------------------- new
function cmdNew() {
  let r;
  try {
    r = issue({
      machine: arg('machine'),
      days: arg('days'),
      until: arg('until'),
      edition: arg('edition', 'pro'),
      competition: arg('competition'),
      buyer: arg('buyer', ''),
      note: arg('note', ''),
    });
  } catch (e) {
    console.error('✗ ' + e.message);
    if (e.code === 'ENOKEY') console.error('  先跑一次密钥生成（或从备份恢复 keys/license-private.pem）。');
    console.error('  用法：node tools/issue.js new --machine 7E84-2A70-F998-6EB7 --competition cumcm --days 365');
    process.exitCode = 2;
    return;
  }

  const { credential, payload } = r;
  const compName = payload.competition === 'all' ? '全能包（全部赛事）'
    : comps.get(payload.competition).fullName;
  console.log('');
  console.log('  ┌─ 卡密已生成 ──────────────────────────────────────');
  console.log('  │ 卡号      ' + payload.card);
  console.log('  │ 机器码    ' + pretty(payload.machine));
  console.log('  │ 版本      ' + payload.edition);
  console.log('  │ 解锁赛事  ' + compName + '（售价 ¥' + r.price + '）');
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
  if (!cred) { console.error('用法：node tools/issue.js verify <卡密> [--machine 机器码]'); process.exit(2); }
  const machine = arg('machine');
  const v = core.verify(cred, machine);
  console.log('  签名      ' + (v.ok ? '✓ 有效' : '✗ ' + v.why));
  if (v.payload) {
    console.log('  卡号      ' + v.payload.card);
    if (v.payload.machine) console.log('  机器码    ' + pretty(v.payload.machine));
    console.log('  版本      ' + v.payload.edition);
    console.log('  解锁赛事  ' + (v.payload.competition || 'all') + '（旧卡缺省按全能包）');
    if (v.payload.expireAt) console.log('  到期      ' + new Date(v.payload.expireAt).toISOString().slice(0, 10));
  }
  process.exit(v.ok ? 0 : 1);
}

// --------------------------------------------------------------- list
function cmdList() {
  const rows = readLedger();
  if (!rows.length) { console.log('  还没发过卡。'); return; }
  console.log('  共 ' + rows.length + ' 张');
  console.log('');
  console.log('  卡号'.padEnd(16) + '邀请码'.padEnd(10) + '赛事'.padEnd(12) + '到期'.padEnd(13) + '买家');
  console.log('  ' + '-'.repeat(68));
  for (const r of rows) {
    const inv = comps.inviteCodeFromCard(r.card) || '-';
    console.log('  ' + String(r.card).padEnd(14) + String(inv).padEnd(10)
      + String(r.competition || 'all').padEnd(12)
      + String(r.expireAt || '').slice(0, 10).padEnd(13) + String(r.buyer || ''));
  }
}

// ------------------------------------------------------------- invite
function cmdInvite() {
  const code = argv[1] && !argv[1].startsWith('--') ? argv[1] : arg('code');
  if (!code) {
    console.error('✗ 用法：node tools/issue.js invite <6位邀请码> [--buyer 张三] [--competition cumcm] [--amount 64] [--note 备注]');
    process.exitCode = 2;
    return;
  }
  try {
    const r = core.recordInvite({
      inviterCode: code,
      buyer: arg('buyer', ''),
      competition: arg('competition', ''),
      amount: arg('amount', ''),
      note: arg('note', ''),
    });
    const owner = core.whoIs(r.code);
    const RULES = comps.INVITE_RULES;
    console.log('');
    console.log('  ✓ 已记录推荐：邀请码 ' + r.code);
    if (owner) console.log('    推荐人卡号 ' + owner.card + (owner.buyer ? '（' + owner.buyer + '）' : ''));
    if (!owner) console.log('    ⚠️ 台账里没找到持有该邀请码的卡 —— 确认一下码有没有抄错');
    console.log('    该邀请码累计 ' + r.count + ' 人');
    if (r.count >= RULES.threshold) {
      console.log('');
      console.log('  🎁 已满 ' + RULES.threshold + ' 人 —— 该送' + RULES.reward + '了！');
      console.log('     记得给推荐人发一张免费卡（node tools/issue.js new ...）');
    } else {
      console.log('    还差 ' + (RULES.threshold - r.count) + ' 人可送' + RULES.reward);
    }
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exitCode = 2;
  }
}

function cmdInvites() {
  const stats = core.inviteStats();
  const RULES = comps.INVITE_RULES;
  console.log('');
  if (!stats.length) {
    console.log('  还没有推荐记录。');
    console.log('  用户购买后报出邀请码时，用 `node tools/issue.js invite <码> --buyer 张三` 记一笔。');
    return;
  }
  console.log('  邀请码    推荐数   状态        推荐人');
  console.log('  ' + '-'.repeat(60));
  let due = 0;
  for (const s of stats) {
    const owner = core.whoIs(s.code);
    const done = Math.floor(s.count / RULES.threshold);
    const status = s.count >= RULES.threshold ? `🎁 可送 ${done} 次` : `差 ${RULES.threshold - s.count} 人`;
    if (s.count >= RULES.threshold) due += done;
    console.log('  ' + s.code.padEnd(10) + String(s.count).padEnd(9) + status.padEnd(12)
      + (owner ? owner.card + (owner.buyer ? '（' + owner.buyer + '）' : '') : '⚠️ 台账无此码'));
  }
  console.log('');
  if (due) console.log(`  ⚠️ 有 ${due} 次奖励待发放（满 ${RULES.threshold} 人送${RULES.reward}）`);
}

// ------------------------------------------------------------- import
function cmdImport() {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : arg('file');
  if (!file) {
    console.error('✗ 用法：node tools/issue.js import <keygen导出的.csv> [--dry]');
    process.exitCode = 2;
    return;
  }
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到文件：${p}`);
    process.exitCode = 1;
    return;
  }

  const existing = new Set(readLedger().map((r) => r.card));
  const { error, rows, skipped, unknown } = core.parseImportCsv(fs.readFileSync(p, 'utf8'), {
    existingCards: existing,
  });
  if (error) { console.error('✗ ' + error); process.exitCode = 1; return; }

  console.log(`\n导入 ${path.basename(p)}：新增 ${rows.length} 张，跳过重复 ${skipped.length} 张`);
  if (unknown.length) {
    console.log(`\n  ⚠️ ${unknown.length} 张卡的赛事名对不上任何已知赛事，已按原样记入台账：`);
    for (const u of unknown.slice(0, 10)) console.log('     ' + u);
    console.log('     没有偷偷改成 all —— 台账是收钱的凭据，记错了查不回来。');
    console.log('     请核对后手工改正（可先 --dry 看清单，再 `npm run issue -- list` 复查）。');
  }
  if (flag('dry')) {
    console.log('  （--dry 只预演，不写入）\n');
    return;
  }
  core.importRows(rows);
  if (rows.length) console.log(`  ✓ 已写入 ${LEDGER}`);
  if (skipped.length) console.log(`  · 已存在未覆盖：${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''}`);

  // 邀请码是这套台账最常被回查的字段，导完直接列出来省一次 list
  if (rows.length) {
    console.log('\n  卡号'.padEnd(18) + '邀请码'.padEnd(10) + '赛事');
    console.log('  ' + '-'.repeat(46));
    for (const r of rows) {
      console.log('  ' + r.card.padEnd(16) + comps.inviteCodeFromCard(r.card).padEnd(8) + r.competition);
    }
  }
  console.log('');
}

// -------------------------------------------------------------- usage
function usage() {
  console.log(`
卡密签发工具

  node tools/issue.js new --machine <机器码> [选项]
      签发一张绑定指定机器的卡密

      --machine      16 位机器码（带不带横杠都行）
      --competition  解锁赛事：all / cumcm / huawei / mcm / shuwei / apmcm /
                     bigdata / huashu / huashu_intl / mathorcup / others
                     不填 = all（全能包）
      --days         有效天数，默认 365
      --until        指定到期日（如 2027-09-30），优先于 --days
      --edition      版本标识，默认 pro
      --buyer        买家备注，便于对账
      --note         其他备注

  node tools/issue.js verify <卡密> [--machine <机器码>]
      校验一张卡密（用客户端同一套验签逻辑，确保 exe 一定认）
      带上 --machine 还能验"一机一码"是否对得上

  node tools/issue.js list
      列出已签发的卡密（含每张卡对应的邀请码）

  node tools/issue.js invite <6位邀请码> [--buyer 张三] [--competition cumcm] [--amount 64]
      记录一次成功推荐（邀请码 = 卡号后 6 位，见 list）
      满 ${comps.INVITE_RULES.threshold} 人会自动提醒你发奖励

  node tools/issue.js invites
      查看推荐统计与待发奖励

  node tools/issue.js import <csv> [--dry]
      把网页签发器（keygen.html）导出的台账并进 issued.csv
      ⚠️ 网页签的卡默认只存在浏览器里，不导进来，
      invite/invites 就查不到那些买家 —— 领奖时会认不出人。

  💡 图形界面：双击 tools/签发卡密.bat（本地服务版）
                或 tools/issuer-app/ 里的独立应用

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
    case 'invite': cmdInvite(); break;
    case 'invites': cmdInvites(); break;
    case 'import': cmdImport(); break;
    default: usage(); break;
  }
}

/**
 * 导出面**保持与重构前一致** —— 已有测试（issuer-consistency-test /
 * keygen-ledger-test / license-e2e / competitions-test）都 require 这些名字。
 */
module.exports = {
  issue, sign: core.sign, normalizeMachine, pretty, readLedger, LEDGER, nextSeq,
  recordInvite: core.recordInvite, countInvites: core.countInvites,
  inviteStats: core.inviteStats, whoIs: core.whoIs,
  INVITE_LEDGER,
  // 新增（应用版与后续脚本可用）
  core,
};
