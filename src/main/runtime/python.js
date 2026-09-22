'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function getVenvPython() {
  const dir = getVenvDir();
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'Scripts', 'python.exe')]
      : [path.join(dir, 'bin', 'python3'), path.join(dir, 'bin', 'python')];
  return candidates.find((p) => fs.existsSync(p)) || null;
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
    return { ok: false, error: r.stderr.trim() || `退出码 ${r.code}`, missing: wanted, installed: [] };
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
  checkPackages,
  ensureVenv,
  installPackages,
};
