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
const {
  getPresignedPutUrl, getPresignedUrl, deleteObject,
  buildSessionSummaryPdfKey, uploadBuffer, objectExists, getS3Client,
} = require('../services/s3Service');
const sessionSummaryPdfBuilder = require('../services/sessionSummaryPdfBuilder');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { loadResource, mapLoadedResource } = require('../security/middleware/load-resource.middleware');
const { authorize }    = require('../security/middleware/authorize.middleware');
const { fieldFilter }  = require('../security/middleware/field-filter.middleware');

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

// ── Treatment summary + invoice PDF ──────────────────────────────────────────
// In-process clinic-logo cache (keyed by clinic_id, 5-min TTL) so we don't refetch
// the same logo from S3 on every seal.
const _logoCache = new Map();
const LOGO_TTL_MS = 5 * 60 * 1000;

async function _fetchLogoBuffer(s3Key, clinicId) {
  const cached = _logoCache.get(clinicId);
  if (cached && cached.expiresAt > Date.now()) return cached.buffer;
  try {
    const resp = await getS3Client().send(new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key:    s3Key,
    }));
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    _logoCache.set(clinicId, { buffer, expiresAt: Date.now() + LOGO_TTL_MS });
    return buffer;
  } catch {
    return null; // logo failure must never block PDF generation
  }
}

/**
 * Build the treatment-summary + invoice PDF for a sealed session, upload it to
 * S3, and persist the key + invoice number on clinical_session. Returns the
 * stored row fields, or null on failure (caller decides whether that's fatal).
 */
async function generateSessionSummaryPdf({ sessionId, clinicId }) {
  const { rows: hdrRows } = await db.query(
    `SELECT cs.id, cs.patient_id, cs.clinic_id, cs.sealed_at, cs.variance_reason,
            pat.name  AS patient_name, pat.phone AS patient_phone,
            pat.age   AS patient_age,  pat.gender AS patient_gender,
            u.first_name AS doctor_first_name, u.last_name AS doctor_last_name,
            u.designation AS doctor_designation,
            c.name AS clinic_name, c.phone AS clinic_phone, c.email AS clinic_email,
            c.address AS clinic_address, c.city AS clinic_city, c.logo_s3_key AS clinic_logo_s3_key
       FROM clinical_session cs
       JOIN patients pat ON pat.id = cs.patient_id
       JOIN users    u   ON u.id   = cs.primary_doctor_id
       JOIN clinics  c   ON c.id   = cs.clinic_id
      WHERE cs.id = $1 AND cs.clinic_id = $2`,
    [sessionId, clinicId]
  );
  if (!hdrRows.length) return null;
  const hdr = hdrRows[0];

  const [{ rows: services }, { rows: diagnoses }, { rows: prescriptions }] = await Promise.all([
    db.query(
      `SELECT sp.tooth_numbers, sp.status, sp.final_charge, s.name AS service_name
         FROM service_performed sp
         JOIN services s ON s.id = sp.service_id
        WHERE sp.session_id = $1 AND sp.deleted_at IS NULL
        ORDER BY sp.started_at ASC`,
      [sessionId]
    ),
    db.query(
      `SELECT diagnosis_text, icd10_code, tooth_numbers, kind
         FROM diagnosis
        WHERE session_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [sessionId]
    ),
    db.query(
      `SELECT li.dosage, li.frequency, li.duration, li.quantity, li.instructions,
              m.generic_name AS medicine_name, m.strength AS medicine_strength
         FROM prescriptions p
         JOIN rx_line_items li ON li.prescription_id = p.id AND li.is_deleted = false
         LEFT JOIN rx_medicines m ON m.id = li.ref_id AND li.item_type = 'medicine'
        WHERE p.session_id = $1 AND li.item_type = 'medicine'
        ORDER BY p.created_at ASC, li.sort_order ASC`,
      [sessionId]
    ),
  ]);

  const total = services
    .filter(sv => sv.status === 'COMPLETED' || sv.status === 'PARTIAL')
    .reduce((sum, sv) => sum + parseFloat(sv.final_charge || 0), 0);

  const invoiceNo = `INV-${String(sessionId).slice(0, 8).toUpperCase()}`;

  const logoBuffer = hdr.clinic_logo_s3_key
    ? await _fetchLogoBuffer(hdr.clinic_logo_s3_key, hdr.clinic_id)
    : null;

  const pdfBuffer = await sessionSummaryPdfBuilder.build(
    { ...hdr, invoice_no: invoiceNo, services, diagnoses, prescriptions, total },
    { logoBuffer }
  );

  const s3Key = buildSessionSummaryPdfKey({ patientId: hdr.patient_id, sessionId });
  await uploadBuffer({ key: s3Key, buffer: pdfBuffer, contentType: 'application/pdf', encrypt: true });

  const { rows } = await db.query(
    `UPDATE clinical_session
        SET invoice_no = $3, summary_pdf_s3_key = $4, summary_pdf_generated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING invoice_no, summary_pdf_s3_key, summary_pdf_generated_at`,
    [sessionId, clinicId, invoiceNo, s3Key]
  );
  return rows[0] || null;
}

// ── POST /appointments/:id/start-treatment  (Endpoint 1) ─────────────────────
router.post(
  '/appointments/:id/start-treatment',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  authorize('create', 'session'),
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

      const { session, activeCases } = await withTx(async (client) => {
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

        // Link active specialty cases — create a specialty_visit for each active case
        const { rows: openCases } = await client.query(
          `SELECT id, case_type FROM specialty_case
            WHERE org_id = $1 AND clinic_id = $2 AND patient_id = $3
              AND status = 'ACTIVE' AND deleted_at IS NULL`,
          [orgId, clinicId, appt.patient_id]
        );

        for (const sc of openCases) {
          const { rows: cntRows } = await client.query(
            `SELECT COALESCE(MAX(visit_number), 0) + 1 AS next
               FROM specialty_visit
              WHERE case_id = $1 AND deleted_at IS NULL`,
            [sc.id]
          );
          const visitNumber = cntRows[0].next;

          await client.query(
            `INSERT INTO specialty_visit
               (org_id, clinic_id, case_id, session_id, visit_number, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$6)
             ON CONFLICT (session_id) DO NOTHING`,
            [orgId, clinicId, sc.id, sess.id, visitNumber, userId]
          );
        }

        return { session: sess, activeCases: openCases };
      });

      req.audit.write({
        entity_type: 'clinical_session',
        entity_id:   session.id,
        action:      'START_TREATMENT',
        details:     {
          appointment_id:  appointmentId,
          doctor_id:       doctorId,
          specialty_cases: activeCases.map(c => c.id),
        },
      });

      return res.status(201).json({ session, active_specialty_cases: activeCases });
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
  loadResource('session', 'id'),
  authorize('read', 'session'),
  fieldFilter('session', { entity: 'session' }),
  fieldFilter('clinical_note', { entity: 'note' }),
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
  loadResource('session', 'id'),
  authorize('update', 'session'),
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
  loadResource('session', 'id'),
  authorize('update', 'session'),
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
        `SELECT id, name, price, requires_consent, requires_preop, postop_required
           FROM services
          WHERE id = $1 AND clinic_id = $2 AND is_active = true`,
        [req.body.service_id, clinicId]
      );
      if (!svcRows.length) return next(createError(404, 'Service not found'));
      const svc = { ...svcRows[0], gst_applicable: false };

      // ── T5.3 Surgical gating ──────────────────────────────────────────────
      if (svc.requires_consent) {
        const { rows: consentRows } = await db.query(
          `SELECT id FROM consent_record
            WHERE session_id=$1 AND (service_id=$2 OR service_id IS NULL)
            LIMIT 1`,
          [sessionId, req.body.service_id]
        ).catch(() => ({ rows: [] }));
        if (!consentRows.length) {
          return next(createError(422, 'Informed consent is required before adding this service.'));
        }
      }
      if (svc.requires_preop) {
        const { rows: preopRows } = await db.query(
          `SELECT id FROM preop_record
            WHERE session_id=$1 AND is_complete=true
            LIMIT 1`,
          [sessionId]
        ).catch(() => ({ rows: [] }));
        if (!preopRows.length) {
          return next(createError(422, 'Pre-operative checklist must be completed before adding this service.'));
        }
      }

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
  loadResource('service_performed', 'id'),
  authorize('update', 'service_performed'),
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

      // ── Commit or return cart items (T4.2 / T4.3) — non-blocking ──────────
      try {
        const { rows: cartItems } = await db.query(
          `SELECT mc.*, ii.is_implant, ii.name AS item_name,
                  cs.patient_id
             FROM material_consumption mc
             JOIN inventory_item ii ON ii.id = mc.inventory_item_id
             JOIN clinical_session cs ON cs.id = mc.session_id
            WHERE mc.service_id=$1 AND mc.state='RESERVED'`,
          [req.params.id]
        );

        if (cartItems.length) {
          let client2 = await db.pool.connect();
          try {
            await client2.query('BEGIN');

            if (req.body.status === 'COMPLETED' || req.body.status === 'PARTIAL') {
              for (const item of cartItems) {
                await client2.query(
                  `UPDATE material_consumption SET state='COMMITTED', updated_at=now() WHERE id=$1`,
                  [item.id]
                );
                await client2.query(
                  `INSERT INTO stock_movement
                     (movement_type, inventory_item_id, batch_id, clinic_id,
                      direction, quantity, source_ref, source_type, actor_id)
                   VALUES ('CONSUMPTION',$1,$2,$3,-1,$4,$5,'service_completion',$6)`,
                  [item.inventory_item_id, item.batch_id, clinicId,
                   item.quantity, item.service_id, userId]
                );
                if (item.is_implant) {
                  await client2.query(
                    `INSERT INTO patient_device_register
                       (patient_id, session_id, service_id, consumption_id, clinic_id,
                        inventory_item_id, item_name, lot_number, expiry_date, implanted_by, tooth_numbers)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                    [item.patient_id, sp.session_id, req.params.id, item.id, clinicId,
                     item.inventory_item_id, item.item_name, item.lot_number || null,
                     item.expiry_date || null, userId, sp.tooth_numbers || null]
                  );
                }
              }
            } else if (req.body.status === 'ABANDONED') {
              await client2.query(
                `UPDATE material_consumption SET state='RETURNED', updated_at=now()
                  WHERE service_id=$1 AND state='RESERVED'`,
                [req.params.id]
              );
            }

            await client2.query('COMMIT');
            // Refresh the stock view AFTER commit — REFRESH ... CONCURRENTLY
            // cannot run inside a transaction (it would abort it and poison the
            // pooled connection for the next request).
            await client2.query('REFRESH MATERIALIZED VIEW CONCURRENTLY current_stock')
              .catch(() => client2.query('REFRESH MATERIALIZED VIEW current_stock'))
              .catch(() => { /* non-fatal */ });
          } catch (cartErr) {
            try { await client2.query('ROLLBACK'); } catch { /* connection may be unusable */ }
            client2.release(cartErr);   // destroy on error so a tainted connection isn't reused
            client2 = null;
            throw cartErr;
          } finally {
            if (client2) client2.release();
          }
        }
      } catch (cartErr) {
        console.error('[cart-commit] skipped:', cartErr.message);
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
  loadResource('session', 'id'),
  authorize('read', 'session', { mode: 'observe' }),
  fieldFilter('service_performed', { collection: 'services' }),
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
  variance_reason:  Joi.string().allow('').optional(),
  patient_ack_at:   Joi.string().isoDate().allow(null).optional(),
});

