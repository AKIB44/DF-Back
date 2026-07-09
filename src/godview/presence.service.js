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
const { verifyAccess } = require('../auth/jwt.service');

const SESSION_IDLE_MS   = 15 * 60 * 1000;  // drop a session after 15m of silence
const ONLINE_MS         = 60 * 1000;       // "online" = active within 60s
const ACTIVITY_MAX      = 400;             // rolling feed cap
const GEO_CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const GEO_TIMEOUT_MS    = 1500;

/** key `${userId}|${ip}|${uaHash}` → live session */
const sessions = new Map();
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
  const name   = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'User';
  const { device } = parseUserAgent(ua);

  let s = sessions.get(key);
  if (!s) {
    s = {
      key, userId: u.sub, name, email: u.email || null, role: u.role || null,
      ip, device, userAgent: ua, geo: null,
      firstSeen: now, lastSeen: now, hits: 0, lastPath: path,
    };
    sessions.set(key, s);
    // Resolve geo once per session, asynchronously.
    lookupGeo(ip).then((geo) => { if (geo) s.geo = geo; }).catch(() => {});
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

function prune() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [k, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(k);
}

/** Live snapshot for the god-view UI. */
function snapshot() {
  prune();
  const now = Date.now();
  const sess = [...sessions.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((s) => ({
      userId: s.userId, name: s.name, email: s.email, role: s.role,
      ip: s.ip, device: s.device, geo: s.geo,
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

module.exports = { presenceMiddleware, snapshot, parseUserAgent, clientIp, isPrivateIp };
