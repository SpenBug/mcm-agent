/*
 * ⚠️ 自动生成，请勿手改 —— 由 scripts/sync-issuer-app.js 从 issuer-core.js 同步。
 * 改这里会在下次同步时被覆盖，且 npm test 的「签发器应用同源」守卫会报漂移。
 */
'use strict';

/**
 * 签发核心：**所有签发入口的唯一真源**。
 *
 * 为什么要有这一层：签发器现在有四个入口 ——
 *   1. tools/issue.js          命令行
 *   2. tools/issuer.js         本地 HTTP 服务（旧 GUI）
 *   3. tools/keygen.html       纯网页（自带一份公钥与逻辑）
 *   4. tools/issuer-app/       独立桌面应用
 * 入口越多，越容易"各抄一份"然后悄悄漂移。本仓库已经因此栽过三次
 * （单赛卡签成全能包、台账列错位、keygen 少 3 个赛事还是旧价），
 * 见 scripts/issuer-consistency-test.js 的注释。
 *
 * 所以把**数据与算法**全部收在这里，各入口只负责"取输入 / 展示输出"：
 *   · 赛事与价格   → 直接 require src/main/competitions（客户端同一份）
 *   · 卡号排号     → nextSeq()，max+1（有空洞也不撞号）
 *   · 台账读写     → 表头按列名映射，加列不会错位
 *   · 邀请记账     → 单独一个文件，不混进卡密台账
 *   · 验签         → 用客户端那套 license.js，保证发出去的卡 exe 一定认
 *
 * 工厂式（createIssuer）而不是模块级常量：命令行版读仓库目录，
 * 独立应用版读 %APPDATA%\阿一古数模签发器\，两边共用同一份实现。
 * 数据目录由调用方注入，**核心自己不认识任何绝对路径** —— 这样它才能被
 * 打包进 asar、也能在测试里指向临时目录。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LEDGER_HEADER = 'card,machine,edition,competition,issuedAt,expireAt,buyer,note';
const INVITE_HEADER = 'inviterCode,buyer,competition,amount,at,note';

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

/** CSV 单元格转义 */
const escCell = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));

/**
 * @param {object} o
 * @param {string} o.dataDir   台账与私钥所在目录（命令行版 = tools/，应用版 = %APPDATA%\…）
 * @param {string} o.privPath  私钥 PEM 路径
 * @param {object} o.comps     赛事数据源（默认取 src/main/competitions）
 * @param {object} [o.license] 客户端验签模块（懒加载，避免核心依赖 Electron）
 * @param {string} [o.ledgerPath]  覆盖台账路径（测试用）
 * @param {string} [o.invitePath]  覆盖邀请台账路径（测试用）
 */
