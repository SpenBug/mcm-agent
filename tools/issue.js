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

/** 赛事与价目（与客户端同一份数据源，避免两边价格对不上） */
const comps = require(path.join(ROOT, 'src', 'main', 'competitions'));

/**
 * 归一化赛事 id：缺省 = all（全能包，解锁全部赛事）。
 * 传了不认识的直接抛错 —— 签错赛事的卡发出去就是客诉。
 */
function normalizeCompetition(s) {
  if (s == null || s === '') return 'all';
  const id = String(s).toLowerCase();
  const known = comps.COMPETITIONS.map((c) => c.id).concat('all');
  if (!known.includes(id)) {
    throw new Error(`--competition 应为：${known.join(' / ')}（收到 "${s}"）`);
  }
  return id;
}

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
function issue({ machine, days, until, edition = 'pro', competition, buyer = '', note = '', now = Date.now() }) {
  const priv = loadKey();

  const m = normalizeMachine(machine);
  const comp = normalizeCompetition(competition);

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

  const payload = { card, machine: m, edition, competition: comp, expireAt, issuedAt: now, buyer };
  const credential = sign(payload, priv);

  appendLedger({
    card, machine: m, edition, competition: comp,
    issuedAt: new Date(now).toISOString(),
    expireAt: new Date(expireAt).toISOString(),
    buyer, note,
  });

  return { credential, payload, price: comps.PRICES[comp], expireText: until || `${days == null ? 365 : days} 天` };
}

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
    console.log('  解锁赛事  ' + (v.payload.competition || 'all') + '（旧卡缺省按全能包）');
    console.log('  到期      ' + new Date(v.payload.expireAt).toISOString().slice(0, 10));
  }
  process.exit(v.ok ? 0 : 1);
}

// --------------------------------------------------------------- list
const LEDGER_HEADER = 'card,machine,edition,competition,issuedAt,expireAt,buyer,note';

/** 按 CSV 规则切一行（支持引号内逗号/换行转义） */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 确保台账是新表头（带 competition 列）。
 * 老台账（7 列）自动迁移：按旧表头名字重排，competition 留空 = all。
 * 只在缺列时重写一次，之后 append 走新列序。
 */
function ensureLedger() {
  if (!fs.existsSync(LEDGER)) {
    fs.writeFileSync(LEDGER, LEDGER_HEADER + '\n', 'utf8');
    return;
  }
  const text = fs.readFileSync(LEDGER, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) { fs.writeFileSync(LEDGER, LEDGER_HEADER + '\n', 'utf8'); return; }
  const header = lines[0].trim();
  if (header === LEDGER_HEADER) return;

  const oldCols = header.split(',').map((s) => s.trim());
  const want = LEDGER_HEADER.split(',');
  const body = lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const obj = {};
    oldCols.forEach((c, i) => { obj[c] = cells[i] ?? ''; });
    obj.competition = obj.competition || 'all';   // 老卡全是全能包
    return want.map((w) => obj[w] ?? '');
  });
  const esc = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  fs.writeFileSync(LEDGER, [LEDGER_HEADER, ...body.map((r) => r.map(esc).join(','))].join('\n') + '\n', 'utf8');
}

/** 读台账为对象数组（列名对齐，老新格式都能读） */
function readLedgerObjects() {
  ensureLedger();
  const lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('card,'));
  const cols = LEDGER_HEADER.split(',');
  return lines.map((l) => {
    const cells = splitCsvLine(l);
    const o = {};
    cols.forEach((c, i) => { o[c] = cells[i] ?? ''; });
    return o;
  });
}

function readLedger() {
  return readLedgerObjects();
}

function appendLedger(row) {
  ensureLedger();
  const esc = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  fs.appendFileSync(LEDGER, [row.card, row.machine, row.edition, row.competition, row.issuedAt, row.expireAt, row.buyer, row.note].map(esc).join(',') + '\n', 'utf8');
}

