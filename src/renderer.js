let currentUser = null;
let authenticatedToken = null;
let jobRunning = false;
let previewOwnerId = null;
let selectedPkgPath = null;
let previewItems = [];
let lastProgress = null;
let progressTimer = null;
let chosenMode = 'preview';
let jobOutcome = 'idle';
let currentStep = 'account';
let updateState = null;
let accountConnecting = false;
const previewRows = new Map();
const conversationNames = new Map();
const actionKey = (item) => [item.channel_id, item.id, item.action || 'message', item.emoji || ''].join(':');

const logBox = document.getElementById('logBox');
const reviewTable = document.getElementById('reviewTable');
const savedAccountsSelect = document.getElementById('savedAccountsSelect');

function duration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderProgress() {
  if (!lastProgress) return;
  const s = lastProgress, now = Date.now();
  const known = Number.isFinite(s.total);
  const timing = globalThis.redactProgressMath.calculateTiming(s, now, jobRunning);
  const stopped = !jobRunning && ['stopped', 'error'].includes(jobOutcome);
  const completed = !jobRunning && jobOutcome === 'completed';
  const eta = stopped ? null : timing.etaMs;
  document.getElementById('jobProgress').hidden = false;
  document.getElementById('progressSummary').textContent = known ? `${s.processed.toLocaleString()} of ${s.total.toLocaleString()} completed · ${timing.remaining.toLocaleString()} remaining` : s.phase === 'discover' ? `Collecting deletion batch · ${s.matched.toLocaleString()} matches queued · ${s.scanned.toLocaleString()} scanned` : `${s.scanned.toLocaleString()} scanned · ${s.matched.toLocaleString()} ${s.matched === 1 ? 'match' : 'matches'} found`;
  const bar = document.getElementById('jobProgressBar');
  bar.max = known ? Math.max(1, s.total) : 100;
  if (completed) { bar.max = 1; bar.value = 1; }
  else if (known) bar.value = s.processed; else bar.removeAttribute('value');
  document.getElementById('elapsedTime').textContent = duration(timing.elapsedMs);
  document.getElementById('estimatedTime').textContent = completed ? 'Complete' : stopped ? 'Stopped' : eta === null ? known ? 'Measuring deletion speed...' : s.phase === 'discover' ? 'Available after collection' : 'Total not known yet' : `About ${duration(eta)}`;
  document.getElementById('finishTime').textContent = completed && s.finishedAt ? new Date(s.finishedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : eta === null ? '—' : new Date(now + eta).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  document.getElementById('processingRate').textContent = `${timing.ratePerMinute.toFixed(1)} / min`;
  const wait = Math.max(0, (s.waitUntilMs || 0) - now);
  document.getElementById('cooldownStatus').textContent = completed ? (s.phase === 'preview' ? 'Preview complete. Uncheck what stays, then delete your selection.' : 'Cleanup complete. Your results are shown below.') : stopped ? 'Stopped. Remaining selections are preserved in this window.' : jobRunning && wait ? `${s.waitReason === 'indexing' ? 'Search indexing' : 'Waiting for Discord'} · resumes in ${duration(wait)}` : s.phase === 'discover' ? 'No deletions are sent until collection finishes.' : 'Estimate adjusts to actual speed and Discord cooldowns.';
}

function showWorkspace(running) {
  document.body?.classList.toggle('run-view', running);
  const reviewPanel = document.querySelector('[data-panel="review"]');
  if (reviewPanel) reviewPanel.hidden = !running;
  document.querySelectorAll('[data-step-panel]').forEach((panel) => { panel.hidden = running || panel.dataset.stepPanel !== currentStep; });
  document.getElementById('updatesPanel').hidden = true;
  document.getElementById('backToSetupBtn').hidden = !running;
  if (!running) showStep(currentStep, true);
}

function setupNotice(message = '') {
  const notice = document.getElementById('setupNotice');
  notice.textContent = message;
  notice.hidden = !message;
}

function validateStep(step) {
  if (!currentUser || authenticatedToken !== document.getElementById('tokenInput').value.trim()) {
    showStep('account', true);
    throw new Error('Connect your Discord account to continue.');
  }
  if (['rules', 'launch'].includes(step)) {
    const isPackage = document.getElementById('pipelineSelect').value === 'datapackage';
    const selected = document.querySelectorAll('.guild-box:checked, .dm-box:checked').length ||
      ['channelIdsInput', 'closedDmInput'].some((id) => document.getElementById(id).value.trim());
    if (isPackage ? !selectedPkgPath : !selected) {
      showStep('targets', true);
      throw new Error(isPackage ? 'Choose your extracted Discord data folder.' : 'Select at least one conversation or add an ID.');
    }
  }
  if (step === 'launch') {
    const min = document.getElementById('minDate').value;
    const max = document.getElementById('maxDate').value;
    const days = document.getElementById('disappearingDays').value;
    if (min && max && min > max) throw new Error('The start date must come before the end date.');
    if (days && (!Number.isFinite(Number(days)) || Number(days) < 1)) throw new Error('Enter an age of at least one day, or leave it blank.');
  }
}

function updateLaunchSummary() {
  document.getElementById('launchAccount').textContent = currentUser?.username || 'Connect an account';
  document.getElementById('launchTargets').textContent = document.getElementById('pipelineSelect').value === 'datapackage'
    ? selectedPkgPath || 'Choose a data folder' : document.getElementById('targetSummary').textContent;
  const types = [...document.querySelectorAll('.ct-box:checked')].map((box) => box.value);
  const parts = [types.length ? types.join(', ') : 'All content types'];
  const min = document.getElementById('minDate').value, max = document.getElementById('maxDate').value;
  if (min || max) parts.push(`${min || 'Beginning'} to ${max || 'now'}`);
  if (document.getElementById('keywords').value.trim()) parts.push('Keyword filter');
  if (document.getElementById('preserveKeywords').value.trim()) parts.push('Preservation keywords');
  if (document.getElementById('disappearingDays').value) parts.push(`Older than ${document.getElementById('disappearingDays').value} days`);
  if (document.getElementById('mentionedUserIds').value.trim()) parts.push(`Mentions: ${document.getElementById('mentionedUserIds').value.trim()}`);
  parts.push(document.getElementById('includePinned').checked ? 'Includes pinned messages' : 'Keeps pinned messages');
  if (document.getElementById('moderatorMode').checked) parts.push(`Moderator mode: ${document.getElementById('targetAuthorId').value.trim() ? 'member ' + document.getElementById('targetAuthorId').value.trim() : 'all accessible authors'}`);
  if (document.getElementById('deleteForumTopics').checked) parts.push('Delete entire forum topics / threads');
  if (document.getElementById('pipelineSelect').value === 'reactions' && document.getElementById('removeEveryoneReactions').checked) parts.push("Clear everyone's reactions");
  if (document.getElementById('pipelineSelect').value !== 'reactions' && document.getElementById('overwriteEnabled').checked) parts.push('Edit each message before deleting');
  document.getElementById('launchRules').textContent = parts.join(' · ');
}

function showStep(step, force = false) {
  if (jobRunning || !['account', 'targets', 'rules', 'launch'].includes(step)) return;
  try { if (!force && step !== 'account') validateStep(step); }
  catch (error) { setupNotice(error.message); return; }
  currentStep = step;
  document.body?.classList.remove('run-view');
  document.querySelectorAll('[data-step-panel]').forEach((panel) => { panel.hidden = panel.dataset.stepPanel !== step; });
  const reviewPanel = document.querySelector('[data-panel="review"]');
  if (reviewPanel) reviewPanel.hidden = true;
  document.getElementById('updatesPanel').hidden = true;
  document.getElementById('backToSetupBtn').hidden = true;
  document.querySelectorAll('[data-step]').forEach((button) => {
    const active = button.dataset.step === step;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  document.getElementById('workspaceTitle').textContent = { account: 'Connect your account', targets: 'Choose conversations', rules: 'Set your rules', launch: 'Review your setup' }[step];
  document.querySelector('.workspace')?.scrollTo?.({ top: 0, behavior: 'instant' });
  const heading = document.querySelector(`[data-step-panel="${step}"] h2`);
  if (heading) { heading.tabIndex = -1; heading.focus?.({ preventScroll: true }); }
  setupNotice();
  updateLaunchSummary();
}

document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.step)));
document.querySelectorAll('[data-next-step]').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.nextStep)));
document.querySelectorAll('[data-prev-step]').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.prevStep, true)));

