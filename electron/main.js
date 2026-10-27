/* Electron main process for qBruce.
 * Hosts the static web app and bridges Web Serial: Chromium raises
 * 'select-serial-port' when the renderer calls navigator.serial.requestPort();
 * we forward the port list to the renderer's picker and return the chosen id. */
const { app, BrowserWindow, session, ipcMain, Menu, shell } = require('electron');
const path = require('path');

let mainWindow = null;
let pendingSelect = null;   // callback awaiting a port choice

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,                 // custom in-app title bar (see .titlebar)
    backgroundColor: '#090909',
    title: 'qBruce',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'src', 'assets', 'bruce-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const ses = mainWindow.webContents.session;

  // Let the renderer present a device picker instead of Chromium's default.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    pendingSelect = callback;
    mainWindow.webContents.send('serial:ports', portList.map(p => ({
      portId: p.portId,
      portName: p.portName || '',
      displayName: p.displayName || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
    })));
  });

  // Grant serial permission requests (we gate selection via the picker above).
  ses.setPermissionCheckHandler((wc, permission) => permission === 'serial' || permission === 'serial-port');
  ses.setDevicePermissionHandler(() => true);
  ses.on('serial-port-added',  (e, port) => { /* optional live refresh */ });
  ses.on('serial-port-removed',(e, port) => { /* optional live refresh */ });

  // External links (About page) open in the user's default browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Renderer reports the user's choice (or '' to cancel).
ipcMain.on('serial:select', (event, portId) => {
  if (pendingSelect) { pendingSelect(portId || ''); pendingSelect = null; }
});

// custom window controls (frameless)
ipcMain.on('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win:close', () => { if (mainWindow) mainWindow.close(); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
