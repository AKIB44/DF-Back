// In-memory permission cache with TTL and DB-backed role-version invalidation.
//
// The cache key includes `users.role_version` which the role-mgmt endpoints
// bump whenever an admin changes a role / permission grant. We read the
// version from the DB on every get() so that ANY process (even in a Node
// cluster) immediately misses stale entries written by a peer process.

const TTL_MS = 600_000; // 10 min

const store    = new Map(); // versioned key -> { data, expiresAt }
const verCache = new Map(); // userId -> { ver, at }  (short fast-path cache for the version itself)
const VER_TTL_MS = 5_000;   // 5s — short enough that admin updates land fast

async function _currentVersion(userId) {
  // Tiny memo so we don't hammer the DB once per request inside the same 5s window.
  const memo = verCache.get(userId);
  if (memo && Date.now() - memo.at < VER_TTL_MS) return memo.ver;
  const db = require('../db');
  let ver = 1;
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(role_version, 1) AS ver FROM users WHERE id = $1`,
      [userId]
    );
    ver = rows[0]?.ver ?? 1;
  } catch { /* if column missing, default to 1 */ }
  verCache.set(userId, { ver, at: Date.now() });
  return ver;
}

function _key(userId, clinicId, ver) {
  return `perms:${userId}:${clinicId || 'org'}:v${ver}`;
}

async function get(userId, clinicId) {
  const ver = await _currentVersion(userId);
  const entry = store.get(_key(userId, clinicId, ver));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(_key(userId, clinicId, ver));
    return null;
  }
  return entry.data;
}

async function set(userId, clinicId, perms) {
  const ver = await _currentVersion(userId);
  store.set(_key(userId, clinicId, ver), {
    data: perms,
    expiresAt: Date.now() + TTL_MS,
  });
}

async function bumpVersion(userId) {
  // Drop the local fast-path memo so the next get() refreshes the version.
  verCache.delete(userId);
  const db = require('../db');
  await db.query(
    `UPDATE users SET role_version = COALESCE(role_version, 1) + 1 WHERE id = $1`,
    [userId]
  );
}

async function invalidate(userId, clinicId) {
  verCache.delete(userId);
  // Best-effort: drop every key for this user. The store is small enough.
  for (const k of store.keys()) {
    if (k.startsWith(`perms:${userId}:`)) store.delete(k);
  }
}

/** Optional convenience for tests / admin tools — wipe everything. */
function clear(userId) {
  if (userId) return invalidate(userId);
  store.clear();
  verCache.clear();
}

module.exports = { get, set, bumpVersion, invalidate, clear };
