const db = require('../db');

async function checkIsOrgAdmin(userId) {
  const { rows } = await db.query(
    `SELECT 1 FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND r.code = 'org_admin'
       AND (ur.valid_to IS NULL OR ur.valid_to > now())
       AND ur.valid_from <= now()
     LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

// Short-lived cache so permission checks can re-derive org-admin status from the
// DB (authoritative) without a query per request. Fixes stale JWT `is_org_admin`
// claims (e.g. an account promoted to org admin after its token was issued).
const _orgAdminMemo = new Map(); // userId → { at, val }
const ORG_ADMIN_TTL_MS = 60 * 1000;

async function isOrgAdminCached(userId) {
  if (!userId) return false;
  const cached = _orgAdminMemo.get(userId);
  if (cached && Date.now() - cached.at < ORG_ADMIN_TTL_MS) return cached.val;
  const val = await checkIsOrgAdmin(userId);
  _orgAdminMemo.set(userId, { at: Date.now(), val });
  return val;
}

async function getAvailableClinics(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT clinic_id FROM user_roles
     WHERE user_id = $1 AND clinic_id IS NOT NULL
       AND (valid_to IS NULL OR valid_to > now())
       AND valid_from <= now()`,
    [userId]
  );
  return rows.map(r => r.clinic_id);
}

module.exports = { checkIsOrgAdmin, isOrgAdminCached, getAvailableClinics };
