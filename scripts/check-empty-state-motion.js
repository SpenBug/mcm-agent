#!/usr/bin/env node
'use strict';

/**
 * 首屏空态动效守卫。
 *
 * 防的是五类**肉眼看不出来、但一定会在某个时刻炸**的事：
 *
 *  ① 动效碰了会触发重排的属性（width / top / margin…）
 *     机器人 SVG 有几十个节点，一旦逐帧重排整块首屏掉帧。首屏是宣传截图的
 *     素材源，掉帧的动效会被写进 GIF/视频素材里，代价对外可见。
 *
 *  ② 加了 animation 却忘了 prefers-reduced-motion 降级
 *     系统开着"减少动态效果"的用户会一直看动画，且拿不到静止终态。
 *
 *  ③ 动画终值 ≠ 元素静态样式值 ← 本轮最真实的风险
 *     花字引子 opacity 静态 .20 / 大字 .82 / 包袱 .72，关键帧终点必须写死成
 *     各自的原值；写错（或统一写 1）动画结束后视觉就永久偏了 ——
 *     fill:both 的终值会一直压着静态声明。宣传截图取的正是这个终态。
 *     反过来"越动越歪"也是同一件事：包袱静态 rotate(-3deg)，终值必须仍是它。
 *
 *  ④ 被 CSS 动画的 SVG 节点带着 transform="…" 呈现属性
 *     CSS transform 会**覆盖** SVG 的 transform 属性（不是叠加），
 *     机器人举着的那张图会被甩飞。所以漂浮只能挂在没有 transform 属性的
 *     包装 <g class="bot-float"> 上。
 *
 *  ⑤ 描线三件套缺一件：dashoffset 动画 ↔ dasharray 声明 ↔ pathLength ↔ 降级关虚线
 *     只关 animation 不关 stroke-dasharray，折线会整条消失。
 *
 * 另外钉住三个"文档写了就得算得出"的事实：柱子根数 = 延迟规则数、
 * 入场总时长不超过注释里声明的上限、CSS 注释点名的守卫就是本文件且真挂了 npm test。
 *
 * 用法：
 *   node scripts/check-empty-state-motion.js             # 校验真实文件
 *   node scripts/check-empty-state-motion.js --self-test # 反向验证：故意注入违规，确认每条都会红
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS_REL = 'src/renderer/styles.css';
const JS_REL = 'src/renderer/app.js';

/* 允许被动画改动的属性白名单：合成器友好（不触发 layout / paint） */
const ALLOWED_KEYFRAME_PROPS = new Set(['transform', 'opacity', 'stroke-dashoffset', 'stroke-dasharray']);
/* 入场动画总时长上限（delay + duration，秒）。CSS 注释写了"压在 1.9s 内"就得验得住 */
const ENTRANCE_CAP_S = 1.9;

/* ============ 基础解析 ============ */

/** 注释替换成等长空格：**保留所有字符偏移**。
 *  否则按 cssRaw 算出的区域边界去切"已去注释"的文本会整体错位（首版实测踩过）。 */
function blankComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** 扫描 CSS，返回规则与 @keyframes（带绝对偏移 + 所属 @media 条件） */
function scanCss(text, base = 0) {
  const rules = [];
  const keyframes = [];
  let i = 0;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) break;
    const head = norm(text.slice(i, brace));
    let depth = 1;
    let j = brace + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const bodyStart = brace + 1;
    const body = text.slice(bodyStart, Math.max(bodyStart, j - 1));
    if (/^@keyframes\b/.test(head)) {
      keyframes.push({ name: head.replace(/^@keyframes\s+/, ''), body, start: base + i, media: '' });
    } else if (/^@/.test(head)) {
      // @media / @supports：递归取内层，把外层条件与真实偏移一起带上
      const inner = scanCss(body, base + bodyStart);
      for (const r of inner.rules) rules.push({ ...r, media: head });
      for (const k of inner.keyframes) keyframes.push({ ...k, media: head });
    } else if (head) {
      rules.push({ selector: head, body, start: base + i, media: '' });
    }
    i = j;
  }
  return { rules, keyframes };
}