router.post(
  '/sessions/:id/end-treatment',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('seal', 'session'),
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

      // ── T6.4 Variance check ───────────────────────────────────────────────
      const VARIANCE_THRESHOLD = 0.15; // 15%
      const { rows: chargeRows } = await db.query(
        `SELECT COALESCE(SUM(final_charge),0) AS final_total
           FROM service_performed
          WHERE session_id=$1 AND status IN ('COMPLETED','PARTIAL') AND deleted_at IS NULL`,
        [sessionId]
      );
      const { rows: estimateRows } = await db.query(
        `SELECT COALESCE(SUM(tpi.cost_min),0) AS accepted_estimate
           FROM treatment_plan_item tpi
           JOIN treatment_plan tp ON tp.id = tpi.plan_id
          WHERE tp.patient_id = $1
            AND tpi.status IN ('ACCEPTED','IN_PROGRESS','DONE','PARTIAL')
            AND tpi.deleted_at IS NULL`,
        [session.patient_id]
      );
      const finalTotal       = parseFloat(chargeRows[0].final_total);
      const acceptedEstimate = parseFloat(estimateRows[0].accepted_estimate);
      const varianceFlag     = acceptedEstimate > 0 && finalTotal > acceptedEstimate * (1 + VARIANCE_THRESHOLD);
      if (varianceFlag && !req.body.variance_reason) {
        return next(createError(422, `Variance alert: charges (₹${finalTotal.toFixed(2)}) exceed accepted estimate (₹${acceptedEstimate.toFixed(2)}) by more than ${VARIANCE_THRESHOLD * 100}%. Provide a variance_reason.`));
      }

      const sealed = await withTx(async (client) => {
        const { rows: sessRows } = await client.query(
          `UPDATE clinical_session
           SET status          = 'COMPLETED',
               sealed_at       = NOW(),
               sealed_by       = $1,
               ended_at        = NOW(),
               updated_at      = NOW(),
               updated_by      = $1,
               variance_reason = $4,
               patient_ack_at  = $6
           WHERE id = $2 AND org_id = $3 AND clinic_id = $5 AND deleted_at IS NULL
           RETURNING *`,
          [userId, sessionId, orgId, req.body.variance_reason || null, clinicId,
           req.body.patient_ack_at || null]
        );

        // T4.3 — commit any remaining RESERVED cart items for completed/partial services
        const { rows: reservedItems } = await client.query(
          `SELECT mc.*, ii.is_implant, ii.name AS item_name, cs.patient_id,
                  sp.tooth_numbers
             FROM material_consumption mc
             JOIN inventory_item ii ON ii.id = mc.inventory_item_id
             JOIN clinical_session cs ON cs.id = mc.session_id
             JOIN service_performed sp ON sp.id = mc.service_id
            WHERE mc.session_id = $1 AND mc.state = 'RESERVED'`,
          [sessionId]
        );

        for (const item of reservedItems) {
          await client.query(
            `UPDATE material_consumption SET state='COMMITTED', updated_at=now() WHERE id=$1`,
            [item.id]
          );
          await client.query(
            `INSERT INTO stock_movement
               (movement_type, inventory_item_id, batch_id, clinic_id,
                direction, quantity, source_ref, source_type, actor_id)
             VALUES ('CONSUMPTION',$1,$2,$3,-1,$4,$5,'session_seal',$6)`,
            [item.inventory_item_id, item.batch_id, clinicId,
             item.quantity, item.service_id, userId]
          );
          if (item.is_implant) {
            await client.query(
              `INSERT INTO patient_device_register
                 (patient_id, session_id, service_id, consumption_id, clinic_id,
                  inventory_item_id, item_name, lot_number, expiry_date, implanted_by, tooth_numbers)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT DO NOTHING`,
              [item.patient_id, sessionId, item.service_id, item.id, clinicId,
               item.inventory_item_id, item.item_name, item.lot_number || null,
               item.expiry_date || null, userId, item.tooth_numbers || null]
            );
          }
        }

        // Transition appointment to done (billing handled separately by reception)
        await client.query(
          `UPDATE appointments SET status = 'done', updated_at = NOW()
           WHERE id = $1`,
          [session.appointment_id]
        );

        return { session: sessRows[0], refreshStock: reservedItems.length > 0 };
      });

      // Refresh stock view AFTER commit — REFRESH MATERIALIZED VIEW CONCURRENTLY
      // cannot run inside a transaction block.
      if (sealed.refreshStock) {
        await db.pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY current_stock`).catch(() =>
          db.pool.query(`REFRESH MATERIALIZED VIEW current_stock`)
        );
      }

      // Generate the treatment summary + invoice PDF (stored in S3, viewable later).
      // The session is already sealed/committed — a PDF failure must not fail the seal.
      let summary = null;
      try {
        summary = await generateSessionSummaryPdf({ sessionId, clinicId });
      } catch (pdfErr) {
        console.error(`[seal] summary PDF generation failed for session ${sessionId}:`, pdfErr.message);
      }

      req.audit.write({
        entity_type: 'clinical_session',
        entity_id:   sessionId,
        action:      'SEAL_SESSION',
        details:     { sealed_by: userId, invoice_no: summary?.invoice_no || null },
      });

      return res.json({
        session: { ...sealed.session, ...(summary || {}) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /sessions/:id/summary-pdf — presigned URL for the treatment summary ──
router.get(
  '/sessions/:id/summary-pdf',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  loadResource('session', 'id'),
  authorize('read', 'session', { mode: 'observe' }),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));

      const { rows } = await db.query(
        `SELECT summary_pdf_s3_key, invoice_no FROM clinical_session
          WHERE id = $1 AND clinic_id = $2`,
        [sessionId, clinicId]
      );
      let s3Key = rows[0]?.summary_pdf_s3_key;

      // Lazily (re)generate if missing — e.g. session sealed before this feature,
      // or a prior generation failed. Only possible once a session is sealed.
      if (!s3Key && session.sealed_at) {
        const summary = await generateSessionSummaryPdf({ sessionId, clinicId });
        s3Key = summary?.summary_pdf_s3_key;
      }

      if (!s3Key) return next(createError(404, 'Summary PDF not available — seal the session first'));
      if (!(await objectExists({ key: s3Key })))
        return next(createError(404, 'Summary PDF missing in storage'));

      const url = await getPresignedUrl({
        key:       s3Key,
        expiresIn: Number(process.env.AWS_S3_SIGNED_URL_TTL_SECONDS || 900),
      });
      return res.json({ url, invoice_no: rows[0]?.invoice_no || null });
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
  loadResource('session', 'id'),
  authorize('update', 'session'),
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
  loadResource('session', 'id'),
  mapLoadedResource('examination'),
  authorize('read', 'examination'),
  fieldFilter('examination', { entity: 'examination' }),
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
  loadResource('session', 'id'),
  authorize('update', 'session'),
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
  loadResource('session', 'id'),
  authorize('update', 'session'),
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
  loadResource('session', 'id'),
  mapLoadedResource('diagnosis'),
  authorize('read', 'diagnosis'),
  fieldFilter('diagnosis', { collection: 'diagnoses' }),
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
  loadResource('session', 'id'),
  mapLoadedResource('examination'),
  authorize('read', 'examination'),
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
  loadResource('session', 'id'),
  authorize('update', 'session'),
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
  requirePermission(P.PATIENT_UPDATE),
  loadResource('patient', 'patientId'),
  mapLoadedResource('treatment_plan'),
  authorize('create', 'treatment_plan'),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const { patientId } = req.params;
    const { title = 'Treatment Plan', id } = req.body;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (id != null && !UUID_RE.test(id)) return next(createError(400, 'Invalid plan id'));
    try {
      // COALESCE lets the client mint the id (offline-first: the id exists in the
      // UI before the request reaches the server). ON CONFLICT DO NOTHING makes a
      // replayed offline create idempotent — we then return the existing,
      // tenant-scoped row instead of erroring on the primary key.
      const { rows } = await db.query(
        `INSERT INTO treatment_plan (id, org_id, clinic_id, patient_id, title, created_by, updated_by)
         VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6,$6)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [id || null, orgId, clinicId, patientId, title, userId]
      );
      let plan = rows[0];
      if (!plan && id) {
        const { rows: existing } = await db.query(
          `SELECT * FROM treatment_plan WHERE id=$1 AND org_id=$2 AND clinic_id=$3 AND deleted_at IS NULL`,
          [id, orgId, clinicId]
        );
        plan = existing[0];
        if (!plan) return next(createError(409, 'Plan id already in use'));
      }
      return res.status(201).json({ plan });
    } catch (err) { next(err); }
  }
);

