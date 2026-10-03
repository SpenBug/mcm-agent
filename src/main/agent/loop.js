'use strict';

const { streamChat } = require('./llm');
const { TOOL_DEFS, executeTool } = require('./tools');

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
    if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
    convo.push(assistantMsg);

    emit({ type: 'turn_end', content: result.content, usage: result.usage });

    if (!result.toolCalls.length) {
      emit({ type: 'done', content: result.content });
      return { messages: convo };
    }

    for (const call of result.toolCalls) {
      if (signal?.aborted) {
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
  }

  emit({ type: 'error', message: `已达最大迭代次数（${maxIterations}），任务可能未完成。可继续发消息让它接着做。` });
  return { messages: convo };
}

module.exports = { runAgent };