/** 声明块拆成 [属性, 值] */
function decls(body) {
  const out = [];
  for (const part of String(body).split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const p = norm(part.slice(0, idx));
    if (p && !p.startsWith('@')) out.push([p.toLowerCase(), norm(part.slice(idx + 1))]);
  }
  return out;
}

/** 取规则里某个属性的最后一个值；没有则 null */
function decl(body, prop) {
  let v = null;
  for (const [p, val] of decls(body)) if (p === prop) v = val;
  return v;
}

/** 关键帧终值帧：优先 100% / to，缺失回退最后一帧 */
function finalFrame(kfBody) {
  const frames = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(kfBody))) frames.push([norm(m[1]), m[2]]);
  if (!frames.length) return null;
  const pick = frames.find(([sel]) => /(^|[,\s])(100%|to)(?=[,\s]|$)/.test(` ${sel} `));
  return (pick || frames[frames.length - 1])[1];
}

/** 关键帧里出现过的函数名（判断动画对 transform-origin 敏不敏感） */
const kfFunctions = (kfBody) => [...String(kfBody).matchAll(/\b([a-zA-Z]+)\s*\(/g)].map((m) => m[1].toLowerCase());

/** '.68s' / '680ms' → 秒 */
function toSeconds(v) {
  if (v == null) return 0;
  const m = /(\d*\.?\d+)(m?s)/.exec(String(v));
  if (!m) return 0;
  return m[2] === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
}
/** 简写里第 1 个时间 = duration，第 2 个 = delay */
function timingFromShorthand(v) {
  const times = [...String(v).matchAll(/(\d*\.?\d+m?s)/g)].map((m) => toSeconds(m[0]));
  return { duration: times[0] || 0, delay: times[1] || 0 };
}

/** transform 恒等式归一：translateY(0)/rotate(0)/scaleY(1)/… ≡ none */
function normalizeTransform(v) {
  if (v == null) return 'none';
  let s = norm(v).toLowerCase().replace(/\s+/g, '');
  s = s
    .replace(/translate[xyz]?\((0(?:px|em|rem|%)?)\)/g, '')
    .replace(/translate\((0(?:px|em|rem|%)?)?,?(0(?:px|em|rem|%)?)?\)/g, '')
    .replace(/rotate[z]?\((0(?:deg|grad|rad|turn)?)\)/g, '')
    .replace(/scale[x y z]?\((?:1(?:\.0+)?)\)/g, '')
    .replace(/scale\((?:1(?:\.0+)?)(?:,?1(?:\.0+)?)?\)/g, '')
    .replace(/matrix\(1,0,0,1,0,0\)/g, '');
  s = s.replace(/,{2,}/g, ',').replace(/^,|,$/g, '').trim();
  return s === '' || s === 'none' ? 'none' : s;
}

/** 解析 animation 简写（支持逗号分隔多条） */
function parseAnims(value) {
  const out = [];
  for (const one of norm(value).split(',')) {
    if (!one || /^(none|inherit|initial|unset)$/.test(one)) continue;
    const tokens = one.split(/\s+/);
    const name = tokens.find((t) => (
      !/^[\d.]+m?s$/.test(t)
      && !/^(both|forwards|backwards|none|linear|ease[a-z-]*|infinite|alternate(?:[-\w]*)?|reverse|normal|paused|running)$/.test(t)
      && !/^[a-z-]+\(/i.test(t)
    )) || '';
    const sh = timingFromShorthand(one);
    out.push({
      name,
      duration: sh.duration,
      delay: sh.delay,
      infinite: /\binfinite\b/.test(one),
      fill: /\b(both|forwards)\b/.test(one),
    });
  }
  return out;
}

/* ============ 上下文 ============ */

function buildCtx(cssRaw, jsRaw) {
  const css = blankComments(cssRaw);          // 偏移与 cssRaw 完全一致
  const { rules, keyframes } = scanCss(css);
  const kfMap = new Map(keyframes.map((k) => [k.name, k]));

  const REDUCE = /prefers-reduced-motion/;
  /* 动效块边界：靠首屏动效自己的横幅注释定位 */
  const mStart = cssRaw.indexOf('/* ============ 空态动效');
  const mEnd = cssRaw.indexOf('/* ---- 品牌区');
  const region = mStart >= 0 && mEnd > mStart ? [mStart, mEnd] : null;
  const inRegion = (start) => !!(region && start >= region[0] && start <= region[1]);

  /* 声明了 animation 的规则（只看动效块内，排除降级块里的 animation:none） */
  const animated = [];
  for (const r of rules) {
    if (r.media || !inRegion(r.start)) continue;
    for (const a of parseAnims(decl(r.body, 'animation') || decl(r.body, 'animation-name') || '')) {
      if (!a.name) continue;
      const d = decl(r.body, 'animation-delay');
      animated.push({ ...a, selector: r.selector, start: r.start, delay: d != null ? toSeconds(d) : a.delay });
    }
  }

  /* 降级块：animation:none 覆盖到的选择器 + 是否关了虚线 */
  const reducedSelectors = new Set();
  let reducedDasharrayNone = false;
  for (const r of rules) {
    if (!r.media || !REDUCE.test(r.media)) continue;
    if (/animation:\s*none/i.test(r.body)) {
      for (const s of r.selector.split(',')) reducedSelectors.add(norm(s));
    }
    if (/stroke-dasharray:\s*none/i.test(r.body)) reducedDasharrayNone = true;
  }

  /** 某个选择器的**静态**声明值：合并动效块外、@media 外的同名规则，同属性取最后一条真写了它的。
   *  ⚠️ 不能只取"最后一条匹配规则" —— 窄屏 @media 覆盖通常只改 font-size，
   *  那样取会把 opacity / transform 当成没写（首版实测误报 5 条）。 */
  function staticValue(selector, prop) {
    let v = null;
    for (const r of rules) {
      if (r.selector !== selector || r.media || inRegion(r.start)) continue;
      const x = decl(r.body, prop);
      if (x != null) v = x;
    }
    return v;
  }

  return {
    css, cssRaw, rules, keyframes, kfMap, region, inRegion,
    animated, reducedSelectors, reducedDasharrayNone, staticValue, jsRaw,
  };
}

/** 选择器里的 class 名（.a.b → ['a','b']） */
const classesOf = (sel) => [...String(sel).matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);

/* ============ 各项检查 ============ */

/* ① 合成器友好属性 + 动效块内禁用 transition */
function checkCompositorSafe(ctx) {
  const out = [];
  for (const kf of ctx.keyframes.filter((k) => ctx.inRegion(k.start))) {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(kf.body))) {
      for (const [prop] of decls(m[2])) {
        if (!ALLOWED_KEYFRAME_PROPS.has(prop)) {
          out.push(`@keyframes ${kf.name} 动了「${prop}」—— 只允许 ${[...ALLOWED_KEYFRAME_PROPS].join('/')}，`
            + `其余属性会逐帧触发重排（首屏整块掉帧，宣传素材里看得见）`);
        }
      }
    }
  }
  for (const r of ctx.rules) {
    if (r.media || !ctx.inRegion(r.start)) continue;
    if (decl(r.body, 'transition')) {
      out.push(`「${r.selector}」在动效块里用了 transition —— 入场统一走 animation，别两套机制混用`);
    }
  }
  return out;
}

