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

const TMJ_PHASES = ['INITIAL_EVALUATION','DIAGNOSTIC_WORKUP','CONSERVATIVE_CARE','REVIEW_AND_ADJUST','STABILISED','DISCHARGED','ESCALATED'];

const createCaseSchema = Joi.object({
  patient_id:                 Joi.string().uuid().required(),
  primary_doctor_id:          Joi.string().uuid().optional(),
  treatment_plan_id:          Joi.string().uuid().optional().allow(null),
  chief_complaint:            Joi.string().max(500).required(),
  pain_onset_date:            Joi.string().isoDate().optional(),
  pain_onset_circumstance:    Joi.string().optional(),
  pain_duration:              Joi.string().optional(),
  suspected_axis_i:           Joi.string().optional(),
  contributing_factors:       Joi.object().optional(),
  past_treatments_attempted:  Joi.string().max(2000).optional(),
  expected_review_weeks:      Joi.number().integer().min(1).default(4),
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
         VALUES ($1,$2,$3,'TMJ','ACTIVE',$4,$5,$6,$6) RETURNING *`,
        [orgId, clinicId, value.patient_id, value.primary_doctor_id||userId, value.treatment_plan_id||null, userId]
      );
      const caseId = sc.rows[0].id;
      await client.query(
        `INSERT INTO tmj_case_detail (case_id, org_id, clinic_id, chief_complaint, pain_onset_date, pain_onset_circumstance, pain_duration, suspected_axis_i, contributing_factors, past_treatments_attempted, primary_doctor_id, expected_review_weeks, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [caseId, orgId, clinicId, value.chief_complaint, value.pain_onset_date||null, value.pain_onset_circumstance||null, value.pain_duration||null, value.suspected_axis_i||null, value.contributing_factors?JSON.stringify(value.contributing_factors):null, value.past_treatments_attempted||null, value.primary_doctor_id||userId, value.expected_review_weeks, userId]
      );
      await client.query(`INSERT INTO specialty_milestone (org_id, clinic_id, case_id, kind, occurred_at, title, created_by, updated_by) VALUES ($1,$2,$3,'CASE_OPENED',NOW(),'TMJ-OFP case opened',$4,$4)`, [orgId, clinicId, caseId, userId]);
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
      `SELECT sc.*, tcd.*, p.name AS patient_name
       FROM specialty_case sc JOIN tmj_case_detail tcd ON tcd.case_id=sc.id JOIN patients p ON p.id=sc.patient_id
       WHERE sc.id=$1 AND sc.org_id=$2 AND sc.clinic_id=$3 AND sc.deleted_at IS NULL`,
      [req.params.id, orgId, clinicId]
    );
    if (!sc) return res.status(404).json({ error: 'Not found' });
    const [joints, roms, painRecords, splints, diary, milestones] = await Promise.all([
      pool.query('SELECT * FROM tmj_joint_finding WHERE case_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM tmj_rom_measurement WHERE case_id=$1 AND deleted_at IS NULL ORDER BY measured_at', [req.params.id]),
      pool.query('SELECT * FROM tmj_pain_record WHERE case_id=$1 AND deleted_at IS NULL ORDER BY recorded_at DESC LIMIT 20', [req.params.id]),
      pool.query('SELECT * FROM tmj_splint WHERE case_id=$1 AND deleted_at IS NULL ORDER BY prescribed_at', [req.params.id]),
      pool.query('SELECT * FROM tmj_diary_entry WHERE case_id=$1 AND deleted_at IS NULL ORDER BY entry_date DESC LIMIT 30', [req.params.id]),
      pool.query('SELECT * FROM specialty_milestone WHERE case_id=$1 AND deleted_at IS NULL ORDER BY occurred_at', [req.params.id]),
    ]);
    res.json({ ...sc, joint_findings: joints.rows, rom_measurements: roms.rows, pain_records: painRecords.rows, splints: splints.rows, diary_entries: diary.rows, milestones: milestones.rows });
  } catch (err) { next(err); }
});

