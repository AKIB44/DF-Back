const { verifyAccess } = require('../auth/jwt.service');
const db = require('../db');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = verifyAccess(header.slice(7));

    // Reject stale tokens (role_version bump)
    if (payload.type === 'user' && payload.rv !== undefined) {
      const { rows } = await db.query(
        `SELECT role_version, status_rbac, is_active FROM users WHERE id = $1`,
        [payload.sub]
      );
      const u = rows[0];
      if (!u || !u.is_active || u.status_rbac === 'disabled' || u.status_rbac === 'locked') {
        return res.status(401).json({ error: 'inactive' });
      }
      if (u.role_version > payload.rv) {
        return res.status(401).json({ error: 'token_stale' });
      }
    }

    req.user = payload;
    // Backward-compat: old routes use req.user.clinic_id
    if (!req.user.clinic_id) req.user.clinic_id = payload.active_clinic_id;

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
