const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { resolveClinicIdForOptionalAuth } = require('../helpers/public-clinic');
const { resolvePermissions } = require('../rbac/permission.resolver');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

const createSchema = Joi.object({
  name:             Joi.string().required(),
  duration_minutes: Joi.number().integer().min(1).max(480).required(),
  price:            Joi.number().min(0).required(),
  description:      Joi.string().optional().allow(''),
  is_active:        Joi.boolean().optional().default(true),
});

const updateSchema = createSchema;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function hasPermission(user, clinicId, code) {
  const perms = await resolvePermissions(user.sub, clinicId);
  return code in perms;
}

// ── GET / — full clinic service list (schedule, booking, public use) ──────────
// Returns ALL active services for the clinic — no doctor filtering.
// Admin view includes doctor_name; unauthenticated callers get a narrower column set.

router.get('/', async (req, res, next) => {
  try {
    const clinicId = resolveClinicIdForOptionalAuth(req);
    if (!clinicId) return res.status(401).json({ error: 'Unauthorized' });

    // Detect admin via JWT without hard-requiring auth middleware
    let isAdmin = false;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        if (decoded?.sub) {
          isAdmin = await hasPermission(decoded, clinicId, P.CLINIC_SETTINGS);
        }
      } catch { /* treat as anonymous */ }
    }

    let rows;
    if (isAdmin) {
      const r = await db.query(
        `SELECT s.*, u.first_name || ' ' || u.last_name AS doctor_name
         FROM services s
         LEFT JOIN users u ON u.id = s.doctor_id
         WHERE s.clinic_id = $1 ORDER BY s.name ASC`,
        [clinicId]
      );
      rows = r.rows;
    } else {
      const r = await db.query(
        `SELECT id, clinic_id, name, duration_minutes, price, description, is_active, code, doctor_id
         FROM services WHERE clinic_id = $1 ORDER BY name ASC`,
        [clinicId]
      );
      rows = r.rows;
    }

    res.json({ services: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /mine — doctor's own services only (authenticated) ────────────────────

router.get('/mine', ...authChain, requirePermission(P.SERVICE_MANAGE_OWN), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, u.first_name || ' ' || u.last_name AS doctor_name
       FROM services s
       LEFT JOIN users u ON u.id = s.doctor_id
       WHERE s.clinic_id = $1 AND s.doctor_id = $2
       ORDER BY s.name ASC`,
      [req.user.clinic_id, req.user.sub]
    );
    res.json({ services: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST / — create service ───────────────────────────────────────────────────

router.post('/', ...authChain, validate(createSchema), async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const isAdmin  = await hasPermission(req.user, clinicId, P.CLINIC_SETTINGS);
    const isDoctor = await hasPermission(req.user, clinicId, P.SERVICE_MANAGE_OWN);

    if (!isAdmin && !isDoctor) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { name, duration_minutes, price, description, is_active = true } = req.body;
    // Doctors always own the service they create; admins create clinic-level (no doctor_id)
    const doctorId = isAdmin ? null : req.user.sub;

    const result = await db.query(
      `INSERT INTO services (clinic_id, name, duration_minutes, price, description, doctor_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [clinicId, name, duration_minutes, price, description || null, doctorId, is_active]
    );
    res.status(201).json({ service: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PUT /:id — update service ─────────────────────────────────────────────────

router.put('/:id', ...authChain, validate(updateSchema), async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const isAdmin  = await hasPermission(req.user, clinicId, P.CLINIC_SETTINGS);
    const isDoctor = await hasPermission(req.user, clinicId, P.SERVICE_MANAGE_OWN);

    if (!isAdmin && !isDoctor) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Doctors can only edit their own services
    const ownerFilter = isAdmin
      ? 'AND clinic_id = $7'
      : 'AND clinic_id = $7 AND doctor_id = $8';

    const params = isAdmin
      ? [req.body.name, req.body.duration_minutes, req.body.price, req.body.description || null,
         req.body.is_active ?? true, req.params.id, clinicId]
      : [req.body.name, req.body.duration_minutes, req.body.price, req.body.description || null,
         req.body.is_active ?? true, req.params.id, clinicId, req.user.sub];

    const result = await db.query(
      `UPDATE services
         SET name=$1, duration_minutes=$2, price=$3, description=$4, is_active=$5
       WHERE id=$6 ${ownerFilter}
       RETURNING *`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Service not found or not yours' });
    }
    res.json({ service: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/toggle — activate / deactivate ─────────────────────────────────

router.patch('/:id/toggle', ...authChain, async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const isAdmin  = await hasPermission(req.user, clinicId, P.CLINIC_SETTINGS);
    const isDoctor = await hasPermission(req.user, clinicId, P.SERVICE_MANAGE_OWN);

    if (!isAdmin && !isDoctor) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const ownerFilter = isAdmin ? '' : 'AND doctor_id = $3';
    const params = isAdmin
      ? [req.params.id, clinicId]
      : [req.params.id, clinicId, req.user.sub];

    const result = await db.query(
      `UPDATE services SET is_active = NOT is_active
       WHERE id = $1 AND clinic_id = $2 ${ownerFilter}
       RETURNING *`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Service not found or not yours' });
    }
    res.json({ service: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id — admin only ──────────────────────────────────────────────────

router.delete('/:id', ...authChain, requirePermission(P.CLINIC_SETTINGS), async (req, res, next) => {
  try {
    const conflict = await db.query(
      `SELECT id FROM appointments
       WHERE service_id = $1
         AND status NOT IN ('cancelled','no_show')
         AND scheduled_at > now()
       LIMIT 1`,
      [req.params.id]
    );
    if (conflict.rows.length) {
      return res.status(409).json({ error: 'Service has upcoming appointments' });
    }
    await db.query(`DELETE FROM services WHERE id=$1 AND clinic_id=$2`, [req.params.id, req.user.clinic_id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
