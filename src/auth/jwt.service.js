const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const SESSION_SECS = 12 * 60 * 60; // 12-hour hard session boundary

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Sign access + refresh tokens.
 * loginAt (Unix seconds) pins the session start; both tokens expire at loginAt + 12h.
 * Passing loginAt from a previous token preserves the session window on refresh/switchClinic.
 */
function signTokens(user, availableClinics, isOrgAdmin = false, loginAt = null) {
  const now          = Math.floor(Date.now() / 1000);
  const sessionStart = loginAt ?? now;
  const sessionExp   = sessionStart + SESSION_SECS;
  const remaining    = Math.max(60, sessionExp - now); // never < 1 min

  const payload = {
    sub:               user.id,
    type:              'user',
    org_id:            user.org_id,
    clinic_id:         user.clinic_id,
    active_clinic_id:  user.clinic_id,
    available_clinics: availableClinics || [user.clinic_id],
    rv:                user.role_version || 1,
    is_org_admin:      isOrgAdmin,
    login_at:          sessionStart,
  };

  const access_token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: remaining,
  });

  const refresh_token = jwt.sign(
    { sub: user.id, type: 'refresh', login_at: sessionStart },
    process.env.REFRESH_SECRET,
    { expiresIn: remaining }
  );

  return { access_token, refresh_token };
}

function verifyAccess(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function verifyRefresh(token) {
  return jwt.verify(token, process.env.REFRESH_SECRET);
}

function decodeExp(token) {
  return jwt.decode(token)?.exp;
}

module.exports = { signTokens, verifyAccess, verifyRefresh, hashToken, decodeExp, SESSION_SECS };
