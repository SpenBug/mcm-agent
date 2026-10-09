#!/usr/bin/env node
'use strict';

/**
 * 把技能库里的「相对路径 / python3 调脚本」统一成 `%MCM_SKILL_ROOT%` 绝对写法。
 *
 * 为什么是真 bug（三方冲突，全部实测确认）：
 *   1. tools.js：run_command / run_python 的 cwd = **工作区**（不是技能目录）
 *   2. prompt.js 的路径契约明确写着"shell 的 cwd 是工作区，写相对路径会找不到"
 *   3. 但技能文档/脚本注释里有 30+ 处 `python3 scripts/xxx.py`
 * 实测：工作区 cwd 下 `python scripts/check_layout.py` → exit=2 找不到文件；
 *      `python "%MCM_SKILL_ROOT%/mcm-diagram/scripts/check_layout.py"` → exit=0。
 *
 * 另外本机 `python3` 是 WindowsApps 的 **0 字节占位器**（跑起来报
 * "cannot find the file"、exit=1），只有 `python` 是真解释器（3.12.4）。
 * 所以调用示例必须写 `python`。**shebang 不动** —— `#!/usr/bin/env python3`
 * 是 POSIX 标准，且在 Windows 上由 `python` 启动时会被忽略。
 *
 * 覆盖三类（前两类是上一版脚本漏掉的）：
 *   A. .md 代码块里的 `python3 scripts/x.py`
 *   B. .md 行内反引号里的 `` `python3 scripts/x.py ...` `` ← 上一版因
 *      `(?:^|\s)` 不匹配反引号而整类漏掉
 *   C. .py docstring 里的 Usage 示例 ← 上一版只走 .md，整类没管
 *
 * 用法：
 *   node scripts/fix-skill-relpaths.js          # 写入
 *   node scripts/fix-skill-relpaths.js --check  # 只校验（CI / npm test）
 *   node scripts/fix-skill-relpaths.js --dry    # 只报将改什么
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'resources', 'skills');
const CHECK = process.argv.includes('--check');
const DRY = !CHECK && process.argv.includes('--dry');

const SKILL_DIRS = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('mcm-'))
  .map((e) => e.name);

/** 每个技能 scripts/ 下的真实脚本名（用于校验引用是否有效） */
const SCRIPTS = {};
for (const s of SKILL_DIRS) {
  const dir = path.join(SKILLS, s, 'scripts');
  SCRIPTS[s] = fs.existsSync(dir)
    ? new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.py')))
    : new Set();
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(md|py)$/.test(e.name)) out.push(p);
  }
  return out;
}

function skillOf(file) {
  const parts = path.relative(SKILLS, file).split(path.sep);
  return SKILL_DIRS.includes(parts[0]) ? parts[0] : null;
}

/** 引号闭合：路径以 .py 结尾，其后是空格/行尾/反引号/注释符 */
function closeQuote(s) {
  return s.replace(/("%MCM_SKILL_ROOT%\/[^\s"`)]+\.py)(?=[\s`)#,;]|$)/g, '$1"');
}

/**
 * 重写一行。
 * @returns {{line:string, changed:boolean, warn:string|null}}
 */
function rewriteLine(line, skill) {
  const warn = null;
  if (!skill) return { line, changed: false, warn };

  // shebang 不动（POSIX 标准；Windows 下由 python 启动时被忽略）
  if (/^\s*#!/.test(line)) return { line, changed: false, warn };

  // 已经写过环境变量的行：只确保引号闭合，不做二次替换（幂等）
  if (line.includes('%MCM_SKILL_ROOT%')) {
    const fixed = closeQuote(line);
    return { line: fixed, changed: fixed !== line, warn };
  }

  let out = line;

  // A/B：`scripts/x.py` → `"%MCM_SKILL_ROOT%/<skill>/scripts/x.py"`
  // 允许前置字符是行首、空白、反引号、冒号（覆盖行内反引号示例）
  out = out.replace(
    /(^|[\s`：:])(?:python3?|py)(\s+)(?:\.\/)?scripts\/([\w.-]+\.py)/g,
    (m, pre, sp, name) => `${pre}python${sp}"%MCM_SKILL_ROOT%/${skill}/scripts/${name}`,
  );

  // C：.py docstring 里的 `python3 x.py`（x.py 是本技能 scripts/ 下真实存在的脚本）
  out = out.replace(
    /(^|[\s`])(?:python3?|py)(\s+)([\w.-]+\.py)/g,
    (m, pre, sp, name) => (SCRIPTS[skill].has(name)
      ? `${pre}python${sp}"%MCM_SKILL_ROOT%/${skill}/scripts/${name}`
      : m),   // 不是本技能脚本（如用户自己的 code/preprocess.py）→ 原样保留
  );

  out = closeQuote(out);
  return { line: out, changed: out !== line, warn };
}

let changedFiles = 0;
let changedLines = 0;

for (const file of walk(SKILLS)) {
  const skill = skillOf(file);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let local = 0;
  const out = lines.map((l) => {
    const r = rewriteLine(l, skill);
    if (r.changed) local += 1;
    return r.line;
  });
  if (!local) continue;

  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  console.log(`${CHECK ? '✗ ' : DRY ? '[dry] ' : ''}${rel}  → ${local} 行`);
  if (!DRY && !CHECK) fs.writeFileSync(file, out.join('\n'), 'utf8');
  changedFiles += 1;
  changedLines += local;
}

if (CHECK) {
  if (changedFiles) {
    console.log(`\n✗ ${changedFiles} 个文件 / ${changedLines} 行写法不合规 —— 模型照抄会 No such file`);
    console.log('  修复：node scripts/fix-skill-relpaths.js');
    process.exit(1);
  }
  console.log('\n✓ 技能库路径写法合规（%MCM_SKILL_ROOT% 绝对路径 + python）');
  process.exit(0);
}

console.log(`\n${DRY ? '将修改' : '已修改'} ${changedFiles} 个文件 / ${changedLines} 行`);

if (DRY) {
  // dry 模式不能跑残留检查：文件没写入，当然还残留
  console.log('\n（dry 模式：跳过自检）');
  process.exit(0);
}

// ---------- 自检 ----------
let bad = 0;
for (const file of walk(SKILLS)) {
  const s = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (s.includes('\uFFFD')) { console.log(`✗ 编码损坏：${rel}`); bad += 1; }

  s.split('\n').forEach((l, i) => {
    if (/^\s*#!/.test(l)) return;   // shebang 合法
    // 残留的 python3 调用（排除 shebang 与纯说明性英文注释）
    if (/(?:python3)\s+[\w./%-]*\.py/.test(l) && !/python3\s*$/.test(l)) {
      console.log(`✗ 仍有 python3 调用：${rel}:${i + 1}  ${l.trim().slice(0, 90)}`);
      bad += 1;
    }
    if (/(?:python3?|py)\s+(?:\.\/)?scripts\//.test(l) && !l.includes('%MCM_SKILL_ROOT%')) {
      console.log(`✗ 仍有相对 scripts/：${rel}:${i + 1}  ${l.trim().slice(0, 90)}`);
      bad += 1;
    }
    const m = l.match(/"%MCM_SKILL_ROOT%\/[^\s"`)]+\.py(?!")/);
    if (m) { console.log(`✗ 引号未闭合：${rel}:${i + 1}  ${l.trim().slice(0, 90)}`); bad += 1; }
  });
}
console.log(bad ? `\n✗ 自检失败 ${bad} 项` : '\n✓ 自检通过：无 python3 调用、无相对路径、引号成对、无编码损坏');
process.exit(bad ? 1 : 0);
