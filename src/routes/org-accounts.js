const express  = require('express');
const db       = require('../db');
const authenticate          = require('../middleware/authenticate');
const tenantScope           = require('../rbac/tenant-scope.middleware');
const auditMw               = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                     = require('../rbac/permissions.constants');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── Helper: parse + clamp period ─────────────────────────────────────────────

function parsePeriod(raw, def = 30) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(365, n));
}

// ── GET /summary — org-level stats ───────────────────────────────────────────

router.get('/summary', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId  = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const period      = parsePeriod(req.query.period);
    const periodStart = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString();

    const [
      clinicsRes,
      staffRes,
      apptRes,
      revenueRes,
    ] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total FROM clinics WHERE org_id = $1 AND is_active = true`,
        [orgId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS total FROM users WHERE org_id = $1 AND is_active = true`,
        [orgId]
      ),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'done')::int          AS completed,
           COUNT(*) FILTER (WHERE status NOT IN ('done','cancelled') AND scheduled_at > now())::int AS upcoming,
           COUNT(*) FILTER (WHERE created_at >= $2)::int         AS period_total
         FROM appointments
         WHERE org_id = $1`,
        [orgId, periodStart]
      ),
      db.query(
        `SELECT
           COALESCE(SUM(s.price) FILTER (WHERE a.status = 'done'), 0)::numeric               AS total_revenue,
           COALESCE(SUM(s.price) FILTER (WHERE a.status = 'done' AND a.created_at >= $2), 0)::numeric AS period_revenue
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         WHERE a.org_id = $1`,
        [orgId, periodStart]
      ),
    ]);

    res.json({
      clinics:      clinicsRes.rows[0].total,
      active_staff: staffRes.rows[0].total,
      appointments: {
        completed:    apptRes.rows[0].completed,
        upcoming:     apptRes.rows[0].upcoming,
        period_total: apptRes.rows[0].period_total,
      },
      revenue: {
        total_revenue:  revenueRes.rows[0].total_revenue,
        period_revenue: revenueRes.rows[0].period_revenue,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /revenue — per-clinic breakdown ──────────────────────────────────────

router.get('/revenue', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId  = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const period      = parsePeriod(req.query.period);
    const periodStart = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString();
    const { clinic_id } = req.query;

    const params = [orgId, periodStart];
    let clinicFilter = '';
    if (clinic_id) {
      params.push(clinic_id);
      clinicFilter = `AND c.id = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT
         c.id                                                              AS clinic_id,
         c.name                                                            AS clinic_name,
         c.is_active,
         COUNT(a.id) FILTER (WHERE a.status = 'done')::int                AS completed_appointments,
         COUNT(a.id) FILTER (WHERE a.status NOT IN ('done','cancelled') AND a.scheduled_at > now())::int AS upcoming_appointments,
         COALESCE(SUM(s.price) FILTER (WHERE a.status = 'done'), 0)::numeric        AS total_revenue,
         COALESCE(SUM(s.price) FILTER (WHERE a.status = 'done' AND a.created_at >= $2), 0)::numeric AS period_revenue,
         MAX(a.scheduled_at) FILTER (WHERE a.status = 'done')            AS last_completed_at
       FROM clinics c
       LEFT JOIN appointments a ON a.clinic_id = c.id AND a.org_id = $1
       LEFT JOIN services s ON s.id = a.service_id
       WHERE c.org_id = $1
         ${clinicFilter}
       GROUP BY c.id, c.name, c.is_active
       ORDER BY total_revenue DESC`,
      params
    );

    res.json({ clinics: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /revenue/services — top 10 services by revenue ───────────────────────

router.get('/revenue/services', ...authChain, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const orgId  = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const period      = parsePeriod(req.query.period);
    const periodStart = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString();
    const { clinic_id } = req.query;

    const params = [orgId, periodStart];
    let clinicFilter = '';
    if (clinic_id) {
      params.push(clinic_id);
      clinicFilter = `AND a.clinic_id = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT
         s.id,
         s.name                                                              AS service_name,
         s.price,
         COUNT(a.id)::int                                                    AS total_bookings,
         COUNT(a.id) FILTER (WHERE a.created_at >= $2)::int                 AS period_bookings,
         COALESCE(SUM(s.price), 0)::numeric                                 AS total_revenue,
         COALESCE(SUM(s.price) FILTER (WHERE a.created_at >= $2), 0)::numeric AS period_revenue
       FROM services s
       JOIN appointments a ON a.service_id = s.id AND a.status = 'done' AND a.org_id = $1
       WHERE s.org_id = $1
         ${clinicFilter}
       GROUP BY s.id, s.name, s.price
       ORDER BY total_revenue DESC
       LIMIT 10`,
      params
    );

    res.json({ services: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
