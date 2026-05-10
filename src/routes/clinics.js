const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate  = require('../middleware/authenticate');
const validate      = require('../middleware/validate');
const tenantScope   = require('../rbac/tenant-scope.middleware');
const auditMw       = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P             = require('../rbac/permissions.constants');

const router = express.Router();

const authChain = [authenticate, tenantScope, auditMw];

// ── Validation schemas ────────────────────────────────────────────────────────

const createSchema = Joi.object({
  name:    Joi.string().required(),
  phone:   Joi.string().required(),
  email:   Joi.string().email().required(),
  address: Joi.string().required(),
  city:    Joi.string().required(),
  state:   Joi.string().optional().allow(''),
});

const updateSchema = Joi.object({
  name:      Joi.string().optional(),
  phone:     Joi.string().optional(),
  email:     Joi.string().email().optional(),
  address:   Joi.string().optional(),
  city:      Joi.string().optional(),
  state:     Joi.string().optional().allow(''),
  is_active: Joi.boolean().optional(),
});

// ── GET / — list all clinics in org ──────────────────────────────────────────

router.get('/', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId = req.user.org_id;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { rows } = await db.query(
      `SELECT id, name, phone, email, address, city, state, is_active, created_at
       FROM clinics
       WHERE org_id = $1
       ORDER BY created_at ASC`,
      [orgId]
    );
    res.json({ clinics: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST / — create a new clinic in org ──────────────────────────────────────

router.post('/', ...authChain, requirePermission(P.ORG_MANAGE), validate(createSchema), async (req, res, next) => {
  try {
    const orgId = req.user.org_id;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { name, phone, email, address, city, state } = req.body;

    const { rows } = await db.query(
      `INSERT INTO clinics (org_id, name, phone, email, address, city, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, phone, email, address, city, state, is_active, created_at`,
      [orgId, name, phone, email, address, city, state || null]
    );
    res.status(201).json({ clinic: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id — update clinic details ───────────────────────────────────────

router.patch('/:id', ...authChain, requirePermission(P.ORG_MANAGE), validate(updateSchema), async (req, res, next) => {
  try {
    const orgId    = req.user.org_id;
    const clinicId = req.params.id;

    // Only allow touching clinics within the same org
    const existing = await db.query(
      `SELECT id FROM clinics WHERE id = $1 AND org_id = $2`,
      [clinicId, orgId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Clinic not found' });

    const fields = ['name', 'phone', 'email', 'address', 'city', 'state', 'is_active'];
    const updates = [];
    const values  = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        values.push(req.body[f]);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(clinicId);
    const { rows } = await db.query(
      `UPDATE clinics SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING id, name, phone, email, address, city, state, is_active, created_at`,
      values
    );
    res.json({ clinic: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id/users — list users & roles for a specific clinic ─────────────────

router.get('/:id/users', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId    = req.user.org_id;
    const clinicId = req.params.id;

    const check = await db.query(
      `SELECT id FROM clinics WHERE id = $1 AND org_id = $2`,
      [clinicId, orgId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Clinic not found' });

    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.designation,
              u.role AS legacy_role, u.is_active,
              r.id   AS role_id,
              r.code AS role_code,
              r.name AS role_name
       FROM users u
       LEFT JOIN user_roles ur
              ON ur.user_id = u.id
             AND ur.clinic_id = $1
             AND (ur.valid_to IS NULL OR ur.valid_to > now())
             AND ur.valid_from <= now()
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.clinic_id = $1
       ORDER BY u.first_name, u.last_name`,
      [clinicId]
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// ── PUT /:id/users/:userId/role — assign role for a user in a specific clinic ─

router.put('/:id/users/:userId/role', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId    = req.user.org_id;
    const clinicId = req.params.id;
    const userId   = req.params.userId;
    const { roleId, roleCode } = req.body;

    if (!roleId || !roleCode) {
      return res.status(400).json({ error: 'roleId and roleCode are required' });
    }

    const check = await db.query(
      `SELECT id FROM clinics WHERE id = $1 AND org_id = $2`,
      [clinicId, orgId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Clinic not found' });

    // Expire existing active roles
    await db.query(
      `UPDATE user_roles SET valid_to = now()
       WHERE user_id = $1 AND clinic_id = $2 AND (valid_to IS NULL OR valid_to > now())`,
      [userId, clinicId]
    );

    await db.query(
      `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [userId, roleId, clinicId, req.user.sub]
    );

    const legacyMap = { org_admin: 'admin', clinic_admin: 'admin', doctor: 'doctor', reception: 'receptionist' };
    const legacyRole = legacyMap[roleCode] ?? 'receptionist';
    await db.query(
      `UPDATE users SET role = $1 WHERE id = $2 AND clinic_id = $3`,
      [legacyRole, userId, clinicId]
    );

    const { bumpVersion } = require('../rbac/permission.cache');
    await bumpVersion(userId);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
