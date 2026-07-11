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
  // medical flags
  blood_group:              Joi.string().valid('A+','A-','B+','B-','AB+','AB-','O+','O-').optional().allow(null,''),
  is_smoker:                Joi.boolean().optional(),
  is_diabetic:              Joi.boolean().optional(),
  is_hypertensive:          Joi.boolean().optional(),
  is_pregnant:              Joi.boolean().optional(),
  is_on_blood_thinner:      Joi.boolean().optional(),
  known_allergies:          Joi.string().optional().allow(null,''),
  emergency_contact_name:   Joi.string().optional().allow(null,''),
  emergency_contact_phone:  Joi.string().optional().allow(null,''),
  preferred_language:       Joi.string().optional().allow(null,''),
  occupation:               Joi.string().optional().allow(null,''),
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
    const { name, phone, email, dob, gender, address, age, clinical_history,
            blood_group, is_smoker, is_diabetic, is_hypertensive, is_pregnant,
            is_on_blood_thinner, known_allergies, emergency_contact_name,
            emergency_contact_phone, preferred_language, occupation } = req.body;

    // Duplicate guard: only block when BOTH phone and name already exist on
    // this clinic. A shared phone with a different name is allowed so family
    // members can register under the same contact number.
    const dup = await db.query(
      `SELECT id FROM patients
         WHERE clinic_id = $1
           AND phone     = $2
           AND LOWER(TRIM(name)) = LOWER(TRIM($3))`,
      [req.user.clinic_id, phone, name]
    );
    if (dup.rows.length) {
      return res.status(409).json({
        error: 'A patient with this phone and name already exists',
        existing_id: dup.rows[0].id,
      });
    }

    // Family grouping: the first patient on a phone is PRIMARY; anyone added
    // against a phone that already has a patient becomes SECONDARY.
    const sibling = await db.query(
      `SELECT 1 FROM patients WHERE clinic_id = $1 AND phone = $2 LIMIT 1`,
      [req.user.clinic_id, phone]
    );
    const isPrimary = sibling.rows.length === 0;

    const result = await db.query(
      `INSERT INTO patients
         (clinic_id, name, phone, email, dob, gender, address, age, clinical_history,
          blood_group, is_smoker, is_diabetic, is_hypertensive, is_pregnant,
          is_on_blood_thinner, known_allergies, emergency_contact_name,
          emergency_contact_phone, preferred_language, occupation, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [req.user.clinic_id, name, phone, email || null, dob || null, gender || null,
       address || null, age ?? null, clinical_history || null,
       blood_group || null, is_smoker ?? false, is_diabetic ?? false,
       is_hypertensive ?? false, is_pregnant ?? false, is_on_blood_thinner ?? false,
       known_allergies || null, emergency_contact_name || null,
       emergency_contact_phone || null, preferred_language || null, occupation || null, isPrimary]
    );
    res.status(201).json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id/record — full patient record (sessions, plans, labs, billing) ────
router.get('/:id/record', requirePermission(P.PATIENT_VIEW), async (req, res, next) => {
  try {
    const patientId = req.params.id;
    const clinicId  = req.user.clinic_id;

    const [patRes, apptRes, sessRes, planRes, labRes, billRes] = await Promise.all([
      // patient
      db.query(`SELECT * FROM patients WHERE id=$1 AND clinic_id=$2`, [patientId, clinicId]),

      // appointments
      db.query(
        `SELECT a.*, s.name AS service_name, s.id AS service_id
           FROM appointments a
           JOIN services s ON s.id = a.service_id
          WHERE a.patient_id = $1
          ORDER BY a.scheduled_at DESC`,
        [patientId]
      ),

      // clinical sessions with services performed + diagnoses (correlated subqueries avoid cartesian product)
      db.query(
        `SELECT
           cs.id, cs.status, cs.started_at, cs.ended_at, cs.sealed_at,
           TRIM(u.first_name || ' ' || u.last_name) AS doctor_name,
           (
             SELECT COALESCE(json_agg(jsonb_build_object(
               'id', sp.id,
               'service_name', svc.name,
               'tooth_numbers', sp.tooth_numbers,
               'quantity', sp.quantity,
               'base_price', sp.base_price,
               'final_charge', sp.final_charge,
               'status', sp.status
             ) ORDER BY sp.id), '[]')
             FROM service_performed sp
             LEFT JOIN services svc ON svc.id = sp.service_id
             WHERE sp.session_id = cs.id
           ) AS services_performed,
           (
             SELECT COALESCE(json_agg(jsonb_build_object(
               'id', d.id,
               'diagnosis_text', d.diagnosis_text,
               'icd10_code', d.icd10_code,
               'tooth_numbers', d.tooth_numbers
             ) ORDER BY d.id), '[]')
             FROM diagnosis d
             WHERE d.session_id = cs.id
           ) AS diagnoses,
           COALESCE(
             (SELECT SUM(sp2.final_charge) FROM service_performed sp2
               WHERE sp2.session_id = cs.id AND sp2.status IN ('COMPLETED', 'PARTIAL')),
             0
           ) AS session_charge
         FROM clinical_session cs
         LEFT JOIN users u ON u.id = cs.primary_doctor_id
         WHERE cs.patient_id = $1 AND cs.clinic_id = $2
         ORDER BY cs.started_at DESC`,
        [patientId, clinicId]
      ),

      // treatment plans with items (treatment_plan has no status/notes columns)
      db.query(
        `SELECT
           tp.id, tp.title, tp.created_at,
           (
             SELECT COALESCE(json_agg(jsonb_build_object(
               'id', tpi.id,
               'service_name', svc.name,
               'cost_min', tpi.cost_min,
               'cost_max', tpi.cost_max,
               'status', tpi.status,
               'priority', tpi.priority,
               'tooth_numbers', tpi.tooth_numbers
             ) ORDER BY tpi.id), '[]')
             FROM treatment_plan_item tpi
             LEFT JOIN services svc ON svc.id = tpi.service_id
             WHERE tpi.plan_id = tp.id AND tpi.deleted_at IS NULL
           ) AS items
         FROM treatment_plan tp
         WHERE tp.patient_id = $1 AND tp.clinic_id = $2 AND tp.deleted_at IS NULL
         ORDER BY tp.created_at DESC`,
        [patientId, clinicId]
      ),

      // lab orders (via session)
      db.query(
        `SELECT
           lo.id, lo.status, lo.shade, lo.specifications,
           lo.pickup_date, lo.expected_delivery_date, lo.lab_cost,
           lo.created_at,
           svc.name AS service_name,
           cs.started_at AS session_date
         FROM lab_order lo
         JOIN clinical_session cs ON cs.id = lo.session_id
         LEFT JOIN services svc ON svc.id = lo.service_id
         WHERE cs.patient_id = $1 AND cs.clinic_id = $2
         ORDER BY lo.created_at DESC`,
        [patientId, clinicId]
      ),

      // billing summary
      db.query(
        `SELECT
           COUNT(DISTINCT cs.id)::int                          AS session_count,
           COALESCE(SUM(sp.final_charge), 0)                  AS total_billed,
           COUNT(sp.id)                                        AS procedure_count
         FROM clinical_session cs
         -- Only bill for treatment that was actually performed: COMPLETED (fully
         -- done) and PARTIAL (partly done). IN_PROGRESS services aren't finished
         -- yet and ABANDONED ones were never performed, so neither contributes to
         -- billed totals or the procedure count. Filtering in the JOIN keeps
         -- sessions with no billable services in session_count.
         LEFT JOIN service_performed sp
                ON sp.session_id = cs.id AND sp.status IN ('COMPLETED', 'PARTIAL')
         WHERE cs.patient_id = $1 AND cs.clinic_id = $2`,
        [patientId, clinicId]
      ),
    ]);

    if (!patRes.rows.length) return res.status(404).json({ error: 'Patient not found' });
    const patient = patRes.rows[0];

    // Family group — everyone sharing this phone at the clinic (primary first).
    const familyRes = await db.query(
      `SELECT id, name, age, gender, is_primary
         FROM patients
        WHERE clinic_id = $1 AND phone = $2
        ORDER BY is_primary DESC, created_at ASC`,
      [clinicId, patient.phone]
    );

    res.json({
      patient,
      appointments:    apptRes.rows,
      sessions:        sessRes.rows,
      treatment_plans: planRes.rows,
      lab_orders:      labRes.rows,
      billing:         billRes.rows[0],
      family:          familyRes.rows,
    });
  } catch (err) { next(err); }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
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
    const { name, phone, email, dob, gender, address, age, clinical_history,
            blood_group, is_smoker, is_diabetic, is_hypertensive, is_pregnant,
            is_on_blood_thinner, known_allergies, emergency_contact_name,
            emergency_contact_phone, preferred_language, occupation } = req.body;
    const result = await db.query(
      `UPDATE patients SET
         name=$1, phone=$2, email=$3, dob=$4, gender=$5, address=$6, age=$7,
         clinical_history=$8, blood_group=$9, is_smoker=$10, is_diabetic=$11,
         is_hypertensive=$12, is_pregnant=$13, is_on_blood_thinner=$14,
         known_allergies=$15, emergency_contact_name=$16, emergency_contact_phone=$17,
         preferred_language=$18, occupation=$19
       WHERE id=$20 AND clinic_id=$21 RETURNING *`,
      [name, phone, email || null, dob || null, gender || null, address || null,
       age ?? null, clinical_history || null, blood_group || null,
       is_smoker ?? false, is_diabetic ?? false, is_hypertensive ?? false,
       is_pregnant ?? false, is_on_blood_thinner ?? false, known_allergies || null,
       emergency_contact_name || null, emergency_contact_phone || null,
       preferred_language || null, occupation || null,
       req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/primary — make this patient the primary of its phone group ──────
// Promotes the target to primary and demotes every other patient sharing the
// phone (the previous primary becomes secondary). Atomic.
router.patch('/:id/primary', requirePermission(P.PATIENT_UPDATE), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, phone FROM patients WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Patient not found' }); }
    const { phone } = rows[0];

    // Demote all in the group, then promote the target — one primary guaranteed.
    await client.query(
      `UPDATE patients SET is_primary = FALSE, updated_at = now()
         WHERE clinic_id = $1 AND phone = $2 AND id <> $3 AND is_primary = TRUE`,
      [req.user.clinic_id, phone, req.params.id]
    );
    const upd = await client.query(
      `UPDATE patients SET is_primary = TRUE, updated_at = now()
         WHERE id = $1 AND clinic_id = $2 RETURNING *`,
      [req.params.id, req.user.clinic_id]
    );

    await client.query('COMMIT');

    // Return the refreshed group so the UI can re-render badges.
    const family = await db.query(
      `SELECT id, name, age, gender, is_primary FROM patients
        WHERE clinic_id = $1 AND phone = $2 ORDER BY is_primary DESC, created_at ASC`,
      [req.user.clinic_id, phone]
    );
    res.json({ patient: upd.rows[0], family: family.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