document.getElementById('backToSetupBtn').addEventListener('click', () => { if (!jobRunning) showWorkspace(false); });
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  chosenMode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
  button.setAttribute('aria-pressed', 'true');
  document.querySelectorAll('[data-mode]').forEach((item) => { if (item !== button) item.setAttribute('aria-pressed', 'false'); });
  document.getElementById('startActionBtn').textContent = chosenMode === 'delete' ? 'Collect & delete matches' : 'Preview matches';
  document.getElementById('startActionBtn').classList.toggle('button-danger', chosenMode === 'delete');
}));
document.getElementById('startActionBtn').addEventListener('click', () => {
  if (jobRunning) return;
  try { validateStep('launch'); }
  catch (error) { setupNotice(error.message); return; }
  document.getElementById(chosenMode === 'delete' ? 'liveWipeBtn' : 'previewBtn').click();
});
for (const [id, showDms] of [['showServersBtn', false], ['showDmsBtn', true]]) document.getElementById(id).addEventListener('click', () => {
  document.getElementById('serverGroup').hidden = showDms;
  document.getElementById('dmGroup').hidden = !showDms;
  document.getElementById('showServersBtn').classList.toggle('active', !showDms);
  document.getElementById('showDmsBtn').classList.toggle('active', showDms);
});

