const express             = require('express');
const db                  = require('../db');
const authenticate        = require('../middleware/authenticate');
const tenantScope         = require('../rbac/tenant-scope.middleware');
const auditMw             = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                   = require('../rbac/permissions.constants');
const { bumpVersion }     = require('../rbac/permission.cache');
const { resolvePermissions } = require('../rbac/permission.resolver');

const router = express.Router();

router.use(authenticate, tenantScope, auditMw, requirePermission(P.STAFF_MANAGE));

// ── 1. List system roles ─────────────────────────────────────────────────────
router.get('/roles', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, code, name FROM roles WHERE is_system = true ORDER BY name`
    );
    res.json({ roles: rows });
  } catch (err) {
    next(err);
  }
});

// ── 2. List clinic users with their active RBAC role + override count ────────
router.get('/users', async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.designation,
              u.role AS legacy_role, u.is_active,
              r.id   AS role_id,
              r.code AS role_code,
              r.name AS role_name,
              (SELECT COUNT(*)
               FROM permission_overrides po
               WHERE po.user_id = u.id
                 AND (po.clinic_id = u.clinic_id OR po.clinic_id IS NULL)
                 AND (po.valid_to IS NULL OR po.valid_to > now())
              ) AS override_count
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

// ── 3. Assign role to user ───────────────────────────────────────────────────
router.put('/users/:id/role', async (req, res, next) => {
  try {
    const clinicId  = req.user.clinic_id;
    const grantedBy = req.user.id;
    const userId    = req.params.id;
    const { roleId, roleCode } = req.body;

    if (!roleId || !roleCode) {
      return res.status(400).json({ error: 'roleId and roleCode are required' });
    }

    // Expire existing active roles for this user in this clinic
    await db.query(
      `UPDATE user_roles
       SET valid_to = now()
       WHERE user_id = $1 AND clinic_id = $2 AND (valid_to IS NULL OR valid_to > now())`,
      [userId, clinicId]
    );

    // Insert new role assignment
    await db.query(
      `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [userId, roleId, clinicId, grantedBy]
    );

    // Map roleCode to legacy role
    const legacyMap = {
      clinic_admin: 'admin',
      doctor:       'doctor',
      reception:    'receptionist',
    };
    const legacyRole = legacyMap[roleCode] ?? 'receptionist';

    // Update legacy role column
    await db.query(
      `UPDATE users SET role = $1 WHERE id = $2 AND clinic_id = $3`,
      [legacyRole, userId, clinicId]
    );

    // Invalidate permission cache for this user
    await bumpVersion(userId);

    // Return updated user
    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role AS legacy_role, u.is_active,
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
       WHERE u.id = $2 AND u.clinic_id = $1`,
      [clinicId, userId]
    );

    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── 4. Get effective permissions for a user ──────────────────────────────────
router.get('/users/:id/permissions', async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const userId   = req.params.id;

    // Resolve effective permissions (role-based + overrides applied)
    const effective = await resolvePermissions(userId, clinicId);

    // Get all permission overrides for this user
    const { rows: overrides } = await db.query(
      `SELECT id, permission_code, effect, scope, reason
       FROM permission_overrides
       WHERE user_id = $1
         AND (clinic_id = $2 OR clinic_id IS NULL)
         AND (valid_to IS NULL OR valid_to > now())
       ORDER BY permission_code`,
      [userId, clinicId]
    );

    // Get all defined permissions
    const { rows: allPermissions } = await db.query(
      `SELECT code, module, action, description, is_sensitive
       FROM permissions
       ORDER BY module, action`
    );

    res.json({ effective, overrides, allPermissions });
  } catch (err) {
    next(err);
  }
});

// ── 5. List permission overrides for a user ──────────────────────────────────
router.get('/users/:id/overrides', async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const userId   = req.params.id;

    const { rows } = await db.query(
      `SELECT *
       FROM permission_overrides
       WHERE user_id = $1
         AND (clinic_id = $2 OR clinic_id IS NULL)
         AND (valid_to IS NULL OR valid_to > now())
       ORDER BY permission_code`,
      [userId, clinicId]
    );

    res.json({ overrides: rows });
  } catch (err) {
    next(err);
  }
});

// ── 6. Set (upsert) a permission override ────────────────────────────────────
router.post('/users/:id/overrides', async (req, res, next) => {
  try {
    const clinicId  = req.user.clinic_id;
    const grantedBy = req.user.id;
    const userId    = req.params.id;
    const { permissionCode, effect, reason } = req.body;

    if (!permissionCode || !effect) {
      return res.status(400).json({ error: 'permissionCode and effect are required' });
    }
    if (!['allow', 'deny'].includes(effect)) {
      return res.status(400).json({ error: 'effect must be "allow" or "deny"' });
    }

    // Remove any existing override for same user+clinic+permission
    await db.query(
      `DELETE FROM permission_overrides
       WHERE user_id = $1 AND clinic_id = $2 AND permission_code = $3`,
      [userId, clinicId, permissionCode]
    );

    // Insert new override
    const { rows } = await db.query(
      `INSERT INTO permission_overrides
         (user_id, clinic_id, permission_code, effect, scope, reason, granted_by)
       VALUES ($1, $2, $3, $4, 'clinic', $5, $6)
       RETURNING *`,
      [userId, clinicId, permissionCode, effect, reason ?? null, grantedBy]
    );

    await bumpVersion(userId);

    res.status(201).json({ override: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── 7. Delete a specific permission override ─────────────────────────────────
router.delete('/users/:id/overrides/:overrideId', async (req, res, next) => {
  try {
    const clinicId  = req.user.clinic_id;
    const userId    = req.params.id;
    const overrideId = req.params.overrideId;

    const { rowCount } = await db.query(
      `DELETE FROM permission_overrides
       WHERE id = $1 AND user_id = $2 AND clinic_id = $3`,
      [overrideId, userId, clinicId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Override not found' });
    }

    await bumpVersion(userId);

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
