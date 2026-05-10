const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate          = require('../middleware/authenticate');
const validate              = require('../middleware/validate');
const tenantScope           = require('../rbac/tenant-scope.middleware');
const auditMw               = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                     = require('../rbac/permissions.constants');
const { bumpVersion }       = require('../rbac/permission.cache');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── Validation schemas ────────────────────────────────────────────────────────

const createRoleSchema = Joi.object({
  name:        Joi.string().required().max(100),
  code:        Joi.string().required().pattern(/^[a-z0-9_]+$/).max(50),
  description: Joi.string().optional().max(255).allow('', null),
});

const updateRoleSchema = Joi.object({
  name:        Joi.string().max(100),
  description: Joi.string().max(255).allow('', null),
}).min(1);

const setPermissionsSchema = Joi.object({
  permissions: Joi.array().items(Joi.string()).required(),
});

// ── GET / — list all roles visible to this org ───────────────────────────────

router.get('/', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { rows } = await db.query(
      `SELECT r.id, r.code, r.name, r.description, r.is_system, r.org_id,
         COALESCE(
           json_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL),
           '[]'::json
         ) AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.is_system = true OR r.org_id = $1
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.name`,
      [orgId]
    );

    res.json({ roles: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST / — create a custom role ────────────────────────────────────────────

router.post('/', ...authChain, requirePermission(P.ORG_MANAGE), validate(createRoleSchema), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { name, code, description } = req.body;

    // Check code uniqueness
    const { rows: existing } = await db.query(
      `SELECT 1 FROM roles WHERE code = $1`,
      [code]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Role code already exists', code: 'code_taken' });
    }

    const { rows } = await db.query(
      `INSERT INTO roles (org_id, code, name, description, is_system)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, org_id, code, name, description, is_system`,
      [orgId, code, name, description || null]
    );

    const role = { ...rows[0], permissions: [] };
    res.status(201).json({ role });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id — update role name/description ─────────────────────────────────

router.patch('/:id', ...authChain, requirePermission(P.ORG_MANAGE), validate(updateRoleSchema), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { id } = req.params;

    // Fetch role — must be custom and belong to this org
    const { rows: existing } = await db.query(
      `SELECT id, is_system FROM roles WHERE id = $1`,
      [id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Role not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'Cannot modify system roles' });

    const { rows: owned } = await db.query(
      `SELECT id FROM roles WHERE id = $1 AND is_system = false AND org_id = $2`,
      [id, orgId]
    );
    if (!owned.length) return res.status(404).json({ error: 'Role not found in this org' });

    const allowed = ['name', 'description'];
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
      `UPDATE roles SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${vals.length}
       RETURNING id, code, name, description, is_system`,
      vals
    );

    res.json({ role: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id — delete a custom role ───────────────────────────────────────

router.delete('/:id', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { id } = req.params;

    // Fetch role
    const { rows: existing } = await db.query(
      `SELECT id, is_system, org_id FROM roles WHERE id = $1`,
      [id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Role not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'Cannot delete system roles' });
    if (existing[0].org_id !== orgId) return res.status(404).json({ error: 'Role not found in this org' });

    // Check if in use
    const { rows: usageRows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM user_roles
       WHERE role_id = $1 AND (valid_to IS NULL OR valid_to > now())`,
      [id]
    );
    if (usageRows[0].count > 0) {
      return res.status(409).json({ error: 'Role is currently assigned to users', code: 'role_in_use' });
    }

    await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
    await db.query(`DELETE FROM roles WHERE id = $1`, [id]);

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ── PUT /:id/permissions — replace full permission set ────────────────────────

router.put('/:id/permissions', ...authChain, requirePermission(P.ORG_MANAGE), validate(setPermissionsSchema), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { id } = req.params;
    const { permissions } = req.body;

    // Fetch role — allow editing system roles too (org admin can manage them)
    const { rows: existing } = await db.query(
      `SELECT id, code, name, description, is_system, org_id
       FROM roles WHERE id = $1 AND (org_id = $2 OR is_system = true)`,
      [id, orgId]
    );
    if (!existing.length) return res.status(404).json({ error: 'Role not found' });

    const role = existing[0];

    // Validate all permission codes exist
    if (permissions.length > 0) {
      const { rows: validPerms } = await db.query(
        `SELECT code FROM permissions WHERE code = ANY($1::text[])`,
        [permissions]
      );
      const validCodes = new Set(validPerms.map(p => p.code));
      const invalid = permissions.filter(c => !validCodes.has(c));
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'Invalid permission codes', codes: invalid });
      }
    }

    // Replace permissions atomically
    await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);

    if (permissions.length > 0) {
      const insertValues = permissions
        .map((_, i) => `($1, $${i + 2})`)
        .join(', ');
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_code) VALUES ${insertValues}`,
        [id, ...permissions]
      );
    }

    // Bump version for all users that have this role
    const { rows: affected } = await db.query(
      `SELECT DISTINCT user_id FROM user_roles
       WHERE role_id = $1 AND (valid_to IS NULL OR valid_to > now())`,
      [id]
    );
    await Promise.all(affected.map(r => bumpVersion(r.user_id)));

    // Return updated role with permissions
    const { rows: updatedRows } = await db.query(
      `SELECT r.id, r.code, r.name, r.description, r.is_system, r.org_id,
         COALESCE(
           json_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL),
           '[]'::json
         ) AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [id]
    );

    res.json({ role: updatedRows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
