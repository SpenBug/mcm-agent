'use strict';

/**
 * 工作区快照 —— 给「回滚」用。
 *
 * 为什么不是简单的「把产物挪进 _backup」：
 *   按文件修改时间判断的话，**被覆盖的文件还原不回来**
 *   （agent 重写同一个 figures/fig1.png，旧版本就没了）。
 *   所以这里在**每一轮对话开始前**给整个工作区拍一张快照，回滚时整体还原。
 *
 * 省磁盘的办法：和上一个快照比对 size + mtime，一致的文件用**硬链接**复用
 * （同盘瞬间完成、不占额外空间）；跨盘或链接失败就退回普通复制。
 *
 * 存储结构：
 *   <userData>/snapshots/<13位时间戳>/files/...   快照内容
 *   <userData>/snapshots/<13位时间戳>/meta.json   元信息
 */

const fs = require('node:fs');
const path = require('node:path');

/** 单次快照的体积上限：超了就不拍，避免把磁盘撑爆 */
const MAX_BYTES = 400 * 1024 * 1024;
/** 保留最近多少个快照，超出的自动删 */
const KEEP = 8;
/** 这些目录不进快照（回滚自己的备份 + 快照本体） */
const SKIP_DIRS = new Set(['_backup', 'snapshots', '.git']);

function snapshotsRoot(userDataDir) {
  return path.join(userDataDir, 'snapshots');
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 按时间倒序列出所有快照（新的在前） */
function listSnapshots(userDataDir) {
  const root = snapshotsRoot(userDataDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => /^\d{13}$/.test(n))
    .map((id) => Object.assign({ id }, readMeta(path.join(root, id))))
    .filter((s) => fs.existsSync(path.join(root, s.id, 'files')))
    .sort((a, b) => Number(b.id) - Number(a.id));
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { total += fs.statSync(p).size; } catch { /* 忽略 */ }
      }
    }
  };
  walk(dir);
  return total;
}

/** 删掉超出保留数的旧快照 */
function prune(userDataDir, keep = KEEP) {
  const list = listSnapshots(userDataDir);
  const removed = [];
  for (const s of list.slice(keep)) {
    try {
      fs.rmSync(path.join(snapshotsRoot(userDataDir), s.id), { recursive: true, force: true });
      removed.push(s.id);
    } catch { /* 删不掉就算了，下次再说 */ }
  }
  return removed;
}

/**
 * 给工作区拍一张快照。
 * @returns {{ok:boolean, id?:string, count?:number, bytes?:number, linked?:number, error?:string}}
 */
