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

const STAGES = ['DIAGNOSED','ACCESS_AND_CLEANING','INTER_VISIT','OBTURATION','POST_OBTURATION','POST_OP_FOLLOW_UP','RECALL','HEALED','FAILED'];

const createCaseSchema = Joi.object({
  patient_id:            Joi.string().uuid().required(),
  primary_doctor_id:     Joi.string().uuid().optional(),
  treatment_plan_id:     Joi.string().uuid().optional().allow(null),
  fdi_tooth:             Joi.number().integer().min(11).max(85).required(),
  is_retreatment:        Joi.boolean().default(false),
  is_apicoectomy:        Joi.boolean().default(false),
  pulp_diagnosis:        Joi.string().optional(),
  periapical_diagnosis:  Joi.string().optional(),
  expected_canal_count:  Joi.number().integer().min(1).max(6).default(1),
  protocol:              Joi.string().valid('SINGLE_VISIT','TWO_VISIT','MULTI_VISIT').default('SINGLE_VISIT'),
  presentation_notes:    Joi.string().max(2000).optional().allow(''),
});

const canalSchema = Joi.object({
  canal_designation:         Joi.string().required(),
  working_length_mm:         Joi.number().optional(),
  apex_locator_reading_mm:   Joi.number().optional(),
  master_apical_file_size:   Joi.number().integer().optional(),
  taper_pct:                 Joi.number().optional(),
  rotary_system:             Joi.string().optional(),
  file_sequence:             Joi.array().optional(),
  irrigation_protocol:       Joi.object().optional(),
  intra_canal_medication:    Joi.string().optional(),
  obturation_technique:      Joi.string().optional(),
  obturation_length_mm:      Joi.number().optional(),
  sealer:                    Joi.string().optional(),
  master_cone_size:          Joi.number().integer().optional(),
  status:                    Joi.string().valid('IN_PROGRESS','CLEANED','OBTURATED','TROUBLED').default('IN_PROGRESS'),
  complications:             Joi.object().optional(),
  notes:                     Joi.string().max(2000).optional().allow(''),
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
         VALUES ($1,$2,$3,'ENDO','ACTIVE',$4,$5,$6,$6) RETURNING *`,
        [orgId, clinicId, value.patient_id, value.primary_doctor_id||userId, value.treatment_plan_id||null, userId]
      );
      const caseId = sc.rows[0].id;
      await client.query(
        `INSERT INTO endo_case_detail (case_id, org_id, clinic_id, fdi_tooth, is_retreatment, is_apicoectomy, pulp_diagnosis, periapical_diagnosis, expected_canal_count, protocol, presentation_notes, primary_doctor_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [caseId, orgId, clinicId, value.fdi_tooth, value.is_retreatment, value.is_apicoectomy, value.pulp_diagnosis||null, value.periapical_diagnosis||null, value.expected_canal_count, value.protocol, value.presentation_notes||null, value.primary_doctor_id||userId, userId]
      );
      await client.query(`INSERT INTO specialty_milestone (org_id, clinic_id, case_id, kind, occurred_at, title, created_by, updated_by) VALUES ($1,$2,$3,'CASE_OPENED',NOW(),'Endo case opened - tooth '||$4,$5,$5)`, [orgId, clinicId, caseId, value.fdi_tooth, userId]);
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
      `SELECT sc.*, ecd.*, p.name AS patient_name
       FROM specialty_case sc JOIN endo_case_detail ecd ON ecd.case_id=sc.id JOIN patients p ON p.id=sc.patient_id
       WHERE sc.id=$1 AND sc.org_id=$2 AND sc.clinic_id=$3 AND sc.deleted_at IS NULL`,
      [req.params.id, orgId, clinicId]
    );
    if (!sc) return res.status(404).json({ error: 'Not found' });
    const [canals, followups, recalls, milestones] = await Promise.all([
      pool.query('SELECT * FROM endo_canal_record WHERE case_id=$1 AND deleted_at IS NULL ORDER BY created_at', [req.params.id]),
      pool.query('SELECT * FROM endo_post_op_followup WHERE case_id=$1 AND deleted_at IS NULL ORDER BY scheduled_for', [req.params.id]),
      pool.query('SELECT * FROM endo_recall WHERE case_id=$1 AND deleted_at IS NULL ORDER BY scheduled_for', [req.params.id]),
      pool.query('SELECT * FROM specialty_milestone WHERE case_id=$1 AND deleted_at IS NULL ORDER BY occurred_at', [req.params.id]),
    ]);
    res.json({ ...sc, canals: canals.rows, followups: followups.rows, recalls: recalls.rows, milestones: milestones.rows });
  } catch (err) { next(err); }
});

// ── POST /cases/:id/advance-stage ─────────────────────────────────────────────
router.post('/cases/:id/advance-stage', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { stage } = req.body;
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    await pool.query(`UPDATE endo_case_detail SET current_stage=$1, updated_by=$2, updated_at=NOW() WHERE case_id=$3 AND org_id=$4 AND clinic_id=$5`, [stage, userId, req.params.id, orgId, clinicId]);
    await pool.query(`INSERT INTO specialty_milestone (org_id, clinic_id, case_id, kind, occurred_at, title, created_by, updated_by) VALUES ($1,$2,$3,'CUSTOM',NOW(),$4,$5,$5)`, [orgId, clinicId, req.params.id, `Stage: ${stage}`, userId]);
    // Auto-create recalls when reaching POST_OBTURATION
    if (stage === 'POST_OBTURATION') {
      const { rows: [ecd] } = await pool.query('SELECT org_id, clinic_id FROM endo_case_detail WHERE case_id=$1', [req.params.id]);
      const existing = await pool.query('SELECT 1 FROM endo_recall WHERE case_id=$1 LIMIT 1', [req.params.id]);
      if (!existing.rows.length) {
        const now = new Date();
        for (const [kind, months] of [['MONTH_3',3],['MONTH_6',6],['MONTH_12',12]]) {
          const d = new Date(now); d.setMonth(d.getMonth()+months);
          await pool.query(`INSERT INTO endo_recall (case_id, org_id, clinic_id, kind, scheduled_for, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6)`, [req.params.id, orgId, clinicId, kind, d.toISOString().slice(0,10), userId]);
        }
      }
    }
    res.json({ stage });
  } catch (err) { next(err); }
});

