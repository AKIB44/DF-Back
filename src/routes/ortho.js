const express = require('express');
const Joi     = require('joi');
const db      = require('../db');
const authenticate          = require('../middleware/authenticate');
const validate              = require('../middleware/validate');
const tenantScope           = require('../rbac/tenant-scope.middleware');
const auditMw               = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                     = require('../rbac/permissions.constants');
const { createError }       = require('../helpers/errors');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── Validation schemas ─────────────────────────────────────────────────────────

const ORTHO_PHASES = [
  'RECORDS', 'TREATMENT_PLANNING', 'BOND_UP', 'LEVELING_ALIGNING',
  'WORKING', 'FINISHING', 'DEBOND', 'RETENTION', 'RETENTION_REVIEW',
];

const APPLIANCE_TYPES = [
  'METAL_BRACES', 'CERAMIC_BRACES', 'SELF_LIGATING', 'CLEAR_ALIGNERS', 'COMBINATION',
];

const createCaseSchema = Joi.object({
  patient_id:               Joi.string().uuid().required(),
  primary_doctor_id:        Joi.string().uuid().optional(),
  treatment_plan_id:        Joi.string().uuid().optional().allow(null),
  started_at:               Joi.string().isoDate().optional(),
  expected_duration_months: Joi.number().integer().min(1).max(120).optional().allow(null),
  case_summary:             Joi.string().max(2000).optional().allow('', null),
  external_case_no:         Joi.string().max(100).optional().allow('', null),
  // ortho_case_detail fields
  appliance_type:           Joi.string().valid(...APPLIANCE_TYPES).optional().allow(null),
  angle_class_molar:        Joi.string().max(50).optional().allow('', null),
  angle_class_canine:       Joi.string().max(50).optional().allow('', null),
  overjet_mm:               Joi.number().optional().allow(null),
  overbite_mm:              Joi.number().optional().allow(null),
  open_bite:                Joi.boolean().optional(),
  crowding_upper_mm:        Joi.number().optional().allow(null),
  crowding_lower_mm:        Joi.number().optional().allow(null),
  spacing_upper_mm:         Joi.number().optional().allow(null),
  spacing_lower_mm:         Joi.number().optional().allow(null),
  extraction_plan:          Joi.array().items(Joi.number().integer()).optional(),
  treatment_objectives:     Joi.string().max(3000).optional().allow('', null),
  mechanics_notes:          Joi.string().max(3000).optional().allow('', null),
  slot_size:                Joi.string().max(50).optional().allow('', null),
});

const updateDetailSchema = Joi.object({
  appliance_type:           Joi.string().valid(...APPLIANCE_TYPES).optional().allow(null),
  angle_class_molar:        Joi.string().max(50).optional().allow('', null),
  angle_class_canine:       Joi.string().max(50).optional().allow('', null),
  overjet_mm:               Joi.number().optional().allow(null),
  overbite_mm:              Joi.number().optional().allow(null),
  open_bite:                Joi.boolean().optional(),
  crowding_upper_mm:        Joi.number().optional().allow(null),
  crowding_lower_mm:        Joi.number().optional().allow(null),
  spacing_upper_mm:         Joi.number().optional().allow(null),
  spacing_lower_mm:         Joi.number().optional().allow(null),
  extraction_plan:          Joi.array().items(Joi.number().integer()).optional(),
  expected_duration_months: Joi.number().integer().min(1).max(120).optional().allow(null),
  treatment_objectives:     Joi.string().max(3000).optional().allow('', null),
  mechanics_notes:          Joi.string().max(3000).optional().allow('', null),
  slot_size:                Joi.string().max(50).optional().allow('', null),
});

const phaseTransitionSchema = Joi.object({
  phase:  Joi.string().valid(...ORTHO_PHASES).required(),
  reason: Joi.string().max(1000).optional().allow('', null),
});

const visitDetailSchema = Joi.object({
  phase:                    Joi.string().max(100).optional().allow('', null),
  archwire_upper:           Joi.string().max(200).optional().allow('', null),
  archwire_lower:           Joi.string().max(200).optional().allow('', null),
  archwire_changed_upper:   Joi.boolean().optional(),
  archwire_changed_lower:   Joi.boolean().optional(),
  elastics_config:          Joi.object().optional().allow(null),
  compliance_self_report:   Joi.object().optional().allow(null),
  oral_hygiene_score:       Joi.number().integer().min(0).max(10).optional().allow(null),
  next_interval_weeks:      Joi.number().integer().min(1).max(52).optional().allow(null),
  visit_summary:            Joi.string().max(3000).optional().allow('', null),
});

