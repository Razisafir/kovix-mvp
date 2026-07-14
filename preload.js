'use strict';

/**
 * Kovix MVP — preload script
 *
 * Exposes a tiny, explicit IPC surface to the renderer via contextBridge.
 * The renderer can call window.kovix.<method>() but cannot touch Node APIs
 * directly (contextIsolation: true, nodeIntegration: false).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kovix', {
  /* ---------------- Settings & models ---------------- */
  getSettings:  () => ipcRenderer.invoke('get-settings'),
  saveSettings: (cfg) => ipcRenderer.invoke('save-settings', cfg),
  fetchModels:  (cfg) => ipcRenderer.invoke('fetch-models', cfg),

  /* ---------------- Conversation --------------------- */
  sendMessage:    (text) => ipcRenderer.invoke('send-message', { text }),
  resetConvo:     () => ipcRenderer.invoke('reset-convo'),
  getConvoState:  () => ipcRenderer.invoke('get-convo-state'),

  /* ---------------- Workspace & files ---------------- */
  openFolder:  () => ipcRenderer.invoke('dialog:open-folder'),
  getWorkspace: () => ipcRenderer.invoke('fs:get-workspace'),
  getTree:     () => ipcRenderer.invoke('fs:get-tree'),
  readFile:    (filePath) => ipcRenderer.invoke('fs:read-file', filePath),

  /* ---------------- Events from main ----------------- */
  /**
   * Subscribe to fs:tree-changed events.
   * @param {(payload:{relativePath:string|null}) => void} cb
   * @returns {() => void} unsubscribe fn
   */
  onTreeChanged: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('fs:tree-changed', listener);
    return () => ipcRenderer.removeListener('fs:tree-changed', listener);
  },
});
