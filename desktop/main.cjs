const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

function getAppUrl() {
  const url = process.env.TALKIE_APP_URL?.trim();
  if (url) return url;
  return app.isPackaged ? 'https://call.moderium-ai.ru' : 'http://localhost:5173';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const allowed = new URL(getAppUrl());
      const target = new URL(url);
      if (target.origin !== allowed.origin) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    } catch {
      // ignore
    }
  });

  void win.loadURL(getAppUrl());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('Talkie');
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
