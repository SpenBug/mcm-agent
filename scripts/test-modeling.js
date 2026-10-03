'use strict';

/**
 * 建模能力端到端验证。
 *
 * 用 mock LLM 驱动一次完整的「写脚本 → 跑脚本 → 出图」链路，
 * 验证应用真的能执行建模代码、真的能产出图片文件。
 *
 * 与 test-agent-loop.js 的区别：那个验的是"循环与协议正确"，
 * 这个验的是"工具链真能干建模的活"（matplotlib 真跑起来、图真落盘）。
 *
 * 用法：MCM_TEST_PYTHON=<python> node scripts/test-modeling.js
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAgent } = require('../src/main/agent/loop');

const WORKSPACE = path.join(os.tmpdir(), 'mcm-agent-modeling-test');
const SKILLS_ROOT = path.join(__dirname, '..', 'resources', 'skills');
const PY = process.env.MCM_TEST_PYTHON || 'python';

/** 一段真实的建模画图代码：阻尼振荡曲线 */
const PLOT_CODE = [
  'import matplotlib',
  "matplotlib.use('Agg')",
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  '',
  'x = np.linspace(0, 10, 100)',
  'y = np.sin(x) * np.exp(-x / 5)',
  '',
  "fig, ax = plt.subplots(figsize=(6, 4), dpi=150)",
  "ax.plot(x, y, color='#2f4b8f', linewidth=1.8)",
  "ax.set_xlabel('t')",
  "ax.set_ylabel('amplitude')",
  "ax.set_title('damped oscillation')",
  'ax.grid(alpha=0.25)',
  'fig.tight_layout()',
  "fig.savefig('figures/result_q1_curve.png', dpi=300)",
  "print('OK saved')",
  '',
].join('\n');

const events = [];
const requests = [];
let turn = 0;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    turn += 1;
    try {
      requests.push(JSON.parse(body));
    } catch {
      requests.push({});
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

    if (turn === 1) {
      // 第一轮：写建模脚本
      sse(res, { choices: [{ delta: { content: '先写画图脚本。' } }] });
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_write',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'code/plot_q1.py', content: PLOT_CODE }),
                  },
                },
              ],
            },
          },
        ],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (turn === 2) {
      // 第二轮：跑脚本
      sse(res, { choices: [{ delta: { content: '脚本写好了，运行它。' } }] });
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_run',
                  type: 'function',
                  function: {
                    name: 'run_python',
                    arguments: JSON.stringify({ script: 'code/plot_q1.py' }),
                  },
                },
              ],
            },
          },
        ],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse(res, { choices: [{ delta: { content: '图已生成：figures/result_q1_curve.png' } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function main() {
  if (fs.existsSync(WORKSPACE)) {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE, { recursive: true });
  // 模拟应用的真实行为：应用在 chat:send / workspace:ensure 时会预建标准目录
  // （见 src/main/ipc.js 的 ensureWorkspaceDirs）。
  // 这里直调 runAgent 绕过了 IPC，所以要自己补上，否则 matplotlib 写
  // savefig('figures/x.png') 会因父目录不存在而失败 —— 那不是工具链的问题。
  for (const d of ['figures', 'code', 'results', 'reports']) {
    fs.mkdirSync(path.join(WORKSPACE, d), { recursive: true });
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const config = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'mock',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 2048,
    maxIterations: 6,
  };

  await runAgent({
    config,
    workspace: WORKSPACE,
    skillsRoot: SKILLS_ROOT,
    messages: [
      { role: 'system', content: '你是数模助手。' },
      { role: 'user', content: '把阻尼振荡画成图，存到 figures/result_q1_curve.png' },
    ],
    emit: (ev) => events.push(ev),
    pythonPath: PY,
  });

  /* ---------- 断言 ---------- */
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail: String(detail) });

  const toolStarts = events.filter((e) => e.type === 'tool_start');
  const toolResults = events.filter((e) => e.type === 'tool_result');

  const scriptPath = path.join(WORKSPACE, 'code', 'plot_q1.py');
  const figurePath = path.join(WORKSPACE, 'figures', 'result_q1_curve.png');

  check('LLM 轮次 = 3', turn === 3, `实际 ${turn}`);
  check('调用了 write_file 与 run_python', toolStarts.length === 2 && toolStarts[0].name === 'write_file' && toolStarts[1].name === 'run_python', toolStarts.map((t) => t.name).join(' → '));
  check('两次工具都成功', toolResults.length === 2 && toolResults.every((r) => r.ok), toolResults.map((r) => `${r.name}:${r.ok}`).join(','));
  check('建模脚本已落盘', fs.existsSync(scriptPath), scriptPath);
  check('matplotlib 图已生成', fs.existsSync(figurePath), figurePath);

  let pngSize = 0;
  let pngMagic = false;
  if (fs.existsSync(figurePath)) {
    pngSize = fs.statSync(figurePath).size;
    const head = fs.readFileSync(figurePath).subarray(0, 8);
    // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
    pngMagic = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  }
  check('产物是有效 PNG（魔数校验）', pngMagic, `${(pngSize / 1024).toFixed(1)} KB`);
  check('PNG 体积合理（>10KB 说明真的画了东西）', pngSize > 10240, `${pngSize} 字节`);

  const runOut = toolResults.find((r) => r.name === 'run_python');
  check('run_python 输出了脚本的 print', Boolean(runOut && /OK saved/.test(runOut.output)), (runOut?.output || '').split('\n').filter((l) => l.includes('OK')).join(''));

  const thirdReq = requests[2] || {};
  const toolMsgs = (thirdReq.messages || []).filter((m) => m.role === 'tool');
  check('两轮工具结果都回灌给了模型', toolMsgs.length === 2, `实际 ${toolMsgs.length} 条`);

  /* ---------- 输出 ---------- */
  const pass = checks.filter((c) => c.pass).length;
  console.log('');
  console.log('=== 事件序列 ===');
  console.log(events.map((e) => e.type + (e.name ? `(${e.name})` : '')).join(' → '));
  console.log('');
  console.log('=== 建模链路验证 ===');
  for (const c of checks) {
    console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
  }
  console.log('');
  console.log(`结果：${pass}/${checks.length} 通过`);
  console.log(`产物：${figurePath}`);

  server.close();
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err.stack || err.message);
  server.close();
  process.exit(1);
});
