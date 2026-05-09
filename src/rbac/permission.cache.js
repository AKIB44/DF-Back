// In-memory permission cache with TTL and role-version invalidation.
// Interface matches a Redis-backed implementation for easy swapping.

const TTL_MS = 600_000; // 10 min

const store = new Map(); // key -> { data, expiresAt }
const versions = new Map(); // userId -> version number

function _key(userId, clinicId, ver) {
  return `perms:${userId}:${clinicId}:v${ver}`;
}

async function get(userId, clinicId) {
  const ver = versions.get(userId);
  if (!ver) return null;
  const entry = store.get(_key(userId, clinicId, ver));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(_key(userId, clinicId, ver));
    return null;
  }
  return entry.data;
}

async function set(userId, clinicId, perms) {
  const ver = versions.get(userId) ?? 1;
  versions.set(userId, ver);
  store.set(_key(userId, clinicId, ver), {
    data: perms,
    expiresAt: Date.now() + TTL_MS,
  });
}

async function bumpVersion(userId) {
  const cur = versions.get(userId) ?? 1;
  versions.set(userId, cur + 1);
  // Also bump role_version in DB
  const db = require('../db');
  await db.query(`UPDATE users SET role_version = role_version + 1 WHERE id = $1`, [userId]);
}

async function invalidate(userId, clinicId) {
  const ver = versions.get(userId);
  if (ver) store.delete(_key(userId, clinicId, ver));
}

module.exports = { get, set, bumpVersion, invalidate };
