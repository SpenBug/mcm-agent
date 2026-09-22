'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 180000;
const MAX_TIMEOUT = 900000;

/* ------------------------------------------------------------------ */
/* 路径安全                                                            */
/* ------------------------------------------------------------------ */

function resolveInside(root, target, label) {
  const abs = path.resolve(root, target || '.');
  const rel = path.relative(root, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
  throw new Error(`${label} 越界：${target} 不在允许范围内（${root}）`);
}

/**
 * 写操作禁止使用 skills/ 前缀。
 * 该前缀是给读操作指向只读技能库用的；写操作若放行，会在工作区里悄悄建一个
 * 同名 skills/ 目录，让 Agent 误以为改了技能库。
 */
function assertNotSkillsPath(target) {
  if (/^skills[\\/]/i.test(String(target || ''))) {
    throw new Error('技能库是只读的，不能写 skills/ 路径。产物请写到工作区的其他路径。');
  }
}

/* ------------------------------------------------------------------ */
/* 工具定义（OpenAI function calling schema）                          */
/* ------------------------------------------------------------------ */

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文本文件内容。用于读题目、技能文档、代码、报告、结果文件。返回带行号的内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径。相对路径基于工作区；技能文件用 skills/<技能名>/... 前缀' },
          offset: { type: 'integer', description: '起始行号（从 1 开始），可选' },
          limit: { type: 'integer', description: '最多读取行数，可选，默认 2000' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入（覆盖）文件。用于产出代码、报告、配置、content JSON 等。目录不存在会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确替换文件中的一段文本。old_string 必须在文件中唯一出现。用于局部修改，比整体重写更安全。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文（需唯一）' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '按 glob 模式列出文件或目录。例如 "**/*.py"、"figures/*"、"reports" 。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，相对工作区' },
          root: { type: 'string', description: '搜索起点，可选，默认工作区根目录' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '在文件中按正则搜索文本，返回匹配的文件与行号。用于查找定义、引用、关键词。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          root: { type: 'string', description: '搜索起点，可选，默认工作区' },
          glob: { type: 'string', description: '限定文件类型，如 "*.py"，可选' },
          max_results: { type: 'integer', description: '最多返回条数，默认 60' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作区执行 shell 命令（Windows 下为 cmd/PowerShell 兼容命令）。用于调用技能自带的 Python 脚本、编译、导出等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录，相对工作区，可选' },
          timeout: { type: 'integer', description: '超时毫秒数，默认 180000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description: '执行 Python 代码片段或脚本文件。会自动使用应用配置的 Python 解释器。用于快速验证算法、画图、处理数据。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 Python 代码（与 script 二选一）' },
          script: { type: 'string', description: '要执行的脚本路径，相对工作区（与 code 二选一）' },
          args: { type: 'array', items: { type: 'string' }, description: '传给脚本的命令行参数，可选' },
          timeout: { type: 'integer', description: '超时毫秒数，默认 180000' },
        },
        required: [],
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* 执行器                                                              */
/* ------------------------------------------------------------------ */

function truncate(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n\n...（输出过长，已截断，共 ${s.length} 字符）`;
}

function runProcess(command, { cwd, timeout, shell, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: shell ?? true,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }, Math.min(Math.max(timeout || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT));

    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      stdout += s;
      if (onOutput) onOutput({ stream: 'stdout', text: s });
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      if (onOutput) onOutput({ stream: 'stderr', text: s });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, killed });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, killed });
    });
  });
}

function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else out.push(full);
  }
}

function globToRegExp(pattern) {
  let re = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (p[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('.+^$(){}|[]'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`, 'i');
}

async function executeTool(name, args, ctx) {
  const { workspace, skillsRoot, onOutput, pythonPath } = ctx;
  const a = args || {};

  /** 解析路径：skills/ 前缀 → 技能目录（只读） */
  const resolveRead = (p) => {
    const raw = String(p || '');
    if (raw.startsWith('skills/') || raw.startsWith('skills\\')) {
      return resolveInside(skillsRoot, raw.replace(/^skills[\\/]/, ''), '技能目录读取');
    }
    return resolveInside(workspace, raw, '读取');
  };

  switch (name) {
    case 'read_file': {
      const abs = resolveRead(a.path);
      if (!fs.existsSync(abs)) throw new Error(`文件不存在：${a.path}`);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) throw new Error(`${a.path} 是目录，请用 list_files`);
      if (stat.size > 5 * 1024 * 1024) throw new Error(`文件过大（${(stat.size / 1048576).toFixed(1)}MB），请分段读取`);
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split(/\r?\n/);
      const offset = Math.max(1, a.offset || 1);
      const limit = a.limit || 2000;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
      const head = `文件：${path.relative(workspace, abs) || abs}（共 ${lines.length} 行）\n`;
      return truncate(head + numbered);
    }

    case 'write_file': {
      assertNotSkillsPath(a.path);
      const abs = resolveInside(workspace, a.path, '写入');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, a.content ?? '', 'utf8');
      const size = fs.statSync(abs).size;
      return `已写入 ${path.relative(workspace, abs)}（${size} 字节）`;
    }

    case 'edit_file': {
      assertNotSkillsPath(a.path);
      const abs = resolveInside(workspace, a.path, '编辑');
      if (!fs.existsSync(abs)) throw new Error(`文件不存在：${a.path}`);
      const text = fs.readFileSync(abs, 'utf8');
      const oldStr = a.old_string ?? '';
      const occurrences = text.split(oldStr).length - 1;
      if (occurrences === 0) throw new Error('old_string 未在文件中找到，请先 read_file 核对原文');
      if (occurrences > 1 && !a.replace_all) {
        throw new Error(`old_string 出现 ${occurrences} 次，不唯一。请补充上下文或设置 replace_all`);
      }
      const next = a.replace_all ? text.split(oldStr).join(a.new_string ?? '') : text.replace(oldStr, a.new_string ?? '');
      fs.writeFileSync(abs, next, 'utf8');
      return `已更新 ${path.relative(workspace, abs)}（替换 ${a.replace_all ? occurrences : 1} 处）`;
    }

    case 'list_files': {
      const root = a.root ? resolveRead(a.root) : workspace;
      const re = globToRegExp(a.pattern);
      const all = [];
      walk(root, all);
      const hits = all.filter((f) => re.test(path.relative(root, f).replace(/\\/g, '/')));
      if (!hits.length) return `未匹配到文件：${a.pattern}`;
      return truncate(
        `匹配 ${hits.length} 个：\n` + hits.slice(0, 300).map((f) => path.relative(workspace, f)).join('\n')
      );
    }

    case 'search_text': {
      const root = a.root ? resolveRead(a.root) : workspace;
      let re;
      try {
        re = new RegExp(a.pattern, 'i');
      } catch (e) {
        throw new Error(`正则无效：${e.message}`);
      }
      const globRe = a.glob ? globToRegExp(a.glob) : null;
      const all = [];
      walk(root, all);
      const max = a.max_results || 60;
      const out = [];
      for (const f of all) {
        if (globRe && !globRe.test(path.basename(f))) continue;
        if (/\.(png|jpg|jpeg|pdf|zip|xlsx|docx|pptx|npy|exe|dll)$/i.test(f)) continue;
        let text;
        try {
          if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
          text = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            out.push(`${path.relative(workspace, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (out.length >= max) break;
          }
        }
        if (out.length >= max) break;
      }
      return out.length ? truncate(out.join('\n')) : `未找到匹配：${a.pattern}`;
    }

    case 'run_command': {
      const cwd = a.cwd ? resolveInside(workspace, a.cwd, '工作目录') : workspace;
      const r = await runProcess(a.command, { cwd, timeout: a.timeout, shell: true, onOutput });
      const parts = [`退出码：${r.code}${r.killed ? '（超时被终止）' : ''}`];
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trim()}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trim()}`);
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(无输出)');
      return truncate(parts.join('\n'));
    }

    case 'run_python': {
      const py = pythonPath || 'python';
      let cmd;
      if (a.script) {
        const abs = resolveInside(workspace, a.script, '脚本');
        if (!fs.existsSync(abs)) throw new Error(`脚本不存在：${a.script}`);
        const extra = Array.isArray(a.args) ? a.args.map((x) => `"${x}"`).join(' ') : '';
        cmd = `"${py}" "${abs}" ${extra}`.trim();
      } else if (a.code) {
        const tmp = path.join(workspace, '.mcm-agent', `snippet_${Date.now()}.py`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, a.code, 'utf8');
        cmd = `"${py}" "${tmp}"`;
      } else {
        throw new Error('必须提供 code 或 script');
      }
      const r = await runProcess(cmd, { cwd: workspace, timeout: a.timeout, shell: true, onOutput });
      const parts = [`退出码：${r.code}${r.killed ? '（超时被终止）' : ''}`];
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trim()}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trim()}`);
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(无输出)');
      return truncate(parts.join('\n'));
    }

    default:
      throw new Error(`未知工具：${name}`);
  }
}

module.exports = { TOOL_DEFS, executeTool, runProcess };
