const db = require('../db');

// ── Tenant read-only enforcement (AC-2) ──────────────────────────────────────
// A clinic whose subscription has lapsed (trial expired, payment failed, revoked)
// drops to read-only: GETs pass, writes are blocked. Status is cached per-clinic
// to keep this off the hot DB path. Subscription-management and auth routes are
// exempt so a blocked clinic can always be reactivated. Fails open on error.
const MUTATING       = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_STATUS = new Set(['SUSPENDED', 'REVOKED', 'CHURNED']);
const STATUS_TTL_MS  = 60 * 1000;
const _statusCache   = new Map(); // clinicId → { status, expiresAt }

function isExemptPath(req) {
  const path = (req.originalUrl || '').split('?')[0];
  return path.startsWith('/v1/platform') || path.startsWith('/v1/auth');
}

async function tenantStatus(clinicId) {
  const cached = _statusCache.get(clinicId);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  const { rows } = await db.query('SELECT tenant_status FROM clinics WHERE id = $1', [clinicId]);
  const status = rows[0]?.tenant_status || null;
  _statusCache.set(clinicId, { status, expiresAt: Date.now() + STATUS_TTL_MS });
  return status;
}

module.exports = async (req, res, next) => {
  const auth = req.user;
  if (!auth) return res.status(401).json({ error: 'unauthorized' });

  const clinicId = auth.active_clinic_id || auth.clinic_id;
  if (!clinicId && auth.type !== 'platform_admin' && !auth.is_org_admin) {
    return res.status(400).json({ error: 'no_active_clinic' });
  }

  req.context = {
    orgId:     auth.org_id,
    clinicId,
    userId:    auth.sub,
    actorType: auth.type || 'user',
  };

  // Keep backward compat for routes still reading req.user.clinic_id
  req.user.clinic_id = clinicId;

  // Read-only gate: only for clinic-scoped writes, never for platform_admin,
  // and never on the subscription-management / auth escape hatches.
  if (clinicId && auth.type !== 'platform_admin' && MUTATING.has(req.method) && !isExemptPath(req)) {
    try {
      const status = await tenantStatus(clinicId);
      if (status && BLOCKED_STATUS.has(status)) {
        res.setHeader('X-Tenant-Status', status);
        return res.status(403).json({
          error:   'TENANT_SUSPENDED',
          message: 'Your subscription is inactive. Please contact your accounts admin.',
          status,
        });
      }
    } catch (_) {
      // Fail open — a status-lookup failure must not lock everyone out.
    }
  }

  next();
};

// Allow other modules (e.g. reactivation) to drop a stale cache entry.
module.exports.invalidateTenantStatus = (clinicId) => _statusCache.delete(clinicId);
