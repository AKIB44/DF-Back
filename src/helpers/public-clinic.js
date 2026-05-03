const jwt = require('jsonwebtoken');
const { validate: isUuid } = require('uuid');

/**
 * For GET list routes shared by staff (Bearer) and public booking (?clinic_id=<uuid>).
 * Prefer JWT clinic when the user is logged in.
 */
function resolveClinicIdForOptionalAuth(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      if (decoded.clinic_id) return decoded.clinic_id;
    } catch {
      /* treat as anonymous */
    }
  }
  const q = req.query.clinic_id;
  if (q && typeof q === 'string' && isUuid(q)) return q;
  return null;
}

module.exports = { resolveClinicIdForOptionalAuth };
