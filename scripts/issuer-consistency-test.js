#!/usr/bin/env node
'use strict';

/**
 * 签发器一致性测试：确认「你收钱的界面」和「客户端放行的判断」是同一套事实。
 *
 * 为什么单独一套：签发器有三个入口（issue.js 命令行 / issuer.js 本地服务 /
 * keygen.html 双击网页），它们各自抄了一份赛事与价格，甚至抄了一份公钥。
 * 这类漂移**不会报错**，只在收钱那一刻暴露 —— 实测抓到三处：
 *   1. issuer.js 的 /api/issue 不透传 competition → 卖 ¥39 的单赛卡
 *      会签成全能包（默认 all），买家白拿 ¥168 的权限
 *   2. issuer.js 的台账接口按字符串下标取列 → 加 competition 列后整体错位，
 *      GUI「已签发」表格全渲染成空行，你看不见发过哪些卡
 *   3. keygen.html 缺上一轮新增的 3 个赛事、亚太赛还是旧价 ¥49
 *      → 买家买大数据赛卡时你根本选不出来
 *
 * 这套测试把三条都钉住，再加公钥一致性（换了密钥对而签发器还认旧公钥，
 * 签出来的卡客户端一律不认，属于最严重的静默故障）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const comps = require('../src/main/competitions');

/**
 * ⚠️ 把台账指到真实 issued.csv 的**临时副本**再 require issue.js。
 *
 * 这套测试要跑一次真实签发（section ⑤），而 issue() 会往台账追加一行 ——
 * 直接跑就会在你的销售记录里留一条假卡，对账时多出一笔说不清的账。
 * 用副本的好处：既读得到真实数据（能验证列映射与邀请码派生），
 * 又保证任何写入都落在临时目录里。
 * LEDGER 是在 issue.js 模块加载时按 env 定下的，所以必须在 require 之前设好。
 */
const REAL_LEDGER = path.join(ROOT, 'tools', 'issued.csv');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ayigu-issuer-'));
process.env.MCM_LEDGER = path.join(TMP, 'issued.csv');
process.env.MCM_INVITE_LEDGER = path.join(TMP, 'invites.csv');
if (fs.existsSync(REAL_LEDGER)) fs.copyFileSync(REAL_LEDGER, process.env.MCM_LEDGER);
const hadRealLedger = fs.existsSync(REAL_LEDGER);

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')); }
}
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 退出清理失败不必再报错 */ } });


const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const norm = (s) => (s || '').replace(/\r/g, '').trim();
const PEM = /-----BEGIN [A-Z ]*-----[\s\S]*?-----END [A-Z ]*-----/;

const issuerJs = read('tools/issuer.js');
const issueJs = read('tools/issue.js');
// 签发算法与数据已收进 issuer-core.js（四个入口共用一份，见该文件顶部注释）。
// 断言"默认 all"这类**行为**时要认准它的真实所在，否则测试会因为
// "代码搬了个家"而变红 —— 那是假警报，会训练人忽略红灯。
const coreJs = read('tools/issuer-core.js');
const keygenHtml = read('tools/keygen.html');
const licenseJs = read('src/main/license.js');

// ---------------------------------------------------------------- ① 公钥
console.log('=== ① 密钥一致（换了钥而签发器没跟上 = 签出的卡全废）===');
const clientPub = (licenseJs.match(PEM) || [''])[0];
const privPem = fs.existsSync(path.join(ROOT, 'keys/license-private.pem'))
  ? read('keys/license-private.pem')
  : null;

/**
 * keygen.html 把公钥写成 JS 字符串字面量（'-----BEGIN...\n-----END...'），
 * 所以要先按 JS 语义解转义再比 —— 直接拿正则抓原文会把字面 \n 当成内容，
 * 于是两把一模一样的钥被判成不同（我第一版就误报在这里）。
 */
