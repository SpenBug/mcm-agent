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
/**
 * 只保留 OpenAI 聊天规范里的字段。
 *
 * 我们在消息上挂了 `reasoning` 之类的 UI 字段（给渲染进程展示用），
 * 但**绝不能发给服务端** —— 部分实现遇到未知字段会直接 400。
 * 白名单比黑名单安全：以后再加内部字段也不用改这里。
 */
const ALLOWED_MSG_FIELDS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id'];

function sanitizeMessage(m) {
  const out = {};
  for (const k of ALLOWED_MSG_FIELDS) {
    if (m[k] !== undefined) out[k] = m[k];
  }
  // 空的 tool_calls 数组没有语义（这条 assistant 就是普通回复、没调工具），
  // 但白名单会把它原样带出去 —— 部分兼容实现遇到 `tool_calls: []` 会直接 400。
  // 和白名单同一套精神：没意义就别发。
  if (Array.isArray(out.tool_calls) && out.tool_calls.length === 0) delete out.tool_calls;
  return out;
}

/**
 * 把各家不同的 usage 字段归一化成统一结构。
 *
 * 缓存命中字段各家叫法不一样，都得认：
 *   - DeepSeek : `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *   - OpenAI   : `prompt_tokens_details.cached_tokens`
 *   - 其他兼容实现：可能两个都没有 —— 那就 cached = 0，界面按"无缓存数据"处理
 */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = Number(u.prompt_tokens) || 0;
  const completion = Number(u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || prompt + completion;

  const rawCached = u.prompt_cache_hit_tokens !== undefined
    ? u.prompt_cache_hit_tokens
    : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
  const rawMissed = u.prompt_cache_miss_tokens;

  const cached = Number(rawCached) || 0;
  const missed = rawMissed !== undefined ? (Number(rawMissed) || 0) : Math.max(0, prompt - cached);

  // ⚠️ 只有接口**明确**给了缓存字段才算"有缓存信息"。
  // 用 cached+missed>0 判断的话，没缓存字段的厂商会被算成"命中率 0%" —— 那是误导。
  const hasCacheInfo = rawCached !== undefined || rawMissed !== undefined;

  return { prompt, completion, total, cached, missed, hasCacheInfo };
}

async function streamChat({ config, messages, tools, signal, onDelta, onReasoning, onToolCallStart }) {
    const body = {
      model: config.model,
      // 只保留 OpenAI 规范字段 —— 我们给消息挂的 reasoning 等 UI 字段不能发给 API，
      // 有些服务端对未知字段会直接 400
      messages: messages.map(sanitizeMessage),
      stream: true,
      // ⚠️ 不加这个，多数 OpenAI 兼容接口**不会在流式响应里返回 usage** ——
      // Token 仪表盘就没数据了。加完之后末尾会多一个 choices 为空的包，
      // handleChunk 是先取 usage 再检查 choice，能正确接住。
      stream_options: { include_usage: true },
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

  // ⚠️ 空闲超时：服务端一旦不再推数据，reader.read() 会永远挂住 ——
  // 界面就表现为"卡着不动"。加个兜底，超时就报错退出，别让用户干等。
  //
  // 默认 5 分钟：大上下文（实测见过 280K）首字延迟可能很久，
  // 120 秒容易把"慢"误判成"断了"。单次请求可用 config.streamIdleMs 覆盖
  // （重试卡片的"加大超时再试"就是走这条路）。
  const IDLE_MS = Math.max(Number(config.streamIdleMs) || 300000, 10000);
  let sawDone = false;

  try {
    while (!sawDone) {
      let idleTimer;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(
              `流式响应已 ${IDLE_MS / 1000} 秒没有任何数据，判定连接已断，已中断本次请求。`
            )),
            IDLE_MS
          );
        }),
      ]);
      clearTimeout(idleTimer);

      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        // ⚠️ 这里是 break 不是 continue。
        // 原来写 continue，收到 [DONE] 后还继续等服务器主动关连接 ——
        // 服务端用 keep-alive 不关的话就永远挂住。
        if (payload === '[DONE]') { sawDone = true; break; }
        try {
          handleChunk(JSON.parse(payload));
        } catch {
          // 忽略无法解析的保活行
        }
      }
    }
  } catch (err) {
    // 出错时主动关掉连接，别把 socket 悬着
    try { await reader.cancel(); } catch { /* 关不掉也无所谓 */ }
    throw err;
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: v.name, arguments: v.args || '{}' },
    }))
    .filter((t) => t.function.name);

  return { content, reasoning, toolCalls, finishReason, usage: normalizeUsage(usage) };
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

module.exports = { streamChat, testConnection, joinUrl, normalizeUsage };
