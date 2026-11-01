'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProcess } = require('../agent/tools');
const { getPythonEnvDir } = require('../paths');

/** 按能力分组的依赖，避免一次性要求全部包 */
const PACKAGE_GROUPS = {
  core: [
    { pip: 'numpy', import: 'numpy', label: '数值计算' },
    { pip: 'scipy', import: 'scipy', label: '科学计算 / 优化' },
    { pip: 'pandas', import: 'pandas', label: '数据处理' },
  ],
  data: [
    { pip: 'openpyxl', import: 'openpyxl', label: 'Excel 读写' },
    { pip: 'pypdf', import: 'pypdf', label: 'PDF 解析' },
  ],
  visualization: [
    { pip: 'matplotlib', import: 'matplotlib', label: '绘图' },
  ],
  docx: [
    { pip: 'python-docx', import: 'docx', label: 'Word 文档' },
    // Word → PDF：走 Word COM（docx2pdf / pywin32）。
    // ⚠️ 缺了它，「生成 Word 论文 + 转 PDF」这一步只能退回 LibreOffice 或失败；
    // 之前依赖清单里没有它，装完环境才发现转不了 PDF。
    { pip: 'pywin32', import: 'win32com', label: 'Word 转 PDF（Windows）', optional: true },
  ],
  search: [
    { pip: 'requests', import: 'requests', label: '网络请求 / 论文检索' },
  ],
};

const ALL_GROUPS = Object.keys(PACKAGE_GROUPS);