/* ② 每条 animation 都必须有降级 */
function checkReducedMotion(ctx) {
  const out = [];
  for (const a of ctx.animated) {
    if (!ctx.reducedSelectors.has(a.selector)) {
      out.push(`「${a.selector}」有 animation: ${a.name}，但 prefers-reduced-motion 降级里没有它 `
        + `→ 系统关掉动效的用户会一直看动画，且拿不到静止终态`);
    }
  }
  return out;
}

/* ③ 终值 = 静态值（缺字 / 半透明 / 越动越歪的根因） */
function checkFinalEqualsStatic(ctx) {
  const out = [];
  for (const a of ctx.animated) {
    const kf = ctx.kfMap.get(a.name);
    if (!kf) { out.push(`「${a.selector}」引用了不存在的 @keyframes ${a.name}`); continue; }
    const fin = finalFrame(kf.body);
    if (!fin) continue;
    for (const prop of ['opacity', 'transform']) {
      const want = decl(fin, prop);
      if (want == null) continue;
      const have = ctx.staticValue(a.selector, prop);
      const wantN = prop === 'transform' ? normalizeTransform(want) : norm(want);
      const haveN = prop === 'transform' ? normalizeTransform(have) : norm(have == null ? '1' : have);
      if (wantN !== haveN) {
        out.push(`「${a.selector}」动画终值 ${prop}: ${wantN}，静态样式却是 ${prop}: ${haveN}。`
          + `fill:both 会让终值永久压住静态声明 —— 动画结束后视觉就和设计稿不一致（截图正是取这一态）`);
      }
    }
  }
  return out;
}

