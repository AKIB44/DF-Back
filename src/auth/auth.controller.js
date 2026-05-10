const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');
const { signTokens, verifyRefresh, hashToken, decodeExp } = require('./jwt.service');
const { checkIsOrgAdmin, getAvailableClinics } = require('./auth.helpers');
const { issueMfaToken } = require('./mfa.controller');
const { bumpVersion } = require('../rbac/permission.cache');
const { sendOtp }     = require('../services/fast2sms');

const OTP_TTL_MINUTES  = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECS  = 60;

function generateOtp() {
  return String(Math.floor(100000 + crypto.randomInt(900000)));
}

function hashOtp(otp) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'otp-secret')
    .update(otp)
    .digest('hex');
}

function normalizeEmail(s) {
  return String(s).trim().toLowerCase().normalize('NFKC').replace(/[​-‍﻿]/g, '');
}

// Blocks login when the user's clinic is inactive.
// isOrgAdmin flag is resolved once before this is called.
async function assertClinicActive(user, isOrgAdmin) {
  if (!user.clinic_id) return;   // no clinic assigned — org-level user
  if (isOrgAdmin) return;        // org admins are never blocked by clinic status

  const { rows } = await db.query(
    `SELECT is_active FROM clinics WHERE id = $1`,
    [user.clinic_id]
  );
  if (!rows.length || !rows[0].is_active) {
    const err = new Error('clinic_inactive');
    err.status = 403;
    err.code   = 'clinic_inactive';
    throw err;
  }
}

