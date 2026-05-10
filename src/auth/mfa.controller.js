const { generate: totpGenerate, verify: totpVerify, generateSecret, generateURI } = require('otplib');
const qrcode  = require('qrcode');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const { signTokens, hashToken, decodeExp } = require('./jwt.service');
const { checkIsOrgAdmin, getAvailableClinics } = require('./auth.helpers');

const APP_NAME = process.env.MFA_ISSUER || 'DentaFlow';

// ── helpers ──────────────────────────────────────────────────────────────────

function issueMfaToken(userId) {
  return jwt.sign(
    { sub: userId, type: 'mfa_challenge' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

function verifyMfaToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.type !== 'mfa_challenge') throw new Error('wrong token type');
  return payload;
}

// ── GET /auth/mfa/status ──────────────────────────────────────────────────────
async function mfaStatus(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT mfa_enabled FROM users WHERE id = $1`,
      [req.user.sub]
    );
    res.json({ mfa_enabled: rows[0]?.mfa_enabled ?? false });
  } catch (err) {
    next(err);
  }
}

// ── POST /auth/mfa/setup ─────────────────────────────────────────────────────
// Generates a new TOTP secret and returns QR code (does NOT enable MFA yet).
async function setupMfa(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT email, mfa_enabled FROM users WHERE id = $1`,
      [req.user.sub]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const secret  = generateSecret();
    const otpauth = generateURI({ secret, account: user.email, issuer: APP_NAME, label: user.email, encoding: 'base32' });
    const qr_data_url = await qrcode.toDataURL(otpauth);

    // Persist the pending secret (not yet enabled — user must verify first)
    await db.query(
      `UPDATE users SET mfa_secret = $1 WHERE id = $2`,
      [secret, req.user.sub]
    );

    res.json({
      secret,          // show as text fallback for manual entry
      qr_data_url,     // base64 PNG data URL
      already_enabled: user.mfa_enabled,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /auth/mfa/enable ─────────────────────────────────────────────────────
// Verifies the TOTP code against the pending secret, then activates MFA.
async function enableMfa(req, res, next) {
  try {
    const code = String(req.body.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) {
      return res.status(400).json({ error: 'code must be 6 digits' });
    }

    const { rows } = await db.query(
      `SELECT mfa_secret FROM users WHERE id = $1`,
      [req.user.sub]
    );
    const secret = rows[0]?.mfa_secret;
    if (!secret) {
      return res.status(400).json({ error: 'Run /auth/mfa/setup first' });
    }

    const result = await totpVerify({ token: code, secret, encoding: 'base32' });
    if (!result?.valid) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    await db.query(
      `UPDATE users SET mfa_enabled = true WHERE id = $1`,
      [req.user.sub]
    );

    res.json({ mfa_enabled: true });
  } catch (err) {
    next(err);
  }
}

// ── POST /auth/mfa/disable ────────────────────────────────────────────────────
// Requires password + current TOTP to disable.
async function disableMfa(req, res, next) {
  try {
    const password = String(req.body.password ?? '').trim();
    const code     = String(req.body.code ?? '').replace(/\D/g, '');

    if (!password || code.length !== 6) {
      return res.status(400).json({ error: 'password and 6-digit code required' });
    }

    const { rows } = await db.query(
      `SELECT password_hash, mfa_secret, mfa_enabled FROM users WHERE id = $1`,
      [req.user.sub]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled' });

    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const result = await totpVerify({ token: code, secret: user.mfa_secret, encoding: 'base32' });
    if (!result?.valid) {
      return res.status(401).json({ error: 'Invalid authenticator code' });
    }

    await db.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`,
      [req.user.sub]
    );

    res.json({ mfa_enabled: false });
  } catch (err) {
    next(err);
  }
}

// ── POST /auth/mfa/challenge ──────────────────────────────────────────────────
// Second step: validates TOTP, then issues full access + refresh tokens.
async function challengeMfa(req, res, next) {
  try {
    const mfaToken = String(req.body.mfa_token ?? '');
    const code     = String(req.body.code ?? '').replace(/\D/g, '');

    if (!mfaToken || code.length !== 6) {
      return res.status(400).json({ error: 'mfa_token and 6-digit code required' });
    }

    let payload;
    try {
      payload = verifyMfaToken(mfaToken);
    } catch {
      return res.status(401).json({ error: 'MFA session expired. Please log in again.' });
    }

    const { rows } = await db.query(
      `SELECT * FROM users WHERE id = $1 AND is_active = true`,
      [payload.sub]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    if (!user.mfa_secret || !user.mfa_enabled) {
      return res.status(400).json({ error: 'MFA not configured for this account' });
    }

    const result = await totpVerify({ token: code, secret: user.mfa_secret, encoding: 'base32' });
    if (!result?.valid) {
      return res.status(401).json({ error: 'Invalid authenticator code' });
    }

    await db.query(
      `UPDATE users SET last_login_at = now(), failed_login_count = 0 WHERE id = $1`,
      [user.id]
    );

    const isOrgAdmin      = await checkIsOrgAdmin(user.id);
    const availableClinics = await getAvailableClinics(user.id);
    if (!availableClinics.includes(user.clinic_id) && user.clinic_id) {
      availableClinics.push(user.clinic_id);
    }

    const { access_token, refresh_token } = signTokens(user, availableClinics, isOrgAdmin);

    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [crypto.randomUUID(), user.id, hashToken(refresh_token), decodeExp(refresh_token)]
    );

    res.json({
      access_token,
      refresh_token,
      user: {
        id:               user.id,
        email:            user.email,
        first_name:       user.first_name,
        last_name:        user.last_name,
        role:             user.role,
        clinic_id:        user.clinic_id,
        active_clinic_id: user.clinic_id,
        org_id:           user.org_id,
        available_clinics: availableClinics,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { mfaStatus, setupMfa, enableMfa, disableMfa, challengeMfa, issueMfaToken };