/* ⑤a 描线三件套：dashoffset 动画 ↔ dasharray 声明 ↔ 降级关虚线 */
function checkStrokeDraw(ctx) {
  const out = [];
  for (const a of ctx.animated) {
    const kf = ctx.kfMap.get(a.name);
    if (!kf || !/stroke-dashoffset/.test(kf.body)) continue;
    const rule = ctx.rules.find((r) => r.selector === a.selector && ctx.inRegion(r.start));
    if (!rule) continue;
    const da = decl(rule.body, 'stroke-dasharray');
    if (!da) {
      out.push(`「${a.selector}」靠 stroke-dashoffset 做描线，却没声明 stroke-dasharray —— 没有虚线可偏移，线整个不出现`);
    } else if (da !== 'none' && !ctx.reducedDasharrayNone) {
      out.push(`描线动画写了 stroke-dasharray: ${da}，但 prefers-reduced-motion 降级里缺 \`stroke-dasharray: none\` —— `
        + `只关 animation 不关虚线，折线会整条消失（这类降级最常见的错）`);
    }
  }
  return out;
}

/* ⑤b 描线的 <path> 必须有 pathLength（CSS 才能写死 1 1 而不猜像素长度） */
function checkPathLength(ctx) {
  const out = [];
  const drawClasses = new Set();
  for (const a of ctx.animated) {
    const kf = ctx.kfMap.get(a.name);
    if (kf && /stroke-dashoffset/.test(kf.body)) for (const c of classesOf(a.selector)) drawClasses.add(c);
  }
  if (!drawClasses.size) return out;
  for (const tag of (ctx.jsRaw || '').match(/<(path|polyline)\b[^>]*/gi) || []) {
    const cls = /class="([^"]*)"/.exec(tag);
    if (!cls) continue;
    if (!cls[1].split(/\s+/).some((c) => drawClasses.has(c))) continue;
    if (!/pathLength\s*=/i.test(tag)) {
      out.push(`描线用的 <path class="${cls[1]}"> 没有 pathLength —— `
        + `CSS 里的 dasharray 就得写死真实像素长度，改一次形状就得重猜一个数`);
    }
  }
  return out;
}

