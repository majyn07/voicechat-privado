const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, systemPreferences } = require('electron');
const path = require('path');

let mainWindow = null;
let currentMuteToggleAccelerator = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#1e1f24',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// --- Screen / window capture sources for screen sharing ---
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180},
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
  }));
});

// --- Global mute-toggle hotkey (works even when the app is unfocused) ---
ipcMain.handle('set-mute-hotkey', (_evt, accelerator) => {
  if (currentMuteToggleAccelerator) {
    globalShortcut.unregister(currentMuteToggleAccelerator);
    currentMuteToggleAccelerator = null;
  }
  if (!accelerator) return { ok: true };

  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (mainWindow) mainWindow.webContents.send('hotkey-toggle-mute');
    });
    if (ok) currentMuteToggleAccelerator = accelerator;
    return { ok };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('get-mic-permission-status', async () => {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return 'unknown';
  }
});
