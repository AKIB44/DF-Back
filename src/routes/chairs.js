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

const authAdmin = [authenticate, tenantScope, auditMw, requirePermission(P.CLINIC_SETTINGS)];
const authView  = [authenticate, tenantScope, auditMw];

const router = express.Router();

// ── Shared service-status SQL expression ─────────────────────────────────────
const SERVICE_STATUS_EXPR = `
  CASE
    WHEN next_service_due IS NULL        THEN 'no_schedule'
    WHEN next_service_due < CURRENT_DATE THEN 'overdue'
    WHEN next_service_due <= CURRENT_DATE + INTERVAL '30 days' THEN 'due_soon'
    ELSE 'ok'
  END
`;

// ── GET / — list all chairs with service info ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const clinicId = resolveClinicIdForOptionalAuth(req);
    if (!clinicId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await db.query(
      `SELECT *, (${SERVICE_STATUS_EXPR}) AS service_status
         FROM chairs
        WHERE clinic_id = $1
        ORDER BY created_at ASC`,
      [clinicId]
    );
    res.json({ chairs: result.rows });
  } catch (err) { next(err); }
});

// ── GET /service-due — chairs overdue or due within 30 days ───────────────────
router.get('/service-due', ...authView, async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const { rows } = await db.query(
      `SELECT *, (${SERVICE_STATUS_EXPR}) AS service_status
         FROM chairs
        WHERE clinic_id = $1
          AND is_active = true
          AND (next_service_due IS NULL OR next_service_due <= CURRENT_DATE + INTERVAL '30 days')
        ORDER BY next_service_due ASC NULLS LAST`,
      [clinicId]
    );
    res.json({ chairs: rows });
  } catch (err) { next(err); }
});

// ── GET /service-logs — all service logs for the clinic ───────────────────────
router.get('/service-logs', ...authView, async (req, res, next) => {
  try {
    const clinicId  = req.user.clinic_id;
    const chair_id  = req.query.chair_id || null;
    const limit     = Math.min(parseInt(req.query.limit) || 100, 500);

    const conditions = ['sl.clinic_id = $1'];
    const params     = [clinicId];
    let   idx        = 2;

    if (chair_id) { conditions.push(`sl.chair_id = $${idx++}`); params.push(chair_id); }

    const { rows } = await db.query(
      `SELECT sl.*, c.name AS chair_name
         FROM chair_service_log sl
         JOIN chairs c ON c.id = sl.chair_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY sl.serviced_at DESC, sl.created_at DESC
        LIMIT $${idx}`,
      [...params, limit]
    );
    res.json({ logs: rows });
  } catch (err) { next(err); }
});

// ── POST / — create chair ─────────────────────────────────────────────────────
const createSchema = Joi.object({
  name:                  Joi.string().required(),
  service_interval_days: Joi.number().integer().min(1).default(180).optional(),
  operational_status:    Joi.string().valid('operational','under_service','out_of_order').optional(),
  is_active:             Joi.boolean().optional(),
});

router.post('/', ...authAdmin, validate(createSchema), async (req, res, next) => {
  try {
    const { name, service_interval_days, operational_status, is_active } = req.body;
    const result = await db.query(
      `INSERT INTO chairs (clinic_id, name, service_interval_days, operational_status, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *, (${SERVICE_STATUS_EXPR}) AS service_status`,
      [req.user.clinic_id, name, service_interval_days ?? 180,
       operational_status ?? 'operational', is_active ?? true]
    );
    res.status(201).json({ chair: result.rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /:id — update chair ───────────────────────────────────────────────────
const updateSchema = Joi.object({
  name:                  Joi.string().optional(),
  is_active:             Joi.boolean().optional(),
  operational_status:    Joi.string().valid('operational','under_service','out_of_order').optional(),
  service_interval_days: Joi.number().integer().min(1).optional(),
});

router.put('/:id', ...authAdmin, validate(updateSchema), async (req, res, next) => {
  try {
    const { name, is_active, operational_status, service_interval_days } = req.body;
    const result = await db.query(
      `UPDATE chairs SET
         name                  = COALESCE($1, name),
         is_active             = COALESCE($2, is_active),
         operational_status    = COALESCE($3, operational_status),
         service_interval_days = COALESCE($4, service_interval_days)
       WHERE id = $5 AND clinic_id = $6
       RETURNING *, (${SERVICE_STATUS_EXPR}) AS service_status`,
      [name ?? null, is_active ?? null, operational_status ?? null,
       service_interval_days ?? null, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Chair not found' });
    res.json({ chair: result.rows[0] });
  } catch (err) { next(err); }
});

// ── POST /:id/service-logs — log a service event ──────────────────────────────
const serviceLogSchema = Joi.object({
  service_type:       Joi.string().max(100).required(),
  serviced_at:        Joi.string().isoDate().required(),
  serviced_by:        Joi.string().max(200).allow('', null).optional(),
  notes:              Joi.string().max(2000).allow('', null).optional(),
  cost:               Joi.number().min(0).allow(null).optional(),
  operational_status: Joi.string().valid('operational','under_service','out_of_order').optional(),
  next_due_date:      Joi.string().isoDate().allow(null).optional(),
});

router.post('/:id/service-logs', ...authAdmin, validate(serviceLogSchema), async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const userId   = req.user.id;
    const chairId  = req.params.id;

    const { service_type, serviced_at, serviced_by, notes, cost,
            operational_status, next_due_date } = req.body;

    // Verify chair belongs to clinic
    const { rows: [chair] } = await db.query(
      `SELECT * FROM chairs WHERE id=$1 AND clinic_id=$2`, [chairId, clinicId]
    );
    if (!chair) return res.status(404).json({ error: 'Chair not found' });

    // Auto-compute next_due_date if not supplied
    let resolvedNextDue = next_due_date || null;
    if (!resolvedNextDue) {
      const { rows: [computed] } = await db.query(
        `SELECT ($1::date + ($2 || ' days')::INTERVAL)::date AS next_due`,
        [serviced_at, chair.service_interval_days]
      );
      resolvedNextDue = computed.next_due;
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert service log
      const { rows: [log] } = await client.query(
        `INSERT INTO chair_service_log
           (chair_id, clinic_id, service_type, serviced_at, serviced_by, notes, cost, next_due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [chairId, clinicId, service_type, serviced_at, serviced_by || null,
         notes || null, cost ?? null, resolvedNextDue, userId]
      );

      // Update chair: last_serviced_at, next_service_due, operational_status
      const { rows: [updatedChair] } = await client.query(
        `UPDATE chairs SET
           last_serviced_at   = $1,
           next_service_due   = $2,
           operational_status = COALESCE($3, operational_status)
         WHERE id = $4
         RETURNING *, (${SERVICE_STATUS_EXPR}) AS service_status`,
        [serviced_at, log.next_due_date, operational_status ?? null, chairId]
      );

      await client.query('COMMIT');
      res.status(201).json({ log, chair: updatedChair });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete('/:id', ...authAdmin, async (req, res, next) => {
  try {
    const conflict = await db.query(
      `SELECT id FROM appointments
       WHERE chair_id = $1
         AND status IN ('booked','confirmed')
         AND scheduled_at > now()
       LIMIT 1`,
      [req.params.id]
    );
    if (conflict.rows.length) {
      return res.status(409).json({ error: 'Chair has upcoming appointments' });
    }
    await db.query(`DELETE FROM chairs WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
