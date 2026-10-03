'use strict';

/**
 * 工具层完整验证：7 个工具的正面用例 + 边界 + 路径沙箱。
 * 不依赖 Electron，可直接 node 运行。
 *
 * 用法：node scripts/test-tools.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeTool, TOOL_DEFS } = require('../src/main/agent/tools');

const WORKSPACE = path.join(os.tmpdir(), 'mcm-agent-tools-test');
const SKILLS_ROOT = path.join(__dirname, '..', 'resources', 'skills');

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
}

async function main() {
  // 干净工作区
  if (fs.existsSync(WORKSPACE)) {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKSPACE, { recursive: true });

  const ctx = {
    workspace: WORKSPACE,
    skillsRoot: SKILLS_ROOT,
    pythonPath: process.env.MCM_TEST_PYTHON || 'python',
  };

  check('工具定义数 = 7', TOOL_DEFS.length === 7, TOOL_DEFS.map((t) => t.function.name).join(','));

  /* ---------------- 1. write_file ---------------- */
  let r = await executeTool('write_file', { path: 'a/b/deep.txt', content: '第一行\n第二行\n第三行' }, ctx);
  check('write_file 自动建多级目录', fs.existsSync(path.join(WORKSPACE, 'a/b/deep.txt')), r);

  r = await executeTool('write_file', { path: 'dup.txt', content: 'X\nY\nX\n' }, ctx);
  check('write_file 写入含重复行文件', fs.readFileSync(path.join(WORKSPACE, 'dup.txt'), 'utf8') === 'X\nY\nX\n', r);

  /* ---------------- 2. read_file ---------------- */
  r = await executeTool('read_file', { path: 'a/b/deep.txt' }, ctx);
  check('read_file 带行号返回', /1\t第一行/.test(r) && /3\t第三行/.test(r), r.split('\n')[0]);

  r = await executeTool('read_file', { path: 'a/b/deep.txt', offset: 2, limit: 1 }, ctx);
  check('read_file offset/limit 生效', r.includes('第二行') && !r.includes('第一行'), '');

  // 读技能库（skills/ 前缀）
  r = await executeTool('read_file', { path: 'skills/scibox-diagram/SKILL.md', limit: 2 }, ctx);
  check('read_file 经 skills/ 前缀读技能库', r.includes('scibox-diagram') || r.includes('draw.io'), r.split('\n')[0].slice(0, 60));

  // 读不存在
  try {
    await executeTool('read_file', { path: 'nope.txt' }, ctx);
    check('read_file 不存在文件应报错', false, '未报错');
  } catch (e) {
    check('read_file 不存在文件应报错', /不存在/.test(e.message), e.message.slice(0, 40));
  }

  /* ---------------- 3. edit_file ---------------- */
  r = await executeTool('edit_file', { path: 'a/b/deep.txt', old_string: '第二行', new_string: 'SECOND' }, ctx);
  check('edit_file 唯一替换成功', fs.readFileSync(path.join(WORKSPACE, 'a/b/deep.txt'), 'utf8').includes('SECOND'), r);

  try {
    await executeTool('edit_file', { path: 'dup.txt', old_string: 'X', new_string: 'Z' }, ctx);
    check('edit_file 非唯一应拒绝', false, '未拒绝');
  } catch (e) {
    check('edit_file 非唯一应拒绝', /不唯一|出现 2 次/.test(e.message), e.message.slice(0, 50));
  }

  r = await executeTool('edit_file', { path: 'dup.txt', old_string: 'X', new_string: 'Z', replace_all: true }, ctx);
  check('edit_file replace_all 替换全部', fs.readFileSync(path.join(WORKSPACE, 'dup.txt'), 'utf8') === 'Z\nY\nZ\n', r);

  try {
    await executeTool('edit_file', { path: 'a/b/deep.txt', old_string: '不存在的字符串', new_string: 'x' }, ctx);
    check('edit_file 找不到原文应报错', false, '未报错');
  } catch (e) {
    check('edit_file 找不到原文应报错', /未在文件中找到/.test(e.message), e.message.slice(0, 50));
  }

  /* ---------------- 4. list_files ---------------- */
  r = await executeTool('list_files', { pattern: '**/*.txt' }, ctx);
  check('list_files glob 递归匹配', r.includes('deep.txt') && r.includes('dup.txt'), r.split('\n')[0]);

  r = await executeTool('list_files', { pattern: 'a/**' }, ctx);
  check('list_files 子目录 glob', r.includes('deep.txt'), r.split('\n')[0]);

  r = await executeTool('list_files', { pattern: 'zzz/*.nothing' }, ctx);
  check('list_files 无匹配返回提示', /未匹配到/.test(r), r.slice(0, 40));

  /* ---------------- 5. search_text ---------------- */
  await executeTool('write_file', { path: 'src/code.py', content: 'import numpy as np\n\ndef solve():\n    return np.array([1, 2, 3])\n' }, ctx);
  await executeTool('write_file', { path: 'src/note.md', content: '# 说明\n这里提到 numpy 和 pandas\n' }, ctx);

  r = await executeTool('search_text', { pattern: 'numpy' }, ctx);
  check('search_text 跨文件命中', r.includes('code.py') && r.includes('note.md'), r.split('\n').length + ' 行');

  r = await executeTool('search_text', { pattern: 'numpy', glob: '*.py' }, ctx);
  check('search_text glob 过滤生效', r.includes('code.py') && !r.includes('note.md'), r.split('\n')[0]);

  r = await executeTool('search_text', { pattern: 'def\\s+solve' }, ctx);
  check('search_text 支持正则', r.includes('code.py'), r.split('\n')[0]);

  r = await executeTool('search_text', { pattern: '绝对不存在的词xyzzy' }, ctx);
  check('search_text 无命中返回提示', /未找到匹配/.test(r), r.slice(0, 40));

  try {
    await executeTool('search_text', { pattern: '([unclosed' }, ctx);
    check('search_text 非法正则应报错', false, '未报错');
  } catch (e) {
    check('search_text 非法正则应报错', /正则无效/.test(e.message), e.message.slice(0, 40));
  }

  /* ---------------- 6. run_command ---------------- */
  r = await executeTool('run_command', { command: 'echo hello-cmd' }, ctx);
  check('run_command 正常执行', r.includes('hello-cmd') && /退出码：0/.test(r), r.split('\n')[0]);

  r = await executeTool('run_command', { command: 'exit 3' }, ctx);
  check('run_command 透传非零退出码', /退出码：3/.test(r), r.split('\n')[0]);

  r = await executeTool('run_command', { command: 'node -e "console.error(123)"' }, ctx);
  check('run_command 捕获 stderr', r.includes('123') && r.includes('stderr'), '');

  r = await executeTool('run_command', { command: 'echo in-sub', cwd: 'a' }, ctx);
  check('run_command 支持 cwd', /退出码：0/.test(r), r.split('\n')[0]);

  /* ---------------- 7. run_python ---------------- */
  r = await executeTool('run_python', { code: 'print(2 ** 10)' }, ctx);
  check('run_python 执行代码片段', r.includes('1024'), r.split('\n')[0]);

  r = await executeTool('run_python', { code: 'import sys; print(sys.version.split()[0])' }, ctx);
  check('run_python 输出 Python 版本', /3\.\d+/.test(r), (r.match(/3\.\d+\.\d+/) || [''])[0]);

  await executeTool('write_file', { path: 'calc.py', content: 'import sys\nprint("args:", sys.argv[1:])\n' }, ctx);
  r = await executeTool('run_python', { script: 'calc.py', args: ['--q', '1'] }, ctx);
  check('run_python 执行脚本并传参', r.includes('--q') && r.includes('1'), r.split('\n')[1] || '');

  r = await executeTool('run_python', { code: 'raise ValueError("boom")' }, ctx);
  check('run_python 透传异常与退出码', r.includes('ValueError') && !/退出码：0/.test(r), '');

  try {
    await executeTool('run_python', {}, ctx);
    check('run_python 缺参应报错', false, '未报错');
  } catch (e) {
    check('run_python 缺参应报错', /必须提供/.test(e.message), e.message.slice(0, 40));
  }

  /* ---------------- 8. 路径沙箱 ---------------- */
  const escapes = [
    ['write_file', { path: '../escape.txt', content: 'x' }],
    ['write_file', { path: 'a/../../escape2.txt', content: 'x' }],
    ['read_file', { path: '../../Windows/win.ini' }],
    ['edit_file', { path: '../escape.txt', old_string: 'a', new_string: 'b' }],
  ];
  for (const [tool, args] of escapes) {
    try {
      await executeTool(tool, args, ctx);
      check(`${tool} 越界应被拦（${args.path}）`, false, '未拦截');
    } catch (e) {
      check(`${tool} 越界应被拦（${args.path}）`, /越界/.test(e.message), e.message.slice(0, 40));
    }
  }

  // 绝对路径越界
  try {
    await executeTool('write_file', { path: 'C:\\Windows\\Temp\\evil.txt', content: 'x' }, ctx);
    check('绝对路径越界应被拦', false, '未拦截');
  } catch (e) {
    check('绝对路径越界应被拦', /越界/.test(e.message), e.message.slice(0, 40));
  }

  // 技能库只读：写 skills/ 前缀应被拒
  try {
    await executeTool('write_file', { path: 'skills/scibox-diagram/evil.txt', content: 'x' }, ctx);
    check('技能库应只读（写被拒）', false, '未拒绝');
  } catch (e) {
    check('技能库应只读（写被拒）', /只读/.test(e.message), e.message.slice(0, 50));
  }

  // 拒绝后不应在工作区留下 skills/ 目录
  check('拒绝后未在工作区留下 skills/ 目录', !fs.existsSync(path.join(WORKSPACE, 'skills')), '');

  try {
    await executeTool('edit_file', { path: 'skills/scibox-diagram/SKILL.md', old_string: 'a', new_string: 'b' }, ctx);
    check('技能库应只读（编辑被拒）', false, '未拒绝');
  } catch (e) {
    check('技能库应只读（编辑被拒）', /只读/.test(e.message), e.message.slice(0, 50));
  }

  /* ---------------- 9. 超时保护 ---------------- */
  const t0 = Date.now();
  r = await executeTool('run_command', { command: 'node -e "setTimeout(()=>{},60000)"', timeout: 2000 }, ctx);
  const elapsed = Date.now() - t0;
  check('run_command 超时被强杀', elapsed < 20000 && /超时被终止/.test(r), `${elapsed} ms`);

  /* ---------------- 输出 ---------------- */
  const pass = checks.filter((c) => c.pass).length;
  console.log('');
  console.log('=== 工具层验证 ===');
  for (const c of checks) {
    console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
  }
  console.log('');
  console.log(`结果：${pass}/${checks.length} 通过`);

  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err.stack || err.message);
  process.exit(1);
});
