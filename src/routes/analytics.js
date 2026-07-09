// ── Clinic Analytics — revenue, loss factors, time utilisation ──────────────
//
// GET /v1/analytics/overview
//   One round-trip returning every dataset the analytics dashboard renders.
//   All queries are clinic-scoped; money comes from service_performed
//   (final_charge), loss estimates from services.price / plan item costs.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');

const router = express.Router();
router.use(authenticate, tenantScope);

const TZ = 'Asia/Kolkata';

router.get('/overview', requirePermission(P.BILLING_VIEW), async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    if (!clinicId) return res.status(400).json({ error: 'Cannot determine clinic' });

    const [
      kpiRes, trendRes, byServiceRes, byDoctorRes,
      apptLossRes, declinedRes, declinedReasonRes, abandonedRes,
      weekdayRes, hourRes, durationRes, topPatientsRes, labSpendRes,
    ] = await Promise.all([

      // ── KPIs: this month vs last month ────────────────────────────────────
      db.query(
        `WITH months AS (
           SELECT date_trunc('month', (NOW() AT TIME ZONE $2))                       AS cur,
                  date_trunc('month', (NOW() AT TIME ZONE $2) - interval '1 month')  AS prev
         )
         SELECT
           (SELECT COALESCE(SUM(sp.final_charge),0) FROM service_performed sp
              JOIN clinical_session cs ON cs.id = sp.session_id
             WHERE cs.clinic_id = $1
               AND date_trunc('month', cs.started_at AT TIME ZONE $2) = (SELECT cur FROM months))  AS revenue_cur,
           (SELECT COALESCE(SUM(sp.final_charge),0) FROM service_performed sp
              JOIN clinical_session cs ON cs.id = sp.session_id
             WHERE cs.clinic_id = $1
               AND date_trunc('month', cs.started_at AT TIME ZONE $2) = (SELECT prev FROM months)) AS revenue_prev,
           (SELECT COUNT(*) FROM appointments a
             WHERE a.clinic_id = $1
               AND date_trunc('month', a.scheduled_at AT TIME ZONE $2) = (SELECT cur FROM months)) AS appts_cur,
           (SELECT COUNT(*) FROM appointments a
             WHERE a.clinic_id = $1
               AND date_trunc('month', a.scheduled_at AT TIME ZONE $2) = (SELECT prev FROM months)) AS appts_prev,
           (SELECT COUNT(*) FROM appointments a
             WHERE a.clinic_id = $1 AND a.status IN ('no_show','cancelled')
               AND date_trunc('month', a.scheduled_at AT TIME ZONE $2) = (SELECT cur FROM months)) AS lost_appts_cur,
           (SELECT COUNT(*) FROM patients p
             WHERE p.clinic_id = $1
               AND date_trunc('month', p.created_at AT TIME ZONE $2) = (SELECT cur FROM months))   AS new_patients_cur,
           (SELECT COUNT(*) FROM patients p
             WHERE p.clinic_id = $1
               AND date_trunc('month', p.created_at AT TIME ZONE $2) = (SELECT prev FROM months))  AS new_patients_prev,
           (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (cs.ended_at - cs.started_at)) / 60), 0)
              FROM clinical_session cs
             WHERE cs.clinic_id = $1 AND cs.ended_at IS NOT NULL
               AND date_trunc('month', cs.started_at AT TIME ZONE $2) = (SELECT cur FROM months))  AS avg_session_min`,
        [clinicId, TZ]
      ),

      // ── Revenue trend: 12 months ──────────────────────────────────────────
      db.query(
        `SELECT to_char(date_trunc('month', cs.started_at AT TIME ZONE $2), 'YYYY-MM') AS month,
                COALESCE(SUM(sp.final_charge),0)::numeric AS revenue,
                COUNT(DISTINCT cs.id)::int                AS sessions
           FROM clinical_session cs
           LEFT JOIN service_performed sp ON sp.session_id = cs.id
          WHERE cs.clinic_id = $1
            AND cs.started_at >= date_trunc('month', (NOW() AT TIME ZONE $2) - interval '11 months')
          GROUP BY 1 ORDER BY 1`,
        [clinicId, TZ]
      ),

      // ── Revenue by service (12 months, top 10) ────────────────────────────
      db.query(
        `SELECT s.name,
                COALESCE(SUM(sp.final_charge),0)::numeric AS revenue,
                COUNT(*)::int                             AS performed,
                COALESCE(AVG(sp.final_charge),0)::numeric AS avg_charge
           FROM service_performed sp
           JOIN clinical_session cs ON cs.id = sp.session_id
           LEFT JOIN services s ON s.id = sp.service_id
          WHERE cs.clinic_id = $1
            AND cs.started_at >= (NOW() - interval '12 months')
          GROUP BY s.name
          ORDER BY revenue DESC
          LIMIT 10`,
        [clinicId]
      ),

      // ── Revenue by doctor (12 months) ─────────────────────────────────────
      db.query(
        `SELECT TRIM(u.first_name || ' ' || COALESCE(u.last_name,'')) AS doctor,
                COALESCE(SUM(sp.final_charge),0)::numeric AS revenue,
                COUNT(DISTINCT cs.id)::int                AS sessions
           FROM clinical_session cs
           LEFT JOIN service_performed sp ON sp.session_id = cs.id
           LEFT JOIN users u ON u.id = cs.primary_doctor_id
          WHERE cs.clinic_id = $1
            AND cs.started_at >= (NOW() - interval '12 months')
          GROUP BY doctor
          ORDER BY revenue DESC
          LIMIT 8`,
        [clinicId]
      ),

      // ── Loss: cancelled / no-show appointments (90 days) ──────────────────
      db.query(
        `SELECT a.status,
                COUNT(*)::int AS count,
                COALESCE(SUM(s.price),0)::numeric AS est_value,
                COALESCE(SUM(a.duration_minutes),0)::int AS minutes
           FROM appointments a
           LEFT JOIN services s ON s.id = a.service_id
          WHERE a.clinic_id = $1
            AND a.status IN ('cancelled','no_show')
            AND a.scheduled_at >= (NOW() - interval '90 days')
          GROUP BY a.status`,
        [clinicId]
      ),

      // ── Loss: declined treatment plan items (all open history) ────────────
      db.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(COALESCE(tpi.cost_max, tpi.cost_min, 0)),0)::numeric AS est_value
           FROM treatment_plan_item tpi
          WHERE tpi.clinic_id = $1 AND tpi.status = 'DECLINED' AND tpi.deleted_at IS NULL`,
        [clinicId]
      ),
      db.query(
        `SELECT tpi.decline_reason::text AS reason,
                COUNT(*)::int AS count,
                COALESCE(SUM(COALESCE(tpi.cost_max, tpi.cost_min, 0)),0)::numeric AS est_value
           FROM treatment_plan_item tpi
          WHERE tpi.clinic_id = $1 AND tpi.status = 'DECLINED' AND tpi.deleted_at IS NULL
          GROUP BY tpi.decline_reason
          ORDER BY est_value DESC`,
        [clinicId]
      ),

      // ── Loss: abandoned services (90 days) ────────────────────────────────
      db.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(sp.final_charge),0)::numeric AS est_value
           FROM service_performed sp
           JOIN clinical_session cs ON cs.id = sp.session_id
          WHERE cs.clinic_id = $1 AND sp.status = 'ABANDONED'
            AND cs.started_at >= (NOW() - interval '90 days')`,
        [clinicId]
      ),

      // ── Time: appointments by weekday (90 days) ───────────────────────────
      db.query(
        `SELECT EXTRACT(DOW FROM a.scheduled_at AT TIME ZONE $2)::int AS dow,
                COUNT(*)::int AS count
           FROM appointments a
          WHERE a.clinic_id = $1
            AND a.scheduled_at >= (NOW() - interval '90 days')
            AND a.status NOT IN ('cancelled','no_show')
          GROUP BY 1 ORDER BY 1`,
        [clinicId, TZ]
      ),

      // ── Time: appointments by hour (90 days) ──────────────────────────────
      db.query(
        `SELECT EXTRACT(HOUR FROM a.scheduled_at AT TIME ZONE $2)::int AS hour,
                COUNT(*)::int AS count
           FROM appointments a
          WHERE a.clinic_id = $1
            AND a.scheduled_at >= (NOW() - interval '90 days')
            AND a.status NOT IN ('cancelled','no_show')
          GROUP BY 1 ORDER BY 1`,
        [clinicId, TZ]
      ),

      // ── Time: where chair time actually goes (90 days, by service) ────────
      db.query(
        `SELECT s.name,
                COUNT(*)::int AS performed,
                COALESCE(SUM(a.duration_minutes),0)::int AS minutes
           FROM appointments a
           LEFT JOIN services s ON s.id = a.service_id
          WHERE a.clinic_id = $1
            AND a.scheduled_at >= (NOW() - interval '90 days')
            AND a.status NOT IN ('cancelled','no_show')
          GROUP BY s.name
          ORDER BY minutes DESC
          LIMIT 8`,
        [clinicId]
      ),

      // ── Top patients by billed value (12 months) ──────────────────────────
      db.query(
        `SELECT p.id, p.name,
                COALESCE(SUM(sp.final_charge),0)::numeric AS revenue,
                COUNT(DISTINCT cs.id)::int AS sessions
           FROM clinical_session cs
           JOIN patients p ON p.id = cs.patient_id
           LEFT JOIN service_performed sp ON sp.session_id = cs.id
          WHERE cs.clinic_id = $1
            AND cs.started_at >= (NOW() - interval '12 months')
          GROUP BY p.id, p.name
          ORDER BY revenue DESC
          LIMIT 6`,
        [clinicId]
      ),

      // ── Lab spend (outgoing cost, 12 months) ──────────────────────────────
      db.query(
        `SELECT COALESCE(SUM(lo.lab_cost),0)::numeric AS total
           FROM lab_order lo
           JOIN clinical_session cs ON cs.id = lo.session_id
          WHERE cs.clinic_id = $1
            AND lo.created_at >= (NOW() - interval '12 months')
            AND lo.status <> 'cancelled'`,
        [clinicId]
      ),
    ]);

    const k = kpiRes.rows[0];
    const apptLoss = { cancelled: { count: 0, est_value: 0, minutes: 0 }, no_show: { count: 0, est_value: 0, minutes: 0 } };
    for (const r of apptLossRes.rows) {
      apptLoss[r.status] = { count: r.count, est_value: +r.est_value, minutes: r.minutes };
    }

    res.json({
      kpis: {
        revenue_cur:       +k.revenue_cur,
        revenue_prev:      +k.revenue_prev,
        appts_cur:         +k.appts_cur,
        appts_prev:        +k.appts_prev,
        lost_appts_cur:    +k.lost_appts_cur,
        new_patients_cur:  +k.new_patients_cur,
        new_patients_prev: +k.new_patients_prev,
        avg_session_min:   Math.round(+k.avg_session_min),
        lab_spend_12m:     +labSpendRes.rows[0].total,
      },
      revenue_trend:      trendRes.rows.map(r => ({ ...r, revenue: +r.revenue })),
      revenue_by_service: byServiceRes.rows.map(r => ({ ...r, revenue: +r.revenue, avg_charge: +r.avg_charge })),
      revenue_by_doctor:  byDoctorRes.rows.map(r => ({ ...r, revenue: +r.revenue })),
      loss_factors: {
        cancelled:  apptLoss.cancelled,
        no_show:    apptLoss.no_show,
        declined_plans: {
          count:     declinedRes.rows[0].count,
          est_value: +declinedRes.rows[0].est_value,
          by_reason: declinedReasonRes.rows.map(r => ({ ...r, est_value: +r.est_value })),
        },
        abandoned_services: {
          count:     abandonedRes.rows[0].count,
          est_value: +abandonedRes.rows[0].est_value,
        },
      },
      time_analysis: {
        by_weekday:      weekdayRes.rows,
        by_hour:         hourRes.rows,
        time_by_service: durationRes.rows,
      },
      top_patients: topPatientsRes.rows.map(r => ({ ...r, revenue: +r.revenue })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
