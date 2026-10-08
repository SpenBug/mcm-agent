'use strict';

/**
 * AI 工具使用声明生成器。
 *
 * 为什么必须有：全国大学生数学建模竞赛《人工智能工具使用规定（2026 年试行）》
 * （2026-08-03 发布，2026-09-01 起试行）第 3 条明确要求：
 *   参赛队应在**论文参考文献之前**设置「AI工具使用声明」，二者择一：
 *     (1) 未使用 AI："本参赛队在竞赛过程中未使用任何 AI 工具。"
 *     (2) 使用 AI："本参赛队在竞赛过程中使用了 AI 工具，主要用于【简要用途】，
 *         详细使用情况见支撑材料。"
 *   第 4 条要求使用 AI 的作品在支撑材料里附《AI工具使用详情.pdf》，含四项：
 *     ① 工具名称/版本 ② 使用目的与环节 ③ 主要提示方式与过程 ④ 采纳与人工核验情况
 *   第 5 条：不符合规定的作品视为违反竞赛规则，可能取消评奖资格。
 *
 * 华为杯（研究生赛）同样允许 AI，但要求"所有引用文献、引用程序（包括人工智能产品）
 * 均按规定注明来源"。所以两个赛事的声明措辞不同。
 *
 * ⚠️ 本模块**只生成草稿**：工具名称、用途、提示方式这些事实必须由用户/Agent
 * 按实际使用情况填写并核实。生成器不编造"我们用了某某工具"这类未发生的声明 ——
 * 虚假声明按规定是要取消评奖资格的，那是害用户。
 */

/** 赛事 → 声明规则。缺省按国赛（最严格的那套）处理 */
const RULES = {
  cumcm: {
    label: '全国大学生数学建模竞赛',
    basis: '《全国大学生数学建模竞赛人工智能工具使用规定（2026 年试行）》',
    sectionTitle: 'AI 工具使用声明',
    beforeRefs: true,
    detailFile: 'AI工具使用详情.pdf',
    detailTitle: 'AI 工具使用详情',
  },
  huawei: {
    label: '中国研究生数学建模竞赛（华为杯）',
    basis: '《华为杯中国研究生数学建模竞赛人工智能工具及输出使用规定（2026）》',
    sectionTitle: 'AI 工具使用声明',
    beforeRefs: true,
    detailFile: 'AI工具使用详情.pdf',
    detailTitle: 'AI 工具使用详情',
    // 华为杯额外强调"引用来源必须注明"
    extra: '本参赛队对 AI 生成内容逐项进行了人工审查与核实，并按竞赛要求在正文中注明了引用来源。',
  },
  mcm: {
    label: 'COMAP MCM/ICM（美赛）',
    basis: 'COMAP 竞赛规则（AI 使用需在报告中声明）',
    sectionTitle: 'Report on Use of AI Tools',
    beforeRefs: true,
    detailFile: 'AI-Usage-Details.pdf',
    detailTitle: 'AI Usage Details',
    english: true,
  },
};

/** 取某赛事的规则；未知赛事按国赛处理（最保守） */
function ruleFor(competitionId) {
  return RULES[competitionId] || RULES.cumcm;
}

/**
 * 生成论文 spec 里的 `ai_declaration` 片段。
 *
 * @param {object} opts
 * @param {boolean} opts.used       是否使用了 AI 工具
 * @param {string}  [opts.purpose]  简要用途（如"语言润色、代码调试"）
 * @param {string[]}[opts.details]  使用详情四条
 * @param {string}  [opts.competition] 赛事 id
 * @returns {{used:boolean, purpose?:string, details?:string[], sectionTitle:string, basis:string}}
 */
function buildDeclaration({ used, purpose, details, competition } = {}) {
  const rule = ruleFor(competition);
  if (used === false) {
    return {
      used: false,
      sectionTitle: rule.sectionTitle,
      basis: rule.basis,
      text: rule.english
        ? 'This team did not use any AI tools during the contest.'
        : '本参赛队在竞赛过程中未使用任何 AI 工具。',
    };
  }
  return {
    used: true,
    // ⚠️ 不给默认"已填"的用途 —— 留占位符让 check 能查出来，逼用户填真话
    purpose: purpose || '【请填写实际用途，如语言润色、代码调试】',
    details: Array.isArray(details) && details.length ? details : undefined,
    sectionTitle: rule.sectionTitle,
    basis: rule.basis,
    extra: rule.extra,
  };
}

/**
 * 生成《AI工具使用详情》草稿（Markdown，用户可导出 PDF 进支撑材料）。
 *
 * 四项内容按规定第 4 条逐条列出，**未提供的项留显式占位符**而不是省略 ——
 * 省略会让用户以为不用填。
 */
function buildDetailDraft({ competition, tool, purpose, prompts, review, files } = {}) {
  const rule = ruleFor(competition);
  const L = [];
  L.push(`# ${rule.detailTitle}`);
  L.push('');
  L.push(`> 依据：${rule.basis}`);
  L.push(`> 赛事：${rule.label}`);
  L.push('> ⚠️ 这是**草稿**。请按实际使用情况**逐项核实**后填写，删掉不适用的行，不要留空。');
  L.push('> 本文件需转成 PDF 后随论文作为支撑材料提交。');
  L.push('');
  L.push('## 一、所用 AI 工具名称、版本或型号');
  L.push('');
  L.push(tool || '- 【填写工具名称与版本，例如：阿一古数模 v1.0.0 / DeepSeek-V3】');
  L.push('');
  L.push('## 二、具体使用目的和环节');
  L.push('');
  L.push(purpose || [
    '- 【例如】赛题与附件的文字识别、格式整理',
    '- 【例如】候选模型的资料检索与对比',
    '- 【例如】绘图代码的调试',
    '- 【例如】论文语言润色',
  ].join('\n'));
  L.push('');
  L.push('## 三、主要提示方式与使用过程说明');
  L.push('');
  L.push(prompts || [
    '- 【例如】以自然语言描述赛题要求，要求给出建模思路候选，并自行判断取舍',
    '- 【例如】把报错信息贴给工具，询问修改方向，由队员自行决定是否采纳',
    '- （可附典型交互示例截图或文字）',
  ].join('\n'));
  L.push('');
  L.push('## 四、对 AI 输出的采纳、人工修改和核验情况');
  L.push('');
  L.push(review || [
    '- 【例如】所有模型假设、公式推导、参数取值均由队员独立复核',
    '- 【例如】AI 生成的代码经逐行阅读并实际运行验证，结果与论文一致',
    '- 【例如】AI 生成文字全部人工改写，语言润色除外',
  ].join('\n'));
  if (files && files.length) {
    L.push('');
    L.push('## 五、相关产物清单');
    L.push('');
    for (const f of files) L.push(`- \`${f}\``);
  }
  L.push('');
  return L.join('\n');
}

module.exports = { RULES, ruleFor, buildDeclaration, buildDetailDraft };
