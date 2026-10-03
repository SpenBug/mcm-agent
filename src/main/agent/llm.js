'use strict';

/**
 * OpenAI 兼容协议客户端（流式）。
 * 通过自定义 baseUrl / apiKey / model，可对接 DeepSeek、Kimi、通义、智谱、
 * OpenAI、硅基流动、Ollama、以及任何 OpenAI 兼容网关。
 */

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API 地址（Base URL）');
  return `${base}${suffix}`;
}

async function readError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '(无法读取响应体)';
  }
  return `HTTP ${res.status} ${res.statusText} — ${String(detail).slice(0, 500)}`;
}

/**
 * 流式对话。
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, finishReason:string, usage:object|null}>}
 */
async function streamChat({ config, messages, tools, signal, onDelta, onReasoning, onToolCallStart }) {
  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
  };
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey || 'EMPTY'}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(await readError(res));
  if (!res.body) throw new Error('服务端未返回流式响应体');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  /** index -> { id, name, args } */
  const toolAcc = new Map();

  const handleChunk = (json) => {
    if (json.usage) usage = json.usage;
    const choice = json.choices && json.choices[0];
    if (!choice) return;

    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!toolAcc.has(idx)) {
          toolAcc.set(idx, { id: '', name: '', args: '' });
          if (onToolCallStart && tc.function && tc.function.name) {
            onToolCallStart({ index: idx, name: tc.function.name });
          }
        }
        const acc = toolAcc.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function) {
          if (tc.function.name) acc.name = tc.function.name;
          if (tc.function.arguments) acc.args += tc.function.arguments;
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        handleChunk(JSON.parse(payload));
      } catch {
        // 忽略无法解析的保活行
      }
    }
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: v.name, arguments: v.args || '{}' },
    }))
    .filter((t) => t.function.name);

  return { content, reasoning, toolCalls, finishReason, usage };
}

/** 连通性测试：非流式、极短输出 */
async function testConnection(config) {
  const res = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey || 'EMPTY'}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const json = await res.json();
  return {
    ok: true,
    model: json.model || config.model,
    reply: json.choices?.[0]?.message?.content ?? '',
  };
}

module.exports = { streamChat, testConnection, joinUrl };
