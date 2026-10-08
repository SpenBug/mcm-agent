/**
 * 工作区回滚：把 `since` 之后被创建 / 修改过的文件挪进 _backup/<时间戳>/。
 *
 * 抽成独立模块是为了**能测** —— ipc.js 依赖 electron，纯 Node 里 require 不了。
 *
 * ⚠️ 只「移动」不「删除」：判断依据是文件 mtime，用户在这期间自己手改的文件
 * 也会被一起挪走。留在 _backup 里还能捞回来，删了就真没了。
 * ⚠️ .mcm-agent（会话数据）和 _backup（备份自己）必须跳过，
 * 否则回滚会把会话文件、以及上一次的备份也卷进去。
 */
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['.mcm-agent', '_backup', 'node_modules', '.git']);

/** 时间戳做目录名，不能带冒号和点（Windows 路径里非法） */
function stamp(d) {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * @param {string} ws     工作区根目录
 * @param {number} since  毫秒时间戳；mtime 晚于它的文件会被挪走
 * @returns {{ok:boolean, moved?:string[], backup?:string|null, error?:string}}
 */
function rollbackWorkspace(ws, since) {
  const t = Number(since);
  if (!ws || !Number.isFinite(t)) return { ok: false, error: '回滚参数不对' };
  if (!fs.existsSync(ws)) return { ok: false, error: '工作区不存在' };

  const backupName = stamp(new Date());
  const dest = path.join(ws, '_backup', backupName);
  const moved = [];

  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;                       // 没权限就跳过，不中断整次回滚
    }
    for (const it of items) {
      if (SKIP.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full); continue; }
      if (!it.isFile()) continue;

      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs <= t) continue;   // 这轮之前就有的，不动

      try {
        const to = path.join(dest, path.relative(ws, full));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(full, to);
        moved.push(path.relative(ws, full));
      } catch { /* 单个文件挪不动就跳过，不阻断 */ }
    }
  };

  walk(ws);
  return { ok: true, moved, backup: moved.length ? path.join('_backup', backupName) : null };
}

module.exports = { rollbackWorkspace, SKIP };
