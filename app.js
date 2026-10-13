'use strict';

/**
 * VINAYVERSE AI backend — Express app factory.
 *
 * Thin, secure proxy between the VINAYVERSE app and an OpenAI-compatible
 * AI provider. The provider API key lives ONLY in server env vars.
 *
 * Endpoints:
 *   GET  /health        -> { ok, version, providerConfigured }
 *   POST /api/coach     -> { question, profile?, todayData? } => { answer } (+mock flag in mock mode)
 *   POST /analyze-food  -> multipart "photo" (jpeg/png/webp) => [{ name, grams, kcal, protein?, carbs?, fat?, meal? }]
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { rateLimit } = require('./lib/rateLimit');
const { coachAnswer, analyzeFoodImage, isMock, UpstreamError } = require('./lib/ai');

const VERSION = '1.0.0';
const QUESTION_MAX_LEN = 2000;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function createApp(env) {
  env = env || process.env;
  const app = express();
  app.disable('x-powered-by');

  // ---- CORS ---------------------------------------------------------------
  // CORS_ORIGIN: comma-separated allowlist, e.g. "https://app.example.com".
  // The literal "null" may be added to support the single-file HTML opened
  // from file:// (browsers send `Origin: null` there).
  const origins = String(env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    console.warn(
      '[WARN] CORS_ORIGIN is not set — accepting requests from ANY origin. ' +
        'OK for local dev, but set CORS_ORIGIN to your app origin(s) in production.'
    );
    app.use(cors());
  } else {
    app.use(
      cors({
        origin: (origin, cb) => {
          // No Origin header (curl, same-origin, server-to-server): allow.
          if (!origin) return cb(null, true);
          if (origins.includes(origin)) return cb(null, true);
          return cb(null, false); // disallowed: no ACAO header is sent
        },
      })
    );
  }

  // ---- body limits ----------------------------------------------------------
  app.use(express.json({ limit: '100kb' }));

  // ---- rate limiting (API routes only; /health stays open) ------------------
  const limiter = rateLimit({ perMin: parseInt(env.RATE_LIMIT_PER_MIN || '30', 10) });
  app.use('/api/', limiter);
  app.use('/analyze-food', limiter);

  // ---- helpers ---------------------------------------------------------------
  function log(method, path, status, startedAt, extra) {
    const ms = Date.now() - startedAt;
    // Log counts/sizes only — never bodies, keys, images, or PII.
    const x = extra ? ` ${JSON.stringify(extra)}` : '';
    console.log(`${method} ${path} -> ${status} (${ms}ms)${x}`);
  }

  /** Map any failure to a safe client response. Never forwards provider internals. */
  function clientError(res, method, path, startedAt, err, extra) {
    let status = 500;
    let message = 'Something went wrong. Please try again later.';
    if (err instanceof UpstreamError) {
      status = err.httpStatus || 502;
      if (err.code === 'UPSTREAM_TIMEOUT') message = 'The AI request timed out. Please try again.';
      else if (err.code === 'PROVIDER_NOT_CONFIGURED')
        message = 'The AI provider is not configured on this server.';
      else message = 'The AI provider returned an error. Please try again later.';
    } else if (err && err.status === 400 && err.message) {
      status = 400;
      message = err.message;
    }
    log(method, path, status, startedAt, extra);
    return res.status(status).json({ error: message });
  }

  // ---- routes ------------------------------------------------------------------
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      providerConfigured: Boolean(env.AI_API_KEY) || isMock(env),
    });
  });

  function validateCoachBody(body) {
    if (!body || typeof body !== 'object') return 'Request body must be JSON.';
    const { question, profile, todayData } = body;
    if (typeof question !== 'string' || !question.trim())
      return 'question is required and must be a non-empty string.';
    if (question.length > QUESTION_MAX_LEN)
      return `question is too long (max ${QUESTION_MAX_LEN} characters).`;
    if (profile !== undefined && (typeof profile !== 'object' || profile === null || Array.isArray(profile)))
      return 'profile must be an object when provided.';
    if (todayData !== undefined && (typeof todayData !== 'object' || todayData === null || Array.isArray(todayData)))
      return 'todayData must be an object when provided.';
    return null;
  }

  app.post('/api/coach', async (req, res) => {
    const started = Date.now();
    const bad = validateCoachBody(req.body);
    if (bad) {
      log('POST', '/api/coach', 400, started, {});
      return res.status(400).json({ error: bad });
    }
    const { question, profile, todayData } = req.body;
    try {
      const result = await coachAnswer({ question: question.trim(), profile, todayData }, env);
      log('POST', '/api/coach', 200, started, { qlen: question.length, mock: !!result.mock });
      return res.json(result);
    } catch (err) {
      return clientError(res, 'POST', '/api/coach', started, err, { qlen: question.length });
    }
  });

  const maxUploadMb = parseInt(env.MAX_UPLOAD_MB || '12', 10);
  const upload = multer({
    storage: multer.memoryStorage(), // never persisted to disk
    limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
      const err = new Error('Only JPEG, PNG, or WEBP images are accepted.');
      err.code = 'INVALID_FILE_TYPE';
      return cb(err);
    },
  });

  app.post('/analyze-food', (req, res) => {
    const started = Date.now();
    upload.single('photo')(req, res, async (err) => {
      if (err) {
        let status = 400;
        let message = 'Could not read the uploaded image.';
        if (err.code === 'LIMIT_FILE_SIZE') {
          status = 413;
          message = `Image is too large (max ${maxUploadMb} MB).`;
        } else if (err.code === 'INVALID_FILE_TYPE') {
          message = err.message;
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          message = 'Upload a single image in the "photo" field.';
        }
        log('POST', '/analyze-food', status, started, {});
        return res.status(status).json({ error: message });
      }
      if (!req.file) {
        log('POST', '/analyze-food', 400, started, {});
        return res.status(400).json({ error: 'No image uploaded. Attach a photo in the "photo" field.' });
      }
      try {
        const items = await analyzeFoodImage(req.file.buffer, req.file.mimetype, env);
        log('POST', '/analyze-food', 200, started, {
          bytes: req.file.size,
          items: items.length,
          mock: items.some((i) => i.mock),
        });
        return res.json(items);
      } catch (e) {
        return clientError(res, 'POST', '/analyze-food', started, e, { bytes: req.file.size });
      }
    });
  });

  // ---- 404 + error handlers ------------------------------------------------------
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'Request body too large (max 100kb).' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    console.error('unexpected error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Something went wrong. Please try again later.' });
  });

  return app;
}

module.exports = { createApp, VERSION };
