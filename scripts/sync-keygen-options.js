#!/usr/bin/env node
'use strict';

/**
 * 把签发器里的「解锁赛事」下拉从数据源同步到 tools/keygen.html。
 *
 * 为什么需要它：keygen.html 是双击打开的静态页面，没法 require 数据源，
 * 所以赛事和价格是手抄在 <option> 文案里的 —— 手抄必然漂移。
 * 实测抓到三处：
 *   - 缺 bigdata / huashu / huashu_intl（上一轮新增的 3 个赛事）
 *     → 买家买了大数据赛卡，你在这个界面**根本选不出来**
 *   - 亚太赛还写着 ¥49，数据源已改成 ¥39 → 按旧价收钱
 * 这类漂移不报错，只在收钱那一刻暴露，所以必须有自动检查。
 *
 * 用法：
 *   node scripts/sync-keygen-options.js          # 写入
 *   node scripts/sync-keygen-options.js --check  # 只校验（提交前 / CI），漂移即退出码 1
 */

const fs = require('node:fs');
const path = require('node:path');
const comps = require('../src/main/competitions');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'tools', 'keygen.html');
const START = '<!-- COMPETITION:OPTIONS:START -->';
const END = '<!-- COMPETITION:OPTIONS:END -->';

/**
 * 顺序按"先贵后便宜"排，方便发卡时一眼看到档位。
 *
 * ⚠️ 第一项是**空值占位**，不是全能包。以前全能包排第一、就是默认选中项，
 * 于是"没注意直接点签发"会把 ¥39 的单赛卡签成 ¥168 的权限 ——
 * 钱少了、台账上还看不出来。现在必须主动选一次才签得出去。
 * 用 value="" 而不是把整个下拉 disabled：不选就签不出，报错文案也说得清。
 */
function options() {
  const all = comps.COMPETITIONS.map((c, i) => ({ c, i }));
  all.sort((a, b) => (b.c.price - a.c.price) || (a.i - b.i));
  const lines = [
    '<option value="" selected disabled>请选择解锁的赛事…</option>',
    `<option value="all">全能包 —— 解锁全部赛事（¥${comps.PRICES.all}）</option>`,
  ];
  for (const { c } of all) {
    lines.push(`<option value="${c.id}">${c.name}（¥${comps.PRICES[c.id] ?? c.price}）</option>`);
  }
  return lines;
}

function block() {
  // 不在这里加缩进：replace() 会按文件原有缩进统一补，
  // 两处都加会变成 24 空格（实测踩过）。
  return [START, ...options(), END].join('\n');
}

/** 只替换标记之间的内容，保留标记外的手改部分 */
function replace(text, next) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) return null;
  const lineStart = text.lastIndexOf('\n', a) + 1;
  const indent = text.slice(lineStart, a);
  if (!/^\s*$/.test(indent)) return null;   // 标记不在行首 → 文件被改过，别乱动
  const indented = next.split('\n').map((l) => (l ? indent + l : l)).join('\n');
  return text.slice(0, lineStart) + indented + text.slice(b + END.length);
}

const check = process.argv.includes('--check');
const cur = fs.readFileSync(FILE, 'utf8');
const out = replace(cur, block());

if (out === null) {
  console.error('✗ 找不到 COMPETITION:OPTIONS 标记，keygen.html 结构可能被改坏了');
  process.exit(1);
}

if (out === cur) {
  console.log(`赛事选项已与数据源一致（${options().length} 项）`);
  process.exit(0);
}

if (check) {
  // 把差异具体列出来，别只说"不一致" —— 要能一眼看出是漏了赛事还是价格旧了
  const want = new Set(options().map((l) => l.replace(/\s+/g, ' ').trim()));
  const have = new Set(
    cur.slice(cur.indexOf(START), cur.indexOf(END)).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('<option')),
  );
  console.log('✗ keygen.html 的赛事选项与数据源不一致：');
  for (const l of want) if (!have.has(l)) console.log('  应有而缺：' + l);
  for (const l of have) if (!want.has(l)) console.log('  多余/过期：' + l);
  console.log('\n  修复：node scripts/sync-keygen-options.js');
  process.exit(1);
}

fs.writeFileSync(FILE, out, 'utf8');
console.log(`✓ 已同步 ${options().length} 个赛事选项到 tools/keygen.html`);
