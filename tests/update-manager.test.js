const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager } = require('../src/update-manager');

function fixture(options = {}) {
  const updater = new EventEmitter();
  const notifications = [];
  let checks = 0;
  const installs = [];
  updater.checkForUpdates = async () => { checks++; updater.emit('update-not-available', { version: '4.0.5' }); };
  updater.quitAndInstall = (...args) => installs.push(args);
  const manager = new UpdateManager({
    autoUpdater: updater, isPackaged: true, platform: 'win32', isPortable: false,
    configured: true, currentVersion: '4.0.5', notify: (state) => notifications.push(state), ...options
  });
  return { updater, manager, notifications, installs, checks: () => checks };
}

test('development, portable, unsupported and unconfigured builds never check for updates', async () => {
  for (const [options, reason] of [
    [{ isPackaged: false }, 'development'], [{ isPortable: true }, 'portable'],
    [{ platform: 'darwin' }, 'platform'], [{ configured: false }, 'unconfigured'], [{ enabled: false }, 'disabled']
  ]) {
    const f = fixture(options);
    f.manager.start();
    await f.manager.check();
    f.manager.install();
    assert.equal(f.manager.getState().status, 'disabled');
    assert.equal(f.manager.getState().reason, reason);
    assert.equal(f.checks(), 0);
    assert.equal(f.installs.length, 0);
    assert.equal(f.updater.listenerCount('update-downloaded'), 0);
    f.manager.dispose();
  }
});

test('updater uses background downloads, normal-exit installation and stable releases', () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, true);
  assert.equal(f.updater.autoInstallOnAppQuit, true);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.allowPrerelease, false);
  assert.equal(f.updater.disableWebInstaller, true);
  f.manager.dispose();
});

test('launch and six-hour checks are scheduled once and disposal clears the pending check', async () => {
  const pending = new Map();
  let id = 0;
  const f = fixture({ setTimer: (fn, delay) => { pending.set(++id, { fn, delay }); return id; }, clearTimer: (timer) => pending.delete(timer) });
  f.manager.start();
  f.manager.start();
  assert.equal(pending.size, 1);
  assert.equal(pending.get(1).delay, 10000);
  const startup = pending.get(1); pending.delete(1);
  await startup.fn();
  assert.equal(f.checks(), 1);
  assert.equal(pending.get(2).delay, 6 * 60 * 60 * 1000);
  const recurring = pending.get(2); pending.delete(2);
  await recurring.fn();
  assert.equal(f.checks(), 2);
  f.manager.dispose();
  assert.equal(pending.size, 0);
});

test('concurrent checks share one request and a later check can run', async () => {
  const f = fixture();
  let resolve;
  let calls = 0;
  f.updater.checkForUpdates = () => { calls++; return new Promise((r) => { resolve = r; }); };
  const first = f.manager.check();
  const second = f.manager.check();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  f.updater.emit('update-not-available'); resolve();
  assert.equal((await first).status, 'current');
  const next = f.manager.check(); await Promise.resolve();
  assert.equal(calls, 2);
  f.updater.emit('update-not-available'); resolve(); await next;
  f.manager.dispose();
});

test('download events expose safe version and bounded numeric progress', async () => {
  const f = fixture();
  f.updater.emit('update-available', { version: '4.1.0' });
  assert.equal(f.manager.getState().version, '4.1.0');
  f.updater.emit('download-progress', { percent: 42.5, url: 'https://private/?token=secret' });
  assert.equal(f.manager.getState().progress, 42.5);
  assert.equal(f.manager.getState().status, 'downloading');
  await f.manager.check();
  assert.equal(f.checks(), 0);
  f.updater.emit('download-progress', { percent: 150 });
  assert.equal(f.manager.getState().progress, 100);
  f.updater.emit('download-progress', { percent: NaN });
  assert.equal(f.manager.getState().progress, 0);
  f.updater.emit('update-downloaded', { version: 'https://private/?token=secret' });
  assert.equal(f.manager.getState().version, '4.1.0');
  assert.equal(f.manager.getState().canInstall, true);
  assert.equal(JSON.stringify(f.notifications).includes('secret'), false);
  f.manager.dispose();
});

test('installation requires downloaded update and cannot interrupt an active job', () => {
  let busy = true;
  const f = fixture({ hasActiveJob: () => busy });
  f.manager.install();
  assert.equal(f.installs.length, 0);
  f.updater.emit('update-downloaded', { version: '4.1.0' });
  assert.equal(f.manager.getState().canInstall, false);
  assert.match(f.manager.install().message, /Finish or stop/);
  assert.equal(f.installs.length, 0);
  busy = false;
  assert.equal(f.manager.jobStateChanged().canInstall, true);
  assert.equal(f.manager.install().status, 'installing');
  assert.deepEqual(f.installs, [[true, true]]);
  f.manager.install();
  assert.equal(f.installs.length, 1);
  f.manager.dispose();
});

test('job-state callback failure prevents a restart', () => {
  const f = fixture({ hasActiveJob: () => { throw new Error('job status unavailable'); } });
  f.updater.emit('update-downloaded', { version: '4.1.0' });
  f.manager.install();
  assert.equal(f.installs.length, 0);
  assert.equal(f.manager.getState().canInstall, false);
  f.manager.dispose();
});

test('provider exceptions and error events never expose credentials', async () => {
  const f = fixture();
  f.updater.checkForUpdates = () => { throw new Error('https://user:password@example.invalid/?token=super-secret'); };
  assert.equal((await f.manager.check()).status, 'error');
  f.updater.emit('error', new Error('GH_TOKEN=super-secret'));
  assert.equal(f.manager.getState().status, 'error');
  assert.equal(JSON.stringify(f.notifications).includes('super-secret'), false);
  assert.equal(JSON.stringify(f.notifications).includes('password'), false);
  f.manager.dispose();
});

test('a failed restart is shown safely and does not leave an installing state', () => {
  const f = fixture();
  f.updater.quitAndInstall = () => { throw new Error('private download URI'); };
  f.updater.emit('update-downloaded', { version: '4.1.0' });
  assert.equal(f.manager.install().status, 'error');
  assert.equal(f.manager.getState().message.includes('private'), false);
  f.manager.dispose();
});

test('dispose detaches only owned listeners and stops a check queued in a microtask', async () => {
  const f = fixture();
  const otherListener = () => {};
  f.updater.on('download-progress', otherListener);
  const check = f.manager.check();
  f.manager.dispose();
  f.manager.dispose();
  await check;
  assert.equal(f.checks(), 0);
  assert.deepEqual(f.updater.listeners('download-progress'), [otherListener]);
  assert.equal(f.manager.getState().supported, false);
  assert.equal(f.manager.getState().canInstall, false);
  assert.equal(f.manager.getState().status, 'checking');
});
