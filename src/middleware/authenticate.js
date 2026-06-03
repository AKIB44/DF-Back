const { verifyAccess, SESSION_SECS } = require('../auth/jwt.service');
const db = require('../db');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = verifyAccess(header.slice(7));

    // Hard 12h session boundary — belt-and-suspenders on top of token expiry
    if (payload.login_at) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.login_at + SESSION_SECS <= now) {
        return res.status(401).json({ error: 'session_expired' });
      }
    }

    req.user = payload;
    // Backward-compat: old routes use req.user.clinic_id
    if (!req.user.clinic_id) req.user.clinic_id = payload.active_clinic_id;

    if (payload.type === 'user' && payload.sub) {
      const { rows } = await db.query(
        `SELECT role_version, status_rbac, is_active, first_name, last_name, email, role
         FROM users WHERE id = $1`,
        [payload.sub]
      );
      const u = rows[0];
      if (!u || !u.is_active || u.status_rbac === 'disabled' || u.status_rbac === 'locked') {
        return res.status(401).json({ error: 'inactive' });
      }
      if (payload.rv !== undefined && u.role_version > payload.rv) {
        return res.status(401).json({ error: 'token_stale' });
      }
      req.user.first_name = u.first_name;
      req.user.last_name  = u.last_name;
      req.user.email      = u.email;
      req.user.role       = u.role;
      req.user.display_name =
        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null;
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
