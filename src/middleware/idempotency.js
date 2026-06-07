'use strict';

// Idempotency middleware for mutating /v1 requests.
//
// The web client attaches an `Idempotency-Key` header (a UUID) to every mutating
// request and replays queued ones after reconnecting. If the same key arrives
// twice — because the original response was lost on a flaky link, or because the
// offline queue replays a request that actually reached the server — we return
// the originally-captured response instead of re-running the mutation. That keeps
// offline sync from creating duplicate services / diagnoses / etc.
//
// Keyed purely on the client UUID, so this is safe to mount before route-level
// auth. Requests without the header (or non-mutating, or /auth/*) pass straight
// through.

const db = require('../db');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_MAX_LEN = 200;
const CLEANUP_SAMPLE_RATE = 0.01; // ~1% of eligible requests sweep old keys
const TTL = "24 hours";

function isEligible(req) {
  if (!MUTATING.has(req.method)) return false;
  if (req.path.includes('/auth/')) return false;
  const key = req.get('Idempotency-Key');
  if (!key || key.length > KEY_MAX_LEN) return false;
  return true;
}

function maybeCleanup() {
  if (Math.random() >= CLEANUP_SAMPLE_RATE) return;
  db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '${TTL}'`)
    .catch(() => {}); // best-effort housekeeping
}

async function idempotency(req, res, next) {
  if (!isEligible(req)) return next();

  const key  = req.get('Idempotency-Key');
  const path = req.originalUrl;

  try {
    const { rows } = await db.query(
      `SELECT method, path, status, response_body FROM idempotency_keys WHERE key = $1`,
      [key]
    );
    const prior = rows[0];
    // Replay only when the same key maps to the same method+path and we actually
    // captured a response. A key collision on a different request just proceeds
    // (the later capture is dropped by ON CONFLICT DO NOTHING below).
    if (prior && prior.status != null && prior.method === req.method && prior.path === path) {
      return res.status(prior.status).json(prior.response_body);
    }
  } catch (_) {
    // If the lookup fails, fall through and process the request normally.
    return next();
  }

  // Miss — capture the response, then persist it best-effort after sending.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    // Only memoize successful, idempotent-safe responses (2xx). Errors should be
    // retryable, not cached.
    if (status >= 200 && status < 300) {
      db.query(
        `INSERT INTO idempotency_keys (key, method, path, status, response_body)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [key, req.method, path, status, JSON.stringify(body ?? null)]
      ).catch(() => {}); // capture is best-effort; never break the response
    }
    return originalJson(body);
  };

  maybeCleanup();
  return next();
}

module.exports = idempotency;