function updateReviewSelection() {
  const selected = document.querySelectorAll('.rev-check:checked').length;
  document.getElementById('reviewCount').textContent = `${selected} message${selected === 1 ? '' : 's'} selected`;
  document.getElementById('deleteSelectedBtn').disabled = jobRunning || selected === 0;
  const pending = previewItems.filter((item) => !item.completed).length;
  document.getElementById('toggleAllReviewBtn').textContent = pending && selected === pending ? 'Unselect all' : 'Select all';
}

function resetPreviewQueue() {
  previewItems = [];
  previewRows.clear();
  reviewTable.innerHTML = '<div id="reviewEmpty" class="review-empty"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="12" width="44" height="34" rx="8"/><path d="m20 46-4 9 15-9M21 24h22M21 32h14"/></svg><h3>A fresh start begins here</h3><p>Select conversations and run a preview.<br />Review the matches before you delete.</p></div>';
  updateReviewSelection();
}

function updateTargetSummary() {
  const servers = document.querySelectorAll('.guild-box:checked').length;
  const dms = document.querySelectorAll('.dm-box:checked').length;
  const manual = ['channelIdsInput', 'closedDmInput'].reduce((count, id) => count + document.getElementById(id).value.split(/[\s,;]+/).filter(Boolean).length, 0);
  const parts = [];
  if (servers) parts.push(`${servers} server${servers === 1 ? '' : 's'}`);
  if (dms) parts.push(`${dms} DM${dms === 1 ? '' : 's'}`);
  if (manual) parts.push(`${manual} manual ID${manual === 1 ? '' : 's'}`);
  document.getElementById('targetSummary').textContent = parts.length ? `Selected: ${parts.join(', ')}` : 'No conversations selected';
  if (document.getElementById('pipelineSelect').value === 'datapackage') document.getElementById('targetSummary').textContent = selectedPkgPath ? 'Data package selected' : 'Choose an extracted data package below';
  if (parts.length || selectedPkgPath) setupNotice();
  document.getElementById('toggleAllGuilds').textContent = servers && servers === document.querySelectorAll('.guild-box').length ? 'Unselect all' : 'Select all';
  document.getElementById('toggleAllDms').textContent = dms && dms === document.querySelectorAll('.dm-box').length ? 'Unselect all' : 'Select all';
}

function filterConversations() {
  const query = document.getElementById('targetSearch').value.trim().toLowerCase();
  document.querySelectorAll('.target-row').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
}