const retentionPlanSchema = Joi.object({
  fixed_upper:            Joi.boolean().optional(),
  fixed_lower:            Joi.boolean().optional(),
  removable_type:         Joi.string().max(200).optional().allow('', null),
  wear_schedule:          Joi.string().max(1000).optional().allow('', null),
  recall_cadence_months:  Joi.number().integer().min(1).max(36).optional(),
  retention_started_at:   Joi.string().isoDate().optional().allow(null),
  notes:                  Joi.string().max(2000).optional().allow('', null),
});

const complianceSchema = Joi.object({
  source:                    Joi.string().max(100).optional(),
  reporting_period_start:    Joi.string().isoDate().optional().allow(null),
  reporting_period_end:      Joi.string().isoDate().optional().allow(null),
  aligner_hours_per_day_avg: Joi.number().optional().allow(null),
  elastic_compliance:        Joi.string().max(200).optional().allow('', null),
  oh_score:                  Joi.number().integer().min(0).max(10).optional().allow(null),
  notes:                     Joi.string().max(2000).optional().allow('', null),
  visit_id:                  Joi.string().uuid().optional().allow(null),
});

const alignerTraySchema = Joi.object({
  tray_number:           Joi.number().integer().min(1).required(),
  arch:                  Joi.string().valid('UPPER', 'LOWER', 'BOTH').optional(),
  prescribed_at:         Joi.string().isoDate().optional(),
  expected_completed_at: Joi.string().isoDate().optional().allow(null),
  notes:                 Joi.string().max(1000).optional().allow('', null),
  visit_id:              Joi.string().uuid().optional().allow(null),
});