function cmdList() {
  const rows = readLedgerObjects();
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
//
// 邀请记账：**单独一个文件**，不混进卡密台账 ——
// 台账列是固定的（卡密/机器码/赛事…），塞进推荐记录会把格式搞乱，
// 而且推荐是"多次追加"的流水，和"一张卡一行"不是同一种东西。
//
// 邀请码 = 卡号后 6 位（与客户端 inviteCodeFromCard 同一套算法）。

const INVITE_LEDGER = process.env.MCM_INVITE_LEDGER || path.join(__dirname, 'invites.csv');
const INVITE_HEADER = 'inviterCode,buyer,competition,amount,at,note';

function ensureInviteLedger() {
  if (!fs.existsSync(INVITE_LEDGER)) {
    fs.writeFileSync(INVITE_LEDGER, INVITE_HEADER + '\n', 'utf8');
  }
}

function readInvites() {
  ensureInviteLedger();
  const lines = fs.readFileSync(INVITE_LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('inviterCode,'));
  const cols = INVITE_HEADER.split(',');
  return lines.map((l) => {
    const cells = splitCsvLine(l);
    const o = {};
    cols.forEach((c, i) => { o[c] = cells[i] ?? ''; });
    return o;
  });
}

/** 记录一次"某邀请码推荐成功" */
function recordInvite({ inviterCode, buyer = '', competition = '', amount = '', note = '', now = Date.now() }) {
  const code = String(inviterCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error(`邀请码应为 6 位数字（卡号后 6 位），收到 "${inviterCode}"`);
  }
  ensureInviteLedger();
  const esc = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  fs.appendFileSync(INVITE_LEDGER,
    [code, buyer, competition, amount, new Date(now).toISOString(), note].map(esc).join(',') + '\n', 'utf8');
  return { code, count: countInvites(code) };
}

/** 某邀请码累计推荐次数 */
function countInvites(code) {
  return readInvites().filter((r) => r.inviterCode === String(code)).length;
}

/** 统计每个邀请码的推荐数，按次数降序 */
function inviteStats() {
  const map = new Map();
  for (const r of readInvites()) {
    const cur = map.get(r.inviterCode) || { code: r.inviterCode, count: 0, buyers: [] };
    cur.count += 1;
    if (r.buyer) cur.buyers.push(r.buyer);
    map.set(r.inviterCode, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** 邀请码 → 卡号/买家（用来告诉你是谁推荐的） */
function whoIs(code) {
  const hit = readLedgerObjects().find((r) => comps.inviteCodeFromCard(r.card) === String(code));
  return hit || null;
}

function cmdInvite() {
  const code = argv[1] && !argv[1].startsWith('--') ? argv[1] : arg('code');
  if (!code) {
    console.error('✗ 用法：node tools/issue.js invite <6位邀请码> [--buyer 张三] [--competition cumcm] [--amount 64] [--note 备注]');
    process.exitCode = 2;
    return;
  }
  try {
    const r = recordInvite({
      inviterCode: code,
      buyer: arg('buyer', ''),
      competition: arg('competition', ''),
      amount: arg('amount', ''),
      note: arg('note', ''),
    });
    const owner = whoIs(r.code);
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
  const stats = inviteStats();
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
    const owner = whoIs(s.code);
    const done = Math.floor(s.count / RULES.threshold);
    const status = s.count >= RULES.threshold ? `🎁 可送 ${done} 次` : `差 ${RULES.threshold - s.count} 人`;
    if (s.count >= RULES.threshold) due += done;
    console.log('  ' + s.code.padEnd(10) + String(s.count).padEnd(9) + status.padEnd(12)
      + (owner ? owner.card + (owner.buyer ? '（' + owner.buyer + '）' : '') : '⚠️ 台账无此码'));
  }
  console.log('');
  if (due) console.log(`  ⚠️ 有 ${due} 次奖励待发放（满 ${RULES.threshold} 人送${RULES.reward}）`);
}

/**
 * 把 CSV 里的赛事字段解析成赛事 id。
 *
 * 先按 id（keygen 导出的就是 id），再按中文名 / 全名兜 —— 手工改过或
 * 从别处粘的台账常写「华数杯」而不是 huashu。
 *
 * ⚠️ 认不出来时**保留原值并大声警告**，不要悄悄写成 all：
 * 台账是你收钱的凭据，把一张 ¥39 的单赛卡记成全能包，
 * 下次对账就查不回来了 —— 宁可留个明显的脏值让你当场处理。
 */
function resolveCompetition(raw) {
  const v = String(raw || '').trim();
  if (!v) return { id: 'all', ok: true };
  try {
    return { id: normalizeCompetition(v), ok: true };
  } catch { /* 继续按名字找 */ }
  const low = v.toLowerCase();
  const byName = comps.COMPETITIONS.find(
    (c) => c.name === v || c.fullName === v || c.name.toLowerCase() === low || c.fullName.toLowerCase() === low,
  );
  if (byName) return { id: byName.id, ok: true };
  return { id: v, ok: false };
}

/**
 * 导入网页签发器（keygen.html）导出的 CSV 到 issued.csv。
 *
 * 为什么需要：keygen.html 的台账存在**浏览器 localStorage** 里，
 * 它签的卡不会自动进 issued.csv。而 invite / invites 查邀请码只认 issued.csv
 * —— 于是用网页发出去的卡，买家推荐满 3 人来领奖时你查不到是谁。
 * 更要紧的是卡号：网页原先看不到 issued.csv，会重复排号（已修成读台账推号）。
 *
 * 表头两种都认：网页导出的是中文（卡号/机器码/赛事…），
 * 命令行台账是英文（card/machine/competition…），便于两边来回导。
 */
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

  // keygen 导出时带 UTF-8 BOM，不去掉第一列表头会变成 "\uFEFFcard" 而匹配不上。
  // 用 \uFEFF 转义而不是直接写那个字符：肉眼看不见的东西不该出现在源码里。
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    console.error('✗ CSV 里没有数据行（只有表头或空文件）');
    process.exitCode = 1;
    return;
  }

  const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const at = (names) => head.findIndex((h) => names.includes(h));
  const COLS = {
    card: at(['card', '卡号']),
    machine: at(['machine', '机器码']),
    edition: at(['edition', '版本']),
    competition: at(['competition', '赛事']),
    issuedAt: at(['issuedat', '签发时间']),
    expireAt: at(['expireat', '到期时间']),
    buyer: at(['buyer', '买家']),
    note: at(['note', '备注']),
  };
  if (COLS.card < 0) {
    console.error(`✗ CSV 里没有「卡号 / card」列，表头是：${head.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const existing = new Map(readLedgerObjects().map((r) => [r.card, r]));
  const rows = [];
  const skipped = [];
  const unknown = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const get = (i) => (i >= 0 ? String(cells[i] ?? '').trim() : '');
    const card = get(COLS.card);
    if (!card) continue;
    if (existing.has(card)) { skipped.push(card); continue; }   // 不覆盖已有记录
    const comp = resolveCompetition(get(COLS.competition));
    if (!comp.ok) unknown.push(`${card}: "${get(COLS.competition)}"`);
    rows.push({
      card,
      machine: normalizeMachine(get(COLS.machine)),
      edition: get(COLS.edition) || 'pro',
      competition: comp.id,
      issuedAt: get(COLS.issuedAt),
      expireAt: get(COLS.expireAt),
      buyer: get(COLS.buyer),
      note: get(COLS.note),
    });
  }

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
  for (const r of rows) appendLedger(r);
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

  node tools/issue.js verify <卡密>
      校验一张卡密（用客户端同一套验签逻辑，确保 exe 一定认）

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

module.exports = {
  issue, sign, normalizeMachine, pretty, readLedger, LEDGER,
  recordInvite, countInvites, inviteStats, whoIs,
  INVITE_LEDGER,
};
