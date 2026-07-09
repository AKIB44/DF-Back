// ── God view — LIVE in-memory presence (no persistence) ─────────────────────
//
// Nothing is written to the database. Everything below lives in process memory
// and evaporates on restart — this is a real-time monitor, not an audit log.
//
//   - sessions:  one entry per active (user, ip, device); pruned when idle.
//   - activity:  a rolling feed of the most recent actions across all users.
//   - geoCache:  per-IP geo lookups, memoised for the process lifetime.
//
// The capture middleware mounts globally at /v1, decodes the bearer token
// itself (it runs before per-route authenticate), and never blocks the request.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const db = require('../db');
const { verifyAccess } = require('../auth/jwt.service');

const SESSION_IDLE_MS   = 15 * 60 * 1000;  // drop a session after 15m of silence
const ONLINE_MS         = 60 * 1000;       // "online" = active within 60s
const ACTIVITY_MAX      = 400;             // rolling feed cap
const GEO_CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const GEO_TIMEOUT_MS    = 1500;

/** key `${userId}|${ip}|${uaHash}` → live session */
const sessions = new Map();
/** userId → { lat, lng, accuracy, at } — precise browser geolocation (GPS/WiFi) */
const preciseByUser = new Map();
const PRECISE_TTL_MS = 15 * 60 * 1000;

/** userId → { name, email, role } — resolved from DB (JWT doesn't carry these). */
const userCache = new Map();
const userInFlight = new Set();

/** Fetch a user's display fields once; patch any live sessions when they land. */
function lookupUser(userId) {
  if (!userId || userCache.has(userId) || userInFlight.has(userId)) return;
  userInFlight.add(userId);
  db.query(
    `SELECT TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name, email, role
       FROM users WHERE id = $1`,
    [userId]
  ).then(({ rows }) => {
    const u = rows[0];
    if (!u) return;
    const info = { name: (u.name || '').trim() || u.email || 'User', email: u.email || null, role: u.role || null };
    userCache.set(userId, info);
    // Backfill sessions created before the lookup resolved.
    for (const s of sessions.values()) {
      if (s.userId === userId) { s.name = info.name; s.email = info.email; s.role = info.role; }
    }
  }).catch(() => {}).finally(() => userInFlight.delete(userId));
}
/** rolling activity feed, newest last */
const activity = [];
let activitySeq = 0;
/** ip → { at, geo } */
const geoCache = new Map();
const geoInFlight = new Set();

const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function isPrivateIp(ip) {
  if (!ip || ip === 'unknown') return true;
  const v = ip.replace(/^::ffff:/, '');
  return v === '127.0.0.1' || v === '::1' || v.startsWith('10.')
    || v.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(v)
    || v.startsWith('169.254.') || v === 'localhost';
}

function parseUserAgent(ua) {
  if (!ua) return { device: 'Unknown', browser: null, os: null, form: null };
  const s = ua;
  let os = 'Unknown OS';
  if (/Windows NT 10/.test(s)) os = 'Windows 10/11';
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Linux/.test(s)) os = 'Linux';
  let browser = 'Unknown', m;
  if ((m = s.match(/Edg\/(\d+)/)))            browser = `Edge ${m[1]}`;
  else if ((m = s.match(/OPR\/(\d+)/)))       browser = `Opera ${m[1]}`;
  else if ((m = s.match(/Chrome\/(\d+)/)) && !/Edg|OPR/.test(s)) browser = `Chrome ${m[1]}`;
  else if ((m = s.match(/Version\/(\d+).*Safari/))) browser = `Safari ${m[1]}`;
  else if ((m = s.match(/Firefox\/(\d+)/)))   browser = `Firefox ${m[1]}`;
  const form = /Mobile|iPhone|Android.*Mobile/.test(s) ? 'Mobile'
             : /iPad|Tablet/.test(s) ? 'Tablet' : 'Desktop';
  return { device: `${browser} · ${os} · ${form}`, browser, os, form };
}