// ── PATCH /cases/:id/detail ───────────────────────────────────────────────────
router.patch('/cases/:id/detail', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const allowed = ['chief_complaint','pain_onset_date','pain_duration','suspected_axis_i','confirmed_axis_i','contributing_factors','current_phase','case_summary','expected_review_weeks'];
    const sets = []; const vals = [];
    for (const k of allowed) { if (req.body[k] !== undefined) { sets.push(`${k}=$${vals.length+1}`); vals.push(typeof req.body[k]==='object'&&!Array.isArray(req.body[k])?JSON.stringify(req.body[k]):req.body[k]); } }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(userId, req.params.id, orgId, clinicId);
    const n = vals.length;
    await pool.query(`UPDATE tmj_case_detail SET ${sets.join(',')}, updated_by=$${n-3}, updated_at=NOW() WHERE case_id=$${n-2} AND org_id=$${n-1} AND clinic_id=$${n}`, vals);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /visits/:visitId/joint-findings ──────────────────────────────────────
router.post('/visits/:visitId/joint-findings', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { case_id, findings } = req.body; // findings: [{side:'RIGHT', joint_sound:..., locking:..., tenderness:...}]
    if (!case_id || !Array.isArray(findings)) return res.status(400).json({ error: 'case_id and findings[] required' });
    const results = [];
    for (const f of findings) {
      const { side='RIGHT', joint_sound='NONE', locking='NONE', tenderness='NONE', swelling=false, warmth=false, notes } = f;
      const { rows: [jf] } = await pool.query(
        `INSERT INTO tmj_joint_finding (case_id, visit_id, org_id, clinic_id, side, joint_sound, locking, tenderness, swelling, warmth, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (visit_id, side) DO UPDATE SET joint_sound=$6, locking=$7, tenderness=$8, swelling=$9, warmth=$10, notes=$11, updated_by=$12, updated_at=NOW() RETURNING *`,
        [case_id, req.params.visitId, orgId, clinicId, side, joint_sound, locking, tenderness, swelling, warmth, notes||null, userId]
      );
      results.push(jf);
    }
    res.status(201).json(results);
  } catch (err) { next(err); }
});

// ── POST /visits/:visitId/rom ──────────────────────────────────────────────────
router.post('/visits/:visitId/rom', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { case_id, mio_unassisted_mm, mio_assisted_mm, pain_free_opening_mm, right_lateral_mm, left_lateral_mm, protrusive_mm, opening_deviation, opening_pain, notes } = req.body;
    if (!case_id) return res.status(400).json({ error: 'case_id required' });
    const { rows: [rom] } = await pool.query(
      `INSERT INTO tmj_rom_measurement (case_id, visit_id, org_id, clinic_id, mio_unassisted_mm, mio_assisted_mm, pain_free_opening_mm, right_lateral_mm, left_lateral_mm, protrusive_mm, opening_deviation, opening_pain, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
      [case_id, req.params.visitId, orgId, clinicId, mio_unassisted_mm||null, mio_assisted_mm||null, pain_free_opening_mm||null, right_lateral_mm||null, left_lateral_mm||null, protrusive_mm||null, opening_deviation||null, opening_pain||null, notes||null, userId]
    );
    res.status(201).json(rom);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/pain-records ──────────────────────────────────────────────
router.post('/cases/:id/pain-records', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { intensity_now, intensity_max_24h, intensity_avg_24h, sites, character=[], triggers=[], notes, visit_id } = req.body;
    const { rows: [pr] } = await pool.query(
      `INSERT INTO tmj_pain_record (case_id, visit_id, org_id, clinic_id, source, intensity_now, intensity_max_24h, intensity_avg_24h, sites, character, triggers, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,'CLINICAL_VISIT',$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
      [req.params.id, visit_id||null, orgId, clinicId, intensity_now||null, intensity_max_24h||null, intensity_avg_24h||null, sites?JSON.stringify(sites):null, character, triggers, notes||null, userId]
    );
    res.status(201).json(pr);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/splints ───────────────────────────────────────────────────
router.post('/cases/:id/splints', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { kind='STABILISATION_FULL_COVERAGE', arch='UPPER', rationale, material, wear_schedule, notes } = req.body;
    const { rows: [s] } = await pool.query(
      `INSERT INTO tmj_splint (case_id, org_id, clinic_id, kind, arch, prescribed_at, prescribed_by, rationale, material, wear_schedule, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$6,$6) RETURNING *`,
      [req.params.id, orgId, clinicId, kind, arch, userId, rationale||null, material||null, wear_schedule||null, notes||null]
    );
    res.status(201).json(s);
  } catch (err) { next(err); }
});

