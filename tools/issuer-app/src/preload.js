'use strict';

/**
 * 安全桥：渲染进程只能用下面这几个方法，拿不到 require / fs / 私钥路径。
 *
 * contextIsolation: true + 这里显式白名单 —— 界面里即使有注入的 HTML
 * （比如买家备注里塞 <script>）也碰不到文件系统。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 把 {ok,data} / {ok:false,error} 摊平成"成功返回数据、失败抛错" */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r || r.ok !== true) {
    const err = new Error((r && r.error) || '调用失败');
    if (r && r.code) err.code = r.code;
    throw err;
  }
  return r.data;
}

contextBridge.exposeInMainWorld('issuer', {
  info: () => call('app:info'),
  competitions: () => call('competitions:list'),
  prices: () => call('prices'),
  ledger: () => call('ledger:list'),
  issue: (form) => call('issue:new', form),
  verify: (payload) => call('card:verify', payload),
  inviteRecord: (form) => call('invite:record', form),
  inviteStats: () => call('invite:stats'),
  importLedger: (opts) => call('ledger:import', opts || {}),
  exportLedger: (opts) => call('ledger:export', opts || {}),
  copy: (text) => call('clipboard:write', text),
  deleteLegacyKeys: () => call('key:delete-legacy'),
  showItem: (p) => call('shell:show-item', p),
  /** 启动提示（私钥搬迁 / 找不到私钥），主进程推一次 */
  onBootWarning: (fn) => ipcRenderer.on('boot:warning', (_e, payload) => fn(payload)),
});
