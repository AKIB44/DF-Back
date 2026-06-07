// ────────────────────────────────────────────────────────────────────────────
// Staff ABAC attribute editor (PRD §13 item 6)
// ────────────────────────────────────────────────────────────────────────────
//   GET   /v1/staff-attrs/:userId   → current ABAC attrs for a user
//   PATCH /v1/staff-attrs/:userId   → update specialty_tags / max_discount_pct /
//                                     branch_id / shift_*
//
// Admin-gated. Invalidates the subject-memo cache so the engine picks up the
// new attributes on the next request without restart.
// ────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const Joi          = require('joi');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const validate     = require('../middleware/validate');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { authorize } = require('../security/middleware/authorize.middleware');
const { invalidateSubject } = require('../security/helpers/build-subject');

const router = express.Router();
router.use(authenticate, tenantScope, auditMw);

const updateSchema = Joi.object({
  specialty_tags:    Joi.array().items(Joi.string().uppercase().max(40)).max(20).optional(),
  branch_id:         Joi.string().uuid().allow(null).optional(),
  max_discount_pct:  Joi.number().min(0).max(100).optional(),
  shift_start:       Joi.string().pattern(/^\d{2}:\d{2}$/).allow(null).optional(),
  shift_end:         Joi.string().pattern(/^\d{2}:\d{2}$/).allow(null).optional(),
}).min(1);

router.get(
  '/:userId',
  requirePermission(P.STAFF_MANAGE),
  authorize('update', 'staff'),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.role,
                u.specialty_tags, u.branch_id,
                u.max_discount_pct, u.shift_start, u.shift_end,
                u.clinic_id, u.org_id,
                COALESCE(MAX(r.hierarchy_level), 30) AS hierarchy_level
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id AND (ur.valid_to IS NULL OR ur.valid_to > NOW())
           LEFT JOIN roles r ON r.id = ur.role_id
           WHERE u.id = $1 AND u.org_id = $2
           GROUP BY u.id`,
        [req.params.userId, req.user.org_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/:userId',
  requirePermission(P.STAFF_MANAGE),
  authorize('update', 'staff'),
  validate(updateSchema),
  async (req, res, next) => {
    try {
      const fields = [];
      const values = [];
      let i = 1;
      for (const [k, v] of Object.entries(req.body)) {
        fields.push(`${k} = $${i++}`);
        values.push(v);
      }
      values.push(req.params.userId, req.user.org_id);
      const { rows } = await db.query(
        `UPDATE users
            SET ${fields.join(', ')}
          WHERE id = $${i++} AND org_id = $${i}
          RETURNING id, email, specialty_tags, branch_id,
                    max_discount_pct, shift_start, shift_end`,
        values
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      // Drop the in-process attribute memo so the next request sees the change.
      invalidateSubject(req.params.userId);
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
