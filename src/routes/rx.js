const express      = require('express');
const Joi          = require('joi');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize    = require('../middleware/authorize');
const validate     = require('../middleware/validate');
const {
  buildPrescriptionPdfKey,
  getPresignedUrl,
  objectExists,
  uploadBuffer,
} = require('../services/s3Service');
const rxPdfBuilder = require('../services/rxPdfBuilder');

const router = express.Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const lineItemSchema = Joi.object({
  itemType:        Joi.string().valid('medicine', 'procedure').required(),
  refId:           Joi.number().integer().positive().required(),
  sortOrder:       Joi.number().integer().min(1).max(50).default(1),
  dosage:          Joi.string().max(80).optional().allow(''),
  frequency:       Joi.string().max(60).optional().allow(''),
  duration:        Joi.string().max(40).optional().allow(''),
  quantity:        Joi.string().max(40).optional().allow(''),
  procedureStatus: Joi.string().valid('planned', 'done', 'skipped').optional(),
  instructions:    Joi.string().max(2000).optional().allow(''),
});

const rxCreateSchema = Joi.object({
  patientId:     Joi.string().uuid().required(),
  appointmentId: Joi.string().uuid().required(),
  diagnosis:     Joi.string().max(500).optional().allow(''),
  clinicalNotes: Joi.string().max(5000).optional().allow(''),
  validDays:     Joi.number().integer().min(1).max(365).default(7),
  refillable:    Joi.boolean().default(false),
  items:         Joi.array().items(lineItemSchema).min(1).max(50).required(),
});

const rxUpdateSchema = Joi.object({
  diagnosis:     Joi.string().max(500).optional().allow(''),
  clinicalNotes: Joi.string().max(5000).optional().allow(''),
  items:         Joi.array().items(lineItemSchema).min(1).max(50).optional(),
});

const medCreateSchema = Joi.object({
  genericName:  Joi.string().max(150).required(),
  brandName:    Joi.string().max(150).optional().allow(''),
  category:     Joi.string().valid('antibiotic','analgesic','anti_inflammatory','antifungal','antiseptic','vitamin','topical','other').required(),
  dosageForm:   Joi.string().valid('tablet','capsule','syrup','gel','drops','injection','mouthwash').required(),
  strength:     Joi.string().max(50).required(),
  defaultDose:  Joi.string().max(80).optional().allow(''),
  defaultDays:  Joi.number().integer().min(1).max(365).optional(),
  notes:        Joi.string().max(500).optional().allow(''),
});

const medUpdateSchema = medCreateSchema.fork(
  ['genericName','category','dosageForm','strength'],
  f => f.optional()
).keys({ isActive: Joi.boolean().optional() });

const procCreateSchema = Joi.object({
  procedureCode: Joi.string().max(30).required(),
  procedureName: Joi.string().max(200).required(),
  svcId:         Joi.string().max(10).required(),
  procedureStep: Joi.number().integer().min(1).optional(),
  defaultNotes:  Joi.string().optional().allow(''),
  durationDays:  Joi.number().integer().min(0).default(0),
  followupDays:  Joi.number().integer().min(1).optional(),
});

const procUpdateSchema = procCreateSchema.fork(
  ['procedureCode','procedureName','svcId'],
  f => f.optional()
).keys({ isActive: Joi.boolean().optional() });

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function nextRxNumber(client) {
  const year = new Date().getFullYear();
  const result = await client.query(
    `INSERT INTO rx_sequence (fy_year, last_seq) VALUES ($1, 1)
     ON CONFLICT (fy_year) DO UPDATE SET last_seq = rx_sequence.last_seq + 1
     RETURNING last_seq`,
    [year]
  );
  return `DRX-${year}-${String(result.rows[0].last_seq).padStart(4, '0')}`;
}

