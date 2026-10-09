'use strict';

/**
 * 技能脚本「两条执行路径」自检。
 *
 * 为什么必须单独测：技能文档统一写成 `python "%MCM_SKILL_ROOT%/mcm-diagram/scripts/x.py"`，
 * 但这句命令可能被模型用两种方式执行，而它们的机制完全不同：
 *   · run_command（字符串）→ 走 shell，由 **cmd 展开 %VAR%**
 *   · run_python（argv）  → **不经过 shell**，%VAR% 不会被展开
 * 只在纯 Node 里测会得到假象：getSkillsRoot() 依赖 electron 的 app，
 * 取不到值时变量为空、cmd 把 `%MCM_SKILL_ROOT%` 展开成空串，
 * 看起来像"文档写法坏了"，其实是测试环境问题（本轮实测踩过）。
 * 所以必须在真实 Electron 主进程里跑。
 *
 * 用法：npm run selftest:runtimes
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  const { executeTool } = require('../src/main/agent/tools');
  const { getSkillsRoot } = require('../src/main/paths');

  const skillsRoot = getSkillsRoot();
  const ws = path.join(os.tmpdir(), `mcm-rt-${Date.now()}`);
  fs.mkdirSync(ws, { recursive: true });
  const ctx = { workspace: ws, skillsRoot };

  console.log('skillsRoot =', skillsRoot);
  console.log('workspace  =', ws);
  console.log('');

  const SCRIPT = 'mcm-diagram/scripts/check_layout.py';
  const cases = [
    ['run_command + %MCM_SKILL_ROOT%（cmd 展开）', 'run_command',
      { command: `python "%MCM_SKILL_ROOT%/${SCRIPT}" --help` }],
    ['run_command + 绝对路径', 'run_command',
      { command: `python "${path.join(skillsRoot, SCRIPT)}" --help` }],
    ['run_python + %MCM_SKILL_ROOT%（不经 shell）', 'run_python',
      { script: `%MCM_SKILL_ROOT%/${SCRIPT}`, args: ['--help'] }],
    ['run_python + skills/ 前缀', 'run_python',
      { script: `skills/${SCRIPT}`, args: ['--help'] }],
    ['run_python + 绝对路径', 'run_python',
      { script: path.join(skillsRoot, SCRIPT), args: ['--help'] }],
  ];

  let pass = 0;
  let fail = 0;
  for (const [label, tool, args] of cases) {
    try {
      const r = await executeTool(tool, args, ctx);
      const ok = /usage:/.test(String(r));
      console.log(`${ok ? '✓' : '✗'} ${label}`);
      if (!ok) console.log('    ' + String(r).split('\n').slice(0, 3).join(' | ').slice(0, 160));
      if (ok) pass += 1; else fail += 1;
    } catch (e) {
      console.log(`✗ ${label}\n    抛错: ${e.message.slice(0, 140)}`);
      fail += 1;
    }
  }

  // 安全回归：越界必须仍被拦（新增前缀解析不能把沙箱打开）
  console.log('\n=== 越界防护（新增解析不能开洞）===');
  for (const [label, script] of [
    ['../../evil.py', '../../evil.py'],
    ['%MCM_SKILL_ROOT%/../evil.py', '%MCM_SKILL_ROOT%/../evil.py'],
    ['skills/../../evil.py', 'skills/../../evil.py'],
    ['%MCM_SKILL_ROOT%/../../outside.py', '%MCM_SKILL_ROOT%/../../outside.py'],
  ]) {
    try {
      const r = await executeTool('run_python', { script, args: [] }, ctx);
      const blocked = /越界|不存在/.test(String(r));
      console.log(`${blocked ? '✓' : '✗'} ${label} → ${String(r).split('\n')[0].slice(0, 80)}`);
      if (blocked) pass += 1; else fail += 1;
    } catch (e) {
      const blocked = /越界|不存在/.test(e.message);
      console.log(`${blocked ? '✓' : '✗'} ${label} → ${e.message.slice(0, 80)}`);
      if (blocked) pass += 1; else fail += 1;
    }
  }

  fs.rmSync(ws, { recursive: true, force: true });
  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  app.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error('自检异常:', err && err.stack ? err.stack : err);
  app.exit(1);
});