async function lookupGeo(ip) {
  if (isPrivateIp(ip)) return null;
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) return cached.geo;
  if (geoInFlight.has(ip)) return cached?.geo ?? null;
  geoInFlight.add(ip);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEO_TIMEOUT_MS);
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,lat,lon,isp`;
    const resp = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    const j = await resp.json();
    const geo = j && j.status === 'success'
      ? { country: j.country, region: j.regionName, city: j.city, lat: j.lat, lon: j.lon, isp: j.isp }
      : null;
    geoCache.set(ip, { at: Date.now(), geo });
    return geo;
  } catch {
    geoCache.set(ip, { at: Date.now(), geo: null });
    return null;
  } finally {
    geoInFlight.delete(ip);
  }
}

// Requests that shouldn't appear as "activity" (noise: health, the god-view's
// own polling, static/asset probes).
const NOISE_RX = /^\/v1\/(health|godview)\b/;

function friendlyAction(method, path) {
  const p = path.replace(/^\/v1\//, '');
  const seg = p.split('/');
  const verb = { GET: 'Viewed', POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Removed' }[method] || method;
  const area = (seg[0] || 'app').replace(/-/g, ' ');
  return `${verb} ${area}`;
}

function pushActivity(evt) {
  activity.push(evt);
  if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
}

function record(u, req) {
  const ip     = clientIp(req);
  const ua     = req.headers['user-agent'] || '';
  const uaHash = sha1(ua);
  const key    = `${u.sub}|${ip}|${uaHash}`;
  const path   = (req.originalUrl || req.url || '').split('?')[0];
  const now    = Date.now();
  const { device } = parseUserAgent(ua);

  // The JWT carries only `sub`; name/email/role are resolved from the DB (cached).
  const cached = userCache.get(u.sub);
  const name  = cached?.name
    || [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'User';
  const email = cached?.email ?? u.email ?? null;
  const role  = cached?.role ?? u.role ?? null;
  if (!cached) lookupUser(u.sub);

  let s = sessions.get(key);
  if (!s) {
    s = {
      key, userId: u.sub, name, email, role,
      ip, device, userAgent: ua, geo: null,
      firstSeen: now, lastSeen: now, hits: 0, lastPath: path,
    };
    sessions.set(key, s);
    // Resolve geo once per session, asynchronously.
    lookupGeo(ip).then((geo) => { if (geo) s.geo = geo; }).catch(() => {});
  } else if (cached) {
    // Keep an existing session's identity fresh once the lookup lands.
    s.name = name; s.email = email; s.role = role;
  }
  s.lastSeen = now;
  s.lastPath = path;
  s.hits++;

  if (!NOISE_RX.test(path)) {
    pushActivity({
      id: ++activitySeq,
      at: now,
      userId: u.sub,
      name,
      ip,
      method: req.method,
      path,
      action: friendlyAction(req.method, path),
    });
  }
}

/** Record a user's precise browser geolocation (from navigator.geolocation). */
function recordPrecise(userId, lat, lng, accuracy) {
  if (!userId || typeof lat !== 'number' || typeof lng !== 'number') return;
  preciseByUser.set(userId, { lat, lng, accuracy: accuracy || null, at: Date.now() });
}

function prune() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [k, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(k);
  const pcut = Date.now() - PRECISE_TTL_MS;
  for (const [uid, p] of preciseByUser) if (p.at < pcut) preciseByUser.delete(uid);
}

/**
 * Resolve the geo to show for a session: prefer the user's precise browser
 * location (exact GPS/WiFi coords) when available and fresh, keeping the
 * IP-derived city/region/country/ISP labels. Fall back to IP geo otherwise.
 */
function resolveGeo(s) {
  const p = preciseByUser.get(s.userId);
  if (p && Date.now() - p.at <= PRECISE_TTL_MS) {
    return {
      ...(s.geo || {}),                 // keep city/region/country/isp from IP if known
      lat: p.lat,
      lon: p.lng,                       // precise coords override the IP ones
      accuracy: p.accuracy,
      precise: true,
    };
  }
  return s.geo ? { ...s.geo, precise: false } : null;
}

/** Live snapshot for the god-view UI. */
function snapshot() {
  prune();
  const now = Date.now();
  const sess = [...sessions.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((s) => ({
      userId: s.userId, name: s.name, email: s.email, role: s.role,
      ip: s.ip, device: s.device, geo: resolveGeo(s),
      firstSeen: s.firstSeen, lastSeen: s.lastSeen, hits: s.hits, lastPath: s.lastPath,
      online: now - s.lastSeen <= ONLINE_MS,
    }));
  const feed = activity.slice(-120).reverse(); // newest first, last 120
  return {
    generatedAt: now,
    stats: {
      sessions: sess.length,
      online: sess.filter((s) => s.online).length,
      users: new Set(sess.map((s) => s.userId)).size,
      located: sess.filter((s) => s.geo).length,
    },
    sessions: sess,
    activity: feed,
  };
}

/** Global middleware — captures presence, never blocks. */
function presenceMiddleware(req, res, next) {
  try {
    let u = req.user;
    if (!u) {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        try { u = verifyAccess(header.slice(7)); } catch { u = null; }
      }
    }
    if (u && u.type === 'user' && u.sub) record(u, req);
  } catch { /* presence must never affect the request */ }
  next();
}

module.exports = { presenceMiddleware, snapshot, recordPrecise, parseUserAgent, clientIp, isPrivateIp };
