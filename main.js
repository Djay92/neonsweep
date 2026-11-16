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

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// Tokens copied from DevTools often arrive wrapped in quotes.
function cleanToken(token) {
  return String(token || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

// Plain-language errors only: Axios errors carry the Authorization header.
async function discordGet(token, url) {
  try {
    const res = await require('axios').get(`https://discord.com/api/v9${url}`, {
      timeout: 20000,
      headers: { Authorization: cleanToken(token), 'User-Agent': BROWSER_USER_AGENT }
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    let message;
    if (status === 401) message = 'Discord rejected this token. It has expired or been signed out. Log in with Discord again to get a new one.';
    else if (status === 403) message = 'Discord blocked this request. Open Discord, complete any verification it asks for, then try again.';
    else if (status === 429) message = 'Discord is rate limiting this connection. Wait a minute and try again.';
    else if (status) message = `Discord returned an error (HTTP ${status}). Try again shortly.`;
    else message = 'Could not reach Discord. Check your internet connection and try again.';
    const error = new Error(message);
    error.status = status;
    throw error;
  }
}

ipcMain.handle('open-discord-login', async () => {
  // A fresh in-memory session per login: a cached, signed-out Discord session
  // would otherwise hand back its dead token before the login form appears.
  const loginSession = session.fromPartition('discord-login');
  await loginSession.clearStorageData();
  // Older versions logged in through the default profile and left a session on disk.
  session.defaultSession.clearStorageData({ origin: 'https://discord.com' }).catch(() => {});
  loginSession.setUserAgent(BROWSER_USER_AGENT);

  return new Promise((resolve) => {
    let resolved = false;
    const tried = new Set();
    const loginWin = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow,
      modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: loginSession }
    });
    loginWin.setMenuBarVisibility(false);

    const filter = { urls: ['https://discord.com/api/*'] };
    const finish = (token) => {
      if (resolved) return;
      resolved = true;
      loginSession.webRequest.onBeforeSendHeaders(filter, null);
      if (!loginWin.isDestroyed()) loginWin.close();
      resolve(token);
    };
    const listener = (details, callback) => {
      callback({ requestHeaders: details.requestHeaders });
      const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
      if (!auth || resolved || auth.startsWith('Bot ') || auth.length <= 25 || tried.has(auth)) return;
      tried.add(auth);
      // Only accept a token Discord itself confirms; keep the window open otherwise.
      discordGet(auth, '/users/@me').then(() => finish(auth)).catch((err) => {
        if (err.status !== 401) tried.delete(auth);
      });
    };

    loginSession.webRequest.onBeforeSendHeaders(filter, listener);
    loginWin.loadURL('https://discord.com/login');
    loginWin.on('closed', () => finish(null));
  });
});

ipcMain.handle('validate-token', (_, token) => discordGet(token, '/users/@me'));

ipcMain.handle('fetch-workspace', async (_, token) => {
  const [guilds, dms] = await Promise.all([discordGet(token, '/users/@me/guilds'), discordGet(token, '/users/@me/channels')]);
  return { guilds, dms };
});

ipcMain.handle('fetch-guild-channels', (_, { token, guildId }) => discordGet(token, `/guilds/${guildId}/channels`));

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