/** 探测可用的系统 Python 解释器 */
async function detectPython() {
  const candidates = process.platform === 'win32' ? ['python', 'py -3', 'python3'] : ['python3', 'python'];
  const found = [];
  for (const cmd of candidates) {
    try {
      const r = await runProcess(`${cmd} -c "import sys;print(sys.version.split()[0]);print(sys.executable)"`, {
        cwd: process.cwd(),
        timeout: 15000,
        shell: true,
      });
      if (r.code === 0 && r.stdout.trim()) {
        const [version, exe] = r.stdout.trim().split(/\r?\n/);
        found.push({ command: cmd, version: version?.trim(), exe: exe?.trim(), venvPython: null });
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  // 优先返回已建好 venv 的
  const venv = getVenvPython();
  if (venv) found.unshift({ command: venv, version: null, exe: venv, venvPython: venv });
  return found;
}

function getVenvDir() {
  return getPythonEnvDir();
}

/**
 * Python 可执行文件是否存在且能真正启动。
 *
 * 只看 fs.existsSync 不够：venv 的 python.exe 只是一个启动器，
 * 它的母解释器被删除/移动后，文件仍然在，但一启动就报
 * “did not find executable at ...”。这会把整个依赖检查误判成全部缺失。
 */
function isPythonUsable(pythonPath) {
  const raw = String(pythonPath || '').trim();
  if (!raw) return false;
  const looksLikePath = path.isAbsolute(raw) || /[\\/]/.test(raw);
  if (looksLikePath && !fs.existsSync(raw)) return false;
  // 允许 "python" / "py -3" 这类命令名；绝对路径带空格时必须整体当一个参数。
  const parts = looksLikePath ? [raw] : raw.split(/\s+/).filter(Boolean);
  try {
    const r = spawnSync(parts[0], [...parts.slice(1), '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return r.status === 0 && Boolean(String(r.stdout || '').trim());
  } catch {
    return false;
  }
}

function getVenvPython({ validate = true } = {}) {
  const dir = getVenvDir();
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'Scripts', 'python.exe')]
      : [path.join(dir, 'bin', 'python3'), path.join(dir, 'bin', 'python')];
  return candidates.find((p) => fs.existsSync(p) && (!validate || isPythonUsable(p))) || null;
}

/**
 * 选一个能用的 Python：用户显式选择 > 可用 venv > PATH 里的 python。
 * 注意不能直接返回“存在但坏了”的 venv 路径。
 */
function resolvePythonPath(preferred = '') {
  if (preferred && isPythonUsable(preferred)) return preferred;
  const venv = getVenvPython();
  if (venv) return venv;
  return 'python';
}

/** 检查某个解释器里各分组的依赖是否齐备 */
async function checkPackages(pythonPath, groups = ALL_GROUPS) {
  const wanted = [];
  for (const g of groups) {
    for (const p of PACKAGE_GROUPS[g] || []) {
      if (!wanted.some((w) => w.import === p.import)) wanted.push(p);
    }
  }
  if (!wanted.length) return { ok: true, missing: [], installed: [] };

  const script = `import importlib.util, json, sys
pkgs = ${JSON.stringify(wanted.map((w) => ({ pip: w.pip, import: w.import, label: w.label })))}
missing, installed = [], []
for p in pkgs:
    try:
        ok = importlib.util.find_spec(p["import"]) is not None
    except Exception:
        ok = False
    (installed if ok else missing).append(p)
print(json.dumps({"missing": missing, "installed": installed, "python": sys.version.split()[0]}, ensure_ascii=False))
`;

  // 写成临时脚本再执行 —— 直接 `-c "多行脚本"` 在 Windows 下会被引号转义搞坏，
  // 命令失败后会被误判成"全部缺失"。
  const tmp = path.join(os.tmpdir(), `mcm-check-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(tmp, script, 'utf8');
  let r;
  try {
    r = await runProcess(`"${pythonPath}" "${tmp}"`, {
      cwd: path.dirname(tmp),
      timeout: 60000,
      shell: true,
    });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }

  if (r.code !== 0) {
    // 解释器启动失败 ≠ 所有包都缺失。分开报，避免把“母 Python 丢了”
    // 误显示成“9 个依赖一个都没有”。
    return { ok: false, error: r.stderr.trim() || `Python 解释器退出码 ${r.code}`, missing: [], installed: [] };
  }
  try {
    const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    const parsed = JSON.parse(last);
    return { ok: parsed.missing.length === 0, ...parsed };
  } catch (e) {
    return { ok: false, error: `解析检测结果失败：${e.message}`, missing: wanted, installed: [] };
  }
}

/** 用系统 Python 创建应用私有 venv（幂等） */
async function ensureVenv(basePython, onOutput) {
  const venvPython = getVenvPython();
  if (venvPython) return venvPython;

  const dir = getVenvDir();
  const existing = getVenvPython({ validate: false });
  if (existing) {
    // 旧 venv 的启动器还在但母 Python 已失效：先移走，避免在坏环境上覆盖安装。
    const broken = `${dir}.broken-${Date.now()}`;
    try {
      fs.renameSync(dir, broken);
      if (onOutput) onOutput({ stream: 'stdout', text: `旧 Python 环境无法启动，已移到：${broken}\n` });
    } catch (err) {
      throw new Error(`旧 Python 环境无法启动，且无法移走（${err.message}）。请关闭占用该目录的程序后重试。`);
    }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await runProcess(`"${basePython}" -m venv "${dir}"`, {
    cwd: process.cwd(),
    timeout: 180000,
    shell: true,
    onOutput,
  });
  if (r.code !== 0) throw new Error(`创建 Python 环境失败（退出码 ${r.code}）：\n${r.stderr.trim()}`);
  const created = getVenvPython();
  if (!created) throw new Error('venv 创建后未找到 python 可执行文件');
  return created;
}

/** 安装依赖到指定解释器 */
async function installPackages(pythonPath, groups, onOutput) {
  const wanted = [];
  for (const g of groups) {
    for (const p of PACKAGE_GROUPS[g] || []) {
      if (!wanted.some((w) => w.pip === p.pip)) wanted.push(p);
    }
  }
  if (!wanted.length) return { ok: true, installed: [] };

  const names = wanted.map((w) => w.pip);
  const mirror = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  const cmd = `"${pythonPath}" -m pip install --upgrade pip -i ${mirror} && "${pythonPath}" -m pip install ${names.join(' ')} -i ${mirror}`;
  const r = await runProcess(cmd, { cwd: process.cwd(), timeout: 900000, shell: true, onOutput });
  return { ok: r.code === 0, code: r.code, installed: names, stdout: r.stdout, stderr: r.stderr };
}

module.exports = {
  PACKAGE_GROUPS,
  ALL_GROUPS,
  detectPython,
  getVenvPython,
  getVenvDir,
  isPythonUsable,
  resolvePythonPath,
  checkPackages,
  ensureVenv,
  installPackages,
};
