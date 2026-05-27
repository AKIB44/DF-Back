const express     = require('express');
const Joi         = require('joi');
const { v4: uuidv4 } = require('uuid');
const db          = require('../db');
const sessionRepo = require('../repositories/session.repository');
const authenticate    = require('../middleware/authenticate');
const validate        = require('../middleware/validate');
const tenantScope     = require('../rbac/tenant-scope.middleware');
const auditMw         = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P               = require('../rbac/permissions.constants');
const { createError } = require('../helpers/errors');
const { getPresignedPutUrl, getPresignedUrl, deleteObject } = require('../services/s3Service');

const authChain = [authenticate, tenantScope, auditMw];

const router = express.Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const startTreatmentSchema = Joi.object({
  doctor_id: Joi.string().uuid().optional(), // defaults to req.user.sub
});

const soapSchema = Joi.object({
  subjective:  Joi.string().allow('').default(''),
  objective:   Joi.string().allow('').default(''),
  assessment:  Joi.string().allow('').default(''),
  plan:        Joi.string().allow('').default(''),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTx(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /appointments/:id/start-treatment  (Endpoint 1) ─────────────────────
router.post(
  '/appointments/:id/start-treatment',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(startTreatmentSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const appointmentId = req.params.id;

    try {
      // Fetch appointment and validate it belongs to this clinic
      const { rows: apptRows } = await db.query(
        `SELECT id, patient_id, status FROM appointments
         WHERE id = $1 AND clinic_id = $2`,
        [appointmentId, clinicId]
      );
      if (!apptRows.length) {
        return next(createError(404, 'Appointment not found'));
      }
      const appt = apptRows[0];

      // in_treatment means a session is already active — just resume it
      const allowedStatuses = ['confirmed', 'in_progress', 'in_treatment'];
      if (!allowedStatuses.includes(appt.status)) {
        return next(createError(409, `Cannot start treatment from status "${appt.status}"`));
      }

      // Check for an existing active session (idempotent — read-only)
      const { rows: existRows } = await db.query(
        `SELECT * FROM clinical_session
         WHERE org_id = $1 AND clinic_id = $2 AND appointment_id = $3
           AND deleted_at IS NULL
         ORDER BY started_at DESC LIMIT 1`,
        [orgId, clinicId, appointmentId]
      );
      const existing = existRows[0];
      if (existing && existing.status !== 'COMPLETED' && existing.status !== 'ABANDONED') {
        return res.json({ session: existing, resumed: true });
      }

      const doctorId = req.body.doctor_id || userId;

      const session = await withTx(async (client) => {
        // Transition appointment to in_treatment
        await client.query(
          `UPDATE appointments SET status = 'in_treatment', updated_at = NOW()
           WHERE id = $1`,
          [appointmentId]
        );

        const sess = await sessionRepo.createSession(client, {
          orgId, clinicId, appointmentId,
          patientId: appt.patient_id,
          doctorId,
          userId,
        });

        return sess;
      });

      req.audit.write({
        entity_type: 'clinical_session',
        entity_id:   session.id,
        action:      'START_TREATMENT',
        details:     { appointment_id: appointmentId, doctor_id: doctorId },
      });

      return res.status(201).json({ session });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /sessions/:id  (Endpoint 2) ──────────────────────────────────────────
router.get(
  '/sessions/:id',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const session = await sessionRepo.findById(
        { orgId, clinicId },
        req.params.id
      );
      if (!session) return next(createError(404, 'Session not found'));

      // Include SOAP note if it exists
      const note = await sessionRepo.getNoteBySession(session.id);

      return res.json({ session, note: note || null });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /sessions/:id/notes  (Endpoint 22) ─────────────────────────────────
router.patch(
  '/sessions/:id/notes',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(soapSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;

    try {
      // Verify session exists and is not sealed
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed — use addenda'));

      const note = await withTx(async (client) => {
        return sessionRepo.upsertNote(client, {
          orgId, clinicId, sessionId, userId,
          subjective: req.body.subjective,
          objective:  req.body.objective,
          assessment: req.body.assessment,
          plan:       req.body.plan,
        });
      });

      req.audit.write({
        entity_type: 'clinical_note',
        entity_id:   note.id,
        action:      'UPSERT_SOAP',
        details:     { session_id: sessionId },
      });

      return res.json({ note });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /sessions/:id/services  (Endpoint 15) ───────────────────────────────
const addServiceSchema = Joi.object({
  service_id:    Joi.string().uuid().required(),
  plan_item_id:  Joi.string().uuid().optional(),
  tooth_numbers: Joi.array().items(Joi.number().integer()).optional().default([]),
  quantity:      Joi.number().integer().min(1).default(1),
  performed_by:  Joi.string().uuid().optional(),
  discount_pct:  Joi.number().min(0).max(100).default(0),
  discount_flat: Joi.number().min(0).default(0),
  discount_reason: Joi.string().allow('').optional(),
  notes:         Joi.string().allow('').optional(),
});

router.post(
  '/sessions/:id/services',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(addServiceSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;

    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      // Fetch service price from catalog
      const { rows: svcRows } = await db.query(
        `SELECT id, name, price FROM services
         WHERE id = $1 AND clinic_id = $2 AND is_active = true`,
        [req.body.service_id, clinicId]
      );
      if (!svcRows.length) return next(createError(404, 'Service not found'));
      const svc = { ...svcRows[0], gst_applicable: false };

      const basePrice   = parseFloat(svc.price);
      const discountPct = req.body.discount_pct || 0;
      const discountFlat = req.body.discount_flat || 0;
      const finalCharge = Math.max(0,
        (basePrice * req.body.quantity) * (1 - discountPct / 100) - discountFlat
      );

      const planItemId = req.body.plan_item_id || null;

      let updatedPlanItem = null;
      const { rows } = await withTx(async (client) => {
        const result = await client.query(
          `INSERT INTO service_performed
             (org_id, clinic_id, session_id, service_id, plan_item_id, tooth_numbers, quantity,
              performed_by, base_price, discount_pct, discount_flat, discount_reason,
              final_charge, gst_applicable, status, notes, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'IN_PROGRESS',$15,$16,$16)
           RETURNING *`,
          [
            orgId, clinicId, sessionId, req.body.service_id,
            planItemId,
            req.body.tooth_numbers || [],
            req.body.quantity || 1,
            req.body.performed_by || userId,
            basePrice,
            discountPct,
            discountFlat,
            req.body.discount_reason || null,
            finalCharge,
            svc.gst_applicable || false,
            req.body.notes || null,
            userId,
          ]
        );

        // Flip plan item to IN_PROGRESS when a service is started against it
        if (planItemId) {
          const { rows: planRows } = await client.query(
            `UPDATE treatment_plan_item
             SET status = 'IN_PROGRESS', updated_by = $1
             WHERE id = $2 AND status IN ('PROPOSED','ACCEPTED') AND deleted_at IS NULL
             RETURNING *`,
            [userId, planItemId]
          );
          if (planRows.length) updatedPlanItem = planRows[0];
        }

        return result;
      });

      const servicePerformed = { ...rows[0], service_name: svc.name };

      req.audit.write({
        entity_type: 'service_performed',
        entity_id:   servicePerformed.id,
        action:      'ADD_SERVICE',
        details:     { session_id: sessionId, service_id: req.body.service_id, final_charge: finalCharge },
      });

      return res.status(201).json({ service: servicePerformed, plan_item: updatedPlanItem });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /services/:id  (Endpoint 16 — status transition) ───────────────────
const updateServiceSchema = Joi.object({
  status:         Joi.string().valid('COMPLETED', 'PARTIAL', 'ABANDONED').required(),
  abandon_reason: Joi.string().when('status', { is: 'ABANDONED', then: Joi.required() }),
  notes:          Joi.string().allow('').optional(),
  discount_pct:   Joi.number().min(0).max(100).optional(),
  discount_flat:  Joi.number().min(0).optional(),
  discount_reason: Joi.string().allow('').optional(),
});

router.patch(
  '/services/:id',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(updateServiceSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;

    try {
      // Fetch the service_performed row to get session context
      const { rows: spRows } = await db.query(
        `SELECT sp.*, cs.sealed_at, cs.org_id AS sess_org_id
         FROM service_performed sp
         JOIN clinical_session cs ON cs.id = sp.session_id
         WHERE sp.id = $1 AND sp.clinic_id = $2 AND sp.deleted_at IS NULL`,
        [req.params.id, clinicId]
      );
      if (!spRows.length) return next(createError(404, 'Service not found'));
      const sp = spRows[0];
      if (sp.sealed_at) return next(createError(409, 'Session is sealed'));

      const sets = ['status = $1', 'updated_at = NOW()', 'updated_by = $2'];
      const vals = [req.body.status, userId];

      if (req.body.status === 'COMPLETED' || req.body.status === 'PARTIAL') {
        sets.push(`completed_at = NOW()`);
      }
      if (req.body.abandon_reason) {
        sets.push(`abandon_reason = $${vals.length + 1}`);
        vals.push(req.body.abandon_reason);
      }
      if (req.body.notes !== undefined) {
        sets.push(`notes = $${vals.length + 1}`);
        vals.push(req.body.notes);
      }

      vals.push(req.params.id, clinicId);
      const { rows } = await db.query(
        `UPDATE service_performed SET ${sets.join(', ')}
         WHERE id = $${vals.length - 1} AND clinic_id = $${vals.length}
         RETURNING *`,
        vals
      );
      const updated = rows[0];

      // Sync plan item status when a service is completed or abandoned
      let updatedPlanItem = null;
      if (updated.plan_item_id) {
        if (req.body.status === 'COMPLETED') {
          // Increment done_sessions; if done_sessions >= estimated_sessions → DONE, else PARTIAL
          const { rows: piRows } = await db.query(
            `UPDATE treatment_plan_item
             SET done_sessions = done_sessions + 1,
                 status = CASE
                   WHEN done_sessions + 1 >= estimated_sessions THEN 'DONE'::plan_item_status
                   ELSE 'PARTIAL'::plan_item_status
                 END,
                 updated_by = $1
             WHERE id = $2 AND deleted_at IS NULL
             RETURNING *`,
            [userId, updated.plan_item_id]
          );
          if (piRows.length) updatedPlanItem = piRows[0];
        } else if (req.body.status === 'ABANDONED') {
          // Flip plan item back to ACCEPTED so it can be retried
          const { rows: piRows } = await db.query(
            `UPDATE treatment_plan_item
             SET status = 'ACCEPTED'::plan_item_status, updated_by = $1
             WHERE id = $2 AND status = 'IN_PROGRESS' AND deleted_at IS NULL
             RETURNING *`,
            [userId, updated.plan_item_id]
          );
          if (piRows.length) updatedPlanItem = piRows[0];
        }
      }

      req.audit.write({
        entity_type: 'service_performed',
        entity_id:   req.params.id,
        action:      `SERVICE_${req.body.status}`,
        details:     { session_id: sp.session_id },
      });

      return res.json({ service: updated, plan_item: updatedPlanItem });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /sessions/:id/services ────────────────────────────────────────────────
router.get(
  '/sessions/:id/services',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));

      const { rows } = await db.query(
        `SELECT sp.*, s.name AS service_name, s.description AS service_description
         FROM service_performed sp
         JOIN services s ON s.id = sp.service_id
         WHERE sp.session_id = $1 AND sp.deleted_at IS NULL
         ORDER BY sp.started_at ASC`,
        [req.params.id]
      );
      return res.json({ services: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /sessions/:id/end-treatment  (Endpoint 30 — basic seal) ─────────────
const endTreatmentSchema = Joi.object({
  variance_reason: Joi.string().allow('').optional(),
});

router.post(
  '/sessions/:id/end-treatment',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(endTreatmentSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;

    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session already sealed'));

      // Block if any services still IN_PROGRESS
      const { rows: inProgress } = await db.query(
        `SELECT id FROM service_performed
         WHERE session_id = $1 AND status = 'IN_PROGRESS' AND deleted_at IS NULL`,
        [sessionId]
      );
      if (inProgress.length) {
        return next(createError(422, `${inProgress.length} service(s) still in progress — complete or abandon them first`));
      }

      const sealed = await withTx(async (client) => {
        const { rows: sessRows } = await client.query(
          `UPDATE clinical_session
           SET status      = 'COMPLETED',
               sealed_at   = NOW(),
               sealed_by   = $1,
               ended_at    = NOW(),
               updated_at  = NOW(),
               updated_by  = $1,
               variance_reason = $4
           WHERE id = $2 AND org_id = $3 AND clinic_id = $5 AND deleted_at IS NULL
           RETURNING *`,
          [userId, sessionId, orgId, req.body.variance_reason || null, clinicId]
        );

        // Transition appointment to done (billing handled separately by reception)
        await client.query(
          `UPDATE appointments SET status = 'done', updated_at = NOW()
           WHERE id = $1`,
          [session.appointment_id]
        );

        return sessRows[0];
      });

      req.audit.write({
        entity_type: 'clinical_session',
        entity_id:   sessionId,
        action:      'SEAL_SESSION',
        details:     { sealed_by: userId },
      });

      return res.json({ session: sealed });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /sessions/:id/examination  (Endpoint 3 — T2.2) ─────────────────────
const examinationSchema = Joi.object({
  chief_complaint:      Joi.string().allow('').default(''),
  pain_score:           Joi.number().integer().min(0).max(10).allow(null).default(null),
  pain_site:            Joi.string().allow('', null).optional(),
  pain_trigger:         Joi.string().valid('cold','hot','sweet','biting','spontaneous','none').allow(null).optional(),
  intraoral_findings:   Joi.object().optional().default({}),
  extraoral_findings:   Joi.object().optional().default({}),
  soft_tissue_findings: Joi.object().optional().default({}),
  occlusion_notes:      Joi.string().allow('', null).optional(),
});

router.patch(
  '/sessions/:id/examination',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(examinationSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      const b = req.body;
      const { rows } = await db.query(
        `INSERT INTO examination
           (org_id, clinic_id, session_id, chief_complaint, pain_score, pain_site,
            pain_trigger, intraoral_findings, extraoral_findings, soft_tissue_findings,
            occlusion_notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (session_id) DO UPDATE SET
           chief_complaint      = EXCLUDED.chief_complaint,
           pain_score           = EXCLUDED.pain_score,
           pain_site            = EXCLUDED.pain_site,
           pain_trigger         = EXCLUDED.pain_trigger,
           intraoral_findings   = EXCLUDED.intraoral_findings,
           extraoral_findings   = EXCLUDED.extraoral_findings,
           soft_tissue_findings = EXCLUDED.soft_tissue_findings,
           occlusion_notes      = EXCLUDED.occlusion_notes,
           updated_at           = NOW(),
           updated_by           = EXCLUDED.updated_by
         RETURNING *`,
        [orgId, clinicId, sessionId,
         b.chief_complaint, b.pain_score, b.pain_site || null,
         b.pain_trigger || null,
         JSON.stringify(b.intraoral_findings || {}),
         JSON.stringify(b.extraoral_findings || {}),
         JSON.stringify(b.soft_tissue_findings || {}),
         b.occlusion_notes || null,
         userId]
      );
      req.audit.write({ entity_type: 'examination', entity_id: rows[0].id,
        action: 'UPSERT_EXAMINATION', details: { session_id: sessionId } });
      return res.json({ examination: rows[0] });
    } catch (err) { next(err); }
  }
);

// GET examination for a session
router.get(
  '/sessions/:id/examination',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));
      const { rows } = await db.query(
        `SELECT * FROM examination WHERE session_id = $1 AND deleted_at IS NULL`,
        [req.params.id]
      );
      return res.json({ examination: rows[0] || null });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/diagnoses  (Endpoint 5 — T2.3) ────────────────────────
const diagnosisSchema = Joi.object({
  diagnosis_text: Joi.string().trim().min(1).required(),
  icd10_code:     Joi.string().allow('', null).optional(),
  tooth_numbers:  Joi.array().items(Joi.number().integer()).optional().default([]),
  kind:           Joi.string().valid('provisional','differential','final').default('provisional'),
});

router.post(
  '/sessions/:id/diagnoses',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(diagnosisSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      const { rows } = await db.query(
        `INSERT INTO diagnosis
           (org_id, clinic_id, session_id, diagnosis_text, icd10_code,
            tooth_numbers, kind, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [orgId, clinicId, sessionId, req.body.diagnosis_text,
         req.body.icd10_code || null, req.body.tooth_numbers || [],
         req.body.kind, userId]
      );
      req.audit.write({ entity_type: 'diagnosis', entity_id: rows[0].id,
        action: 'ADD_DIAGNOSIS', details: { session_id: sessionId } });
      return res.status(201).json({ diagnosis: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── DELETE /sessions/:id/diagnoses/:dxId  (Endpoint 6) ───────────────────────
router.delete(
  '/sessions/:id/diagnoses/:dxId',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      const { rows } = await db.query(
        `UPDATE diagnosis SET deleted_at = NOW(), updated_by = $1
         WHERE id = $2 AND session_id = $3 AND clinic_id = $4 AND deleted_at IS NULL
         RETURNING id`,
        [userId, req.params.dxId, req.params.id, clinicId]
      );
      if (!rows.length) return next(createError(404, 'Diagnosis not found'));
      req.audit.write({ entity_type: 'diagnosis', entity_id: req.params.dxId,
        action: 'DELETE_DIAGNOSIS', details: { session_id: req.params.id } });
      return res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// GET diagnoses for a session
router.get(
  '/sessions/:id/diagnoses',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));
      const { rows } = await db.query(
        `SELECT * FROM diagnosis WHERE session_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
        [req.params.id]
      );
      return res.json({ diagnoses: rows });
    } catch (err) { next(err); }
  }
);

// ── GET /sessions/:id/chart ───────────────────────────────────────────────────
router.get(
  '/sessions/:id/chart',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));

      const { rows } = await db.query(
        `SELECT tcs.*, prev.chart_data AS baseline_data
         FROM tooth_chart_snapshot tcs
         LEFT JOIN tooth_chart_snapshot prev ON prev.id = tcs.baseline_ref
         WHERE tcs.session_id = $1 AND tcs.deleted_at IS NULL`,
        [req.params.id]
      );
      return res.json({ chart: rows[0] || null });
    } catch (err) { next(err); }
  }
);

// ── PUT /sessions/:id/chart  (Endpoint 4) ────────────────────────────────────
const chartSchema = Joi.object({
  chart_data: Joi.object().required(),
});

router.put(
  '/sessions/:id/chart',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(chartSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      const { rows } = await db.query(
        `INSERT INTO tooth_chart_snapshot
           (org_id, clinic_id, session_id, chart_data, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (session_id) DO UPDATE
           SET chart_data = EXCLUDED.chart_data,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [orgId, clinicId, sessionId, JSON.stringify(req.body.chart_data), userId]
      );
      return res.json({ chart: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── POST /patients/:patientId/treatment-plans ─────────────────────────────────
router.post(
  '/patients/:patientId/treatment-plans',
  ...authChain,
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { patientId } = req.params;
    const { title = 'Treatment Plan' } = req.body;
    try {
      const { rows } = await db.query(
        `INSERT INTO treatment_plan (org_id, clinic_id, patient_id, title, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
        [orgId, clinicId, patientId, title, userId]
      );
      return res.status(201).json({ plan: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── GET /patients/:patientId/treatment-plans ──────────────────────────────────
router.get(
  '/patients/:patientId/treatment-plans',
  ...authChain,
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    const { patientId } = req.params;
    try {
      const { rows: plans } = await db.query(
        `SELECT tp.*,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', tpi.id,
                      'plan_id', tpi.plan_id,
                      'service_id', tpi.service_id,
                      'service_name', s.name,
                      'linked_diagnosis_id', tpi.linked_diagnosis_id,
                      'tooth_numbers', tpi.tooth_numbers,
                      'estimated_sessions', tpi.estimated_sessions,
                      'done_sessions', tpi.done_sessions,
                      'cost_min', tpi.cost_min,
                      'cost_max', tpi.cost_max,
                      'priority', tpi.priority,
                      'status', tpi.status,
                      'decline_reason', tpi.decline_reason,
                      'patient_facing_notes', tpi.patient_facing_notes,
                      'created_at', tpi.created_at
                    ) ORDER BY tpi.created_at
                  ) FILTER (WHERE tpi.id IS NOT NULL),
                  '[]'
                ) AS items
         FROM treatment_plan tp
         LEFT JOIN treatment_plan_item tpi
           ON tpi.plan_id = tp.id AND tpi.deleted_at IS NULL
         LEFT JOIN services s ON s.id = tpi.service_id
         WHERE tp.org_id = $1 AND tp.clinic_id = $2
           AND tp.patient_id = $3 AND tp.deleted_at IS NULL
         GROUP BY tp.id
         ORDER BY tp.created_at DESC`,
        [orgId, clinicId, patientId]
      );
      return res.json({ plans });
    } catch (err) { next(err); }
  }
);

// ── POST /treatment-plans/:planId/items ───────────────────────────────────────
const planItemSchema = Joi.object({
  service_id:           Joi.string().uuid().required(),
  linked_diagnosis_id:  Joi.string().uuid().optional(),
  tooth_numbers:        Joi.array().items(Joi.number().integer()).default([]),
  estimated_sessions:   Joi.number().integer().min(1).default(1),
  cost_min:             Joi.number().min(0).optional(),
  cost_max:             Joi.number().min(0).optional(),
  priority:             Joi.string().valid('urgent','recommended','optional','cosmetic').default('recommended'),
  patient_facing_notes: Joi.string().allow('').optional(),
});

router.post(
  '/treatment-plans/:planId/items',
  ...authChain,
  validate(planItemSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { planId } = req.params;
    const b = req.body;
    try {
      const { rows: planRows } = await db.query(
        `SELECT id FROM treatment_plan WHERE id=$1 AND org_id=$2 AND clinic_id=$3 AND deleted_at IS NULL`,
        [planId, orgId, clinicId]
      );
      if (!planRows.length) return next(createError(404, 'Treatment plan not found'));

      const { rows } = await db.query(
        `INSERT INTO treatment_plan_item
           (org_id, clinic_id, plan_id, service_id, linked_diagnosis_id,
            tooth_numbers, estimated_sessions, cost_min, cost_max,
            priority, patient_facing_notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING *`,
        [
          orgId, clinicId, planId, b.service_id,
          b.linked_diagnosis_id || null,
          b.tooth_numbers, b.estimated_sessions,
          b.cost_min ?? null, b.cost_max ?? null,
          b.priority, b.patient_facing_notes || null,
          userId,
        ]
      );
      const { rows: svcRows } = await db.query(`SELECT name FROM services WHERE id=$1`, [b.service_id]);
      return res.status(201).json({ item: { ...rows[0], service_name: svcRows[0]?.name } });
    } catch (err) { next(err); }
  }
);

// ── PATCH /treatment-plan-items/:itemId ───────────────────────────────────────
const planItemPatchSchema = Joi.object({
  status:               Joi.string().valid('PROPOSED','ACCEPTED','DECLINED','IN_PROGRESS','DONE','PARTIAL','CANCELLED').required(),
  decline_reason:       Joi.string().valid('cost','time','fear','second_opinion','medical').optional(),
  patient_facing_notes: Joi.string().allow('').optional(),
});

router.patch(
  '/treatment-plan-items/:itemId',
  ...authChain,
  validate(planItemPatchSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { itemId } = req.params;
    const { status, decline_reason, patient_facing_notes } = req.body;

    if (status === 'DECLINED' && !decline_reason) {
      return next(createError(400, 'decline_reason is required when declining a plan item'));
    }

    try {
      const { rows } = await db.query(
        `UPDATE treatment_plan_item
         SET status = $1,
             decline_reason = COALESCE($2, decline_reason),
             patient_facing_notes = COALESCE($3, patient_facing_notes),
             updated_by = $4
         WHERE id = $5 AND org_id = $6 AND clinic_id = $7 AND deleted_at IS NULL
         RETURNING *`,
        [status, decline_reason || null, patient_facing_notes ?? null, userId, itemId, orgId, clinicId]
      );
      if (!rows.length) return next(createError(404, 'Plan item not found'));
      return res.json({ item: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── GET /sessions/:id/prescriptions ──────────────────────────────────────────
router.get('/sessions/:id/prescriptions', ...authChain, async (req, res, next) => {
  const { clinicId } = req.context;
  const { id: sessionId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT
         p.id, p.prescription_no, p.diagnosis AS indication,
         p.clinical_notes AS instructions, p.created_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id',           li.id,
               'medicine_id',  li.ref_id,
               'medicine_name', COALESCE(m.brand_name, m.generic_name),
               'generic_name', m.generic_name,
               'dosage_form',  m.dosage_form,
               'dosage',       li.dosage,
               'frequency',    li.frequency,
               'duration',     li.duration,
               'instructions', li.instructions
             ) ORDER BY li.sort_order
           ) FILTER (WHERE li.id IS NOT NULL),
           '[]'
         ) AS items
       FROM prescriptions p
       LEFT JOIN rx_line_items li ON li.prescription_id = p.id AND li.is_deleted = false
       LEFT JOIN rx_medicines  m  ON m.id = li.ref_id AND li.item_type = 'medicine'
       WHERE p.session_id = $1 AND p.clinic_id = $2
       GROUP BY p.id
       ORDER BY p.created_at`,
      [sessionId, clinicId]
    );
    return res.json({ prescriptions: rows });
  } catch (err) { next(err); }
});

// ── POST /sessions/:id/prescriptions ─────────────────────────────────────────
const sessionPrescriptionSchema = Joi.object({
  diagnosis:      Joi.string().max(500).required(),
  clinical_notes: Joi.string().max(5000).allow('', null).optional(),
  items: Joi.array().items(Joi.object({
    medicine_id:  Joi.number().integer().positive().required(),
    dosage:       Joi.string().max(80).allow('').optional(),
    frequency:    Joi.string().max(60).allow('').optional(),
    duration:     Joi.string().max(40).allow('').optional(),
    quantity:     Joi.string().max(40).allow('').optional(),
    instructions: Joi.string().max(2000).allow('').optional(),
  })).min(1).max(20).required(),
});

router.post(
  '/sessions/:id/prescriptions',
  ...authChain,
  validate(sessionPrescriptionSchema),
  async (req, res, next) => {
    const { clinicId, userId } = req.context;
    const { id: sessionId } = req.params;
    const { diagnosis, clinical_notes, items } = req.body;

    try {
      const { rows: sessionRows } = await db.query(
        `SELECT patient_id, appointment_id FROM clinical_session WHERE id = $1 AND clinic_id = $2`,
        [sessionId, clinicId]
      );
      if (!sessionRows.length) return next(createError(404, 'Session not found'));
      const { patient_id, appointment_id } = sessionRows[0];

      const year = new Date().getFullYear();
      const seqResult = await db.query(
        `INSERT INTO rx_sequence (fy_year, last_seq) VALUES ($1, 1)
         ON CONFLICT (fy_year) DO UPDATE SET last_seq = rx_sequence.last_seq + 1
         RETURNING last_seq`,
        [year]
      );
      const prescriptionNo = `DRX-${year}-${String(seqResult.rows[0].last_seq).padStart(4, '0')}`;

      const { rows: rxRows } = await db.query(
        `INSERT INTO prescriptions
           (prescription_no, patient_id, appointment_id, doctor_id, clinic_id,
            session_id, diagnosis, clinical_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [prescriptionNo, patient_id, appointment_id, userId, clinicId,
         sessionId, diagnosis, clinical_notes || null]
      );
      const prescriptionId = rxRows[0].id;

      if (items.length) {
        const valuePlaceholders = items.map((_, i) => {
          const b = i * 9;
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`;
        }).join(',');
        const flat = items.flatMap((item, idx) => [
          prescriptionId, 'medicine', item.medicine_id, idx + 1,
          item.dosage || null, item.frequency || null, item.duration || null,
          item.quantity || null, item.instructions || null,
        ]);
        await db.query(
          `INSERT INTO rx_line_items
             (prescription_id, item_type, ref_id, sort_order, dosage, frequency, duration,
              quantity, instructions)
           VALUES ${valuePlaceholders}`,
          flat
        );
      }

      const { rows: full } = await db.query(
        `SELECT
           p.id, p.prescription_no, p.diagnosis AS indication,
           p.clinical_notes AS instructions, p.created_at,
           COALESCE(
             json_agg(
               json_build_object(
                 'id',           li.id,
                 'medicine_id',  li.ref_id,
                 'medicine_name', COALESCE(m.brand_name, m.generic_name),
                 'generic_name', m.generic_name,
                 'dosage_form',  m.dosage_form,
                 'dosage',       li.dosage,
                 'frequency',    li.frequency,
                 'duration',     li.duration,
                 'instructions', li.instructions
               ) ORDER BY li.sort_order
             ) FILTER (WHERE li.id IS NOT NULL),
             '[]'
           ) AS items
         FROM prescriptions p
         LEFT JOIN rx_line_items li ON li.prescription_id = p.id AND li.is_deleted = false
         LEFT JOIN rx_medicines  m  ON m.id = li.ref_id AND li.item_type = 'medicine'
         WHERE p.id = $1
         GROUP BY p.id`,
        [prescriptionId]
      );

      return res.status(201).json({ prescription: full[0] });
    } catch (err) { next(err); }
  }
);

// ── Shared upload constants (used by both investigations and attachments) ─────

const ATT_SIGN_TTL     = 300;   // 5 min PUT window
const ATT_DOWNLOAD_TTL = 900;   // 15 min GET URL

const attachSignSchema = Joi.object({
  filename:     Joi.string().max(255).required(),
  content_type: Joi.string().max(128).required(),
});

// ── Investigations ────────────────────────────────────────────────────────────

const INVESTIGATION_KINDS = [
  'iopa','opg','cbct','ceph','bitewing','occlusal','intraoral_photo','intraoral_scan',
  'lab_cbc','lab_rbs','lab_fbs','lab_hba1c','lab_bt_ct','lab_inr',
  'biopsy_incisional','biopsy_excisional','cytology',
];

const investigationOrderSchema = Joi.object({
  kind:                Joi.string().valid(...INVESTIGATION_KINDS).required(),
  clinical_indication: Joi.string().max(500).required(),
  tooth_numbers:       Joi.array().items(Joi.number().integer().min(11).max(85)).optional(),
  cbct_fov:            Joi.string().valid('small','medium','large').optional(),
  vendor:              Joi.string().max(200).allow('', null).optional(),
});

const investigationReceiveSchema = Joi.object({
  interpretation:   Joi.string().min(1).max(2000).required(),
  s3_key:           Joi.string().max(500).allow(null).optional(),
  vendor_report_id: Joi.string().max(200).allow('', null).optional(),
  received_at:      Joi.string().isoDate().optional(),
});

const INV_URL_TTL = 900;

async function investigationsWithUrls(rows) {
  return Promise.all(rows.map(async (inv) => ({
    ...inv,
    url: inv.s3_key
      ? await getPresignedUrl({ key: inv.s3_key, expiresIn: INV_URL_TTL }).catch(() => null)
      : null,
  })));
}

// GET /sessions/:id/investigations
router.get(
  '/sessions/:id/investigations',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    try {
      const { id: sessionId } = req.params;
      const clinicId = req.context.clinicId;

      const session = await db.query(
        `SELECT id FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));

      const { rows } = await db.query(
        `SELECT * FROM investigation_order
          WHERE session_id=$1 AND clinic_id=$2
          ORDER BY created_at ASC`,
        [sessionId, clinicId]
      );

      return res.json({ investigations: await investigationsWithUrls(rows) });
    } catch (err) { next(err); }
  }
);

// POST /sessions/:id/investigations — place an order
router.post(
  '/sessions/:id/investigations',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(investigationOrderSchema),
  async (req, res, next) => {
    try {
      const { id: sessionId } = req.params;
      const clinicId = req.context.clinicId;
      const userId   = req.context.userId;

      const session = await db.query(
        `SELECT id, status FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));
      if (session.rows[0].status === 'SEALED') return next(createError(409, 'Session is sealed'));

      const { kind, clinical_indication, tooth_numbers, cbct_fov, vendor } = req.body;

      const { rows } = await db.query(
        `INSERT INTO investigation_order
           (session_id, clinic_id, ordered_by, kind, clinical_indication,
            tooth_numbers, cbct_fov, vendor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          sessionId, clinicId, userId, kind, clinical_indication,
          tooth_numbers?.length ? tooth_numbers : null,
          cbct_fov || null,
          vendor || null,
        ]
      );

      return res.status(201).json({ investigation: { ...rows[0], url: null } });
    } catch (err) { next(err); }
  }
);

// PATCH /investigations/:id/receive — attach result + interpretation → marks READ
router.patch(
  '/investigations/:id/receive',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(investigationReceiveSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const clinicId = req.context.clinicId;

      const existing = await db.query(
        `SELECT io.* FROM investigation_order io
           JOIN clinical_session cs ON cs.id = io.session_id
          WHERE io.id=$1 AND io.clinic_id=$2`,
        [id, clinicId]
      );
      if (!existing.rows[0]) return next(createError(404, 'Investigation not found'));
      if (existing.rows[0].status === 'CANCELLED') {
        return next(createError(409, 'Cannot receive a cancelled investigation'));
      }

      const { interpretation, s3_key, vendor_report_id, received_at } = req.body;

      const { rows } = await db.query(
        `UPDATE investigation_order
            SET status           = 'READ',
                interpretation   = $1,
                s3_key           = COALESCE($2, s3_key),
                vendor_report_id = COALESCE($3, vendor_report_id),
                received_at      = COALESCE($4::TIMESTAMPTZ, now()),
                updated_at       = now()
          WHERE id=$5 AND clinic_id=$6
          RETURNING *`,
        [interpretation, s3_key || null, vendor_report_id || null, received_at || null, id, clinicId]
      );

      const inv = rows[0];
      const url = inv.s3_key
        ? await getPresignedUrl({ key: inv.s3_key, expiresIn: INV_URL_TTL }).catch(() => null)
        : null;

      return res.json({ investigation: { ...inv, url } });
    } catch (err) { next(err); }
  }
);

// DELETE /investigations/:id — cancel order
router.delete(
  '/investigations/:id',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const clinicId = req.context.clinicId;

      const existing = await db.query(
        `SELECT io.status FROM investigation_order io
          WHERE io.id=$1 AND io.clinic_id=$2`,
        [id, clinicId]
      );
      if (!existing.rows[0]) return next(createError(404, 'Investigation not found'));
      if (existing.rows[0].status === 'READ') {
        return next(createError(409, 'Cannot cancel an already-read investigation'));
      }

      await db.query(
        `UPDATE investigation_order SET status='CANCELLED', updated_at=now()
          WHERE id=$1 AND clinic_id=$2`,
        [id, clinicId]
      );

      return res.json({ cancelled: true });
    } catch (err) { next(err); }
  }
);

// POST /investigations/:id/sign — presigned PUT for report upload
router.post(
  '/investigations/:id/sign',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(attachSignSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const clinicId = req.context.clinicId;

      const existing = await db.query(
        `SELECT io.session_id, io.status FROM investigation_order io
          WHERE io.id=$1 AND io.clinic_id=$2`,
        [id, clinicId]
      );
      if (!existing.rows[0]) return next(createError(404, 'Investigation not found'));
      if (existing.rows[0].status === 'CANCELLED') {
        return next(createError(409, 'Investigation is cancelled'));
      }

      const { filename, content_type } = req.body;
      const ext    = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'bin';
      const s3Key  = `sessions/${existing.rows[0].session_id}/investigations/${id}/${uuidv4()}.${ext}`;

      const uploadUrl = await getPresignedPutUrl({
        key:         s3Key,
        contentType: content_type,
        expiresIn:   ATT_SIGN_TTL,
      });

      return res.json({ upload_url: uploadUrl, s3_key: s3Key });
    } catch (err) { next(err); }
  }
);

// ── Lab Orders (T3.3) ────────────────────────────────────────────────────────

const LAB_ORDER_STATUSES = ['created','picked_up','in_progress','delivered','trial_returned','completed','cancelled'];

const labOrderCreateSchema = Joi.object({
  shade:                  Joi.string().max(80).allow('', null).optional(),
  expected_delivery_date: Joi.string().isoDate().allow(null).optional(),
  pickup_date:            Joi.string().isoDate().allow(null).optional(),
  lab_cost:               Joi.number().min(0).allow(null).optional(),
  notes:                  Joi.string().max(1000).allow('', null).optional(),
  specifications:         Joi.object().optional(),
});

const labOrderUpdateSchema = Joi.object({
  status:                 Joi.string().valid(...LAB_ORDER_STATUSES).optional(),
  shade:                  Joi.string().max(80).allow('', null).optional(),
  expected_delivery_date: Joi.string().isoDate().allow(null).optional(),
  pickup_date:            Joi.string().isoDate().allow(null).optional(),
  lab_cost:               Joi.number().min(0).allow(null).optional(),
  trial_sessions_count:   Joi.number().integer().min(0).optional(),
  notes:                  Joi.string().max(1000).allow('', null).optional(),
  specifications:         Joi.object().optional(),
});

// GET /sessions/:id/lab-orders
router.get(
  '/sessions/:id/lab-orders',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    try {
      const { id: sessionId } = req.params;
      const { clinicId } = req.context;

      const session = await db.query(
        `SELECT id FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));

      const { rows } = await db.query(
        `SELECT lo.*, sp.service_name
           FROM lab_order lo
           LEFT JOIN service_performed sp ON sp.id = lo.service_id
          WHERE lo.session_id=$1 AND lo.clinic_id=$2
          ORDER BY lo.created_at ASC`,
        [sessionId, clinicId]
      );
      return res.json({ lab_orders: rows });
    } catch (err) { next(err); }
  }
);

// POST /services/:id/lab-orders
router.post(
  '/services/:id/lab-orders',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(labOrderCreateSchema),
  async (req, res, next) => {
    try {
      const { id: serviceId } = req.params;
      const { clinicId, userId } = req.context;

      const svcRow = await db.query(
        `SELECT session_id FROM service_performed WHERE id=$1 AND clinic_id=$2`,
        [serviceId, clinicId]
      );
      if (!svcRow.rows[0]) return next(createError(404, 'Service not found'));
      const sessionId = svcRow.rows[0].session_id;

      const existing = await db.query(
        `SELECT id FROM lab_order WHERE service_id=$1`,
        [serviceId]
      );
      if (existing.rows[0]) return next(createError(409, 'Lab order already exists for this service'));

      const { shade, expected_delivery_date, pickup_date, lab_cost, notes, specifications } = req.body;

      const { rows } = await db.query(
        `INSERT INTO lab_order
           (session_id, service_id, clinic_id, created_by,
            shade, expected_delivery_date, pickup_date, lab_cost, notes, specifications)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [sessionId, serviceId, clinicId, userId,
         shade || null, expected_delivery_date || null, pickup_date || null,
         lab_cost ?? null, notes || null, specifications ? JSON.stringify(specifications) : '{}']
      );
      return res.status(201).json({ lab_order: rows[0] });
    } catch (err) { next(err); }
  }
);

// PATCH /lab-orders/:id
router.patch(
  '/lab-orders/:id',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(labOrderUpdateSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { clinicId } = req.context;

      const existing = await db.query(
        `SELECT id FROM lab_order WHERE id=$1 AND clinic_id=$2`,
        [id, clinicId]
      );
      if (!existing.rows[0]) return next(createError(404, 'Lab order not found'));

      const fields = [];
      const values = [];
      let i = 1;

      const allowed = ['status','shade','expected_delivery_date','pickup_date','lab_cost','trial_sessions_count','notes'];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          fields.push(`${key}=$${i++}`);
          values.push(req.body[key]);
        }
      }
      if (req.body.specifications !== undefined) {
        fields.push(`specifications=$${i++}`);
        values.push(JSON.stringify(req.body.specifications));
      }
      if (!fields.length) return next(createError(400, 'No fields to update'));

      fields.push(`updated_at=now()`);
      values.push(id);

      const { rows } = await db.query(
        `UPDATE lab_order SET ${fields.join(',')} WHERE id=$${i} RETURNING *`,
        values
      );
      return res.json({ lab_order: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── Attachments ───────────────────────────────────────────────────────────────

const attachConfirmSchema = Joi.object({
  s3_key:       Joi.string().max(500).required(),
  filename:     Joi.string().max(255).required(),
  content_type: Joi.string().max(128).required(),
  file_size:    Joi.number().integer().min(1).max(52428800).optional(), // 50 MB max
});

async function attachmentsWithUrls(sessionId, clinicId) {
  const { rows } = await db.query(
    `SELECT id, s3_key, filename, content_type, file_size, created_at,
            uploaded_by
       FROM session_attachments
      WHERE session_id = $1 AND clinic_id = $2
      ORDER BY created_at ASC`,
    [sessionId, clinicId]
  );
  return Promise.all(
    rows.map(async (a) => ({
      ...a,
      url: await getPresignedUrl({ key: a.s3_key, expiresIn: ATT_DOWNLOAD_TTL }),
    }))
  );
}

// Request a presigned PUT URL
router.post(
  '/sessions/:id/attachments/sign',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(attachSignSchema),
  async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      const clinicId  = req.context.clinicId;

      const session = await db.query(
        `SELECT id, status FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));
      if (session.rows[0].status === 'SEALED') return next(createError(409, 'Session is sealed'));

      const { filename, content_type } = req.body;
      const ext    = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'bin';
      const s3Key  = `sessions/${sessionId}/attachments/${uuidv4()}.${ext}`;

      const uploadUrl = await getPresignedPutUrl({
        key:         s3Key,
        contentType: content_type,
        expiresIn:   ATT_SIGN_TTL,
      });

      return res.json({ upload_url: uploadUrl, s3_key: s3Key });
    } catch (err) { next(err); }
  }
);

// Register attachment after client-side S3 upload
router.post(
  '/sessions/:id/attachments',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(attachConfirmSchema),
  async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      const clinicId  = req.context.clinicId;
      const userId    = req.context.userId;

      const session = await db.query(
        `SELECT id, status FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));
      if (session.rows[0].status === 'SEALED') return next(createError(409, 'Session is sealed'));

      const { s3_key, filename, content_type, file_size } = req.body;

      const { rows } = await db.query(
        `INSERT INTO session_attachments
           (session_id, clinic_id, uploaded_by, s3_key, filename, content_type, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [sessionId, clinicId, userId, s3_key, filename, content_type, file_size ?? null]
      );

      const attachment = {
        ...rows[0],
        url: await getPresignedUrl({ key: s3_key, expiresIn: ATT_DOWNLOAD_TTL }),
      };

      return res.status(201).json({ attachment });
    } catch (err) { next(err); }
  }
);

// List attachments for a session
router.get(
  '/sessions/:id/attachments',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      const clinicId  = req.context.clinicId;

      const session = await db.query(
        `SELECT id FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));

      const attachments = await attachmentsWithUrls(sessionId, clinicId);
      return res.json({ attachments });
    } catch (err) { next(err); }
  }
);

// Delete an attachment
router.delete(
  '/sessions/:id/attachments/:attachmentId',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  async (req, res, next) => {
    try {
      const { id: sessionId, attachmentId } = req.params;
      const clinicId = req.context.clinicId;

      const { rows } = await db.query(
        `DELETE FROM session_attachments
          WHERE id=$1 AND session_id=$2 AND clinic_id=$3
          RETURNING s3_key`,
        [attachmentId, sessionId, clinicId]
      );
      if (!rows[0]) return next(createError(404, 'Attachment not found'));

      try {
        await deleteObject({ key: rows[0].s3_key });
      } catch (_) { /* S3 delete is best-effort; DB record is already removed */ }

      return res.json({ deleted: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
