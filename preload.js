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

  /* ---------------- Staging (Approve-Before-Write Gate) ----------- */
  //
  // These methods are the renderer's only way to interact with the staging
  // queue. The renderer subscribes to onStagingPropose (new diff to review)
  // and onStagingQueueUpdate (queue state changed), then calls resolveStaging
  // when the user clicks Accept / Reject / Modify.
  //
  resolveStaging:     (decision) => ipcRenderer.invoke('staging:resolve', decision),
  getCurrentStaging:  () => ipcRenderer.invoke('staging:get-current'),
  getStagingQueue:    () => ipcRenderer.invoke('staging:get-queue'),
  setStagingAutoMode: (mode, reason) =>
    ipcRenderer.invoke('staging:set-auto-mode', { mode, reason }),
  clearStagingAutoMode: () => ipcRenderer.invoke('staging:clear-auto-mode'),
  resetStaging:       () => ipcRenderer.invoke('staging:reset'),

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

  /**
   * Subscribe to staging:propose events (a new file write is awaiting
   * user approval). The renderer should render a Monaco diff with the
   * proposal's oldContent vs newContent and show Accept / Reject / Modify
   * buttons.
   * @param {(payload:{proposal: {id, path, absPath, oldContent, newContent, source, isCreate, status, createdAt}}) => void} cb
   * @returns {() => void} unsubscribe fn
   */
  onStagingPropose: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('staging:propose', listener);
    return () => ipcRenderer.removeListener('staging:propose', listener);
  },

  /**
   * Subscribe to staging:queue-update events (the staging queue state
   * changed — proposal added, resolved, auto-mode toggled, etc).
   * @param {(payload:{queue: Array, currentIndex: number, autoMode: string, pendingCount: number, resolvedCount: number, errorCount: number}) => void} cb
   * @returns {() => void} unsubscribe fn
   */
  onStagingQueueUpdate: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('staging:queue-update', listener);
    return () => ipcRenderer.removeListener('staging:queue-update', listener);
  },
});
