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
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (cfg) => ipcRenderer.invoke('save-settings', cfg),

  // Models
  fetchModels: (cfg) => ipcRenderer.invoke('fetch-models', cfg),

  // Conversation
  sendMessage: (text) => ipcRenderer.invoke('send-message', { text }),
  resetConvo: () => ipcRenderer.invoke('reset-convo'),
  getConvoState: () => ipcRenderer.invoke('get-convo-state'),
});
