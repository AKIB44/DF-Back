const db    = require('../db');
const cache = require('./permission.cache');

async function resolvePermissions(userId, clinicId) {
  // Cache key uses 'org' as a sentinel when no clinic is active. Without this,
  // org-admin sessions (which have no active clinic) used to short-circuit to
  // {} and miss every role-based permission their role granted them.
  const cacheKey = clinicId || 'org';
  const cached = await cache.get(userId, cacheKey);
  if (cached) return cached;

  // Role-based permissions.
  //
  // With a clinicId: roles assigned to that clinic OR org-wide roles (clinic_id IS NULL).
  // Without a clinicId (org-admin viewing org dashboard): only org-wide roles.
  const { rows: rolePerms } = clinicId
    ? await db.query(
        `SELECT rp.permission_code AS code, rp.scope
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1
           AND (ur.clinic_id = $2 OR ur.clinic_id IS NULL)
           AND (ur.valid_to IS NULL OR ur.valid_to > now())
           AND ur.valid_from <= now()`,
        [userId, clinicId]
      )
    : await db.query(
        `SELECT rp.permission_code AS code, rp.scope
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1
           AND ur.clinic_id IS NULL
           AND (ur.valid_to IS NULL OR ur.valid_to > now())
           AND ur.valid_from <= now()`,
        [userId]
      );

  // Per-user overrides — same clinic / org-wide split.
  const { rows: overrides } = clinicId
    ? await db.query(
        `SELECT permission_code AS code, effect, scope
         FROM permission_overrides
         WHERE user_id = $1
           AND (clinic_id = $2 OR clinic_id IS NULL)
           AND (valid_to IS NULL OR valid_to > now())
           AND valid_from <= now()`,
        [userId, clinicId]
      )
    : await db.query(
        `SELECT permission_code AS code, effect, scope
         FROM permission_overrides
         WHERE user_id = $1
           AND clinic_id IS NULL
           AND (valid_to IS NULL OR valid_to > now())
           AND valid_from <= now()`,
        [userId]
      );

  const perms = new Map();
  for (const r of rolePerms) perms.set(r.code, { scope: r.scope });
  for (const o of overrides) {
    if (o.effect === 'deny') perms.delete(o.code);
    else perms.set(o.code, { scope: o.scope });
  }

  const result = Object.fromEntries(perms);
  await cache.set(userId, cacheKey, result);
  return result;
}

module.exports = { resolvePermissions };
