// Exercise the real renderer, preload, IPC, and scanner without account data or network access.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appRoot = process.env.REDACT_TEST_APP_ROOT || path.join(__dirname, '..');
const appRequire = require('node:module').createRequire(path.join(appRoot, 'package.json'));
const axios = appRequire('axios');
const { runJob } = appRequire('./src/engine');
const { version } = appRequire('./package.json');

const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-preview-test-'));
app.setPath('userData', isolatedData);
app.disableHardwareAcceleration();
const authorId = '123456789012345678';
const channelId = '223456789012345678';
const requests = [];
const actualJobStats = [];
let immediateFixture = false, immediateDeletes = 0, finishImmediateRequest;
const screenshotDir = path.join(__dirname, '..', '.impeccable', 'review');
let updateChecks = 0, updateInstalls = 0, finishUpdateCheck;
let updateState = { status: 'idle', version, progress: null, message: 'Updates download automatically in the background.', supported: true, canInstall: false, jobActive: false };
function sendUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  win.webContents.send('update-state', updateState);
  return updateState;
}
axios.create = () => ({ request: async (request) => {
  requests.push({ method: request.method, url: request.url });
  if (request.method === 'DELETE') {
    assert.equal(immediateFixture, true, 'Mutation is allowed only in the simulated immediate-deletion test');
    if (++immediateDeletes === 4) await new Promise((resolve) => { finishImmediateRequest = resolve; });
    else await new Promise((resolve) => setTimeout(resolve, 30));
    return { status: 204, headers: { 'x-ratelimit-remaining': '10' } };
  }
  assert.equal(request.method, 'GET', 'Unexpected fixture request');
  assert.equal(request.url, `/channels/${channelId}/messages`);
  if (immediateFixture) return { status: 200, headers: { 'x-ratelimit-remaining': '10' }, data: Array.from({ length: 6 }, (_, i) => ({ id: String(1537213327967780800n - BigInt(i)), channel_id: channelId, type: 0, author: { id: i < 4 ? authorId : '323456789012345678' }, content: 'Simulated immediate-deletion item ' + (i + 1), timestamp: '2026-10-20T12:00:00Z' })) };
  return { status: 200, data: [
    { id: '1537213327967780966', type: 0, channel_id: channelId, author: { id: authorId, username: 'PreviewTest' }, content: 'Preview test: my DM message', timestamp: '2026-10-20T12:00:00Z', attachments: [{ filename: 'project-notes.png', content_type: 'image/png', size: 1024 }], embeds: [{ type: 'rich', title: 'Project planning reference', url: 'https://example.invalid/project' }] },
    { id: '1537213327967780965', type: 0, channel_id: channelId, author: { id: '323456789012345678' }, content: 'Other person message', timestamp: '2026-10-20T11:00:00Z' }
  ] };
} });

let win;
let jobDone = false;
const timeout = setTimeout(() => { console.error('Electron preview smoke test timed out'); app.exit(1); }, 30000);
ipcMain.handle('get-app-info', () => ({ version, packaged: false, portable: false, name: 'NeonSweep' }));
ipcMain.handle('get-update-state', () => updateState);
ipcMain.handle('check-for-updates', () => new Promise((resolve) => {
  updateChecks++;
  sendUpdateState({ status: 'checking', message: 'Checking for updates…' });
  finishUpdateCheck = () => resolve(sendUpdateState({ status: 'current', message: 'You have the latest version.' }));
}));
ipcMain.handle('install-update', () => {
  updateInstalls++;
  assert.equal(updateState.status, 'downloaded');
  assert.equal(updateState.canInstall, true);
  return sendUpdateState({ status: 'installing', canInstall: false, message: 'Simulated restart only. No installer is executed.' });
});
ipcMain.handle('get-saved-accounts', () => []);
ipcMain.handle('save-account', () => []);
ipcMain.handle('validate-token', (_, token) => {
  assert.equal(token, 'simulated-token');
  return { id: authorId, username: 'PreviewTest' };
});
ipcMain.handle('fetch-workspace', () => ({
  guilds: [
    { id: '423456789012345678', name: 'Design community' },
    { id: '523456789012345678', name: 'Friends & projects' }
  ],
  dms: [
    { id: channelId, recipients: [{ username: 'DMTest' }] },
    { id: '623456789012345678', recipients: [{ username: 'Alex' }] },
    { id: '723456789012345678', name: 'Weekend plans', recipients: [] }
  ]
}));
ipcMain.handle('start-job', async (_, cfg) => {
  try {
    const stats = await runJob(cfg, {
      onLog: (msg) => win.webContents.send('job-log', msg),
      onStats: (st) => { actualJobStats.push(st); win.webContents.send('job-stats', st); },
      onPreview: (item) => win.webContents.send('preview-match', item)
    });
    return { stats };
  } catch (error) { return { error: error.message }; }
  finally { jobDone = true; }
});

