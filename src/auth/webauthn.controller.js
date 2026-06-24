const jwt = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('../db');

// ── Relying-Party config ──────────────────────────────────────────────────────
// Origins the browser may run on (reuse the CORS allow-list).
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:4200')
  .split(',').map((s) => s.trim()).filter(Boolean);

// The browser requires rpID to be a registrable suffix of the page's origin.
// Resolve the origin for THIS request from its Origin header (validated against
// the allow-list) rather than assuming ORIGINS[0] — otherwise a dev origin left
// first in ALLOWED_ORIGINS (e.g. http://localhost:4200) leaks "localhost" into
// production and the authenticator rejects it. WEBAUTHN_RP_ID still overrides
// for apex-vs-www / shared-suffix setups.
function originFor(req) {
  const o = req && req.headers && req.headers.origin;
  if (o && ORIGINS.includes(o)) return o;
  return ORIGINS[0];
}
function rpID(req) {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID;
  try { return new URL(originFor(req)).hostname; } catch { return 'localhost'; }
}
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'DentaFlow';
// Grant is re-minted on every visit to the gated screen; lifetime only needs to
// outlast a single browsing session (pagination/filtering) without re-prompting.
const BIOMETRIC_TOKEN_TTL = '15m';

async function saveChallenge(userId, challenge, purpose) {
  await db.query(
    `INSERT INTO user_webauthn_challenge (user_id, challenge, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + interval '5 minutes')
     ON CONFLICT (user_id) DO UPDATE
       SET challenge = EXCLUDED.challenge, purpose = EXCLUDED.purpose, expires_at = EXCLUDED.expires_at`,
    [userId, challenge, purpose]
  );
}

async function takeChallenge(userId, purpose) {
  const { rows } = await db.query(
    `DELETE FROM user_webauthn_challenge
     WHERE user_id = $1 AND purpose = $2 AND expires_at > NOW()
     RETURNING challenge`,
    [userId, purpose]
  );
  return rows[0]?.challenge || null;
}

// ── Registration ──────────────────────────────────────────────────────────────
async function registerOptions(req, res, next) {
  try {
    const userId = req.user.sub;
    const { rows: creds } = await db.query(
      `SELECT credential_id, transports FROM user_webauthn_credential WHERE user_id = $1`,
      [userId]
    );
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpID(req),
      userID: new TextEncoder().encode(userId),
      userName: req.user.email || userId,
      userDisplayName: req.user.display_name || req.user.email || 'User',
      attestationType: 'none',
      excludeCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: c.transports || undefined,
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // built-in biometric (Touch ID / Face ID)
        residentKey: 'discouraged',
        userVerification: 'required',
      },
    });
    await saveChallenge(userId, options.challenge, 'register');
    res.json(options);
  } catch (err) { next(err); }
}

async function registerVerify(req, res, next) {
  try {
    const userId = req.user.sub;
    const expectedChallenge = await takeChallenge(userId, 'register');
    if (!expectedChallenge) return res.status(400).json({ error: 'challenge_expired' });

    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: ORIGINS,
      expectedRPID: rpID(req),
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'verification_failed' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const label = String(req.body.device_label || '').slice(0, 80) || 'This device';

    await db.query(
      `INSERT INTO user_webauthn_credential
         (user_id, org_id, credential_id, public_key, counter, transports, device_type, backed_up, device_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (credential_id) DO NOTHING`,
      [
        userId,
        req.user.org_id || null,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports || null,
        credentialDeviceType || null,
        !!credentialBackedUp,
        label,
      ]
    );
    res.status(201).json({ enrolled: true });
  } catch (err) { next(err); }
}

// ── Enrolled-device management ────────────────────────────────────────────────
async function listCredentials(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, device_label, device_type, backed_up, created_at, last_used_at
       FROM user_webauthn_credential WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.sub]
    );
    res.json({ credentials: rows });
  } catch (err) { next(err); }
}

async function deleteCredential(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM user_webauthn_credential WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
}

// ── Authentication (step-up) ──────────────────────────────────────────────────
async function authOptions(req, res, next) {
  try {
    const userId = req.user.sub;
    const { rows: creds } = await db.query(
      `SELECT credential_id, transports FROM user_webauthn_credential WHERE user_id = $1`,
      [userId]
    );
    if (!creds.length) return res.status(409).json({ error: 'not_enrolled' });

    const options = await generateAuthenticationOptions({
      rpID: rpID(req),
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: c.transports || undefined,
      })),
    });
    await saveChallenge(userId, options.challenge, 'authenticate');
    res.json(options);
  } catch (err) { next(err); }
}

async function authVerify(req, res, next) {
  try {
    const userId = req.user.sub;
    const expectedChallenge = await takeChallenge(userId, 'authenticate');
    if (!expectedChallenge) return res.status(400).json({ error: 'challenge_expired' });

    const response = req.body.response;
    const { rows } = await db.query(
      `SELECT id, credential_id, public_key, counter, transports
       FROM user_webauthn_credential WHERE user_id = $1 AND credential_id = $2`,
      [userId, response?.id]
    );
    const stored = rows[0];
    if (!stored) return res.status(404).json({ error: 'unknown_credential' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGINS,
      expectedRPID: rpID(req),
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.counter),
        transports: stored.transports || undefined,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'verification_failed' });

    await db.query(
      `UPDATE user_webauthn_credential SET counter = $1, last_used_at = NOW() WHERE id = $2`,
      [verification.authenticationInfo.newCounter, stored.id]
    );

    // Short-lived grant proving a fresh biometric step-up. Consumed by the
    // requireBiometric middleware guarding the activity-log route.
    const biometric_token = jwt.sign(
      { sub: userId, purpose: 'audit_unlock', auth_at: Math.floor(Date.now() / 1000) },
      process.env.JWT_SECRET,
      { expiresIn: BIOMETRIC_TOKEN_TTL }
    );
    res.json({ biometric_token });
  } catch (err) { next(err); }
}

module.exports = {
  registerOptions, registerVerify, listCredentials, deleteCredential, authOptions, authVerify,
};
