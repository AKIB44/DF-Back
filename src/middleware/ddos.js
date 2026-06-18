/**
 * DDoS guard — three coordinated layers:
 *
 * 1. IP ban list    – after accumulating BAN_STRIKES rate-limit violations an IP
 *                     is banned for BAN_TTL_MS; banned IPs get 429 immediately
 *                     without touching any route handler or database.
 *
 * 2. Burst detector – a sliding-window counter per IP; if more than BURST_MAX
 *                     requests arrive within BURST_WINDOW_MS the IP is banned
 *                     on the spot regardless of per-window limits.
 *
 * 3. Suspicious-path detector – immediately bans IPs probing paths that no
 *                     legitimate client ever requests (wp-admin, .env, xmlrpc,
 *                     shell/exploit paths).  One hit = strike; SCAN_BAN_STRIKES
 *                     hits = ban.
 *
 * All stores are in-process Maps; they reset on restart. For multi-process /
 * clustered deployments replace with Redis counters.
 */

const { verifyAccess } = require('../auth/jwt.service');

const BAN_TTL_MS        = 60 * 60 * 1000;  // 1 hour ban
const BAN_STRIKES       = 5;               // rate-limit violations before ban
const BURST_WINDOW_MS   = 5_000;           // 5 s sliding window
const BURST_MAX         = 60;              // max requests in that window
const SCAN_BAN_STRIKES  = 3;               // malicious path hits before ban

// Map<ip, { until: number, strikes: number }>
const banStore = new Map();
// Map<ip, { count: number, windowStart: number, strikes: number }>
const burstStore = new Map();
// Map<ip, { hits: number }>
const scanStore  = new Map();

// Paths that no legitimate client of this API will ever request.
const SCAN_PATHS = [
  /\/wp-admin/i, /\/wp-login/i, /xmlrpc\.php/i,
  /\.env$/i, /\.git\//i, /\.DS_Store/i,
  /\/etc\/passwd/i, /\/etc\/shadow/i,
  /\/shell/i, /\/cmd/i, /\/exec/i,
  /phpmyadmin/i, /adminer/i, /manager\/html/i,
  /\/config\.(yml|yaml|json|php)/i,
  /\/backup/i, /\/dump/i,
  /\/(eval|base64_decode|system|passthru)\s*\(/i,
];

function getIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Org/platform admins with a valid Bearer token bypass all DDoS layers. */
function isDdosExempt(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  try {
    const payload = verifyAccess(header.slice(7));
    return payload.is_org_admin === true || payload.type === 'platform_admin';
  } catch {
    return false;
  }
}

function isBanned(ip) {
  const entry = banStore.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    banStore.delete(ip);
    return false;
  }
  return true;
}

function ban(ip) {
  const existing = banStore.get(ip);
  banStore.set(ip, {
    until:   Date.now() + BAN_TTL_MS,
    strikes: (existing?.strikes ?? 0) + 1,
  });
  console.warn(`[ddos] IP banned: ${ip} (strikes: ${banStore.get(ip).strikes})`);
}

/**
 * Called by the express-rate-limit handler option when a limit is hit.
 * Records a strike against the IP; bans it once BAN_STRIKES is reached.
 */
function recordRateLimitViolation(req) {
  if (isDdosExempt(req)) return;
  const ip = getIp(req);
  const entry = burstStore.get(ip) ?? { count: 0, windowStart: Date.now(), strikes: 0 };
  entry.strikes = (entry.strikes ?? 0) + 1;
  burstStore.set(ip, entry);
  if (entry.strikes >= BAN_STRIKES) {
    ban(ip);
  }
}

/**
 * Main guard middleware — must be placed before all routes.
 * Enforces ban list, burst detection, and scan/probe detection.
 */
function ddosGuard(req, res, next) {
  if (isDdosExempt(req)) return next();

  const ip = getIp(req);

  // ── 1. Ban list check ───────────────────────────────────────────────────────
  if (isBanned(ip)) {
    res.set('Retry-After', String(Math.ceil(BAN_TTL_MS / 1000)));
    return res.status(429).json({ error: 'Too many requests. You have been temporarily blocked.' });
  }

  // ── 2. Burst detection ──────────────────────────────────────────────────────
  const now   = Date.now();
  const burst = burstStore.get(ip) ?? { count: 0, windowStart: now, strikes: 0 };

  if (now - burst.windowStart > BURST_WINDOW_MS) {
    burst.count       = 1;
    burst.windowStart = now;
  } else {
    burst.count += 1;
  }
  burstStore.set(ip, burst);

  if (burst.count > BURST_MAX) {
    ban(ip);
    res.set('Retry-After', String(Math.ceil(BAN_TTL_MS / 1000)));
    return res.status(429).json({ error: 'Request burst limit exceeded. You have been temporarily blocked.' });
  }

  // ── 3. Suspicious path / scan detection ────────────────────────────────────
  if (SCAN_PATHS.some(re => re.test(req.originalUrl))) {
    const scan = scanStore.get(ip) ?? { hits: 0 };
    scan.hits += 1;
    scanStore.set(ip, scan);
    console.warn(`[ddos] scan probe from ${ip}: ${req.originalUrl} (hit ${scan.hits})`);
    if (scan.hits >= SCAN_BAN_STRIKES) {
      ban(ip);
    }
    return res.status(404).json({ error: 'Not found.' }); // don't leak route info
  }

  next();
}

/**
 * Rate-limit handler for use in express-rate-limit's `handler` option.
 * Records a violation strike and then sends the standard 429.
 */
function rateLimitHandler(req, res) {
  recordRateLimitViolation(req);
  res.set('Retry-After', '900');
  res.status(429).json({ error: 'Too many requests. Please try again later.' });
}

/**
 * Auth-specific rate-limit handler — strikes count double since brute-force
 * against auth endpoints is more damaging than general API abuse.
 */
function authRateLimitHandler(req, res) {
  const ip = getIp(req);
  // Count two strikes for auth endpoint violations
  recordRateLimitViolation(req);
  recordRateLimitViolation(req);
  console.warn(`[ddos] auth brute-force attempt from ${ip}: ${req.originalUrl}`);
  res.set('Retry-After', '900');
  res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });
}

module.exports = { ddosGuard, rateLimitHandler, authRateLimitHandler, isDdosExempt };
