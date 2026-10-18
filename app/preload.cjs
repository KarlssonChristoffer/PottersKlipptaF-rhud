// The only things the Clippit page may ask of the main process.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'announce', 'activity', 'animate', 'hide', 'show', 'zone-prompt', 'zone-context', 'offload-ask', 'offload-status', 'offloads'];

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
  zone: () => ipcRenderer.send('zone-start'),
  zoneSubmit: (id, text) => ipcRenderer.send('zone-submit', { id: String(id), text: String(text) }),
  zoneDismiss: () => ipcRenderer.send('zone-dismiss'),
  openPrivacy: which => ipcRenderer.send('open-privacy', String(which)),
  offloadAnswer: (id, where) => ipcRenderer.send('offload-answer', { id: String(id), where: String(where) }),
  offloadCmd: (id, cmd) => ipcRenderer.send('offload-cmd', { id: String(id), cmd: String(cmd) }),
});