async function insertLineItems(client, prescriptionId, items) {
  if (!items.length) return;
  const valuePlaceholders = items.map((_, i) => {
    const b = i * 10;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`;
  }).join(',');

  const flat = items.flatMap((item, idx) => [
    prescriptionId,
    item.itemType,
    item.refId,
    item.sortOrder || idx + 1,
    item.dosage          || null,
    item.frequency       || null,
    item.duration        || null,
    item.quantity        || null,
    item.procedureStatus || 'planned',
    item.instructions    || null,
  ]);

  await client.query(
    `INSERT INTO rx_line_items
       (prescription_id, item_type, ref_id, sort_order,
        dosage, frequency, duration, quantity, procedure_status, instructions)
     VALUES ${valuePlaceholders}`,
    flat
  );
}

// ─── Master data — medicines ──────────────────────────────────────────────────

router.get('/master/medicines', authenticate, async (req, res, next) => {
  try {
    const { search, category } = req.query;
    const params = [req.user.clinic_id];
    let query = `SELECT * FROM rx_medicines WHERE clinic_id = $1 AND is_active = true`;

    if (category) { params.push(category);          query += ` AND category = $${params.length}`; }
    if (search)   { params.push(`%${search}%`);     query += ` AND generic_name ILIKE $${params.length}`; }

    query += ` ORDER BY generic_name ASC`;
    const result = await db.query(query, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

router.post('/master/medicines', authenticate, authorize('admin'), validate(medCreateSchema), async (req, res, next) => {
  try {
    const { genericName, brandName, category, dosageForm, strength, defaultDose, defaultDays, notes } = req.body;
    const result = await db.query(
      `INSERT INTO rx_medicines
         (clinic_id, generic_name, brand_name, category, dosage_form, strength, default_dose, default_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [req.user.clinic_id, genericName, brandName || null, category, dosageForm,
       strength, defaultDose || null, defaultDays || null, notes || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/master/medicines/:id', authenticate, authorize('admin'), validate(medUpdateSchema), async (req, res, next) => {
  try {
    const FIELD_MAP = {
      genericName: 'generic_name', brandName: 'brand_name', category: 'category',
      dosageForm: 'dosage_form', strength: 'strength', defaultDose: 'default_dose',
      defaultDays: 'default_days', notes: 'notes', isActive: 'is_active',
    };
    const updates = [];
    const params  = [];
    for (const [jsKey, colName] of Object.entries(FIELD_MAP)) {
      if (req.body[jsKey] !== undefined) {
        params.push(req.body[jsKey]);
        updates.push(`${colName}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.id, req.user.clinic_id);
    const result = await db.query(
      `UPDATE rx_medicines SET ${updates.join(', ')}, updated_at=now()
       WHERE id=$${params.length - 1} AND clinic_id=$${params.length}
       RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Medicine not found' });
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/master/medicines/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    // Check if medicine is referenced by any non-deleted line item for this clinic
    const inUse = await db.query(
      `SELECT li.id FROM rx_line_items li
       JOIN prescriptions p ON p.id = li.prescription_id
       WHERE li.ref_id = $1 AND li.item_type = 'medicine'
         AND li.is_deleted = false AND p.clinic_id = $2
       LIMIT 1`,
      [req.params.id, req.user.clinic_id]
    );
    if (inUse.rows.length) {
      return res.status(409).json({ error: 'Medicine is used in existing prescriptions. Deactivate it instead.' });
    }
    const result = await db.query(
      `DELETE FROM rx_medicines WHERE id=$1 AND clinic_id=$2 RETURNING id`,
      [req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Medicine not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Master data — procedures ─────────────────────────────────────────────────

router.get('/master/procedures', authenticate, async (req, res, next) => {
  try {
    const { svc_id } = req.query;
    const params = [req.user.clinic_id];
    let query = `SELECT * FROM rx_procedures WHERE clinic_id = $1 AND is_active = true`;

    if (svc_id) { params.push(svc_id); query += ` AND svc_id = $${params.length}`; }

    query += ` ORDER BY procedure_step ASC NULLS LAST, procedure_name ASC`;
    const result = await db.query(query, params);
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

router.post('/master/procedures', authenticate, authorize('admin'), validate(procCreateSchema), async (req, res, next) => {
  try {
    const { procedureCode, procedureName, svcId, procedureStep, defaultNotes, durationDays, followupDays } = req.body;
    const result = await db.query(
      `INSERT INTO rx_procedures
         (clinic_id, procedure_code, procedure_name, svc_id, procedure_step,
          default_notes, duration_days, followup_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.user.clinic_id, procedureCode, procedureName, svcId,
       procedureStep || null, defaultNotes || null, durationDays, followupDays || null]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/master/procedures/:id', authenticate, authorize('admin'), validate(procUpdateSchema), async (req, res, next) => {
  try {
    const FIELD_MAP = {
      procedureCode: 'procedure_code', procedureName: 'procedure_name', svcId: 'svc_id',
      procedureStep: 'procedure_step', defaultNotes: 'default_notes',
      durationDays: 'duration_days', followupDays: 'followup_days', isActive: 'is_active',
    };
    const updates = [];
    const params  = [];
    for (const [jsKey, colName] of Object.entries(FIELD_MAP)) {
      if (req.body[jsKey] !== undefined) {
        params.push(req.body[jsKey]);
        updates.push(`${colName}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.id, req.user.clinic_id);
    const result = await db.query(
      `UPDATE rx_procedures SET ${updates.join(', ')}, updated_at=now()
       WHERE id=$${params.length - 1} AND clinic_id=$${params.length}
       RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Procedure not found' });
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/master/procedures/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const inUse = await db.query(
      `SELECT li.id FROM rx_line_items li
       JOIN prescriptions p ON p.id = li.prescription_id
       WHERE li.ref_id = $1 AND li.item_type = 'procedure'
         AND li.is_deleted = false AND p.clinic_id = $2
       LIMIT 1`,
      [req.params.id, req.user.clinic_id]
    );
    if (inUse.rows.length) {
      return res.status(409).json({ error: 'Procedure is used in existing prescriptions. Deactivate it instead.' });
    }
    const result = await db.query(
      `DELETE FROM rx_procedures WHERE id=$1 AND clinic_id=$2 RETURNING id`,
      [req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Procedure not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Master data — service defaults ──────────────────────────────────────────

router.get('/master/defaults', authenticate, async (req, res, next) => {
  try {
    const { svc_id } = req.query;
    if (!svc_id) return res.status(400).json({ error: 'svc_id is required' });

    const [medsResult, procsResult] = await Promise.all([
      db.query(
        `SELECT m.id, m.generic_name, m.brand_name, m.dosage_form,
                m.strength, m.default_dose, m.default_days
         FROM rx_service_defaults sd
         JOIN rx_medicines m ON m.id = sd.medicine_id
         WHERE sd.clinic_id = $1 AND sd.svc_id = $2 AND m.is_active = true
         ORDER BY sd.sort_order ASC`,
        [req.user.clinic_id, svc_id]
      ),
      db.query(
        `SELECT * FROM rx_procedures
         WHERE clinic_id = $1 AND svc_id = $2 AND is_active = true
         ORDER BY procedure_step ASC NULLS LAST, procedure_name ASC`,
        [req.user.clinic_id, svc_id]
      ),
    ]);

    res.json({ data: { medicines: medsResult.rows, procedures: procsResult.rows } });
  } catch (err) { next(err); }
});

// ─── Prescriptions ────────────────────────────────────────────────────────────

router.post('/prescriptions', authenticate, validate(rxCreateSchema), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { patientId, appointmentId, diagnosis, clinicalNotes, validDays, refillable, items } = req.body;
    const doctorId = req.user.sub;
    const clinicId = req.user.clinic_id;

    await client.query('BEGIN');

    const patCheck = await client.query(
      `SELECT id FROM patients WHERE id=$1 AND clinic_id=$2`, [patientId, clinicId]
    );
    if (!patCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Patient not found' });
    }

    const apptCheck = await client.query(
      `SELECT id FROM appointments WHERE id=$1 AND patient_id=$2 AND clinic_id=$3`,
      [appointmentId, patientId, clinicId]
    );
    if (!apptCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const dupCheck = await client.query(
      `SELECT id FROM prescriptions WHERE appointment_id=$1`, [appointmentId]
    );
    if (dupCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A prescription already exists for this appointment',
        existing_id: dupCheck.rows[0].id,
      });
    }

    const prescriptionNo = await nextRxNumber(client);

    const rxResult = await client.query(
      `INSERT INTO prescriptions
         (prescription_no, patient_id, appointment_id, doctor_id, clinic_id,
          diagnosis, clinical_notes, valid_days, refillable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, prescription_no`,
      [prescriptionNo, patientId, appointmentId, doctorId, clinicId,
       diagnosis || null, clinicalNotes || null, validDays, refillable]
    );

    const prescriptionId = rxResult.rows[0].id;
    await insertLineItems(client, prescriptionId, items);
    await client.query('COMMIT');

    res.status(201).json({ id: prescriptionId, prescription_no: prescriptionNo });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(err);
  } finally {
    client.release();
  }
});

router.get('/prescriptions', authenticate, async (req, res, next) => {
  try {
    const { patient_id, page = 1, limit = 10 } = req.query;
    if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

    const cap    = Math.min(Number(limit) || 10, 50);
    const offset = (Number(page) - 1) * cap;

    const [countResult, rowsResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM prescriptions WHERE patient_id=$1 AND clinic_id=$2`,
        [patient_id, req.user.clinic_id]
      ),
      db.query(
        `SELECT id, prescription_no, diagnosis, pdf_generated, wa_sent, created_at, valid_days
         FROM prescriptions
         WHERE patient_id=$1 AND clinic_id=$2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [patient_id, req.user.clinic_id, cap, offset]
      ),
    ]);

    res.json({
      data:  rowsResult.rows,
      total: Number(countResult.rows[0].count),
      page:  Number(page),
      limit: cap,
    });
  } catch (err) { next(err); }
});

router.get('/prescriptions/:id', authenticate, async (req, res, next) => {
  try {
    const rxResult = await db.query(
      `SELECT p.*,
              pat.name        AS patient_name,
              pat.phone       AS patient_phone,
              u.first_name    AS doctor_first_name,
              u.last_name     AS doctor_last_name,
              c.name          AS clinic_name,
              c.phone         AS clinic_phone,
              c.address       AS clinic_address,
              c.city          AS clinic_city,
              c.logo_url      AS clinic_logo_url
       FROM prescriptions p
       JOIN patients pat ON pat.id = p.patient_id
       JOIN users    u   ON u.id   = p.doctor_id
       JOIN clinics  c   ON c.id   = p.clinic_id
       WHERE p.id=$1 AND p.clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!rxResult.rows.length) return res.status(404).json({ error: 'Prescription not found' });

    const linesResult = await db.query(
      `SELECT li.*,
              m.generic_name  AS medicine_name,
              m.brand_name,
              m.strength      AS medicine_strength,
              pr.procedure_name,
              pr.procedure_code,
              pr.default_notes
       FROM rx_line_items li
       LEFT JOIN rx_medicines  m  ON m.id  = li.ref_id AND li.item_type = 'medicine'
       LEFT JOIN rx_procedures pr ON pr.id = li.ref_id AND li.item_type = 'procedure'
       WHERE li.prescription_id=$1 AND li.is_deleted = false
       ORDER BY li.sort_order ASC`,
      [req.params.id]
    );

    res.json({ data: { ...rxResult.rows[0], line_items: linesResult.rows } });
  } catch (err) { next(err); }
});

router.put('/prescriptions/:id', authenticate, validate(rxUpdateSchema), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { diagnosis, clinicalNotes, items } = req.body;
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM prescriptions WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const updates = [];
    const params  = [];
    if (diagnosis     !== undefined) { params.push(diagnosis);     updates.push(`diagnosis=$${params.length}`);      }
    if (clinicalNotes !== undefined) { params.push(clinicalNotes); updates.push(`clinical_notes=$${params.length}`); }
    if (updates.length) {
      params.push(req.params.id);
      await client.query(
        `UPDATE prescriptions SET ${updates.join(', ')}, updated_at=now() WHERE id=$${params.length}`,
        params
      );
    }

    if (items) {
      await client.query(
        `UPDATE rx_line_items SET is_deleted=true WHERE prescription_id=$1`, [req.params.id]
      );
      await insertLineItems(client, req.params.id, items);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(err);
  } finally {
    client.release();
  }
});

// ─── PDF generation ───────────────────────────────────────────────────────────

router.post('/prescriptions/:id/generate', authenticate, async (req, res, next) => {
  try {
    const rxResult = await db.query(
      `SELECT p.*,
              pat.name    AS patient_name,  pat.phone  AS patient_phone,
              u.first_name AS doctor_first_name, u.last_name AS doctor_last_name,
              c.name      AS clinic_name,   c.phone    AS clinic_phone,
              c.address   AS clinic_address, c.city    AS clinic_city,
              c.logo_url  AS clinic_logo_url
       FROM prescriptions p
       JOIN patients pat ON pat.id = p.patient_id
       JOIN users    u   ON u.id   = p.doctor_id
       JOIN clinics  c   ON c.id   = p.clinic_id
       WHERE p.id=$1 AND p.clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!rxResult.rows.length) return res.status(404).json({ error: 'Prescription not found' });
    const prescription = rxResult.rows[0];

    const linesResult = await db.query(
      `SELECT li.*,
              m.generic_name AS medicine_name, m.brand_name, m.strength AS medicine_strength,
              pr.procedure_name, pr.procedure_code, pr.default_notes
       FROM rx_line_items li
       LEFT JOIN rx_medicines  m  ON m.id  = li.ref_id AND li.item_type = 'medicine'
       LEFT JOIN rx_procedures pr ON pr.id = li.ref_id AND li.item_type = 'procedure'
       WHERE li.prescription_id=$1 AND li.is_deleted = false
       ORDER BY li.sort_order ASC`,
      [req.params.id]
    );

    const pdfBuffer = await rxPdfBuilder.build({ ...prescription, line_items: linesResult.rows });

    const s3Key = buildPrescriptionPdfKey({
      patientId:       prescription.patient_id,
      prescriptionNo:  prescription.prescription_no,
    });

    await uploadBuffer({ key: s3Key, buffer: pdfBuffer, contentType: 'application/pdf', encrypt: true });

    const updated = await db.query(
      `UPDATE prescriptions
       SET pdf_generated=true, pdf_generated_at=now(), pdf_s3_key=$3, updated_at=now()
       WHERE id=$1 AND clinic_id=$2
       RETURNING id, prescription_no, pdf_s3_key, pdf_generated_at`,
      [req.params.id, req.user.clinic_id, s3Key]
    );

    res.json({ message: 'PDF generated', prescription: updated.rows[0] });
  } catch (err) { next(err); }
});

router.get('/prescriptions/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT pdf_s3_key, pdf_generated FROM prescriptions WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Prescription not found' });
    if (!result.rows[0].pdf_generated || !result.rows[0].pdf_s3_key)
      return res.status(404).json({ error: 'PDF not yet generated' });
    if (!(await objectExists({ key: result.rows[0].pdf_s3_key })))
      return res.status(404).json({ error: 'PDF file missing in S3 — regenerate the prescription' });

    const url = await getPresignedUrl({
      key:       result.rows[0].pdf_s3_key,
      expiresIn: Number(process.env.AWS_S3_SIGNED_URL_TTL_SECONDS || 900),
    });
    res.json({ url });
  } catch (err) { next(err); }
});

// ─── WA send hook ─────────────────────────────────────────────────────────────

router.post('/prescriptions/:id/send', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE prescriptions
       SET wa_sent=true, wa_sent_at=COALESCE(wa_sent_at, now()), updated_at=now()
       WHERE id=$1 AND clinic_id=$2 AND pdf_generated=true
       RETURNING id, prescription_no, wa_sent_at`,
      [req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) {
      const exists = await db.query(
        `SELECT pdf_generated FROM prescriptions WHERE id=$1 AND clinic_id=$2`,
        [req.params.id, req.user.clinic_id]
      );
      if (!exists.rows.length) return res.status(404).json({ error: 'Prescription not found' });
      return res.status(400).json({ error: 'Generate PDF before sending' });
    }
    res.json({ success: true, prescription: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