/* ④ SVG transform 属性冲突 + 包装层 + 变换基准 */
function checkSvgTransformAttr(ctx) {
  const out = [];
  const js = ctx.jsRaw || '';
  const botSvg = /const SVG_BOT\s*=\s*`([\s\S]*?)`;/.exec(js);
  if (!botSvg) return ['app.js 里找不到 SVG_BOT 模板（改名或挪走了？守卫需同步，否则这块检查在空转）'];
  const svg = botSvg[1];

  const animatedClasses = new Set();
  for (const a of ctx.animated) for (const c of classesOf(a.selector)) animatedClasses.add(c);

  /* CSS transform 覆盖 SVG transform 属性，不是叠加 */
  for (const tag of svg.match(/<(g|path|circle|rect|ellipse|line|polygon|use)\b[^>]*>/gi) || []) {
    const cls = /class="([^"]*)"/.exec(tag);
    if (!cls || !/\btransform\s*=/.test(tag)) continue;
    const hit = cls[1].split(/\s+/).find((n) => animatedClasses.has(n));
    if (hit) {
      out.push(`SVG 节点 class="${cls[1]}" 带 transform 呈现属性，又被 .${hit} 的 CSS 动画命中 —— `
        + `CSS transform 是**覆盖**不是叠加，该节点原定位会整个失效（机器人举的图会被甩飞）。`
        + `改法：给它外面套一层不带 transform 属性的 <g>，动画挂包装层`);
    }
  }

  /* 漂浮必须是包着本体的、自身无属性的包装 g */
  const open = /<g\b[^>]*class="[^"]*\bbot-float\b[^"]*"[^>]*>/i.exec(svg);
  if (!open) out.push('SVG_BOT 里没有 <g class="bot-float"> 包装层 —— 漂浮只能挂它，挂子节点会撞 transform 属性');
  else if (/\btransform\s*=/.test(open[0])) out.push('<g class="bot-float"> 自己带了 transform 属性 —— 它必须是无属性的纯包装层');
  else {
    const closeIdx = svg.indexOf('</g><!-- /bot-float');
    if (closeIdx < 0) out.push('bot-float 包装层缺 </g><!-- /bot-float --> 收尾（配对标记，也用来定位检查区间）');
    else if (!/<g\b[^>]*\btransform\s*=\s*"translate\(/i.test(svg.slice(open.index, closeIdx))) {
      out.push('bot-float 区间内没有带 transform="translate(…)" 的举图分组 —— '
        + '若手臂/图卡被重构，请确认漂浮仍只动外层（这条检查依赖那个包装 <g> 存在）');
    }
  }

  /* 对 transform-origin 敏感的循环动画（scale/rotate/skew）必须 fill-box；纯位移不受基准影响 */
  for (const a of ctx.animated) {
    if (!a.infinite) continue;
    const kf = ctx.kfMap.get(a.name);
    if (!kf) continue;
    const sensitive = kfFunctions(kf.body).some((f) => /^(scale|rotate|skew)/.test(f));
    if (!sensitive) continue;
    if (!classesOf(a.selector).some((c) => new RegExp(`class="[^"]*\\b${c}\\b`).test(svg))) continue;
    const rule = ctx.rules.find((r) => r.selector === a.selector && ctx.inRegion(r.start));
    if (!/fill-box/.test(decl(rule.body, 'transform-box') || '')) {
      out.push(`「${a.selector}」是循环微动且动 scale/rotate，却没写 transform-box: fill-box —— `
        + `SVG 元素的 transform-origin 默认不是自身中心，scale 会把它甩出画面`);
    }
  }
  return out;
}

