/*
 * ⚠️ 自动生成，请勿手改 —— 由 scripts/sync-issuer-app.js 从 competitions.js 同步。
 * 改这里会在下次同步时被覆盖，且 npm test 的「签发器应用同源」守卫会报漂移。
 */
'use strict';

/**
 * 赛事数据 + 时长档位价目表。
 *
 * ⚠️ 2026-10 起，授权口径从「按赛事解锁」改为「按时长解锁」：
 *   卡密只带 plan（week / month / year / forever）与 expireAt，
 *   **不再带 competition 字段**。赛事数据现在只服务两件事 ——
 *   ① 系统提示词里的「当前赛事」成稿口径与 AI 声明措辞；
 *   ② 比赛时间的展示（若将来重新做日历）。
 *   它与授权、与价格**已经解耦**，改赛事时间不影响任何一张已售出的卡。
 *
 * 时间来源（2026-10-08 联网核实）：
 *   - 国赛：mcm.edu.cn 首页 —— 2026-09-10 18:00 发布赛题，云南赛区通知
 *     载明 09-10 18:00 → 09-13 20:00
 *   - 华为杯：研究生数学建模竞赛开赛公告（2026-09-16）——
 *     09-23 08:00 → 09-27 12:00
 *   - 亚太赛：APMCM 中文赛项题目发布 —— 06-12 18:00 → 06-15 20:00
 *   - 数维杯：nmmcm.org.cn《关于大赛》—— 报名截止 11-20 06:00，
 *     11-20 09:00 → 11-24 09:00，论文 11-24 10:00 截止
 *   - MathorCup 数学建模：mathorcup.org —— 04-17 08:00 → 04-21 09:00
 *   - MathorCup 大数据：报名通知（2026-08-20）—— 报名截止 10-23 12:00，
 *     初赛 10-23 18:00 → 10-30 20:00（7 天），复赛 12-04 18:00 → 12-11 20:00
 *   - 华数杯：赛氪赛题发布 —— 08-07 18:00 → 08-10 20:00
 *   - 华数杯国际：赛氪赛题发布 —— 2026-01-17 06:00 → 01-21 09:00
 *   - 美赛 2027：官方未公布 → tba
 */

const HOUR = 3600 * 1000;

// ===========================================================================
// 时长档位（授权与定价的唯一真源）
// ===========================================================================
//
// 为什么改成时长制：按赛事解锁有两个绕不开的麻烦 ——
//   ① 用户买了国赛卡，想顺手做一道华为杯题就被拦住，体验上像"坏了"；
//   ② 赛事日历一改（加新赛事、改时间），门禁判断就得跟着改，
//      而时间是会漂移的，授权逻辑不该依赖它。
// 时长制下「买了就能用所有功能」，到期自然续费，两边都简单。
//
// ⚠️ days 是**签发时**写进凭证的 expireAt 的依据，改它只影响新签的卡，
//    已售出的卡以自己 payload 里的 expireAt 为准，不会失效。
//
// 永久买断（forever）没有 days，expireAt 用 PERPETUAL_MS 哨兵值 ——
// 一个足够远的真实时间戳（2099-01-01）。为什么不加 perpetual 布尔位让
// verifyCredential 跳过过期判断：那要改验签逻辑，而验签是整条授权链的
// 地基，为一种档位去动它不值得。哨兵值走完全相同的代码路径，
// 且 payload 里另有 perpetual: true 供界面显示「永久」。

/** 永久买断的 expireAt 哨兵：2099-01-01 UTC。足够远，且是合法 JSON 数字 */
const PERPETUAL_MS = Date.UTC(2099, 0, 1);

/** 档位表（元，人民币）—— 商业决策，改前三思 */
const PLANS = {
  week:    { label: '周卡',   days: 7,   price: 29 },
  month:   { label: '月卡',   days: 30,  price: 59 },
  year:    { label: '年卡',   days: 365, price: 99 },
  forever: { label: '永久买断', days: null, price: 199, perpetual: true },
};

/** 档位 → 展示用时长文案（永久卡没有天数） */
function planDaysText(id) {
  const p = PLANS[id];
  if (!p) return '';
  return p.perpetual ? '永久' : `${p.days} 天`;
}

/** 把档位 id 归一化；不合法就抛错（调用方转成用户可见文案） */
function normalizePlan(s) {
  const id = String(s == null ? '' : s).toLowerCase();
  if (!PLANS[id]) {
    throw new Error(`--plan 应为：${Object.keys(PLANS).join(' / ')}（收到 "${s}"）`);
  }
  return id;
}

/** 老卡（只有 competition、没有 plan）→ 按时长制兼容成年卡 */
function planOf(payload) {
  const p = String((payload && payload.plan) || '').toLowerCase();
  if (PLANS[p]) return p;
  return 'year';
}

