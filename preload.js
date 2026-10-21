const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('redactAPI', {
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateState: (cb) => {
    const listener = (_, state) => cb(state);
    ipcRenderer.on('update-state', listener);
    return () => ipcRenderer.removeListener('update-state', listener);
  },
  validateToken: (token) => ipcRenderer.invoke('validate-token', token),
  openDiscordLogin: () => ipcRenderer.invoke('open-discord-login'),
  getSavedAccounts: () => ipcRenderer.invoke('get-saved-accounts'),
  saveAccount: (acc) => ipcRenderer.invoke('save-account', acc),
  fetchWorkspace: (token) => ipcRenderer.invoke('fetch-workspace', token),
  fetchGuildChannels: (token, guildId) => ipcRenderer.invoke('fetch-guild-channels', { token, guildId }),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  startJob: (jobConfig) => ipcRenderer.invoke('start-job', jobConfig),
  stopJob: () => ipcRenderer.invoke('stop-job'),
  deleteReviewed: (payload) => ipcRenderer.invoke('delete-reviewed', payload),
  onLog: (cb) => ipcRenderer.on('job-log', (_, data) => cb(data)),
  onPreviewMatch: (cb) => ipcRenderer.on('preview-match', (_, item) => cb(item)),
  onStats: (cb) => ipcRenderer.on('job-stats', (_, stats) => cb(stats))
});
