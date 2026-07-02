const { resolvePermissions } = require('./permission.resolver');
const { isOrgAdminCached } = require('../auth/auth.helpers');

function requirePermission(code, opts = {}) {
  return async (req, res, next) => {
    // Platform admins bypass all permission checks
    if (req.user?.type === 'platform_admin') return next();

    // Org admins have implicit org.manage permission — no clinic context required
    if (req.user?.is_org_admin && code === 'org.manage') return next();

    const { userId, clinicId } = req.context || {};
    if (!userId || !clinicId) {
      return res.status(400).json({ error: 'no_active_clinic' });
    }

    // Org admins are the top of their tenant and implicitly hold every org
    // permission (mirrors the org_admin role, which is granted all permissions
    // except platform.manage). Bypass the role lookup so a missing or stale role
    // assignment / cached permission set can't lock an org admin out of their
    // own org. Clinic context (above) and step-up (below) still apply.
    if (req.user?.is_org_admin && code !== 'platform.manage') {
      if (opts.sensitive && !req.user.stepUpAt) {
        return res.status(401).json({ error: 'step_up_required' });
      }
      req.permissionGranted = { code, scope: 'org' };
      return next();
    }

    try {
      const perms   = await resolvePermissions(userId, clinicId);
      const granted = perms[code];

      if (!granted) {
        // Before denying, re-derive org-admin from the DB (authoritative) — the
        // JWT `is_org_admin` claim can be stale (e.g. promoted after login).
        if (code !== 'platform.manage' && await isOrgAdminCached(userId)) {
          if (opts.sensitive && !req.user.stepUpAt) {
            return res.status(401).json({ error: 'step_up_required' });
          }
          req.permissionGranted = { code, scope: 'org' };
          return next();
        }
        if (req.audit) {
          req.audit.write({ action: code, result: 'denied' }).catch(() => {});
        }
        return res.status(403).json({ error: 'forbidden', code });
      }

      req.permissionGranted = { code, scope: granted.scope };

      // Sensitive permissions require step-up auth
      if (opts.sensitive && !req.user.stepUpAt) {
        return res.status(401).json({ error: 'step_up_required' });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requirePermission };
