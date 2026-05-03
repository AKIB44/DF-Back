const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');

const router = express.Router();

const patientSchema = Joi.object({
  name:    Joi.string().required(),
  phone:   Joi.string().required(),
  email:   Joi.string().email().optional().allow(''),
  dob:     Joi.string().isoDate().optional(),
  gender:  Joi.string().valid('male', 'female', 'other').optional(),
  address: Joi.string().optional(),
});

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { search, limit = 20 } = req.query;
    const cap = Math.min(Number(limit) || 20, 100);

    let result;
    if (search) {
      result = await db.query(
        `SELECT * FROM patients
         WHERE clinic_id = $1
           AND (name ILIKE '%' || $2 || '%' OR phone ILIKE '%' || $2 || '%')
         ORDER BY name ASC LIMIT $3`,
        [req.user.clinic_id, search, cap]
      );
    } else {
      result = await db.query(
        `SELECT * FROM patients WHERE clinic_id = $1 ORDER BY name ASC LIMIT $2`,
        [req.user.clinic_id, cap]
      );
    }
    res.json({ patients: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(patientSchema), async (req, res, next) => {
  try {
    const { name, phone, email, dob, gender, address } = req.body;

    const dup = await db.query(
      `SELECT id FROM patients WHERE clinic_id = $1 AND phone = $2`,
      [req.user.clinic_id, phone]
    );
    if (dup.rows.length) {
      return res.status(409).json({
        error: 'Patient with this phone already exists',
        existing_id: dup.rows[0].id,
      });
    }

    const result = await db.query(
      `INSERT INTO patients (clinic_id, name, phone, email, dob, gender, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.clinic_id, name, phone, email || null, dob || null, gender || null, address || null]
    );
    res.status(201).json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const patResult = await db.query(
      `SELECT * FROM patients WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!patResult.rows.length) return res.status(404).json({ error: 'Patient not found' });

    const apptResult = await db.query(
      `SELECT a.*, s.name AS service_name
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.patient_id = $1
       ORDER BY a.scheduled_at DESC
       LIMIT 5`,
      [req.params.id]
    );

    res.json({ patient: patResult.rows[0], recent_appointments: apptResult.rows });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(patientSchema), async (req, res, next) => {
  try {
    const { name, phone, email, dob, gender, address } = req.body;
    const result = await db.query(
      `UPDATE patients SET name=$1, phone=$2, email=$3, dob=$4, gender=$5, address=$6
       WHERE id=$7 AND clinic_id=$8 RETURNING *`,
      [name, phone, email || null, dob || null, gender || null, address || null, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
