/**
 * 赛事模块测试：状态推导、倒计时、默认当前赛事、解锁判断。
 * 全部注入固定 now，不依赖真实时间。
 */
const C = require('../src/main/competitions');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const HOUR = 3600 * 1000;

// ---------- ① 数据完整性 ----------
console.log('=== ① 数据完整性 ===');
const ids = C.COMPETITIONS.map((c) => c.id);
check('id 不重复', new Set(ids).size === ids.length);
check('每个赛事都有价目', C.COMPETITIONS.every((c) => typeof c.price === 'number' && c.price > 0));
check('价目表 = 用户确认的定价', JSON.stringify(C.PRICES) === JSON.stringify(
  { cumcm: 69, huawei: 79, mcm: 79, shuwei: 39, apmcm: 39, bigdata: 39, huashu: 39, huashu_intl: 39, mathorcup: 29, others: 29, all: 168 }),
  JSON.stringify(C.PRICES));
// ⚠️ 不强制 https：MathorCup 官网只有 http，国赛报名入口（知网）也只有 http。
// 但要保证**没有危险协议**（javascript: / file: 之类），那才是真正的风险面。
check('官网/报名链接无危险协议', C.COMPETITIONS.every((c) =>
  /^https?:\/\//.test(c.url) && (!c.regUrl || /^https?:\/\//.test(c.regUrl))));
check('没有 javascript: / file: 协议', C.COMPETITIONS.every((c) =>
  !/^(javascript|file|data):/i.test(c.url) && !/^(javascript|file|data):/i.test(c.regUrl || '')));
check('数维杯时间与官网一致', C.get('shuwei').startAt === Date.parse('2026-11-20T09:00:00+08:00')
  && C.get('shuwei').endAt === Date.parse('2026-11-24T09:00:00+08:00'));
check('国赛时间与官网一致', C.get('cumcm').startAt === Date.parse('2026-09-10T18:00:00+08:00')
  && C.get('cumcm').endAt === Date.parse('2026-09-13T20:00:00+08:00'));
check('华为杯时间与开赛公告一致', C.get('huawei').startAt === Date.parse('2026-09-23T08:00:00+08:00')
  && C.get('huawei').endAt === Date.parse('2026-09-27T12:00:00+08:00'));
check('美赛 2027 未公布 → startAt null', C.get('mcm').startAt === null);

// ---------- ② 状态推导（注入固定 now）----------
console.log();
console.log('=== ② 状态推导 ===');
const shuweiStart = C.get('shuwei').startAt;
const shuweiEnd = C.get('shuwei').endAt;
check('开赛前 → 报名中', C.statusOf(C.get('shuwei'), shuweiStart - HOUR) === 'open');
check('比赛中 → 进行中', C.statusOf(C.get('shuwei'), shuweiStart + HOUR) === 'live');
check('结束瞬间 → 已结束', C.statusOf(C.get('shuwei'), shuweiEnd) === 'ended');
check('无时间 → 待公布', C.statusOf(C.get('mcm'), Date.now()) === 'tba');
check('国赛在今天已结束', C.statusOf(C.get('cumcm'), Date.now()) === 'ended');

// ---------- ③ 列表与倒计时 ----------
console.log();
console.log('=== ③ 列表与倒计时 ===');
const list = C.list(shuweiStart - 48 * HOUR);
const sw = list.find((c) => c.id === 'shuwei');
check('list 含状态文案', sw.statusText === '报名中', sw.statusText);
check('倒计时 = 48 小时', sw.countdownMs === 48 * HOUR, String(sw.countdownMs));
const swLive = C.list(shuweiStart + HOUR).find((c) => c.id === 'shuwei');
check('进行中倒计时归零', swLive.countdownMs === 0 && swLive.live === true);
const swEnded = C.list(shuweiEnd + HOUR).find((c) => c.id === 'shuwei');
check('已结束倒计时归零', swEnded.countdownMs === 0 && swEnded.upcoming === false);

// ---------- ④ 默认当前赛事 ----------
console.log();
console.log('=== ④ 默认当前赛事 ===');
// 2026-10-08：最近一场未开赛的是 MathorCup 大数据赛（10-23），比数维杯（11-20）更早
check('今天默认当前赛事 = 大数据赛', C.defaultCurrent(Date.parse('2026-10-08T12:00:00+08:00')) === 'bigdata',
  String(C.defaultCurrent(Date.parse('2026-10-08T12:00:00+08:00'))));
// 大数据赛结束后：数维杯接棒
check('大数据赛后接棒数维杯', C.defaultCurrent(Date.parse('2026-11-01T12:00:00+08:00')) === 'shuwei',
  String(C.defaultCurrent(Date.parse('2026-11-01T12:00:00+08:00'))));
// 数维杯结束后：没有任何报名中的有时间赛事 → null（面板显示"下一场待公布"）
check('全部结束后默认无当前赛事', C.defaultCurrent(shuweiEnd + 24 * HOUR) === null);

// ---------- ④B 新增赛事 ----------
console.log();
console.log('=== ④B 新增赛事（大数据 / 华数杯 / 华数杯国际）===');
check('大数据赛时间与报名通知一致',
  C.get('bigdata').startAt === Date.parse('2026-10-23T18:00:00+08:00')
  && C.get('bigdata').endAt === Date.parse('2026-10-30T20:00:00+08:00'));
check('大数据赛是 7 天赛',
  Math.round((C.get('bigdata').endAt - C.get('bigdata').startAt) / HOUR) === 170,
  String(Math.round((C.get('bigdata').endAt - C.get('bigdata').startAt) / HOUR)) + ' 小时');
check('华数杯时间与赛题发布一致',
  C.get('huashu').startAt === Date.parse('2026-08-07T18:00:00+08:00')
  && C.get('huashu').endAt === Date.parse('2026-08-10T20:00:00+08:00'));
check('华数杯国际赛时间与赛题发布一致',
  C.get('huashu_intl').startAt === Date.parse('2026-01-17T06:00:00+08:00')
  && C.get('huashu_intl').endAt === Date.parse('2026-01-21T09:00:00+08:00'));
check('华数杯国际赛是 4 天赛',
  Math.round((C.get('huashu_intl').endAt - C.get('huashu_intl').startAt) / HOUR) === 99,
  String(Math.round((C.get('huashu_intl').endAt - C.get('huashu_intl').startAt) / HOUR)) + ' 小时');
check('大数据赛与 MathorCup 建模赛是两个独立 SKU',
  C.get('bigdata').id !== C.get('mathorcup').id && C.get('bigdata').price !== undefined);

console.log();
console.log('=== ④C 定价（用户确认：39 档统一）===');
check('亚太赛已调为 39', C.PRICES.apmcm === 39, String(C.PRICES.apmcm));
check('39 档五个赛事一致',
  ['shuwei', 'apmcm', 'bigdata', 'huashu', 'huashu_intl'].every((id) => C.PRICES[id] === 39));
check('小赛保持 29', C.PRICES.mathorcup === 29 && C.PRICES.others === 29);
check('主力赛事不变', C.PRICES.cumcm === 69 && C.PRICES.huawei === 79 && C.PRICES.mcm === 79);
check('全能包 168', C.PRICES.all === 168);

console.log();
console.log('=== ④D 邀请码派生 ===');
check('卡号后 6 位', C.inviteCodeFromCard('MCM-2026-0005') === '260005', String(C.inviteCodeFromCard('MCM-2026-0005')));
check('取的是末尾数字', C.inviteCodeFromCard('MCM-2026-1234') === '261234', String(C.inviteCodeFromCard('MCM-2026-1234')));
check('位数不足返回 null', C.inviteCodeFromCard('MCM-1') === null, String(C.inviteCodeFromCard('MCM-1')));
check('空值返回 null', C.inviteCodeFromCard('') === null && C.inviteCodeFromCard(null) === null);
check('同一卡号稳定', C.inviteCodeFromCard('MCM-2026-0005') === C.inviteCodeFromCard('MCM-2026-0005'));
check('邀请规则：朋友减 5 元', C.INVITE_RULES.friendDiscount === 5);
check('邀请规则：满 3 人送一期', C.INVITE_RULES.threshold === 3);

console.log();
console.log('=== ④E 邀请码与台账联动（issue.js）===');
// 用临时台账，不污染真台账
const os = require('node:os');
const fsx = require('node:fs');
const pathx = require('node:path');
const tmpCards = pathx.join(os.tmpdir(), 'inv-cards-' + Date.now() + '.csv');
const tmpInv = pathx.join(os.tmpdir(), 'inv-invites-' + Date.now() + '.csv');
process.env.MCM_LEDGER = tmpCards;
process.env.MCM_INVITE_LEDGER = tmpInv;
const issuer = require('../tools/issue.js');

const rec = issuer.issue({ machine: '7E842A70F9986EB7', competition: 'cumcm', days: 365, buyer: '张三', now: Date.now() });
const code = C.inviteCodeFromCard(rec.payload.card);
check('签发的卡能派生出邀请码', /^\d{6}$/.test(code), String(code));
check('推荐人可反查到卡号', issuer.whoIs(code) && issuer.whoIs(code).card === rec.payload.card,
  String(issuer.whoIs(code) && issuer.whoIs(code).card));

issuer.recordInvite({ inviterCode: code, buyer: '李四' });
issuer.recordInvite({ inviterCode: code, buyer: '王五' });
check('记录两次推荐', issuer.countInvites(code) === 2, String(issuer.countInvites(code)));
issuer.recordInvite({ inviterCode: code, buyer: '赵六' });
check('第三次后达阈值', issuer.countInvites(code) >= C.INVITE_RULES.threshold);
check('统计里能看到该码', issuer.inviteStats().some((s) => s.code === code && s.count === 3));
let threw = false;
try { issuer.recordInvite({ inviterCode: 'abc' }); } catch { threw = true; }
check('非法邀请码被拒（非 6 位数字）', threw);
check('不存在的邀请码反查为 null', issuer.whoIs('999999') === null);

fsx.rmSync(tmpCards, { force: true });
fsx.rmSync(tmpInv, { force: true });
delete process.env.MCM_LEDGER;
delete process.env.MCM_INVITE_LEDGER;

// ---------- ⑤ 解锁判断 ----------
console.log();
console.log('=== ⑤ 解锁判断 ===');
check('all 解锁任何赛事', C.unlocks('all', 'cumcm') === true);
check('缺省（undefined/null）按 all 兼容', C.unlocks(undefined, 'cumcm') === true && C.unlocks(null, 'mcm') === true);
check('国赛卡不解锁华为杯', C.unlocks('cumcm', 'huawei') === false);
check('国赛卡解锁国赛', C.unlocks('cumcm', 'cumcm') === true);
check('others 档不等于具体赛事', C.unlocks('others', 'mathorcup') === false);

// ---------- 结果 ----------
console.log();
console.log(`结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
