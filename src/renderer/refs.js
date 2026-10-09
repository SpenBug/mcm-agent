'use strict';

/**
 * @{类别/名称} —— 输入框引用的解析与投影。
 *
 * 为什么是这个语法：
 *  - 没有空格歧义（`@赛题` 遇到带空格的中文文件名就会断）
 *  - 一条正则就能解析，不需要词法分析
 *  - **模型直接读得懂**：引用最终就是正文里的普通文本，
 *    主进程 tools 那边按名字读文件即可，不用额外协议。
 *    这点比 base64/UUID 标记重要得多 —— 标记越"聪明"，模型越容易读不懂用户意图。
 *
 * 与 DSH 的对应关系（以及为什么没照搬）：
 *  DSH 用 Lexical 把引用做成原子 DecoratorNode，一份文档三种投影，
 *  因为它的 chip 会改字形宽度、要支持剪贴板展开。
 *  本项目是原生 textarea + 零打包器 + 用户全打中文（IME 组合态是重灾区），
 *  所以只做"文本是唯一的真源，chip 是它的投影"：
 *  rail 上显示的每一张 chip，都必须能在正文里找到对应的那段文本；
 *  删 chip 就是删那段文本。反过来不维护第二份引用列表 ——
 *  DSH 的架构笔记里写得很清楚，草稿存两份正是它一系列结构性 bug 的根源。
 */

/** 允许引用的类别。固定枚举：用户手打错了类别就当普通文本，不假装它是引用 */
const CATS = ['赛题', '规范', '模板', '数据', '赛事', '模型'];

/**
 * 匹配 @{...}。
 *  - [^{}\n] 排除换行与嵌套花括号：引用必须是单行、一层，
 *    用户手打的 `@{a{b}}` 不该被当成一个引用。
 *  - 名称部分允许 `/` 以外的任意字符（文件名里有斜杠会被截断，
 *    但工作区文件名本身不含 `/`，所以够用）。
 */
const REF_RE = /@\{([^{}\n]{1,200})\}/g;

/** 把一段引用内容拆成 {cat, name}。不合法就返回 null（当普通文本处理） */
function splitRef(inner) {
  const s = String(inner || '');
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1) return null;
  const cat = s.slice(0, slash);
  const name = s.slice(slash + 1);
  if (!CATS.includes(cat)) return null;
  if (!name.trim()) return null;
  return { cat, name };
}

/**
 * 从正文解析出全部引用。
 *
 * @param {string} text
 * @returns {Array<{raw:string,cat:string,name:string,start:number,end:number}>}
 *          start/end 是 raw 在 text 中的字符区间（含头不含尾）
 */
function parseRefs(text) {
  const src = String(text || '');
  const out = [];
  if (!src) return out;
  // 每次调用都要重置 lastIndex：正则带 g 是模块级共享状态，
  // 复用会留下上一次的游标，表现为"第二次解析少了几条"——极难查
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(src)) !== null) {
    const split = splitRef(m[1]);
    if (!split) continue;          // 不是合法引用：当普通文本，不显示 chip
    out.push({ raw: m[0], cat: split.cat, name: split.name, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 拼出可插入正文的引用文本 */
function formatRef(cat, name) {
  return `@{${cat}/${String(name || '').replace(/[{}\n]/g, '')}}`;
}

/**
 * 从正文里删掉某一段引用（rail 上点 ✕ 用）。
 *
 * 按 start/end 删，而不是按 raw 字符串 replace ——
 * 同一个文件被引用两次时 replace 只会删掉第一个，
 * 用户点了第二张 chip 却发现第一张消失了。
 *
 * @param {string} text 当前正文
 * @param {{start:number,end:number,raw?:string}} ref
 */
function removeRef(text, ref) {
  const src = String(text || '');
  if (!ref || typeof ref.start !== 'number' || typeof ref.end !== 'number') return src;
  if (ref.start < 0 || ref.end > src.length || ref.start >= ref.end) return src;
  // 校验区间内容确实是这条引用：正文可能在这期间被用户改过（防错位删除）
  if (ref.raw && src.slice(ref.start, ref.end) !== ref.raw) return src;
  return src.slice(0, ref.start) + src.slice(ref.end);
}

/**
 * 把引用换成"人类可读的展开形式"，用于发给模型前的说明性文本。
 * 目前不启用（模型读得懂 @{...}），留着给以后接真附件协议时用。
 */
function expandRefs(text) {
  return parseRefs(text).reduceRight((acc, r) => acc.slice(0, r.start) + `${r.cat}：${r.name}` + acc.slice(r.end), String(text || ''));
}

/**
 * 触发检测：光标前是否正在输入一个引用（决定弹不弹候选面板）。
 *
 * ⚠️ 必须在 composition（中文输入法上屏）期间由调用方跳过 ——
 * 输入法打 `@` 时会先进组合态，那时文本还没定，弹面板会打断上屏。
 *
 * @returns {{query:string, start:number}|null} query 是 `@{` 之后已输入的部分
 */
function detectTrigger(text, caret) {
  const src = String(text || '');
  const pos = typeof caret === 'number' ? caret : src.length;
  const before = src.slice(0, pos);
  const open = before.lastIndexOf('@{');
  if (open < 0) return null;
  const seg = before.slice(open);
  // 已经闭合或含换行 → 不是在输入引用
  if (/}/.test(seg) || /\n/.test(seg)) return null;
  const inner = seg.slice(2);
  if (inner.length > 200) return null;
  return { query: inner, start: open };
}

/**
 * 按输入过滤候选。
 * 支持只打类别（`赛` → 列出各类别的材料），也支持 `赛题/12` 这种带名字的片段。
 */
function filterCandidates(query, sources) {
  const q = String(query || '');
  const all = [];
  for (const group of sources || []) {
    for (const item of group.items || []) {
      all.push({ cat: group.cat, name: item.name, hint: item.hint || '' });
    }
  }
  const slash = q.indexOf('/');
  const catPart = slash >= 0 ? q.slice(0, slash) : '';
  const namePart = slash >= 0 ? q.slice(slash + 1) : q;

  const byCat = catPart
    ? all.filter((c) => c.cat.includes(catPart))
    : all;
  const list = namePart ? byCat.filter((c) => c.name.toLowerCase().includes(namePart.toLowerCase())) : byCat;
  return list.slice(0, 40);
}

if (typeof window !== 'undefined') {
  window.McmRefs = { CATS, parseRefs, formatRef, removeRef, expandRefs, detectTrigger, filterCandidates, splitRef };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CATS, parseRefs, formatRef, removeRef, expandRefs, detectTrigger, filterCandidates, splitRef };
}
