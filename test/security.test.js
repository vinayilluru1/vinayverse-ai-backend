'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tinyPng, photoForm } = require('./helpers');

const REAL_FETCH = globalThis.fetch;

function stubFetch(impl) {
  globalThis.fetch = impl;
}
function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

test('upstream 500 maps to generic 502 (no provider internals leak)', async (t) => {
  // Intercept ONLY the provider call; let the test's own HTTP to the app through.
  stubFetch(async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'SECRET_PROVIDER_DETAIL' } }),
        text: async () => 'SECRET_PROVIDER_DETAIL',
      };
    }
    return REAL_FETCH(url, opts);
  });
  t.after(restoreFetch);
  const srv = await startServer({ AI_MOCK: '0', AI_API_KEY: 'dummy-key' });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.doesNotMatch(text, /SECRET_PROVIDER_DETAIL/);
  assert.doesNotMatch(text, /dummy-key/);
  assert.match(JSON.parse(text).error, /try again/i);
});

test('upstream timeout maps to 504', async (t) => {
  // Hanging provider stub that honors AbortSignal, like real fetch does.
  // Non-provider URLs (the test's own HTTP to the app) pass through.
  stubFetch((url, opts) => {
    if (!String(url).includes('/chat/completions')) return REAL_FETCH(url, opts);
    return new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        rej(e);
      });
    });
  });
  t.after(restoreFetch);
  const srv = await startServer({ AI_MOCK: '0', AI_API_KEY: 'dummy-key', AI_TIMEOUT_MS: '150' });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(res.status, 504);
  assert.match((await res.json()).error, /timed out/i);
});

test('missing AI_API_KEY without mock returns honest 503', async (t) => {
  const srv = await startServer({ AI_MOCK: '0', AI_API_KEY: '' });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not configured/i);
});

test('CORS allowlist blocks disallowed origin, allows listed origin', async (t) => {
  const srv = await startServer({ CORS_ORIGIN: 'https://allowed.example' });
  t.after(() => srv.close());
  const evil = await fetch(`${srv.url}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const good = await fetch(`${srv.url}/health`, { headers: { Origin: 'https://allowed.example' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://allowed.example');
});

test('CORS literal "null" origin can be allowlisted for file:// app usage', async (t) => {
  const srv = await startServer({ CORS_ORIGIN: 'null' });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/health`, { headers: { Origin: 'null' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'null');
});

test('rate limiter returns 429 after the per-minute budget is spent', async (t) => {
  const srv = await startServer({ RATE_LIMIT_PER_MIN: '2' });
  t.after(() => srv.close());
  const post = () =>
    fetch(`${srv.url}/api/coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hi' }),
    });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const limited = await post();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  assert.match((await limited.json()).error, /too many requests/i);
});

test('/health is not rate limited', async (t) => {
  const srv = await startServer({ RATE_LIMIT_PER_MIN: '1' });
  t.after(() => srv.close());
  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(`${srv.url}/health`)).status, 200);
  }
});