async function login(req, res, next) {
  try {
    const email    = normalizeEmail(req.body.email ?? req.body.username ?? '');
    const password = String(req.body.password ?? '').trim();

    const { rows } = await db.query(
      `SELECT * FROM users WHERE lower(trim(email)) = $1 AND is_active = true`,
      [email]
    );
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      if (user) {
        await db.query(
          `UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1`,
          [user.id]
        );
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.status_rbac === 'disabled' || user.status_rbac === 'locked') {
      return res.status(401).json({ error: 'Account inactive' });
    }

    const isOrgAdmin = await checkIsOrgAdmin(user.id);
    await assertClinicActive(user, isOrgAdmin);

    // MFA gate — org admins with MFA enabled must complete TOTP challenge
    if (user.mfa_enabled) {
      const mfa_token = issueMfaToken(user.id);
      return res.json({ mfa_required: true, mfa_token });
    }

    await db.query(
      `UPDATE users SET last_login_at = now(), failed_login_count = 0 WHERE id = $1`,
      [user.id]
    );

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
        id:                user.id,
        email:             user.email,
        first_name:        user.first_name,
        last_name:         user.last_name,
        role:              user.role,
        clinic_id:         user.clinic_id,
        active_clinic_id:  user.clinic_id,
        org_id:            user.org_id,
        available_clinics: availableClinics,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(401).json({ error: 'Missing refresh_token' });

    let payload;
    try {
      payload = verifyRefresh(refresh_token);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const tokenHash = hashToken(refresh_token);
    const { rows: stored } = await db.query(
      `SELECT id FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash]
    );
    if (!stored.length) return res.status(401).json({ error: 'Refresh token not recognised' });

    await db.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]);

    const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [payload.sub]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const isOrgAdmin = await checkIsOrgAdmin(user.id);
    await assertClinicActive(user, isOrgAdmin);

    const availableClinics = await getAvailableClinics(user.id);
    if (!availableClinics.includes(user.clinic_id) && user.clinic_id) {
      availableClinics.push(user.clinic_id);
    }

    const { access_token, refresh_token: new_refresh } = signTokens(user, availableClinics, isOrgAdmin);

    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [crypto.randomUUID(), user.id, hashToken(new_refresh), decodeExp(new_refresh)]
    );

    res.json({ access_token, refresh_token: new_refresh });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      await db.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hashToken(refresh_token)]);
    } else {
      await db.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [req.user.sub]);
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, email, first_name, last_name, role, clinic_id, org_id, designation
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const availableClinics = await getAvailableClinics(user.id);
    if (!availableClinics.includes(user.clinic_id) && user.clinic_id) {
      availableClinics.push(user.clinic_id);
    }

    res.json({ ...user, available_clinics: availableClinics });
  } catch (err) {
    next(err);
  }
}

async function myPermissions(req, res, next) {
  try {
    const { resolvePermissions } = require('../rbac/permission.resolver');
    const clinicId = req.query.clinicId || req.context?.clinicId;
    const permissions = await resolvePermissions(req.user.sub, clinicId);

    // Org admins always have org.manage regardless of clinic context.
    if (req.user.is_org_admin) {
      permissions['org.manage'] = { scope: 'org' };
    }

    res.json({ permissions });
  } catch (err) {
    next(err);
  }
}

async function switchClinic(req, res, next) {
  try {
    const { clinicId } = req.body;
    if (!clinicId) return res.status(400).json({ error: 'clinicId required' });

    const available = req.user.available_clinics || [];
    if (!available.includes(clinicId)) {
      return res.status(403).json({ error: 'Clinic not in your access list' });
    }

    const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [req.user.sub]);
    const user = { ...rows[0], clinic_id: clinicId };

    const { access_token, refresh_token } = signTokens(user, available, req.user.is_org_admin || false);

    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [crypto.randomUUID(), user.id, hashToken(refresh_token), decodeExp(refresh_token)]
    );

    res.json({ access_token, refresh_token });
  } catch (err) {
    next(err);
  }
}

async function stepUp(req, res, next) {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });

    const { rows } = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.sub]);
    if (!rows[0] || !(await bcrypt.compare(String(password).trim(), rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const payload = { ...req.user, stepUpAt: Math.floor(Date.now() / 1000) };
    const jwt = require('jsonwebtoken');
    const step_up_token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5m' });

    res.json({ access_token: step_up_token });
  } catch (err) {
    next(err);
  }
}

// ── OTP: request ─────────────────────────────────────────────────────────────
async function requestOtp(req, res, next) {
  try {
    const phone = String(req.body.phone ?? '').replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    }

    // Look up active user by phone
    const { rows: users } = await db.query(
      `SELECT id, phone, status_rbac FROM users WHERE phone = $1 AND is_active = true LIMIT 1`,
      [phone]
    );
    if (!users.length) {
      // Return same response to avoid phone enumeration
      return res.json({ sent: true });
    }
    const user = users[0];

    if (user.status_rbac === 'disabled' || user.status_rbac === 'locked') {
      return res.status(403).json({ error: 'Account inactive or locked' });
    }

    // Rate limit: block if a valid OTP was sent in the last OTP_RESEND_SECS
    const { rows: recent } = await db.query(
      `SELECT id FROM otp_requests
       WHERE user_id = $1 AND used = false AND expires_at > now()
         AND created_at > now() - interval '${OTP_RESEND_SECS} seconds'
       LIMIT 1`,
      [user.id]
    );
    if (recent.length) {
      return res.status(429).json({ error: `Please wait ${OTP_RESEND_SECS}s before requesting another OTP` });
    }

    // Invalidate any previous unused OTPs for this user
    await db.query(
      `UPDATE otp_requests SET used = true WHERE user_id = $1 AND used = false`,
      [user.id]
    );

    const otp = generateOtp();
    const id  = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await db.query(
      `INSERT INTO otp_requests
         (id, user_id, code_hash, expires_at, used, destination_phone, attempts_used, max_attempts, channel, provider)
       VALUES ($1,$2,$3,$4,false,$5,0,$6,'sms','fast2sms')`,
      [id, user.id, hashOtp(otp), expiresAt, phone, OTP_MAX_ATTEMPTS]
    );

    const result = await sendOtp(phone, otp);

    await db.query(
      `UPDATE otp_requests
       SET provider_status = $1, provider_message_id = $2, provider_error = $3
       WHERE id = $4`,
      [
        result.success ? 'sent' : 'failed',
        result.requestId ?? null,
        result.error     ?? null,
        id,
      ]
    );

    if (!result.success) {
      console.error('[otp] fast2sms send failed:', result.error, 'code:', result.providerCode);
      // Surface actionable provider errors to the caller
      if (result.providerCode === 999) {
        return res.status(502).json({ error: 'SMS account needs a recharge. Contact your admin.' });
      }
      if (result.providerCode === 996) {
        return res.status(502).json({ error: 'SMS OTP route not verified. Contact your admin.' });
      }
      return res.status(502).json({ error: 'Failed to send OTP. Please try again.' });
    }

    return res.json({ sent: true });
  } catch (err) {
    next(err);
  }
}

// ── OTP: verify ───────────────────────────────────────────────────────────────
async function verifyOtp(req, res, next) {
  try {
    const phone = String(req.body.phone ?? '').replace(/\D/g, '').slice(-10);
    const otp   = String(req.body.otp ?? '').replace(/\D/g, '');

    if (phone.length !== 10 || otp.length !== 6) {
      return res.status(400).json({ error: 'Invalid phone or OTP format' });
    }

    // Find the active OTP request (cast user_id varchar → uuid for join)
    const { rows } = await db.query(
      `SELECT r.id, r.user_id, r.code_hash, r.attempts_used, r.max_attempts
       FROM otp_requests r
       JOIN users u ON u.id = r.user_id::uuid
       WHERE r.destination_phone = $1
         AND r.used = false
         AND r.expires_at > now()
         AND u.is_active = true
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [phone]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'OTP expired or not found. Request a new one.' });
    }

    const record = rows[0];

    // Bump attempt counter first
    await db.query(
      `UPDATE otp_requests SET attempts_used = attempts_used + 1 WHERE id = $1`,
      [record.id]
    );

    if (record.attempts_used + 1 > record.max_attempts) {
      await db.query(`UPDATE otp_requests SET used = true WHERE id = $1`, [record.id]);
      return res.status(401).json({ error: 'Too many incorrect attempts. Request a new OTP.' });
    }

    if (hashOtp(otp) !== record.code_hash) {
      const remaining = record.max_attempts - (record.attempts_used + 1);
      return res.status(401).json({
        error:     'Incorrect OTP.',
        remaining,
      });
    }

    // Valid OTP — mark consumed
    await db.query(
      `UPDATE otp_requests SET used = true, consumed_at = now() WHERE id = $1`,
      [record.id]
    );

    // Load user and issue tokens (cast varchar user_id → uuid)
    const { rows: userRows } = await db.query(
      `SELECT * FROM users WHERE id = $1::uuid`,
      [record.user_id]
    );
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const isOrgAdmin = await checkIsOrgAdmin(user.id);
    await assertClinicActive(user, isOrgAdmin);

    await db.query(
      `UPDATE users SET last_login_at = now(), failed_login_count = 0 WHERE id = $1`,
      [user.id]
    );

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

    return res.json({
      access_token,
      refresh_token,
      user: {
        id:                user.id,
        email:             user.email,
        first_name:        user.first_name,
        last_name:         user.last_name,
        role:              user.role,
        clinic_id:         user.clinic_id,
        active_clinic_id:  user.clinic_id,
        org_id:            user.org_id,
        available_clinics: availableClinics,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, refresh, logout, me, myPermissions, switchClinic, stepUp, requestOtp, verifyOtp };
