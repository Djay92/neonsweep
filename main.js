const { app, BrowserWindow, ipcMain, dialog, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { runJob, deleteReviewedItems } = require('./src/engine');
const { UpdateManager } = require('./src/update-manager');

// Keep the existing profile (including safeStorage's Local State) across the rename.
const profilePath = path.join(app.getPath('appData'), 'discord-redact-pro');
fs.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
// This form/list application does not need GPU acceleration. Software rendering
// also avoids driver-dependent Chromium startup failures on Windows.
app.disableHardwareAcceleration();
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

let mainWindow;
let currentAbortController = null;
let updateManager = null;

function getAccountsFile() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function getArchiveDir() {
  const dir = path.join(app.getPath('userData'), 'archives');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSavedAccounts() {
  const f = getAccountsFile();
  if (!fs.existsSync(f)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return raw.map((acc) => {
      let decryptedToken = acc.token;
      if (acc.encrypted && safeStorage.isEncryptionAvailable()) {
        try {
          decryptedToken = safeStorage.decryptString(Buffer.from(acc.token, 'hex'));
        } catch (_) {}
      }
      return { id: acc.id, username: acc.username, token: decryptedToken };
    });
  } catch (_) {
    return [];
  }
}

function saveAccountSecure(acc) {
  const f = getAccountsFile();
  let list = [];
  if (fs.existsSync(f)) {
    try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  }
  list = list.filter((x) => x.id !== acc.id);

  let tokenToStore = acc.token;
  let isEncrypted = false;
  if (safeStorage.isEncryptionAvailable()) {
    tokenToStore = safeStorage.encryptString(acc.token).toString('hex');
    isEncrypted = true;
  }

  list.push({ id: acc.id, username: acc.username, token: tokenToStore, encrypted: isEncrypted });
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: `NeonSweep v${app.getVersion()}`,
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#090f14',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  if (!ownsInstance) return;
  const { autoUpdater } = require('electron-updater');
  updateManager = new UpdateManager({
    autoUpdater,
    isPackaged: app.isPackaged,
    isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    configured: fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    currentVersion: app.getVersion(),
    hasActiveJob: () => Boolean(currentAbortController),
    notify: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-state', state);
    }
  });
  createWindow();
  updateManager.start();
});
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  updateManager?.dispose();
  currentAbortController?.abort();
});

ipcMain.handle('get-saved-accounts', () => loadSavedAccounts());
ipcMain.handle('get-app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE), name: 'NeonSweep' }));
ipcMain.handle('get-update-state', () => updateManager?.getState());
ipcMain.handle('check-for-updates', () => updateManager?.check());
ipcMain.handle('install-update', () => updateManager?.install());

ipcMain.handle('save-account', (_, acc) => {
  saveAccountSecure(acc);
  return loadSavedAccounts();
});

ipcMain.handle('open-discord-login', async () => {
  return new Promise((resolve) => {
    let resolved = false;
    const loginWin = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow,
      modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    loginWin.setMenuBarVisibility(false);

    const filter = { urls: ['https://discord.com/api/v9/*'] };
    const listener = (details, callback) => {
      const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
      if (auth && !auth.startsWith('Bot ') && auth.length > 25 && !resolved) {
        resolved = true;
        session.defaultSession.webRequest.onBeforeSendHeaders(filter, null);
        loginWin.close();
        resolve(auth);
      }
      callback({ requestHeaders: details.requestHeaders });
    };

    session.defaultSession.webRequest.onBeforeSendHeaders(filter, listener);
    loginWin.loadURL('https://discord.com/login');

    loginWin.on('closed', () => {
      if (!resolved) {
        session.defaultSession.webRequest.onBeforeSendHeaders(filter, null);
        resolve(null);
      }
    });
  });
});

ipcMain.handle('validate-token', async (_, token) => {
  // Temporary client creation for validation
  const client = require('axios').create({
    baseURL: 'https://discord.com/api/v9',
    headers: { Authorization: token.trim(), 'Content-Type': 'application/json' }
  });
  const res = await client.get('/users/@me');
  return res.data;
});

ipcMain.handle('fetch-workspace', async (_, token) => {
  const client = require('axios').create({
    baseURL: 'https://discord.com/api/v9',
    headers: { Authorization: token.trim(), 'Content-Type': 'application/json' }
  });
  const [guilds, dms] = await Promise.all([client.get('/users/@me/guilds'), client.get('/users/@me/channels')]);
  return { guilds: guilds.data, dms: dms.data };
});

ipcMain.handle('fetch-guild-channels', async (_, { token, guildId }) => {
  const client = require('axios').create({
    baseURL: 'https://discord.com/api/v9',
    headers: { Authorization: token.trim(), 'Content-Type': 'application/json' }
  });
  const res = await client.get(`/guilds/${guildId}/channels`);
  return res.data;
});

ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('start-job', async (_, cfg) => {
  if (currentAbortController) return { error: 'A job is already running. Stop it and wait for completion.' };
  const controller = new AbortController();
  currentAbortController = controller;
  updateManager?.jobStateChanged();

  try {
    const stats = await runJob({ ...cfg, archiveDir: getArchiveDir() }, {
      onLog: (msg) => mainWindow.webContents.send('job-log', msg),
      onPreview: (item) => mainWindow.webContents.send('preview-match', item),
      onStats: (st) => mainWindow.webContents.send('job-stats', st)
    }, controller.signal);
    return { stats };
  } catch (err) {
    return err.message === 'Aborted' ? { aborted: true } : { error: err.message };
  } finally {
    if (currentAbortController === controller) currentAbortController = null;
    updateManager?.jobStateChanged();
  }
});

ipcMain.handle('delete-reviewed', async (_, p) => {
  if (currentAbortController) return { error: 'A job is already running.' };
  const controller = new AbortController();
  currentAbortController = controller;
  updateManager?.jobStateChanged();

  try {
    const stats = await deleteReviewedItems(
      p.token,
      p.authorId,
      p.items,
      p.overwriteEnabled,
      p.overwriteText,
      getArchiveDir(),
      (msg) => mainWindow.webContents.send('job-log', msg),
      (st) => mainWindow.webContents.send('job-stats', st),
      controller.signal
    );
    return { stats };
  } catch (err) {
    return err.message === 'Aborted' ? { aborted: true } : { error: err.message };
  } finally {
    if (currentAbortController === controller) currentAbortController = null;
    updateManager?.jobStateChanged();
  }
});

ipcMain.handle('stop-job', () => {
  if (currentAbortController) {
    currentAbortController.abort();
  }
  mainWindow.webContents.send('job-log', '[STOPPED] Job aborted by user.');
});
