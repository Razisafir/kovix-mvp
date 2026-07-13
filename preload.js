const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kovix', {
  sendMessage: (message) => ipcRenderer.invoke('send-message', message),
  getState: () => ipcRenderer.invoke('get-state'),
  reset: () => ipcRenderer.invoke('reset'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
});
