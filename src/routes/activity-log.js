const express    = require('express');
const db         = require('../db');
const authenticate   = require('../middleware/authenticate');
const tenantScope    = require('../rbac/tenant-scope.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P          = require('../rbac/permissions.constants');

const router = express.Router();

router.get('/', authenticate, tenantScope, requirePermission(P.AUDIT_VIEW), async (req, res, next) => {
  try {
    const clinicId = req.user.clinic_id;
    const page     = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit    = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset   = (page - 1) * limit;

    const params  = [clinicId];
    const filters = [];

    if (req.query.user_id) {
      params.push(req.query.user_id);
      filters.push(`user_id = $${params.length}`);
    }
    if (req.query.entity_type) {
      params.push(req.query.entity_type);
      filters.push(`entity_type = $${params.length}`);
    }
    if (req.query.date_from) {
      params.push(req.query.date_from);
      filters.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (req.query.date_to) {
      params.push(req.query.date_to);
      filters.push(`created_at < ($${params.length}::date + interval '1 day')`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      const n = params.length;
      filters.push(
        `(action ILIKE $${n} OR path ILIKE $${n} OR user_name ILIKE $${n} OR user_email ILIKE $${n})`
      );
    }

    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

    params.push(limit, offset);
    const limitN  = params.length - 1;
    const offsetN = params.length;

    const { rows } = await db.query(
      `SELECT *, COUNT(*) OVER() AS total_count
       FROM activity_log
       WHERE clinic_id = $1 ${where}
       ORDER BY created_at DESC
       LIMIT $${limitN} OFFSET $${offsetN}`,
      params
    );

    const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    const logs  = rows.map(({ total_count, ...r }) => r);

    res.json({ logs, total, page, limit });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
