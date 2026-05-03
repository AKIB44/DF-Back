const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');
const validate     = require('../middleware/validate');
const { resolveClinicIdForOptionalAuth } = require('../helpers/public-clinic');

const router = express.Router();

const createSchema = Joi.object({
  name: Joi.string().required(),
});

const updateSchema = Joi.object({
  name:      Joi.string().required(),
  is_active: Joi.boolean().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const clinicId = resolveClinicIdForOptionalAuth(req);
    if (!clinicId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await db.query(
      `SELECT * FROM chairs WHERE clinic_id = $1 ORDER BY created_at ASC`,
      [clinicId]
    );
    res.json({ chairs: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, authorize('admin'), validate(createSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      `INSERT INTO chairs (clinic_id, name) VALUES ($1, $2) RETURNING *`,
      [req.user.clinic_id, req.body.name]
    );
    res.status(201).json({ chair: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticate, authorize('admin'), validate(updateSchema), async (req, res, next) => {
  try {
    const { name, is_active } = req.body;
    const result = await db.query(
      `UPDATE chairs SET name=$1, is_active=$2 WHERE id=$3 AND clinic_id=$4 RETURNING *`,
      [name, is_active ?? true, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Chair not found' });
    res.json({ chair: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const conflict = await db.query(
      `SELECT id FROM appointments
       WHERE chair_id = $1
         AND status IN ('booked','confirmed')
         AND scheduled_at > now()
       LIMIT 1`,
      [req.params.id]
    );
    if (conflict.rows.length) {
      return res.status(409).json({ error: 'Chair has upcoming appointments' });
    }

    await db.query(`DELETE FROM chairs WHERE id=$1 AND clinic_id=$2`, [req.params.id, req.user.clinic_id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