function keygenPublicKey(html) {
  const m = html.match(/const PUB_PEM = ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
  if (!m) return '';
  const lit = m[1].slice(1, -1);
  try {
    return JSON.parse('"' + lit.replace(/"/g, '\\"') + '"');
  } catch {
    return lit.replace(/\\n/g, '\n');
  }
}

const keygenPub = keygenPublicKey(keygenHtml);

check('客户端内嵌了公钥', clientPub.length > 0);
check('keygen.html 内嵌了公钥', keygenPub.length > 0);

if (privPem && clientPub) {
  const derived = norm(crypto.createPublicKey(privPem).export({ type: 'spki', format: 'pem' }));
  check('私钥推导出的公钥 == 客户端内嵌公钥', derived === norm(clientPub));
  if (keygenPub) {
    check('keygen 内嵌公钥 == 客户端内嵌公钥', norm(keygenPub) === norm(clientPub),
      '两边不是同一把钥，签出的卡客户端不认');
  }
} else {
  console.log('  · 私钥不在本机（正常：只该在卖家机上），跳过推导校验');
}

// ---------------------------------------------------------------- ② 赛事
console.log('\n=== ② 赛事与定价（三个入口必须同源）===');
const ids = comps.COMPETITIONS.map((c) => c.id);

/** 从 HTML/JS 里抓 value="xxx" 形式的赛事选项 */
function optionIds(text, marker) {
  const seg = marker ? text.slice(text.indexOf(marker), text.indexOf(marker) + 4000) : text;
  return [...new Set([...seg.matchAll(/value="([a-z_]+)"/g)].map((m) => m[1]))];
}

const keygenOpts = optionIds(keygenHtml, 'COMPETITION:OPTIONS:START');
check('keygen 选项含全部赛事', ids.every((id) => keygenOpts.includes(id)),
  '缺：' + ids.filter((id) => !keygenOpts.includes(id)).join(', '));
check('keygen 选项含全能包', keygenOpts.includes('all'));

// issuer.js 的下拉是从 comps 生成的，确认它没有再抄一份硬编码列表。
// ⚠️ 判据是"有没有把赛事 id 写死成字面量"，不是"有没有 value=xxx" ——
// 后者会连 <option value="all">（全能包，本来就该有）和有效期下拉的
// value="custom" 一起抓进来，我第一版就误报在这。
const strayIds = ids.filter((id) => new RegExp(`["'>=]\\s*${id}\\b`).test(issuerJs.replace(/comps\.[A-Za-z.]+/g, '')));
check('issuer.js 不抄赛事清单（从数据源生成）', strayIds.length === 0, '硬编码：' + strayIds.join(', '));
check('issuer.js 遍历数据源生成选项', /comps\.COMPETITIONS\.map/.test(issuerJs));
check('issuer.js 读数据源', /require\(['"]\.\.\/src\/main\/competitions['"]\)/.test(issuerJs));

// 价格：HTML 里手抄的必须等于 PRICES
const htmlPrices = {};
for (const m of keygenHtml.matchAll(/<option\s+value="([a-z_]+)"[^>]*>[^<]*?¥(\d+)/g)) {
  htmlPrices[m[1]] = Number(m[2]);
}
const priceDiff = Object.keys(comps.PRICES).filter((k) => htmlPrices[k] !== comps.PRICES[k]);
check('keygen 里每个价格都等于数据源 PRICES', priceDiff.length === 0,
  priceDiff.map((k) => `${k}: ¥${htmlPrices[k]} vs ¥${comps.PRICES[k]}`).join('; '));

// ---------------------------------------------------------------- ③ 透传
console.log('\n=== ③ competition 必须透传（否则单赛卡签成全能包）===');
const issueCall = issuerJs.slice(issuerJs.indexOf('issue({'), issuerJs.indexOf('issue({') + 500);
check('issuer.js 把 competition 传给 issue()', /competition:\s*b\.competition/.test(issueCall),
  '没透传 → 默认 all，卖 ¥39 的单赛卡会给到全能包权限');
// ⚠️ 这条断言的是**核心行为**（不传时默认 all），实现已移到 issuer-core.js。
// 行为本身没变：界面必须堵住它，不能靠核心兜底 —— 见下面那条界面断言。
check('核心：未传时默认 all（老行为，需被界面堵住）', /normalizeCompetition\(competition\)/.test(coreJs));
check('界面有赛事下拉', /id="competition"/.test(issuerJs));
check('签发结果回显赛事与价格', /competitionName/.test(issuerJs) && /price/.test(issuerJs));

// ---------------------------------------------------------------- ④ 台账
console.log('\n=== ④ 台账列映射（错位会让你看不见发过什么卡）===');
// ⚠️ 要定位到**服务端**那段：文件里 '/api/ledger' 出现两次，
// 前端的 api('/api/ledger') 在 loadLedger 里、位置更靠前，
// 直接 indexOf 会抓到前端代码，于是服务端字段一个也查不到（我第一版误报在这）。
const ledgerAt = issuerJs.indexOf("pathname === '/api/ledger'");
const ledgerSeg = issuerJs.slice(ledgerAt, ledgerAt + 900);
// 检查代码而不是注释：这段里有一句注释写着"曾经按 a[0]/a[1] 取下标"，
// 不排除注释就会把说明 bug 的注释当成 bug 本身（我第一版就栽在这）。
const ledgerCode = ledgerSeg.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('找到服务端台账接口', ledgerAt > 0);
check('台账接口不按数字下标取列', !/[a-z]\[\d\]/i.test(ledgerCode),
  'readLedger() 返回对象数组，按下标取会整体错位');
check('台账含 competition 字段', /competition:\s*r\.competition/.test(ledgerSeg));
check('台账含邀请码', /inviteCode/.test(ledgerSeg));

// 真实读一遍台账，确认字段能取到（含空台账的健壮性）
const { readLedger } = require('../tools/issue.js');
const rows = readLedger();
check('readLedger() 返回对象数组', rows.every((r) => typeof r === 'object' && 'card' in r));
if (rows.length) {
  check('每行都有 competition（旧行按 all 兼容）', rows.every((r) => typeof r.competition === 'string'));
  check('每行卡号能派生邀请码', rows.every((r) => /^\d{6}$/.test(comps.inviteCodeFromCard(r.card))));
}

// ---------------------------------------------------------------- ⑤ 端到端
console.log('\n=== ⑤ 端到端：GUI 签的单赛卡，客户端只放行该赛事与该机器 ===');
if (privPem) {
  const { issue } = require('../tools/issue.js');
  const { verifyCredential } = require('../src/main/license.js');
  const MACHINE = '7E842A70F9986EB7';

  const { credential, payload } = issue({
    machine: MACHINE, days: 30, competition: 'cumcm', buyer: '一致性测试',
  });

  check('签出的 competition = cumcm', payload.competition === 'cumcm', payload.competition);
  check('客户端验签认这张卡', verifyCredential(credential, MACHINE).ok === true,
    '验签失败说明 issuer 与 license 的签名格式已经不一致');
  // 这两条是商业上的核心保证：卡密绑定机器、按赛事放行
  check('换机器码立刻不认（一机一码）',
    verifyCredential(credential, 'AAAAAAAAAAAAAAAA').ok === false);
  check('该卡只解锁国赛', comps.unlocks(payload.competition, 'cumcm') === true);
  check('该卡不解锁华为杯', comps.unlocks(payload.competition, 'huawei') === false);
  check('该卡不解锁大数据赛', comps.unlocks(payload.competition, 'bigdata') === false);
  check('全能包解锁全部赛事',
    comps.COMPETITIONS.every((c) => comps.unlocks('all', c.id) === true));

  // 篡改检测：改了 payload 必须验不过（否则买家可以自己把 cumcm 改成 all）
  const tampered = credential.replace(/^([^.])/, (m) => (m === 'e' ? 'f' : 'e'));
  check('凭证被改一个字符即验不过', verifyCredential(tampered, MACHINE).ok === false);

  // 签发不能污染真实台账
  if (hadRealLedger) {
    const realLines = fs.readFileSync(REAL_LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
    const tmpLines = fs.readFileSync(process.env.MCM_LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
    check('测试签发没有写进真实 issued.csv', tmpLines > realLines,
      `副本 ${tmpLines} 行 vs 真实 ${realLines} 行`);
  }
} else {
  console.log('  · 私钥不在本机，跳过端到端');
}

// ---------------------------------------------------------------- ⑥ 应用
/**
 * 第 4 个入口：独立桌面应用（tools/issuer-app）。
 *
 * 它跑在打包后的 asar 里，用的是 vendor/ 下的**副本**，所以最容易漂移：
 * 有人改了 src/main/competitions.js 的定价，忘了跑 sync-issuer-app.js，
 * 应用就会按旧价卖。这里直接**比对内容**（不看时间戳），改了真源没同步就红。
 */
console.log('\n=== ⑥ 独立应用与真源同源（第 4 个入口，最容易漂）===');
const VENDOR = path.join(ROOT, 'tools', 'issuer-app', 'vendor');
const SYNC = [
  ['src/main/competitions.js', 'competitions.js'],
  ['src/main/license.js', 'license.js'],
  ['tools/issuer-core.js', 'issuer-core.js'],
];
for (const [srcRel, vendorName] of SYNC) {
  const vp = path.join(VENDOR, vendorName);
  if (!fs.existsSync(vp)) { check(`vendor/${vendorName} 存在`, false, '跑 node scripts/sync-issuer-app.js'); continue; }
  const srcText = read(srcRel);
  const vendText = fs.readFileSync(vp, 'utf8');
  /* 生成的文件带"勿手改"横幅，issuer-core 的 require 路径也被改写过，
     所以不能整文件相等 —— 比对**关键事实**，比字符串相等更耐改。 */
  if (vendorName === 'license.js') {
    /* ⚠️ 公钥必须从 license.js 比对：它是客户端验签的真源。
       上一版把公钥断言也套在 competitions.js 上，而那个文件里根本没有公钥 ——
       两边都取到空串、永远相等，等于一条空转的断言（反向验证时才发现）。
       所以这里先断言"确实抓到了公钥"，再比内容。 */
    const pk = (t) => (t.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/) || [''])[0].replace(/\s+/g, '');
    const a = pk(srcText); const b = pk(vendText);
    check('vendor/license.js 里有公钥（否则下面的比对是空转）', a.length > 40 && b.length > 40, `len=${a.length}/${b.length}`);
    check('vendor/license.js 的公钥与真源一致', a === b && a.length > 40, '换了密钥对而应用没同步 → 应用验的卡与客户端不一致');
  } else if (vendorName === 'competitions.js') {
    const digest = (t) => ({
      prices: (t.match(/[a-z_]+:\s*\d+/g) || []).join(','),
      ids: (t.match(/id:\s*'[a-z_]+'/g) || []).join(','),
    });
    const a = digest(srcText); const b = digest(vendText);
    check('vendor/competitions.js 里有价格与赛事 id（否则比对是空转）', a.prices.length > 0 && a.ids.length > 0);
    check('vendor/competitions.js 的价格与赛事 id 同源', a.prices === b.prices && a.ids === b.ids,
      `价格 ${a.prices} vs ${b.prices}`);
  } else {
    // issuer-core：核心逻辑（排号/签发/导入）必须逐字一致
    const strip = (t) => t.replace(/^\/\*[\s\S]*?\*\/\n/, '').replace(/require\('\.\/competitions'\)/g, "require('__C__')")
      .replace(/require\('\.\/license'\)/g, "require('__L__')")
      .replace(/require\(path\.join\(__dirname,\s*'\.\.',\s*'src',\s*'main',\s*'competitions'\)\)/g, "require('__C__')")
      .replace(/require\(path\.join\(__dirname,\s*'\.\.',\s*'src',\s*'main',\s*'license'\)\)/g, "require('__L__')")
      .replace(/\s+/g, ' ').trim();
    check('vendor/issuer-core.js 与 tools/issuer-core.js 同源', strip(srcText) === strip(vendText),
      '逻辑漂移了 —— 跑 node scripts/sync-issuer-app.js');
  }
}
// 应用不能自带私钥/台账
for (const f of fs.readdirSync(VENDOR)) {
  const t = fs.readFileSync(path.join(VENDOR, f), 'utf8');
  check(`vendor/${f} 无敏感内容`, !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)
    && !/^card,machine,edition/m.test(t));
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
