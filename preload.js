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
  getSettings:    () => ipcRenderer.invoke('get-settings'),
  saveSettings:   (cfg) => ipcRenderer.invoke('save-settings', cfg),
  fetchModels:    (cfg) => ipcRenderer.invoke('fetch-models', cfg),
  testConnection: (cfg) => ipcRenderer.invoke('test-connection', cfg),

  /* ---------------- Conversation --------------------- */
  sendMessage:    (text) => ipcRenderer.invoke('send-message', { text }),
  resetConvo:     () => ipcRenderer.invoke('reset-convo'),
  getConvoState:  () => ipcRenderer.invoke('get-convo-state'),
  cancelCurrent:  () => ipcRenderer.invoke('cancel-current'),
  advanceStep:    () => ipcRenderer.invoke('advance-step'),

  /* ---------------- Sessions ------------------------- */
  listSessions:   () => ipcRenderer.invoke('sessions:list'),
  loadSession:    (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession:  (id) => ipcRenderer.invoke('sessions:delete', id),
  newSession:     () => ipcRenderer.invoke('sessions:new'),

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

  /**
   * Subscribe to llm:delta events (streamed tokens from the LLM).
   * @param {(payload:{delta:string}) => void} cb
   * @returns {() => void} unsubscribe fn
   */
  onLLMDelta: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('llm:delta', listener);
    return () => ipcRenderer.removeListener('llm:delta', listener);
  },

  /**
   * Subscribe to tool:call events (agent is executing a tool).
   * @param {(payload:{name:string, args:object, iteration:number}) => void} cb
   * @returns {() => void} unsubscribe fn
   */
  onToolCall: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('tool:call', listener);
    return () => ipcRenderer.removeListener('tool:call', listener);
  },

  /**
   * Subscribe to tool:result events (tool execution completed).
   * @param {(payload:{name:string, ok:boolean, result:string, iteration:number}) => void} cb
   * @returns {() => void} unsubscribe fn
   */
  onToolResult: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('tool:result', listener);
    return () => ipcRenderer.removeListener('tool:result', listener);
  },
});
