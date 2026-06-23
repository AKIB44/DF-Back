const jwt = require('jsonwebtoken');

/**
 * Gate a route behind a fresh WebAuthn (Face ID / Touch ID) step-up.
 *
 * The frontend obtains a short-lived `biometric_token` from
 * POST /auth/webauthn/auth/verify and sends it as `X-Biometric-Token`.
 * Must run AFTER `authenticate` so `req.user` is populated.
 *
 * @param {string} purpose expected token purpose, e.g. 'audit_unlock'
 */
module.exports = (purpose) => (req, res, next) => {
  const token = req.headers['x-biometric-token'];
  if (!token) return res.status(401).json({ error: 'biometric_required' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.purpose !== purpose || payload.sub !== req.user.sub) {
      return res.status(401).json({ error: 'biometric_invalid' });
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'biometric_expired' });
  }
};
