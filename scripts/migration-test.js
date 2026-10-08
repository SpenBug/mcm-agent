'use strict';

/**
 * userData 迁移判断的回归测试。
 *
 * 为什么单独测：这段逻辑决定「改品牌名后老用户会不会丢东西」——
 * 丢卡密、丢设置、重装几百 MB 的 Python 环境，或者反过来白捡一次全新试用。
 * 上一版用「新目录是否存在」判断，被实测打脸：Electron 只要启动过一次
 * 就会创建 userData，导致迁移永久失效。
 * 再上一版只认「凭证」，又漏了体验期老用户（没有凭证 → 不迁移 → 试用重置 + 环境孤儿）。
 * 现在按「新目录已激活则不动；旧目录有凭证/试用锚点/环境则迁」判断，
 * 这个判断本身得钉住，不然以后又被人改回去。
 *
 * 不启动 Electron：shouldMigrate 是纯函数，文件系统用探针注入。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shouldMigrate, readHasCred, hasTrialAnchor, hasPythonEnv } = require('../src/main/paths');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

/** 造一个假的文件系统状态，喂给 shouldMigrate 的 probe */
function probe({ legacyCred = false, currentCred = false, legacyExists = true, legacyTrial = false, legacyEnv = false } = {}) {
  return {
    dirExists: (d) => legacyExists && d.endsWith('数模工坊'),
    hasCred: (d) => (d.endsWith('数模工坊') ? legacyCred : currentCred),
    hasTrialAnchor: (d) => (d.endsWith('数模工坊') ? legacyTrial : false),
    hasPythonEnv: (d) => (d.endsWith('数模工坊') ? legacyEnv : false),
  };
}

const CUR = path.join(os.homedir(), 'AppData', 'Roaming', '阿一古数模');
const LEG = path.join(os.homedir(), 'AppData', 'Roaming', '数模工坊');
const run = (o) => shouldMigrate({ current: CUR, legacy: LEG, probe: probe(o) });

console.log('=== userData 迁移判定 ===');

// —— 保住买家资产 ——
check('付费老用户升级（旧目录有凭证）→ 迁移', run({ legacyCred: true }) === true);
check('体验老用户（旧目录只有试用锚点）→ 迁移，不白送试用', run({ legacyTrial: true }) === true);
check('旧目录只有 Python 环境 → 迁移，不让人重装几百 MB', run({ legacyEnv: true }) === true);
check('新目录已激活 → 绝不迁移（不能把新卡换成旧的）',
  run({ legacyCred: true, currentCred: true }) === false);
check('新目录已激活 + 旧目录有环境 → 仍不迁移',
  run({ currentCred: true, legacyEnv: true, legacyTrial: true }) === false);

// —— 不该迁的 ——
check('全新机器（旧目录不存在）→ 不迁移', run({ legacyExists: false, legacyCred: true }) === false);
check('两个目录都空 → 不迁移', run({}) === false);
check('旧目录只有 Electron 缓存（Preferences 那种）→ 不迁移',
  run({ legacyCred: false, legacyTrial: false, legacyEnv: false }) === false);

// —— 参数健壮性 ——
check('缺 current 路径 → 不迁移、不抛错',
  shouldMigrate({ current: '', legacy: LEG, probe: probe({ legacyCred: true }) }) === false);
check('缺 legacy 路径 → 不迁移、不抛错',
  shouldMigrate({ current: CUR, legacy: '', probe: probe({ legacyCred: true }) }) === false);

// —— 真实读文件的那套探针（不注入，直接跑默认实现）——
console.log('\n=== 默认探针在临时目录上的真实行为 ===');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayigu-mig-'));
const legacy = path.join(root, '数模工坊');
const current = path.join(root, '阿一古数模');
fs.mkdirSync(legacy, { recursive: true });
fs.mkdirSync(current, { recursive: true });

const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj), 'utf8');
const real = () => shouldMigrate({ current, legacy });   // 不注入 probe，走 fs

check('临时目录都为空 → 不迁移', real() === false);

writeJson(legacy, 'license.json', { trialFirstRunAt: 1791381353111, trialLastSeenAt: 1791381353111 });
check('旧目录有体验镜像（无凭证）→ 迁移（保住试用进度）', real() === true);

writeJson(current, 'license.json', { credential: 'a.b' });
check('新目录已激活 → 立刻不迁移', real() === false);

fs.rmSync(path.join(current, 'license.json'));
fs.mkdirSync(path.join(legacy, 'python-env', process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'python-env', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'), '');
writeJson(legacy, 'license.json', {});   // 清掉锚点，只留环境
check('只有 python-env 也算"值得保" → 迁移', real() === true);

fs.rmSync(path.join(legacy, 'python-env'), { recursive: true, force: true });
check('环境删了、锚点也没了 → 不迁移', real() === false);

fs.rmSync(root, { recursive: true, force: true });

// —— 本机现状（只读报告，不断言：开发机状态随时会变）——
// 用 paths.js 导出的**同一批探针**，免得报告显示的和判定依据不是一回事。
console.log('\n=== 本机现状（只读）===');
for (const [label, dir] of [['旧', LEG], ['新', CUR]]) {
  if (!fs.existsSync(dir)) { console.log(`  ${label}目录不存在：${dir}`); continue; }
  console.log(
    `  ${label}目录  凭证=${readHasCred(dir) ? '有' : '无'}  ` +
    `试用锚点=${hasTrialAnchor(dir) ? '有' : '无'}  python-env=${hasPythonEnv(dir) ? '有' : '无'}`,
  );
}
console.log(`  → 判定：${shouldMigrate({ current: CUR, legacy: LEG }) ? '指回旧目录' : '用新目录'}`);

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
