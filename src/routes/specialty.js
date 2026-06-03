const express = require('express');
const Joi     = require('joi');
const db      = require('../db');
const authenticate         = require('../middleware/authenticate');
const validate             = require('../middleware/validate');
const tenantScope          = require('../rbac/tenant-scope.middleware');
const auditMw              = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                    = require('../rbac/permissions.constants');
const { createError }      = require('../helpers/errors');

const router = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── Schemas ───────────────────────────────────────────────────────────────────

const CASE_TYPES   = ['ORTHO', 'IMPLANT', 'PAEDO', 'ENDO', 'TMJ'];
const CASE_STATUSES = ['ACTIVE', 'PAUSED', 'TRANSFERRED', 'ABANDONED', 'COMPLETED'];

const createCaseSchema = Joi.object({
  patient_id:               Joi.string().uuid().required(),
  case_type:                Joi.string().valid(...CASE_TYPES).required(),
  primary_doctor_id:        Joi.string().uuid().optional(),
  treatment_plan_id:        Joi.string().uuid().optional().allow(null),
  started_at:               Joi.string().isoDate().optional(),
  expected_duration_months: Joi.number().integer().min(1).max(120).optional().allow(null),
  case_summary:             Joi.string().max(2000).optional().allow('', null),
  external_case_no:         Joi.string().max(100).optional().allow('', null),
});

const updateCaseSchema = Joi.object({
  case_summary:             Joi.string().max(2000).optional().allow('', null),
  primary_doctor_id:        Joi.string().uuid().optional(),
  treatment_plan_id:        Joi.string().uuid().optional().allow(null),
  expected_duration_months: Joi.number().integer().min(1).max(120).optional().allow(null),
  external_case_no:         Joi.string().max(100).optional().allow('', null),
});

const statusTransitionSchema = Joi.object({
  status: Joi.string().valid(...CASE_STATUSES).required(),
  reason: Joi.string().max(1000).optional().allow('', null),
});

const milestoneSchema = Joi.object({
  kind:        Joi.string().required(),
  occurred_at: Joi.string().isoDate().optional(),
  title:       Joi.string().max(500).required(),
  details:     Joi.object().optional().default({}),
  visit_id:    Joi.string().uuid().optional().allow(null),
});

