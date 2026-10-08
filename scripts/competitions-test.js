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
  { cumcm: 69, huawei: 79, mcm: 79, apmcm: 49, shuwei: 39, mathorcup: 29, others: 29, all: 168 }),
  JSON.stringify(C.PRICES));
check('有 startAt 的赛事 URL 都是 https', C.COMPETITIONS.every((c) => /^https:\/\//.test(c.url)));
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
// 2026-10-08：唯一"报名中且有时间"的是数维杯
check('今天默认当前赛事 = 数维杯', C.defaultCurrent(Date.parse('2026-10-08T12:00:00+08:00')) === 'shuwei',
  String(C.defaultCurrent(Date.parse('2026-10-08T12:00:00+08:00'))));
// 数维杯结束后：没有任何报名中的有时间赛事 → null（面板显示"下一场待公布"）
check('全部结束后默认无当前赛事', C.defaultCurrent(shuweiEnd + 24 * HOUR) === null);

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
