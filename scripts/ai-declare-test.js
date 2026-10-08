/**
 * AI 工具使用声明生成器测试。
 * 重点：**不能编造声明** —— 未提供的用途必须是显式占位符，而不是被填成默认值。
 */
const AI = require('../src/main/agent/ai-declare');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

console.log('=== ① 赛事规则 ===');
check('国赛规则存在且要求排在参考文献前', AI.ruleFor('cumcm').beforeRefs === true);
check('国赛依据引用 2026 试行规定', /2026/.test(AI.ruleFor('cumcm').basis));
check('华为杯有独立规则', AI.ruleFor('huawei').label.includes('研究生'));
check('华为杯强调注明引用来源', /注明引用来源|引用来源/.test(AI.ruleFor('huawei').extra || ''));
check('美赛用英文标题', AI.ruleFor('mcm').sectionTitle === 'Report on Use of AI Tools');
check('未知赛事按国赛兜底（最严格）', AI.ruleFor('nope').sectionTitle === AI.ruleFor('cumcm').sectionTitle);

console.log();
console.log('=== ② 声明内容 ===');
const noAi = AI.buildDeclaration({ used: false, competition: 'cumcm' });
check('未使用 AI → 规定固定句式', noAi.text === '本参赛队在竞赛过程中未使用任何 AI 工具。', noAi.text);
check('未使用 AI 不带 details', noAi.details === undefined);

const withAi = AI.buildDeclaration({ used: true, purpose: '语言润色', competition: 'cumcm' });
check('使用 AI → 带用途', /语言润色/.test(withAi.purpose));
check('使用 AI → used 标记', withAi.used === true);

// ⚠️ 最关键的一条：不给用途时必须留占位符，不能编一个"看起来填好了"的值
const blank = AI.buildDeclaration({ used: true, competition: 'cumcm' });
check('未填用途 → 留【】占位符（不编造）', /【/.test(blank.purpose) && /】/.test(blank.purpose), blank.purpose);
check('占位符会被 mcm_docx check 查出（含【】）', blank.purpose.includes('【'));

const en = AI.buildDeclaration({ used: false, competition: 'mcm' });
check('美赛未使用 → 英文句式', /did not use any AI tools/.test(en.text), en.text);

console.log();
console.log('=== ③ 详情草稿（规定第 4 条四项）===');
const draft = AI.buildDetailDraft({ competition: 'cumcm' });
check('含工具名称版本项', /工具名称/.test(draft));
check('含使用目的和环节项', /使用目的和环节/.test(draft));
check('含提示方式与过程项', /提示方式/.test(draft));
check('含采纳与人工核验项', /核验/.test(draft));
check('标明是草稿、要求核实', /草稿/.test(draft) && /核实/.test(draft));
check('说明需转 PDF 进支撑材料', /PDF/.test(draft));
check('依据写进草稿', /2026/.test(draft));
check('未提供内容 → 留【】占位符', /【/.test(draft));

const filled = AI.buildDetailDraft({
  competition: 'cumcm',
  tool: '阿一古数模 v1.0.0',
  purpose: '- 绘图代码调试',
});
check('提供了工具名 → 原样写入', filled.includes('阿一古数模 v1.0.0'));
check('提供了用途 → 原样写入', filled.includes('绘图代码调试'));

console.log();
console.log(`结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