function updatePipeline() {
  const pipeline = document.getElementById('pipelineSelect').value;
  document.querySelectorAll('[data-pipeline]').forEach((button) => {
    const selected = button.dataset.pipeline === pipeline;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.getElementById('packageOptions').open = pipeline === 'datapackage';
  for (const selector of ['.targets-scroll', '.conversation-tabs', '.advanced-targets']) {
    const element = document.querySelector(selector);
    if (element) element.hidden = pipeline === 'datapackage';
  }
  document.getElementById('previewBtn').textContent = pipeline === 'reactions' ? 'Preview reactions' : 'Preview messages';
  updateTargetSummary();
}

document.querySelectorAll('[data-pipeline]').forEach((button) => button.addEventListener('click', () => {
  document.getElementById('pipelineSelect').value = button.dataset.pipeline;
  updatePipeline();
}));
document.getElementById('pipelineSelect').addEventListener('change', updatePipeline);
document.getElementById('targetSearch').addEventListener('input', filterConversations);
for (const id of ['guildsList', 'dmsList']) document.getElementById(id).addEventListener('change', updateTargetSummary);
for (const id of ['channelIdsInput', 'closedDmInput']) document.getElementById(id).addEventListener('input', updateTargetSummary);
reviewTable.addEventListener('change', updateReviewSelection);
document.getElementById('toggleAllReviewBtn').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('.rev-check')].filter((box) => !box.disabled);
  const selected = boxes.length && boxes.every((box) => box.checked);
  boxes.forEach((box) => { box.checked = !selected; });
  updateReviewSelection();
});
document.getElementById('filtersResetBtn').addEventListener('click', () => {
  for (const id of ['minDate', 'maxDate', 'disappearingDays', 'keywords', 'preserveKeywords', 'mentionedUserIds', 'targetAuthorId']) document.getElementById(id).value = '';
  document.querySelectorAll('.ct-box').forEach((box) => { box.checked = false; });
  for (const id of ['deleteForumTopics', 'moderatorMode', 'removeEveryoneReactions', 'includePinned']) document.getElementById(id).checked = false;
  document.getElementById('overwriteEnabled').checked = true;
  document.getElementById('overwriteText').value = '[Removed]';
});

