'use strict';

/**
 * 赛事日历 —— 内置官方准确时间 + 状态推导 + 价目表。
 *
 * 设计要点：
 *
 * 1. **状态不写死**：报名中 / 进行中 / 已结束 / 待公布，全部由
 *    startAt / endAt / regDeadline 与当前时间实时推导，倒计时同理。
 *    时间统一存 UTC 毫秒（Date.parse('...+08:00')），显示用本地时区。
 *
 * 2. **数据是快照不是服务**：改期就改这个文件重新打包（YAGNI，
 *    不为日历引入联网更新与服务端）。
 *
 * 3. **时间来源（2026-10-08 联网核实）**：
 *    - 国赛：mcm.edu.cn 首页 —— 2026-09-10 18:00 发布赛题，云南赛区通知
 *      载明 09-10 18:00 → 09-13 20:00
 *    - 华为杯：研究生数学建模竞赛开赛公告（2026-09-16）——
 *      09-23 08:00 → 09-27 12:00
 *    - 亚太赛：APMCM 中文赛项题目发布 —— 06-12 18:00 → 06-15 20:00
 *    - 数维杯：nmmcm.org.cn《关于大赛》—— 报名截止 11-20 06:00，
 *      11-20 09:00 → 11-24 09:00，论文 11-24 10:00 截止
 *    - MathorCup：mathorcup.org —— 04-17 08:00 → 04-21 09:00
 *    - 美赛 2027：官方未公布 → tba
 *
 * 4. **价目表是用户确认过的商业决策**，不要随手改：
 *    国赛 69 / 华为杯 79 / 美赛 79 / 亚太 49 / 数维杯 39 / 小赛 29 / 全能包 168。
 */

const HOUR = 3600 * 1000;

