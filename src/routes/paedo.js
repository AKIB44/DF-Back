'use strict';
const express = require('express');
const Joi     = require('joi');
const { pool } = require('../db');
const authenticate          = require('../middleware/authenticate');
const tenantScope           = require('../rbac/tenant-scope.middleware');
const auditMw = require("../audit/audit.middleware");
const { requirePermission } = require('../rbac/require-permission.middleware');
const P = require("../rbac/permissions.constants");

const router = express.Router();
router.use(authenticate, tenantScope, auditMw);

const createCaseSchema = Joi.object({
  patient_id:           Joi.string().uuid().required(),
  primary_doctor_id:    Joi.string().uuid().optional(),
  treatment_plan_id:    Joi.string().uuid().optional().allow(null),
  registration_date:    Joi.string().isoDate().optional(),
  referral_source:      Joi.string().optional(),
  developmental_status: Joi.string().optional(),
  medical_alerts:       Joi.object().optional(),
  guardian: Joi.object({
    name:         Joi.string().required(),
    relationship: Joi.string().default('PARENT'),
    phone:        Joi.string().optional(),
    email:        Joi.string().email().optional(),
  }).optional(),
});

// ── POST /cases ───────────────────────────────────────────────────────────────
router.post('/cases', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { error, value } = createCaseSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const { orgId, clinicId, userId } = req.context;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sc = await client.query(
        `INSERT INTO specialty_case (org_id, clinic_id, patient_id, case_type, status, primary_doctor_id, treatment_plan_id, created_by, updated_by)
         VALUES ($1,$2,$3,'PAEDO','ACTIVE',$4,$5,$6,$6) RETURNING *`,
        [orgId, clinicId, value.patient_id, value.primary_doctor_id||userId, value.treatment_plan_id||null, userId]
      );
      const caseId = sc.rows[0].id;
      await client.query(
        `INSERT INTO paedo_case_detail (case_id, org_id, clinic_id, registration_date, referral_source, developmental_status, medical_alerts, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [caseId, orgId, clinicId, value.registration_date||new Date().toISOString().slice(0,10), value.referral_source||null, value.developmental_status||'TYPICAL', value.medical_alerts?JSON.stringify(value.medical_alerts):null, userId]
      );
      if (value.guardian) {
        await client.query(
          `INSERT INTO paedo_guardian (case_id, org_id, clinic_id, name, relationship, is_primary, phone, email, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$8)`,
          [caseId, orgId, clinicId, value.guardian.name, value.guardian.relationship||'PARENT', value.guardian.phone||null, value.guardian.email||null, userId]
        );
      }
      await client.query(`INSERT INTO specialty_milestone (org_id, clinic_id, case_id, kind, occurred_at, title, created_by, updated_by) VALUES ($1,$2,$3,'CASE_OPENED',NOW(),'Paediatric case opened',$4,$4)`, [orgId, clinicId, caseId, userId]);
      await client.query('COMMIT');
      res.status(201).json({ id: caseId });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

// ── GET /cases/:id ────────────────────────────────────────────────────────────
router.get('/cases/:id', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { rows: [sc] } = await pool.query(
      `SELECT sc.*, pcd.*, p.name AS patient_name, p.date_of_birth
       FROM specialty_case sc JOIN paedo_case_detail pcd ON pcd.case_id=sc.id JOIN patients p ON p.id=sc.patient_id
       WHERE sc.id=$1 AND sc.org_id=$2 AND sc.clinic_id=$3 AND sc.deleted_at IS NULL`,
      [req.params.id, orgId, clinicId]
    );
    if (!sc) return res.status(404).json({ error: 'Not found' });
    const [guardians, behaviour, growth, eruption, caries] = await Promise.all([
      pool.query('SELECT * FROM paedo_guardian WHERE case_id=$1 AND deleted_at IS NULL ORDER BY is_primary DESC', [req.params.id]),
      pool.query('SELECT * FROM paedo_behaviour_assessment WHERE case_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10', [req.params.id]),
      pool.query('SELECT * FROM paedo_growth_measurement WHERE case_id=$1 AND deleted_at IS NULL ORDER BY measured_at DESC', [req.params.id]),
      pool.query('SELECT * FROM paedo_eruption_record WHERE case_id=$1 AND deleted_at IS NULL ORDER BY fdi_tooth', [req.params.id]),
      pool.query('SELECT * FROM paedo_caries_risk_assessment WHERE case_id=$1 AND deleted_at IS NULL ORDER BY assessed_at DESC LIMIT 5', [req.params.id]),
    ]);
    res.json({ ...sc, guardians: guardians.rows, behaviour_history: behaviour.rows, growth_history: growth.rows, eruption_records: eruption.rows, caries_risk_history: caries.rows });
  } catch (err) { next(err); }
});

// ── POST /cases/:id/guardians ────────────────────────────────────────────────
router.post('/cases/:id/guardians', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { name, relationship='PARENT', is_primary=false, can_consent_medical=true, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows: [g] } = await pool.query(
      `INSERT INTO paedo_guardian (case_id, org_id, clinic_id, name, relationship, is_primary, can_consent_medical, phone, email, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [req.params.id, orgId, clinicId, name, relationship, is_primary, can_consent_medical, phone||null, email||null, notes||null, userId]
    );
    res.status(201).json(g);
  } catch (err) { next(err); }
});

