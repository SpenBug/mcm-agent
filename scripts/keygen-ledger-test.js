#!/usr/bin/env node
'use strict';

/**
 * keygen.html 台账逻辑测试（卡号去重 / CSV 导入）。
 *
 * 为什么要在 Node 里测一个网页里的函数：
 * 重复卡号是真实的商业事故 —— keygen 原先用自己的 localStorage 计数器排号，
 * 完全看不到 tools/issued.csv。于是
 *   - 先用命令行发 6 张，再用网页发 → 网页从 0001 重新开始，签出同号卡
 *   - 清浏览器数据 / 换电脑 → 同样归零
 * 邀请码 = 卡号后 6 位，两张同号卡就有同一个邀请码，
 * issue.js 的 whoIs() 取第一条匹配 → 推荐奖励记到错误的人头上。
 *
 * 这些函数写在 HTML 里、跑在浏览器里，没法直接 require。
 * 这里把它们从 <script> 里抠出来，配一个假 localStorage 求值 ——
 * 宁可测得糙一点，也不要"看起来对"就放过去。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tools', 'keygen.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')); }
}

/** 抠出指定名字的函数源码（按大括号配平，正则匹配嵌套会漏） */
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

const names = ['readLedger', 'writeLedger', 'nextSeq', 'parseCsv', 'mergeLedger'];
const src = names.map((n) => {
  const f = extractFn(n);
  if (!f) throw new Error(`keygen.html 里找不到函数 ${n}（改名或删掉了？测试要同步）`);
  return f;
}).join('\n');

function makeCtx(seed = []) {
  const store = { 'mcm.ledger': JSON.stringify(seed) };
  const ctx = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    LS_LEDGER: 'mcm.ledger',
    LS_SEQ: 'mcm.seq',
    renderLedger() {},        // 页面渲染，测试里不需要
    flash() {},
    console,
    JSON,
    Set,
    Number,
    String,
    Math,
    RegExp,
    Date,
    Array,
    Object,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, store };
}

const cards = (ctx) => JSON.parse(ctx.localStorage.getItem('mcm.ledger')).map((r) => r.card);

console.log('=== ① parseCsv（导入 issued.csv 的第一步）===');
{
  const { ctx } = makeCtx();
  const rows = ctx.parseCsv('card,machine,note\nMCM-2026-0001,ABC,"x, y"\nMCM-2026-0002,DEF,"say ""hi"""\n');
  check('解析出行数', rows.length === 3, `${rows.length}`);
  check('引号内的逗号不算分隔', rows[1][2] === 'x, y', JSON.stringify(rows[1]));
  check('转义双引号还原', rows[2][2] === 'say "hi"', JSON.stringify(rows[2]));
  check('CRLF 也能解析', ctx.parseCsv('a,b\r\n1,2\r\n').length === 2);
  check('空行被丢掉', ctx.parseCsv('a,b\n\n\n').length === 1);
}

console.log('\n=== ② nextSeq：不能与已存在的卡号撞车 ===');
{
  const { ctx } = makeCtx([
    { card: 'MCM-2026-0006' }, { card: 'MCM-2026-0001' }, { card: 'MCM-2025-0042' },
  ]);
  const n = ctx.nextSeq();
  check('取已有最大序号 +1（不是从 1 开始）', n === 7, `${n}`);
  // 真实契约：nextSeq 只读台账、不写台账，所以没写入新卡前重复调用必须给同一个号；
  // 写了卡之后才前进。断言写成 "7 或 8" 就等于没断言。
  check('未写卡时重复调用不前进（幂等）', ctx.nextSeq() === 7, `${ctx.nextSeq()}`);
  ctx.writeLedger([...JSON.parse(ctx.localStorage.getItem('mcm.ledger')), { card: `MCM-${new Date().getFullYear()}-0007` }]);
  check('写入 0007 后前进到 0008', ctx.nextSeq() === 8, `${ctx.nextSeq()}`);
}