/** 解析中国时间（+08:00）为 UTC 毫秒；解析失败返回 null */
function cn(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 价目表（元，人民币）—— 商业决策，勿改 */
const PRICES = {
  cumcm: 69,
  huawei: 79,
  mcm: 79,
  apmcm: 49,
  shuwei: 39,
  mathorcup: 29,
  others: 29,
  all: 168,
};

/**
 * 赛事清单。字段：
 *   id           稳定标识（也是凭证 competition 字段的取值）
 *   name         短名（面板显示）
 *   fullName     全称（详情/文档）
 *   price        解锁价（元）
 *   startAt      开赛 UTC 毫秒；null = 官方未公布
 *   endAt        结束 UTC 毫秒
 *   regDeadline  报名截止 UTC 毫秒（可空）
 *   paperDeadline 论文提交截止（可空）
 *   url          官网
 *   regUrl       报名入口（可空）
 *   fee          官方报名费（元/队，可空）
 *   note         重要提示（合规/规则，可空）
 *   tier         main（主推）/ small（小赛）/ bundle（套餐展示用）
 */
const COMPETITIONS = [
  {
    id: 'shuwei',
    name: '数维杯秋季赛',
    fullName: '2026 年第十二届数维杯全国大学生数学建模挑战赛（秋季赛）',
    price: PRICES.shuwei,
    startAt: cn('2026-11-20T09:00:00+08:00'),
    endAt: cn('2026-11-24T09:00:00+08:00'),
    regDeadline: cn('2026-11-20T06:00:00+08:00'),
    paperDeadline: cn('2026-11-24T10:00:00+08:00'),
    url: 'https://www.nmmcm.org.cn/',
    regUrl: 'https://www.mojinghub.com/competitions/swbmcm/2026',
    fee: 200,
    note: '全英文论文；AIGC 占比 >30% 或总相似比 >50% 取消评奖资格',
    tier: 'main',
  },
  {
    id: 'cumcm',
    name: '国赛 CUMCM',
    fullName: '高教社杯全国大学生数学建模竞赛',
    price: PRICES.cumcm,
    startAt: cn('2026-09-10T18:00:00+08:00'),
    endAt: cn('2026-09-13T20:00:00+08:00'),
    regDeadline: null,
    url: 'https://www.mcm.edu.cn/',
    regUrl: 'http://cumcm.cnki.net',
    note: '2026 届已结束（89,516 队）；2027 届时间待官方公布。'
      + '使用 AI 须按《人工智能工具使用规定（2026 试行）》在参考文献前声明并附使用详情',
    tier: 'main',
    next: '2027 届时间待官方公布（往年 9 月第二个周末）',
  },
  {
    id: 'huawei',
    name: '华为杯研究生赛',
    fullName: '中国研究生数学建模竞赛（华为杯，第 23 届）',
    price: PRICES.huawei,
    startAt: cn('2026-09-23T08:00:00+08:00'),
    endAt: cn('2026-09-27T12:00:00+08:00'),
    regDeadline: cn('2026-09-19T17:00:00+08:00'),
    url: 'https://www.shumo.com/',
    regUrl: 'https://cpipc.acge.org.cn/cw/hp/4',
    note: '2026 届已结束；正文 50 页以上。允许用 AI 但须按规定注明引用来源',
    tier: 'main',
    next: '2027 届（第 24 届）时间待官方公布',
  },
  {
    id: 'mcm',
    name: '美赛 MCM/ICM',
    fullName: 'COMAP Mathematical Contest in Modeling / ICM',
    price: PRICES.mcm,
    startAt: null,   // 2027 届官方未公布
    endAt: null,
    regDeadline: null,
    url: 'https://www.comap.com/contests/mcm-icm',
    note: '英文论文约 22 页；2027 届开赛时间待 COMAP 公布（往年 1 月底）',
    tier: 'main',
    next: '2027 届时间待 COMAP 公布（往年 1 月底连赛 4 天）',
  },
  {
    id: 'apmcm',
    name: '亚太赛 APMCM',
    fullName: '亚太地区大学生数学建模竞赛（中文赛项）',
    price: PRICES.apmcm,
    startAt: cn('2026-06-12T18:00:00+08:00'),
    endAt: cn('2026-06-15T20:00:00+08:00'),
    regDeadline: null,
    url: 'https://www.apmcm.org/',
    regUrl: 'https://m.saikr.com/apmcm26',
    note: '2026 届已结束；英文/中文赛项分设，以官网公告为准',
    tier: 'main',
    next: '2027 届时间待官方公布（往年 6 月中旬）',
  },
  {
    id: 'mathorcup',
    name: 'MathorCup',
    fullName: 'MathorCup 高校数学建模挑战赛',
    price: PRICES.mathorcup,
    startAt: cn('2026-04-17T08:00:00+08:00'),
    endAt: cn('2026-04-21T09:00:00+08:00'),
    regDeadline: cn('2026-04-16T12:00:00+08:00'),
    url: 'https://www.mathorcup.org/',
    note: '2026 届已结束',
    tier: 'small',
    next: '2027 届时间待官方公布',
  },
  {
    id: 'others',
    name: '其他小赛',
    fullName: '华中杯 / 华数杯 / 五一赛 / 研究生联赛等',
    price: PRICES.others,
    startAt: null,
    endAt: null,
    regDeadline: null,
    url: 'https://www.cmathc.org.cn/mcm/',
    note: '统一 ¥29 档。各赛事时间以官网为准；2026 年「深圳杯」官方已宣布暂停举办',
    tier: 'small',
    next: '各赛事时间以官网公告为准',
  },
];

/**
 * 推导状态。
 *   tba    —— 官方未公布 / 无时间数据
 *   open   —— 报名中（未开赛）
 *   live   —— 进行中
 *   ended  —— 已结束
 */
function statusOf(c, now = Date.now()) {
  if (!c.startAt || !c.endAt) return 'tba';
  if (now >= c.startAt && now < c.endAt) return 'live';
  if (now >= c.endAt) return 'ended';
  return 'open';
}

const STATUS_TEXT = {
  tba: '待公布',
  open: '报名中',
  live: '进行中',
  ended: '已结束',
};

/**
 * 列出全部赛事（带状态与倒计时）。
 * countdownMs：距开赛毫秒（>0）；已开赛或已结束为 0。
 */
function list(now = Date.now()) {
  return COMPETITIONS.map((c) => {
    const status = statusOf(c, now);
    const countdownMs = c.startAt && c.startAt > now ? c.startAt - now : 0;
    return {
      ...c,
      status,
      statusText: STATUS_TEXT[status],
      countdownMs,
      live: status === 'live',
      current: status === 'live' || status === 'open',
      // 下一场未开赛且有明确时间的（用来挑"默认当前赛事"）
      upcoming: status === 'open',
    };
  });
}

/** 最近一场"报名中"的赛事 id；没有则 null（用于默认当前赛事） */
function defaultCurrent(now = Date.now()) {
  const up = list(now)
    .filter((c) => c.upcoming && c.startAt)
    .sort((a, b) => a.startAt - b.startAt);
  return up.length ? up[0].id : null;
}

function get(id) {
  return COMPETITIONS.find((c) => c.id === id) || null;
}

/** 解锁判断：凭证 competition 是否覆盖赛事 id */
function unlocks(competition, id) {
  if (!competition || competition === 'all') return true;
  return competition === id;
}

module.exports = {
  PRICES,
  COMPETITIONS,
  STATUS_TEXT,
  statusOf,
  list,
  get,
  defaultCurrent,
  unlocks,
  HOUR,
};
