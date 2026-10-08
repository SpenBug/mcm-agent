/**
 * 路径解析测试：read_file 对技能库的四种写法都要能正确处理。
 * 复现用户遇到的「越界」错误。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { executeTool } = require('../src/main/agent/tools');

const ROOT = path.join(os.tmpdir(), 'pathtest-' + Date.now());
const WS = path.join(ROOT, '工作区');
const SK = path.join(ROOT, '数模工坊', 'skills');

// 造出技能库和工作区的真实文件
fs.mkdirSync(path.join(SK, 'mcm-workflow'), { recursive: true });
fs.mkdirSync(path.join(WS, 'reports'), { recursive: true });
fs.writeFileSync(path.join(SK, 'mcm-workflow', 'SKILL.md'), '# 技能正文\n第2行\n', 'utf8');
fs.writeFileSync(path.join(WS, 'reports', '规则卡.md'), '# 规则卡\n', 'utf8');
fs.mkdirSync(path.join(ROOT, '外面'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '外面', 'secret.txt'), 'SECRET', 'utf8');

const ctx = { workspace: WS, skillsRoot: SK };

// expect: 期望读到的内容特征（防止"读到了但读错文件"）
async function tryRead(label, p, expect) {
  try {
    const r = await executeTool('read_file', { path: p }, ctx);
    if (typeof r !== 'string' || r.startsWith('执行失败')) {
      console.log('  x ' + label + ' -> ' + r.slice(0, 60));
      return false;
    }
    if (expect && !r.includes(expect)) {
      console.log('  x ' + label + ' -> 读到的内容不对！');
      console.log('      ' + r.replace(/\n/g, ' / ').slice(0, 100));
      return false;
    }
    console.log('  v ' + label + ' -> ' + (expect ? '内容正确' : '读到内容'));
    return true;
  } catch (e) {
    console.log('  x ' + label + ' -> 抛错: ' + e.message.slice(0, 70));
    return false;
  }
}

(async () => {
  console.log('workspace : ' + WS);
  console.log('skillsRoot: ' + SK);
  console.log('');
  console.log('=== 应该成功 ===');
  const a = await tryRead('skills/ 前缀', 'skills/mcm-workflow/SKILL.md', '技能正文');
  const b = await tryRead('技能库绝对路径', path.join(SK, 'mcm-workflow', 'SKILL.md'), '技能正文');
  const c = await tryRead('技能库绝对路径（反斜杠）', SK + '\\mcm-workflow\\SKILL.md', '技能正文');
  const d = await tryRead('工作区相对路径', 'reports/规则卡.md', '规则卡');
  const e = await tryRead('工作区绝对路径', path.join(WS, 'reports', '规则卡.md'), '规则卡');

  console.log('');
  console.log('=== 应该被拒绝（安全）===');
  const f = await tryRead('越界：工作区外', path.join(ROOT, '外面', 'secret.txt'));
  const g = await tryRead('越界：.. 跳出', '../../外面/secret.txt');
  const h = await tryRead('越界：技能库的 ..', 'skills/../../外面/secret.txt');

  // run_python 的 script 参数也要能指向技能库
  const pyOk = await (async () => {
    try {
      const r = await executeTool('run_python', { script: 'skills/mcm-workflow/SKILL.md' }, ctx);
      // 不是真脚本，跑起来会失败，但**不该是越界错误**
      const notOob = !String(r).includes('越界');
      console.log((notOob ? '  v ' : '  x ') + 'run_python script 指向技能库 -> ' + (notOob ? '不报越界' : '仍报越界'));
      return notOob;
    } catch (e) {
      const notOob = !e.message.includes('越界');
      console.log((notOob ? '  v ' : '  x ') + 'run_python script 指向技能库 -> ' + e.message.slice(0, 50));
      return notOob;
    }
  })();

  const pass = a && b && c && d && e && !f && !g && !h && pyOk;
  console.log('');
  console.log(pass ? '=== ✓ 全部符合预期 ===' : '=== ✗ 有不符合预期的项 ===');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})();