/* ⑥ 柱子根数 = 延迟规则数，且柱子动画不得动 opacity */
function checkBarCount(ctx) {
  const out = [];
  const barSvg = /const SVG_BAR\s*=\s*`([\s\S]*?)`;/.exec(ctx.jsRaw || '');
  if (!barSvg) return ['app.js 里找不到 SVG_BAR 模板（改名或挪走了？守卫需同步）'];
  const rects = [...barSvg[1].matchAll(/<rect\b[^>]*\bclass="([^"]*)"[^>]*>/g)]
    .map((m) => m[1].split(/\s+/).find((c) => /^b\d+$/.test(c)))
    .filter(Boolean);
  const delayRules = new Set();
  for (const r of ctx.rules) {
    const m = /^\.bar\.(b\d+)$/.exec(r.selector);
    if (m && decl(r.body, 'animation-delay')) delayRules.add(m[1]);
  }
  for (const c of rects) {
    if (!delayRules.has(c)) out.push(`SVG 里有柱子 .${c}，CSS 却没有 .bar.${c} 延迟规则 → 这根不参与错位，会跟别人同时跳`);
  }
  for (const d of delayRules) {
    if (!rects.includes(d)) out.push(`CSS 有 .bar.${d} 延迟规则，SVG 里却没这根柱子 → 规则写给了不存在的元素`);
  }
  /* 双色对比靠 <rect opacity=".55">；柱子动画一旦写 opacity 会覆盖它，把分组抹平成同色 */
  const softRects = [...barSvg[1].matchAll(/<rect\b[^>]*\bopacity="\.?\d+"/g)].length;
  for (const a of ctx.animated) {
    const kf = ctx.kfMap.get(a.name);
    if (!kf || !classesOf(a.selector).includes('bar')) continue;
    if (/opacity/.test(kf.body)) {
      out.push(`@keyframes ${a.name} 给柱子动了 opacity —— SVG 里有 ${softRects} 根柱子靠呈现属性 opacity=".55" 做双色对比，`
        + `CSS 动画会覆盖它（fill:both 后还常驻终值），分组对比被抹平成同色。柱子只动 transform 就够（scaleY(0) 本身即看不见）`);
    }
  }
  return out;
}

/* ⑦ 入场总时长不超过注释声明的上限 */
function checkEntranceBudget(ctx) {
  const out = [];
  for (const a of ctx.animated) {
    if (a.infinite) continue;
    const total = a.delay + a.duration;
    if (total > ENTRANCE_CAP_S) {
      out.push(`「${a.selector}」入场 ${a.delay}s + ${a.duration}s = ${total.toFixed(2)}s，超过上限 ${ENTRANCE_CAP_S}s `
        + `（styles.css 动效块注释声明的预算）—— 首屏是打开就看到的，超过 2s 会被读成"卡住了"`);
    }
  }
  return out;
}

/* ⑧ 死指针 / 未挂载 */
function checkDeadPointers(ctx) {
  const out = [];
  const mine = path.basename(__filename);
  const refs = [...ctx.cssRaw.matchAll(/scripts\/([a-z0-9-]+\.js)/g)].map((m) => m[1]);
  if (refs.length && !refs.includes(mine)) {
    out.push(`styles.css 注释点名了 ${refs.join(', ')}，实际运行的守卫是 ${mine} —— 注释里的路径指不到东西`);
  }
  const suite = path.join(ROOT, 'scripts', 'run-all-tests.js');
  if (fs.existsSync(suite) && !fs.readFileSync(suite, 'utf8').includes(mine)) {
    out.push(`${mine} 没挂进 run-all-tests.js 的 SUITES → npm test 永远不会跑它，等于没有守卫`);
  }
  const sop = path.join(ROOT, 'docs', 'SOP-开发与发版.md');
  if (fs.existsSync(sop) && !fs.readFileSync(sop, 'utf8').includes(mine)) {
    out.push(`${mine} 没写进 SOP 第四节守卫清单 → 下一个人不知道该守什么`);
  }
  return out;
}

const CHECKS = [
  ['① 合成器友好属性', checkCompositorSafe],
  ['② 减少动态效果降级', checkReducedMotion],
  ['③ 终值 = 静态值', checkFinalEqualsStatic],
  ['④ SVG transform 属性冲突/包装层', checkSvgTransformAttr],
  ['⑤a 描线三件套', checkStrokeDraw],
  ['⑤b pathLength', checkPathLength],
  ['⑥ 柱子数量与双色对比', checkBarCount],
  ['⑦ 入场时长上限', checkEntranceBudget],
  ['⑧ 死指针/挂载', checkDeadPointers],
];

