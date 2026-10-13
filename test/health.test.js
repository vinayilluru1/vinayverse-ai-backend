'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

test('GET /health returns ok/version/providerConfigured', async (t) => {
  const srv = await startServer({ AI_MOCK: '1', AI_API_KEY: '' });
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.equal(body.providerConfigured, true); // mock counts as configured
});

test('GET /health providerConfigured=false without key or mock', async (t) => {
  const srv = await startServer({ AI_MOCK: '0', AI_API_KEY: '' });
  t.after(() => srv.close());
  const body = await (await fetch(`${srv.url}/health`)).json();
  assert.equal(body.providerConfigured, false);
});

test('unknown route returns JSON 404', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'Not found.');
});
