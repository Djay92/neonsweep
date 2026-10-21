const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const { runJob } = require('../src/engine');

const authorId = '123456789012345678';
const channelId = '223456789012345678';
const userId = '323456789012345678';
const messageId = '1537213327967780966';
const token = 'transport-test-token-do-not-log';
const historyPath = `/channels/${channelId}/messages`;
const config = { token, authorId, pipeline: 'search', executionMode: 'preview', channelIds: [channelId] };
const message = { id: messageId, channel_id: channelId, type: 0, author: { id: authorId }, content: 'A preview from real HTTP transport.' };

// Retain Axios's production transforms and HTTP adapter; redirect only the destination.
// Request-level mocks cannot detect JSON null being serialized into a GET body.
async function withLoopback(respond, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = {
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        authenticated: req.headers.authorization === token
      };
      requests.push(request);
      try {
        const response = respond(request);
        res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
        res.end(response.status === 204 ? undefined : JSON.stringify(response.data));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: error.message }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const originalCreate = axios.create;
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  axios.create = (options) => originalCreate({ ...options, baseURL, proxy: false });
  try {
    return await run(requests);
  } finally {
    axios.create = originalCreate;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function historyResponse(request) {
  if (request.method !== 'GET' || request.url !== `${historyPath}?limit=100`) {
    return { status: 404, data: { message: 'Unexpected test route.' } };
  }
  if (request.body) {
    return { status: 400, data: { code: 50035, message: 'GET requests must have an empty body.' } };
  }
  return { data: [message] };
}

function assertBodyless(request) {
  assert.equal(request.body, '');
  assert.equal(request.contentType, undefined);
  assert.ok(request.contentLength === undefined || request.contentLength === '0');
  assert.equal(request.authenticated, true);
}

test('real Axios DM preview sends a bodyless GET and produces a preview', async () => {
  await withLoopback(historyResponse, async (requests) => {
    const previews = [];
    const stats = await runJob(config, { onPreview: (item) => previews.push(item) });
    assert.deepEqual(stats, { scanned: 1, matched: 1, deleted: 0, skipped: 0 });
    assert.equal(previews.length, 1);
    assert.equal(previews[0].content, message.content);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${historyPath}?limit=100`);
    assertBodyless(requests[0]);
  });
});

test('real Axios resolves a closed DM with JSON POST then fetches bodyless history', async () => {
  await withLoopback((request) => {
    if (request.method === 'POST' && request.url === '/users/@me/channels') return { data: { id: channelId } };
    return historyResponse(request);
  }, async (requests) => {
    const stats = await runJob({ ...config, channelIds: [], closedDmUserIds: [userId] });
    assert.equal(stats.matched, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].contentType, /^application\/json\b/);
    assert.deepEqual(JSON.parse(requests[0].body), { recipient_id: userId });
    assert.equal(requests[0].authenticated, true);
    assertBodyless(requests[1]);
  });
});

test('real Axios HTTP 400 reports route and Discord field errors', async () => {
  await withLoopback(() => ({ status: 400, data: {
    code: 50035,
    message: 'Invalid Form Body',
    errors: { limit: { _errors: [{ code: 'NUMBER_TYPE_COERCE', message: 'Not a valid integer' }] } }
  } }), async () => {
    await assert.rejects(runJob(config), (error) => {
      assert.ok(error.message.includes(`GET ${historyPath} failed: HTTP 400`));
      assert.match(error.message, /Discord 50035/);
      assert.match(error.message, /Invalid Form Body/);
      assert.match(error.message, /limit.*Not a valid integer/);
      return true;
    });
  });
});

test('API diagnostics redact a token echoed by an authentication error', async () => {
  await withLoopback(() => ({ status: 401, data: {
    code: 0,
    message: `Invalid authorization: ${token}`,
    errors: { authorization: { _errors: [{ code: 'INVALID_TOKEN', message: `Rejected ${token}` }] } }
  } }), async () => {
    const logs = [];
    await assert.rejects(runJob(config, { onLog: (line) => logs.push(line) }), (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.message.includes(token), false);
      assert.equal(JSON.stringify(logs).includes(token), false);
      assert.equal(error.message.includes('Authorization:'), false);
      return true;
    });
  });
});

test('real Axios overwrite sends JSON and deletion sends no body', async () => {
  await withLoopback((request) => {
    if (request.method === 'PATCH') return { data: { ...message, content: '[Redacted test]' } };
    if (request.method === 'DELETE') return { status: 204 };
    return historyResponse(request);
  }, async (requests) => {
    const stats = await runJob({
      ...config,
      executionMode: 'delete',
      overwriteEnabled: true,
      overwriteText: '[Redacted test]',
      deleteDelayMs: 1
    });
    assert.equal(stats.deleted, 1);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.method), ['GET', 'PATCH', 'DELETE']);
    assertBodyless(requests[0]);
    assert.equal(requests[1].url, `${historyPath}/${messageId}`);
    assert.match(requests[1].contentType, /^application\/json\b/);
    assert.deepEqual(JSON.parse(requests[1].body), { content: '[Redacted test]' });
    assert.equal(requests[2].url, `${historyPath}/${messageId}`);
    assertBodyless(requests[2]);
  });
});
