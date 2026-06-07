// ────────────────────────────────────────────────────────────────────────────
// Build the policy-engine `subject` from req.user + a cached attribute fetch.
// ────────────────────────────────────────────────────────────────────────────
//
// JWT carries the minimal {id, role, org_id, clinic_id}. The richer ABAC
// attributes (specialty_tags, branch_id, hierarchy_level, max_discount_pct)
// live in `users` / `roles` and are pulled once per
// request, then memoised on req for any subsequent authorize() in the chain.
// ────────────────────────────────────────────────────────────────────────────

const db    = require('../../db');
const cache = require('../../rbac/permission.cache');

const TTL_MS = 5 * 60 * 1000;
const memo   = new Map();        // userId → { at, attrs }

async function loadAttrs(userId) {
  const cached = memo.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.attrs;

  const { rows } = await db.query(
    `SELECT u.id, u.role AS legacy_role, u.specialty_tags, u.branch_id, u.clinic_id,
            u.max_discount_pct,
            COALESCE(MAX(r.hierarchy_level), 30) AS hierarchy_level
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND (ur.valid_to IS NULL OR ur.valid_to > NOW())
       LEFT JOIN roles r       ON r.id = ur.role_id
       WHERE u.id = $1
       GROUP BY u.id`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  const attrs = {
    specialtyTags:   row.specialty_tags || [],
    branchId:        row.branch_id || row.clinic_id || null,
    maxDiscountPct:  Number(row.max_discount_pct ?? 10),
    hierarchyLevel:  Number(row.hierarchy_level || 30),
    legacyRole:      row.legacy_role,
  };
  memo.set(userId, { at: Date.now(), attrs });
  return attrs;
}

async function buildSubject(req) {
  if (req._abacSubject) return req._abacSubject;
  const u = req.user || {};
  const attrs = (await loadAttrs(u.sub || u.id)) || {};
  const subject = {
    id:              u.sub || u.id,
    role:            u.role || attrs.legacyRole,
    specialtyTags:   attrs.specialtyTags || [],
    branchId:        attrs.branchId || u.clinic_id || null,
    hierarchyLevel:  attrs.hierarchyLevel || 30,
    maxDiscountPct:  attrs.maxDiscountPct,
  };
  req._abacSubject = subject;
  return subject;
}

function invalidateSubject(userId) {
  memo.delete(userId);
  if (cache.clear) cache.clear(userId);
  if (cache.bumpVersion) cache.bumpVersion(userId).catch(() => {});
}

module.exports = { buildSubject, invalidateSubject, _memo: memo };
