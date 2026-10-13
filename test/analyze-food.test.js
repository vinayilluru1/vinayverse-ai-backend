'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tinyPng, photoForm } = require('./helpers');

test('POST /analyze-food happy path (mock provider)', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/analyze-food`, {
    method: 'POST',
    body: photoForm(tinyPng()),
  });
  assert.equal(res.status, 200);
  const items = await res.json();
  assert.ok(Array.isArray(items) && items.length > 0);
  for (const it of items) {
    // The app type-guards these strictly — every item must satisfy this.
    assert.equal(typeof it.name, 'string');
    assert.ok(it.name.trim().length > 0);
    assert.equal(typeof it.grams, 'number');
    assert.ok(Number.isFinite(it.grams) && it.grams >= 0);
    assert.equal(typeof it.kcal, 'number');
    assert.ok(Number.isFinite(it.kcal) && it.kcal >= 0);
    assert.equal(it.mock, true); // obviously a test double
  }
});

test('POST /analyze-food rejects missing file', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/analyze-food`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no image/i);
});

test('POST /analyze-food rejects non-image file', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const fd = new FormData();
  fd.append('photo', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const res = await fetch(`${srv.url}/analyze-food`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /JPEG, PNG, or WEBP/i);
});

test('POST /analyze-food rejects oversized file', async (t) => {
  const srv = await startServer({ MAX_UPLOAD_MB: '1' });
  t.after(() => srv.close());
  const big = Buffer.alloc(2 * 1024 * 1024, 0);
  const res = await fetch(`${srv.url}/analyze-food`, {
    method: 'POST',
    body: photoForm(big, 'big.png', 'image/png'),
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/i);
});

test('POST /analyze-food accepts webp', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/analyze-food`, {
    method: 'POST',
    body: photoForm(tinyPng(), 'meal.webp', 'image/webp'),
  });
  assert.equal(res.status, 200);
});
