'use strict';

/**
 * 会话标题生成（对标 DSH 的 packages/session/session-title-llm）。
 *
 * 要解决的问题：本项目原先用 `firstLine.trim().slice(0, 20)` 命名会话，
 * 两个后果 —— ① 中文标题被腰斩（「基于层次分析法的…» 切成半句），
 * ② 用户粘一整篇赛题时首行往往是「附件1」这种噪音，侧栏完全分不出哪个是哪个。
 *
 * 从 DSH 抄来的四条设计（都是它踩坑后定下的）：
 *  1. **CJK 感知长度**：targetWords（英文）与 targetCjkCharacters（中日韩）分开。
 *     一个按词算、一个按字算，用同一个数字必然一边太长一边太短。
 *  2. **输入用 JSON 框住**：DSH 注释原文 "Frame exact messages as JSON so user
 *     text cannot break structural delimiters"。不这么做的话，用户题目里带一对
 *     引号或一句「忽略以上指令」就能把提示词结构撑破。
 *  3. **严格单行输出约束**：禁引号/前缀/Markdown/XML/控制码/代码，并要求
 *     "Use the language of the messages"（用中文问就别回英文标题）。
 *  4. **端到端 deadline + 专用错误码**：标题是辅助调用，绝不能把主对话拖住。
 *
 * 主动偏离 DSH 的一处：DSH 生成失败就不更新标题；这里**先给本地兜底标题**，
 * LLM 成功再替换 —— 本项目要面对没配 Key / 断网 / 网关不支持的用户，
 * 侧栏不能出现空标题或永久「新会话」。
 */

const { streamChat } = require('./llm');

/** 与 DSH 的 SESSION_TITLE_TIMEOUT_CODE 同构：让调用方能区分超时和其他失败 */
const TITLE_TIMEOUT_CODE = 'TITLE_TIMEOUT';

/** 默认策略。DSH 坚持"库不设默认值"，但那是插件框架要显式配置；
 *  这里是应用内部一次性辅助调用，给一组保守默认更实际。 */
const DEFAULTS = {
  targetWords: 5,
  targetCjkCharacters: 10,
  /** 用户可能直接粘整篇赛题（几十 KB），按 UTF-8 字节裁，避免辅助调用白烧 token */
  maxInputBytes: 2000,
  maxOutputTokens: 48,
  timeoutMs: 12000,
};

/** 中日韩统一表意文字 + 常见中文标点。用来决定按"字"还是按"词"计数。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u{20000}-\u{2a6df}]/u;

function looksCjk(text) {
  return CJK_RE.test(String(text || ''));
}

/** UTF-8 字节数（不引第三方包，手写足够准） */
function utf8Bytes(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0x10000) n += 3;
    else n += 4;
  }
  return n;
}

/** 按 UTF-8 字节裁到 limit，且不切断多字节字符（for..of 按码点迭代，天然安全） */
function clampBytes(s, limit) {
  const str = String(s || '');
  if (utf8Bytes(str) <= limit) return str;
  let n = 0;
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (n > limit) break;
    out += ch;
  }
  return out;
}

/** 目标长度：CJK 按字、其他按词。两者取"该语言下的等效长度"。 */
function targetLength(text, cfg) {
  return looksCjk(text) ? cfg.targetCjkCharacters : cfg.targetWords;
}

/**
 * 按语言计数截断。
 * ⚠️ 不能直接用 String.slice(n)：英文 5 个"字符"只有 1 个词，
 * 中文 10 个"字符"才是想要的长度 —— 这正是 DSH 把两个参数分开的原因。
 */
function truncateToTarget(text, cfg) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (looksCjk(s)) {
    const limit = cfg.targetCjkCharacters;
    return [...s].length > limit ? [...s].slice(0, limit).join('').trimEnd() : s;
  }
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > cfg.targetWords ? words.slice(0, cfg.targetWords).join(' ') : s;
}

/**
 * 清洗模型返回：强制单行纯文本。
 *
 * 模型常见不听话的形态，逐条兜住：
 *   - 包引号 / 前缀「标题：」/ Markdown 加粗 / 反引号 / XML 标签
 *   - 返回一整段解释，甚至一段代码
 *   - 多行（DSH 明确要求 "on one line"）
 */