/** 这个档位是不是永久买断（界面据此显示「永久」而不是日期） */
function isPerpetual(payload) {
  const p = planOf(payload);
  return !!PLANS[p].perpetual;
}

// ===========================================================================
// 赛事数据（只服务提示词与展示，**不参与授权**）
// ===========================================================================

/** 解析中国时间（+08:00）为 UTC 毫秒；解析失败返回 null */
function cn(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * 赛事清单。字段：
 *   id           稳定标识（也是凭证 competition 字段的取值）
 *   name         短名（面板显示）
 *   fullName     全称（详情/文档）
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
    id: 'bigdata',
    name: 'MathorCup 大数据赛',
    fullName: 'MathorCup 数学应用挑战赛 — 大数据竞赛（第七届）',
    startAt: cn('2026-10-23T18:00:00+08:00'),
    endAt: cn('2026-10-30T20:00:00+08:00'),
    regDeadline: cn('2026-10-23T12:00:00+08:00'),
    url: 'http://www.mathorcup.org',
    regUrl: 'https://m.saikr.com/bigdata2026',
    fee: 200,
    note: '7 天赛（10-23 → 10-30）；需提交论文 + 结果数据集 + 源程序。'
      + '初赛前 10% 进复赛（12-04 18:00 → 12-11 20:00）',
    tier: 'main',
  },
  {
    id: 'huashu',
    name: '华数杯',
    fullName: '华数杯大学生数学建模竞赛（第七届）',
    startAt: cn('2026-08-07T18:00:00+08:00'),
    endAt: cn('2026-08-10T20:00:00+08:00'),
    regDeadline: null,
    url: 'https://m.saikr.com/chinamcm26',
    fee: null,
    note: '2026 届已结束（常被称为国赛热身赛）；2027 届时间待官方公布',
    tier: 'main',
    next: '2027 届时间待官方公布（往年 8 月上旬）',
  },
  {
    id: 'huashu_intl',
    name: '华数杯国际赛',
    fullName: '华数杯国际大学生数学建模竞赛（第四届）',
    startAt: cn('2026-01-17T06:00:00+08:00'),
    endAt: cn('2026-01-21T09:00:00+08:00'),
    regDeadline: null,
    url: 'https://m.saikr.com/mcmicm2026',
    fee: null,
    note: '英文论文，4 天赛；常作为美赛选拔赛/热身。2026 届已结束，2027 届时间待公布',
    tier: 'main',
    next: '2027 届时间待官方公布（往年 1 月中旬）',
  },
  {
    id: 'mathorcup',
    name: 'MathorCup',
    fullName: 'MathorCup 高校数学建模挑战赛',
    startAt: cn('2026-04-17T08:00:00+08:00'),
    endAt: cn('2026-04-21T09:00:00+08:00'),
    regDeadline: cn('2026-04-16T12:00:00+08:00'),
    url: 'https://www.mathorcup.org/',
    note: '2026 届已结束。⚠️ 这是数学建模赛项；大数据赛项是另一场（见 bigdata）',
    tier: 'small',
    next: '2027 届时间待官方公布',
  },
  {
    id: 'others',
    name: '其他小赛',
    fullName: '华中杯 / 华数杯 / 五一赛 / 研究生联赛等',
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

// ===========================================================================
// 邀请码
// ===========================================================================
//
// 设计：**邀请码 = 卡号后 6 位数字**（`MCM-2026-0005` → `260005`）。
//
// 为什么不搞本地自动计数：应用是纯离线的，本地记录朋友用了谁的码，
// 用户删掉 license.json 或改个 JSON 就重置了 —— 那个"满 3 人送一期"
// 等于没有。所以软件**只负责展示邀请码**，减价与送卡都由卖家在微信里
// 人工完成（用 tools/issue.js invite 记账，满 3 会自动提醒）。
//
// 邀请码是"谁推荐的"的标识，不是凭证：它没有签名，猜到了也没用 ——
// 减价要卖家确认，送卡更是卖家发。

/** 从卡号派生邀请码：取末尾 6 位数字。派不出来返回 null。 */
function inviteCodeFromCard(card) {
  const digits = String(card || '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(-6);
}

/** 邀请规则（展示给用户看，也供卖家口径对齐） */
const INVITE_RULES = {
  friendDiscount: 5,      // 朋友购买立减（元）
  threshold: 3,           // 满几人送一期
  reward: '一期比赛的使用权',
};

module.exports = {
  PLANS,
  PERPETUAL_MS,
  normalizePlan,
  planDaysText,
  isPerpetual,
  planOf,
  COMPETITIONS,
  STATUS_TEXT,
  INVITE_RULES,
  statusOf,
  list,
  get,
  defaultCurrent,
  inviteCodeFromCard,
  HOUR,
};
