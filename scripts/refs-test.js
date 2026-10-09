#!/usr/bin/env node
'use strict';

/**
 * 引用解析（@{类别/名称}）的离线测试。
 *
 * 核心不变量：**chip 是正文的投影** —— 解析出的每条都必须能在原文里
 * 按 start/end 精确切回来，删 chip 就是删那段文本。
 * 一旦哪天又维护了第二份引用列表，这里的断言就会红。
 */

const R = require('../src/renderer/refs');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')); }
}

console.log('=== ① 基本解析 ===');
{
  const t = '请用 @{赛题/2024A题.pdf} 结合 @{数据/附件1.xlsx} 建模';
  const refs = R.parseRefs(t);
  check('解析出 2 条', refs.length === 2, JSON.stringify(refs.map((r) => r.raw)));
  check('类别正确', refs[0].cat === '赛题' && refs[1].cat === '数据', refs.map((r) => r.cat).join(','));
  check('名称正确', refs[0].name === '2024A题.pdf' && refs[1].name === '附件1.xlsx');
  check('每条都能按区间切回原文（投影不变量）',
    refs.every((r) => t.slice(r.start, r.end) === r.raw));
  check('空文本不崩', R.parseRefs('').length === 0 && R.parseRefs(null).length === 0);
  check('重复解析结果稳定（g 正则 lastIndex 陷阱）',
    JSON.stringify(R.parseRefs(t)) === JSON.stringify(R.parseRefs(t)), '第二次与第一次不同 → lastIndex 没重置');
}

console.log('\n=== ② 非法形态一律当普通文本 ===');
{
  const bad = [
    '@{未知类别/x}',        // 类别不在枚举里
    '@{赛题}',              // 没有斜杠
    '@{/名字}',             // 类别空
    '@{赛题/}',             // 名字空
    '@{赛题/  }',           // 名字全空白
    '@{a{b}}',              // 嵌套花括号
    '@{赛题/跨\n行}',        // 含换行
    '@{}',                  // 空
  ];
  for (const s of bad) {
    check(`不解析：${JSON.stringify(s.slice(0, 16))}`, R.parseRefs(s).length === 0, JSON.stringify(R.parseRefs(s)));
  }
}

console.log('\n=== ③ 中文名、空格、特殊字符 ===');
{
  const refs = R.parseRefs('@{规范/论文 格式 要求 2026 版.docx}');
  check('名称含空格能完整解析', refs.length === 1 && refs[0].name === '论文 格式 要求 2026 版.docx', refs[0]?.name);
  check('中文类别可解析', R.parseRefs('@{模板/我的模板.tex}')[0]?.cat === '模板');
  check('六个类别都支持', R.CATS.every((c) => R.parseRefs(`@{${c}/x}`).length === 1), R.CATS.join(','));
}

console.log('\n=== ④ formatRef 与 parseRefs 互逆 ===');
{
  for (const c of R.CATS) {
    const s = R.formatRef(c, '文件名 v2.pdf');
    const back = R.parseRefs(s)[0];
    check(`${c}: 拼出来能被解析回去`, back && back.cat === c && back.name === '文件名 v2.pdf', s);
  }
  const dirty = R.formatRef('赛题', 'a{b}c\nd');
  // 只看名称段：外层 @{ } 本来就该在
  const dirtyBack = R.parseRefs(dirty)[0];
  check('名称里的花括号与换行被剔除（防破坏语法）',
    !/[{}\n]/.test(dirty.slice(3, -1)) && dirtyBack?.name === 'abcd', JSON.stringify({ dirty, name: dirtyBack?.name }));
}

console.log('\n=== ⑤ removeRef：按区间删，不是按字符串 replace ===');
{
  const t = '前 @{数据/a.csv} 中 @{数据/a.csv} 后';
  const refs = R.parseRefs(t);
  check('同一文件引用两次', refs.length === 2);
  const removed2 = R.removeRef(t, refs[1]);
  // 关键：删第二条时不能误删第一条（按字符串 replace 就会那样）。
  // 剩下的那条必须还停在原位（start=2）。
  check('删第二条只去掉第二条（不是第一个匹配）',
    R.parseRefs(removed2).length === 1 && R.parseRefs(removed2)[0].start === 2 && removed2.startsWith('前 @{数据/a.csv} 中'),
    JSON.stringify(removed2));
  const removed1 = R.removeRef(t, refs[0]);
  check('删第一条后剩下第二条', R.parseRefs(removed1).length === 1 && removed1.startsWith('前'));
  check('幂等：重复删同一条不会多删', R.removeRef(R.removeRef(t, refs[0]), refs[0]) === R.removeRef(t, refs[0]));
}

