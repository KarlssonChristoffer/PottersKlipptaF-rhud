// The zone overlay may only report a rectangle or cancel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zone', {
  done: r => ipcRenderer.send('zone-done', { x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 }),
  cancel: () => ipcRenderer.send('zone-cancel'),
});