function runChecks(cssRaw, jsRaw) {
  const ctx = buildCtx(cssRaw, jsRaw);
  const results = [];
  for (const [label, fn] of CHECKS) {
    let issues;
    try { issues = fn(ctx); }
    catch (e) { issues = [`检查自身抛错（解析器没跟上改动，需要更新守卫，别让它静默空转）：${e.message}`]; }
    results.push({ label, issues });
  }
  return { ctx, results };
}

/* ============ 反向验证 ============ */

/**
 * 每条检查造一个"故意违规"的最小样本，确认它会红。
 * 为什么自带：守卫只在"通过"时有存在感，写错了没人知道它其实一直空转
 * —— 本仓库真发生过（抽图块正则被 CRLF 打得静默跳过，显示通过但一条都没查）。
 * 本守卫首版运行时自己误报 5 条、且漏掉了 CSS 里一处真实的预算超标，就是靠这套自检暴露的。
 */
function selfTest() {
  const realCss = fs.readFileSync(path.join(ROOT, CSS_REL), 'utf8');
  const realJs = fs.readFileSync(path.join(ROOT, JS_REL), 'utf8');

  const cases = [
    { tag: '①', why: '关键帧动 margin', css: (c) => c.replace('@keyframes esRise {', '@keyframes esRise {\n  50% { margin-top: 4px; }') },
    /* ⚠️ 只改动画那条规则的选择器，**不要**同步改降级列表 ——
       上一版这里两处一起改名，等于把违规自己抹平了，检查当然不会红
       （看起来"检查空转"，实际是用例失效。用例必须只破坏一处）。 */
    { tag: '②', why: '有 animation 但降级列表里没有它', css: (c) => c
      .replace('.es-brand  { animation: esRise', '.es-brand-orphan { animation: esRise') },
    { tag: '③', why: '大字终值写 opacity:1（静态 .82）', css: (c) => c.replace(
      /@keyframes esHeroIn \{[\s\S]*?\n\}/,
      '@keyframes esHeroIn {\n  from { opacity: 0; transform: translateY(13px) scale(.97); }\n  to   { opacity: 1; transform: none; }\n}',
    ) },
    { tag: '③', why: '包袱终值 rotate(-8deg)：越动越歪', css: (c) => c.replace(
      '100% { opacity: .72; transform: rotate(-3deg); }',
      '100% { opacity: .72; transform: rotate(-8deg); }',
    ) },
    { tag: '④', why: '给 bot-float 包装层加 transform 属性', js: (j) => j.replace(
      '<g class="bot-float">', '<g class="bot-float" transform="translate(0,2)">',
    ) },
    { tag: '④', why: '循环缩放动画缺 transform-box: fill-box', css: (c) => c.replace(
      '.bot-bulb              { transform-box: fill-box; transform-origin: center;',
      '.bot-bulb              { transform-origin: center;',
    ) },
    { tag: '⑤a', why: '删掉 stroke-dasharray 声明', css: (c) => c.replace('.lc-line { stroke-dasharray: 1 1;', '.lc-line {') },
    { tag: '⑤a', why: '降级只关 animation 不关虚线', css: (c) => c.replace('  .lc-line { stroke-dasharray: none; }\n', '') },
    { tag: '⑤b', why: '去掉 pathLength="1"', js: (j) => j.replace('pathLength="1" ', '') },
    { tag: '⑥', why: '柱子少一条延迟规则', css: (c) => c.replace('.bar.b8 { animation-delay: 1.04s; }', '') },
    { tag: '⑥', why: '柱子动画动 opacity', css: (c) => c.replace(
      /@keyframes esGrowBar \{[\s\S]*?\n\}/,
      '@keyframes esGrowBar {\n  from { opacity: 0; transform: scaleY(0); }\n  to   { opacity: 1; transform: scaleY(1); }\n}',
    ) },
    /* ⚠️ 用例的匹配串来自当前真实文本。上一版这里写的是 'animation-delay: 1.08s;'
       （调整预算时改成了 1.15s），replace 没命中、文本原样返回 —— 于是"注入违规"
       其实注入的是真实文件本身。下面那句"用例没改成任何东西"就是防这种假绿的。 */
    { tag: '⑦', why: '包袱延迟拉到 2.5s', css: (c) => c.replace('animation: esFearIn .72s', 'animation: esFearIn 2.5s') },
    { tag: '⑧', why: 'CSS 注释指到别的守卫文件名', css: (c) => c.replace(/scripts\/check-empty-state-motion\.js/g, 'scripts/ghost-guard.js') },
  ];

  let bad = 0;
  console.log('=== 守卫自检：每条检查都必须抓到自己针对的违规 ===');

  const clean = runChecks(realCss, realJs);
  const cleanIssues = clean.results.flatMap((r) => r.issues);
  console.log(`${cleanIssues.length ? '✗' : '✓'} 0) 真实文件全绿（否则"变红"没有参照系）`);
  for (const s of cleanIssues) console.log(`      ${s}`);
  if (cleanIssues.length) bad += 1;

  for (const c of cases) {
    const css = c.css ? c.css(realCss) : realCss;
    const js = c.js ? c.js(realJs) : realJs;
    if (css === realCss && js === realJs) {
      console.log(`✗ [${c.tag}] ${c.why} —— 用例没改成任何东西（用例自身失效）`);
      bad += 1;
      continue;
    }
    const { results } = runChecks(css, js);
    const fired = results.find((r) => r.label.startsWith(c.tag));
    const hit = fired && fired.issues.length > 0;
    console.log(`${hit ? '✓' : '✗'} [${c.tag}] ${c.why} → 该检查变红`);
    if (!hit) {
      console.log('      ↑ 空转：这种违规不会报警，必须修守卫');
      bad += 1;
    }
  }

  if (bad) { console.log(`\n✗ 自检失败 ${bad} 项`); process.exit(1); }
  console.log(`\n✓ 自检通过：${cases.length} 类注入全部报警，且真实文件全绿（检查项 ${CHECKS.length}）`);
}

