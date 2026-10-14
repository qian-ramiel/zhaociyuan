const { contextBridge, ipcRenderer } = require('electron');
const initialLanguage = process.argv.find((argument) => argument.startsWith('--zhaociyuan-ui-language='))?.split('=')[1];

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  initialLanguage: ['zh', 'en', 'ja'].includes(initialLanguage) ? initialLanguage : 'en',
  api: (path, options) => ipcRenderer.invoke('api', path, options),
  stream: (id, path, body, callback) => {
    const handler = (_, receivedId, value) => { if (receivedId === id) callback(value); };
    ipcRenderer.on('stream-event', handler);
    return ipcRenderer.invoke('stream', id, path, body).finally(() => ipcRenderer.removeListener('stream-event', handler));
  },
  cancelStream: (id) => ipcRenderer.invoke('stream-cancel', id),
  lipSync: (value) => ipcRenderer.send('lip-sync', value),
  upload: (path, bytes, name, type, fields) => ipcRenderer.invoke('upload', path, bytes, name, type, fields),
  sources: () => ipcRenderer.invoke('sources'),
  capture: () => ipcRenderer.invoke('capture'),
  permission: () => ipcRenderer.invoke('permission'),
  overlay: (options) => ipcRenderer.invoke('overlay', options),
  pointerRegions: (regions, capturing) => ipcRenderer.send('pointer-regions', regions, capturing),
  openConsole: () => ipcRenderer.invoke('open-console'),
  openChat: () => ipcRenderer.invoke('open-chat'),
  command: (command) => ipcRenderer.send('command', command),
  openData: () => ipcRenderer.invoke('open-data'),
  openPermissions: () => ipcRenderer.invoke('open-permissions'),
  notifyState: (state) => ipcRenderer.send('state', state),
  onState: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  onCommand: (callback) => {
    const handler = (_, command) => callback(command);
    ipcRenderer.on('command', handler);
    return () => ipcRenderer.removeListener('command', handler);
  },
  quit: () => ipcRenderer.invoke('quit'),
});
ipcRenderer.on('lip-sync', (_, value) => window.dispatchEvent(new CustomEvent('companion-mouth', { detail: value })));