function cleanTitle(raw, cfg = DEFAULTS) {
  let s = String(raw == null ? '' : raw);

  // 顺序很重要，别把这两步合并：
  //  1. 零宽字符（含 BOM）要**删除** —— 它们本身不可见，替换成空格会凭空插入一个可见空格
  //  2. 换行/回车要**留着**，等下面按行切完再统一折叠；
  //     早先版本把 \u0000-\u001f 整段换成空格，结果 \n 先没了，"只取第一行"永远失效
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');

  s = s.trim();
  if (!s) return '';

  // 只取第一行 —— 模型爱在标题后面补解释
  s = s.split('\n')[0].trim();

  // 去掉常见包装：引号、书名号式前缀、Markdown、反引号、XML 标签
  s = s.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, '');
  s = s.replace(/^\**\s*|\s*\**$/g, '');
  s = s.replace(/^`+|`+$/g, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/^["'“”「『《]+|["'“”」』》]+$/g, '');
  s = s.replace(/[.。]$/, '');

  s = s.replace(/\s+/g, ' ').trim();

  // 兜底长度：模型不守规矩时按目标长度硬裁，避免侧栏被一句话撑爆
  if (utf8Bytes(s) > 200) s = clampBytes(s, 200);
  const target = targetLength(s, cfg);
  const count = looksCjk(s) ? [...s].length : s.split(/\s+/).filter(Boolean).length;
  if (count > target * 2) s = truncateToTarget(s, cfg);   // 明显超长才裁，别把合规标题切坏

  return s.slice(0, 80);
}

/** 系统提示词（照 DSH 的措辞结构） */
function systemPrompt(cfg) {
  return [
    'Create a concise title for a mathematical-modeling assistant session from the supplied user messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${cfg.targetWords} words in non-CJK languages or ${cfg.targetCjkCharacters} CJK characters.`,
  ].join('\n');
}

/**
 * 把消息框成 JSON 数组。
 * 关键：用户原文里出现引号、换行、甚至「忽略上面的指令」都只会成为
 * 一个被转义的字符串值，撑不破结构 —— 这是 DSH 防提示词注入的手法。
 */
function frameMessages(messages, cfg) {
  const arr = (messages || []).map((m) => ({ role: m.role || 'user', content: clampBytes(m.content, cfg.maxInputBytes) }));
  return `Generate the session title from this JSON array of user messages:\n${JSON.stringify(arr)}`;
}

/**
 * 本地兜底标题（不依赖网络）。
 *
 * 比原来的 slice(0,20) 好在三点：
 *  - 按标点/句子断，不会把「基于层次分析法的」切成半句
 *  - 跳过「附件1」「题目：」「## 」这类材料噪音行
 *  - 用同一套 CJK 感知长度
 */
function localTitle(text, cfg = DEFAULTS) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const NOISE = /^(?:附件|附录|图\s*\d|表\s*\d|题目|题干|问题\s*[一二三四五六1-9]\s*[：:]?|#{1,6}\s*|[-*•]\s+|>\s*)/i;
  const pick = lines.find((l) => !NOISE.test(l) && l.length > 3) || lines[0] || '';
  // 优先在标点处收口，读起来才像标题而不是被剪断的句子
  const cut = pick.split(/[。！？；!?;\n]/)[0].trim() || pick.trim();
  return cleanTitle(cut, cfg);
}

/**
 * 生成标题。失败时返回 { ok:false, code }，调用方保留本地兜底即可。
 *
 * @param {object} o
 * @param {object} o.config       readConfig() 的结果（provider/model/baseUrl/apiKey）
 * @param {Array}  o.messages     用户消息（通常只有第一条）
 * @param {Function} [o.chat]     注入用：替代真实 LLM 调用，便于离线测试
 * @param {number} [o.timeoutMs]  端到端 deadline
 * @param {number} [o.now]        测试用时间戳
 */
async function generateTitle({ config, messages, chat = streamChat, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const cfg = { ...DEFAULTS };
  if (!config || !config.apiKey || !config.model || !config.baseUrl) {
    return { ok: false, code: 'NO_CONFIG', error: '未配置 API Key 或模型' };
  }

  const framed = frameMessages(messages, cfg);
  const system = { role: 'system', content: systemPrompt(cfg) };
  const user = { role: 'user', content: framed };

  // 标题是辅助调用，绝不能把主对话拖住：独立 signal + 端到端 deadline。
  // maxTokens 压到 48：标题就一行字，多给只会让慢模型磨蹭。
  const callCfg = { ...config, maxTokens: cfg.maxOutputTokens, temperature: 0.2 };

  // 有些网关返回体是空的但流里有内容，所以两条都收
  let content = '';

  try {
    const out = await withDeadline(
      ({ signal }) => chat({
        config: callCfg,
        messages: [system, user],
        signal,
        onDelta: (t) => { content += t; },
      }),
      timeoutMs,
    );
    // 超时后 signal 已 abort，底层可能仍 resolve；settled 保证不覆盖已返回的失败
    const title = cleanTitle((out && out.content) || content, cfg);
    if (!title) return { ok: false, code: 'EMPTY', error: '模型未返回可用标题' };
    return { ok: true, title };
  } catch (err) {
    const code = err && err.code === TITLE_TIMEOUT_CODE ? TITLE_TIMEOUT_CODE : 'LLM_ERROR';
    return { ok: false, code, error: (err && err.message) || '生成失败' };
  }
}

/**
 * 给任意 promise 加端到端超时，并在超时时**取消底层请求**。
 *
 * 只 reject 不 abort 的话，那条 HTTP 连接会一直挂着跑完 ——
 * 标题这种"失败了就无所谓"的辅助调用最容易攒出一堆僵尸请求。
 * 错误带专用 code，让调用方能区分超时和其他失败（照 DSH 的 SESSION_TITLE_TIMEOUT）。
 *
 * @param {(o:{signal:AbortSignal})=>Promise} invoke 收到 signal 的调用函数
 * @param {number} ms
 */
function withDeadline(invoke, ms) {
  const ac = new AbortController();
  let settled = false;
  let timer = null;

  const finish = (fn, val) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn(val);
  };

  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      // 先 abort 再 reject：顺序反了的话请求可能已经发出去了
      try { ac.abort(); } catch { /* abort 失败不影响超时结论 */ }
      const e = new Error(`session title timed out after ${ms}ms`);
      e.code = TITLE_TIMEOUT_CODE;
      reject(e);
    }, ms);
    // 不 ref 住事件循环：标题这种辅助任务不该让进程多活一会儿
    if (typeof timer.unref === 'function') timer.unref();

    let p;
    try {
      p = invoke({ signal: ac.signal });
    } catch (err) {
      finish(reject, err);
      return;
    }
    if (!p || typeof p.then !== 'function') {
      finish(reject, new Error('session title chat() 未返回 Promise'));
      return;
    }
    p.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

module.exports = {
  TITLE_TIMEOUT_CODE,
  DEFAULTS,
  looksCjk,
  utf8Bytes,
  clampBytes,
  truncateToTarget,
  cleanTitle,
  systemPrompt,
  frameMessages,
  localTitle,
  generateTitle,
};
