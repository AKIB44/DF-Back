// ────────────────────────────────────────────────────────────────────────────
// Feature flags — org-scoped on/off toggles
// ────────────────────────────────────────────────────────────────────────────
//   GET    /v1/feature-flags         → list flags for current org (resolved)
//   PATCH  /v1/feature-flags/:key    → set { enabled: boolean } (org_admin)
// ────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');

const router = express.Router();
router.use(authenticate, tenantScope, auditMw);

// ── Catalog of known flags — keeps the response shape stable even when a row
//    hasn't been written yet (absent row = default false).
const FLAGS = [
  {
    key:         'voice_assistant.friday',
    label:       'Friday — Voice Assistant',
    description: 'Global mic + clinic-wide voice commands ("Friday, open patient Ravi").',
    default:     false,
  },
];

router.get('/', async (req, res, next) => {
  try {
    const orgId = req.user.org_id;
    const result = await db.query(
      `SELECT flag_key, enabled, updated_at, updated_by
         FROM feature_flags WHERE org_id = $1`,
      [orgId]
    );
    const byKey = new Map(result.rows.map(r => [r.flag_key, r]));
    const flags = FLAGS.map(f => {
      const row = byKey.get(f.key);
      return {
        key:         f.key,
        label:       f.label,
        description: f.description,
        enabled:     row ? row.enabled : f.default,
        updated_at:  row?.updated_at ?? null,
        updated_by:  row?.updated_by ?? null,
      };
    });
    res.json({ flags });
  } catch (err) { next(err); }
});

router.patch('/:key', requirePermission(P.FEATURE_FLAG_MANAGE), async (req, res, next) => {
  try {
    const key = String(req.params.key || '').toLowerCase();
    if (!FLAGS.some(f => f.key === key)) {
      return res.status(404).json({ error: 'Unknown feature flag' });
    }
    const enabled = req.body?.enabled === true;
    const orgId   = req.user.org_id;
    const userId  = req.user.sub || req.user.id;
    const result = await db.query(
      `INSERT INTO feature_flags (org_id, flag_key, enabled, updated_by)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, flag_key)
         DO UPDATE SET enabled = EXCLUDED.enabled,
                       updated_at = NOW(),
                       updated_by = EXCLUDED.updated_by
       RETURNING flag_key, enabled, updated_at, updated_by`,
      [orgId, key, enabled, userId]
    );
    res.json({ flag: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