let finishReviewed;
ipcMain.handle('delete-reviewed', (_, payload) => new Promise((resolve) => {
  assert.equal(payload.items.length, 4);
  const startedAt = Date.now() - 9000;
  const snapshot = (processed, completedItem, waiting = false) => ({ scanned: 4, matched: 4, deleted: processed, skipped: 0, phase: 'delete-reviewed', total: 4, processed, remaining: 4 - processed, startedAt, elapsedMs: 9000, etaMs: processed ? (4 - processed) * 3000 + (waiting ? 3000 : 0) : null, ratePerMinute: 20, waitUntilMs: waiting ? Date.now() + 3000 : null, waitReason: waiting ? 'rate-limit' : null, completedItem });
  win.webContents.send('job-stats', snapshot(0, null));
  for (let i = 0; i < 3; i++) win.webContents.send('job-stats', snapshot(i + 1, payload.items[i], i === 2));
  finishReviewed = () => {
    const stats = snapshot(4, payload.items[3]);
    win.webContents.send('job-stats', stats);
    resolve({ stats });
  };
}));

async function waitFor(expression) {
  const start = Date.now();
  while (!await win.webContents.executeJavaScript(expression)) {
    if (Date.now() - start > 8000) throw new Error(`UI condition timed out: ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Test actual layout rather than the presence of classes: the previous portable
// build contained Tailwind source directives, so the DOM existed but was unstyled.
async function checkLayoutAndCapture(width, height, phase = 'preview', step = null) {
  win.setContentSize(width, height);
  await waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`);
  const layout = await win.webContents.executeJavaScript(`(() => {
    const measure = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom,
        display: style.display, visibility: style.visibility,
        columns: style.gridTemplateColumns,
        background: style.backgroundColor,
        padding: parseFloat(style.paddingTop),
        radius: parseFloat(style.borderTopLeftRadius)
      };
    };
    return {
      width: innerWidth, height: innerHeight,
      scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      bodyMargin: getComputedStyle(document.body).margin,
      font: getComputedStyle(document.body).fontFamily,
      stylesheets: [...document.styleSheets].map((sheet) => ({ href: sheet.href, rules: sheet.cssRules.length })),
      shell: measure('.app-shell'), grid: measure('.workspace-grid'),
      steps: [...document.querySelectorAll('[data-step-panel]')].map((panel) => ({ step: panel.dataset.stepPanel, hidden: panel.hidden, rect: measure('[data-step-panel="' + panel.dataset.stepPanel + '"]') })),
      targets: measure('[data-panel="targets"]'),
      filters: measure('[data-panel="filters"]'),
      review: measure('[data-panel="review"]'),
      updates: measure('#updatesPanel'),
      primary: measure(${JSON.stringify(phase === 'updates' ? '#checkUpdatesBtn' : step ? step === 'account' ? '#connectBtn' : step === 'launch' ? '#startActionBtn' : `[data-step-panel="${step}"] [data-next-step]` : '#stopBtn')}),
      token: measure('#tokenInput')
    };
  })()`);
  const atSize = `${width}x${height}`;
  assert.ok(layout.scrollWidth <= width + 1, `No horizontal page overflow at ${atSize}: ${layout.scrollWidth}px`);
  assert.equal(layout.bodyMargin, '0px', `Local CSS reset is applied at ${atSize}`);
  assert.match(layout.font, /sans-serif|Segoe UI|Inter/i, `Application font is applied at ${atSize}`);
  assert.ok(layout.stylesheets.some((sheet) => sheet.href?.startsWith('file:') && sheet.rules > 20), 'A populated local stylesheet is loaded');
  assert.ok(layout.shell, 'The application shell exists');
  assert.ok(['grid', 'flex'].includes(layout.shell.display), `Application shell is styled at ${atSize}`);
  assert.ok(layout.grid, 'Workspace exists');
  assert.ok(['grid', 'flex'].includes(layout.grid.display), 'Workspace has a deliberate layout');
  if (phase === 'updates') {
    assert.ok(layout.steps.every((panel) => panel.hidden), 'Setup steps are hidden during update settings');
    assert.ok(layout.updates.width > width * 0.5 && layout.updates.height > 150, 'Update settings use the available workspace');
    assert.equal(layout.review.height, 0, 'Review is hidden during update settings');
  } else if (step) {
    assert.deepEqual(layout.steps.filter((panel) => !panel.hidden).map((panel) => panel.step), [step], 'Only the current setup step is visible');
    const active = layout.steps.find((panel) => panel.step === step).rect;
    assert.ok(active.width > width * 0.5 && active.height > 150, `${step} uses the available workspace`);
    assert.ok(layout.review.height === 0, 'Review is hidden during setup');
  } else {
    assert.ok(layout.steps.every((panel) => panel.hidden), 'Setup steps are hidden during a job');
    assert.ok(layout.review.width > width * 0.6 && layout.review.height > 250, 'Review results use available workspace');
    assert.ok(layout.review.right <= width + 1, 'Review stays in viewport');
  }
  assert.ok(layout.primary.width > 55 && layout.primary.height >= 32, `The primary action is styled at ${atSize}`);
  assert.ok(layout.primary.x >= 0 && layout.primary.y >= 0 && layout.primary.right <= width + 1 && layout.primary.bottom <= height + 1, `The primary action is visible without scrolling at ${atSize}`);
  assert.notEqual(layout.primary.background, 'rgba(0, 0, 0, 0)', 'The primary action has a visible button background');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `neonsweep-v${version}-${phase}-${atSize}.png`);
  fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
  console.log(`Layout passed at ${atSize}; screenshot: ${screenshotPath}`);
}

