const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ifWindow', {
  minimize: () => ipcRenderer.send('if:window-minimize'),
  toggleFullscreen: () => ipcRenderer.send('if:window-toggle-fullscreen'),
  close: () => ipcRenderer.send('if:window-close'),
})
