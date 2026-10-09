#!/usr/bin/env node
'use strict';

/**
 * 草稿存储的离线测试。
 *
 * 为什么值得单独测：草稿的逻辑全是"顺序"和"边界"，
 * 而且失败模式都很安静 —— 用户只会觉得"草稿时灵时不灵"，
 * 谁也说不清是哪里的问题。所以每条都钉住。
 *
 * createDrafts 是工厂 + 注入 storage，不需要浏览器就能跑。
 */

const { createDrafts } = require('../src/renderer/drafts');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')); }
}

/** 假 localStorage（够语义就行：getItem/setItem/removeItem） */
function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _dump: () => Object.fromEntries(m),
  };
}

console.log('=== ① 基本读写 ===');
{
  const d = createDrafts(memStore());
  d.save('s1', '第一句还没发出去');
  check('存进去能读回来', d.load('s1') === '第一句还没发出去', d.load('s1'));
  check('别的会话读不到', d.load('s2') === '');
  check('空 id 不崩', d.load('') === '' && d.save('', 'x') === false);

  d.save('s1', '改过了');
  check('覆盖写生效', d.load('s1') === '改过了');

  d.clear('s1');
  check('clear 后读为空', d.load('s1') === '');
  check('clear 不存在的会话不报错', d.clear('nope') === true);
}

console.log('\n=== ② 空内容的语义（区分"没有"与"明确清空"）===');
{
  const d = createDrafts(memStore());
  d.save('s1', '有内容');
  d.save('s1', '');
  check('存空串等于删除该草稿', d.load('s1') === '');
  check('删除后条目真的不在 map 里', !('s1' in d.readAll()));
  d.save('s1', '');
  check('重复清空是幂等的（不抛错）', d.load('s1') === '');
  check('null/undefined 当空处理', (() => { d.save('s9', null); const a = d.load('s9'); d.save('s8', undefined); return a === '' && d.load('s8') === ''; })());
}

console.log('\n=== ③ 上限与裁剪 ===');
{
  const d = createDrafts(memStore(), { maxText: 10, maxItems: 3 });
  d.save('s1', '一二三四五六七八九十一二三');   // 13 字
  check('超长按码点裁到上限', [...d.load('s1')].length === 10, String([...d.load('s1')].length));
  check('裁剪不切断代理对（emoji）', (() => {
    const e = createDrafts(memStore(), { maxText: 3 });
    e.save('a', '😀😀😀😀');
    return !/\ufffd/.test(e.load('a')) && [...e.load('a')].length === 3;
  })());

  const d2 = createDrafts(memStore(), { maxItems: 3 });
  d2.save('a', '1'); d2.save('b', '2'); d2.save('c', '3'); d2.save('d', '4');
  const left = Object.keys(d2.readAll()).filter((k) => k !== '__last__');
  check('超出会话数上限时淘汰最旧', left.length <= 3, left.join(','));
  check('刚写入的那条不会被自己挤掉', d2.load('d') === '4', JSON.stringify(left));
  check('保留的是较新的几条', left.includes('d') && left.includes('c'), left.join(','));
}

console.log('\n=== ④ 淘汰不能碰恢复指针（真实踩过的坑）===');
{
  const d = createDrafts(memStore(), { maxItems: 3 });
  d.setLast('a');
  d.save('a', '正在写的这篇');
  d.save('b', '1'); d.save('c', '2'); d.save('d', '3'); d.save('e', '4');   // 逼它淘汰
  check('__last__ 没被淘汰掉', d.getLast() === 'a', d.getLast());
  check('恢复指针指向的会话仍可读', typeof d.load(d.getLast()) === 'string');
}

console.log('\n=== ⑤ 恢复指针与 resumable ===');
{
  const d = createDrafts(memStore());
  check('初始不可恢复', d.resumable() === '');
  d.setLast('s1');
  check('只有指针没内容 → 不可恢复', d.resumable() === '');
  d.save('s1', '没发出去的话');
  check('有指针有内容 → 可恢复', d.resumable() === 's1', d.resumable());
  d.clear('s1');
  check('内容清空后不再恢复（发出去过的不该回来）', d.resumable() === '');
  d.setLast('');
  check('setLast 空 id 无效', d.getLast() === '');
}

console.log('\n=== ⑥ 损坏数据一律降级，绝不抛错 ===');
{
  const cases = {
    '非法 JSON': { 'mcm-drafts': '{not json' },
    '数组而非对象': { 'mcm-drafts': '[1,2,3]' },
    'null': { 'mcm-drafts': 'null' },
    '值类型不对': { 'mcm-drafts': '{"s1":123,"s2":{"a":1}}' },
    '纯字符串（老版本）': { 'mcm-drafts': '"旧格式"' },
  };
  for (const [name, init] of Object.entries(cases)) {
    let ok = true;
    let d;
    try {
      d = createDrafts(memStore(init));
      d.load('s1');
      d.resumable();
      d.save('s1', '新内容');
      check(`${name} → 不抛错且能重新写`, d.load('s1') === '新内容');
    } catch (e) {
      ok = false;
      check(`${name} → 不抛错`, false, e.message);
    }
    void ok; void d;
  }
}

console.log('\n=== ⑦ storage 不可写（配额满 / 隐私模式）===');
{
  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceeded'); },
    removeItem: () => { throw new Error('nope'); },
  };
  const d = createDrafts(broken);
  let threw = false;
  try {
    check('写失败返回 false 而不是抛错', d.save('s1', 'x') === false);
    check('读失败返回空', d.load('s1') === '');
    check('resumable 失败返回空', d.resumable() === '');
  } catch (e) {
    threw = true;
    check('任何操作都不该抛错', false, e.message);
  }
  check('全程未抛异常', !threw);
}

console.log('\n=== ⑧ drop 与 clear 语义一致 ===');
{
  const d = createDrafts(memStore());
  d.save('s1', 'x'); d.setLast('s1');
  d.drop('s1');
  check('drop 后内容没了', d.load('s1') === '');
  check('drop 后不再恢复', d.resumable() === '');
}

console.log('\n=== ⑨ 持久化往返（模拟重启）===');
{
  const store = memStore();
  const a = createDrafts(store);
  a.save('s1', '重启前打的字');
  a.setLast('s1');

  const b = createDrafts(store);          // 同一个 storage 的新实例 = 重启
  check('重启后能恢复', b.resumable() === 's1');
  check('重启后内容完好', b.load('s1') === '重启前打的字', b.load('s1'));
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
