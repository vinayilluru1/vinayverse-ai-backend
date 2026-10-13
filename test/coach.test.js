'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

async function postCoach(url, body, rawBody) {
  return fetch(`${url}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
}

test('POST /api/coach happy path (mock provider)', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, {
    question: 'How much protein do I need?',
    profile: { age: 30, goal: 'muscle' },
    todayData: { kcal: 1800 },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.answer, 'string');
  assert.ok(body.answer.length > 0);
  assert.equal(body.mock, true); // obviously a test double
});

test('POST /api/coach rejects missing question', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, { profile: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /question/i);
});

test('POST /api/coach rejects empty question', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, { question: '   ' });
  assert.equal(res.status, 400);
});

test('POST /api/coach rejects too-long question', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, { question: 'x'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too long/i);
});

test('POST /api/coach rejects non-object profile', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, { question: 'hi', profile: 'nope' });
  assert.equal(res.status, 400);
});

test('POST /api/coach rejects invalid JSON', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, null, '{not json');
  assert.equal(res.status, 400);
});

test('POST /api/coach rejects oversized JSON body', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, { question: 'x'.repeat(200 * 1024) });
  assert.equal(res.status, 413);
});

test('POST /api/coach works without profile/todayData', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await postCoach(srv.url, { question: 'Hello' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mock, true);
});
