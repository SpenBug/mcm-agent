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
  temperature: 0.3,
  maxTokens: 8192,
  workspace: '',
  autoApprove: true,
  maxIterations: 80,
  pythonPath: '',
  lastProject: '',
};

let cache = null;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
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
  return cache;
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  cache = next;
  const file = getConfigPath();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 返回给渲染进程的配置（脱敏：不返回完整 key，只返回是否已配置 + 尾号） */
function publicConfig() {
  const c = readConfig();
  return {
    ...c,
    apiKey: undefined,
    hasApiKey: Boolean(c.apiKey && c.apiKey.trim()),
    apiKeyTail: c.apiKey ? c.apiKey.slice(-4) : '',
  };
}

module.exports = { PROVIDERS, DEFAULT_CONFIG, readConfig, writeConfig, publicConfig };
