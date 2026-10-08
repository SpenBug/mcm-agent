'use strict';

const { streamChat } = require('./llm');
const { TOOL_DEFS, executeTool } = require('./tools');

/**
 * 中断/报错时给**没有应答的 tool_calls 补一条 tool 消息**。
 *
 * OpenAI 协议要求：assistant 带了 tool_calls，后面必须逐条跟上同 id 的 tool 消息。
 * 少一条，这份历史回灌给服务端就是 400，而且会话已经落盘 ——
 * 用户表现为「点了停止之后，这个会话再也发不出消息」。
 */
function closePendingToolCalls(convo, toolCalls, note = '（该工具在任务被中断时未执行完成）') {
  const answered = new Set(convo.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  let added = 0;
  for (const call of toolCalls || []) {
    if (answered.has(call.id)) continue;
    convo.push({ role: 'tool', tool_call_id: call.id, content: note });
    added += 1;
  }
  return added;
}

/**
 * Agent 主循环：对话 → 解析工具调用 → 执行 → 回灌 → 继续，直到模型不再调用工具。
 * 所有事件通过 emit 实时推送给渲染进程。
 */
async function runAgent({ config, workspace, skillsRoot, messages, emit, signal, pythonPath }) {
  const maxIterations = Math.min(Math.max(config.maxIterations || 40, 1), 200);
  const convo = [...messages];

  for (let i = 0; i < maxIterations; i += 1) {
    if (signal?.aborted) {
      emit({ type: 'aborted' });
      return { messages: convo, aborted: true };
    }

    emit({ type: 'turn_start', iteration: i + 1 });

    let result;
    try {
      result = await streamChat({
        config,
        messages: convo,
        tools: TOOL_DEFS,
        signal,
        onDelta: (text) => emit({ type: 'delta', text }),
        onReasoning: (text) => emit({ type: 'reasoning', text }),
      });
    } catch (err) {
      if (signal?.aborted) {
        emit({ type: 'aborted' });
        return { messages: convo, aborted: true };
      }
      emit({ type: 'error', message: err.message });
      return { messages: convo, error: err.message };
    }

    const assistantMsg = { role: 'assistant', content: result.content || '' };
    // 思考内容挂在这里，只为渲染进程能展示「思考过程」；
    // llm.js 的 sanitizeMessage() 会在发给 API 前把它剥掉
    if (result.reasoning) assistantMsg.reasoning = result.reasoning;
    if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
    convo.push(assistantMsg);

    if (!result.toolCalls.length) {
      // 没有工具调用 = 这一轮结束，turn_end 照发（保证每轮恰好一次）
      emit({ type: 'turn_end', content: result.content, usage: result.usage });
      emit({ type: 'done', content: result.content });
      return { messages: convo };
    }

    for (const call of result.toolCalls) {
      if (signal?.aborted) {
        // assistant 已带着全部 tool_calls 入列，剩下的工具不会再跑 ——
        // 必须补齐缺的 tool 消息，否则这份历史（以及刚落盘的会话文件）永远 400
        closePendingToolCalls(convo, result.toolCalls);
        emit({ type: 'aborted' });
        return { messages: convo, aborted: true };
      }

      const toolName = call.function.name;
      let parsedArgs = {};
      let parseError = null;
      try {
        parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (e) {
        parseError = e.message;
      }

      emit({ type: 'tool_start', id: call.id, name: toolName, args: parsedArgs });

      let output;
      if (parseError) {
        output = `参数解析失败：${parseError}\n原始参数：${call.function.arguments}`;
        emit({ type: 'tool_result', id: call.id, name: toolName, ok: false, output });
      } else {
        const started = Date.now();
        try {
          output = await executeTool(toolName, parsedArgs, {
            workspace,
            skillsRoot,
            pythonPath,
            onOutput: (chunk) => emit({ type: 'tool_stream', id: call.id, ...chunk }),
          });

          // 命令类工具以**退出码**判定成败。
          // executeTool 不抛异常只说明"命令跑起来了"，不代表命令本身成功 ——
          // 不区分的话，UI 会给一个绿色的"成功"卡片，实际什么都没产出。
          let ok = true;
          const m = /^退出码：(-?\d+)/.exec(String(output));
          if (m) ok = Number(m[1]) === 0;

          emit({ type: 'tool_result', id: call.id, name: toolName, ok, output, elapsed: Date.now() - started });
        } catch (err) {
          output = `执行失败：${err.message}`;
          emit({ type: 'tool_result', id: call.id, name: toolName, ok: false, output, elapsed: Date.now() - started });
        }
      }

      convo.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
    }

    // ⚠️ turn_end 必须等这一轮的工具**跑完**再发。
    // 原来发在工具循环之前，渲染层在 turn_end 里就把 currentAssistant 置空了，
    // 于是紧接着的 tool_start 里 `if (state.currentAssistant)` 为假 ——
    // 工具调用**根本没被记进消息状态**，会留下「assistant 没有 tool_calls、
    // 后面却跟着 tool 消息」的畸形结构，下次请求直接被服务端 400。
    emit({ type: 'turn_end', content: result.content, usage: result.usage });
  }

  emit({ type: 'error', message: `已达最大迭代次数（${maxIterations}），任务可能未完成。可继续发消息让它接着做。` });
  return { messages: convo };
}

module.exports = { runAgent };
