'use strict';

/**
 * 冒烟结果的机器判定（纯函数，零依赖）。
 *
 * 为什么需要它：以前冒烟只 console.log、不设退出码，
 * 开发态靠人看输出还行；但**打包后的 exe 是 GUI 子系统程序，
 * Windows 下 stdout 根本看不见** —— 于是"包里到底能不能跑"
 * 永远只能靠人肉盯。而本轮反复验证过"开发态绿 ≠ 包里绿"
 * （图标那次最典型：文件在包里、内容是旧的，还静默发版）。
 *
 * 判据从输出行反推，而不是让每个检查点登记：
 * 冒烟有 4 组结构化断言 + 端到端 + 后端链路共 70+ 项，
 * 逐个改造成登记表要动几十处、极易漏；而它们的输出格式本来就统一。
 *
 * 单独成文件（而不是留在 smoke.js 里）的理由：
 * smoke.js 顶层 require('electron')，纯 Node 测试环境拿不到 app，
 * 抽出来才能离线测这套规则 —— 这套规则本身出过 bug（见下面的 \b 注释）。
 */

/** 断言行的四种形态 */
const MARK_ARROW = /=>\s*([✓✗])/;      // 名称 => ✓ / 名称 => ✗ 原因
const MARK_PREFIX = /^[✓✗]/;           // ✓ 名称 / ✗ 名称
const MARK_BOOL = /=\s*(true|false)$/; // xxx = true / xxx = false（后端链路用）

/** 打包态专属的危险信号：这三类出现即判失败 */
const FATAL = [
  { re: /^===界面错误===$/, why: '冒烟过程抛异常（见 ===界面错误=== 段）' },
  { re: /LOAD FAIL|RENDER GONE/, why: '渲染层加载失败或进程崩溃（资源可能没进包）' },
  // 本项目 CSP 是 script-src 'self'：新加的脚本只要没进包就会在这里现形
  { re: /Refused to|Content Security Policy/i, why: 'CSP 拦截（新增文件没进包 / 被策略挡住）' },
];

/**
 * @param {Iterable<unknown>} lines 冒烟输出行（含渲染进程 console 日志）
 * @returns {{failures:string[], pass:number, fail:number}}
 */
function summarizeSmoke(lines) {
  const failures = [];
  let pass = 0;
  let fail = 0;

  for (const raw of lines || []) {
    const line = String(raw == null ? '' : raw).trim();
    if (!line) continue;

    const fatal = FATAL.find((f) => f.re.test(line));
    if (fatal) { failures.push(`${fatal.why}：${line}`); fail += 1; continue; }

    // ⚠️ 不能用 \b：✓/✗ 不是单词字符，"✗ 原因"里 ✗ 后面是空格，
    // 加 \b 会让这个分支永远匹配不上 —— 端到端断言全是 `=> ✓` 格式，
    // 等于失败全部漏判。这个 bug 是反向测试（喂已知失败样本）抓出来的。
    let m = line.match(MARK_ARROW);
    if (!m && MARK_PREFIX.test(line)) m = [null, line[0]];
    if (m) {
      if (m[1] === '✓') pass += 1;
      else { fail += 1; failures.push(line); }
      continue;
    }

    m = line.match(MARK_BOOL);
    if (m) {
      if (m[1] === 'true') pass += 1;
      else { fail += 1; failures.push(line); }
    }
    // 其余是信息行（"提示词长度 = 9082 字符"、"IPC 结果：12/12 通过"），不计入
  }

  return { failures, pass, fail };
}

/** 一行摘要，供 stdout / 报告文件用 */
function verdictLine(r) {
  return `${r.fail === 0 ? 'PASS' : 'FAIL'} pass=${r.pass} fail=${r.fail}`;
}

module.exports = { summarizeSmoke, verdictLine };