/* ============ 主流程 ============ */

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return; }

  const cssRaw = fs.readFileSync(path.join(ROOT, CSS_REL), 'utf8');
  const jsRaw = fs.readFileSync(path.join(ROOT, JS_REL), 'utf8');
  const built = buildCtx(cssRaw, jsRaw);
  if (!built.region) {
    console.error(`✗ 在 ${CSS_REL} 里找不到首屏动效块边界（靠 /* ============ 空态动效 与 /* ---- 品牌区 两条标记注释定位）`);
    console.error('  动效被挪走或注释改了格式 —— 同步调整本守卫的定位方式，别让它静默失去作用范围。');
    process.exit(1);
  }

  const { results } = runChecks(cssRaw, jsRaw);
  let fail = 0;
  let pass = 0;
  for (const r of results) {
    if (r.issues.length) {
      fail += r.issues.length;
      console.log(`✗ ${r.label}`);
      for (const s of r.issues) console.log(`    · ${s}`);
    } else {
      pass += 1;
      console.log(`✓ ${r.label}`);
    }
  }
  console.log(`\n通过 ${pass}/${results.length} 项检查，问题 ${fail} 条`);
  if (fail) {
    console.log('\n提示：动效三条硬规矩写在 styles.css「空态动效」块开头（只碰 transform/opacity、');
    console.log('      不靠 JS 计时器重放、每条都要 reduced-motion 降级且终态 = 原样）。');
    console.log('      改完跑 `node scripts/check-empty-state-motion.js --self-test` 确认守卫还有牙齿。');
    process.exit(1);
  }
  console.log(`（动效 ${built.animated.length} 条、关键帧 ${built.keyframes.length} 组；--self-test 可做反向验证）`);
}

if (require.main === module) main();
module.exports = { runChecks, buildCtx };