app.whenReady().then(async () => {
  try {
    const stylesheet = fs.readFileSync(path.join(appRoot, 'src', 'styles.css'), 'utf8');
    assert.doesNotMatch(stylesheet, /@tailwind\b/, 'Shipped CSS must contain native rules or compiled utilities, not Tailwind build directives');
    win = new BrowserWindow({
      show: false, width: 1440, height: 960, useContentSize: true, enableLargerThanScreen: true,
      webPreferences: { preload: path.join(appRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    await win.loadFile(path.join(appRoot, 'src', 'index.html'));
    await waitFor(`document.getElementById('runtimeVersion').textContent === 'v${version}'`);
    await waitFor(`document.querySelectorAll('[data-step-panel]').length === 4`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-step-panel="account"]').hidden`), false);
    for (const [width, height] of [[1440, 960], [1100, 760]]) await checkLayoutAndCapture(width, height, 'account', 'account');
    // Update IPC is fully simulated; no release server or installer is contacted.
    await win.webContents.executeJavaScript(`document.getElementById('updatesNavBtn').click();`);
    await waitFor(`!document.getElementById('updatesPanel').hidden`);
    for (const [width, height] of [[1440, 960], [1100, 760]]) await checkLayoutAndCapture(width, height, 'updates');
    await win.webContents.executeJavaScript(`document.getElementById('checkUpdatesBtn').click();`);
    await waitFor(`document.getElementById('checkUpdatesBtn').disabled && document.getElementById('updateStatus').textContent.includes('Checking')`);
    assert.equal(updateChecks, 1);
    finishUpdateCheck();
    await waitFor(`!document.getElementById('checkUpdatesBtn').disabled && document.getElementById('updateStatus').textContent.includes('up to date')`);
    sendUpdateState({ status: 'downloading', progress: 42, message: 'Downloading a simulated update…' });
    await waitFor(`!document.getElementById('updateProgress').hidden && document.getElementById('updateProgress').value === 42`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('checkUpdatesBtn').disabled`), true);
    sendUpdateState({ status: 'downloaded', version: '5.0.1', progress: 100, canInstall: true, message: 'Update ready. Restart to install.' });
    await waitFor(`!document.getElementById('installUpdateBtn').hidden && !document.getElementById('installUpdateBtn').disabled`);
    await win.webContents.executeJavaScript(`document.getElementById('installUpdateBtn').click();`);
    await waitFor(`document.getElementById('updateStatus').textContent.includes('Restarting')`);
    assert.equal(updateInstalls, 1);
    sendUpdateState({ status: 'current', version, progress: null, canInstall: false, message: 'You have the latest version.' });
    await win.webContents.executeJavaScript(`document.getElementById('settingsBackBtn').click();`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-step-panel="account"]').hidden`), false);
    await win.webContents.executeJavaScript(`document.getElementById('tokenInput').value = 'simulated-token'; document.getElementById('connectBtn').click();`);
    await waitFor(`document.querySelectorAll('.dm-box').length === 3 && !document.querySelector('[data-step-panel="targets"]').hidden`);
    await win.webContents.executeJavaScript(`document.querySelector('[data-next-step="rules"]').click();`);
    await waitFor(`!document.getElementById('setupNotice').hidden`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-step-panel="targets"]').hidden`), false, 'Rules require a conversation selection');
    await win.webContents.executeJavaScript(`document.getElementById('showDmsBtn').click(); document.querySelector('.dm-box').checked = true; document.querySelector('.dm-box').dispatchEvent(new Event('change', { bubbles: true }));`);
    for (const [width, height] of [[1440, 960], [1100, 760]]) await checkLayoutAndCapture(width, height, 'targets', 'targets');
    await win.webContents.executeJavaScript(`document.querySelector('[data-next-step="rules"]').click();`);
    await waitFor(`!document.querySelector('[data-step-panel="rules"]').hidden`);
    for (const [width, height] of [[1440, 960], [1100, 760]]) await checkLayoutAndCapture(width, height, 'rules', 'rules');
    await win.webContents.executeJavaScript(`document.querySelector('[data-next-step="launch"]').click();`);
    await waitFor(`!document.querySelector('[data-step-panel="launch"]').hidden`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('launchTargets').textContent`), /1 DM/);
    for (const [width, height] of [[1440, 960], [1100, 760]]) await checkLayoutAndCapture(width, height, 'launch', 'launch');
    await win.webContents.executeJavaScript(`document.getElementById('moderatorMode').checked = true; document.getElementById('targetAuthorId').value = '${authorId}'; document.getElementById('deleteForumTopics').checked = true; document.getElementById('removeEveryoneReactions').checked = true; document.getElementById('pipelineSelect').value = 'reactions'; updatePipeline(); showStep('launch', true);`);
    const advancedSummary = await win.webContents.executeJavaScript(`document.getElementById('launchRules').textContent`);
    assert.match(advancedSummary, new RegExp('Moderator mode: member ' + authorId));
    assert.match(advancedSummary, /Delete entire forum topics \/ threads/);
    assert.match(advancedSummary, /Clear everyone's reactions/);
    for (const [width, height] of [[1440, 960], [1100, 760]]) await checkLayoutAndCapture(width, height, 'advanced-launch', 'launch');
    await win.webContents.executeJavaScript(`document.getElementById('moderatorMode').checked = false; document.getElementById('targetAuthorId').value = ''; document.getElementById('deleteForumTopics').checked = false; document.getElementById('removeEveryoneReactions').checked = false; document.getElementById('pipelineSelect').value = 'search'; updatePipeline(); showStep('launch', true);`);
    await win.webContents.executeJavaScript(`document.getElementById('startActionBtn').click();`);
    await waitFor(`document.getElementById('stScanned').textContent === '2' && document.querySelectorAll('.rev-check').length === 1 && !document.getElementById('previewBtn').disabled`);
    const result = await win.webContents.executeJavaScript(`({ scanned: document.getElementById('stScanned').textContent, matched: document.getElementById('stMatched').textContent, text: document.getElementById('reviewTable').textContent, logs: document.getElementById('logBox').textContent })`);
    assert.equal(jobDone, true);
    assert.equal(result.matched, '1');
    assert.match(result.text, /Preview test: my DM message/);
    assert.match(result.text, /DMTest/);
    assert.match(result.text, /Message 1537213327967780966 · PreviewTest/);
    assert.match(result.text, /File: project-notes\.png/);
    assert.match(result.text, /Embed: Project planning reference/);
    assert.doesNotMatch(result.text, /Other person message/);
    assert.match(result.logs, /\[History\].*received 2 messages/);
    assert.equal(requests.length, 1);
    const completePreview = await win.webContents.executeJavaScript(`({ date: document.querySelector('.preview-date').textContent, expectedDate: new Date('2026-10-20T12:00:00Z').toLocaleString(), determinate: document.getElementById('jobProgressBar').hasAttribute('value'), progress: document.getElementById('jobProgressBar').value, maximum: document.getElementById('jobProgressBar').max, eta: document.getElementById('estimatedTime').textContent })`);
    assert.equal(completePreview.date, 'DM · DMTest · ' + completePreview.expectedDate, 'Every match identifies its conversation and exact date/time');
    assert.equal(completePreview.determinate, true, 'A finished preview stops its indeterminate progress animation');
    assert.equal(completePreview.progress, completePreview.maximum);
    assert.equal(completePreview.eta, 'Complete');
    for (const [width, height] of [[1440, 960], [1100, 850], [2556, 1368]]) {
      await checkLayoutAndCapture(width, height);
    }
    // Mock reviewed deletion exercises progress, cooldown and remaining-selection UI only.
    for (let i = 1; i <= 3; i++) win.webContents.send('preview-match', { id: `153721332796778097${i}`, channel_id: channelId, author_id: authorId, content: 'Simulated review item ' + i, timestamp: '2026-10-20T12:00:00Z' });
    await waitFor(`document.querySelectorAll('.rev-check').length === 4`);
    await win.webContents.executeJavaScript(`document.getElementById('deleteSelectedBtn').click();`);
    await waitFor(`document.getElementById('progressSummary').textContent.includes('3 of 4') && document.querySelectorAll('.rev-check:checked').length === 1`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('updatesNavBtn').disabled`), true, 'Updates navigation cannot interrupt an active job');
    sendUpdateState({ status: 'downloaded', version: '5.0.1', progress: 100, canInstall: false, jobActive: true, message: 'Finish the current job before restarting.' });
    await waitFor(`document.getElementById('installUpdateBtn').disabled`);
    await win.webContents.executeJavaScript(`document.getElementById('installUpdateBtn').click();`);
    assert.equal(updateInstalls, 1, 'A disabled restart control does not request installation during a job');
    const progress = await win.webContents.executeJavaScript(`({ eta: document.getElementById('estimatedTime').textContent, cooldown: document.getElementById('cooldownStatus').textContent, status: document.getElementById('reviewStatus').textContent })`);
    assert.match(progress.eta, /About/);
    assert.match(progress.cooldown, /Waiting for Discord/);
    assert.equal(progress.status, 'Deleting...');
    await checkLayoutAndCapture(1440, 960, 'deletion');
    await checkLayoutAndCapture(1100, 850, 'deletion');
    finishReviewed();
    await waitFor(`!document.getElementById('previewBtn').disabled && document.querySelectorAll('.rev-check:checked').length === 0`);
    sendUpdateState({ status: 'current', version, progress: null, canInstall: false, jobActive: false, message: 'You have the latest version.' });
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('deleteSelectedBtn').disabled`), true);
    await win.webContents.executeJavaScript(`document.getElementById('backToSetupBtn').click();`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-step-panel="launch"]').hidden`), false, 'Back to setup returns to the launch summary');
    // Use the real engine's immediate-delete flow (all requests are intercepted above).
    immediateFixture = true;
    actualJobStats.length = 0;
    await win.webContents.executeJavaScript(`window.confirm = () => true; document.getElementById('overwriteEnabled').checked = false; document.querySelector('[data-mode="delete"]').click(); document.getElementById('startActionBtn').click();`);
    await waitFor(`document.getElementById('progressSummary').textContent.includes('3 of 4') && document.querySelectorAll('.rev-check').length === 4`);
    assert.equal(immediateDeletes, 4);
    assert.ok(actualJobStats.some((s) => s.phase === 'discover' && s.deleted === 0));
    assert.ok(actualJobStats.filter((s) => s.phase === 'delete-live').every((s) => s.total === 4));
    const immediate = await win.webContents.executeJavaScript(`({ eta: document.getElementById('estimatedTime').textContent, finish: document.getElementById('finishTime').textContent, title: document.getElementById('workspaceTitle').textContent, selected: document.querySelectorAll('.rev-check:checked').length, rate: document.getElementById('processingRate').textContent })`);
    assert.match(immediate.eta, /About/);
    assert.notEqual(immediate.eta, 'About 0s');
    assert.notEqual(immediate.finish, '—');
    assert.equal(immediate.selected, 1);
    assert.match(immediate.title, /Currently deleting/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.notEqual(await win.webContents.executeJavaScript(`document.getElementById('estimatedTime').textContent`), 'About 0s');
    await checkLayoutAndCapture(1440, 960, 'immediate-deletion');
    finishImmediateRequest();
    await waitFor(`!document.getElementById('previewBtn').disabled && document.getElementById('progressSummary').textContent.includes('4 of 4')`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.rev-check:checked').length`), 0);
    console.log('Real engine immediate-delete UI passed: discovery -> known batch total -> numeric ETA/finish -> completion; simulated requests only.');
    console.log(`Electron wizard, updates and DM preview passed (${process.env.REDACT_TEST_APP_ROOT ? 'packaged' : 'workspace'}): ${result.scanned} scanned, ${result.matched} matched, 1 visible review row; no live API calls or installers.`);
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error(error.stack);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});
