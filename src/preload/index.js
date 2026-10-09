'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mcm', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (patch) => ipcRenderer.invoke('config:save', patch),
    test: (override) => ipcRenderer.invoke('config:test', override),
  },
  input: {
    // Electron 32+ 移除了 File.path，取真实路径必须走 webUtils（只能在 preload 调用）
    pathForFile: (file) => webUtils.getPathForFile(file),
    // 四类材料分别提交，第一个参数是分类键：赛题 / 规范 / 模板 / 数据
    import: (cat, paths) => ipcRenderer.invoke('input:import', cat, paths),
    pick: (cat) => ipcRenderer.invoke('input:pick', cat),
    list: () => ipcRenderer.invoke('input:list'),
    remove: (cat, name) => ipcRenderer.invoke('input:remove', cat, name),
    openDir: (cat) => ipcRenderer.invoke('input:openDir', cat),
  },
  workspace: {
    choose: () => ipcRenderer.invoke('workspace:choose'),
    ensure: () => ipcRenderer.invoke('workspace:ensure'),
    list: (rel) => ipcRenderer.invoke('workspace:list', rel),
    openPath: (rel) => ipcRenderer.invoke('workspace:openPath', rel),
    reveal: (rel) => ipcRenderer.invoke('workspace:reveal', rel),
    read: (rel) => ipcRenderer.invoke('workspace:read', rel),
    dataUrl: (rel) => ipcRenderer.invoke('workspace:dataUrl', rel),
  },
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    save: (payload) => ipcRenderer.invoke('session:save', payload),
    load: (id) => ipcRenderer.invoke('session:load', id),
    remove: (id) => ipcRenderer.invoke('session:delete', id),
    rollback: (since) => ipcRenderer.invoke('session:rollback', { since }),
    // LLM 生成会话标题；失败时渲染层保留本地兜底标题，不提示用户
    title: (payload) => ipcRenderer.invoke('session:title', payload),
    // 本地兜底标题：纯计算、瞬时返回，先把侧栏填上
    titleLocal: (payload) => ipcRenderer.invoke('session:title-local', payload),
  },
  // 工作区快照：每轮对话前拍一张，回滚时整体还原（覆盖/新增/删除都能回去）
  snapshot: {
    create: (meta) => ipcRenderer.invoke('snapshot:create', meta),
    list: () => ipcRenderer.invoke('snapshot:list'),
    restore: (id) => ipcRenderer.invoke('snapshot:restore', id),
  },
  python: {
    status: () => ipcRenderer.invoke('python:status'),
    setup: (base) => ipcRenderer.invoke('python:setup', base),
    setPath: (p) => ipcRenderer.invoke('python:setPath', p),
  },
  drawio: {
    status: () => ipcRenderer.invoke('drawio:status'),
    export: (payload) => ipcRenderer.invoke('drawio:export', payload),
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: () => ipcRenderer.invoke('chat:abort'),
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('chat:event', handler);
      return () => ipcRenderer.removeListener('chat:event', handler);
    },
  },
  skills: {
    info: () => ipcRenderer.invoke('skills:info'),
  },
  license: {
    state: () => ipcRenderer.invoke('license:state'),
    machine: () => ipcRenderer.invoke('license:machine'),
    qr: (kind) => ipcRenderer.invoke('license:qr', kind),
    activate: (credential) => ipcRenderer.invoke('license:activate', { credential }),
  },
  // 赛事日历：状态/倒计时由主进程推导，渲染层只负责画
  competitions: {
    list: () => ipcRenderer.invoke('competitions:list'),
    setCurrent: (id) => ipcRenderer.invoke('competition:setCurrent', id),
  },
  // 外链（赛事官网）：主进程只放行 https
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  // AI 工具使用详情草稿（支撑材料）
  aiDeclare: {
    draft: (payload) => ipcRenderer.invoke('aiDeclare:draft', payload),
  },
  // 邀请码（只读展示；减价与送卡由卖家人工确认）
  invite: {
    info: () => ipcRenderer.invoke('invite:info'),
  },
});
