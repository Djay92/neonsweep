const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { runJob } = require('../src/engine');
const { calculateTiming } = require('../src/progress-math');

const authorId = '123456789012345678', channelId = '223456789012345678';
const baseId = 1537213327967780966n;
const config = { token: 'simulated-token', authorId, channelIds: [channelId], pipeline: 'search', executionMode: 'delete', localArchive: false };
const message = (index, own = true) => ({ id: String(baseId - BigInt(index)), channel_id: channelId, author: { id: own ? authorId : '323456789012345678' }, type: 0, content: 'secret message', timestamp: '2026-10-20T12:00:00Z' });

async function mock(respond, run) {
  const originalCreate = axios.create, originalNow = Date.now;
  let time = 10000;
  Date.now = () => time;
  axios.create = () => ({ request: async (req) => {
    time += 1000;
    return { status: req.method === 'DELETE' ? 204 : 200, headers: { 'x-ratelimit-remaining': '10' }, data: respond(req) };
  } });
  try { return await run(); }
  finally { axios.create = originalCreate; Date.now = originalNow; }
}

test('immediate deletion discovers every page before mutation and always deletes with a known total', async () => {
  const stats = [], previews = [], methods = [];
  let pages = 0;
  await mock((req) => {
    methods.push(req.method);
    if (req.method === 'GET') return ++pages === 1 ? Array.from({ length: 100 }, (_, i) => message(i, i < 3)) : [message(100), message(101)];
    assert.equal(pages, 2, 'Discovery must finish before the first deletion');
    assert.equal(stats.at(-1).phase, 'delete-live');
    assert.equal(stats.at(-1).total, 5);
    return undefined;
  }, async () => {
    const result = await runJob({ ...config, keywords: ['secret'] }, { onStats: (s) => stats.push(s), onPreview: (item) => previews.push(item) });
    assert.equal(result.deleted, 5);
    assert.equal(result.scanned, 102);
    assert.equal(result.matched, 5);
    assert.equal(result.remaining, 0);
    assert.equal(result.etaMs, 0);
  });
  assert.deepEqual(methods, ['GET', 'GET', 'DELETE', 'DELETE', 'DELETE', 'DELETE', 'DELETE']);
  assert.equal(previews.length, 5);
  assert.ok(stats.some((s) => s.phase === 'discover' && s.deleted === 0));
  assert.ok(stats.filter((s) => s.phase === 'delete-live').every((s) => s.total === 5));
  const sample = stats.find((s) => s.phase === 'delete-live' && s.processed === 3);
  assert.equal(sample.remaining, 2);
  assert.equal(sample.etaMs, 2000, 'Discovery time must not inflate deletion throughput');
  assert.equal(sample.elapsedMs, 5000, 'Total elapsed includes discovery');
});

test('Stop during discovery sends no deletion and leaves no unknown-total deletion phase', async () => {
  const controller = new AbortController();
  const methods = [], stats = [];
  await mock((req) => { methods.push(req.method); return [message(0), message(1)]; }, async () => {
    await assert.rejects(runJob(config, { onStats: (s) => stats.push(s), onPreview: () => controller.abort() }, controller.signal), /Aborted/);
  });
  assert.deepEqual(methods, ['GET']);
  assert.ok(stats.every((s) => s.deleted === 0 && s.phase === 'discover'));
});

test('immediate reaction removal collects typed actions before executing the known batch', async () => {
  const requests = [], stats = [];
  await mock((req) => {
    requests.push(req);
    if (req.method === 'GET') return [{ ...message(0), reactions: [{ me: true, emoji: { id: null, name: '👍' } }, { me: true, emoji: { id: '444456789012345678', name: 'custom' } }] }];
    assert.equal(stats.at(-1).total, 2);
    return undefined;
  }, async () => {
    const result = await runJob({ ...config, pipeline: 'reactions' }, { onStats: (s) => stats.push(s) });
    assert.equal(result.deleted, 2);
    assert.equal(result.processed, 2);
  });
  assert.deepEqual(requests.map((req) => req.method), ['GET', 'DELETE', 'DELETE']);
  assert.ok(requests.slice(1).every((req) => req.url.endsWith('/@me')));
});

test('remaining estimate cannot count down to zero while the same work remains', () => {
  const progress = { phase: 'delete-live', total: 10, processed: 3, startedAt: 1000, rateStartedAt: 4000, scanned: 100, waitUntilMs: 15000 };
  const initial = calculateTiming(progress, 10000);
  const afterStall = calculateTiming(progress, 20000);
  assert.equal(initial.etaMs, 19000);
  assert.ok(afterStall.etaMs > initial.etaMs);
  assert.equal(afterStall.remaining, 7);
  assert.equal(afterStall.elapsedMs, 19000);
  assert.equal(afterStall.processingElapsedMs, 16000);
  assert.equal(calculateTiming({ ...progress, processed: 10 }, 20000).etaMs, 0);
});

test('stopped timing freezes at its last measured durations', () => {
  const result = calculateTiming({ phase: 'delete-reviewed', total: 10, processed: 4, startedAt: 1000, rateStartedAt: 4000, elapsedMs: 9000, processingElapsedMs: 6000 }, 900000, false);
  assert.equal(result.elapsedMs, 9000);
  assert.equal(result.processingElapsedMs, 6000);
  assert.equal(result.etaMs, 9000);
});
