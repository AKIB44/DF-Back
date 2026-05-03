const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');
const validate     = require('../middleware/validate');

const router = express.Router();

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
