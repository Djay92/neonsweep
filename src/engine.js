const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { RequestPacer } = require('./request-pacer');
const { JobProgress } = require('./job-progress');

const DISCORD_EPOCH = 1420070400000n;
const DELETABLE_TYPES = new Set([0, 6, 19, 20, 21]);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Aborted'));
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error('Aborted'));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

function dateToSnowflake(dateInput) {
  const value = new Date(dateInput).getTime();
  if (!Number.isFinite(value)) throw new Error('Invalid date filter.');
  const ts = BigInt(Math.max(value, Number(DISCORD_EPOCH)));
  return ((ts - DISCORD_EPOCH) << 22n).toString();
}

function normalizeConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('Missing job configuration.');
  const cfg = { ...input };
  const list = (value, ids = false) => {
    if (ids && (Array.isArray(value) ? value : [value]).some((v) => typeof v === 'number' && !Number.isSafeInteger(v))) throw new Error('Discord IDs must be passed as strings to preserve precision.');
    const entries = (Array.isArray(value) ? value : [value ?? ''])
      .flatMap((v) => String(v).split(ids ? /[\s,;]+/ : /[,\n]+/))
      .map((v) => v.trim()).filter(Boolean);
    if (ids && entries.some((id) => !/^\d{17,20}$/.test(id))) {
      throw new Error('Discord IDs must contain 17–20 digits; keep them as strings.');
    }
    return [...new Set(entries)];
  };
  for (const key of ['guildIds', 'channelIds', 'closedDmUserIds', 'mentionedUserIds']) cfg[key] = list(cfg[key], true);
  for (const key of ['keywords', 'preserveKeywords', 'contentTypes']) cfg[key] = list(cfg[key]);
  if (cfg.contentTypes.some((v) => !['image', 'video', 'sound', 'file', 'link', 'embed', 'sticker', 'text'].includes(v))) throw new Error('Unknown content type.');
  cfg.token = String(cfg.token || '').trim();
  if (!cfg.token) throw new Error('Connect your Discord account first.');
  cfg.authorId = list(cfg.authorId, true)[0];
  cfg.targetAuthorId = list(cfg.targetAuthorId, true)[0] || null;
  if (!cfg.authorId) throw new Error('Missing authenticated author ID. Reconnect your account.');
  cfg.pipeline = cfg.pipeline || 'search';
  if (!['search', 'reactions', 'datapackage'].includes(cfg.pipeline)) throw new Error('Unknown scan pipeline.');
  if (!['preview', 'delete'].includes(cfg.executionMode)) throw new Error('Unknown execution mode.');
  for (const key of ['moderatorMode', 'includePinned', 'overwriteEnabled', 'deleteForumTopics', 'removeEveryoneReactions', 'localArchive']) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'boolean') throw new Error(`Invalid boolean: ${key}`);
  }
  for (const key of ['minDate', 'maxDate']) if (cfg[key]) dateToSnowflake(cfg[key]);
  if (cfg.minDate && cfg.maxDate && new Date(cfg.minDate) > new Date(cfg.maxDate)) throw new Error('Minimum date must precede maximum date.');
  if (cfg.disappearingDays && (!Number.isFinite(Number(cfg.disappearingDays)) || Number(cfg.disappearingDays) <= 0)) throw new Error('Disappearing days must be positive.');
  if (cfg.pipeline === 'datapackage') {
    if (!cfg.dataPackagePath) throw new Error('Select an extracted data package folder first.');
  } else if (!cfg.guildIds.length && !cfg.channelIds.length && !cfg.closedDmUserIds.length) {
    throw new Error('Select a server or DM, or enter a channel ID or closed DM user ID.');
  }
  return cfg;
}

function createClient(token, { onWait = () => {} } = {}) {
  const client = axios.create({
    timeout: 30000,
    baseURL: 'https://discord.com/api/v9',
    headers: {
      Authorization: token.trim(),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36'
    }
  });
  client.pacer = new RequestPacer({ onWait });
  client.onWait = onWait;
  return client;
}

