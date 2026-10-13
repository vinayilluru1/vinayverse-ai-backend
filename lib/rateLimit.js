'use strict';

/**
 * Tiny hand-rolled per-IP sliding-window rate limiter.
 * No dependencies, no persistence — counters live in memory and reset
 * naturally as the window slides. Suitable for a small single-instance proxy.
 */

function rateLimit({ perMin }) {
  const max = Number.isFinite(perMin) && perMin > 0 ? perMin : 30;
  const hits = new Map(); // ip -> number[] of epoch ms

  // Avoid unbounded growth: prune idle entries every 5 minutes.
  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [ip, times] of hits) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length) hits.set(ip, fresh);
      else hits.delete(ip);
    }
  }, 5 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  return function rateLimitMiddleware(req, res, next) {
    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const now = Date.now();
    const cutoff = now - 60000;
    const times = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (times.length >= max) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again in a minute.' });
    }
    times.push(now);
    hits.set(ip, times);
    next();
  };
}

module.exports = { rateLimit };