console.log('\n=== ⑥ removeRef 的防御（正文可能已被用户改过）===');
{
  const t = 'abc @{数据/a.csv} def';
  const ref = R.parseRefs(t)[0];
  // 前缀换成不同长度，让 ref.start 指向的内容不再是这条引用。
  // （早先用等长的 'XYZ' 替换 'abc'，位置根本没动，测不出防错位删除）
  const mutated = 'wxyz @{数据/a.csv} def';
  check('区间内容与 raw 不符时不删（防错位删除）',
    R.removeRef(mutated, ref) === mutated, JSON.stringify(R.removeRef(mutated, ref)));
  // 删掉后剩 'abc ' + ' def'（中间两个空格），所以比较前先折叠空白
  check('合法区间仍能正常删', R.removeRef(t, ref).replace(/\s+/g, ' ').trim() === 'abc def',
    JSON.stringify(R.removeRef(t, ref)));
  check('非法区间不动原文', R.removeRef(t, { start: -5, end: 999, raw: 'x' }) === t);
  check('start>=end 不动原文', R.removeRef(t, { start: 5, end: 5, raw: '' }) === t);
  check('ref 为 null 不动原文', R.removeRef(t, null) === t);
  check('缺 raw 时仍按区间删（兼容）', R.removeRef(t, { start: 4, end: 15 }).includes('abc'));
}

console.log('\n=== ⑦ detectTrigger：什么时候该弹候选 ===');
{
  const t = '请用 @{赛';
  const trig = R.detectTrigger(t, t.length);
  // '@{' 从下标 3 开始（请=0 用=1 空格=2 @=3 {=4 赛=5）
  check('正在输入 @{ 时触发', trig && trig.query === '赛' && trig.start === 3, JSON.stringify(trig));
  check('没打 @{ 不触发', R.detectTrigger('普通文本', 4) === null);
  check('已闭合不触发', R.detectTrigger('@{数据/a.csv} 后面', 14) === null);
  // 光标落在一条完整引用内部：按"正在编辑这条引用"处理，
  // 让候选随已输入的部分收窄，插入时从 start 替换到光标。这是有意的行为。
  const inside = R.detectTrigger('@{数据/a}', 3);
  check('光标在引用内部时按正在编辑处理', inside && inside.start === 0 && inside.query === '数', JSON.stringify(inside));
  check('光标后的内容不影响判定', (() => {
    const s = '@{赛 后面还有字';
    const r = R.detectTrigger(s, 3);
    return r && r.query === '赛';
  })());
  check('含换行的残缺引用不触发', R.detectTrigger('@{a\nb', 5) === null);
  check('空文本不崩', R.detectTrigger('', 0) === null);
  check('超长 query 不触发（防卡）', R.detectTrigger('@{' + 'x'.repeat(300), 302) === null);
}

console.log('\n=== ⑧ filterCandidates ===');
{
  const sources = [
    { cat: '赛题', items: [{ name: '2024A.pdf' }, { name: '2024B.pdf' }] },
    { cat: '数据', items: [{ name: '附件1.xlsx' }] },
    { cat: '赛事', items: [{ name: '国赛 CUMCM' }] },
  ];
  check('空 query 列全部', R.filterCandidates('', sources).length === 4);
  check('按类别过滤', R.filterCandidates('赛', sources).every((c) => c.cat === '赛题' || c.cat === '赛事'));
  check('只列赛题', R.filterCandidates('赛题/', sources).length === 2);
  check('按名称片段过滤', R.filterCandidates('赛题/2024B', sources).length === 1);
  check('名称匹配大小写不敏感', R.filterCandidates('数据/附件', sources).length === 1);
  check('无匹配返回空数组', Array.isArray(R.filterCandidates('zzz', sources)) && R.filterCandidates('zzz', sources).length === 0);
  check('空 sources 不崩', R.filterCandidates('x', []).length === 0 && R.filterCandidates('x', null).length === 0);
  check('结果数有上限（防面板爆掉）',
    R.filterCandidates('', [{ cat: '数据', items: Array.from({ length: 200 }, (_, i) => ({ name: 'f' + i })) }]).length <= 40);
}

console.log('\n=== ⑨ expandRefs（备用）===');
{
  const e = R.expandRefs('看 @{数据/a.csv} 和 @{赛题/b.pdf}');
  check('展开成人类可读文本', e.includes('数据：a.csv') && e.includes('赛题：b.pdf'), e);
  check('非法引用原样保留', R.expandRefs('@{未知/x}') === '@{未知/x}');
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
