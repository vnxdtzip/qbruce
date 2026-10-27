/* preload — minimal, safe bridge for the serial-port picker. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronSerial', {
  isElectron: true,
  onPorts: (cb) => ipcRenderer.on('serial:ports', (_e, list) => cb(list)),
  select: (portId) => ipcRenderer.send('serial:select', portId),
});

contextBridge.exposeInMainWorld('winControls', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
});

/* Single source of truth for the app version: package.json. */
let pkgVersion = '';
try { pkgVersion = require('../package.json').version; } catch {}
contextBridge.exposeInMainWorld('appInfo', { version: pkgVersion });