function createSnapshot(userDataDir, workspace, meta = {}) {
  if (!workspace || !fs.existsSync(workspace)) {
    return { ok: false, error: '工作区不存在' };
  }

  const root = snapshotsRoot(userDataDir);
  const id = String(Date.now());
  const dst = path.join(root, id);
  const filesDir = path.join(dst, 'files');

  // 最近一张，用来做硬链接复用
  const prev = listSnapshots(userDataDir)[0];
  const prevFiles = prev ? path.join(root, prev.id, 'files') : null;

  let count = 0;
  let bytes = 0;
  let linked = 0;
  let aborted = false;

  try {
    fs.mkdirSync(filesDir, { recursive: true });

    const walk = (rel) => {
      if (aborted) return;
      let entries;
      try {
        entries = fs.readdirSync(path.join(workspace, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (aborted) return;
        const r = rel ? path.join(rel, e.name) : e.name;

        if (e.isDirectory()) {
          if (!rel && SKIP_DIRS.has(e.name)) continue;   // 只跳过工作区根下这几个
          fs.mkdirSync(path.join(filesDir, r), { recursive: true });
          walk(r);
          continue;
        }
        if (!e.isFile()) continue;                        // 符号链接等一律跳过

        const src = path.join(workspace, r);
        const out = path.join(filesDir, r);
        let st;
        try { st = fs.statSync(src); } catch { continue; }

        bytes += st.size;
        count += 1;
        if (bytes > MAX_BYTES) { aborted = true; return; }

        // 和上一个快照同 size + 同 mtime → 硬链接复用（跨盘会 EXDEV，退回复制）
        if (prevFiles) {
          const p = path.join(prevFiles, r);
          try {
            const pst = fs.statSync(p);
            if (pst.size === st.size && Math.abs(pst.mtimeMs - st.mtimeMs) < 1) {
              fs.linkSync(p, out);
              linked += 1;
              continue;
            }
          } catch { /* 没有旧版本，或链接失败 */ }
        }
        fs.copyFileSync(src, out);
      }
    };

    walk('');

    if (aborted) {
      fs.rmSync(dst, { recursive: true, force: true });
      return { ok: false, error: `工作区超过 ${Math.round(MAX_BYTES / 1048576)}MB，已跳过这次快照` };
    }

    fs.writeFileSync(
      path.join(dst, 'meta.json'),
      JSON.stringify({
        at: Number(id),
        workspace,
        label: meta.label || '',
        count,
        bytes,
        linked,
      }, null, 2),
      'utf8'
    );

    const removed = prune(userDataDir);
    return { ok: true, id, count, bytes, linked, pruned: removed.length };
  } catch (e) {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return { ok: false, error: e.message };
  }
}

/**
 * 把工作区还原到某张快照。
 *
 * ⚠️ 当前内容**不删除**，而是整体挪进 `_backup/rollback-<时间>/` ——
 * 万一是误操作，还能自己翻回来。这是这一整套东西里唯一有破坏性的动作，
 * 所以宁可多占点磁盘。
 */
function restoreSnapshot(userDataDir, id, workspace) {
  const root = snapshotsRoot(userDataDir);
  const srcFiles = path.join(root, String(id), 'files');
  if (!fs.existsSync(srcFiles)) return { ok: false, error: '快照不存在或已被清理' };
  if (!fs.existsSync(workspace)) return { ok: false, error: '工作区不存在' };

  const stamp = Date.now();
  const backupRoot = path.join(workspace, '_backup');
  const parked = path.join(backupRoot, 'rollback-' + stamp);
  fs.mkdirSync(parked, { recursive: true });

  // ① 把当前内容挪走（rename 同盘瞬间完成；跨盘会退化成复制，慢但正确）
  let moved = 0;
  for (const name of fs.readdirSync(workspace)) {
    if (name === '_backup') continue;
    try {
      fs.renameSync(path.join(workspace, name), path.join(parked, name));
      moved += 1;
    } catch {
      try {
        fs.cpSync(path.join(workspace, name), path.join(parked, name), { recursive: true });
        fs.rmSync(path.join(workspace, name), { recursive: true, force: true });
        moved += 1;
      } catch { /* 单个失败不影响其它 */ }
    }
  }

  // ② 快照内容拷回来（必须是真拷贝 —— 硬链接回工作区的话，
  //    以后改文件会连带改掉历史快照）
  let restored = 0;
  const walk = (rel) => {
    const d = path.join(srcFiles, rel);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      const out = path.join(workspace, r);
      if (e.isDirectory()) {
        fs.mkdirSync(out, { recursive: true });
        walk(r);
      } else if (e.isFile()) {
        fs.copyFileSync(path.join(d, e.name), out);
        restored += 1;
      }
    }
  };
  walk('');

  return { ok: true, moved, restored, backup: path.relative(workspace, parked) };
}

/** 删掉一张快照 */
function removeSnapshot(userDataDir, id) {
  const p = path.join(snapshotsRoot(userDataDir), String(id));
  if (!fs.existsSync(p)) return { ok: false, error: '快照不存在' };
  fs.rmSync(p, { recursive: true, force: true });
  return { ok: true };
}

/** 全部快照占多少磁盘 */
function totalBytes(userDataDir) {
  const root = snapshotsRoot(userDataDir);
  return fs.existsSync(root) ? dirBytes(root) : 0;
}

module.exports = {
  MAX_BYTES,
  KEEP,
  listSnapshots,
  createSnapshot,
  restoreSnapshot,
  removeSnapshot,
  totalBytes,
  prune,
};
