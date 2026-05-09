const db    = require('../db');
const cache = require('./permission.cache');

async function resolvePermissions(userId, clinicId) {
  if (!clinicId) return {};

  const cached = await cache.get(userId, clinicId);
  if (cached) return cached;

  // Role-based permissions
  const { rows: rolePerms } = await db.query(
    `SELECT rp.permission_code AS code, rp.scope
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = $1
       AND (ur.clinic_id = $2 OR ur.clinic_id IS NULL)
       AND (ur.valid_to IS NULL OR ur.valid_to > now())
       AND ur.valid_from <= now()`,
    [userId, clinicId]
  );

  // Per-user overrides
  const { rows: overrides } = await db.query(
    `SELECT permission_code AS code, effect, scope
     FROM permission_overrides
     WHERE user_id = $1
       AND (clinic_id = $2 OR clinic_id IS NULL)
       AND (valid_to IS NULL OR valid_to > now())
       AND valid_from <= now()`,
    [userId, clinicId]
  );

  const perms = new Map();
  for (const r of rolePerms) perms.set(r.code, { scope: r.scope });
  for (const o of overrides) {
    if (o.effect === 'deny') perms.delete(o.code);
    else perms.set(o.code, { scope: o.scope });
  }

  const result = Object.fromEntries(perms);
  await cache.set(userId, clinicId, result);
  return result;
}

module.exports = { resolvePermissions };
