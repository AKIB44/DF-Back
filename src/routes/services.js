const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');
const validate     = require('../middleware/validate');

const router = express.Router();

const createSchema = Joi.object({
  name:             Joi.string().required(),
  duration_minutes: Joi.number().integer().min(1).max(480).required(),
  price:            Joi.number().min(0).required(),
  description:      Joi.string().optional().allow(''),
});

const updateSchema = createSchema.keys({
  is_active: Joi.boolean().optional(),
});

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM services WHERE clinic_id = $1 ORDER BY name ASC`,
      [req.user.clinic_id]
    );
    res.json({ services: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', authorize('admin'), validate(createSchema), async (req, res, next) => {
  try {
    const { name, duration_minutes, price, description } = req.body;
    const result = await db.query(
      `INSERT INTO services (clinic_id, name, duration_minutes, price, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.clinic_id, name, duration_minutes, price, description || null]
    );
    res.status(201).json({ service: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authorize('admin'), validate(updateSchema), async (req, res, next) => {
  try {
    const { name, duration_minutes, price, description, is_active } = req.body;
    const result = await db.query(
      `UPDATE services SET name=$1, duration_minutes=$2, price=$3, description=$4, is_active=$5
       WHERE id=$6 AND clinic_id=$7 RETURNING *`,
      [name, duration_minutes, price, description || null, is_active ?? true, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Service not found' });
    res.json({ service: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    const conflict = await db.query(
      `SELECT id FROM appointments
       WHERE service_id = $1
         AND status NOT IN ('cancelled','no_show')
         AND scheduled_at > now()
       LIMIT 1`,
      [req.params.id]
    );
    if (conflict.rows.length) {
      return res.status(409).json({ error: 'Service has upcoming appointments' });
    }

    await db.query(`DELETE FROM services WHERE id=$1 AND clinic_id=$2`, [req.params.id, req.user.clinic_id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