const visitSchema = Joi.object({
  session_id:   Joi.string().uuid().optional().allow(null),
  visit_number: Joi.number().integer().min(1).optional(),
  visit_type:   Joi.string().max(200).optional().allow('', null),
  notes:        Joi.string().max(2000).optional().allow('', null),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCaseOwnedBy(client_or_db, caseId, orgId, clinicId) {
  const { rows } = await client_or_db.query(
    `SELECT * FROM specialty_case
      WHERE id = $1 AND org_id = $2 AND clinic_id = $3 AND deleted_at IS NULL`,
    [caseId, orgId, clinicId]
  );
  return rows[0] || null;
}

async function nextVisitNumber(db_inst, caseId) {
  const { rows } = await db_inst.query(
    `SELECT COALESCE(MAX(visit_number), 0) + 1 AS next
       FROM specialty_visit
      WHERE case_id = $1 AND deleted_at IS NULL`,
    [caseId]
  );
  return rows[0].next;
}

// ── POST /cases ───────────────────────────────────────────────────────────────
router.post(
  '/cases',
  ...authChain,
  requirePermission(P.SPECIALTY_CREATE),
  validate(createCaseSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const doctorId = b.primary_doctor_id || userId;

      const { rows } = await db.query(
        `INSERT INTO specialty_case
           (org_id, clinic_id, patient_id, case_type, status, primary_doctor_id,
            treatment_plan_id, started_at, expected_duration_months,
            case_summary, external_case_no, created_by, updated_by)
         VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,
                 COALESCE($7::TIMESTAMPTZ, NOW()),
                 $8,$9,$10,$11,$11)
         RETURNING *`,
        [
          orgId, clinicId, b.patient_id, b.case_type, doctorId,
          b.treatment_plan_id || null,
          b.started_at || null,
          b.expected_duration_months || null,
          b.case_summary || null,
          b.external_case_no || null,
          userId,
        ]
      );

      const specialtyCase = rows[0];

      // Auto-log CASE_OPENED milestone
      await db.query(
        `INSERT INTO specialty_milestone
           (org_id, clinic_id, case_id, kind, occurred_at, title, details, created_by, updated_by)
         VALUES ($1,$2,$3,'CASE_OPENED', $4, 'Case Opened', $5, $6, $6)`,
        [
          orgId, clinicId, specialtyCase.id,
          specialtyCase.started_at,
          JSON.stringify({ case_type: b.case_type, doctor_id: doctorId }),
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'specialty_case',
        entity_id:   specialtyCase.id,
        action:      'CREATE_SPECIALTY_CASE',
        details:     { case_type: b.case_type, patient_id: b.patient_id },
      });

      return res.status(201).json({ case: specialtyCase });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /cases/:id ────────────────────────────────────────────────────────────
router.get(
  '/cases/:id',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;

    try {
      const specialtyCase = await getCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!specialtyCase) return next(createError(404, 'Specialty case not found'));

      const [visitsRes, milestonesRes] = await Promise.all([
        db.query(
          `SELECT sv.*, cs.started_at AS session_date
             FROM specialty_visit sv
             LEFT JOIN clinical_session cs ON cs.id = sv.session_id
            WHERE sv.case_id = $1 AND sv.deleted_at IS NULL
            ORDER BY sv.visit_number ASC`,
          [req.params.id]
        ),
        db.query(
          `SELECT * FROM specialty_milestone
            WHERE case_id = $1 AND deleted_at IS NULL
            ORDER BY occurred_at ASC`,
          [req.params.id]
        ),
      ]);

      return res.json({
        case:       specialtyCase,
        visits:     visitsRes.rows,
        milestones: milestonesRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /cases/:id ──────────────────────────────────────────────────────────
router.patch(
  '/cases/:id',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(updateCaseSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const existing = await getCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Specialty case not found'));

      const sets  = ['updated_at = NOW()', 'updated_by = $1'];
      const vals  = [userId];
      let   idx   = 2;

      const fields = ['case_summary', 'primary_doctor_id', 'treatment_plan_id',
                      'expected_duration_months', 'external_case_no'];
      for (const f of fields) {
        if (b[f] !== undefined) {
          sets.push(`${f} = $${idx++}`);
          vals.push(b[f]);
        }
      }

      vals.push(req.params.id, orgId, clinicId);
      const { rows } = await db.query(
        `UPDATE specialty_case SET ${sets.join(', ')}
          WHERE id = $${idx} AND org_id = $${idx + 1} AND clinic_id = $${idx + 2} AND deleted_at IS NULL
          RETURNING *`,
        vals
      );

      req.audit.write({
        entity_type: 'specialty_case',
        entity_id:   req.params.id,
        action:      'UPDATE_SPECIALTY_CASE',
        details:     b,
      });

      return res.json({ case: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /patients/:patientId/cases ────────────────────────────────────────────
router.get(
  '/patients/:patientId/cases',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    const { status } = req.query;

    try {
      const params = [orgId, clinicId, req.params.patientId];
      let whereExtra = '';
      if (status) {
        params.push(status.toString().toUpperCase());
        whereExtra = ` AND sc.status = $${params.length}`;
      }

      const { rows } = await db.query(
        `SELECT sc.*,
                TRIM(u.first_name || ' ' || u.last_name) AS doctor_name,
                (SELECT COUNT(*)::int FROM specialty_visit sv
                  WHERE sv.case_id = sc.id AND sv.deleted_at IS NULL) AS visit_count,
                (SELECT COUNT(*)::int FROM specialty_milestone sm
                  WHERE sm.case_id = sc.id AND sm.deleted_at IS NULL) AS milestone_count
           FROM specialty_case sc
           LEFT JOIN users u ON u.id = sc.primary_doctor_id
          WHERE sc.org_id = $1 AND sc.clinic_id = $2
            AND sc.patient_id = $3 AND sc.deleted_at IS NULL
            ${whereExtra}
          ORDER BY sc.started_at DESC`,
        params
      );

      return res.json({ cases: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /cases/:id/milestones ────────────────────────────────────────────────
router.post(
  '/cases/:id/milestones',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(milestoneSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const specialtyCase = await getCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!specialtyCase) return next(createError(404, 'Specialty case not found'));

      const { rows } = await db.query(
        `INSERT INTO specialty_milestone
           (org_id, clinic_id, case_id, visit_id, kind, occurred_at, title, details, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::TIMESTAMPTZ, NOW()), $7, $8, $9, $9)
         RETURNING *`,
        [
          orgId, clinicId, req.params.id,
          b.visit_id || null,
          b.kind,
          b.occurred_at || null,
          b.title,
          JSON.stringify(b.details || {}),
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'specialty_milestone',
        entity_id:   rows[0].id,
        action:      'ADD_MILESTONE',
        details:     { case_id: req.params.id, kind: b.kind },
      });

      return res.status(201).json({ milestone: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /cases/:id/visits ────────────────────────────────────────────────────
router.post(
  '/cases/:id/visits',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(visitSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const b = req.body;

    try {
      const specialtyCase = await getCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!specialtyCase) return next(createError(404, 'Specialty case not found'));

      const visitNumber = b.visit_number || await nextVisitNumber(db, req.params.id);

      const { rows } = await db.query(
        `INSERT INTO specialty_visit
           (org_id, clinic_id, case_id, session_id, visit_number, visit_type, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         RETURNING *`,
        [
          orgId, clinicId, req.params.id,
          b.session_id || null,
          visitNumber,
          b.visit_type || null,
          b.notes || null,
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'specialty_visit',
        entity_id:   rows[0].id,
        action:      'ADD_VISIT',
        details:     { case_id: req.params.id, visit_number: visitNumber },
      });

      return res.status(201).json({ visit: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /cases/:id/timeline ───────────────────────────────────────────────────
router.get(
  '/cases/:id/timeline',
  ...authChain,
  requirePermission(P.SPECIALTY_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;

    try {
      const specialtyCase = await getCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!specialtyCase) return next(createError(404, 'Specialty case not found'));

      const [milestonesRes, visitsRes] = await Promise.all([
        db.query(
          `SELECT sm.*,
                  TRIM(u.first_name || ' ' || u.last_name) AS created_by_name
             FROM specialty_milestone sm
             LEFT JOIN users u ON u.id = sm.created_by
            WHERE sm.case_id = $1 AND sm.deleted_at IS NULL
            ORDER BY sm.occurred_at ASC, sm.created_at ASC`,
          [req.params.id]
        ),
        db.query(
          `SELECT sv.*,
                  cs.started_at AS session_date,
                  TRIM(u.first_name || ' ' || u.last_name) AS doctor_name
             FROM specialty_visit sv
             LEFT JOIN clinical_session cs ON cs.id = sv.session_id
             LEFT JOIN users u ON u.id = cs.primary_doctor_id
            WHERE sv.case_id = $1 AND sv.deleted_at IS NULL
            ORDER BY sv.visit_number ASC`,
          [req.params.id]
        ),
      ]);

      return res.json({
        case:       specialtyCase,
        milestones: milestonesRes.rows,
        visits:     visitsRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /cases/:id/status ───────────────────────────────────────────────────
router.patch(
  '/cases/:id/status',
  ...authChain,
  requirePermission(P.SPECIALTY_UPDATE),
  validate(statusTransitionSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { status, reason } = req.body;

    try {
      const existing = await getCaseOwnedBy(db, req.params.id, orgId, clinicId);
      if (!existing) return next(createError(404, 'Specialty case not found'));

      // Build milestone kind from status
      const kindMap = {
        PAUSED:      'CASE_PAUSED',
        TRANSFERRED: 'CASE_TRANSFERRED',
        ABANDONED:   'CASE_ABANDONED',
        COMPLETED:   'CASE_COMPLETED',
        ACTIVE:      'CASE_RESUMED',
      };
      const milestoneKind = kindMap[status] || 'CUSTOM';

      const completedAt = status === 'COMPLETED' ? 'NOW()' : 'NULL';

      const { rows } = await db.query(
        `UPDATE specialty_case
            SET status = $1,
                completed_at = ${completedAt},
                updated_at = NOW(),
                updated_by = $2
          WHERE id = $3 AND org_id = $4 AND clinic_id = $5 AND deleted_at IS NULL
          RETURNING *`,
        [status, userId, req.params.id, orgId, clinicId]
      );

      if (!rows.length) return next(createError(404, 'Specialty case not found'));

      // Log milestone
      await db.query(
        `INSERT INTO specialty_milestone
           (org_id, clinic_id, case_id, kind, occurred_at, title, details, created_by, updated_by)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$7)`,
        [
          orgId, clinicId, req.params.id,
          milestoneKind,
          `Case status changed to ${status}`,
          JSON.stringify({ previous_status: existing.status, new_status: status, reason: reason || null }),
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'specialty_case',
        entity_id:   req.params.id,
        action:      `CASE_STATUS_${status}`,
        details:     { previous: existing.status, new: status, reason },
      });

      return res.json({ case: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