// ── PATCH /splints/:id ────────────────────────────────────────────────────────
router.patch('/splints/:id', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, userId } = req.context;
    const allowed = ['status','delivered_at','discontinued_at','outcome','notes','wear_schedule'];
    const sets = []; const vals = [];
    for (const k of allowed) { if (req.body[k] !== undefined) { sets.push(`${k}=$${vals.length+1}`); vals.push(req.body[k]); } }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(userId, req.params.id);
    const { rows: [s] } = await pool.query(`UPDATE tmj_splint SET ${sets.join(',')}, updated_by=$${vals.length-1}, updated_at=NOW() WHERE id=$${vals.length} AND deleted_at IS NULL RETURNING *`, vals);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (err) { next(err); }
});

// ── POST /diary-entries (patient self-report) ─────────────────────────────────
router.post('/diary-entries', async (req, res, next) => {
  try {
    const { case_id, entry_date, pain_morning, pain_afternoon, pain_evening, worst_today, sleep_disturbed, jaw_locking_episode, major_triggers=[], free_text, submission_channel='WEB_FORM' } = req.body;
    if (!case_id || !entry_date) return res.status(400).json({ error: 'case_id and entry_date required' });
    // Get org/clinic from case
    const { rows: [sc] } = await pool.query('SELECT org_id, clinic_id FROM specialty_case WHERE id=$1', [case_id]);
    if (!sc) return res.status(404).json({ error: 'Case not found' });
    const { rows: [de] } = await pool.query(
      `INSERT INTO tmj_diary_entry (case_id, org_id, clinic_id, entry_date, pain_morning, pain_afternoon, pain_evening, worst_today, sleep_disturbed, jaw_locking_episode, major_triggers, free_text, submitted_at, submission_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13)
       ON CONFLICT (case_id, entry_date) DO UPDATE SET worst_today=$8, free_text=$12, updated_at=NOW() RETURNING *`,
      [case_id, sc.org_id, sc.clinic_id, entry_date, pain_morning||null, pain_afternoon||null, pain_evening||null, worst_today||null, sleep_disturbed!=null?sleep_disturbed:null, jaw_locking_episode!=null?jaw_locking_episode:null, major_triggers, free_text||null, submission_channel]
    );
    res.status(201).json(de);
  } catch (err) { next(err); }
});

// ── GET /reports/active-cases ─────────────────────────────────────────────────
router.get('/reports/active-cases', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { rows } = await pool.query(
      `SELECT sc.id, sc.external_case_no, sc.started_at, tcd.current_phase, tcd.chief_complaint,
              tcd.suspected_axis_i, p.name AS patient_name
       FROM specialty_case sc JOIN tmj_case_detail tcd ON tcd.case_id=sc.id JOIN patients p ON p.id=sc.patient_id
       WHERE sc.org_id=$1 AND sc.clinic_id=$2 AND sc.status='ACTIVE' AND sc.deleted_at IS NULL ORDER BY sc.started_at DESC`,
      [orgId, clinicId]
    );
    res.json({ count: rows.length, cases: rows });
  } catch (err) { next(err); }
});

module.exports = router;
