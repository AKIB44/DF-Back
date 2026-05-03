const express  = require('express');
const bcrypt   = require('bcryptjs');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');
const validate     = require('../middleware/validate');

const router = express.Router();

const SAFE_COLS = 'id, clinic_id, first_name, last_name, email, role, is_active, created_at';

const createSchema = Joi.object({
  first_name: Joi.string().required(),
  last_name:  Joi.string().optional().default(''),
  email:      Joi.string().email().required(),
  role:       Joi.string().valid('admin', 'doctor', 'receptionist').required(),
  password:   Joi.string().min(8).required(),
});

const updateSchema = Joi.object({
  first_name: Joi.string().optional(),
  last_name:  Joi.string().optional(),
  email:      Joi.string().trim().email().optional(),
  role:       Joi.string().valid('admin', 'doctor', 'receptionist').optional(),
  is_active:  Joi.boolean().optional(),
});

const patchSchema = Joi.object({
  is_active: Joi.boolean().required(),
});

router.use(authenticate, authorize('admin'));

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT ${SAFE_COLS} FROM users WHERE clinic_id = $1 ORDER BY created_at ASC`,
      [req.user.clinic_id]
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const { first_name, last_name, email, role, password } = req.body;

    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (clinic_id, first_name, last_name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${SAFE_COLS}`,
      [req.user.clinic_id, first_name, last_name || '', email, password_hash, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(updateSchema), async (req, res, next) => {
  try {
    const { first_name, last_name, role, is_active } = req.body;
    const email =
      req.body.email === undefined
        ? undefined
        : String(req.body.email).trim().toLowerCase();

    if (email !== undefined) {
      const dup = await db.query(
        `SELECT id FROM users WHERE lower(trim(email)) = $1 AND id <> $2`,
        [email, req.params.id]
      );
      if (dup.rows.length) {
        return res.status(409).json({ error: 'Email already in use' });
      }
    }

    const result = await db.query(
      `UPDATE users SET
         first_name = COALESCE($1, first_name),
         last_name  = COALESCE($2, last_name),
         email      = COALESCE($3, email),
         role       = COALESCE($4, role),
         is_active  = COALESCE($5, is_active)
       WHERE id=$6 AND clinic_id=$7
       RETURNING ${SAFE_COLS}`,
      [first_name, last_name, email, role, is_active, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', validate(patchSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_active=$1 WHERE id=$2 AND clinic_id=$3 RETURNING ${SAFE_COLS}`,
      [req.body.is_active, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
