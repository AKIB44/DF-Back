const express  = require('express');
const bcrypt   = require('bcryptjs');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { bumpVersion } = require('../rbac/permission.cache');

const router = express.Router();

const SAFE_COLS = 'id, clinic_id, first_name, last_name, email, role, designation, is_active, created_at';

const createSchema = Joi.object({
  first_name:  Joi.string().required(),
  last_name:   Joi.string().optional().default(''),
  email:       Joi.string().email().required(),
  role:        Joi.string().valid('admin', 'doctor', 'receptionist').required(),
  designation: Joi.string().max(100).optional().allow(''),
  password:    Joi.string().min(8).required(),
  is_active:   Joi.boolean().optional(),
});

const updateSchema = Joi.object({
  first_name:  Joi.string().optional(),
  last_name:   Joi.string().optional(),
  email:       Joi.string().trim().email().optional(),
  role:        Joi.string().valid('admin', 'doctor', 'receptionist').optional(),
  designation: Joi.string().max(100).optional().allow(''),
  is_active:  Joi.boolean().optional(),
});

const patchSchema = Joi.object({
  is_active: Joi.boolean().required(),
});

router.use(authenticate, tenantScope, auditMw, requirePermission(P.STAFF_MANAGE));

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT ${SAFE_COLS} FROM users WHERE clinic_id = $1 ORDER BY created_at ASC`,
      [req.user.clinic_id]
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

const ROLE_MAP = { admin: 'clinic_admin', doctor: 'doctor', receptionist: 'reception' };

router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const { first_name, last_name, email, role, designation, password } = req.body;

    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO users (org_id, clinic_id, first_name, last_name, email, password_hash, role, designation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${SAFE_COLS}`,
      [req.context.orgId, req.user.clinic_id, first_name, last_name || '', email, password_hash, role, designation || null]
    );

    const newUser = result.rows[0];
    const rbacCode = ROLE_MAP[role] || 'reception';
    const roleRow = await db.query(`SELECT id FROM roles WHERE code=$1 AND is_system=true`, [rbacCode]);
    if (roleRow.rows.length) {
      await db.query(
        `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by) VALUES ($1,$2,$3,$4)`,
        [newUser.id, roleRow.rows[0].id, req.user.clinic_id, req.user.sub]
      );
    }

    res.status(201).json({ user: newUser });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(updateSchema), async (req, res, next) => {
  try {
    const { first_name, last_name, role, is_active } = req.body;

    // Protect org admins — their role can only be changed via org-level RBAC management
    if (role !== undefined) {
      const { rows: orgAdminCheck } = await db.query(
        `SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND r.code = 'org_admin'
           AND (ur.valid_to IS NULL OR ur.valid_to > now()) LIMIT 1`,
        [req.params.id]
      );
      if (orgAdminCheck.length) {
        return res.status(403).json({ error: 'Cannot change role of an org admin via clinic staff management.' });
      }
    }
    const email =
      req.body.email === undefined
        ? undefined
        : String(req.body.email).trim().toLowerCase();

    if (email !== undefined) {
      const dup = await db.query(
        `SELECT id FROM users WHERE lower(trim(email)) = $1 AND id <> $2`,
        [email, req.params.id]
      );
      if (dup.rows.length) {
        return res.status(409).json({ error: 'Email already in use' });
      }
    }

    const { designation } = req.body;
    const result = await db.query(
      `UPDATE users SET
         first_name  = COALESCE($1, first_name),
         last_name   = COALESCE($2, last_name),
         email       = COALESCE($3, email),
         role        = COALESCE($4, role),
         is_active   = COALESCE($5, is_active),
         designation = COALESCE($6, designation)
       WHERE id=$7 AND clinic_id=$8
       RETURNING ${SAFE_COLS}`,
      [first_name, last_name, email, role, is_active, designation, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });

    if (role !== undefined) {
      const rbacCode = ROLE_MAP[role] || 'reception';
      const roleRow = await db.query(`SELECT id FROM roles WHERE code=$1 AND is_system=true`, [rbacCode]);
      if (roleRow.rows.length) {
        await db.query(
          `UPDATE user_roles SET valid_to=now() WHERE user_id=$1 AND clinic_id=$2 AND (valid_to IS NULL OR valid_to > now())`,
          [req.params.id, req.user.clinic_id]
        );
        await db.query(
          `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by) VALUES ($1,$2,$3,$4)`,
          [req.params.id, roleRow.rows[0].id, req.user.clinic_id, req.user.sub]
        );
        await bumpVersion(req.params.id);
      }
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user.sub) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await db.query(
      `UPDATE users SET is_active=false WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    await db.query(
      `UPDATE user_roles SET valid_to=now() WHERE user_id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    await bumpVersion(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', validate(patchSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_active=$1 WHERE id=$2 AND clinic_id=$3 RETURNING ${SAFE_COLS}`,
      [req.body.is_active, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
