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
const { getPresignedUrl } = require('../services/s3Service');

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

const transferSchema = Joi.object({
  clinic_id: Joi.string().uuid().required(),
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

// List active clinics in the requester's org — populates the "Transfer to clinic" dialog.
router.get('/clinics', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, city, address, logo_s3_key FROM clinics
        WHERE org_id = $1 AND is_active = true
        ORDER BY name`,
      [req.context.orgId]
    );
    const clinics = await Promise.all(rows.map(async (c) => ({
      id: c.id, name: c.name, city: c.city, address: c.address,
      logo_url: c.logo_s3_key
        ? await getPresignedUrl({ key: c.logo_s3_key, expiresIn: 900, responseCacheControl: 'private, max-age=900' })
        : null,
    })));
    res.json({ clinics });
  } catch (err) {
    next(err);
  }
});

// Assign / transfer a user to another clinic in the same org.
// Gated by staff.manage (held only by org_admin & clinic_admin).
router.post('/:id/transfer-clinic', validate(transferSchema), async (req, res, next) => {
  const orgId = req.context.orgId;
  const { clinic_id } = req.body;
  try {
    const u = await db.query(
      `SELECT id, clinic_id FROM users WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (!u.rows.length) return res.status(404).json({ error: 'User not found in your organization' });
    const oldClinic = u.rows[0].clinic_id;

    const c = await db.query(
      `SELECT id, name FROM clinics WHERE id = $1 AND org_id = $2 AND is_active = true`,
      [clinic_id, orgId]
    );
    if (!c.rows.length) return res.status(400).json({ error: 'Target clinic is not in your organization' });
    if (oldClinic === clinic_id) return res.status(409).json({ error: 'User is already assigned to that clinic' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET clinic_id = $1, branch_id = $1 WHERE id = $2`,
        [clinic_id, req.params.id]
      );
      // Move the user's active role grants to the new clinic so their access follows them.
      await client.query(
        `UPDATE user_roles SET clinic_id = $1
          WHERE user_id = $2 AND clinic_id = $3 AND (valid_to IS NULL OR valid_to > now())`,
        [clinic_id, req.params.id, oldClinic]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await bumpVersion(req.params.id); // invalidate cached permissions for the moved user

    const { rows } = await db.query(`SELECT ${SAFE_COLS} FROM users WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, user: { ...rows[0], clinic_name: c.rows[0].name } });
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
      // The users-table AFTER INSERT trigger may have already seeded this row
      // based on the legacy `role` column; the unique partial index ensures we
      // don't end up with duplicates.
      await db.query(
        `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
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
