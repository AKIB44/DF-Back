const rateLimit = require('express-rate-limit');

const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAVERSAL_RE = /(\.\.[/\\]|%2e%2e[/\\%])/i;
const NULL_BYTE_RE = /%00|\x00/;

const REQUEST_TIMEOUT_MS = 30_000; // 30 s

/**
 * Blocks HTTP method override headers — prevents attackers from tunnelling
 * DELETE/PUT through POST by setting X-HTTP-Method-Override or similar.
 */
function blockMethodOverride(req, res, next) {
  if (
    req.headers['x-http-method-override'] ||
    req.headers['x-method-override'] ||
    req.headers['x-http-method']
  ) {
    return res.status(400).json({ error: 'Method override headers are not allowed.' });
  }
  next();
}

/**
 * Blocks path traversal and null-byte injection in the raw URL.
 */
function blockPathTraversal(req, res, next) {
  if (TRAVERSAL_RE.test(req.originalUrl)) {
    return res.status(400).json({ error: 'Invalid request path.' });
  }
  if (NULL_BYTE_RE.test(req.originalUrl)) {
    return res.status(400).json({ error: 'Invalid request path.' });
  }
  next();
}

/**
 * Flattens duplicate query parameters into the last value so routes always
 * receive a scalar string rather than an array.
 * e.g. ?status=active&status=done → { status: 'done' }
 */
function flattenQueryParams(req, res, next) {
  for (const key of Object.keys(req.query)) {
    if (Array.isArray(req.query[key])) {
      req.query[key] = req.query[key][req.query[key].length - 1];
    }
  }
  next();
}

/**
 * Validates that any :id route parameter is a valid UUID before the handler
 * runs. Returns 400 instead of letting a malformed value reach the database.
 */
function validateUuidParams(req, res, next) {
  for (const [key, val] of Object.entries(req.params)) {
    if (key === 'id' || key.endsWith('_id') || key.endsWith('Id')) {
      if (val && !UUID_RE.test(val)) {
        return res.status(400).json({ error: `Invalid ${key} format.` });
      }
    }
  }
  next();
}

/**
 * Rejects POST / PUT / PATCH requests that don't declare application/json.
 * Prevents form-data, text, or XML payloads from reaching route handlers.
 */
function enforceJsonContentType(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json.' });
    }
  }
  next();
}

/**
 * Kills requests that haven't completed within REQUEST_TIMEOUT_MS.
 * Protects against slow-loris and runaway DB queries tying up the event loop.
 */
function requestTimeout(req, res, next) {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timed out.' });
    }
  }, REQUEST_TIMEOUT_MS);

  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
}

/**
 * Per-user rate limiter for authenticated API endpoints.
 * Falls back to IP when no user token is present (should not happen on auth'd routes).
 * 120 requests / minute — well above normal interactive use, blocks scripted abuse.
 */
const perUserLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       120,
  keyGenerator: (req) => req.user?.sub || req.ip,
  standardHeaders: true,
  legacyHeaders:   false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = {
  blockMethodOverride,
  blockPathTraversal,
  flattenQueryParams,
  validateUuidParams,
  enforceJsonContentType,
  requestTimeout,
  perUserLimiter,
};
