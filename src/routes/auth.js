const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');

const router = express.Router();

/** Accept `email` or `username` (many clients label the field “username” but send an email). */
const loginSchema = Joi.alternatives().try(
  Joi.object({
    email: Joi.string().trim().email().required(),
    password: Joi.string().required(),
  }),
  Joi.object({
    username: Joi.string().trim().email().required(),
    password: Joi.string().required(),
  })
);

const refreshSchema = Joi.object({
  refresh_token: Joi.string().required(),
});

function normalizeLoginEmail(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signTokens(user) {
  const payload = { sub: user.id, clinic_id: user.clinic_id, role: user.role };

  const access_token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });

  const refresh_token = jwt.sign(payload, process.env.REFRESH_SECRET, {
    expiresIn: process.env.REFRESH_EXPIRES_IN || '7d',
  });

  return { access_token, refresh_token };
}

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const email = normalizeLoginEmail(req.body.email ?? req.body.username);
    // Trim password — trailing/leading whitespace from paste breaks bcrypt.compare (401).
    const password = String(req.body.password).trim();

    const result = await db.query(
      `SELECT * FROM users WHERE lower(trim(email)) = $1 AND is_active = true`,
      [email]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const { access_token, refresh_token } = signTokens(user);

    const decoded = jwt.decode(refresh_token);
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [crypto.randomUUID(), user.id, hashToken(refresh_token), decoded.exp]
    );

    res.json({
      access_token,
      refresh_token,
      user: {
        id:         user.id,
        email:      user.email,
        first_name: user.first_name,
        last_name:  user.last_name,
        role:       user.role,
        clinic_id:  user.clinic_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', validate(refreshSchema), async (req, res, next) => {
  try {
    const { refresh_token } = req.body;

    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const tokenHash = hashToken(refresh_token);
    const stored = await db.query(
      `SELECT id FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash]
    );
    if (!stored.rows.length) return res.status(401).json({ error: 'Refresh token not recognised' });

    await db.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]);

    const userResult = await db.query(`SELECT * FROM users WHERE id = $1`, [payload.sub]);
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    const { access_token, refresh_token: new_refresh } = signTokens(user);

    const decoded = jwt.decode(new_refresh);
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [crypto.randomUUID(), user.id, hashToken(new_refresh), decoded.exp]
    );

    res.json({ access_token, refresh_token: new_refresh });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', authenticate, async (req, res, next) => {
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
});

module.exports = router;
