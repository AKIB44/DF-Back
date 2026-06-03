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

const { orgId: _o, clinicId: _c, userId: _u } = {}; // for IDE hints only

// ── Schemas ───────────────────────────────────────────────────────────────────
const STAGES = ['PLANNING','SURGICAL_STAGE_1','OSSEOINTEGRATION','SURGICAL_STAGE_2',
  'SOFT_TISSUE_HEALING','PROSTHETIC_IMPRESSION','PROSTHETIC_TRIAL',
  'PROSTHETIC_DELIVERY','FIRST_FOLLOW_UP','MAINTENANCE'];

const createCaseSchema = Joi.object({
  patient_id:            Joi.string().uuid().required(),
  primary_doctor_id:     Joi.string().uuid().optional(),
  treatment_plan_id:     Joi.string().uuid().optional().allow(null),
  protocol:              Joi.string().valid('SINGLE_TOOTH','MULTIPLE_ADJACENT','IMPLANT_BRIDGE','OVERDENTURE','FULL_ARCH_FIXED','ZYGOMATIC').default('SINGLE_TOOTH'),
  is_two_stage:          Joi.boolean().default(true),
  same_day_loading:      Joi.boolean().default(false),
  planned_fixture_count: Joi.number().integer().min(1).required(),
  surgeon_id:            Joi.string().uuid().optional(),
  planning_notes:        Joi.string().max(2000).optional().allow(''),
});

