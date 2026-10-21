const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const axios = require('axios');
const { runJob, normalizeConfig } = require('../src/engine');

const authorId = '123456789012345678';
const channelId = '223456789012345678';
const userId = '323456789012345678';
const guildId = '423456789012345678';
const messageId = '1537213327967780966';
const base = { token: 'test-token', authorId, pipeline: 'search', executionMode: 'preview', channelIds: [channelId] };
const message = (extra = {}) => ({ id: messageId, channel_id: channelId, type: 0, author: { id: authorId }, content: 'secret text', ...extra });

async function scan(config, respond) {
  const original = axios.create;
  const requests = [], previews = [], logs = [];
  axios.create = () => ({ request: async (request) => {
    requests.push(request);
    return { status: 200, data: await respond(request) };
  } });
  try {
    const stats = await runJob(config, { onLog: (v) => logs.push(v), onPreview: (v) => previews.push(v) });
    return { stats, requests, previews, logs };
  } finally { axios.create = original; }
}

test('normalizes delimited IDs, removes duplicates, and rejects invalid configs', () => {
  const cfg = normalizeConfig({ ...base, channelIds: `${channelId}, ${channelId}\n${userId}`, keywords: 'secret, private' });
  assert.deepEqual(cfg.channelIds, [channelId, userId]);
  assert.deepEqual(cfg.keywords, ['secret', 'private']);
  for (const patch of [{ channelIds: [] }, { channelIds: 'bad-id' }, { pipeline: 'unknown' }, { minDate: 'invalid' }, { executionMode: undefined }, { disappearingDays: -1 }, { includePinned: 'false' }]) {
    assert.throws(() => normalizeConfig({ ...base, ...patch }));
  }
});

test('explicit channels fetch history and preview full content without mutations', async () => {
  const content = 'secret '.repeat(30);
  const result = await scan(base, (req) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, `/channels/${channelId}/messages`);
    return [message({ content })];
  });
  assert.equal(result.stats.scanned, 1);
  assert.equal(result.stats.matched, 1);
  assert.equal(result.previews[0].content, content);
});

test('closed DM user IDs resolve to channel IDs before fetching', async () => {
  const result = await scan({ ...base, channelIds: [], closedDmUserIds: [userId] }, (req) => {
    if (req.method === 'POST') {
      assert.deepEqual(req.data, { recipient_id: userId });
      return { id: channelId };
    }
    assert.equal(req.url, `/channels/${channelId}/messages`);
    return [message()];
  });
  assert.equal(result.stats.matched, 1);
});

test('failed DM resolution reports an error instead of silently losing the target', async () => {
  await assert.rejects(scan({ ...base, channelIds: [], closedDmUserIds: [userId] }, () => {
    throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
  }), /Could not resolve DM user/);
});

test('history paginates using the oldest ID and deduplicates overlapping pages', async () => {
  let page = 0;
  const batch = Array.from({ length: 100 }, (_, i) => message({ id: (BigInt(messageId) - BigInt(i)).toString() }));
  const result = await scan(base, (req) => {
    if (++page === 1) return batch;
    assert.equal(req.params.before, batch[99].id);
    return [batch[99], message({ id: (BigInt(messageId) - 100n).toString() })];
  });
  assert.equal(result.stats.scanned, 101);
  assert.equal(result.previews.length, 101);
});

test('author, pinned, keywords, preservation, mentions, and content filters apply locally', async () => {
  const result = await scan({ ...base, keywords: ['secret'], preserveKeywords: ['keep'], mentionedUserIds: [userId], contentTypes: ['text'] }, () => [
    message({ content: `secret <@!${userId}>` }),
    message({ id: (BigInt(messageId) - 1n).toString(), pinned: true }),
    message({ id: (BigInt(messageId) - 2n).toString(), author: { id: userId } }),
    message({ id: (BigInt(messageId) - 3n).toString(), content: `secret keep <@${userId}>` }),
    message({ id: (BigInt(messageId) - 4n).toString(), content: `other <@${userId}>` })
  ]);
  assert.equal(result.stats.scanned, 5);
  assert.equal(result.stats.matched, 1);
  assert.equal(result.stats.skipped, 4);
});

test('server search counts all hits, ignores context, and avoids duplicate channel expansion', async () => {
  let calls = 0;
  const result = await scan({ ...base, guildIds: [guildId], channelIds: [] }, (req) => {
    assert.equal(req.url, `/guilds/${guildId}/messages/search`);
    assert.equal(req.params.author_id, authorId);
    if (++calls === 1) return { messages: [[message({ hit: true }), message({ id: (BigInt(messageId) - 1n).toString(), hit: true }), message({ hit: false })]] };
    assert.equal(req.params.max_id, (BigInt(messageId) - 1n).toString());
    return { messages: [] };
  });
  assert.equal(result.stats.scanned, 2);
  assert.equal(result.stats.matched, 2);
});

test('reaction previews emit typed actions for the review queue without deleting', async () => {
  const result = await scan({ ...base, pipeline: 'reactions' }, (req) => {
    assert.equal(req.method, 'GET');
    return [message({ reactions: [{ me: true, emoji: { id: null, name: '👍' } }] })];
  });
  assert.equal(result.previews[0].action, 'remove-reaction');
  assert.equal(result.previews[0].emoji, encodeURIComponent('👍'));
});

