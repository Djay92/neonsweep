const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { JobProgress } = require('../src/job-progress');
const { deleteReviewedItems } = require('../src/engine');

test('known batch reports remaining, measured ETA, cooldown and completed identity', () => {
  let now = 100000;
  const emitted = [];
  const tracker = new JobProgress({ scanned: 2742, matched: 2742, deleted: 0, skipped: 0 }, (s) => emitted.push(s), { total: 2742, phase: 'delete-reviewed', now: () => now });
  assert.equal(tracker.emit().etaMs, null);
  for (let index = 0; index < 177; index++) tracker.complete({ id: String(index), channel_id: 'channel' });
  now += 177 * 2550;
  let result = tracker.emit();
  assert.equal(result.remaining, 2565);
  assert.equal(result.etaMs, 2565 * 2550);
  tracker.wait({ reason: 'rate-limit', untilMs: now + 2800 });
  result = emitted.at(-1);
  assert.equal(result.etaMs, 2565 * 2550 + 2800);
  assert.equal(result.completedItem.id, '176');
  assert.equal(result.waitReason, 'rate-limit');
});

test('open-ended scan has measured throughput and no invented ETA', () => {
  let now = 1000;
  const tracker = new JobProgress({ scanned: 100, matched: 4, deleted: 0, skipped: 96 }, () => {}, { now: () => now });
  now += 10000;
  const result = tracker.emit();
  assert.equal(result.total, null);
  assert.equal(result.etaMs, null);
  assert.equal(result.ratePerMinute, 600);
});

const items = Array.from({ length: 4 }, (_, i) => ({ id: `153721332796778096${i}`, channel_id: '223456789012345678', author_id: '123456789012345678', content: 'Simulated reviewed item' }));
async function reviewed(respond, onStats = () => {}, signal) {
  const original = axios.create;
  axios.create = () => ({ request: async (request) => ({ status: 204, headers: { 'x-ratelimit-remaining': '5' }, data: await respond(request) }) });
  try { return await deleteReviewedItems('test-token', '123456789012345678', items, false, '', null, () => {}, onStats, signal); }
  finally { axios.create = original; }
}

test('reviewed deletion emits total before requests and counts each completed action once', async () => {
  const snapshots = [];
  let requests = 0;
  const result = await reviewed(() => { assert.equal(snapshots[0].processed, 0); requests++; }, (s) => snapshots.push(s));
  assert.equal(snapshots[0].total, 4);
  assert.equal(snapshots[0].matched, 4);
  assert.equal(requests, 4);
  assert.equal(result.processed, 4);
  assert.equal(result.deleted, 4);
  assert.equal(result.remaining, 0);
  assert.equal(result.etaMs, 0);
});

test('stopping a reviewed batch preserves unfinished work and does not send another delete', async () => {
  const controller = new AbortController();
  let requests = 0, last;
  await assert.rejects(reviewed(() => { requests++; }, (s) => {
    last = s;
    if (s.processed === 1) controller.abort();
  }, controller.signal), /Aborted/);
  assert.equal(requests, 1);
  assert.equal(last.remaining, 3);
  assert.equal(last.completedItem.id, items[0].id);
});

test('429 waits are visible and retries do not double-count reviewed items', async () => {
  let requests = 0;
  const snapshots = [];
  const result = await reviewed(() => {
    if (++requests === 1) throw Object.assign(new Error('Rate limited'), { response: { status: 429, data: { retry_after: 0 }, headers: {} } });
  }, (s) => snapshots.push(s));
  assert.equal(requests, 5);
  assert.equal(result.processed, 4);
  assert.ok(snapshots.some((s) => s.waitReason === 'rate-limit' && s.waitUntilMs > s.startedAt && s.processed === 0));
});