const fixtureSchema = Joi.object({
  brand:                 Joi.string().max(100).required(),
  system:                Joi.string().max(100).required(),
  diameter_mm:           Joi.number().required(),
  length_mm:             Joi.number().required(),
  surface:               Joi.string().max(60).optional(),
  lot_number:            Joi.string().max(100).required(),
  expiry_date:           Joi.string().isoDate().required(),
  fdi_position:          Joi.number().integer().min(11).max(85).required(),
  insertion_torque_ncm:  Joi.number().optional(),
  primary_stability_isq: Joi.number().optional(),
  bone_density:          Joi.string().optional(),
  technique:             Joi.string().optional(),
  immediate_loading:     Joi.boolean().default(false),
  notes:                 Joi.string().max(2000).optional().allow(''),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function scopeCheck(r) { return [r.context.orgId, r.context.clinicId]; }

// ── POST /cases ───────────────────────────────────────────────────────────────
router.post('/cases', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { error, value } = createCaseSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const { orgId, clinicId, userId } = req.context;
    const { patient_id, primary_doctor_id, treatment_plan_id, protocol, is_two_stage, same_day_loading, planned_fixture_count, surgeon_id, planning_notes } = value;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sc = await client.query(
        `INSERT INTO specialty_case (org_id, clinic_id, patient_id, case_type, status, primary_doctor_id, treatment_plan_id, created_by, updated_by)
         VALUES ($1,$2,$3,'IMPLANT','ACTIVE',$4,$5,$6,$6) RETURNING *`,
        [orgId, clinicId, patient_id, primary_doctor_id || userId, treatment_plan_id || null, userId]
      );
      const caseId = sc.rows[0].id;
      await client.query(
        `INSERT INTO implant_case_detail (case_id, org_id, clinic_id, protocol, is_two_stage, same_day_loading, planned_fixture_count, surgeon_id, planning_notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [caseId, orgId, clinicId, protocol, is_two_stage, same_day_loading, planned_fixture_count, surgeon_id || null, planning_notes || null, userId]
      );
      await client.query(
        `INSERT INTO specialty_milestone (org_id, clinic_id, case_id, kind, occurred_at, title, created_by, updated_by)
         VALUES ($1,$2,$3,'CASE_OPENED',NOW(),'Implant case opened',$4,$4)`,
        [orgId, clinicId, caseId, userId]
      );
      await client.query('COMMIT');
      res.status(201).json({ id: caseId, ...sc.rows[0] });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

// ── GET /cases/:id ────────────────────────────────────────────────────────────
router.get('/cases/:id', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { rows: [sc] } = await pool.query(
      `SELECT sc.*, icd.*, p.name AS patient_name
       FROM specialty_case sc
       JOIN implant_case_detail icd ON icd.case_id = sc.id
       JOIN patients p ON p.id = sc.patient_id
       WHERE sc.id = $1 AND sc.org_id = $2 AND sc.clinic_id = $3 AND sc.deleted_at IS NULL`,
      [req.params.id, orgId, clinicId]
    );
    if (!sc) return res.status(404).json({ error: 'Not found' });
    const [fixtures, prostheses, complications, maintenance, milestones] = await Promise.all([
      pool.query('SELECT * FROM implant_fixture WHERE case_id=$1 AND deleted_at IS NULL ORDER BY placed_at', [req.params.id]),
      pool.query('SELECT * FROM implant_prosthesis WHERE case_id=$1 AND deleted_at IS NULL ORDER BY created_at', [req.params.id]),
      pool.query('SELECT * FROM implant_complication WHERE case_id=$1 AND deleted_at IS NULL ORDER BY identified_at DESC', [req.params.id]),
      pool.query('SELECT * FROM implant_maintenance_visit WHERE case_id=$1 AND deleted_at IS NULL ORDER BY scheduled_at', [req.params.id]),
      pool.query('SELECT * FROM specialty_milestone WHERE case_id=$1 AND deleted_at IS NULL ORDER BY occurred_at', [req.params.id]),
    ]);
    res.json({ ...sc, fixtures: fixtures.rows, prostheses: prostheses.rows, complications: complications.rows, maintenance_visits: maintenance.rows, milestones: milestones.rows });
  } catch (err) { next(err); }
});

// ── PATCH /cases/:id/detail ───────────────────────────────────────────────────
router.patch('/cases/:id/detail', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const allowed = ['protocol','is_two_stage','same_day_loading','current_stage','planned_fixture_count','planned_prosthesis_type','bone_quality_d_class','needs_bone_graft','needs_sinus_lift','sinus_lift_side','surgeon_id','prosthodontist_id','planning_notes'];
    const sets = []; const vals = [];
    for (const k of allowed) { if (req.body[k] !== undefined) { sets.push(`${k}=$${vals.length+1}`); vals.push(req.body[k]); } }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(userId, req.params.id, orgId, clinicId);
    const n = vals.length;
    await pool.query(`UPDATE implant_case_detail SET ${sets.join(',')}, updated_by=$${n-3}, updated_at=NOW() WHERE case_id=$${n-2} AND org_id=$${n-1} AND clinic_id=$${n}`, vals);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── PATCH /cases/:id/advance-stage ───────────────────────────────────────────
router.patch('/cases/:id/advance-stage', requirePermission(P.SPECIALTY_UPDATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { stage, override_reason } = req.body;
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    await pool.query(`UPDATE implant_case_detail SET current_stage=$1, updated_by=$2, updated_at=NOW() WHERE case_id=$3 AND org_id=$4 AND clinic_id=$5`, [stage, userId, req.params.id, orgId, clinicId]);
    await pool.query(`INSERT INTO specialty_milestone (org_id, clinic_id, case_id, kind, occurred_at, title, details, created_by, updated_by) VALUES ($1,$2,$3,'CUSTOM',NOW(),$4,$5,$6,$6)`,
      [orgId, clinicId, req.params.id, `Stage: ${stage}`, override_reason ? { override_reason } : null, userId]);
    res.json({ stage });
  } catch (err) { next(err); }
});

// ── POST /cases/:id/fixtures ──────────────────────────────────────────────────
router.post('/cases/:id/fixtures', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { error, value } = fixtureSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const { orgId, clinicId, userId } = req.context;
    const { rows: [sc] } = await pool.query('SELECT patient_id FROM specialty_case WHERE id=$1 AND org_id=$2', [req.params.id, orgId]);
    if (!sc) return res.status(404).json({ error: 'Case not found' });
    const { rows: [fix] } = await pool.query(
      `INSERT INTO implant_fixture (case_id, patient_id, org_id, clinic_id, brand, system, diameter_mm, length_mm, surface, lot_number, expiry_date, fdi_position, insertion_torque_ncm, primary_stability_isq, bone_density, technique, immediate_loading, notes, placed_at, placed_by, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),$19,'PLACED',$19,$19) RETURNING *`,
      [req.params.id, sc.patient_id, orgId, clinicId, value.brand, value.system, value.diameter_mm, value.length_mm, value.surface||null, value.lot_number, value.expiry_date, value.fdi_position, value.insertion_torque_ncm||null, value.primary_stability_isq||null, value.bone_density||null, value.technique||null, value.immediate_loading, value.notes||null, userId]
    );
    res.status(201).json(fix);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/complications ────────────────────────────────────────────
router.post('/cases/:id/complications', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { kind, severity = 'MINOR', action_taken, notes, fixture_id } = req.body;
    if (!kind || !action_taken) return res.status(400).json({ error: 'kind and action_taken required' });
    const { rows: [comp] } = await pool.query(
      `INSERT INTO implant_complication (fixture_id, case_id, org_id, clinic_id, kind, severity, identified_at, identified_by, action_taken, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9,$7,$7) RETURNING *`,
      [fixture_id||null, req.params.id, orgId, clinicId, kind, severity, userId, action_taken, notes||null]
    );
    res.status(201).json(comp);
  } catch (err) { next(err); }
});

// ── POST /cases/:id/maintenance-visits ───────────────────────────────────────
router.post('/cases/:id/maintenance-visits', requirePermission(P.SPECIALTY_CREATE), async (req, res, next) => {
  try {
    const { orgId, clinicId, userId } = req.context;
    const { scheduled_at, notes } = req.body;
    const { rows: [mv] } = await pool.query(
      `INSERT INTO implant_maintenance_visit (case_id, org_id, clinic_id, scheduled_at, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [req.params.id, orgId, clinicId, scheduled_at||null, notes||null, userId]
    );
    res.status(201).json(mv);
  } catch (err) { next(err); }
});