function createIssuer({ dataDir, privPath, comps, license, ledgerPath, invitePath }) {
  if (!dataDir) throw new Error('createIssuer 需要 dataDir');
  const PRIV = privPath || path.join(dataDir, 'license-private.pem');
  const LEDGER = ledgerPath || process.env.MCM_LEDGER || path.join(dataDir, 'issued.csv');
  const INVITES = invitePath || process.env.MCM_INVITE_LEDGER || path.join(dataDir, 'invites.csv');
  const C = comps || require('./competitions');

  // ---------------------------------------------------------------- 基础
  function normalizeCompetition(s) {
    if (s == null || s === '') return 'all';
    const id = String(s).toLowerCase();
    const known = C.COMPETITIONS.map((c) => c.id).concat('all');
    if (!known.includes(id)) {
      throw new Error(`--competition 应为：${known.join(' / ')}（收到 "${s}"）`);
    }
    return id;
  }

  function normalizeMachine(s) {
    const t = String(s || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    if (t.length !== 16) {
      throw new Error(`机器码应该是 16 位十六进制，收到 "${s}"（归一化后 ${t.length} 位）`);
    }
    return t;
  }

  function pretty(machine) { return String(machine).match(/.{1,4}/g).join('-'); }

  function loadKey() {
    if (!fs.existsSync(PRIV)) {
      const e = new Error(`找不到私钥：${PRIV}`);
      e.code = 'ENOKEY';
      throw e;
    }
    return fs.readFileSync(PRIV, 'utf8');
  }

  const hasKey = () => fs.existsSync(PRIV);

  function sign(payload, priv) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign(null, Buffer.from(body), priv).toString('base64url');
    return body + '.' + sig;
  }

  // ---------------------------------------------------------------- 台账
  /**
   * 确保台账是新表头（带 competition 列）。
   * 老台账（7 列）自动迁移：按旧表头名字重排，competition 留空 = all。
   */
  function ensureLedger() {
    if (!fs.existsSync(LEDGER)) {
      fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
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
      obj.competition = obj.competition || 'all';
      return want.map((w) => obj[w] ?? '');
    });
    fs.writeFileSync(LEDGER, [LEDGER_HEADER, ...body.map((r) => r.map(escCell).join(','))].join('\n') + '\n', 'utf8');
  }

  function readLedgerObjects() {
    ensureLedger();
    const lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('card,'));
    const cols = LEDGER_HEADER.split(',');
    return lines.map((l) => {
      const cells = splitCsvLine(l);
      const o = {};
      cols.forEach((c, i) => { o[c] = cells[i] ?? ''; });
      return o;
    });
  }

  function appendLedger(row) {
    ensureLedger();
    fs.appendFileSync(LEDGER,
      [row.card, row.machine, row.edition, row.competition, row.issuedAt, row.expireAt, row.buyer, row.note]
        .map(escCell).join(',') + '\n', 'utf8');
  }

  /**
   * 下一个卡号序号 = **当年已发的最大序号 + 1**，不是「台账行数 + 1」。
   *
   * ⚠️ 曾经写的是 `readLedger().length + 1`，只要台账有空洞就撞号：
   *   空洞很常见 —— keygen.html 在浏览器里删一条记录，导出 CSV 再 import
   *   进来（卖家手册要求的动作），台账就缺号了。实测复现：导入 0001、0003
   *   （缺 0002）后 count+1 算出 0003，与已付款客户同卡号。
   * 撞号不只是难看：邀请码 = 卡号后 6 位，两个买家会共用一个邀请码，
   * 而 whoIs() 用 find() 只返回第一条 —— 第二个人的推荐奖励永远记不到。
   */
  function nextSeq(year, rows = readLedgerObjects()) {
    let max = 0;
    for (const r of rows) {
      const m = /^MCM-(\d{4})-(\d{4})$/.exec(String(r.card || ''));
      if (!m || Number(m[1]) !== year) continue;
      max = Math.max(max, Number(m[2]));
    }
    return max + 1;
  }

  // ---------------------------------------------------------------- 签发
  /**
   * 签发一张卡密。**不打印任何东西** —— 输出由各入口自己决定
   * （命令行打印卡密、GUI 渲染成页面）。
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

    const year = new Date(now).getFullYear();
    const seq = nextSeq(year).toString().padStart(4, '0');
    const card = `MCM-${year}-${seq}`;

    const payload = { card, machine: m, edition, competition: comp, expireAt, issuedAt: now, buyer };
    const credential = sign(payload, priv);

    appendLedger({
      card, machine: m, edition, competition: comp,
      issuedAt: new Date(now).toISOString(),
      expireAt: new Date(expireAt).toISOString(),
      buyer, note,
    });

    return {
      credential,
      payload,
      price: C.PRICES[comp],
      inviteCode: C.inviteCodeFromCard(card),
      expireText: until || `${days == null ? 365 : days} 天`,
    };
  }

  /**
   * 验一张卡密。用**客户端那套验签逻辑**，确保发出去的卡 exe 一定认。
   * license.js 只在需要时加载（它 require electron 相关模块，纯 Node 下要能跑）。
   */
  function verify(credential, machine) {
    const L = license || require('./license');
    const cred = String(credential || '').trim();
    const dot = cred.indexOf('.');
    if (dot <= 0) return { ok: false, why: '卡密格式不对（没有 . 分隔符）' };
    let payload;
    try {
      payload = JSON.parse(Buffer.from(cred.slice(0, dot), 'base64url').toString('utf8'));
    } catch {
      return { ok: false, why: '卡密内容解不开（不是合法 base64url JSON）' };
    }
    // 传机器码才能验一机一码；不传就只验签名与有效期
    const v = L.verifyCredential(cred, machine ? normalizeMachine(machine) : undefined);
    return { ...v, payload: v.payload || payload };
  }

  // ---------------------------------------------------------------- 邀请
  function ensureInviteLedger() {
    if (!fs.existsSync(INVITES)) {
      fs.mkdirSync(path.dirname(INVITES), { recursive: true });
      fs.writeFileSync(INVITES, INVITE_HEADER + '\n', 'utf8');
    }
  }

  function readInvites() {
    ensureInviteLedger();
    const lines = fs.readFileSync(INVITES, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('inviterCode,'));
    const cols = INVITE_HEADER.split(',');
    return lines.map((l) => {
      const cells = splitCsvLine(l);
      const o = {};
      cols.forEach((c, i) => { o[c] = cells[i] ?? ''; });
      return o;
    });
  }

  function recordInvite({ inviterCode, buyer = '', competition = '', amount = '', note = '', now = Date.now() }) {
    const code = String(inviterCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      throw new Error(`邀请码应为 6 位数字（卡号后 6 位），收到 "${inviterCode}"`);
    }
    ensureInviteLedger();
    fs.appendFileSync(INVITES,
      [code, buyer, competition, amount, new Date(now).toISOString(), note].map(escCell).join(',') + '\n', 'utf8');
    return { code, count: countInvites(code) };
  }

  function countInvites(code) {
    return readInvites().filter((r) => r.inviterCode === String(code)).length;
  }

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
    return readLedgerObjects().find((r) => C.inviteCodeFromCard(r.card) === String(code)) || null;
  }

  // ---------------------------------------------------------------- 导入
  /**
   * 把 CSV 里的赛事字段解析成赛事 id。
   * 先按 id，再按中文名/全名兜（手工改过或从别处粘的台账常写「华数杯」）。
   *
   * ⚠️ 认不出来时**保留原值并大声警告**，不要悄悄写成 all：
   * 台账是收钱的凭据，把一张 ¥39 的单赛卡记成全能包，下次对账查不回来。
   */
  function resolveCompetition(raw) {
    const v = String(raw || '').trim();
    if (!v) return { id: 'all', ok: true };
    try {
      return { id: normalizeCompetition(v), ok: true };
    } catch { /* 继续按名字找 */ }
    const low = v.toLowerCase();
    const byName = C.COMPETITIONS.find(
      (c) => c.name === v || c.fullName === v || c.name.toLowerCase() === low || c.fullName.toLowerCase() === low,
    );
    if (byName) return { id: byName.id, ok: true };
    return { id: v, ok: false };
  }

  /**
   * 解析 keygen.html 导出的 CSV 为待导入行。
   * 表头两种都认：网页导出的是中文（卡号/机器码/赛事…），命令行台账是英文。
   * 返回 { rows, skipped, unknown, error }，**不写盘**（调用方决定是否落盘）。
   */
  function parseImportCsv(text, { existingCards } = {}) {
    const clean = String(text || '').replace(/^\uFEFF/, '');   // keygen 导出带 BOM
    const lines = clean.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { error: 'CSV 里没有数据行（只有表头或空文件）', rows: [], skipped: [], unknown: [] };

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
      return { error: `CSV 里没有「卡号 / card」列，表头是：${head.join(', ')}`, rows: [], skipped: [], unknown: [] };
    }

    const known = existingCards instanceof Set ? existingCards : new Set(existingCards || []);
    const rows = [];
    const skipped = [];
    const unknown = [];
    for (const line of lines.slice(1)) {
      const cells = splitCsvLine(line);
      const get = (i) => (i >= 0 ? String(cells[i] ?? '').trim() : '');
      const card = get(COLS.card);
      if (!card) continue;
      if (known.has(card)) { skipped.push(card); continue; }
      const comp = resolveCompetition(get(COLS.competition));
      if (!comp.ok) unknown.push(`${card}: "${get(COLS.competition)}"`);
      let machine = '';
      try { machine = normalizeMachine(get(COLS.machine)); } catch { machine = get(COLS.machine); }
      rows.push({
        card,
        machine,
        edition: get(COLS.edition) || 'pro',
        competition: comp.id,
        issuedAt: get(COLS.issuedAt),
        expireAt: get(COLS.expireAt),
        buyer: get(COLS.buyer),
        note: get(COLS.note),
      });
    }
    return { rows, skipped, unknown };
  }

  /** 把解析结果写进台账（不覆盖已有卡号） */
  function importRows(rows) {
    for (const r of rows) appendLedger(r);
    return rows.length;
  }

  // ---------------------------------------------------------------- 导出
  /** 台账 → CSV 文本（英文表头，与 issue.js import 的格式往返兼容） */
  function ledgerToCsv() {
    const rows = readLedgerObjects();
    const body = rows.map((r) => LEDGER_HEADER.split(',').map((c) => escCell(r[c] ?? '')).join(','));
    return [LEDGER_HEADER, ...body].join('\n') + '\n';
  }

  /** 台账 → 中文表头 CSV（给 Excel 看；与 keygen 导出格式一致，可往回导） */
  function ledgerToCsvZh() {
    const ZH = ['卡号', '机器码', '版本', '赛事', '签发时间', '到期时间', '买家', '备注'];
    const rows = readLedgerObjects();
    const body = rows.map((r) => [
      r.card, pretty(r.machine || ''), r.edition, r.competition,
      r.issuedAt, r.expireAt, r.buyer, r.note,
    ].map(escCell).join(','));
    return [ZH.join(','), ...body].join('\n') + '\n';
  }

  return {
    // 路径
    dataDir, ledgerPath: LEDGER, invitePath: INVITES, privPath: PRIV,
    // 基础
    normalizeCompetition, normalizeMachine, pretty, sign, loadKey, hasKey,
    // 台账
    ensureLedger, readLedger: readLedgerObjects, nextSeq, ledgerToCsv, ledgerToCsvZh,
    // 签发与验卡
    issue, verify,
    // 邀请
    readInvites, recordInvite, countInvites, inviteStats, whoIs,
    // 导入
    parseImportCsv, importRows, resolveCompetition,
    // 常量
    LEDGER_HEADER, INVITE_HEADER, comps: C,
  };
}

module.exports = { createIssuer, splitCsvLine, escCell, LEDGER_HEADER, INVITE_HEADER };