function addLog(msg) {
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

window.redactAPI.getAppInfo().then((info) => {
  document.getElementById('runtimeVersion').textContent = `v${info.version}`;
  document.title = `NeonSweep v${info.version}`;
  document.getElementById('updateVersion').textContent = `v${info.version}`;
  addLog(`[App] NeonSweep v${info.version} (${info.packaged ? info.portable ? 'portable build' : 'installed build' : 'workspace'}). DM previews use message history.`);
}).catch((e) => addLog(`Could not read app version: ${e.message}`));

async function refreshAccountsDropdown() {
  const list = await window.redactAPI.getSavedAccounts();
  savedAccountsSelect.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Saved Accounts...';
  savedAccountsSelect.appendChild(defaultOpt);

  for (const a of list) {
    const opt = document.createElement('option');
    opt.value = a.token;
    opt.textContent = `${a.username} (${a.id})`;
    savedAccountsSelect.appendChild(opt);
  }
}
refreshAccountsDropdown().catch((e) => addLog(`Could not load saved accounts: ${e.message}`));

savedAccountsSelect.addEventListener('change', (e) => {
  if (e.target.value) {
    document.getElementById('tokenInput').value = e.target.value;
    document.getElementById('connectBtn').click();
  }
});

window.redactAPI.onLog((m) => addLog(m));
window.redactAPI.onStats((s) => {
  document.getElementById('stScanned').textContent = s.scanned;
  document.getElementById('stMatched').textContent = s.matched;
  document.getElementById('stDeleted').textContent = s.deleted;
  document.getElementById('stSkipped').textContent = s.skipped;
  if (s.startedAt) { lastProgress = { ...s, finishedAt: !jobRunning && jobOutcome === 'completed' ? lastProgress?.finishedAt || Date.now() : undefined, receivedAt: Date.now() }; renderProgress(); }
  if (jobRunning && s.phase === 'discover') {
    document.getElementById('workspaceTitle').textContent = 'Collecting deletion batch';
    document.getElementById('reviewStatus').textContent = 'Collecting matches...';
    document.getElementById('reviewCount').textContent = `${s.matched.toLocaleString()} matches queued`;
  } else if (jobRunning && s.phase === 'delete-live') {
    document.getElementById('workspaceTitle').textContent = 'Currently deleting';
    document.getElementById('reviewStatus').textContent = 'Deleting...';
  }
  if (s.completedItem) {
    const record = previewRows.get(actionKey(s.completedItem));
    if (record && !record.item.completed) {
      record.item.completed = true;
      record.checkbox.checked = false;
      record.checkbox.disabled = true;
      record.row.classList.add('completed-row');
      updateReviewSelection();
    }
  }
});

window.redactAPI.onPreviewMatch((item) => {
  previewItems.push(item);
  const empty = document.getElementById('reviewEmpty');
  if (empty) empty.hidden = true;
  const row = document.createElement('label');
  row.className = 'preview-row';

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'rev-check';
  chk.dataset.id = String(previewItems.length - 1);
  chk.checked = true;
  chk.disabled = jobRunning;

  const txtDiv = document.createElement('div');
  txtDiv.className = 'preview-text';
  const span = document.createElement('span');
  span.className = 'preview-date';
  const timestamp = Date.parse(item.timestamp);
  const conversation = conversationNames.get(item.channel_id) || item.channel_name || `Channel ${item.channel_id}`;
  span.textContent = `${conversation} · ${Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : item.timestamp || 'Date unavailable'}`;
  txtDiv.appendChild(span);
  txtDiv.appendChild(document.createTextNode(item.content || '[No message text]'));
  const media = [...(item.attachments || []).map((a) => `File: ${a.filename || 'Attachment'}`), ...(item.embeds || []).map((e) => `Embed: ${e.title || e.type || e.url || 'Embedded content'}`), ...(item.stickers || []).map((s) => `Sticker: ${s.name || 'Sticker'}`)];
  if (media.length) {
    const description = document.createElement('span');
    description.className = 'preview-media';
    description.textContent = media.join(' · ');
    txtDiv.appendChild(description);
  }
  const reference = document.createElement('span');
  reference.className = 'preview-reference';
  reference.textContent = `Message ${item.id} · ${item.author_name || (item.author_id === currentUser?.id ? currentUser.username : item.author_id || 'Author unavailable')}`;
  txtDiv.appendChild(reference);

  row.appendChild(chk);
  row.appendChild(txtDiv);
  reviewTable.appendChild(row);
  previewRows.set(actionKey(item), { item, checkbox: chk, row });
  updateReviewSelection();
});

async function authenticateWithToken(token) {
  if (jobRunning || accountConnecting) return;
  accountConnecting = true;
  const accountControls = ['connectBtn', 'browserLoginBtn', 'savedAccountsSelect', 'tokenInput'];
  accountControls.forEach((id) => { document.getElementById(id).disabled = true; });
  currentUser = null;
  authenticatedToken = null;
  document.getElementById('userStatus').textContent = 'Connecting...';
  document.getElementById('accountHint').textContent = 'Loading your conversations...';
  document.getElementById('userStatus').classList.remove('connected');
  try {
    const user = await window.redactAPI.validateToken(token);
    const ws = await window.redactAPI.fetchWorkspace(token);
    currentUser = user;
    authenticatedToken = token.trim();
    conversationNames.clear();
    resetPreviewQueue();
    document.getElementById('userStatus').textContent = currentUser.username;
    document.getElementById('accountHint').textContent = 'Your conversations are ready to select';
    document.getElementById('userStatus').classList.add('connected');
    addLog(`Authenticated as ${currentUser.username} (${currentUser.id})`);

    try {
      await window.redactAPI.saveAccount({ id: currentUser.id, username: currentUser.username, token });
      await refreshAccountsDropdown();
    } catch (e) { addLog(`Could not save account: ${e.message}`); }
    
    const gList = document.getElementById('guildsList');
    gList.innerHTML = '';
    ws.guilds.forEach((g) => {
      const lbl = document.createElement('label');
      lbl.className = 'target-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'guild-box';
      input.value = g.id;
      const span = document.createElement('span');
      span.textContent = g.name;
      lbl.appendChild(input);
      lbl.appendChild(span);
      gList.appendChild(lbl);
    });

    const dmList = document.getElementById('dmsList');
    dmList.innerHTML = '';
    ws.dms.forEach((d) => {
      const name = d.name || (d.recipients || []).map((r) => r.username).join(', ') || d.id;
      conversationNames.set(d.id, `DM · ${name}`);
      const lbl = document.createElement('label');
      lbl.className = 'target-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'dm-box';
      input.value = d.id;
      const span = document.createElement('span');
      span.textContent = name;
      lbl.appendChild(input);
      lbl.appendChild(span);
      dmList.appendChild(lbl);
    });
    if (!ws.guilds.length) gList.innerHTML = '<p class="list-empty">No servers found for this account.</p>';
    if (!ws.dms.length) dmList.innerHTML = '<p class="list-empty">No open DMs found. You can add a user ID below.</p>';
    updateTargetSummary();
    filterConversations();
    showStep('targets', true);
  } catch (e) {
    currentUser = null;
    authenticatedToken = null;
    document.getElementById('userStatus').textContent = 'Not Connected';
    document.getElementById('accountHint').textContent = 'Connect to load your conversations';
    document.getElementById('userStatus').classList.remove('connected');
    document.getElementById('guildsList').innerHTML = '';
    document.getElementById('dmsList').innerHTML = '';
    addLog(`Connection failed: ${e.message}`);
    setupNotice('Connection failed. Check your token or try logging in again.');
  } finally {
    accountConnecting = false;
    accountControls.forEach((id) => { document.getElementById(id).disabled = false; });
  }
}

document.getElementById('connectBtn').addEventListener('click', () => {
  const token = document.getElementById('tokenInput').value.trim();
  if (!token) return alert('Paste your Discord token or click Log in with Discord.');
  authenticateWithToken(token);
});

document.getElementById('browserLoginBtn').addEventListener('click', async () => {
  if (accountConnecting || jobRunning) return;
  addLog('Opening Discord login window...');
  const loginButton = document.getElementById('browserLoginBtn');
  loginButton.disabled = true;
  try {
    const capturedToken = await window.redactAPI.openDiscordLogin();
    if (capturedToken) {
      document.getElementById('tokenInput').value = capturedToken;
      await authenticateWithToken(capturedToken);
    } else addLog('Login window closed without capturing token.');
  } catch (_) { setupNotice('Could not open Discord login. Try again or connect with a token.'); }
  finally { loginButton.disabled = false; }
});

document.getElementById('toggleAllGuilds').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('.guild-box')];
  const allChecked = boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = !allChecked));
  updateTargetSummary();
});