console.log('\n=== ②B 跨年重新排号（与 issue.js 一致：按当年计数）===');
{
  const { ctx } = makeCtx([{ card: 'MCM-2027-0042' }, { card: 'MCM-2027-0043' }]);
  // 本年是 2026，台账里只有 2027 的卡 → 本年应从 0001 开始
  check('往年/来年卡号不影响本年序号', ctx.nextSeq() === 1, `${ctx.nextSeq()}`);
}

console.log('\n=== ③ 清浏览器数据后导入 CLI 台账 → 接着排号 ===');
{
  // 模拟：命令行发了 6 张，网页这边台账是空的（清过数据）
  const { ctx } = makeCtx([]);
  const csv = 'card,machine,edition,competition,issuedAt,expireAt,buyer,note\n'
    + 'MCM-2026-0001,7E84,pro,all,,,,\n'
    + 'MCM-2026-0002,7E84,pro,all,,,,\n'
    + 'MCM-2026-0006,7E84,pro,mathorcup,,,\n';
  const rows = ctx.parseCsv(csv);
  const head = rows[0].map((h) => h.toLowerCase());
  const iCard = head.indexOf('card');
  const incoming = rows.slice(1).map((r) => ({ card: r[iCard] }));
  const added = ctx.mergeLedger(incoming);
  check('导入 3 条', added === 3, `${added}`);
  check('导入后 nextSeq 接着排（不再从 0001 开始）', ctx.nextSeq() === 7, `${ctx.nextSeq()}`);

  const again = ctx.mergeLedger(incoming);
  check('重复导入不产生重复卡号', again === 0 && new Set(cards(ctx)).size === cards(ctx).length);
}

console.log('\n=== ④ mergeLedger 不覆盖已有记录 ===');
{
  const { ctx } = makeCtx([{ card: 'MCM-2026-0001', buyer: '真实买家', competition: 'cumcm' }]);
  ctx.mergeLedger([{ card: 'MCM-2026-0001', buyer: '', competition: 'all' }]);
  const kept = JSON.parse(ctx.localStorage.getItem('mcm.ledger'))[0];
  check('同卡号保留原记录（不被空值覆盖）', kept.buyer === '真实买家' && kept.competition === 'cumcm',
    JSON.stringify(kept));
}