// ── POST /visits/:visitId/canals ──────────────────────────────────────────────
router.post('/visits/:visitId/canals', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { case_id, canals } = req.body;
    if (!case_id || !Array.isArray(canals)) return res.status(400).json({ error: 'case_id and canals array required' });
    const results = [];
    for (const canal of canals) {
      const { error, value } = canalSchema.validate(canal);
      if (error) return res.status(400).json({ error: error.message });
      const { rows: [c] } = await pool.query(
        `INSERT INTO endo_canal_record (case_id, visit_id, org_id, clinic_id, canal_designation, working_length_mm, apex_locator_reading_mm, master_apical_file_size, taper_pct, rotary_system, file_sequence, irrigation_protocol, intra_canal_medication, obturation_technique, obturation_length_mm, sealer, master_cone_size, status, complications, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) RETURNING *`,
        [case_id, req.params.visitId, orgId, clinicId, value.canal_designation, value.working_length_mm||null, value.apex_locator_reading_mm||null, value.master_apical_file_size||null, value.taper_pct||null, value.rotary_system||null, value.file_sequence?JSON.stringify(value.file_sequence):null, value.irrigation_protocol?JSON.stringify(value.irrigation_protocol):null, value.intra_canal_medication||null, value.obturation_technique||null, value.obturation_length_mm||null, value.sealer||null, value.master_cone_size||null, value.status, value.complications?JSON.stringify(value.complications):null, value.notes||null, userId]
      );
      results.push(c);
    }
    res.status(201).json(results);
  } catch (err) { next(err); }
});

// ── PATCH /canals/:id ─────────────────────────────────────────────────────────
router.patch('/canals/:id', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const allowed = ['working_length_mm','apex_locator_reading_mm','master_apical_file_size','taper_pct','rotary_system','file_sequence','irrigation_protocol','intra_canal_medication','obturation_technique','obturation_length_mm','sealer','master_cone_size','status','complications','notes'];
    const sets = []; const vals = [];
    for (const k of allowed) { if (req.body[k] !== undefined) { sets.push(`${k}=$${vals.length+1}`); vals.push(typeof req.body[k]==='object'?JSON.stringify(req.body[k]):req.body[k]); } }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(userId, req.params.id, orgId);
    const n = vals.length;
    const { rows: [c] } = await pool.query(`UPDATE endo_canal_record SET ${sets.join(',')}, updated_by=$${n-2}, updated_at=NOW() WHERE id=$${n-1} AND org_id=$${n} AND deleted_at IS NULL RETURNING *`, vals);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/post-op-followups ────────────────────────────────────────
router.post('/cases/:id/post-op-followups', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { interval_hours=24, channel='WHATSAPP', visit_id } = req.body;
    const scheduled_for = new Date(Date.now() + interval_hours*3600000).toISOString();
    const { rows: [f] } = await pool.query(
      `INSERT INTO endo_post_op_followup (case_id, visit_id, org_id, clinic_id, scheduled_for, interval_hours, channel, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [req.params.id, visit_id||null, orgId, clinicId, scheduled_for, interval_hours, channel, userId]
    );
    res.status(201).json(f);
  } catch (err) { next(err); }
});

// ── PATCH /post-op-followups/:id/respond ─────────────────────────────────────
router.patch('/post-op-followups/:id/respond', async (req, res, next) => {
  try {
    const { pain_score, swelling, taking_prescribed_medication, any_concerns } = req.body;
    const doctor_review_required = pain_score >= 6 || swelling === true;
    const { rows: [f] } = await pool.query(
      `UPDATE endo_post_op_followup SET pain_score=$1, swelling=$2, taking_prescribed_medication=$3, any_concerns=$4, responded_at=NOW(), status='RESPONDED', doctor_review_required=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [pain_score||null, swelling!=null?swelling:null, taking_prescribed_medication!=null?taking_prescribed_medication:null, any_concerns||null, doctor_review_required, req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Not found' });
    res.json(f);
  } catch (err) { next(err); }
});

// ── GET /reports/active-cases ─────────────────────────────────────────────────
router.get('/reports/active-cases', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { rows } = await pool.query(
      `SELECT sc.id, sc.external_case_no, sc.started_at, ecd.fdi_tooth, ecd.current_stage, ecd.protocol,
              p.name AS patient_name
       FROM specialty_case sc JOIN endo_case_detail ecd ON ecd.case_id=sc.id JOIN patients p ON p.id=sc.patient_id
       WHERE sc.org_id=$1 AND sc.clinic_id=$2 AND sc.status='ACTIVE' AND sc.deleted_at IS NULL ORDER BY sc.started_at DESC`,
      [orgId, clinicId]
    );
    res.json({ count: rows.length, cases: rows });
  } catch (err) { next(err); }
});

module.exports = router;
