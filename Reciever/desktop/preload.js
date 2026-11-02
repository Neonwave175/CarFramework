const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('receiver', {
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  start: options => ipcRenderer.invoke('start-receiver', options),
  stop: () => ipcRenderer.invoke('stop-receiver'),
  onEvent: callback => ipcRenderer.on('receiver-event', (_, payload) => callback(payload))
});
