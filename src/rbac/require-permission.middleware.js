const { resolvePermissions } = require('./permission.resolver');

function requirePermission(code, opts = {}) {
  return async (req, res, next) => {
    // Platform admins bypass all permission checks
    if (req.user?.type === 'platform_admin') return next();

    const { userId, clinicId } = req.context || {};
    if (!userId || !clinicId) {
      return res.status(400).json({ error: 'no_active_clinic' });
    }

    try {
      const perms   = await resolvePermissions(userId, clinicId);
      const granted = perms[code];

      if (!granted) {
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
