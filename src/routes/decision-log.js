// ────────────────────────────────────────────────────────────────────────────
// Access-decision log search (PRD §13 item 4)
// ────────────────────────────────────────────────────────────────────────────
//   GET /v1/decision-log?user_id&decision&resource_type&from&to&limit
// ────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { authorize } = require('../security/middleware/authorize.middleware');

const router = express.Router();
router.use(authenticate, tenantScope, auditMw);

router.get(
  '/',
  requirePermission(P.AUDIT_VIEW),
  authorize('read', 'audit_log'),
  async (req, res, next) => {
    try {
      const where = ['(adl.clinic_id IS NULL OR adl.clinic_id = $1)'];
      const params = [req.user.clinic_id || null];
      let i = 2;
      const addEq = (col, val) => { if (val) { where.push(`adl.${col} = $${i}`); params.push(val); i++; } };
      addEq('user_id',       req.query.user_id);
      addEq('decision',      req.query.decision);
      addEq('resource_type', req.query.resource_type);
      addEq('action',        req.query.action);
      if (req.query.from) { where.push(`adl.decided_at >= $${i}`); params.push(req.query.from); i++; }
      if (req.query.to)   { where.push(`adl.decided_at <= $${i}`); params.push(req.query.to);   i++; }
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);

      const { rows } = await db.query(
        `SELECT adl.id, adl.user_id, adl.role, adl.action, adl.resource_type,
                adl.resource_id, adl.decision, adl.policy_name, adl.policy_version,
                adl.reason, adl.attributes, adl.ip_address, adl.decided_at,
                u.first_name || ' ' || COALESCE(u.last_name,'') AS user_name,
                u.email AS user_email
           FROM access_decision_log adl
           LEFT JOIN users u ON u.id = adl.user_id
           WHERE ${where.join(' AND ')}
           ORDER BY adl.decided_at DESC
           LIMIT $${i}`,
        [...params, limit]
      );

      // Stats — useful for the page header summary.
      const { rows: stats } = await db.query(
        `SELECT decision, COUNT(*)::int AS n
           FROM access_decision_log adl
           WHERE ${where.join(' AND ')}
           GROUP BY decision`,
        params
      );

      res.json({ entries: rows, stats });
    } catch (err) { next(err); }
  }
);

module.exports = router;