// ── GET /reports/active-cases ─────────────────────────────────────────────────
router.get('/reports/active-cases', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { rows } = await pool.query(
      `SELECT sc.id, sc.external_case_no, sc.started_at, sc.status,
              icd.current_stage, icd.planned_fixture_count,
              p.name AS patient_name
       FROM specialty_case sc
       JOIN implant_case_detail icd ON icd.case_id = sc.id
       JOIN patients p ON p.id = sc.patient_id
       WHERE sc.org_id=$1 AND sc.clinic_id=$2 AND sc.status='ACTIVE' AND sc.deleted_at IS NULL
       ORDER BY sc.started_at DESC`,
      [orgId, clinicId]
    );
    res.json({ count: rows.length, cases: rows });
  } catch (err) { next(err); }
});

// ── Admin: recall search ──────────────────────────────────────────────────────
router.get('/recall-search', requirePermission(P.SPECIALTY_VIEW), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const { lot, brand, from, to } = req.query;
    const conditions = ['f.org_id=$1', 'f.clinic_id=$2', 'f.deleted_at IS NULL'];
    const params = [orgId, clinicId];
    if (lot) { params.push(`%${lot}%`); conditions.push(`f.lot_number ILIKE $${params.length}`); }
    if (brand) { params.push(`%${brand}%`); conditions.push(`f.brand ILIKE $${params.length}`); }
    if (from) { params.push(from); conditions.push(`f.placed_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`f.placed_at <= $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT f.*, p.name AS patient_name, p.phone
       FROM implant_fixture f JOIN patients p ON p.id = f.patient_id
       WHERE ${conditions.join(' AND ')} ORDER BY f.placed_at DESC LIMIT 200`,
      params
    );
    res.json({ count: rows.length, fixtures: rows });
  } catch (err) { next(err); }
});

module.exports = router;
