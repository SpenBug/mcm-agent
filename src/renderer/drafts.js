'use strict';

/**
 * 会话草稿：输入到一半切会话 / 关窗口，内容不该丢。
 *
 * 为什么用 localStorage 而不是主进程的 userData/drafts.json：
 * 项目已经在用它存主题（app.js 里的 mcm-theme），草稿是同样的"应用级小状态"。
 * 走文件要新增 IPC + 防抖写盘 + 路径处理，收益不抵成本。
 *
 * 设计要点（从 DSH 的 draft.ts 借思路，但不照搬）：
 *  - DSH 存 {text, references[]} 语义快照并用 zod 校验 span 一致性。
 *    本项目正文只有纯文本（引用是文本投影，没有独立 span），
 *    所以只存字符串 —— 少一份要保真的结构，就少一类会漂移的地方。
 *  - **按会话分键**：切会话时把当前输入存回旧会话、再载入目标会话的草稿。
 *  - 上限与淘汰：localStorage 配额有限，且没人需要几百份草稿。
 *  - 任何异常都静默降级：草稿是"锦上添花"，不该把输入框搞崩。
 *
 * 导出成工厂函数 + 注入 storage，是为了能在 Node 里离线测（不依赖浏览器）。
 */
function createDrafts(storage, opts = {}) {
  const KEY = opts.key || 'mcm-drafts';
  const MAX_TEXT = opts.maxText || 8000;      // 单份上限：8000 字足够写清一道题
  const MAX_ITEMS = opts.maxItems || 50;      // 最多记 50 个会话
  /** 存"最后正在编辑的会话 id"的保留键。用 __ 前缀避免和真实会话 id 撞 */
  const LAST_KEY = '__last__';

  /** 读全部草稿。损坏 / 非法 JSON / 老版本数据一律当空的，下次写入自然覆盖 */
  function readAll() {
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      // 只接受 { 字符串键: 字符串值 }；混进别的东西（手工改过 / 版本不兼容）就丢掉
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === 'string' && typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  function writeAll(map) {
    try {
      storage.setItem(KEY, JSON.stringify(map));
      return true;
    } catch {
      // 配额满 / 隐私模式禁用 localStorage：静默失败，输入框照常能用
      return false;
    }
  }

  /** 空串也要能存 —— 它表示"用户明确清空了"，恢复时不该再把旧内容填回去 */
  function save(id, text) {
    const sid = String(id || '');
    if (!sid) return false;
    const map = readAll();
    const t = String(text == null ? '' : text);
    if (!t) {
      if (!(sid in map)) return true;   // 本来就没有，不用写
      delete map[sid];
      return writeAll(map);
    }
    const clipped = [...t].length > MAX_TEXT ? [...t].slice(0, MAX_TEXT).join('') : t;
    map[sid] = clipped;

    // 超量时按插入顺序淘汰最旧的（JSON 对象保留字符串键的插入顺序）。
    // ⚠️ 两个例外不能当淘汰候选：
    //   LAST_KEY —— 它是恢复指针，被淘汰等于"重启后想不起该恢复哪个会话"，
    //              而且是无声的，用户只会觉得草稿功能时灵时不灵；
    //   sid      —— 刚写的这条。会话数刚好超上限时，最旧的就是它自己，
    //              不排掉的话这次保存会被自己删掉。
    const keys = Object.keys(map).filter((k) => k !== LAST_KEY && k !== sid);
    if (keys.length > MAX_ITEMS - 1) {
      for (const k of keys.slice(0, keys.length - (MAX_ITEMS - 1))) delete map[k];
    }
    return writeAll(map);
  }

  function load(id) {
    const sid = String(id || '');
    if (!sid) return '';
    const v = readAll()[sid];
    return typeof v === 'string' ? v : '';
  }

  function clear(id) {
    const sid = String(id || '');
    if (!sid) return false;
    const map = readAll();
    if (!(sid in map)) return true;
    delete map[sid];
    return writeAll(map);
  }

  /** 会话被删除时顺手清掉它的草稿，否则永久占位 */
  function drop(id) {
    return clear(id);
  }

  /**
   * 记住"最后正在编辑的会话"。
   *
   * 为什么需要：应用启动走的是 newSession()，会生成一个全新的
   * `session-<时间戳>` id。只按会话 id 存草稿的话，重启后拿这个新 id 去查
   * 必然查不到 —— 于是"关窗口再打开，没发出去的内容还在"这个
   * 草稿最核心的场景其实完全没生效。
   */
  function setLast(id) {
    const sid = String(id || '');
    const map = readAll();
    if (!sid) {
      // 传空表示"清除指针"。早先这里是直接 return false 什么都不做，
      // 于是调用方以为重置了、实际还指着旧会话 —— 静默失效比报错更难查。
      if (!(LAST_KEY in map)) return true;
      delete map[LAST_KEY];
      return writeAll(map);
    }
    map[LAST_KEY] = sid;
    return writeAll(map);
  }

  function getLast() {
    const v = readAll()[LAST_KEY];
    return typeof v === 'string' ? v : '';
  }

  /** 供启动时调用：有未发送草稿就返回该会话 id，否则空串 */
  function resumable() {
    const sid = getLast();
    if (!sid) return '';
    const t = readAll()[sid];
    return typeof t === 'string' && t.trim() ? sid : '';
  }

  return { save, load, clear, drop, setLast, getLast, resumable, readAll, writeAll, MAX_TEXT, MAX_ITEMS };
}

// 浏览器里挂到 window；Node（测试）里走 module.exports
if (typeof window !== 'undefined') window.createDrafts = createDrafts;
if (typeof module !== 'undefined' && module.exports) module.exports = { createDrafts };