// ── POST /visits/:visitId/behaviour ──────────────────────────────────────────
router.post('/visits/:visitId/behaviour', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { case_id, frankl_rating='F3_POSITIVE', pre_visit_anxiety, techniques_used=[], guardian_present=true, outcome_notes, next_visit_strategy } = req.body;
    if (!case_id) return res.status(400).json({ error: 'case_id required' });
    const { rows: [b] } = await pool.query(
      `INSERT INTO paedo_behaviour_assessment (case_id, visit_id, org_id, clinic_id, frankl_rating, pre_visit_anxiety, techniques_used, guardian_present, outcome_notes, next_visit_strategy, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       ON CONFLICT (visit_id) DO UPDATE SET frankl_rating=$5, updated_by=$11, updated_at=NOW() RETURNING *`,
      [case_id, req.params.visitId, orgId, clinicId, frankl_rating, pre_visit_anxiety||null, techniques_used, guardian_present, outcome_notes||null, next_visit_strategy||null, userId]
    );
    res.status(201).json(b);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/growth-measurements ──────────────────────────────────────
router.post('/cases/:id/growth-measurements', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { height_cm, weight_kg, age_months=0, notes, visit_id } = req.body;
    const { rows: [g] } = await pool.query(
      `INSERT INTO paedo_growth_measurement (case_id, visit_id, org_id, clinic_id, measured_at, height_cm, weight_kg, age_months, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [req.params.id, visit_id||null, orgId, clinicId, height_cm||null, weight_kg||null, age_months, notes||null, userId]
    );
    res.status(201).json(g);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/eruption-records ──────────────────────────────────────────
router.post('/cases/:id/eruption-records', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { fdi_tooth, status='UNERUPTED', notes, visit_id } = req.body;
    if (!fdi_tooth) return res.status(400).json({ error: 'fdi_tooth required' });
    const { rows: [er] } = await pool.query(
      `INSERT INTO paedo_eruption_record (case_id, visit_id, org_id, clinic_id, fdi_tooth, status, observed_at, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$8) RETURNING *`,
      [req.params.id, visit_id||null, orgId, clinicId, fdi_tooth, status, notes||null, userId]
    );
    res.status(201).json(er);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/caries-risk-assessments ──────────────────────────────────
router.post('/cases/:id/caries-risk-assessments', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { risk_level='MODERATE', disease_indicators, risk_factors, protective_factors, recommended_recall_months=6, prevention_plan, visit_id } = req.body;
    const { rows: [cra] } = await pool.query(
      `INSERT INTO paedo_caries_risk_assessment (case_id, visit_id, org_id, clinic_id, risk_level, disease_indicators, risk_factors, protective_factors, recommended_recall_months, prevention_plan, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [req.params.id, visit_id||null, orgId, clinicId, risk_level, disease_indicators?JSON.stringify(disease_indicators):null, risk_factors?JSON.stringify(risk_factors):null, protective_factors?JSON.stringify(protective_factors):null, recommended_recall_months, prevention_plan||null, userId]
    );
    res.status(201).json(cra);
  } catch (err) { next(err); }
});

// ── GET /reports/active-cases ─────────────────────────────────────────────────
router.get('/reports/active-cases', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { rows } = await pool.query(
      `SELECT sc.id, sc.external_case_no, sc.started_at, pcd.developmental_status,
              p.name AS patient_name, p.date_of_birth
       FROM specialty_case sc JOIN paedo_case_detail pcd ON pcd.case_id=sc.id JOIN patients p ON p.id=sc.patient_id
       WHERE sc.org_id=$1 AND sc.clinic_id=$2 AND sc.status='ACTIVE' AND sc.deleted_at IS NULL
       ORDER BY sc.started_at DESC`,
      [orgId, clinicId]
    );
    res.json({ count: rows.length, cases: rows });
  } catch (err) { next(err); }
});

module.exports = router;
