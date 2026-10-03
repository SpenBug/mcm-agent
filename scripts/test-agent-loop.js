'use strict';

/**
 * Agent 内核离线验证：用一个本地 mock LLM 服务器跑通完整的
 * 「流式响应 → tool_calls 分片拼接 → 工具执行 → 结果回灌 → 循环终止」链路。
 *
 * 不需要真实 API Key。用法：node scripts/test-agent-loop.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runAgent } = require('../src/main/agent/loop');

const WORKSPACE = path.join(os.tmpdir(), 'mcm-agent-loop-test');
const SKILLS_ROOT = path.join(__dirname, '..', 'resources', 'skills');

let callCount = 0;
const seenRequests = [];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    callCount += 1;
    try {
      seenRequests.push(JSON.parse(body));
    } catch {
      seenRequests.push({ _raw: body });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (callCount === 1) {
      // 第一轮：把 tool_calls 的 arguments 拆成 3 片，验证拼接
      sse(res, { choices: [{ delta: { role: 'assistant', content: '' } }] });
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a1', type: 'function', function: { name: 'write_file', arguments: '{"path": "out' } },
              ],
            },
          },
        ],
      });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '/result.txt", ' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content": "hello from mock"}' } }] } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else if (callCount === 2) {
      // 第二轮：同时发起两个工具调用，验证多工具处理
      sse(res, { choices: [{ delta: { content: '文件已写入，再读一下确认。' } }] });
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_b1', type: 'function', function: { name: 'read_file', arguments: '{"path": "out/result.txt"}' } },
              ],
            },
          },
        ],
      });
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'call_b2', type: 'function', function: { name: 'list_files', arguments: '{"pattern": "out/*"}' } },
              ],
            },
          },
        ],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      // 第三轮：收敛
      sse(res, { choices: [{ delta: { content: '完成。out/result.txt 内容为 hello from mock。' } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const events = [];

async function main() {
  // 准备干净工作区
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`mock LLM 服务器: http://127.0.0.1:${port}/v1`);

  const config = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 1024,
    maxIterations: 10,
  };

  const result = await runAgent({
    config,
    workspace: WORKSPACE,
    skillsRoot: SKILLS_ROOT,
    messages: [
      { role: 'system', content: '你是一个测试助手。' },
      { role: 'user', content: '把 hello from mock 写进 out/result.txt' },
    ],
    emit: (ev) => events.push(ev),
    pythonPath: 'python',
  });

  /* ---------- 断言 ---------- */
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  const toolStarts = events.filter((e) => e.type === 'tool_start');
  const toolResults = events.filter((e) => e.type === 'tool_result');

  push('LLM 请求次数 = 3', callCount === 3, `实际 ${callCount}`);

  push('tool_start 事件 = 3', toolStarts.length === 3, `实际 ${toolStarts.length}：${toolStarts.map((t) => t.name).join(',')}`);

  push(
    'arguments 分片拼接正确',
    toolStarts[0] && toolStarts[0].args && toolStarts[0].args.path === 'out/result.txt' && toolStarts[0].args.content === 'hello from mock',
    JSON.stringify(toolStarts[0]?.args)
  );

  push('工具全部执行成功', toolResults.length === 3 && toolResults.every((r) => r.ok), toolResults.map((r) => `${r.name}:${r.ok}`).join(','));

  push('文件确实落盘', fs.existsSync(path.join(WORKSPACE, 'out', 'result.txt')), path.join(WORKSPACE, 'out', 'result.txt'));

  push(
    '文件内容正确',
    fs.existsSync(path.join(WORKSPACE, 'out', 'result.txt')) &&
      fs.readFileSync(path.join(WORKSPACE, 'out', 'result.txt'), 'utf8') === 'hello from mock',
    ''
  );

  push('多工具并行（同轮 2 个）', toolStarts.filter((t) => t.name === 'read_file' || t.name === 'list_files').length === 2, '');

  push('收到 done 事件', events.some((e) => e.type === 'done'), '');

  push('无 error 事件', !events.some((e) => e.type === 'error'), events.filter((e) => e.type === 'error').map((e) => e.message).join('|'));

  // 第二轮请求里应带 tool 角色消息
  const secondReq = seenRequests[1];
  const toolMsgs = (secondReq?.messages || []).filter((m) => m.role === 'tool');
  push('回灌了 tool 角色消息', toolMsgs.length === 1, `实际 ${toolMsgs.length} 条`);

  const assistantWithTools = (secondReq?.messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
  push('assistant 消息带 tool_calls', Boolean(assistantWithTools), '');

  push('请求里带上了 tools 定义', Array.isArray(secondReq?.tools) && secondReq.tools.length === 7, `实际 ${secondReq?.tools?.length} 个`);

  const finalMsg = result.messages[result.messages.length - 1];
  push('最终返回文本', finalMsg?.role === 'assistant' && String(finalMsg.content).includes('完成'), String(finalMsg?.content).slice(0, 40));

  /* ---------- 输出 ---------- */
  console.log('');
  console.log('=== 事件序列 ===');
  console.log(events.map((e) => e.type + (e.name ? `(${e.name})` : '')).join(' → '));
  console.log('');
  console.log('=== 断言结果 ===');
  let pass = 0;
  for (const c of checks) {
    console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
    if (c.pass) pass += 1;
  }
  console.log('');
  console.log(`结果：${pass}/${checks.length} 通过`);

  server.close();
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err.stack || err.message);
  server.close();
  process.exit(1);
});