document.getElementById('toggleAllDms').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('.dm-box')];
  const allChecked = boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = !allChecked));
  updateTargetSummary();
});

document.getElementById('pickPkgBtn').addEventListener('click', async () => {
  const p = await window.redactAPI.selectFolder();
  if (p) {
    selectedPkgPath = p;
    document.getElementById('pkgPathLabel').textContent = p;
    document.getElementById('pipelineSelect').value = 'datapackage';
    updatePipeline();
  }
});

function gatherConfig(executionMode) {
  updateTargetSummary();
  const splitCsv = (id) =>
    document.getElementById(id).value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const splitIds = (id) => document.getElementById(id).value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!currentUser || authenticatedToken !== document.getElementById('tokenInput').value.trim()) throw new Error('Connect the current token before starting a job.');

  return {
    token: document.getElementById('tokenInput').value.trim(),
    authorId: currentUser?.id,
    pipeline: document.getElementById('pipelineSelect').value,
    executionMode,
    guildIds: [...document.querySelectorAll('.guild-box:checked')].map((el) => el.value),
    channelIds: [...new Set([...document.querySelectorAll('.dm-box:checked')].map((el) => el.value).concat(splitIds('channelIdsInput')))],
    closedDmUserIds: splitIds('closedDmInput'),
    minDate: document.getElementById('minDate').value || null,
    maxDate: document.getElementById('maxDate').value || null,
    disappearingDays: document.getElementById('disappearingDays').value || null,
    contentTypes: [...document.querySelectorAll('.ct-box:checked')].map((el) => el.value),
    keywords: splitCsv('keywords'),
    preserveKeywords: splitCsv('preserveKeywords'),
    mentionedUserIds: splitIds('mentionedUserIds'),
    overwriteEnabled: document.getElementById('overwriteEnabled').checked,
    overwriteText: document.getElementById('overwriteText').value,
    deleteForumTopics: document.getElementById('deleteForumTopics').checked,
    moderatorMode: document.getElementById('moderatorMode').checked,
    targetAuthorId: document.getElementById('targetAuthorId').value.trim() || null,
    removeEveryoneReactions: document.getElementById('removeEveryoneReactions').checked,
    includePinned: document.getElementById('includePinned').checked,
    dataPackagePath: selectedPkgPath,
    localArchive: true
  };
}

