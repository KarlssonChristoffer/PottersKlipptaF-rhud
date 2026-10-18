// The only things the Clippit page may ask of the main process.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'announce', 'activity', 'animate', 'hide', 'show'];

contextBridge.exposeInMainWorld('clippit', {
  platform: process.platform,
  on: (channel, cb) => { if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data)); },
  ready: () => ipcRenderer.send('ready'),
  shape: rects => ipcRenderer.send('shape', rects),
  hit: over => ipcRenderer.send('hit', !!over),
  drag: d => ipcRenderer.send('drag', { dx: Number(d.dx) || 0, dy: Number(d.dy) || 0 }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  focus: id => ipcRenderer.send('focus', String(id)),
  menu: () => ipcRenderer.send('menu'),
  hide: () => ipcRenderer.send('hide'),
});