function describeApiError(err, method, url, client) {
  const status = err.response?.status;
  const body = err.response?.data;
  const parts = [];
  if (status) parts.push(`HTTP ${status}`);
  if (body && (typeof body.code === 'number' || typeof body.code === 'string')) parts.push(`Discord ${body.code}`);
  let message = `${method} ${url} failed: ${parts.join(', ') || err.code || 'Network error'}`;
  if (typeof body?.message === 'string') message += `: ${body.message}`;
  else if (!status) message += err.code === 'ECONNABORTED' ? ': Request timed out. Check your connection and try again.' : ': Check your connection and try again.';
  const details = [];
  const collect = (node, field = '', depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6 || details.length >= 6) return;
    if (Array.isArray(node._errors)) {
      for (const detail of node._errors) {
        if (typeof detail.message === 'string' && details.length < 6) details.push(`${field || 'request'}: ${detail.message}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== '_errors') collect(value, field ? `${field}.${key}` : key, depth + 1);
    }
  };
  collect(body?.errors);
  if (details.length) message += `; ${details.join('; ')}`;
  // Only the server's error fields are surfaced, never Axios config/headers.
  const headers = client.defaults?.headers;
  const token = headers?.Authorization || headers?.common?.Authorization;
  if (typeof token === 'string' && token) message = message.split(token).join('[REDACTED]');
  const error = new Error(message.slice(0, 1800));
  error.status = status;
  error.discordCode = body?.code;
  return error;
}

async function apiCall(client, method, url, { params = {}, data } = {}, emitLog, signal) {
  while (!signal.aborted) {
    try {
      await client.pacer.beforeRequest(method, url, signal);
      const request = { method, url, params, signal };
      // A JSON content type plus data:null becomes a literal "null" body in Axios.
      // GET/HEAD use query parameters; POST/PATCH payloads are encoded by Axios.
      if (data !== undefined && data !== null && !['GET', 'HEAD'].includes(method.toUpperCase())) request.data = data;
      const res = await client.request(request);
      client.pacer.observeResponse(method, url, res.headers);
      if (res.status === 202) {
        const wait = (res.data?.retry_after || 2) * 1000;
        emitLog(`[Indexing 202] Waiting ${wait}ms for Discord search index...`);
        client.onWait({ reason: 'indexing', untilMs: Date.now() + wait });
        try { await sleep(wait, signal); }
        finally { client.onWait({ reason: null, untilMs: null }); }
        continue;
      }
      return res.data;
    } catch (err) {
      if (err.message === 'Aborted' || signal.aborted) throw new Error('Aborted');
      const status = err.response?.status;
      if (status === 429) {
        const wait = client.pacer.observeRateLimit(method, url, err.response);
        emitLog(`[Rate Limit 429] Cooling down for ${wait}ms...`);
        continue;
      }
      // Non-fatal API errors (403, 404, etc.) log cleanly instead of crashing the job
      if (status === 403 || status === 404) {
        const apiError = describeApiError(err, method, url, client);
        if (method !== 'GET') throw apiError;
        emitLog(`[API Notice] ${apiError.message}. Skipping...`);
        return null;
      }
      throw describeApiError(err, method, url, client);
    }
  }
  throw new Error('Aborted');
}

function matchesContentType(msg, types) {
  if (!types || types.length === 0) return true;
  const att = msg.attachments || [];
  const emb = msg.embeds || [];
  const stk = msg.sticker_items || msg.stickers || [];
  const txt = msg.content || '';

  const flags = {
    image: att.some((a) => (a.content_type?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename || '')) && !a.content_type?.includes('svg')) || emb.some((e) => e.type === 'image' || e.image || e.thumbnail),
    video: att.some((a) => a.content_type?.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(a.filename || '')) || emb.some((e) => e.type === 'video' || e.video),
    sound: att.some((a) => a.content_type?.startsWith('audio/') || /\.(mp3|wav|ogg|m4a)$/i.test(a.filename || '')),
    file: att.some((a) => {
      const ct = a.content_type || '';
      return !/^(image|video|audio)\//.test(ct) && !/\.(png|jpe?g|gif|webp|mp4|mov|webm|mp3|wav|ogg|m4a)$/i.test(a.filename || '');
    }),
    link: /https?:\/\/\S+/i.test(txt),
    embed: emb.length > 0,
    sticker: stk.length > 0,
    text: txt.trim().length > 0 && att.length === 0 && emb.length === 0 && stk.length === 0 && !/https?:\/\/\S+/i.test(txt)
  };
  return types.some((t) => flags[t]);
}

function passesFilters(msg, cfg, authorId, minId, maxId) {
  const expectedAuthor = cfg.moderatorMode ? cfg.targetAuthorId : authorId;
  if (expectedAuthor && msg.author?.id !== expectedAuthor) return false;
  if (!DELETABLE_TYPES.has(msg.type ?? 0)) return false;
  if (!cfg.includePinned && msg.pinned) return false;
  if (minId && BigInt(msg.id) < BigInt(minId)) return false;
  if (maxId && BigInt(msg.id) > BigInt(maxId)) return false;
  if (!matchesContentType(msg, cfg.contentTypes)) return false;

  const embText = (msg.embeds || []).map((e) => `${e.title || ''} ${e.description || ''}`).join(' ');
  const fullText = `${msg.content || ''} ${embText}`.toLowerCase();

  if (cfg.preserveKeywords?.length > 0 && cfg.preserveKeywords.some((k) => fullText.includes(k.toLowerCase()))) return false;
  if (cfg.keywords?.length > 0 && !cfg.keywords.some((k) => fullText.includes(k.toLowerCase()))) return false;
  if (cfg.mentionedUserIds?.length > 0) {
    const mIds = new Set((msg.mentions || []).map((u) => u.id));
    if (!cfg.mentionedUserIds.some((id) => mIds.has(id) || (msg.content || '').includes(`<@${id}>`) || (msg.content || '').includes(`<@!${id}>`))) return false;
  }
  return true;
}

function archiveMessage(msg, archiveDir) {
  try {
    const file = path.join(archiveDir, 'local-archive.json');
    let arr = [];
    if (fs.existsSync(file)) {
      try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    }
    if (!arr.some((x) => x.id === msg.id)) {
      arr.push({ id: msg.id, channel_id: msg.channel_id, timestamp: msg.timestamp, content: msg.content || '', archivedAt: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    }
  } catch (_) {}
}

function previewMessage(msg, authorId) {
  return {
    id: msg.id, channel_id: msg.channel_id, channel_name: msg.channel?.name || null,
    timestamp: msg.timestamp || '', content: msg.content || '[Media/Embed]',
    author_id: msg.author?.id || authorId,
    author_name: msg.author?.global_name || msg.author?.username || null,
    attachments: (msg.attachments || []).map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size })),
    embeds: (msg.embeds || []).map((e) => ({ type: e.type, title: e.title, url: e.url })),
    stickers: (msg.sticker_items || msg.stickers || []).map((s) => ({ name: s.name }))
  };
}

async function handleAction(client, msg, cfg, authorId, stats, callbacks, signal) {
  if (signal.aborted) throw new Error('Aborted');
  const snippet = (msg.content || '[Media/Embed]').replace(/\n/g, ' ').slice(0, 60);

  if (!cfg.reviewedBatch) stats.matched++;
  if (cfg.executionMode === 'preview') {
    callbacks.onDiscover?.(msg);
    callbacks.onPreview(previewMessage(msg, authorId));
    callbacks.onStats(stats);
    return;
  }

  // Only archive on confirmed deletion/wipe pass
  if (cfg.localArchive && cfg.archiveDir) archiveMessage(msg, cfg.archiveDir);

  const isForumPost = (msg.type === 0 && msg.id === msg.channel_id) || msg.type === 21 || msg.thread?.id;
  if (cfg.deleteForumTopics && isForumPost) {
    const tid = msg.thread?.id || msg.channel_id;
    await apiCall(client, 'DELETE', `/channels/${tid}`, {}, callbacks.onLog, signal);
    if (signal.aborted) return;
    stats.deleted++;
    callbacks.onCompleted?.(msg);
    callbacks.onLog(`[FORUM DELETED] Thread ${tid}`);
    callbacks.onStats(stats);
    return;
  }

  if (cfg.overwriteEnabled && (!msg.author?.id || msg.author.id === authorId)) {
    try {
      await apiCall(client, 'PATCH', `/channels/${msg.channel_id}/messages/${msg.id}`, { data: { content: cfg.overwriteText || '[Redacted]' } }, callbacks.onLog, signal);
    } catch (error) {
      if (signal.aborted) throw new Error('Aborted');
      callbacks.onLog(`[Overwrite skipped] ${error.message}`);
    }
  }

  if (signal.aborted) return;
  await apiCall(client, 'DELETE', `/channels/${msg.channel_id}/messages/${msg.id}`, {}, callbacks.onLog, signal);
  if (signal.aborted) return;
  stats.deleted++;
  callbacks.onCompleted?.(msg);
  callbacks.onLog(`[DELETED] [${msg.id}] "${snippet}"`);
  callbacks.onStats(stats);
}

async function runJob(cfg, callbacks = {}, signal = new AbortController().signal) {
  cfg = normalizeConfig(cfg);
  if (cfg.executionMode === 'delete') return collectAndDelete(cfg, callbacks, signal);
  callbacks = { onLog: () => {}, onPreview: () => {}, onStats: () => {}, ...callbacks };
  const stats = { scanned: 0, matched: 0, deleted: 0, skipped: 0, skippedIds: new Set() };
  const reporter = new JobProgress(stats, callbacks.onStats, { phase: cfg.executionMode === 'preview' ? 'preview' : 'delete-live' });
  callbacks.onStats = () => reporter.emit();
  callbacks.onCompleted = (item) => reporter.complete(item);
  const client = createClient(cfg.token, { onWait: (wait) => reporter.wait(wait) });
  callbacks.onClient?.(client);
  const seen = new Set();
  callbacks.onStats(stats);

  let minId = cfg.minDate ? dateToSnowflake(cfg.minDate) : null;
  let maxId = cfg.maxDate ? dateToSnowflake(cfg.maxDate) : null;
  if (cfg.disappearingDays && Number(cfg.disappearingDays) > 0) {
    const ageLimit = dateToSnowflake(new Date(Date.now() - Number(cfg.disappearingDays) * 86400000));
    if (!maxId || BigInt(ageLimit) < BigInt(maxId)) maxId = ageLimit;
  }
  if (minId && maxId && BigInt(minId) > BigInt(maxId)) throw new Error('Date and age filters leave an empty date range.');

  const channelTargets = [...(cfg.channelIds || [])];
  
  // Resolve guild channels if servers are selected
  if (cfg.pipeline === 'reactions' && cfg.guildIds.length > 0) {
    for (const gid of cfg.guildIds) {
      if (signal.aborted) break;
      try {
        const channels = await apiCall(client, 'GET', `/guilds/${gid}/channels`, {}, callbacks.onLog, signal);
        if (Array.isArray(channels)) {
          for (const ch of channels) {
            if ([0, 2, 5, 10, 11, 12, 13].includes(ch.type)) {
              channelTargets.push(ch.id);
            }
          }
        }
      } catch (e) {
        if (signal.aborted) throw new Error('Aborted');
        callbacks.onLog(`[Warning] Could not fetch channels for guild ${gid}`);
      }
    }
  }

  if (cfg.closedDmUserIds?.length > 0) {
    for (const uid of cfg.closedDmUserIds) {
      if (signal.aborted) break;
      try {
        const dm = await apiCall(client, 'POST', '/users/@me/channels', { data: { recipient_id: uid.trim() } }, callbacks.onLog, signal);
        if (dm?.id) {
          channelTargets.push(dm.id);
          callbacks.onLog(`[Resolved DM] User ${uid} -> Channel ${dm.id}`);
        }
      } catch (e) {
        if (signal.aborted) throw new Error('Aborted');
        throw new Error(`Could not resolve DM user ${uid}: ${e.message}. For a channel ID, use Specific Channel IDs.`);
      }
    }
  }

  const uniqueChannels = [...new Set(channelTargets)];
  callbacks.onLog(`[Targets] ${cfg.guildIds.length} servers, ${uniqueChannels.length} resolved channels; pipeline=${cfg.pipeline}, mode=${cfg.executionMode}`);
  if (cfg.pipeline === 'reactions' && !uniqueChannels.length) throw new Error('No accessible message channels resolved.');

  if (cfg.pipeline === 'search') {
    const endpoints = [];
    if (cfg.guildIds?.length > 0) {
      for (const gid of cfg.guildIds) endpoints.push(`/guilds/${gid}/messages/search`);
    }
    // Explicit channels use history, which does not depend on Discord's search index.
    for (const cid of uniqueChannels) {
      callbacks.onLog(`[History] Scanning channel ${cid}...`);
      let before = maxId;
      while (!signal.aborted) {
        const params = { limit: 100 };
        if (before) params.before = before;
        const messages = await apiCall(client, 'GET', `/channels/${cid}/messages`, { params }, callbacks.onLog, signal);
        if (messages === null) break;
        if (!Array.isArray(messages)) throw new Error(`Invalid message history for channel ${cid}.`);
        callbacks.onLog(`[History] Channel ${cid}: received ${messages.length} messages.`);
        if (!messages.length) break;
        let oldest = null;
        for (const raw of messages) {
          if (signal.aborted) throw new Error('Aborted');
          const msg = { ...raw, channel_id: raw.channel_id || cid };
          if (!oldest || BigInt(msg.id) < BigInt(oldest)) oldest = msg.id;
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          stats.scanned++;
          if (passesFilters(msg, cfg, cfg.authorId, minId, maxId)) await handleAction(client, msg, cfg, cfg.authorId, stats, callbacks, signal);
          else stats.skipped++;
          callbacks.onStats(stats);
        }
        if (before && BigInt(oldest) >= BigInt(before)) throw new Error(`Pagination made no progress in channel ${cid}.`);
        if (messages.length < 100 || (minId && BigInt(oldest) <= BigInt(minId))) break;
        before = oldest;
      }
    }

    for (const ep of endpoints) {
      if (signal.aborted) break;
      callbacks.onLog(`Scanning ${ep}...`);
      let curMax = maxId;

      while (!signal.aborted) {
        const params = { include_nsfw: true, sort_by: 'timestamp', sort_order: 'desc' };
        if (!cfg.moderatorMode) params.author_id = cfg.authorId;
        else if (cfg.targetAuthorId) params.author_id = cfg.targetAuthorId;
        if (minId) params.min_id = minId;
        if (curMax) params.max_id = curMax;
        if (!cfg.includePinned) params.pinned = false;

        const data = await apiCall(client, 'GET', ep, { params }, callbacks.onLog, signal);
        if (!data) break;
        if (!Array.isArray(data.messages)) throw new Error(`Invalid search response from ${ep}.`);
        const groups = data.messages;
        if (groups.length === 0) break;

        const hits = groups.flatMap((g) => {
          const messages = Array.isArray(g) ? g : [g];
          const marked = messages.filter((m) => m.hit === true);
          return marked.length ? marked : messages.filter((m) => m.hit !== false).slice(0, 1);
        }).filter(Boolean);
        if (hits.length === 0) break;

        for (const msg of hits) {
          if (signal.aborted) break;
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          stats.scanned++;
          callbacks.onStats(stats);
          if (stats.skippedIds.has(msg.id)) continue;
          if (passesFilters(msg, cfg, cfg.authorId, minId, maxId)) {
            await handleAction(client, msg, cfg, cfg.authorId, stats, callbacks, signal);
          } else stats.skipped++;
          callbacks.onStats(stats);
        }
        const nextMax = hits.reduce((min, m) => BigInt(m.id) < min ? BigInt(m.id) : min, BigInt(hits[0].id)).toString();
        if (curMax && BigInt(nextMax) >= BigInt(curMax)) throw new Error('Search pagination made no progress.');
        curMax = nextMax;
        if (minId && BigInt(curMax) <= BigInt(minId)) break;
      }
    }
  } else if (cfg.pipeline === 'reactions') {
    for (const cid of uniqueChannels) {
      if (signal.aborted) break;
      callbacks.onLog(`[Reaction Scanner] Scanning channel ${cid}...`);
      let beforeId = maxId;
      let hasMore = true;

      while (!signal.aborted && hasMore) {
        const params = { limit: 100 };
        if (beforeId) params.before = beforeId;

        const msgs = await apiCall(client, 'GET', `/channels/${cid}/messages`, { params }, callbacks.onLog, signal);
        if (!msgs || msgs.length === 0) break;

        for (const m of msgs) {
          if (signal.aborted) break;
          stats.scanned++;
          callbacks.onStats(stats);

          if (minId && BigInt(m.id) < BigInt(minId)) {
            hasMore = false;
            break;
          }
          if (!m.reactions?.length) continue;
          if (!passesFilters(m, { ...cfg, moderatorMode: true, targetAuthorId: null }, cfg.authorId, minId, maxId)) {
            stats.skipped++;
            callbacks.onStats(stats);
            continue;
          }

          if (cfg.removeEveryoneReactions) {
            stats.matched++;
            if (cfg.executionMode === 'preview') {
              callbacks.onPreview({ ...previewMessage({ ...m, channel_id: cid }, cfg.authorId), content: `[Clear all reactions] ${m.content || ''}`, action: 'clear-reactions', author_id: cfg.authorId });
              callbacks.onLog(`[PREVIEW] Would clear all reactions on ${m.id}`);
            } else {
              await apiCall(client, 'DELETE', `/channels/${cid}/messages/${m.id}/reactions`, {}, callbacks.onLog, signal);
              if (signal.aborted) break;
              stats.deleted++;
              callbacks.onLog(`[MOD REACTION WIPE] Msg ${m.id}`);
            }
          } else {
            for (const r of m.reactions.filter((x) => x.me)) {
              const eStr = encodeURIComponent(r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name);
              stats.matched++;
              if (cfg.executionMode === 'preview') {
                callbacks.onPreview({ ...previewMessage({ ...m, channel_id: cid }, cfg.authorId), content: `[Remove reaction ${r.emoji.name}] ${m.content || ''}`, action: 'remove-reaction', emoji: eStr, author_id: cfg.authorId });
                callbacks.onLog(`[PREVIEW] Would remove reaction ${r.emoji.name} on ${m.id}`);
              } else {
                await apiCall(client, 'DELETE', `/channels/${cid}/messages/${m.id}/reactions/${eStr}/@me`, {}, callbacks.onLog, signal);
                if (signal.aborted) break;
                stats.deleted++;
                callbacks.onLog(`[REACTION REMOVED] ${r.emoji.name} on ${m.id}`);
              }
            }
          }
          callbacks.onStats(stats);
        }

        if (!hasMore || msgs.length < 100) break;
        beforeId = msgs[msgs.length - 1].id;
      }
    }
  } else if (cfg.pipeline === 'datapackage') {
    const baseDir = cfg.dataPackagePath;
    if (!baseDir) {
      callbacks.onLog('[Error] Please select a Data Package folder first.');
      return;
    }
    const msgDir = fs.existsSync(path.join(baseDir, 'messages')) ? path.join(baseDir, 'messages') : baseDir;
    const dirs = fs.readdirSync(msgDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('c'));
    for (const d of dirs) {
      if (signal.aborted) break;
      const cid = d.name.slice(1);
      if (uniqueChannels.length > 0 && !uniqueChannels.includes(cid)) continue;
      const jFile = path.join(msgDir, d.name, 'messages.json');
      if (!fs.existsSync(jFile)) continue;
      const rows = JSON.parse(fs.readFileSync(jFile, 'utf8'));
      for (const r of rows) {
        if (signal.aborted) break;
        stats.scanned++;
        const mid = String(r.ID || r.id);
        const txt = String(r.Contents || r.contents || '');
        const msg = { id: mid, channel_id: cid, type: 0, content: txt, timestamp: r.Timestamp || '', author: { id: cfg.authorId } };
        if (passesFilters(msg, cfg, cfg.authorId, minId, maxId)) await handleAction(client, msg, cfg, cfg.authorId, stats, callbacks, signal);
        else stats.skipped++;
        callbacks.onStats(stats);
      }
    }
  }
  if (signal.aborted) throw new Error('Aborted');
  callbacks.onStats(stats);
  callbacks.onLog(`--- Job Finished: ${stats.scanned} scanned, ${stats.matched} matched, ${stats.deleted} deleted, ${stats.skipped} skipped ---`);
  if (!stats.scanned) callbacks.onLog('[No results] No messages were returned. Check selected targets, date range, and channel/history access.');
  return { scanned: stats.scanned, matched: stats.matched, deleted: stats.deleted, skipped: stats.skipped };
}

async function collectAndDelete(cfg, callbacks, signal) {
  callbacks = { onLog: () => {}, onStats: () => {}, onPreview: () => {}, ...callbacks };
  const startedAt = Date.now();
  const pending = [];
  const sourceMessages = new Map();
  let client;
  callbacks.onLog('[Preparing deletion] Collecting all matches before deleting so the batch total and ETA are known.');
  const scanStats = await runJob({ ...cfg, executionMode: 'preview' }, {
    onClient: (value) => { client = value; },
    onDiscover: (message) => sourceMessages.set(message.id, message),
    onStats: (stats) => callbacks.onStats({ ...stats, phase: 'discover', etaMs: null }),
    onLog: (message) => callbacks.onLog(message.startsWith('--- Job Finished:') ? `[Discovery complete] ${pending.length} matching actions queued.` : message),
    onPreview: (item) => {
      pending.push({ ...sourceMessages.get(item.id), ...item });
      sourceMessages.delete(item.id);
      callbacks.onPreview(item);
    }
  }, signal);
  if (signal.aborted) throw new Error('Aborted');
  return deleteReviewedItems(cfg.token, cfg.authorId, pending, cfg.overwriteEnabled, cfg.overwriteText,
    cfg.archiveDir, callbacks.onLog, callbacks.onStats, signal,
    { ...cfg, client, scanStats, startedAt, phase: 'delete-live' });
}

async function deleteReviewedItems(token, authorId, items, overwriteEnabled, overwriteText, archiveDir, emitLog = () => {}, emitStats = () => {}, signal = new AbortController().signal, options = {}) {
  const stats = { scanned: options.scanStats?.scanned ?? items.length, matched: items.length, deleted: 0, skipped: options.scanStats?.skipped ?? 0 };
  const reporter = new JobProgress(stats, emitStats, { total: items.length, phase: options.phase || 'delete-reviewed', startedAt: options.startedAt });
  const client = options.client || createClient(token);
  client.onWait = (wait) => reporter.wait(wait);
  client.pacer.onWait = client.onWait;
  const callbacks = { onLog: emitLog, onStats: () => reporter.emit(), onPreview: () => {}, onCompleted: (item) => reporter.complete(item) };
  reporter.emit();
  try {
    for (const item of items) {
      if (signal.aborted) throw new Error('Aborted');
      try {
        if (item.action === 'clear-reactions' || item.action === 'remove-reaction') {
          if (item.action === 'remove-reaction' && !item.emoji) throw new Error('Missing reaction identifier.');
          const suffix = item.action === 'clear-reactions' ? '' : `/${item.emoji}/@me`;
          await apiCall(client, 'DELETE', `/channels/${item.channel_id}/messages/${item.id}/reactions${suffix}`, {}, emitLog, signal);
          stats.deleted++;
          reporter.complete(item);
          reporter.emit();
          continue;
        }
        if (item.action) throw new Error('Unknown reviewed action.');
        await handleAction(client, { ...item, author: { id: item.author_id || authorId } },
          { ...options, executionMode: 'delete', reviewedBatch: true, overwriteEnabled, overwriteText, localArchive: options.localArchive !== false, archiveDir },
          authorId, stats, callbacks, signal);
      } catch (error) {
        if (error.status !== 404 || signal.aborted) throw error;
        stats.skipped++;
        reporter.complete(item);
        emitLog(`[Skipped unavailable item] ${item.id}`);
        reporter.emit();
      }
    }
    if (signal.aborted) throw new Error('Aborted');
    emitLog('--- Reviewed Batch Complete ---');
    return reporter.emit();
  } finally { reporter.emit(); }
}

module.exports = { runJob, deleteReviewedItems, createClient, normalizeConfig };
