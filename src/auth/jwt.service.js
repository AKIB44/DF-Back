const jwt = require('jsonwebtoken');
const crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signTokens(user, availableClinics, isOrgAdmin = false) {
  const payload = {
    sub:               user.id,
    type:              'user',
    org_id:            user.org_id,
    clinic_id:         user.clinic_id,
    active_clinic_id:  user.clinic_id,
    available_clinics: availableClinics || [user.clinic_id],
    rv:                user.role_version || 1,
    is_org_admin:      isOrgAdmin,
  };

  const access_token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });

  const refresh_token = jwt.sign(
    { sub: user.id, type: 'refresh' },
    process.env.REFRESH_SECRET,
    { expiresIn: process.env.REFRESH_EXPIRES_IN || '7d' }
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

module.exports = { signTokens, verifyAccess, verifyRefresh, hashToken, decodeExp };
