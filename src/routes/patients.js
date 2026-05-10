const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const authenticate   = require('../middleware/authenticate');
const validate       = require('../middleware/validate');
const tenantScope    = require('../rbac/tenant-scope.middleware');
const auditMw        = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P              = require('../rbac/permissions.constants');

const router = express.Router();

const patientSchema = Joi.object({
  name:             Joi.string().required(),
  phone:            Joi.string().required(),
  email:            Joi.string().email().optional().allow(''),
  dob:              Joi.string().isoDate().optional(),
  gender:           Joi.string().valid('male', 'female', 'other').optional(),
  address:          Joi.string().optional().allow(''),
  age:              Joi.number().integer().min(0).max(150).optional(),
  clinical_history: Joi.string().optional().allow(''),
});

router.use(authenticate, tenantScope, auditMw);

router.get('/', requirePermission(P.PATIENT_VIEW), async (req, res, next) => {
  try {
    const { search, service_id, limit = 20 } = req.query;
    const cap = Math.min(Number(limit) || 20, 200);

    const params = [req.user.clinic_id];
    let where = 'p.clinic_id = $1';
    let idx = 2;

    if (search) {
      where += ` AND (p.name ILIKE '%' || $${idx} || '%' OR p.phone ILIKE '%' || $${idx} || '%')`;
      params.push(search); idx++;
    }

    // Filter by service: only patients who have had at least one appointment for that service
    let serviceJoin = '';
    if (service_id) {
      serviceJoin = `JOIN appointments ap_svc ON ap_svc.patient_id = p.id AND ap_svc.service_id = $${idx}`;
      params.push(service_id); idx++;
    }

    params.push(cap);
    const result = await db.query(
      `SELECT DISTINCT p.*,
         (SELECT a.scheduled_at FROM appointments a WHERE a.patient_id = p.id ORDER BY a.scheduled_at DESC LIMIT 1) AS last_visit,
         (SELECT s.name FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.patient_id = p.id ORDER BY a.scheduled_at DESC LIMIT 1) AS last_service
       FROM patients p
       ${serviceJoin}
       WHERE ${where}
       ORDER BY p.name ASC LIMIT $${idx}`,
      params
    );
    res.json({ patients: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission(P.PATIENT_CREATE), validate(patientSchema), async (req, res, next) => {
  try {
    const { name, phone, email, dob, gender, address, age, clinical_history } = req.body;

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
      `INSERT INTO patients (clinic_id, name, phone, email, dob, gender, address, age, clinical_history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.clinic_id, name, phone, email || null, dob || null, gender || null, address || null, age ?? null, clinical_history || null]
    );
    res.status(201).json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission(P.PATIENT_VIEW), async (req, res, next) => {
  try {
    const patResult = await db.query(
      `SELECT * FROM patients WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!patResult.rows.length) return res.status(404).json({ error: 'Patient not found' });

    const { service_id } = req.query;
    const apptParams = [req.params.id];
    let apptWhere = 'a.patient_id = $1';
    if (service_id) {
      apptParams.push(service_id);
      apptWhere += ' AND a.service_id = $2';
    }

    const apptResult = await db.query(
      `SELECT a.*, s.name AS service_name, s.id AS service_id
       FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE ${apptWhere}
       ORDER BY a.scheduled_at DESC`,
      apptParams
    );

    res.json({ patient: patResult.rows[0], appointments: apptResult.rows });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requirePermission(P.PATIENT_UPDATE), validate(patientSchema), async (req, res, next) => {
  try {
    const { name, phone, email, dob, gender, address, age, clinical_history } = req.body;
    const result = await db.query(
      `UPDATE patients SET name=$1, phone=$2, email=$3, dob=$4, gender=$5, address=$6, age=$7, clinical_history=$8
       WHERE id=$9 AND clinic_id=$10 RETURNING *`,
      [name, phone, email || null, dob || null, gender || null, address || null, age ?? null, clinical_history || null, req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
