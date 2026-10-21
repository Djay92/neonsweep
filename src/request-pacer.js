'use strict';

function abortError() {
  return new Error('Aborted');
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let timer;
    const cleanUp = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanUp();
      reject(abortError());
    };
    timer = setTimeout(() => {
      cleanUp();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value !== undefined && value !== null) return value;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function nonnegativeNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function routeDetails(method, url) {
  const pathname = String(url).split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+/i, '');
  const segments = pathname.split('/');
  const majorParts = [];
  const normalized = segments.map((segment, index) => {
    if (!/^\d+$/.test(segment)) return segment;
    if (['channels', 'guilds'].includes(segments[index - 1])) {
      majorParts.push(`${segments[index - 1]}:${segment}`);
      return segment;
    }
    return ':id';
  }).join('/');
  return {
    route: `${String(method).toUpperCase()} ${normalized}`,
    major: majorParts.join('|') || 'none'
  };
}

function globalResponse(headers) {
  const global = headerValue(headers, 'x-ratelimit-global');
  return global === true || global === 1 || global === '1' || String(global).toLowerCase() === 'true'
    || String(headerValue(headers, 'x-ratelimit-scope')).toLowerCase() === 'global';
}

class RequestPacer {
  constructor({ now = Date.now, sleep = abortableSleep, onWait = () => {}, safetyMarginMs = 50, fallbackDelayMs = 250 } = {}) {
    if (typeof now !== 'function' || typeof sleep !== 'function' || typeof onWait !== 'function') throw new TypeError('Invalid request pacer callbacks.');
    if (nonnegativeNumber(safetyMarginMs) === null || nonnegativeNumber(fallbackDelayMs) === null) throw new TypeError('Request pacing delays must be nonnegative finite numbers.');
    this.now = now;
    this.sleep = sleep;
    this.onWait = onWait;
    this.safetyMarginMs = Number(safetyMarginMs);
    this.fallbackDelayMs = Number(fallbackDelayMs);
    this.routeBuckets = new Map();
    this.routeDeadlines = new Map();
    this.bucketDeadlines = new Map();
    this.globalUntilMs = 0;
    this.fallbackUntilMs = 0;
  }

  bucketKey(route, major) {
    const hash = this.routeBuckets.get(route);
    return hash ? `${hash}|${major}` : null;
  }

  rememberBucket(route, headers) {
    const hash = headerValue(headers, 'x-ratelimit-bucket');
    if (typeof hash === 'string' && hash.trim()) this.routeBuckets.set(route, hash.trim());
  }

  setDeadline(route, major, deadline) {
    const bucket = this.bucketKey(route, major);
    const deadlines = bucket ? this.bucketDeadlines : this.routeDeadlines;
    const key = bucket || route;
    deadlines.set(key, Math.max(deadlines.get(key) || 0, deadline));
  }

  async beforeRequest(method, url, signal) {
    const { route, major } = routeDetails(method, url);
    let waiting = false;
    try {
      while (true) {
        if (signal?.aborted) throw abortError();
        const bucket = this.bucketKey(route, major);
        const untilMs = Math.max(
          this.routeDeadlines.get(route) || 0,
          bucket ? this.bucketDeadlines.get(bucket) || 0 : 0,
          this.globalUntilMs,
          this.fallbackUntilMs
        );
        const waitMs = Math.max(0, Math.ceil(untilMs - this.now()));
        if (!waitMs) return;
        waiting = true;
        this.onWait({ reason: 'rate-limit', untilMs, waitMs });
        await this.sleep(waitMs, signal);
      }
    } finally {
      if (waiting) this.onWait({ reason: null, untilMs: null, waitMs: 0 });
    }
  }

  observeResponse(method, url, headers) {
    const { route, major } = routeDetails(method, url);
    this.rememberBucket(route, headers);
    const remaining = nonnegativeNumber(headerValue(headers, 'x-ratelimit-remaining'));
    const resetAfter = nonnegativeNumber(headerValue(headers, 'x-ratelimit-reset-after'));
    if (remaining === 0 && resetAfter !== null) {
      const deadline = this.now() + Math.ceil(resetAfter * 1000) + this.safetyMarginMs;
      this.setDeadline(route, major, deadline);
      if (globalResponse(headers)) this.globalUntilMs = Math.max(this.globalUntilMs, deadline);
    } else if (remaining === null || remaining === 0) {
      // Without a usable bucket allowance, preserve modest spacing across routes.
      this.fallbackUntilMs = Math.max(this.fallbackUntilMs, this.now() + this.fallbackDelayMs);
    }
  }

  observeRateLimit(method, url, response) {
    const { route, major } = routeDetails(method, url);
    const headers = response?.headers;
    this.rememberBucket(route, headers);
    const serverWaits = [
      response?.data?.retry_after,
      headerValue(headers, 'retry-after'),
      headerValue(headers, 'x-ratelimit-reset-after')
    ].map(nonnegativeNumber).filter((value) => value !== null);
    const waitMs = Math.ceil((serverWaits.length ? Math.max(...serverWaits) : 2.5) * 1000) + this.safetyMarginMs;
    const deadline = this.now() + waitMs;
    this.setDeadline(route, major, deadline);
    if (response?.data?.global === true || globalResponse(headers)) this.globalUntilMs = Math.max(this.globalUntilMs, deadline);
    return waitMs;
  }
}

module.exports = { RequestPacer };