const updateTraySchema = Joi.object({
  actual_completed_at:   Joi.string().isoDate().optional().allow(null),
  expected_completed_at: Joi.string().isoDate().optional().allow(null),
  notes:                 Joi.string().max(1000).optional().allow('', null),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getOrthoCaseOwnedBy(client_or_db, caseId, orgId, clinicId) {
  const { rows } = await client_or_db.query(
    `SELECT sc.*, ocd.current_phase, ocd.appliance_type
       FROM specialty_case sc
       LEFT JOIN ortho_case_detail ocd ON ocd.case_id = sc.id
      WHERE sc.id = $1 AND sc.org_id = $2 AND sc.clinic_id = $3
        AND sc.case_type = 'ORTHO' AND sc.deleted_at IS NULL`,
    [caseId, orgId, clinicId]
  );
  return rows[0] || null;
}

// ── POST /cases ────────────────────────────────────────────────────────────────
router.post(
  '/cases',
  ...authChain,
  requirePermission(P.SPECIALTY_CREATE),
  validate(createCaseSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;
    const client = await db.pool.connect();

    try {
      await client.query('BEGIN');

      const doctorId = b.primary_doctor_id || userId;

      // Create the base specialty_case
      const { rows: caseRows } = await client.query(
        `INSERT INTO specialty_case
           (org_id, clinic_id, patient_id, case_type, status, primary_doctor_id,
            treatment_plan_id, started_at, expected_duration_months,
            case_summary, external_case_no, created_by, updated_by)
         VALUES ($1,$2,$3,'ORTHO','ACTIVE',$4,$5,
                 COALESCE($6::TIMESTAMPTZ, NOW()),
                 $7,$8,$9,$10,$10)
         RETURNING *`,
        [
          orgId, clinicId, b.patient_id, doctorId,
          b.treatment_plan_id || null,
          b.started_at || null,
          b.expected_duration_months || null,
          b.case_summary || null,
          b.external_case_no || null,
          userId,
        ]
      );
      const specialtyCase = caseRows[0];

      // Create ortho_case_detail
      const { rows: detailRows } = await client.query(
        `INSERT INTO ortho_case_detail
           (case_id, org_id, clinic_id, appliance_type, angle_class_molar, angle_class_canine,
            overjet_mm, overbite_mm, open_bite, crowding_upper_mm, crowding_lower_mm,
            spacing_upper_mm, spacing_lower_mm, extraction_plan,
            expected_duration_months, treatment_objectives, mechanics_notes,
            current_phase, slot_size, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
         RETURNING *`,
        [
          specialtyCase.id, orgId, clinicId,
          b.appliance_type || null,
          b.angle_class_molar || null,
          b.angle_class_canine || null,
          b.overjet_mm ?? null,
          b.overbite_mm ?? null,
          b.open_bite ?? false,
          b.crowding_upper_mm ?? null,
          b.crowding_lower_mm ?? null,
          b.spacing_upper_mm ?? null,
          b.spacing_lower_mm ?? null,
          JSON.stringify(b.extraction_plan || []),
          b.expected_duration_months || null,
          b.treatment_objectives || null,
          b.mechanics_notes || null,
          'RECORDS',
          b.slot_size || null,
          userId,
        ]
      );

      // Log CASE_OPENED milestone
      await client.query(
        `INSERT INTO specialty_milestone
           (org_id, clinic_id, case_id, kind, occurred_at, title, details, created_by, updated_by)
         VALUES ($1,$2,$3,'CASE_OPENED',NOW(),'Orthodontic case opened',$4,$5,$5)`,
        [
          orgId, clinicId, specialtyCase.id,
          JSON.stringify({ appliance_type: b.appliance_type || null }),
          userId,
        ]
      );

      await client.query('COMMIT');

      req.audit.write({
        entity_type: 'ortho_case',
        entity_id:   specialtyCase.id,
        action:      'ORTHO_CASE_CREATE',
        details:     { patient_id: b.patient_id, appliance_type: b.appliance_type },
      });

      return res.status(201).json({ id: specialtyCase.id, case: specialtyCase, detail: detailRows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// ── GET /cases/:id ─────────────────────────────────────────────────────────────
router.get(
  '/cases/:id',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    const caseId = req.params.id;

    try {
      const specialtyCase = await getOrthoCaseOwnedBy(db, caseId, orgId, clinicId);
      if (!specialtyCase) return next(createError(404, 'Ortho case not found'));

      const [
        detailRes,
        visitsRes,
        archwireRes,
        elasticRes,
        retentionRes,
        complianceRes,
        trayRes,
      ] = await Promise.all([
        db.query(
          `SELECT * FROM ortho_case_detail WHERE case_id = $1`,
          [caseId]
        ),
        db.query(
          `SELECT sv.*, ovd.phase, ovd.archwire_upper, ovd.archwire_lower,
                  ovd.archwire_changed_upper, ovd.archwire_changed_lower,
                  ovd.elastics_config, ovd.compliance_self_report,
                  ovd.oral_hygiene_score, ovd.next_interval_weeks, ovd.visit_summary,
                  cs.started_at AS session_date,
                  TRIM(u.first_name || ' ' || u.last_name) AS doctor_name
             FROM specialty_visit sv
             LEFT JOIN ortho_visit_detail ovd ON ovd.visit_id = sv.id
             LEFT JOIN clinical_session cs ON cs.id = sv.session_id
             LEFT JOIN users u ON u.id = sv.created_by
            WHERE sv.case_id = $1 AND sv.deleted_at IS NULL
            ORDER BY sv.visit_number ASC`,
          [caseId]
        ),
        db.query(
          `SELECT * FROM ortho_archwire_log WHERE case_id = $1 ORDER BY placed_at ASC`,
          [caseId]
        ),
        db.query(
          `SELECT * FROM ortho_elastic_log WHERE case_id = $1 ORDER BY prescribed_at ASC`,
          [caseId]
        ),
        db.query(
          `SELECT * FROM ortho_retention_plan WHERE case_id = $1`,
          [caseId]
        ),
        db.query(
          `SELECT * FROM ortho_compliance_record WHERE case_id = $1 ORDER BY created_at ASC`,
          [caseId]
        ),
        db.query(
          `SELECT * FROM ortho_aligner_tray_log WHERE case_id = $1 ORDER BY tray_number ASC`,
          [caseId]
        ),
      ]);

      return res.json({
        case:       specialtyCase,
        detail:     detailRes.rows[0] || null,
        visits:     visitsRes.rows,
        archwires:  archwireRes.rows,
        elastics:   elasticRes.rows,
        retention:  retentionRes.rows[0] || null,
        compliance: complianceRes.rows,
        trays:      trayRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /cases/:id/detail ────────────────────────────────────────────────────
router.patch(
  '/cases/:id/detail',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(updateDetailSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const fields = [];
      const vals   = [];
      let   idx    = 1;

      const allowed = [
        'appliance_type', 'angle_class_molar', 'angle_class_canine',
        'overjet_mm', 'overbite_mm', 'open_bite',
        'crowding_upper_mm', 'crowding_lower_mm', 'spacing_upper_mm', 'spacing_lower_mm',
        'expected_duration_months', 'treatment_objectives', 'mechanics_notes', 'slot_size',
      ];

      for (const key of allowed) {
        if (b[key] !== undefined) {
          fields.push(`${key} = $${idx++}`);
          vals.push(b[key]);
        }
      }

      if (b.extraction_plan !== undefined) {
        fields.push(`extraction_plan = $${idx++}`);
        vals.push(JSON.stringify(b.extraction_plan));
      }

      if (fields.length === 0) return res.json({ detail: null });

      fields.push(`updated_by = $${idx++}`, `updated_at = NOW()`);
      vals.push(userId, req.params.id);

      const { rows } = await db.query(
        `UPDATE ortho_case_detail SET ${fields.join(', ')}
          WHERE case_id = $${idx}
          RETURNING *`,
        vals
      );

      req.audit.write({
        entity_type: 'ortho_case_detail',
        entity_id:   req.params.id,
        action:      'ORTHO_DETAIL_UPDATE',
        details:     b,
      });

      return res.json({ detail: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /cases/:id/phase-transition ──────────────────────────────────────────
router.post(
  '/cases/:id/phase-transition',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(phaseTransitionSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { phase, reason } = req.body;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const previousPhase = existing.current_phase;

      const { rows: detailRows } = await db.query(
        `UPDATE ortho_case_detail
            SET current_phase = $1, updated_at = NOW(), updated_by = $2
          WHERE case_id = $3
          RETURNING *`,
        [phase, userId, req.params.id]
      );

      // Log milestone
      await db.query(
        `INSERT INTO specialty_milestone
           (org_id, clinic_id, case_id, kind, occurred_at, title, details, created_by, updated_by)
         VALUES ($1,$2,$3,'CUSTOM',NOW(),$4,$5,$6,$6)`,
        [
          orgId, clinicId, req.params.id,
          `Phase transition: ${previousPhase} → ${phase}`,
          JSON.stringify({ previous_phase: previousPhase, new_phase: phase, reason: reason || null }),
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'ortho_case_detail',
        entity_id:   req.params.id,
        action:      'ORTHO_PHASE_TRANSITION',
        details:     { previous_phase: previousPhase, new_phase: phase, reason },
      });

      return res.json({ detail: detailRows[0], previous_phase: previousPhase });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /visits/:visitId/detail ───────────────────────────────────────────────
router.post(
  '/visits/:visitId/detail',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(visitDetailSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { visitId } = req.params;
    const b = req.body;

    try {
      // Verify visit exists and belongs to this tenant
      const { rows: visitRows } = await db.query(
        `SELECT sv.*, sc.id AS specialty_case_id
           FROM specialty_visit sv
           JOIN specialty_case sc ON sc.id = sv.case_id
          WHERE sv.id = $1 AND sv.org_id = $2 AND sv.clinic_id = $3
            AND sv.deleted_at IS NULL AND sc.case_type = 'ORTHO'`,
        [visitId, orgId, clinicId]
      );
      if (!visitRows.length) return next(createError(404, 'Ortho visit not found'));
      const visit = visitRows[0];

      const { rows } = await db.query(
        `INSERT INTO ortho_visit_detail
           (visit_id, org_id, clinic_id, case_id,
            phase, archwire_upper, archwire_lower,
            archwire_changed_upper, archwire_changed_lower,
            elastics_config, compliance_self_report,
            oral_hygiene_score, next_interval_weeks, visit_summary,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
         ON CONFLICT (visit_id) DO UPDATE SET
           phase                  = EXCLUDED.phase,
           archwire_upper         = EXCLUDED.archwire_upper,
           archwire_lower         = EXCLUDED.archwire_lower,
           archwire_changed_upper = EXCLUDED.archwire_changed_upper,
           archwire_changed_lower = EXCLUDED.archwire_changed_lower,
           elastics_config        = EXCLUDED.elastics_config,
           compliance_self_report = EXCLUDED.compliance_self_report,
           oral_hygiene_score     = EXCLUDED.oral_hygiene_score,
           next_interval_weeks    = EXCLUDED.next_interval_weeks,
           visit_summary          = EXCLUDED.visit_summary,
           updated_by             = EXCLUDED.updated_by,
           updated_at             = NOW()
         RETURNING *`,
        [
          visitId, orgId, clinicId, visit.specialty_case_id,
          b.phase || null,
          b.archwire_upper || null,
          b.archwire_lower || null,
          b.archwire_changed_upper ?? false,
          b.archwire_changed_lower ?? false,
          b.elastics_config ? JSON.stringify(b.elastics_config) : null,
          b.compliance_self_report ? JSON.stringify(b.compliance_self_report) : null,
          b.oral_hygiene_score ?? null,
          b.next_interval_weeks ?? null,
          b.visit_summary || null,
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'ortho_visit_detail',
        entity_id:   visitId,
        action:      'ORTHO_VISIT_DETAIL_UPSERT',
        details:     { case_id: visit.specialty_case_id },
      });

      return res.status(201).json({ visit_detail: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /cases/:id/archwires ───────────────────────────────────────────────────
router.get(
  '/cases/:id/archwires',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const { rows } = await db.query(
        `SELECT * FROM ortho_archwire_log
          WHERE case_id = $1 ORDER BY placed_at ASC`,
        [req.params.id]
      );
      return res.json({ archwires: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /cases/:id/elastics ────────────────────────────────────────────────────
router.get(
  '/cases/:id/elastics',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const { rows } = await db.query(
        `SELECT * FROM ortho_elastic_log
          WHERE case_id = $1 ORDER BY prescribed_at ASC`,
        [req.params.id]
      );
      return res.json({ elastics: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /cases/:id/retention-plan ────────────────────────────────────────────
router.post(
  '/cases/:id/retention-plan',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(retentionPlanSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      // Check retention plan doesn't already exist
      const { rows: check } = await db.query(
        `SELECT 1 FROM ortho_retention_plan WHERE case_id = $1`,
        [req.params.id]
      );
      if (check.length) return next(createError(409, 'Retention plan already exists. Use PATCH to update.'));

      const { rows } = await db.query(
        `INSERT INTO ortho_retention_plan
           (case_id, org_id, clinic_id, fixed_upper, fixed_lower, removable_type,
            wear_schedule, recall_cadence_months, retention_started_at, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING *`,
        [
          req.params.id, orgId, clinicId,
          b.fixed_upper ?? false,
          b.fixed_lower ?? false,
          b.removable_type || null,
          b.wear_schedule || null,
          b.recall_cadence_months ?? 6,
          b.retention_started_at || null,
          b.notes || null,
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'ortho_retention_plan',
        entity_id:   req.params.id,
        action:      'ORTHO_RETENTION_CREATE',
        details:     {},
      });

      return res.status(201).json({ retention_plan: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /cases/:id/retention-plan ───────────────────────────────────────────
router.patch(
  '/cases/:id/retention-plan',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(retentionPlanSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const fields = [];
      const vals   = [];
      let   idx    = 1;

      const allowed = [
        'fixed_upper', 'fixed_lower', 'removable_type', 'wear_schedule',
        'recall_cadence_months', 'retention_started_at', 'notes',
      ];

      for (const key of allowed) {
        if (b[key] !== undefined) {
          fields.push(`${key} = $${idx++}`);
          vals.push(b[key]);
        }
      }

      if (fields.length === 0) return res.json({ retention_plan: null });

      fields.push(`updated_by = $${idx++}`, `updated_at = NOW()`);
      vals.push(userId, req.params.id);

      const { rows } = await db.query(
        `UPDATE ortho_retention_plan SET ${fields.join(', ')}
          WHERE case_id = $${idx}
          RETURNING *`,
        vals
      );

      if (!rows.length) return next(createError(404, 'Retention plan not found'));

      req.audit.write({
        entity_type: 'ortho_retention_plan',
        entity_id:   req.params.id,
        action:      'ORTHO_RETENTION_UPDATE',
        details:     b,
      });

      return res.json({ retention_plan: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /cases/:id/compliance ─────────────────────────────────────────────────
router.post(
  '/cases/:id/compliance',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(complianceSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const { rows } = await db.query(
        `INSERT INTO ortho_compliance_record
           (org_id, clinic_id, case_id, visit_id, source,
            reporting_period_start, reporting_period_end,
            aligner_hours_per_day_avg, elastic_compliance, oh_score, notes,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING *`,
        [
          orgId, clinicId, req.params.id,
          b.visit_id || null,
          b.source || 'CLINICAL',
          b.reporting_period_start || null,
          b.reporting_period_end   || null,
          b.aligner_hours_per_day_avg ?? null,
          b.elastic_compliance || null,
          b.oh_score ?? null,
          b.notes || null,
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'ortho_compliance_record',
        entity_id:   rows[0].id,
        action:      'ORTHO_COMPLIANCE_ADD',
        details:     { case_id: req.params.id },
      });

      return res.status(201).json({ compliance: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /cases/:id/aligner-trays ──────────────────────────────────────────────
router.post(
  '/cases/:id/aligner-trays',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(alignerTraySchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const existing = await getOrthoCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Ortho case not found'));

      const { rows } = await db.query(
        `INSERT INTO ortho_aligner_tray_log
           (org_id, clinic_id, case_id, visit_id, tray_number, arch,
            prescribed_at, expected_completed_at, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,
                 COALESCE($7::TIMESTAMPTZ, NOW()),
                 $8,$9,$10,$10)
         RETURNING *`,
        [
          orgId, clinicId, req.params.id,
          b.visit_id || null,
          b.tray_number,
          b.arch || 'BOTH',
          b.prescribed_at || null,
          b.expected_completed_at || null,
          b.notes || null,
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'ortho_aligner_tray_log',
        entity_id:   rows[0].id,
        action:      'ORTHO_TRAY_ADD',
        details:     { case_id: req.params.id, tray_number: b.tray_number },
      });

      return res.status(201).json({ tray: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /aligner-trays/:id ───────────────────────────────────────────────────
router.patch(
  '/aligner-trays/:id',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(updateTraySchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const fields = [];
      const vals   = [];
      let   idx    = 1;

      if (b.actual_completed_at !== undefined) {
        fields.push(`actual_completed_at = $${idx++}`);
        vals.push(b.actual_completed_at);
      }
      if (b.expected_completed_at !== undefined) {
        fields.push(`expected_completed_at = $${idx++}`);
        vals.push(b.expected_completed_at);
      }
      if (b.notes !== undefined) {
        fields.push(`notes = $${idx++}`);
        vals.push(b.notes);
      }

      if (fields.length === 0) return res.json({ tray: null });

      fields.push(`updated_by = $${idx++}`, `updated_at = NOW()`);
      vals.push(userId, req.params.id, orgId, clinicId);

      const { rows } = await db.query(
        `UPDATE ortho_aligner_tray_log
            SET ${fields.join(', ')}
          WHERE id = $${idx} AND org_id = $${idx + 1} AND clinic_id = $${idx + 2}
          RETURNING *`,
        vals
      );

      if (!rows.length) return next(createError(404, 'Aligner tray not found'));

      req.audit.write({
        entity_type: 'ortho_aligner_tray_log',
        entity_id:   req.params.id,
        action:      'ORTHO_TRAY_UPDATE',
        details:     b,
      });

      return res.json({ tray: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /reports/active-cases ──────────────────────────────────────────────────
router.get(
  '/reports/active-cases',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;

    try {
      const { rows } = await db.query(
        `SELECT
           sc.id,
           sc.external_case_no,
           sc.started_at,
           sc.expected_duration_months,
           sc.status,
           sc.patient_id,
           TRIM(p.name) AS patient_name,
           ocd.appliance_type,
           ocd.current_phase,
           COALESCE(v.visit_count, 0) AS visit_count,
           v.last_visit_date,
           ROUND(
             LEAST(100,
               (EXTRACT(EPOCH FROM (NOW() - sc.started_at)) / 2592000.0)
               / NULLIF(ocd.expected_duration_months, 0) * 100
             )
           , 1) AS progress_pct
         FROM specialty_case sc
         JOIN patients p ON p.id = sc.patient_id
         LEFT JOIN ortho_case_detail ocd ON ocd.case_id = sc.id
         LEFT JOIN (
           SELECT case_id,
                  COUNT(*) AS visit_count,
                  MAX(created_at) AS last_visit_date
             FROM specialty_visit
            WHERE deleted_at IS NULL
            GROUP BY case_id
         ) v ON v.case_id = sc.id
         WHERE sc.org_id = $1
           AND sc.clinic_id = $2
           AND sc.case_type = 'ORTHO'
           AND sc.status = 'ACTIVE'
           AND sc.deleted_at IS NULL
         ORDER BY sc.started_at DESC`,
        [orgId, clinicId]
      );

      return res.json({
        count: rows.length,
        cases: rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
