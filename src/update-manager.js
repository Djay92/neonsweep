const SIX_HOURS = 6 * 60 * 60 * 1000;

function cleanVersion(value, fallback = '') {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : fallback;
}

/** Coordinates automatic downloads without interrupting a running Discord job. */
class UpdateManager {
  constructor({
    autoUpdater,
    enabled = true,
    isPackaged = false,
    platform = process.platform,
    isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
    configured = false,
    currentVersion = '',
    hasActiveJob = () => false,
    notify = () => {},
    startupDelayMs = 10000,
    checkIntervalMs = SIX_HOURS,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    this.autoUpdater = autoUpdater;
    this.hasActiveJob = hasActiveJob;
    this.notify = notify;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.startupDelayMs = Math.max(0, Number(startupDelayMs) || 0);
    this.checkIntervalMs = Math.max(1000, Number(checkIntervalMs) || SIX_HOURS);
    this.listeners = [];
    this.timer = null;
    this.checkPromise = null;
    this.started = false;
    this.disposed = false;

    let reason = null;
    let message = 'Updates download automatically. Installation happens when you close the app or choose Restart to update.';
    if (!isPackaged) {
      reason = 'development';
      message = 'Automatic updates are available in the installed app.';
    } else if (platform !== 'win32') {
      reason = 'platform';
      message = 'Automatic updates are configured for the Windows installer.';
    } else if (isPortable) {
      reason = 'portable';
      message = 'Install the setup version once to receive automatic updates.';
    } else if (!configured) {
      reason = 'unconfigured';
      message = 'A release source has not been configured for this build.';
    } else if (!enabled || !autoUpdater) {
      reason = 'disabled';
      message = 'Automatic updates are disabled for this build.';
    }
    this.state = {
      status: reason ? 'disabled' : 'idle',
      reason,
      version: cleanVersion(currentVersion),
      progress: null,
      message
    };
    this.supported = !reason;
    if (this.supported) this.bindUpdater();
  }

  bindUpdater() {
    this.autoUpdater.autoDownload = true;
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.autoUpdater.allowDowngrade = false;
    this.autoUpdater.allowPrerelease = false;
    // Only full NSIS installers are published by this application.
    this.autoUpdater.disableWebInstaller = true;
    const on = (event, callback) => {
      const listener = (...args) => {
        if (!this.disposed) callback(...args);
      };
      this.listeners.push([event, listener]);
      this.autoUpdater.on(event, listener);
    };
    on('checking-for-update', () => this.emit({ status: 'checking', progress: null, message: 'Checking for updates…' }));
    on('update-available', (info) => this.emit({
      status: 'available', version: cleanVersion(info?.version, this.state.version), progress: 0,
      message: 'An update is available. Downloading in the background…'
    }));
    on('update-not-available', () => this.emit({ status: 'current', progress: null, message: 'You have the latest version.' }));
    on('download-progress', (info) => {
      const percent = Number(info?.percent);
      this.emit({
        status: 'downloading', progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
        message: 'Downloading update in the background…'
      });
    });
    on('update-downloaded', (info) => {
      this.emit({ status: 'downloaded', version: cleanVersion(info?.version, this.state.version), progress: 100, message: this.readyMessage() });
    });
    // Do not forward exception messages: provider errors can contain private URLs or tokens.
    on('error', () => this.reportError());
    on('update-cancelled', () => this.emit({ status: 'idle', progress: null, message: 'Update download paused. Check again to retry.' }));
  }

  jobActive() {
    try { return Boolean(this.hasActiveJob()); }
    catch (_) { return true; }
  }

  readyMessage() {
    return this.jobActive()
      ? 'Update ready. Finish or stop the current job before restarting. It will also install when you close the app.'
      : 'Update ready. Restart to install, or it will install when you close the app.';
  }

  getState() {
    const jobActive = this.jobActive();
    return {
      ...this.state,
      supported: this.supported && !this.disposed,
      jobActive,
      canInstall: !this.disposed && this.state.status === 'downloaded' && !jobActive
    };
  }

  emit(patch = {}) {
    if (this.disposed) return this.getState();
    Object.assign(this.state, patch);
    const state = this.getState();
    try { this.notify(state); } catch (_) { /* A closed window must not break the updater. */ }
    return state;
  }

  reportError() {
    return this.emit({ status: 'error', progress: null, message: 'Could not update the app. Check your connection and try again.' });
  }

  check() {
    if (!this.supported || this.disposed) return Promise.resolve(this.getState());
    if (this.checkPromise) return this.checkPromise;
    if (['available', 'downloading', 'downloaded', 'installing'].includes(this.state.status)) return Promise.resolve(this.getState());
    this.emit({ status: 'checking', progress: null, message: 'Checking for updates…' });
    // The microtask also catches a synchronous provider error and prevents duplicate checks.
    this.checkPromise = Promise.resolve().then(() => {
      if (this.disposed) return null;
      return this.autoUpdater.checkForUpdates();
    }).catch(() => this.reportError()).then(() => this.getState()).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  install() {
    if (!this.supported || this.disposed) return this.getState();
    if (this.state.status !== 'downloaded') return this.getState();
    if (this.jobActive()) return this.emit({ message: this.readyMessage() });
    this.emit({ status: 'installing', message: 'Restarting to install the update…' });
    try { this.autoUpdater.quitAndInstall(true, true); }
    catch (_) { return this.reportError(); }
    return this.getState();
  }

  jobStateChanged() {
    return this.emit(this.state.status === 'downloaded' ? { message: this.readyMessage() } : {});
  }

  start() {
    if (!this.supported || this.started || this.disposed) return this.getState();
    this.started = true;
    this.schedule(this.startupDelayMs);
    return this.emit();
  }

  schedule(delay) {
    this.timer = this.setTimer(async () => {
      this.timer = null;
      await this.check();
      if (!this.disposed && this.started) this.schedule(this.checkIntervalMs);
    }, delay);
    this.timer?.unref?.();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const [event, listener] of this.listeners) this.autoUpdater.removeListener(event, listener);
    this.listeners.length = 0;
  }
}

module.exports = { UpdateManager };
