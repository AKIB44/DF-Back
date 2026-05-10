const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate          = require('../middleware/authenticate');
const validate              = require('../middleware/validate');
const tenantScope           = require('../rbac/tenant-scope.middleware');
const auditMw               = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                     = require('../rbac/permissions.constants');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── Validation ────────────────────────────────────────────────────────────────

const updateStaffSchema = Joi.object({
  is_active:   Joi.boolean().optional(),
  designation: Joi.string().max(100).optional(),
  status_rbac: Joi.string().valid('active', 'disabled', 'locked').optional(),
}).min(1);

// ── GET /staff — list all staff in the org ───────────────────────────────────

router.get('/staff', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { search, clinic_id, is_active, limit = '50', offset = '0' } = req.query;

    const conditions = ['u.org_id = $1'];
    const params     = [orgId];

    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(
        `(u.first_name ILIKE $${n} OR u.last_name ILIKE $${n} OR u.email ILIKE $${n} OR u.phone ILIKE $${n})`
      );
    }

    if (clinic_id) {
      params.push(clinic_id);
      conditions.push(`u.clinic_id = $${params.length}`);
    }

    if (is_active === 'true' || is_active === 'false') {
      params.push(is_active === 'true');
      conditions.push(`u.is_active = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    // COUNT query
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       WHERE ${where}`,
      params
    );
    const total = countRows[0].total;

    // Data query (add LIMIT/OFFSET params)
    const limitInt  = Math.max(1, Math.min(200, parseInt(limit)  || 50));
    const offsetInt = Math.max(0,              parseInt(offset) || 0);
    params.push(limitInt, offsetInt);
    const lIdx = params.length - 1;
    const oIdx = params.length;

    const { rows: staff } = await db.query(
      `SELECT
         u.id, u.first_name, u.last_name, u.email, u.phone,
         u.role, u.designation, u.is_active, u.status_rbac,
         u.last_login_at, u.created_at,
         u.clinic_id,
         c.name AS clinic_name,
         (
           SELECT COALESCE(json_agg(json_build_object('name', r.name, 'code', r.code)), '[]'::json)
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id
             AND ur.clinic_id = u.clinic_id
             AND (ur.valid_from IS NULL OR ur.valid_from <= now())
             AND (ur.valid_to   IS NULL OR ur.valid_to   >= now())
         ) AS roles
       FROM users u
       LEFT JOIN clinics c ON c.id = u.clinic_id
       WHERE ${where}
       ORDER BY u.created_at DESC
       LIMIT $${lIdx} OFFSET $${oIdx}`,
      params
    );

    res.json({ staff, total });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /staff/:id — update a staff member ─────────────────────────────────

router.patch('/staff/:id', ...authChain, requirePermission(P.ORG_MANAGE), validate(updateStaffSchema), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { id } = req.params;

    // Verify staff belongs to same org
    const { rows: existing } = await db.query(
      `SELECT id FROM users WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'Staff member not found' });

    const allowed = ['is_active', 'designation', 'status_rbac'];
    const sets    = [];
    const vals    = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        vals.push(req.body[key]);
        sets.push(`${key} = $${vals.length}`);
      }
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, first_name, last_name, email, is_active, designation, status_rbac`,
      vals
    );

    res.json({ ok: true, staff: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