async function executeJob(task, status = 'Working...') {
  if (jobRunning) return;
  jobRunning = true;
  jobOutcome = 'running';
  showWorkspace(true);
  lastProgress = null;
  document.getElementById('jobProgress').hidden = true;
  document.getElementById('backToSetupBtn').disabled = true;
  progressTimer = setInterval(renderProgress, 1000);
  document.querySelectorAll('.rev-check').forEach((box) => { box.disabled = true; });
  document.getElementById('reviewStatus').textContent = status;
  document.getElementById('workspaceTitle').textContent = status === 'Previewing...' ? 'Currently previewing' : 'Currently deleting';
  document.getElementById('stopBtn').disabled = false;
  const ids = ['previewBtn', 'liveWipeBtn', 'deleteSelectedBtn', 'toggleAllReviewBtn', 'connectBtn', 'browserLoginBtn', 'savedAccountsSelect', 'tokenInput', 'startActionBtn', 'updatesNavBtn'];
  document.querySelectorAll('[data-step]').forEach((button) => { button.disabled = true; });
  ids.forEach((id) => { document.getElementById(id).disabled = true; });
  try {
    const result = await task();
    if (result?.error) throw new Error(result.error);
    jobOutcome = result?.aborted ? 'stopped' : 'completed';
    document.getElementById('reviewStatus').textContent = result?.aborted ? 'Stopped' : result?.stats?.matched === 0 ? 'No matches found' : 'Complete';
    document.getElementById('workspaceTitle').textContent = result?.aborted ? 'Stopped' : status === 'Previewing...' ? 'Preview complete' : 'Deletion complete';
  } catch (e) {
    jobOutcome = 'error';
    document.getElementById('reviewStatus').textContent = 'Check activity log';
    document.getElementById('workspaceTitle').textContent = 'Job interrupted';
    const activity = document.querySelector('.activity-details');
    if (activity) activity.open = true;
    addLog(`[Job Error] ${e.message}`);
  } finally {
    jobRunning = false;
    if (lastProgress && jobOutcome === 'completed') lastProgress.finishedAt = Date.now();
    clearInterval(progressTimer);
    progressTimer = null;
    document.getElementById('backToSetupBtn').disabled = false;
    document.querySelectorAll('.rev-check').forEach((box) => { box.disabled = Boolean(previewItems[Number(box.dataset.id)]?.completed); });
    renderProgress();
    ids.forEach((id) => { document.getElementById(id).disabled = false; });
    document.querySelectorAll('[data-step]').forEach((button) => { button.disabled = false; });
    document.getElementById('stopBtn').disabled = true;
    updateReviewSelection();
    renderUpdateState(updateState);
  }
}

document.getElementById('previewBtn').addEventListener('click', () => executeJob(async () => {
  const cfg = gatherConfig('preview');
  resetPreviewQueue();
  previewOwnerId = cfg.authorId;
  addLog(`[Preview] Starting: ${cfg.guildIds.length} servers, ${cfg.channelIds.length} channels/DMs, ${cfg.closedDmUserIds.length} DM users.`);
  return window.redactAPI.startJob(cfg);
}, 'Previewing...'));

