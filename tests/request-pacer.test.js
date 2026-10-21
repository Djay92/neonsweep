const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestPacer } = require('../src/request-pacer');

const channel = '123456789012345678';
const otherChannel = '223456789012345678';
const message = '323456789012345678';
const otherMessage = '423456789012345678';
const route = `/channels/${channel}/messages/${message}`;

function fixture(options = {}) {
  let timestamp = 10000;
  const sleeps = [], waits = [];
  const pacer = new RequestPacer({
    now: () => timestamp,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error('Aborted');
      sleeps.push(ms);
      timestamp += ms;
    },
    onWait: (wait) => waits.push(wait),
    ...options
  });
  return { pacer, sleeps, waits, now: () => timestamp };
}

test('successful exhausted buckets wait for decimal reset-after plus safety margin', async () => {
  const { pacer, sleeps, waits } = fixture();
  pacer.observeResponse('PATCH', route, {
    'X-RateLimit-Bucket': 'edit-message',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset-After': '0.375'
  });
  await pacer.beforeRequest('PATCH', route);
  assert.deepEqual(sleeps, [425]);
  assert.deepEqual(waits, [
    { reason: 'rate-limit', untilMs: 10425, waitMs: 425 },
    { reason: null, untilMs: null, waitMs: 0 }
  ]);
});

test('known positive remaining does not add a fallback delay', async () => {
  const { pacer, sleeps } = fixture();
  pacer.observeResponse('DELETE', route, {
    'x-ratelimit-bucket': 'messages',
    'x-ratelimit-remaining': '2',
    'x-ratelimit-reset-after': '9'
  });
  await pacer.beforeRequest('DELETE', route);
  assert.deepEqual(sleeps, []);
});

test('missing or unusable bucket headers preserve global fallback spacing', async () => {
  const { pacer, sleeps } = fixture();
  pacer.observeResponse('DELETE', route);
  await pacer.beforeRequest('GET', `/channels/${otherChannel}/messages`);
  pacer.observeResponse('GET', `/channels/${otherChannel}/messages`, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset-after': 'invalid'
  });
  await pacer.beforeRequest('PATCH', route);
  assert.deepEqual(sleeps, [250, 250]);
});

test('known PATCH and DELETE routes share bucket waits for a channel', async () => {
  const { pacer, sleeps } = fixture();
  pacer.observeResponse('DELETE', route, {
    'x-ratelimit-bucket': 'shared-messages', 'x-ratelimit-remaining': '1'
  });
  pacer.observeResponse('PATCH', route, {
    'x-ratelimit-bucket': 'shared-messages',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset-after': '1.25'
  });
  await pacer.beforeRequest('DELETE', `/channels/${channel}/messages/${otherMessage}?ignored=1`);
  assert.deepEqual(sleeps, [1300]);
});

test('bucket deadlines remain scoped to each channel or guild major resource', async () => {
  const { pacer, sleeps } = fixture();
  const shared = { 'x-ratelimit-bucket': 'same-hash', 'x-ratelimit-remaining': '1' };
  pacer.observeResponse('DELETE', `/channels/${otherChannel}/messages/${message}`, shared);
  pacer.observeResponse('DELETE', route, {
    ...shared, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2'
  });
  await pacer.beforeRequest('DELETE', `/channels/${otherChannel}/messages/${otherMessage}`);
  assert.deepEqual(sleeps, []);
  await pacer.beforeRequest('DELETE', route);
  assert.deepEqual(sleeps, [2050]);
});

test('HTTP 429 respects the longest valid server retry deadline before retrying', async () => {
  const { pacer, sleeps, now } = fixture();
  const waitMs = pacer.observeRateLimit('DELETE', route, {
    data: { retry_after: 0.75 },
    headers: { 'retry-after': '1.2', 'x-ratelimit-reset-after': '0.9' }
  });
  assert.equal(waitMs, 1250);
  await pacer.beforeRequest('DELETE', `/channels/${channel}/messages/${otherMessage}`);
  assert.deepEqual(sleeps, [1250]);
  assert.equal(now(), 11250);
});

test('a global 429 also pauses unrelated channels and methods', async () => {
  const { pacer, sleeps } = fixture();
  pacer.observeRateLimit('DELETE', route, {
    data: { retry_after: 1.75, global: true }, headers: {}
  });
  await pacer.beforeRequest('GET', `/channels/${otherChannel}/messages`);
  assert.deepEqual(sleeps, [1800]);
});

test('global rate-limit headers are honored and malformed retry values use a safe fallback', async () => {
  const { pacer, sleeps } = fixture();
  assert.equal(pacer.observeRateLimit('DELETE', route, {
    data: { retry_after: -10 },
    headers: { 'Retry-After': 'invalid', 'X-RateLimit-Global': 'true' }
  }), 2550);
  await pacer.beforeRequest('PATCH', `/channels/${otherChannel}/messages/${message}`);
  assert.deepEqual(sleeps, [2550]);
});

test('Headers-style access and zero-second retries still respect the safety margin', async () => {
  const { pacer, sleeps } = fixture();
  pacer.observeRateLimit('DELETE', route, {
    data: { retry_after: 0 },
    headers: { get: (name) => name === 'x-ratelimit-bucket' ? 'messages' : null }
  });
  await pacer.beforeRequest('DELETE', route);
  assert.deepEqual(sleeps, [50]);
});

test('an already cancelled request never sleeps', async () => {
  const { pacer, sleeps, waits } = fixture();
  const controller = new AbortController();
  pacer.observeResponse('DELETE', route);
  controller.abort();
  await assert.rejects(pacer.beforeRequest('DELETE', route, controller.signal), /Aborted/);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(waits, []);
});

test('cancelling a real pending wait removes its abort listener and clears wait state', async () => {
  const controller = new AbortController();
  const waits = [];
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { if (args[0] === 'abort') listeners++; return add(...args); };
  signal.removeEventListener = (...args) => { if (args[0] === 'abort') listeners--; return remove(...args); };
  const pacer = new RequestPacer({ onWait: (wait) => waits.push(wait) });
  pacer.observeRateLimit('DELETE', route, { data: { retry_after: 30 } });
  const pending = pacer.beforeRequest('DELETE', route, signal);
  assert.equal(listeners, 1);
  controller.abort();
  await assert.rejects(pending, /Aborted/);
  assert.equal(listeners, 0);
  assert.equal(waits[0].reason, 'rate-limit');
  assert.deepEqual(waits.at(-1), { reason: null, untilMs: null, waitMs: 0 });
});
