'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcm', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (patch) => ipcRenderer.invoke('config:save', patch),
    test: (override) => ipcRenderer.invoke('config:test', override),
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
});