// ── GET /patients/:patientId/treatment-plans ──────────────────────────────────
router.get(
  '/patients/:patientId/treatment-plans',
  ...authChain,
  requirePermission(P.PATIENT_VIEW),
  loadResource('patient', 'patientId'),
  mapLoadedResource('treatment_plan'),
  authorize('read', 'treatment_plan', { mode: 'observe' }),
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
  id:                   Joi.string().uuid().optional(),
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
  requirePermission(P.PATIENT_UPDATE),
  loadResource('treatment_plan', 'planId'),
  mapLoadedResource('treatment_plan_item'),
  authorize('create', 'treatment_plan_item'),
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

      // Client-minted id (offline-first) via COALESCE; ON CONFLICT DO NOTHING
      // makes a replayed offline create idempotent.
      const { rows } = await db.query(
        `INSERT INTO treatment_plan_item
           (id, org_id, clinic_id, plan_id, service_id, linked_diagnosis_id,
            tooth_numbers, estimated_sessions, cost_min, cost_max,
            priority, patient_facing_notes, created_by, updated_by)
         VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          b.id || null,
          orgId, clinicId, planId, b.service_id,
          b.linked_diagnosis_id || null,
          b.tooth_numbers, b.estimated_sessions,
          b.cost_min ?? null, b.cost_max ?? null,
          b.priority, b.patient_facing_notes || null,
          userId,
        ]
      );
      let item = rows[0];
      if (!item && b.id) {
        const { rows: existing } = await db.query(
          `SELECT * FROM treatment_plan_item WHERE id=$1 AND org_id=$2 AND clinic_id=$3 AND deleted_at IS NULL`,
          [b.id, orgId, clinicId]
        );
        item = existing[0];
        if (!item) return next(createError(409, 'Item id already in use'));
      }
      const { rows: svcRows } = await db.query(`SELECT name FROM services WHERE id=$1`, [b.service_id]);
      return res.status(201).json({ item: { ...item, service_name: svcRows[0]?.name } });
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
  requirePermission(P.PATIENT_UPDATE),
  loadResource('treatment_plan_item', 'itemId'),
  authorize('update', 'treatment_plan_item'),
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
router.get(
  '/sessions/:id/prescriptions',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  loadResource('session', 'id'),
  mapLoadedResource('prescription'),
  authorize('read', 'prescription'),
  fieldFilter('prescription', { collection: 'prescriptions' }),
  async (req, res, next) => {
  const { clinicId } = req.context;
  const { id: sessionId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT
         p.id, p.prescription_no, p.diagnosis AS indication,
         p.clinical_notes AS instructions, p.created_at,
         p.pdf_generated,
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
               'quantity',     li.quantity,
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
  }
);

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
  requirePermission(P.PRESCRIPTION_CREATE),
  loadResource('session', 'id'),
  mapLoadedResource('prescription'),
  authorize('create', 'prescription'),
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
           p.pdf_generated,
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
                 'quantity',     li.quantity,
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
  loadResource('session', 'id'),
  mapLoadedResource('investigation'),
  authorize('read', 'investigation'),
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
  loadResource('session', 'id'),
  mapLoadedResource('investigation'),
  authorize('create', 'investigation'),
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
  loadResource('investigation', 'id'),
  authorize('update', 'investigation'),
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
  loadResource('investigation', 'id'),
  authorize('delete', 'investigation'),
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

// ── Materials Cart (T4.2) ─────────────────────────────────────────────────────

const cartAddSchema = Joi.object({
  service_id:        Joi.string().uuid().required(),
  inventory_item_id: Joi.string().uuid().required(),
  batch_id:          Joi.string().uuid().allow(null).optional(),
  quantity:          Joi.number().positive().required(),
  unit:              Joi.string().max(20).required(),
  lot_number:        Joi.string().max(100).allow('', null).optional(),
  expiry_date:       Joi.string().isoDate().allow(null).optional(),
  scanned:           Joi.boolean().optional(),
});

const cartPatchSchema = Joi.object({
  quantity:    Joi.number().positive().optional(),
  lot_number:  Joi.string().max(100).allow('', null).optional(),
  expiry_date: Joi.string().isoDate().allow(null).optional(),
  scanned:     Joi.boolean().optional(),
  batch_id:    Joi.string().uuid().allow(null).optional(),
});

// helper: full cart rows with item details
async function cartWithDetails(sessionId, clinicId) {
  const { rows } = await db.query(
    `SELECT mc.*,
            ii.name        AS item_name,
            ii.category    AS item_category,
            ii.is_implant,
            ii.is_traceable
       FROM material_consumption mc
       JOIN inventory_item ii ON ii.id = mc.inventory_item_id
      WHERE mc.session_id = $1 AND mc.clinic_id = $2
      ORDER BY mc.created_at ASC`,
    [sessionId, clinicId]
  );
  return rows;
}

// GET /sessions/:id/cart
router.get(
  '/sessions/:id/cart',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  loadResource('session', 'id'),
  authorize('read', 'session', { mode: 'observe' }),
  async (req, res, next) => {
    try {
      const { id: sessionId } = req.params;
      const { clinicId } = req.context;

      const session = await db.query(
        `SELECT id FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));

      return res.json({ cart: await cartWithDetails(sessionId, clinicId) });
    } catch (err) { next(err); }
  }
);

