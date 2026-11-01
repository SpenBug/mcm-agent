'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getConfigPath, getDefaultWorkspace } = require('./paths');

/** 内置服务商预设（全部走 OpenAI 兼容协议） */
const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'moonshot', label: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k'] },
  { id: 'dashscope', label: '通义千问 阿里云', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen3-coder-plus', 'qwen-plus'] },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'] },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2-Exp', 'Qwen/Qwen3-235B-A22B-Instruct-2507'] },
  { id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3:32b', 'deepseek-r1:14b', 'llama3.3'] },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', models: [] },
];

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  // 当前会话使用的模型。model / models[0] 是设置页里的主模型，
  // chatModel 允许用户不改主模型、直接在输入框右下角临时切换。
  chatModel: '',
  // 仅对支持 OpenAI 兼容 reasoning_effort 的模型生效。
  // auto = 不向服务端传该字段，避免不支持的网关直接 400。
  reasoningEffort: 'auto',
  // 已勾选的模型（多选）。空数组 = 未配置过，界面引导去勾；
  // 非空时 model 是其中第一个（主模型），其余作为备选。
  models: [],
  temperature: 0.3,
  maxTokens: 8192,
  // 上次成功拉到的模型列表（断网时设置页也能显示）。
  // 由 config:listModels 写入，渲染层只在拉取失败时读取它兜底。
  knownModels: [],
  workspace: '',
  maxIterations: 80,
  pythonPath: '',
  lastProject: '',
  theme: 'dark',      // 由渲染进程写入，主进程用它决定窗口底色（避免启动闪色）
  currentCompetition: '',   // 当前赛事 id（'' = 自动取最近一场报名中的赛事）
};

let cache = null;

const REASONING_EFFORTS = ['auto', 'low', 'medium', 'high'];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** 思考强度白名单。未知值一律回退到 auto，避免把脏配置发给服务商。 */
function normalizeReasoningEffort(value) {
  const v = String(value || '').trim().toLowerCase();
  return REASONING_EFFORTS.includes(v) ? v : 'auto';
}

function readConfig() {
  if (cache) return cache;
  const file = getConfigPath();
  let stored = {};
  try {
    if (fs.existsSync(file)) {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error('[config] 读取失败，使用默认值:', err.message);
    stored = {};
  }
  cache = { ...DEFAULT_CONFIG, ...stored };
  if (!cache.workspace) cache.workspace = getDefaultWorkspace();
  // model 与 models 必须一致。磁盘上可能出现「models 有值但 model 为空」
  // （老配置迁移、用户手改过 config.json）—— 那种情况下 chat:send 的
  // `!cfg.model` 门禁会把已配好的用户误拦成「尚未选择模型」。
  if (!cache.model && cache.models?.length) {
    cache.model = normalizeModels(cache)[0];
  }
  // 老配置没有 chatModel：默认跟随主模型，保证升级后行为不变。
  if (typeof cache.chatModel !== 'string' || !cache.chatModel.trim()) {
    cache.chatModel = normalizeModels(cache)[0] || cache.model || '';
  } else {
    cache.chatModel = cache.chatModel.trim();
  }
  cache.reasoningEffort = normalizeReasoningEffort(cache.reasoningEffort);
  return cache;
}

/** 返回给渲染进程的配置（脱敏：不返回完整 key，只返回是否已配置 + 尾号） */
function publicConfig() {
  const c = readConfig();
  const list = normalizeModels(c);
  const active = activeModel(c);
  return {
    ...c,
    // 抹平成数组，渲染层不用判 undefined
    models: list,
    chatModel: active,
    activeModel: active,
    reasoningEffort: normalizeReasoningEffort(c.reasoningEffort),
    apiKey: undefined,
    hasApiKey: Boolean(c.apiKey && c.apiKey.trim()),
    apiKeyTail: c.apiKey ? c.apiKey.slice(-4) : '',
  };
}

/**
 * 把配置里的 models 归一成字符串数组。
 * 老配置只有 model 单值 → 转成 [model]，保证升级后勾选状态不丢。
 */
function normalizeModels(c) {
  const arr = Array.isArray(c.models) ? c.models.filter((m) => typeof m === 'string' && m.trim()) : [];
  if (arr.length) return arr;
  const one = typeof c.model === 'string' ? c.model.trim() : '';
  return one ? [one] : [];
}

/**
 * 当前生效的模型：勾选列表的第一个。
 * 渲染层与 loop.js 都从这里取，避免两边各存一份而漂移。
 */
function activeModel(c = readConfig()) {
  const list = normalizeModels(c);
  const selected = typeof c.chatModel === 'string' ? c.chatModel.trim() : '';
  return selected || list[0] || c.model || '';
}

/**
 * 写配置时保持 models 与 model 同步（model 始终是列表第一个）。
 * chatModel 是「当前聊天使用哪一个」，可以与主模型不同。
 */
function writeConfig(patch) {
  const base = readConfig();
  const next = { ...base, ...patch };
  if (Array.isArray(next.models)) {
    next.models = next.models.filter((m) => typeof m === 'string' && m.trim());
    if (next.models.length) {
      next.model = next.models[0];
    } else if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
      // 显式清空模型列表时，patch.model 才是真源。
      // 旧实现这里回退 base.model，导致「清空列表」和测试恢复配置时
      // 把上一轮的临时模型名重新写回来。
      next.model = typeof patch.model === 'string' ? patch.model.trim() : '';
    } else {
      next.model = base.model || '';
    }
  }
  next.chatModel = typeof next.chatModel === 'string' && next.chatModel.trim()
    ? next.chatModel.trim()
    : (normalizeModels(next)[0] || next.model || '');
  next.reasoningEffort = normalizeReasoningEffort(next.reasoningEffort);
  cache = next;
  const file = getConfigPath();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  PROVIDERS, DEFAULT_CONFIG, readConfig, writeConfig, publicConfig,
  normalizeModels, activeModel, normalizeReasoningEffort, REASONING_EFFORTS,
};
