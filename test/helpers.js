'use strict';

/** Test helpers: spin up the app on an ephemeral port. */
const { createApp } = require('../app');

async function startServer(envOverrides = {}) {
  const env = { AI_MOCK: '1', ...process.env, ...envOverrides };
  // Never let a real key leak into tests unless a test explicitly sets one.
  const app = createApp(env);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((res) => server.close(res)),
  };
}

/** Minimal 1x1 PNG bytes for upload tests. */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

function photoForm(buffer, filename = 'meal.png', type = 'image/png') {
  const fd = new FormData();
  fd.append('photo', new Blob([buffer], { type }), filename);
  return fd;
}

module.exports = { startServer, tinyPng, photoForm };