// POST /sessions/:id/cart
router.post(
  '/sessions/:id/cart',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('update', 'session'),
  validate(cartAddSchema),
  async (req, res, next) => {
    try {
      const { id: sessionId } = req.params;
      const { clinicId, userId } = req.context;
      const { service_id, inventory_item_id, batch_id, quantity, unit, lot_number, expiry_date, scanned } = req.body;

      const session = await db.query(
        `SELECT id, sealed_at FROM clinical_session WHERE id=$1 AND clinic_id=$2`,
        [sessionId, clinicId]
      );
      if (!session.rows[0]) return next(createError(404, 'Session not found'));
      if (session.rows[0].sealed_at) return next(createError(409, 'Session is sealed'));

      const svc = await db.query(
        `SELECT id FROM service_performed WHERE id=$1 AND session_id=$2 AND clinic_id=$3`,
        [service_id, sessionId, clinicId]
      );
      if (!svc.rows[0]) return next(createError(404, 'Service not found in session'));

      const { rows } = await db.query(
        `INSERT INTO material_consumption
           (session_id, service_id, clinic_id, inventory_item_id, batch_id,
            quantity, unit, lot_number, expiry_date, scanned, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [sessionId, service_id, clinicId, inventory_item_id, batch_id || null,
         quantity, unit, lot_number || null, expiry_date || null,
         scanned ?? false, userId]
      );

      const [full] = await cartWithDetails(sessionId, clinicId);
      // Return just the newly created item enriched with item details
      const allCart = await cartWithDetails(sessionId, clinicId);
      const newItem = allCart.find(r => r.id === rows[0].id);
      return res.status(201).json({ cart_item: newItem });
    } catch (err) { next(err); }
  }
);

// PATCH /sessions/:id/cart/:itemId — update qty/lot/batch while still RESERVED
router.patch(
  '/sessions/:id/cart/:itemId',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('update', 'session'),
  validate(cartPatchSchema),
  async (req, res, next) => {
    try {
      const { id: sessionId, itemId } = req.params;
      const { clinicId } = req.context;

      const existing = await db.query(
        `SELECT id, state FROM material_consumption
          WHERE id=$1 AND session_id=$2 AND clinic_id=$3`,
        [itemId, sessionId, clinicId]
      );
      if (!existing.rows[0]) return next(createError(404, 'Cart item not found'));
      if (existing.rows[0].state !== 'RESERVED') {
        return next(createError(409, 'Can only update RESERVED cart items'));
      }

      const fields = [];
      const values = [];
      let i = 1;
      for (const key of ['quantity','lot_number','expiry_date','scanned','batch_id']) {
        if (req.body[key] !== undefined) {
          fields.push(`${key}=$${i++}`);
          values.push(req.body[key]);
        }
      }
      if (!fields.length) return next(createError(400, 'No fields to update'));
      fields.push(`updated_at=now()`);
      values.push(itemId, sessionId, clinicId);

      await db.query(
        `UPDATE material_consumption SET ${fields.join(',')}
          WHERE id=$${i} AND session_id=$${i+1} AND clinic_id=$${i+2}`,
        values
      );

      const allCart = await cartWithDetails(sessionId, clinicId);
      const updated = allCart.find(r => r.id === itemId);
      return res.json({ cart_item: updated });
    } catch (err) { next(err); }
  }
);

// DELETE /sessions/:id/cart/:itemId — remove RESERVED item (pre-commit)
router.delete(
  '/sessions/:id/cart/:itemId',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('update', 'session'),
  async (req, res, next) => {
    try {
      const { id: sessionId, itemId } = req.params;
      const { clinicId } = req.context;

      const { rows } = await db.query(
        `DELETE FROM material_consumption
          WHERE id=$1 AND session_id=$2 AND clinic_id=$3 AND state='RESERVED'
          RETURNING id`,
        [itemId, sessionId, clinicId]
      );
      if (!rows[0]) return next(createError(404, 'Cart item not found or already committed'));
      return res.json({ removed: true });
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
  loadResource('session', 'id'),
  authorize('read', 'session', { mode: 'observe' }),
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
        `SELECT lo.*, s.name AS service_name
           FROM lab_order lo
           LEFT JOIN service_performed sp ON sp.id = lo.service_id
           LEFT JOIN services s ON s.id = sp.service_id
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
  loadResource('service_performed', 'id'),
  mapLoadedResource('lab_order'),
  authorize('create', 'lab_order'),
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
  loadResource('lab_order', 'id'),
  authorize('update', 'lab_order'),
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
  loadResource('session', 'id'),
  mapLoadedResource('attachment'),
  authorize('create', 'attachment'),
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
  loadResource('session', 'id'),
  mapLoadedResource('attachment'),
  authorize('create', 'attachment'),
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
  loadResource('session', 'id'),
  mapLoadedResource('attachment'),
  authorize('read', 'attachment'),
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
  loadResource('session', 'id'),
  mapLoadedResource('attachment'),
  authorize('delete', 'attachment'),
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

// ═══════════════════════════════════════════════════════════════════════════════
// T6 — EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /sessions/:id/pause  (Endpoint 27 — EC-2) ───────────────────────────
router.post(
  '/sessions/:id/pause',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('update', 'session'),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));
      if (session.status === 'PAUSED') return next(createError(409, 'Session already paused'));
      if (['COMPLETED', 'ABANDONED'].includes(session.status)) {
        return next(createError(409, 'Cannot pause a completed or abandoned session'));
      }

      const { rows } = await db.query(
        `UPDATE clinical_session
         SET status = 'PAUSED', updated_at = NOW(), updated_by = $1
         WHERE id = $2 AND org_id = $3 AND clinic_id = $4
         RETURNING *`,
        [userId, req.params.id, orgId, clinicId]
      );

      req.audit.write({ entity_type: 'clinical_session', entity_id: req.params.id,
        action: 'SESSION_PAUSED', details: { previous_status: session.status } });

      return res.json({ session: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/resume  (Endpoint 28 — EC-2) ──────────────────────────
router.post(
  '/sessions/:id/resume',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('update', 'session'),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, req.params.id);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.status !== 'PAUSED') return next(createError(409, 'Session is not paused'));

      const { rows } = await db.query(
        `UPDATE clinical_session
         SET status = 'PERFORMING_SERVICES', updated_at = NOW(), updated_by = $1
         WHERE id = $2 AND org_id = $3 AND clinic_id = $4
         RETURNING *`,
        [userId, req.params.id, orgId, clinicId]
      );

      req.audit.write({ entity_type: 'clinical_session', entity_id: req.params.id,
        action: 'SESSION_RESUMED', details: {} });

      return res.json({ session: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/abandon  (Endpoint 29 — EC-1) ─────────────────────────
const abandonSessionSchema = Joi.object({
  end_reason: Joi.string().valid('medical', 'patient_request', 'equipment_failure', 'time', 'other').required(),
  notes:      Joi.string().max(1000).allow('', null).optional(),
  force:      Joi.boolean().default(false),
});

router.post(
  '/sessions/:id/abandon',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  loadResource('session', 'id'),
  authorize('update', 'session'),
  validate(abandonSessionSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));
      if (session.status === 'ABANDONED') return next(createError(409, 'Session already abandoned'));

      const { rows: inProgress } = await db.query(
        `SELECT id, service_id FROM service_performed
          WHERE session_id=$1 AND status='IN_PROGRESS' AND deleted_at IS NULL`,
        [sessionId]
      );

      if (inProgress.length && !req.body.force) {
        return next(createError(422, {
          message: `${inProgress.length} service(s) still in progress. Send force=true to abandon them.`,
          in_progress_count: inProgress.length,
        }));
      }

      await withTx(async (client) => {
        // Force-abandon any in-progress services
        if (inProgress.length) {
          await client.query(
            `UPDATE service_performed
             SET status='ABANDONED', abandon_reason='session_abandoned', updated_by=$1
             WHERE session_id=$2 AND status='IN_PROGRESS' AND deleted_at IS NULL`,
            [userId, sessionId]
          );
        }

        // Return all RESERVED cart items
        await client.query(
          `UPDATE material_consumption SET state='RETURNED', updated_at=now()
            WHERE session_id=$1 AND state='RESERVED'`,
          [sessionId]
        ).catch(() => {}); // non-blocking if inventory tables don't exist yet

        await client.query(
          `UPDATE clinical_session
           SET status='ABANDONED', ended_at=NOW(), end_reason=$1,
               updated_at=NOW(), updated_by=$2
           WHERE id=$3 AND org_id=$4 AND clinic_id=$5`,
          [req.body.end_reason, userId, sessionId, orgId, clinicId]
        );

        await client.query(
          `UPDATE appointments SET status='cancelled', updated_at=NOW()
           WHERE id=$1`,
          [session.appointment_id]
        );
      });

      req.audit.write({ entity_type: 'clinical_session', entity_id: sessionId,
        action: 'SESSION_ABANDONED', details: { end_reason: req.body.end_reason, notes: req.body.notes } });

      const { rows } = await db.query(`SELECT * FROM clinical_session WHERE id=$1`, [sessionId]);
      return res.json({ session: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/reopen  (Endpoint 31 — EC-9) ──────────────────────────
const REOPEN_WINDOW_MINUTES = 30;

router.post(
  '/sessions/:id/reopen',
  ...authChain,
  requirePermission(P.CLINIC_MANAGE),
  loadResource('session', 'id'),
  authorize('reopen', 'session'),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (!session.sealed_at) return next(createError(409, 'Session is not sealed'));

      const sealedMs  = new Date(session.sealed_at).getTime();
      const windowMs  = REOPEN_WINDOW_MINUTES * 60 * 1000;
      if (Date.now() - sealedMs > windowMs) {
        return next(createError(422, `Reopen window has expired (${REOPEN_WINDOW_MINUTES} min limit).`));
      }

      const { rows } = await db.query(
        `UPDATE clinical_session
         SET status     = 'PERFORMING_SERVICES',
             sealed_at  = NULL,
             sealed_by  = NULL,
             updated_at = NOW(),
             updated_by = $1
         WHERE id=$2 AND org_id=$3 AND clinic_id=$4
         RETURNING *`,
        [userId, sessionId, orgId, clinicId]
      );

      await db.query(
        `UPDATE appointments SET status='in_treatment', updated_at=NOW() WHERE id=$1`,
        [session.appointment_id]
      );

      req.audit.write({ entity_type: 'clinical_session', entity_id: sessionId,
        action: 'SESSION_REOPENED', details: { reopened_by: userId } });

      return res.json({ session: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── GET /sessions/:id/variance  (T6.4 — FE preflight check) ──────────────────
router.get(
  '/sessions/:id/variance',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    const sessionId = req.params.id;
    const THRESHOLD = 0.15;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));

      const { rows: cr } = await db.query(
        `SELECT COALESCE(SUM(final_charge),0) AS final_total
           FROM service_performed
          WHERE session_id=$1 AND status IN ('COMPLETED','PARTIAL') AND deleted_at IS NULL`,
        [sessionId]
      );
      const { rows: er } = await db.query(
        `SELECT COALESCE(SUM(tpi.cost_min),0) AS accepted_estimate
           FROM treatment_plan_item tpi
           JOIN treatment_plan tp ON tp.id = tpi.plan_id
          WHERE tp.patient_id=$1
            AND tpi.status IN ('ACCEPTED','IN_PROGRESS','DONE','PARTIAL')
            AND tpi.deleted_at IS NULL`,
        [session.patient_id]
      );

      const finalTotal       = parseFloat(cr[0].final_total);
      const acceptedEstimate = parseFloat(er[0].accepted_estimate);
      const varianceFlag     = acceptedEstimate > 0 && finalTotal > acceptedEstimate * (1 + THRESHOLD);

      return res.json({ final_total: finalTotal, accepted_estimate: acceptedEstimate,
        variance_flag: varianceFlag, threshold_pct: THRESHOLD * 100 });
    } catch (err) { next(err); }
  }
);

// ── GET /sessions/:id/tpa  ────────────────────────────────────────────────────
router.get(
  '/sessions/:id/tpa',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const { rows } = await db.query(
        `SELECT * FROM tpa_preauth
          WHERE session_id=$1 AND org_id=$2 AND clinic_id=$3
          ORDER BY created_at DESC`,
        [req.params.id, orgId, clinicId]
      ).catch(() => ({ rows: [] }));
      return res.json({ tpa: rows });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/tpa  (T6.6) ────────────────────────────────────────────
const tpaSchema = Joi.object({
  insurer_name:      Joi.string().max(200).required(),
  policy_number:     Joi.string().max(100).allow('', null).optional(),
  preauth_number:    Joi.string().max(100).allow('', null).optional(),
  approved_amount:   Joi.number().min(0).allow(null).optional(),
  approved_services: Joi.array().items(Joi.object()).default([]),
  copay_pct:         Joi.number().min(0).max(100).default(0),
  copay_flat:        Joi.number().min(0).default(0),
  status:            Joi.string().valid('PENDING','APPROVED','PARTIALLY_APPROVED','REJECTED','CANCELLED').default('PENDING'),
  notes:             Joi.string().max(1000).allow('', null).optional(),
});

router.post(
  '/sessions/:id/tpa',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(tpaSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));

      const b = req.body;
      const { rows } = await db.query(
        `INSERT INTO tpa_preauth
           (org_id, clinic_id, session_id, patient_id, insurer_name, policy_number,
            preauth_number, approved_amount, approved_services, copay_pct, copay_flat,
            status, notes, created_by, updated_by,
            submitted_at, responded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,
                 ${b.status !== 'PENDING' ? 'now()' : 'NULL'},
                 ${['APPROVED','PARTIALLY_APPROVED','REJECTED'].includes(b.status) ? 'now()' : 'NULL'})
         RETURNING *`,
        [orgId, clinicId, sessionId, session.patient_id, b.insurer_name, b.policy_number || null,
         b.preauth_number || null, b.approved_amount ?? null, JSON.stringify(b.approved_services || []),
         b.copay_pct || 0, b.copay_flat || 0, b.status, b.notes || null, userId]
      );
      return res.status(201).json({ tpa: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── PATCH /tpa/:id  (T6.6 — update status/details) ───────────────────────────
router.patch(
  '/tpa/:id',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    try {
      const allowed = ['status','preauth_number','approved_amount','approved_services',
                       'copay_pct','copay_flat','notes','rejection_reason'];
      const sets = []; const vals = [];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${vals.length + 1}`);
          vals.push(key === 'approved_services' ? JSON.stringify(req.body[key]) : req.body[key]);
        }
      }
      if (!sets.length) return next(createError(400, 'No fields to update'));
      if (req.body.status && req.body.status !== 'PENDING') {
        sets.push(`submitted_at = COALESCE(submitted_at, NOW())`);
      }
      if (['APPROVED','PARTIALLY_APPROVED','REJECTED'].includes(req.body.status)) {
        sets.push(`responded_at = NOW()`);
      }
      sets.push(`updated_by = $${vals.length + 1}`, `updated_at = NOW()`);
      vals.push(userId, req.params.id, orgId, clinicId);

      const { rows } = await db.query(
        `UPDATE tpa_preauth SET ${sets.join(', ')}
          WHERE id=$${vals.length - 2} AND org_id=$${vals.length - 1} AND clinic_id=$${vals.length}
          RETURNING *`,
        vals
      );
      if (!rows.length) return next(createError(404, 'TPA record not found'));
      return res.json({ tpa: rows[0] });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// T5 — SURGICAL GATING
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /sessions/:id/consents ─────────────────────────────────────────────────
router.get(
  '/sessions/:id/consents',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const { rows } = await db.query(
        `SELECT cr.*, ct.title AS template_title, ct.body_html AS template_body
           FROM consent_record cr
           LEFT JOIN consent_template ct ON ct.id = cr.template_id
          WHERE cr.session_id = $1 AND cr.org_id = $2 AND cr.clinic_id = $3
          ORDER BY cr.signed_at ASC`,
        [req.params.id, orgId, clinicId]
      );
      return res.json({ consents: rows });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/consents/sign  (presign patient signature upload) ────────
router.post(
  '/sessions/:id/consents/sign',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  async (req, res, next) => {
    try {
      const s3Key = `consents/${req.params.id}/${Date.now()}_sig.png`;
      const uploadUrl = await getPresignedPutUrl({
        key:         s3Key,
        contentType: 'image/png',
        expiresIn:   300,
      });
      return res.json({ upload_url: uploadUrl, s3_key: s3Key });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/consents  (Endpoint 13 — confirm consent after sig upload)
const addConsentSchema = Joi.object({
  procedure_type:        Joi.string().max(120).required(),
  service_id:            Joi.string().uuid().optional(),
  template_id:           Joi.string().uuid().optional(),
  patient_signature_url: Joi.string().max(500).required(),
  witness_signature_url: Joi.string().max(500).allow('', null).optional(),
  is_minor:              Joi.boolean().default(false),
  guardian_name:         Joi.string().max(200).allow('', null).optional(),
  notes:                 Joi.string().max(2000).allow('', null).optional(),
});

router.post(
  '/sessions/:id/consents',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(addConsentSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      // Guard the optional catalog-service link so a bad id returns a clean 400
      // instead of a raw FK violation (consent_record.service_id → services.id).
      if (req.body.service_id) {
        const svc = await db.query(
          `SELECT 1 FROM services WHERE id = $1 AND clinic_id = $2`,
          [req.body.service_id, clinicId]
        );
        if (!svc.rows[0]) return next(createError(400, 'Linked service not found for this clinic'));
      }

      // hash the s3 key as a lightweight integrity marker
      const crypto = require('crypto');
      const sigHash = crypto
        .createHash('sha256')
        .update(req.body.patient_signature_url)
        .digest('hex');

      const { rows } = await db.query(
        `INSERT INTO consent_record
           (org_id, clinic_id, session_id, patient_id, template_id, procedure_type,
            service_id, patient_signature_url, witness_signature_url,
            signature_hash, is_minor, guardian_name, signed_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          orgId, clinicId, sessionId, session.patient_id,
          req.body.template_id || null,
          req.body.procedure_type,
          req.body.service_id || null,
          req.body.patient_signature_url,
          req.body.witness_signature_url || null,
          sigHash,
          req.body.is_minor || false,
          req.body.guardian_name || null,
          userId,
          req.body.notes || null,
        ]
      );

      req.audit.write({
        entity_type: 'consent_record',
        entity_id:   rows[0].id,
        action:      'CONSENT_SIGNED',
        details:     { session_id: sessionId, procedure_type: req.body.procedure_type },
      });

      return res.status(201).json({ consent: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── GET /consent-templates ─────────────────────────────────────────────────────
router.get(
  '/consent-templates',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const { rows } = await db.query(
        `SELECT * FROM consent_template
          WHERE clinic_id = $1 AND org_id = $2 AND is_active = true
          ORDER BY procedure_type, version DESC`,
        [clinicId, orgId]
      );
      return res.json({ templates: rows });
    } catch (err) { next(err); }
  }
);

// ── GET /sessions/:id/preop ───────────────────────────────────────────────────
router.get(
  '/sessions/:id/preop',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const { rows } = await db.query(
        `SELECT * FROM preop_record
          WHERE session_id=$1 AND org_id=$2 AND clinic_id=$3`,
        [req.params.id, orgId, clinicId]
      );
      return res.json({ preop: rows[0] || null });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/preop  (Endpoint 14) ───────────────────────────────────
const preopSchema = Joi.object({
  bp_systolic:                  Joi.number().integer().min(50).max(300).allow(null).optional(),
  bp_diastolic:                 Joi.number().integer().min(30).max(200).allow(null).optional(),
  pulse:                        Joi.number().integer().min(20).max(300).allow(null).optional(),
  spo2:                         Joi.number().min(50).max(100).allow(null).optional(),
  temperature:                  Joi.number().min(30).max(45).allow(null).optional(),
  blood_sugar:                  Joi.number().min(0).max(1000).allow(null).optional(),
  inr_value:                    Joi.number().min(0).max(20).allow(null).optional(),
  allergies_confirmed_at:       Joi.string().isoDate().allow(null).optional(),
  medical_clearance_url:        Joi.string().max(500).allow('', null).optional(),
  antibiotic_prophylaxis_given: Joi.boolean().default(false),
  antibiotic_drug:              Joi.string().max(200).allow('', null).optional(),
  antibiotic_dose:              Joi.string().max(100).allow('', null).optional(),
  antibiotic_given_at:          Joi.string().isoDate().allow(null).optional(),
  npo_hours:                    Joi.number().min(0).max(72).allow(null).optional(),
  anaesthesia_plan:             Joi.string().valid('local', 'sedation', 'ga').default('local'),
  anaesthesia_agent:            Joi.string().max(200).allow('', null).optional(),
  anaesthesia_dose:             Joi.string().max(100).allow('', null).optional(),
  surgical_site_marked:         Joi.boolean().default(false),
  override_reason:              Joi.string().max(500).allow('', null).optional(),
  is_complete:                  Joi.boolean().default(false),
  notes:                        Joi.string().max(2000).allow('', null).optional(),
});

router.post(
  '/sessions/:id/preop',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(preopSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      const b = req.body;
      const completedAt = b.is_complete ? 'now()' : 'NULL';

      const { rows } = await db.query(
        `INSERT INTO preop_record
           (org_id, clinic_id, session_id,
            bp_systolic, bp_diastolic, pulse, spo2, temperature, blood_sugar, inr_value,
            allergies_confirmed_at, medical_clearance_url,
            antibiotic_prophylaxis_given, antibiotic_drug, antibiotic_dose, antibiotic_given_at,
            npo_hours, anaesthesia_plan, anaesthesia_agent, anaesthesia_dose,
            surgical_site_marked, override_reason, is_complete,
            completed_at, completed_by, created_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                 ${b.is_complete ? 'now()' : 'NULL'},$24,$24,$25)
         ON CONFLICT (session_id) DO UPDATE SET
           bp_systolic=$4, bp_diastolic=$5, pulse=$6, spo2=$7, temperature=$8,
           blood_sugar=$9, inr_value=$10, allergies_confirmed_at=$11,
           medical_clearance_url=$12, antibiotic_prophylaxis_given=$13,
           antibiotic_drug=$14, antibiotic_dose=$15, antibiotic_given_at=$16,
           npo_hours=$17, anaesthesia_plan=$18, anaesthesia_agent=$19, anaesthesia_dose=$20,
           surgical_site_marked=$21, override_reason=$22, is_complete=$23,
           completed_at=${b.is_complete ? 'now()' : 'preop_record.completed_at'},
           completed_by=${b.is_complete ? '$24' : 'preop_record.completed_by'},
           notes=$25, updated_at=now()
         RETURNING *`,
        [
          orgId, clinicId, sessionId,
          b.bp_systolic ?? null, b.bp_diastolic ?? null, b.pulse ?? null,
          b.spo2 ?? null, b.temperature ?? null, b.blood_sugar ?? null, b.inr_value ?? null,
          b.allergies_confirmed_at || null, b.medical_clearance_url || null,
          b.antibiotic_prophylaxis_given || false,
          b.antibiotic_drug || null, b.antibiotic_dose || null, b.antibiotic_given_at || null,
          b.npo_hours ?? null, b.anaesthesia_plan || 'local',
          b.anaesthesia_agent || null, b.anaesthesia_dose || null,
          b.surgical_site_marked || false, b.override_reason || null,
          b.is_complete || false,
          userId,
          b.notes || null,
        ]
      );

      return res.status(201).json({ preop: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── GET /sessions/:id/postop ──────────────────────────────────────────────────
router.get(
  '/sessions/:id/postop',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    const { orgId, clinicId } = req.context;
    try {
      const { rows } = await db.query(
        `SELECT * FROM postop_record
          WHERE session_id=$1 AND org_id=$2 AND clinic_id=$3`,
        [req.params.id, orgId, clinicId]
      );
      return res.json({ postop: rows[0] || null });
    } catch (err) { next(err); }
  }
);

// ── POST /sessions/:id/postop  (Endpoint 25) ─────────────────────────────────
const postopSchema = Joi.object({
  complications:               Joi.array().items(Joi.object({
    type:         Joi.string().max(200).required(),
    severity:     Joi.string().valid('mild','moderate','severe').required(),
    action_taken: Joi.string().max(500).allow('').optional(),
  })).default([]),
  suture_count:                Joi.number().integer().min(0).allow(null).optional(),
  suture_type:                 Joi.string().valid('resorbable','non-resorbable').allow(null).optional(),
  suture_removal_date:         Joi.string().isoDate().allow(null).optional(),
  specimen_sent:               Joi.boolean().default(false),
  specimen_lab_id:             Joi.string().max(200).allow('', null).optional(),
  specimen_request_slip_no:    Joi.string().max(200).allow('', null).optional(),
  specimen_expected_report_date: Joi.string().isoDate().allow(null).optional(),
  recovery_vitals:             Joi.array().items(Joi.object({
    time:    Joi.string().required(),
    bp_sys:  Joi.number().integer().allow(null).optional(),
    bp_dia:  Joi.number().integer().allow(null).optional(),
    pulse:   Joi.number().integer().allow(null).optional(),
    spo2:    Joi.number().allow(null).optional(),
  })).default([]),
  postop_instructions_given:   Joi.boolean().default(false),
  postop_instructions_text:    Joi.string().max(5000).allow('', null).optional(),
  patient_acknowledged_at:     Joi.string().isoDate().allow(null).optional(),
  follow_up_date:              Joi.string().isoDate().allow(null).optional(),
  follow_up_notes:             Joi.string().max(1000).allow('', null).optional(),
  notes:                       Joi.string().max(2000).allow('', null).optional(),
});

router.post(
  '/sessions/:id/postop',
  ...authChain,
  requirePermission(P.APPOINTMENT_UPDATE),
  validate(postopSchema),
  async (req, res, next) => {
    const { orgId, clinicId, userId } = req.context;
    const sessionId = req.params.id;
    try {
      const session = await sessionRepo.findById({ orgId, clinicId }, sessionId);
      if (!session) return next(createError(404, 'Session not found'));
      if (session.sealed_at) return next(createError(409, 'Session is sealed'));

      const b = req.body;
      const { rows } = await db.query(
        `INSERT INTO postop_record
           (org_id, clinic_id, session_id, complications, suture_count, suture_type,
            suture_removal_date, specimen_sent, specimen_lab_id, specimen_request_slip_no,
            specimen_expected_report_date, recovery_vitals, postop_instructions_given,
            postop_instructions_text, patient_acknowledged_at, follow_up_date,
            follow_up_notes, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (session_id) DO UPDATE SET
           complications=$4, suture_count=$5, suture_type=$6, suture_removal_date=$7,
           specimen_sent=$8, specimen_lab_id=$9, specimen_request_slip_no=$10,
           specimen_expected_report_date=$11, recovery_vitals=$12,
           postop_instructions_given=$13, postop_instructions_text=$14,
           patient_acknowledged_at=$15, follow_up_date=$16, follow_up_notes=$17,
           notes=$18, updated_at=now()
         RETURNING *`,
        [
          orgId, clinicId, sessionId,
          JSON.stringify(b.complications || []),
          b.suture_count ?? null, b.suture_type || null, b.suture_removal_date || null,
          b.specimen_sent || false, b.specimen_lab_id || null,
          b.specimen_request_slip_no || null, b.specimen_expected_report_date || null,
          JSON.stringify(b.recovery_vitals || []),
          b.postop_instructions_given || false, b.postop_instructions_text || null,
          b.patient_acknowledged_at || null, b.follow_up_date || null,
          b.follow_up_notes || null, b.notes || null,
          userId,
        ]
      );

      req.audit.write({
        entity_type: 'postop_record',
        entity_id:   rows[0].id,
        action:      'POSTOP_SAVED',
        details:     { session_id: sessionId },
      });

      return res.status(201).json({ postop: rows[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