console.log('\n=== ⑤ 卡号与邀请码的唯一性（商业上的硬要求）===');
{
  const comps = require('../src/main/competitions');
  const { ctx } = makeCtx([]);
  const issued = [];
  for (let i = 0; i < 5; i += 1) {
    const seq = ctx.nextSeq();
    const card = `MCM-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
    issued.push(card);
    ctx.writeLedger([...JSON.parse(ctx.localStorage.getItem('mcm.ledger')), { card }]);
  }
  check('连续 5 次签发卡号互不相同', new Set(issued).size === 5, issued.join(','));
  const codes = issued.map((c) => comps.inviteCodeFromCard(c));
  check('邀请码互不相同（whoIs 不会认错人）', new Set(codes).size === 5, codes.join(','));
}

console.log('\n=== ⑥ keygen 与 issue.js 的卡号格式一致 ===');
{
  // 卡号格式的实现在 issuer-core.js（命令行/HTTP/桌面应用共用一份）。
  // 断言要跟着逻辑走，别钉死在某个入口文件上 —— 否则搬一次家就误报一次。
  const coreSrc = fs.readFileSync(path.join(ROOT, 'tools', 'issuer-core.js'), 'utf8');
  check('核心用 MCM-年-4位序号', /MCM-\$\{year\}-\$\{seq\}/.test(coreSrc));
  check('序号同为 4 位补零', /padStart\(4,\s*'0'\)/.test(coreSrc));
  // 顺带确认命令行版确实走的是核心，而不是自己又抄了一份
  const issueSrc = fs.readFileSync(path.join(ROOT, 'tools', 'issue.js'), 'utf8');
  check('issue.js 复用核心（不自己算卡号）', /require\(['"]\.\/issuer-core['"]\)/.test(issueSrc)
    && !/MCM-\$\{/.test(issueSrc), 'issue.js 里又出现了卡号拼装，说明逻辑被抄回去了');
}

/**
 * ⑥B issue.js 自己的排号必须也是 max+1。
 *
 * 为什么单独测：⑥ 只比对**源码文本**，而文本一致不代表算法一致。
 * 真实缺陷就在这儿 —— issue.js 一度写的是 `readLedger().length + 1`（行数+1），
 * keygen 是 max+1。台账有空洞时两者就分叉：
 *   导入 0001、0003（缺 0002）→ count+1 算出 0003，与已付款客户同号。
 * 空洞的常见来源正是 README 要求卖家做的 `issue.js import`（keygen 里删过记录再导出）。
 * 上一版这个套件只测了 keygen 侧的 nextSeq，CLI 侧一次都没测到，所以漏了。
 */
console.log('\n=== ⑥B issue.js 排号：有空洞也不能撞号（max+1，不是 count+1）===');
{
  process.env.MCM_LEDGER = path.join(os.tmpdir(), `nope-${process.pid}-never-read.csv`);
  const { nextSeq } = require(path.join(ROOT, 'tools', 'issue.js'));
  const Y = 2026;

  check('空台账 → 0001', nextSeq(Y, []) === 1);
  check('连续 1..3 → 4', nextSeq(Y, [{ card: 'MCM-2026-0001' }, { card: 'MCM-2026-0002' }, { card: 'MCM-2026-0003' }]) === 4);
  check('乱序台账 → 仍取最大值 +1', nextSeq(Y, [{ card: 'MCM-2026-0006' }, { card: 'MCM-2026-0001' }]) === 7);
  check('有空洞（0001,0003）→ 4 而不是 3', nextSeq(Y, [{ card: 'MCM-2026-0001' }, { card: 'MCM-2026-0003' }]) === 4);
  check('跨年：只有 2027 的卡 → 本年从 1 起', nextSeq(Y, [{ card: 'MCM-2027-0042' }]) === 1);
  check('畸形卡号不参与排号', nextSeq(Y, [{ card: 'GARBAGE' }, { card: 'MCM-2026-9999' }]) === 10000);
  check('缺 card 字段不崩', nextSeq(Y, [{ buyer: '甲' }, { card: 'MCM-2026-0002' }]) === 3);

  // 关键不变量：连续签发必须互不相同（count+1 在有空洞时会立刻违反）
  const rows = [{ card: 'MCM-2026-0001' }, { card: 'MCM-2026-0003' }];
  const issued = [];
  for (let i = 0; i < 4; i += 1) {
    const n = nextSeq(Y, rows);
    const card = `MCM-${Y}-${String(n).padStart(4, '0')}`;
    issued.push(card);
    rows.push({ card });
  }
  check('从空洞台账连发 4 张互不相同', new Set(issued).size === 4, issued.join(','));
  check('且都不与导入的两张撞号', !issued.includes('MCM-2026-0001') && !issued.includes('MCM-2026-0003'), issued.join(','));
  const codes = issued.map((c) => require('../src/main/competitions').inviteCodeFromCard(c));
  check('邀请码互不相同', new Set(codes).size === 4, codes.join(','));

  // 反向守卫：确认这条测试真的抓得住 count+1（否则它和没写一样）
  const countPlusOne = (rs) => rs.length + 1;
  const hole = [{ card: 'MCM-2026-0001' }, { card: 'MCM-2026-0003' }];
  check('反证：count+1 在空洞台账下会给出 3（撞号）', countPlusOne(hole) === 3 && nextSeq(Y, hole) === 4,
    `count+1=${countPlusOne(hole)} max+1=${nextSeq(Y, hole)}`);
}

/**
 * ⑦ 往返契约：keygen「导出 CSV」的表头，必须能被 `issue.js import` 认出来。
 *
 * 这是最容易悄悄断的一环 —— 两边各写一份中文表头，谁改了对方不知道，
 * 结果就是"导进去了但所有列都错位"或"整份被拒"。
 * 这里不复制表头字符串，而是**从 keygen.html 里把真实表头抠出来**再喂给 import，
 * 改了任何一边都会在这里暴露。
 */
console.log('\n=== ⑦ keygen 导出的 CSV 能被 issue.js import 读回（往返契约）===');
{
  const { execFileSync } = require('node:child_process');
  const m = html.match(/const head = \[(.*?)\];/);
  check('抠到 keygen 的导出表头', Boolean(m), 'keygen.html 里 head 数组的写法变了，测试要同步');
  if (m) {
    const head = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    check('表头含卡号/机器码/赛事/买家', ['卡号', '机器码', '赛事', '买家'].every((k) => head.includes(k)),
      head.join('/'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayigu-roundtrip-'));
    const ledger = path.join(dir, 'issued.csv');
    const csvPath = path.join(dir, 'kg.csv');
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const row = ['MCM-2026-0099', '7E84-2A70-F998-6EB7', 'bigdata', 'pro',
      '2026-10-09T01:00:00.000Z', '2027-10-09T01:00:00.000Z', '张三', 'eyJxxx'];
    fs.writeFileSync(csvPath, '\uFEFF' + [head, row].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n', 'utf8');

    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'issue.js'), 'import', csvPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, MCM_LEDGER: ledger },
    });
    check('import 认下这张卡', /新增 1 张/.test(out), out.split('\n').find((l) => l.includes('新增')));

    const written = fs.readFileSync(ledger, 'utf8');
    check('赛事正确落到 competition 列', /MCM-2026-0099,7E842A70F9986EB7,pro,bigdata/.test(written),
      written.split('\n').find((l) => l.startsWith('MCM-2026-0099')));
    check('买家名没被列错位吃掉', written.includes('张三'));
    check('带 BOM 的 CSV 也能解析表头', !out.includes('没找到') && !out.includes('不认识'));

    // 中文赛事名要能按名字兜住（手工改过的台账常写中文名）
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ayigu-name-'));
    const csv2 = path.join(dir2, 'n.csv');
    const ledger2 = path.join(dir2, 'issued.csv');
    fs.writeFileSync(csv2, '\uFEFF' + [head, ['MCM-2026-0100', 'AAAA-BBBB-CCCC-DDDD', '华数杯', 'pro',
      '', '', '李四', 'e'].map(esc).join(',')].join('\n'), 'utf8');
    const out2 = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'issue.js'), 'import', csv2], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, MCM_LEDGER: ledger2 },
    });
    check('中文赛事名「华数杯」解析成 huashu', /huashu/.test(fs.readFileSync(ledger2, 'utf8')),
      out2.split('\n').find((l) => l.includes('260100')));

    // 认不出的赛事不能被悄悄写成 all（台账是收钱凭据）
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ayigu-bad-'));
    const csv3 = path.join(dir3, 'b.csv');
    const ledger3 = path.join(dir3, 'issued.csv');
    fs.writeFileSync(csv3, '\uFEFF' + [head, ['MCM-2026-0101', 'AAAA-BBBB-CCCC-DDDD', '世界杯杯', 'pro',
      '', '', '王五', 'e'].map(esc).join(',')].join('\n'), 'utf8');
    const out3 = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'issue.js'), 'import', csv3], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, MCM_LEDGER: ledger3 },
    });
    const l3 = fs.readFileSync(ledger3, 'utf8');
    check('未知赛事保留原值并警告（不静默变 all）',
      l3.includes('世界杯杯') && /对不上任何已知赛事/.test(out3), l3.split('\n').find((x) => x.startsWith('MCM-2026-0101')));

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(dir3, { recursive: true, force: true });
  }
}

/**
 * ⑧ 显示辅助函数。
 *
 * 为什么要单独测：这三个函数跑在浏览器 DOM 里，前面几节够不着。
 * 其中 compLabel 存在的意义就是**消灭第三份手抄清单** ——
 * keygen 原先自己存了一份 COMP_NAMES 字典，上一轮新增的
 * bigdata / huashu / huashu_intl 都不在里面，签完只显示裸 id。
 * 现在它直接读 <option> 文案（那份由 sync-keygen-options.js 从数据源生成）。
 */
console.log('\n=== ⑧ 显示辅助函数（compLabel / fmtDate / pretty）===');
const optionText = {};
for (const m of html.matchAll(/<option value="([a-z_]+)"[^>]*>([^<]*)<\/option>/g)) {
  optionText[m[1]] = m[2].trim();
}
const ctx2 = {
  document: {
    querySelector: (sel) => {
      const m = /option\[value="([a-z_]+)"\]/.exec(sel);
      const id = m && m[1];
      return id && optionText[id] ? { textContent: optionText[id] } : null;
    },
  },
  Number, String, Date, Math, RegExp, Object, JSON,
};
{
  const comps = require('../src/main/competitions');

  const src2 = ['compLabel', 'fmtDate', 'pretty'].map((n) => {
    const f = extractFn(n);
    if (!f) throw new Error(`keygen.html 里找不到函数 ${n}`);
    return f;
  }).join('\n');

  vm.createContext(ctx2);
  vm.runInContext(src2, ctx2);

  const unnamed = comps.COMPETITIONS.filter((c) => !ctx2.compLabel(c.id) || ctx2.compLabel(c.id) === c.id);
  check('每个赛事都能取到中文显示名', unnamed.length === 0, '裸 id：' + unnamed.map((c) => c.id).join(','));
  check('大数据赛显示名含「大数据」', ctx2.compLabel('bigdata').includes('大数据'), ctx2.compLabel('bigdata'));
  check('华数杯显示名含「华数杯」', ctx2.compLabel('huashu').includes('华数杯'), ctx2.compLabel('huashu'));
  check('全能包显示名含「全能包」', ctx2.compLabel('all').includes('全能包'), ctx2.compLabel('all'));
  check('已下架赛事原样返回（不瞎猜名字）', ctx2.compLabel('retired_cup') === 'retired_cup');
  check('空值按全能包处理', ctx2.compLabel('').includes('全能包'), ctx2.compLabel(''));

  check('fmtDate 吃 ISO 字符串', ctx2.fmtDate('2027-10-09T01:00:00.000Z') === '2027-10-09',
    ctx2.fmtDate('2027-10-09T01:00:00.000Z'));
  const ts = Date.UTC(2027, 9, 9, 1, 0, 0);
  check('fmtDate 吃毫秒时间戳', ctx2.fmtDate(ts) === '2027-10-09', ctx2.fmtDate(ts));
  check('fmtDate 空值不崩', ctx2.fmtDate(null) === '—' && ctx2.fmtDate('') === '—' && ctx2.fmtDate(undefined) === '—');
  check('fmtDate 垃圾值不崩', ctx2.fmtDate('not-a-date') === '—', ctx2.fmtDate('not-a-date'));

  check('pretty 正常分组', ctx2.pretty('7E842A70F9986EB7') === '7E84-2A70-F998-6EB7', ctx2.pretty('7E842A70F9986EB7'));
  // 旧实现是 m.match(/.{1,4}/g).join('-')：机器码为空时 match 返回 null，
  // 直接 .join 抛错 → 整个台账表格渲染不出来，页面看起来像坏了且没有任何提示。
  check('pretty 空机器码不崩（旧版会抛错拖垮整张表）',
    ctx2.pretty('') === '—' && ctx2.pretty(null) === '—' && ctx2.pretty(undefined) === '—');
  check('pretty 能吃带横杠的输入', ctx2.pretty('7E84-2A70-F998-6EB7') === '7E84-2A70-F998-6EB7',
    ctx2.pretty('7E84-2A70-F998-6EB7'));
}

/** 反向验证：这些防线本身要能失败，否则等于没有。 */
console.log('\n=== ⑨ 反向验证（确认检查真的会红）===');
{
  // compLabel 的兜底行为：下拉里找不到对应 option 时，必须原样返回裸 id，
  // 而不是凭记忆编一个名字 —— 台账上显示错赛事名比显示裸 id 更糟。
  const saved = optionText.huashu;
  delete optionText.huashu;
  check('选项缺失时不编造名字', ctx2.compLabel('huashu') === 'huashu', ctx2.compLabel('huashu'));
  optionText.huashu = saved;
  check('恢复后重新取到名字', ctx2.compLabel('huashu').includes('华数杯'), ctx2.compLabel('huashu'));
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