test('inaccessible history is logged and cancellation aborts cleanly', async () => {
  const result = await scan(base, () => { throw Object.assign(new Error('Forbidden'), { response: { status: 403 } }); });
  assert.equal(result.stats.scanned, 0);
  assert.ok(result.logs.some((v) => v.includes('HTTP 403')));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runJob(base, {}, controller.signal), /Aborted/);
});

test('renderer DOM selections travel through preload IPC unchanged and scan successfully', async () => {
  const elements = new Map();
  const makeElement = () => {
    const classes = new Set();
    const attributes = new Map();
    return {
      value: '', checked: false, disabled: false, hidden: false,
      innerHTML: '', textContent: '', dataset: {}, style: {}, children: [],
      addEventListener() {},
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force) {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        }
      }
    };
  };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const document = {
    body: makeElement(),
    getElementById: element,
    createElement: makeElement,
    createTextNode: (text) => ({ textContent: text }),
    querySelector: (selector) => selector.startsWith('#') ? element(selector.slice(1)) : null,
    querySelectorAll: (selector) => ({ '.guild-box:checked': [], '.dm-box:checked': [{ value: channelId }], '.guild-box:checked, .dm-box:checked': [{ value: channelId }], '.ct-box:checked': [{ value: 'text' }] })[selector] || []
  };
  let exposed, payload;
  vm.runInNewContext(fs.readFileSync(require.resolve('../preload'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, api) => { exposed = api; } }, ipcRenderer: {
      invoke: async (name, value) => {
        if (name === 'start-job') payload = value;
        if (name === 'get-app-info') return { version: require('../package.json').version, packaged: false, name: 'NeonSweep' };
        if (name === 'get-update-state') return { status: 'disabled', reason: 'development', version: require('../package.json').version, message: 'Updates are available in the installed app.', canInstall: false };
        return [];
      }, on() {}, removeListener() {}
    } })
  });
  const context = vm.createContext({ document, window: { redactAPI: exposed }, alert() {}, confirm: () => true });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer'), 'utf8'), context);
  element('tokenInput').value = 'test-token';
  element('pipelineSelect').value = 'search';
  element('channelIdsInput').value = `${userId}; ${channelId}`;
  element('closedDmInput').value = guildId;
  element('keywords').value = 'secret';
  vm.runInContext(`currentUser = { id: '${authorId}' }; authenticatedToken = 'test-token'; window.redactAPI.startJob(gatherConfig('preview'));`, context);
  assert.deepEqual(Array.from(payload.channelIds), [channelId, userId]);
  assert.deepEqual(Array.from(payload.closedDmUserIds), [guildId]);
  const result = await scan(payload, (req) => req.method === 'POST' ? { id: channelId } : [message()]);
  assert.equal(result.stats.matched, 1);
});

test('date bounds are sent to history and combined age bounds cannot broaden the range', async () => {
  const result = await scan({ ...base, minDate: '2020-01-01', maxDate: '2021-01-01', disappearingDays: 1 }, (req) => {
    const expected = ((BigInt(Date.parse('2021-01-01')) - 1420070400000n) << 22n).toString();
    assert.equal(req.params.before, expected);
    return [];
  });
  assert.equal(result.stats.scanned, 0);
});

test('main IPC reports failures, blocks overlapping jobs, and releases completed controllers', async () => {
  const handlers = new Map();
  const paths = new Map();
  let lockRequests = 0;
  let finish;
  let activeSignal;
  const run = (_, __, signal) => { activeSignal = signal; return new Promise((resolve) => { finish = resolve; }); };
  const fakeElectron = {
    app: {
      whenReady: () => ({ then() {} }), getPath: (name) => paths.get(name) || 'test-user-data',
      setPath: (name, value) => paths.set(name, value), on() {}, quit() {}, disableHardwareAcceleration() {},
      requestSingleInstanceLock: () => { lockRequests++; return true; }
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
  };
  const context = vm.createContext({ __dirname: process.cwd(), AbortController, Buffer, require: (name) => {
    if (name === 'electron') return fakeElectron;
    if (name === './src/engine') return { runJob: run };
    if (name === './src/update-manager') return require('../src/update-manager');
    if (name === 'fs') return { mkdirSync() {} };
    return require(name);
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../main'), 'utf8'), context);
  assert.equal(lockRequests, 1, 'Only one installed app instance may own jobs and updates');
  assert.equal(paths.get('userData'), require('node:path').join('test-user-data', 'discord-redact-pro'), 'The product rename retains the existing account profile');
  vm.runInContext('mainWindow = { webContents: { send() {} } };', context);
  const first = handlers.get('start-job')(null, base);
  const second = await handlers.get('start-job')(null, base);
  assert.match(second.error, /already running/);
  handlers.get('stop-job')();
  assert.equal(activeSignal.aborted, true);
  assert.match((await handlers.get('start-job')(null, base)).error, /already running/);
  finish({ scanned: 1 });
  assert.equal((await first).stats.scanned, 1);
  const third = handlers.get('start-job')(null, base);
  finish({ scanned: 2 });
  assert.equal((await third).stats.scanned, 2);
  assert.equal(activeSignal.aborted, false);
});