document.getElementById('liveWipeBtn').addEventListener('click', () => {
  if (!currentUser) return alert('Connect your Discord account first!');
  if (!confirm('Collect all matches, then delete them with the current filters?')) return;
  executeJob(() => {
    const cfg = gatherConfig('delete');
    resetPreviewQueue();
    previewOwnerId = cfg.authorId;
    return window.redactAPI.startJob(cfg);
  }, 'Collecting matches...');
});

document.getElementById('deleteSelectedBtn').addEventListener('click', () => {
  if (jobRunning) return;
  if (!currentUser || currentUser.id !== previewOwnerId || authenticatedToken !== document.getElementById('tokenInput').value.trim()) return alert('Preview with the connected account first.');
  const checkedIds = new Set([...document.querySelectorAll('.rev-check:checked')].map((c) => c.dataset.id));
  const approved = previewItems.filter((item, index) => !item.completed && checkedIds.has(String(index)));
  if (approved.length === 0) return alert('No previewed messages checked!');
  executeJob(() => window.redactAPI.deleteReviewed({
    token: document.getElementById('tokenInput').value.trim(),
    authorId: currentUser.id,
    items: approved,
    overwriteEnabled: document.getElementById('overwriteEnabled').checked,
    overwriteText: document.getElementById('overwriteText').value
  }), 'Deleting...');
});

document.getElementById('stopBtn').addEventListener('click', () => {
  window.redactAPI.stopJob().catch((e) => addLog(e.message));
});

function renderUpdateState(state) {
  if (!state) return;
  updateState = state;
  const labels = { disabled: 'Automatic updates unavailable', idle: 'Automatic updates are on', checking: 'Checking for updates…', available: 'Update found', downloading: 'Downloading update…', current: 'You’re up to date', downloaded: 'Update ready', installing: 'Restarting to update…', error: 'Could not check for updates' };
  document.getElementById('updateStatus').textContent = labels[state.status] || 'Updates';
  document.getElementById('updateDetail').textContent = state.message;
  const progress = document.getElementById('updateProgress');
  progress.hidden = state.status !== 'downloading';
  progress.value = state.progress || 0;
  const check = document.getElementById('checkUpdatesBtn');
  check.disabled = ['disabled', 'checking', 'available', 'downloading', 'installing'].includes(state.status);
  const install = document.getElementById('installUpdateBtn');
  install.hidden = state.status !== 'downloaded';
  install.disabled = jobRunning || !state.canInstall;
  const nav = document.getElementById('updatesNavBtn');
  nav.classList.toggle('update-ready', state.status === 'downloaded');
  nav.title = state.status === 'downloaded' ? `Version ${state.version} ready to install` : 'Application updates';
}

document.getElementById('updatesNavBtn').addEventListener('click', () => {
  if (jobRunning) return;
  document.body?.classList.remove('run-view');
  document.querySelectorAll('[data-step-panel]').forEach((panel) => { panel.hidden = true; });
  const reviewPanel = document.querySelector('[data-panel="review"]');
  if (reviewPanel) reviewPanel.hidden = true;
  document.getElementById('updatesPanel').hidden = false;
  document.getElementById('backToSetupBtn').hidden = true;
  document.getElementById('workspaceTitle').textContent = 'Application updates';
  document.querySelectorAll('[data-step]').forEach((button) => { button.classList.remove('active'); button.removeAttribute('aria-current'); });
  document.querySelector('.workspace')?.scrollTo?.({ top: 0, behavior: 'instant' });
  setupNotice();
});
document.getElementById('settingsBackBtn').addEventListener('click', () => showStep(currentStep, true));
document.getElementById('checkUpdatesBtn').addEventListener('click', () => window.redactAPI.checkForUpdates().then(renderUpdateState).catch(() => setupNotice('Could not reach the update service. Try again later.')));
document.getElementById('installUpdateBtn').addEventListener('click', () => {
  if (!jobRunning) window.redactAPI.installUpdate().then(renderUpdateState).catch(() => setupNotice('Could not install the update. Close and reopen NeonSweep to try again.'));
});
window.redactAPI.onUpdateState(renderUpdateState);
window.redactAPI.getUpdateState().then(renderUpdateState).catch(() => {});
showStep('account', true);
