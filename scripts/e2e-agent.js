/**
 * 真·端到端：用真实配置跑一轮完整 agent 循环。
 *
 * 为什么需要它：之前所有测试都是打桩的（桩掉 API、桩掉 dialog），
 * 从来没验证过"一轮真实对话到底能不能跑完"。这个脚本补上。
 *
 * 跑法: node scripts/e2e-agent.js
 * 注意：会消耗少量真实 token；API Key 只读取、不打印。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = path.join(process.env.APPDATA || '', '数模工坊');
const cfgPath = path.join(APP, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('✗ 找不到配置:', cfgPath);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!cfg.apiKey) {
  console.error('✗ 配置里没有 API Key，没法跑真实请求');
  process.exit(2);
}

// 只打印非敏感信息
console.log('=== 配置 ===');
console.log('  provider :', cfg.provider);
console.log('  model    :', cfg.model);
console.log('  baseUrl  :', cfg.baseUrl);
console.log('  apiKey   : 已配置（不打印）');
console.log('');

// 造一个临时工作区
const WS = path.join(os.tmpdir(), 'e2e-agent-' + Date.now());
fs.mkdirSync(path.join(WS, '.mcm-agent'), { recursive: true });
fs.mkdirSync(path.join(WS, 'input', '数据'), { recursive: true });
fs.mkdirSync(path.join(WS, 'code'), { recursive: true });

const SK = path.join(__dirname, '..', 'resources', 'skills');

const { runAgent } = require('../src/main/agent/loop');

const timeline = [];
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

let toolCount = 0;
let usageTotal = { prompt: 0, completion: 0, cached: 0, missed: 0 };

const emit = (ev) => {
  switch (ev.type) {
    case 'turn_start': timeline.push(`${stamp()} 第 ${ev.iteration} 轮开始`); break;
    case 'delta': break;                                   // 内容太多，不打
    case 'reasoning': timeline.push(`${stamp()} [思考] ${ev.text.length} 字`); break;
    case 'tool_start':
      toolCount += 1;
      timeline.push(`${stamp()} [工具] ${ev.name} ${JSON.stringify(ev.args).slice(0, 90)}`);
      break;
    case 'tool_result':
      timeline.push(`${stamp()} [结果] ${ev.ok ? '成功' : '失败'} ${ev.elapsed}ms :: ${String(ev.output).replace(/\s+/g, ' ').slice(0, 90)}`);
      break;
    case 'turn_end':
      if (ev.usage) {
        usageTotal.prompt += ev.usage.prompt || 0;
        usageTotal.completion += ev.usage.completion || 0;
        usageTotal.cached += ev.usage.cached || 0;
        usageTotal.missed += ev.usage.missed || 0;
        timeline.push(`${stamp()} 轮结束  usage=${JSON.stringify(ev.usage)}`);
      } else {
        timeline.push(`${stamp()} 轮结束  usage=null  ← ⚠️ 没拿到用量`);
      }
      break;
    case 'done': timeline.push(`${stamp()} ✓ done`); break;
    case 'aborted': timeline.push(`${stamp()} ■ aborted`); break;
    case 'error': timeline.push(`${stamp()} ✗ error: ${ev.message}`); break;
    default: timeline.push(`${stamp()} ? ${ev.type}`);
  }
};

// 硬超时，别让脚本挂住
const HARD_MS = 180000;
const killer = setTimeout(() => {
  console.log('\n✗ 超过 ' + HARD_MS / 1000 + ' 秒仍未结束，判定卡住');
  console.log(timeline.join('\n'));
  process.exit(1);
}, HARD_MS);

(async () => {
  console.log('=== 任务 ===');
  const prompt = '运行 `echo e2e-ok` 这条命令，然后把它的输出原样告诉我。只做这一件事。';
  console.log('  ' + prompt);
  console.log('');
  console.log('=== 时间线 ===');

  let out;
  try {
    out = await runAgent({
      config: cfg,
      workspace: WS,
      skillsRoot: SK,
      messages: [{ role: 'user', content: prompt }],
      emit,
      pythonPath: cfg.pythonPath || 'python',
    });
  } catch (err) {
    console.log(timeline.join('\n'));
    console.log('\n✗ 抛异常: ' + err.message);
    process.exit(1);
  }
  clearTimeout(killer);

  console.log(timeline.join('\n'));
  console.log('');
  console.log('=== 结果 ===');
  const last = out.messages[out.messages.length - 1];
  console.log('  最终回复:', JSON.stringify(String(last && last.content || '').slice(0, 200)));
  console.log('  工具调用次数:', toolCount);
  console.log('  消息条数:', out.messages.length);
  console.log('  用量合计: 输入 ' + usageTotal.prompt + ' / 输出 ' + usageTotal.completion
    + ' / 缓存命中 ' + usageTotal.cached + ' / 未命中 ' + usageTotal.missed);
  console.log('  耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const pass = !out.error && !out.aborted && toolCount > 0
    && String(last && last.content || '').includes('e2e-ok');
  console.log('');
  console.log(pass ? '=== ✓ 端到端通过 ===' : '=== ✗ 端到端未通过 ===');

  fs.rmSync(WS, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})();
