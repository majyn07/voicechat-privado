const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicechat', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  setMuteHotkey: (accelerator) => ipcRenderer.invoke('set-mute-hotkey', accelerator),
  getMicPermissionStatus: () => ipcRenderer.invoke('get-mic-permission-status'),
  onHotkeyToggleMute: (cb) => {
    ipcRenderer.removeAllListeners('hotkey-toggle-mute');
    ipcRenderer.on('hotkey-toggle-mute', () => cb());
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdateNow: () => ipcRenderer.invoke('install-update-now'),
  onUpdateStatus: (cb) => {
    ipcRenderer.removeAllListeners('update-status');
    ipcRenderer.on('update-status', (_evt, payload) => cb(payload));
  },
});
