'use strict';

/**
 * 工作区快照的单元测试。
 *
 * 重点不是「函数有没有被调用」，而是**还原之后文件内容真的回来了**：
 * 被覆盖的要变回旧内容、新增的要消失、被删的要回来。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require(path.join(__dirname, '..', 'src', 'main', 'snapshot.js'));

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
const ud = path.join(tmp, 'userData');
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(ud, { recursive: true });
fs.mkdirSync(path.join(ws, 'figures'), { recursive: true });
fs.writeFileSync(path.join(ws, 'a.txt'), 'v1');
fs.writeFileSync(path.join(ws, 'figures', 'f1.png'), 'PIC1');

console.log('=== ① 拍快照 ===');
const s1 = S.createSnapshot(ud, ws, { label: '第一次' });
check('拍快照成功', s1.ok, s1.error);
check('文件数 = 2', s1.count === 2, String(s1.count));
check('有 id', /^\d{13}$/.test(String(s1.id)), String(s1.id));

console.log();
console.log('=== ② 改动工作区（覆盖 / 新增 / 删除）===');
fs.writeFileSync(path.join(ws, 'a.txt'), 'v2');
fs.writeFileSync(path.join(ws, 'b.txt'), 'new');
fs.rmSync(path.join(ws, 'figures'), { recursive: true, force: true });
const s2 = S.createSnapshot(ud, ws, { label: '第二次' });
check('第二张快照成功', s2.ok, s2.error);
check('第二张只看到 2 个文件（a.txt + b.txt）', s2.count === 2, String(s2.count));

console.log();
console.log('=== ③ 还原到第一张（核心）===');
const r = S.restoreSnapshot(ud, s1.id, ws);
check('还原返回 ok', r.ok, r.error);
check('被覆盖的 a.txt 回到 v1', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'v1',
  fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'));
check('新增的 b.txt 消失了', !fs.existsSync(path.join(ws, 'b.txt')));
check('被删的 figures/f1.png 回来了', fs.existsSync(path.join(ws, 'figures', 'f1.png')));
check('  内容也对', fs.readFileSync(path.join(ws, 'figures', 'f1.png'), 'utf8') === 'PIC1');

console.log();
console.log('=== ④ 原内容进 _backup，不是被删 ===');
const backups = fs.readdirSync(path.join(ws, '_backup'));
check('_backup 下有 1 个 rollback 目录', backups.length === 1, JSON.stringify(backups));
check('里面能看到还原前的 a.txt = v2',
  fs.readFileSync(path.join(ws, '_backup', backups[0], 'a.txt'), 'utf8') === 'v2');
check('_backup 本身不进快照', !fs.existsSync(path.join(ws, '_backup', backups[0], '_backup')));

console.log();
console.log('=== ⑤ 硬链接复用（省磁盘）===');
const t1 = S.createSnapshot(ud, ws, { label: 'h1' });
const t2 = S.createSnapshot(ud, ws, { label: 'h2' });
check('第二张成功', t2.ok, t2.error);
check('不改动时第二次全走硬链接', t2.linked === t2.count && t2.count > 0,
  `linked=${t2.linked} count=${t2.count}`);

console.log();
console.log('=== ⑥ 保留上限 ===');
for (let i = 0; i < S.KEEP + 3; i += 1) {
  S.createSnapshot(ud, ws, { label: 'p' + i });
}
const list = S.listSnapshots(ud);
check(`快照数不超过 ${S.KEEP}`, list.length <= S.KEEP, String(list.length));
check('列表按时间倒序', list.length < 2 || Number(list[0].id) > Number(list[1].id));

console.log();
console.log('=== ⑦ 异常路径 ===');
check('还原不存在的快照 → 失败', S.restoreSnapshot(ud, '1', ws).ok === false);
check('拍不存在的工作区 → 失败', S.createSnapshot(ud, path.join(tmp, 'nope'), {}).ok === false);
check('删除快照', S.removeSnapshot(ud, list[0].id).ok === true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log();
console.log(`  结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
