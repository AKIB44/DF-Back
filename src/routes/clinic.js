const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');
const validate     = require('../middleware/validate');

const router = express.Router();

/** Anonymous booking: default clinic when ?clinic= is omitted. Must stay above authenticate. */
router.get('/public', async (req, res, next) => {
  try {
    let id = process.env.DEFAULT_CLINIC_ID;
    if (!id) {
      const first = await db.query(
        `SELECT id FROM clinics WHERE is_active = true ORDER BY created_at ASC LIMIT 1`
      );
      if (first.rows.length) id = first.rows[0].id;
    }
    if (!id) {
      return res.status(404).json({ error: 'No clinic available for public booking' });
    }
    const result = await db.query(
      `SELECT id, name, city, phone, email FROM clinics WHERE id = $1 AND is_active = true`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    res.json({ clinic: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const updateSchema = Joi.object({
  name:     Joi.string().required(),
  phone:    Joi.string().required(),
  email:    Joi.string().email().required(),
  address:  Joi.string().required(),
  city:     Joi.string().required(),
  state:    Joi.string().optional(),
  logo_url: Joi.string().uri().optional().allow(''),
});

router.use(authenticate, authorize('admin'));

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(`SELECT * FROM clinics WHERE id = $1`, [req.user.clinic_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ clinic: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/', validate(updateSchema), async (req, res, next) => {
  try {
    const { name, phone, email, address, city, state, logo_url } = req.body;
    const result = await db.query(
      `UPDATE clinics SET name=$1, phone=$2, email=$3, address=$4, city=$5, state=$6, logo_url=$7
       WHERE id = $8 RETURNING *`,
      [name, phone, email, address, city, state || null, logo_url || null, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ clinic: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
