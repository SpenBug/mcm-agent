#!/usr/bin/env node
'use strict';

/**
 * 冒烟判定器（smoke-verdict）的离线测试。
 *
 * 为什么单独一套：判定器是"打包态唯一能自动判定成败的东西"
 * —— 打包出的 exe 是 GUI 程序，Windows 下看不到 stdout，成败全靠它算退出码。
 * 它自己要是漏判，就等于**发出去的包根本没人验过**。
 *
 * 而且它真出过 bug：正则写成 `/=>\s*(✓|✗)\b/`，因为 ✓/✗ 不是单词字符、
 * 后面跟空格时 `\b` 不成立，导致所有 `名称 => ✗ 原因` 格式的失败**全部漏判**。
 * 端到端断言用的正是这个格式。这个 bug 是靠"喂已知失败样本"抓出来的，
 * 所以那类反向用例必须永久留在套件里。
 */

const { summarizeSmoke, verdictLine } = require('../src/main/smoke-verdict');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
}

// 一份真实的通过样本（取自 npm run smoke 的实际输出，覆盖四种断言格式）
const PASSING_SAMPLE = [
  '===界面 DOM===',
  '{"title":"阿一古数模","bridge":"ok"}',
  '===赛事日历面板===',
  '✓ 面板可打开',
  '✓ 渲染出赛事条目  [10 条]',
  '✓ 默认当前赛事 = 最近一场未开赛的  [bigdata]',
  '赛事面板：10/10 通过',
  '===品牌与邀请码===',
  '✓ 窗口标题 = 阿一古数模  [阿一古数模]',
  '✓ 界面上不再出现微信号',
  '品牌与邀请码：12/12 通过',
  '===会话框内容===',
  '✓ 输入 @{ 弹出候选面板  [items=4]',
  '✓ 草稿写入 localStorage',
  '会话框内容：14/14 通过',
  '===IPC 链路===',
  '✓ config 保存往返  [temp=0.66]',
  'IPC 结果：12/12 通过',
  '===端到端对话（mock LLM）===',
  'mock LLM 收到请求 => ✓',
  '对话请求含用户消息（关键） => ✓',
  '并行发出标题辅助请求 => ✓',
  '  标题请求 max_tokens 已收紧 => ✓ 48',
  '发送后输入框已清空 => ✓',
  '===后端链路===',
  '  无 scibox 残留 = true',
  '  含 DRAWIO_REPORT = true',
  '提示词长度 = 9082 字符',
  '越界写入防护 => ✓ 已拦截（写入 越界…）',
  '  导出实测 => ✓ PDF 61 KB',
];

console.log('=== ① 真实通过样本必须判 PASS ===');
{
  const r = summarizeSmoke(PASSING_SAMPLE);
  check('无失败项', r.fail === 0, JSON.stringify(r.failures));
  // 用下限而不是精确值：精确值会把"往样本里加一行"变成要同步改两处，
  // 而计数的正确性由 ②③ 逐格式保证，这里只要求"主要格式都被认出来了"。
  check('断言计数达到下限（≥15，实测 17）', r.pass >= 15, `pass=${r.pass}`);
  check('verdictLine 输出 PASS', verdictLine(r).startsWith('PASS'), verdictLine(r));
}

console.log('\n=== ② 反向用例：每种失败格式都必须被抓到 ===');
{
  const cases = [
    ['✗ 前缀', '✗ 邀请面板可打开'],
    ['=> ✗ 带原因（曾经的漏判格式）', '对话请求含用户消息（关键） => ✗ 实际 roles=[system]'],
    ['=> ✗ 带计数', '请求带 7 个 tools 定义 => ✗ undefined'],
    ['布尔 false', '  无 scibox 残留 = false'],
    ['界面错误段', '===界面错误==='],
    ['加载失败', 'LOAD FAIL -3 ERR_FILE_NOT_FOUND'],
    ['渲染进程崩溃', 'RENDER GONE {"reason":"crashed"}'],
    ['CSP 拦截新增脚本', '[lvl3] Refused to load the script file:///.../refs.js because it violates CSP'],
    ['CSP 英文措辞', 'This document requires Content Security Policy'],
  ];
  for (const [name, line] of cases) {
    const r = summarizeSmoke([line]);
    check(`${name} → 判失败`, r.fail === 1 && r.failures.length === 1, JSON.stringify(r));
  }
}

console.log('\n=== ③ 良性行不能被误判 ===');
{
  const benign = [
    '✓ 正常项',
    '导出实测 => ✓ PDF 61 KB',
    '  含 DRAWIO_REPORT = true',
    '提示词长度 = 9082 字符',            // 有 = 号但不是布尔
    'IPC 结果：12/12 通过',              // 汇总行，不该被拆成 12 个断言
    '{"title":"阿一古数模","bridge":"ok"}',
    '   ',
    '',
    null,
    undefined,
  ];
  for (const line of benign) {
    const r = summarizeSmoke([line]);
    check(`放过：${JSON.stringify(String(line).slice(0, 24))}`, r.fail === 0, JSON.stringify(r.failures));
  }
}

console.log('\n=== ④ 混合场景：一项坏就整体 FAIL ===');
{
  const dirty = PASSING_SAMPLE.concat(['✗ 草稿写入 localStorage']);
  const r = summarizeSmoke(dirty);
  check('fail 计数为 1', r.fail === 1, `fail=${r.fail}`);
  check('失败项被列出且可定位', r.failures[0].includes('草稿'), JSON.stringify(r.failures));
  check('verdictLine 输出 FAIL', verdictLine(r).startsWith('FAIL'), verdictLine(r));
  check('通过项照常计数', r.pass >= 15, `pass=${r.pass}`);
}

console.log('\n=== ⑤ 健壮性：喂垃圾不崩 ===');
{
  const weird = [123, {}, [], true, Buffer.from('x'), Symbol.iterator ? 'sym' : 's'];
  let threw = false;
  let r;
  try { r = summarizeSmoke(weird); } catch { threw = true; }
  check('非字符串输入不抛错', !threw);
  check('垃圾输入不产生假失败', !threw && r.fail === 0, threw ? '' : JSON.stringify(r.failures));
  let threw2 = false;
  try { summarizeSmoke(null); summarizeSmoke(undefined); } catch { threw2 = true; }
  check('lines 本身为 null/undefined 也不抛错', !threw2);
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
