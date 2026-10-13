'use strict';

/**
 * Entry point: loads env, creates the app, starts listening.
 * The AI provider key comes ONLY from env vars — never from code, chat, or files.
 */

require('dotenv').config();
const { createApp, VERSION } = require('./app');

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = createApp(process.env);

const server = app.listen(PORT, () => {
  console.log(`vinayverse-ai-backend v${VERSION} listening on port ${PORT}`);
  console.log(`  AI provider : ${process.env.AI_MOCK === '1' ? 'MOCK MODE (test double — not real AI)' : process.env.AI_API_KEY ? 'configured' : 'NOT CONFIGURED (set AI_API_KEY)'}`);
  console.log(`  CORS        : ${process.env.CORS_ORIGIN || 'permissive (dev only — set CORS_ORIGIN in production)'}`);
  console.log(`  Health      : http://localhost:${PORT}/health`);
  if (process.env.AI_MOCK === '1') {
    console.warn('[WARN] AI_MOCK=1 — responses are canned test data tagged "mock": true. Do not use for real users.');
  }
});

// Hard server-side request timeout: 60s (upstream AI timeout is 50s).
server.timeout = 60000;
server.headersTimeout = 65000;
server.requestTimeout = 60000;
