/**
 * 赛事模块测试：状态推导、倒计时、默认当前赛事、解锁判断。
 * 全部注入固定 now，不依赖真实时间。
 */
const C = require('../src/main/competitions');
const fs = require('node:fs');
const path = require('node:path');

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
check('大数据赛与 MathorCup 建模赛是两个独立赛事',
  C.get('bigdata').id !== C.get('mathorcup').id);

console.log();
console.log('=== ④C 时长档位与定价 ===');
// 2026-10 起授权改时长制：赛事不再参与授权与定价。
check('四个档位齐全', ['week', 'month', 'year', 'forever'].every((k) => C.PLANS[k]),
  Object.keys(C.PLANS).join('/'));
check('周卡 7 天', C.PLANS.week.days === 7);
check('月卡 30 天', C.PLANS.month.days === 30);
check('永久买断没有天数', C.PLANS.forever.days === null);
check('年卡 365 天', C.PLANS.year.days === 365);
check('价格随时长递增（29/59/99/199）',
  C.PLANS.week.price === 29 && C.PLANS.month.price === 59
  && C.PLANS.year.price === 99 && C.PLANS.forever.price === 199,
  `${C.PLANS.week.price}/${C.PLANS.month.price}/${C.PLANS.year.price}/${C.PLANS.forever.price}`);
check('赛事数据不再带价格（已与授权解耦）',
  C.COMPETITIONS.every((c) => c.price === undefined));
check('不再导出 PRICES / unlocks',
  C.PRICES === undefined && C.unlocks === undefined);
check('normalizePlan 认四个档位',
  ['week', 'month', 'year', 'forever'].every((k) => C.normalizePlan(k) === k));
check('normalizePlan 拒未知档位', (() => {
  try { C.normalizePlan('cumcm'); return false; } catch { return true; }
})());
check('planOf：新卡按 plan', C.planOf({ plan: 'month' }) === 'month');
check('永久卡到期哨兵是 2099', C.PERPETUAL_MS === Date.UTC(2099, 0, 1),
  new Date(C.PERPETUAL_MS).toISOString().slice(0, 10));
check('planDaysText：永久不显示天数', C.planDaysText('forever') === '永久'
  && C.planDaysText('month') === '30 天');
check('isPerpetual 认永久卡', C.isPerpetual({ plan: 'forever' }) === true
  && C.isPerpetual({ plan: 'year' }) === false && C.isPerpetual({}) === false);
check('planOf：旧卡无 plan → 年卡兼容', C.planOf({}) === 'year' && C.planOf(null) === 'year');

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

// ---------- ⑥ 授权口径：时长制 ----------
// 授权改时长制后，门禁只剩「模式」一层：体验中/已激活放行，过期/未激活拦截。
// 这里锁住三件容易被后人改坏的事：
//   ① 激活逻辑不再依赖赛事字段（否则改赛事数据会让已售卡失效）；
//   ② 赛事切换 IPC 保持撤掉状态（面板已经没了，留着就是死代码）；
//   ③ 凭证里不再出现 competition 字段。
console.log();
console.log('=== ⑥ 授权口径：时长制 ===');
const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
// currentCompetition 仍保留，但只用于选 AI 声明措辞（与授权无关）
check('激活不再按赛事写 config',
  !/writeConfig\(\{ currentCompetition/.test(ipcSrc));
check('激活日志报档位不报赛事', /档位=/.test(ipcSrc));
check('界面不再暴露赛事切换 IPC',
  !/ipcMain\.handle\('competitions:list'/.test(ipcSrc)
  && !/ipcMain\.handle\('competition:setCurrent'/.test(ipcSrc));
check('门禁提示分「到期」与「体验结束」两种',
  ipcSrc.includes('授权已到期') && ipcSrc.includes('体验已结束'));

const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'issuer-core.js'), 'utf8');
check('凭证 payload 带 plan 不带 competition',
  /payload = \{ card, machine: m, edition, plan: p,/.test(coreSrc)
  && !/payload = \{ card, machine: m, edition, competition/.test(coreSrc));
check('台账表头用 plan 列', /LEDGER_HEADER = 'card,machine,edition,plan,/.test(coreSrc));
check('老 --competition 参数仍可发卡（不抛错）',
  /function normalizeCompetition\(s\)/.test(coreSrc)
  && /已废弃，请改用 --plan/.test(coreSrc));

// ---------- 结果 ----------
console.log();
console.log(`结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
