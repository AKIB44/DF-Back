const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAVERSAL_RE = /(\.\.[/\\]|%2e%2e[/\\%])/i;

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
 * Blocks path traversal sequences in the raw URL before any route matches.
 */
function blockPathTraversal(req, res, next) {
  if (TRAVERSAL_RE.test(req.originalUrl)) {
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

module.exports = { blockMethodOverride, blockPathTraversal, flattenQueryParams, validateUuidParams };
