const express  = require('express');
const Joi      = require('joi');
const db       = require('../db');
const { generateSlots } = require('../helpers/slots');
const authenticate     = require('../middleware/authenticate');
const authorize        = require('../middleware/authorize');
const validate         = require('../middleware/validate');
const bus              = require('../services/appointmentBus');

const router = express.Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const bookingSchema = Joi.object({
  service_id:     Joi.string().required(),
  chair_id:       Joi.string().required(),
  scheduled_at:   Joi.string().isoDate().required(),
  booking_source: Joi.string().valid('website', 'whatsapp', 'direct', 'staff').required(),
  notes:          Joi.string().optional().allow(''),
  intake_data:    Joi.object().optional().default({}),
  patient: Joi.object({
    name:  Joi.string().required(),
    phone: Joi.string().required(),
    email: Joi.string().email().optional().allow(''),
  }).required(),
});

const statusSchema = Joi.object({
  status: Joi.string().valid('confirmed', 'in_progress', 'done', 'no_show', 'cancelled').required(),
});

const rescheduleSchema = Joi.object({
  scheduled_at: Joi.string().isoDate().optional(),
  chair_id:     Joi.string().uuid().optional(),
  notes:        Joi.string().optional().allow(''),
});

/** Slots API uses DB UUIDs — use ids from GET /v1/services and /v1/chairs (not client codes like SVC-03). */
const slotsQuerySchema = Joi.object({
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  service_id: Joi.string().uuid().required().messages({
    'string.guid': 'service_id must be a service UUID from GET /v1/services',
  }),
  chair_id: Joi.string().uuid().required().messages({
    'string.guid': 'chair_id must be a chair UUID from GET /v1/chairs',
  }),
});

// ─── Allowed state transitions ────────────────────────────────────────────────

const TRANSITIONS = {
  booked:      ['confirmed', 'no_show', 'cancelled'],
  confirmed:   ['in_progress', 'no_show', 'cancelled'],
  in_progress: ['done', 'no_show', 'cancelled'],
};

// ─── Conflict check helper ────────────────────────────────────────────────────

async function hasConflict(chairId, scheduledAt, durationMinutes, excludeId = null) {
  const result = await db.query(
    `SELECT id FROM appointments
     WHERE chair_id = $1
       AND status NOT IN ('cancelled','no_show')
       AND ($4::uuid IS NULL OR id != $4)
       AND tstzrange(scheduled_at, scheduled_at + duration_minutes * interval '1 minute')
           && tstzrange($2::timestamptz, $2::timestamptz + $3 * interval '1 minute')
     LIMIT 1`,
    [chairId, scheduledAt, durationMinutes, excludeId]
  );
  return result.rows.length > 0;
}

// ─── GET /slots (public) ──────────────────────────────────────────────────────

router.get('/slots', validate.query(slotsQuerySchema), async (req, res, next) => {
  try {
    const { date, service_id, chair_id } = req.query;

    // Use clinic_id from token if authenticated; otherwise null (public endpoint)
    let clinicId = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        clinicId = decoded.clinic_id;
      } catch { /* public access — no clinic filter */ }
    }
    if (!clinicId) clinicId = process.env.DEFAULT_CLINIC_ID || null;

    const slots = await generateSlots({ date, serviceId: service_id, chairId: chair_id, clinicId });
    res.json({ slots });
  } catch (err) {
    next(err);
  }
});

// ─── GET /stream — SSE push for schedule screen ───────────────────────────────

router.get('/stream', (req, res) => {
  // EventSource cannot send custom headers, so accept token via ?token= query param.
  const jwt    = require('jsonwebtoken');
  const raw    = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : req.query.token;

  if (!raw) return res.status(401).json({ error: 'Missing token' });

  let user;
  try {
    user = jwt.verify(raw, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clinicId = user.clinic_id;

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onNew     = d => { if (d.clinic_id === clinicId) send('appointment:new',     d.appointment); };
  const onUpdated = d => { if (d.clinic_id === clinicId) send('appointment:updated', d.appointment); };

  bus.on('appointment:new',     onNew);
  bus.on('appointment:updated', onUpdated);

  // Keep-alive comment every 25 s (proxies drop idle SSE connections after 30 s)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    bus.off('appointment:new',     onNew);
    bus.off('appointment:updated', onUpdated);
    clearInterval(ping);
  });
});

// ─── GET / (authenticated) ────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { date, chair_id, status, limit = 100 } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });

    // Use explicit IST range so PostgreSQL can use the (clinic_id, scheduled_at) index.
    // Casting the column side (scheduled_at::date) kills index seeks.
    const result = await db.query(
      `SELECT
         a.*,
         p.name    AS patient_name,
         p.phone   AS patient_phone,
         s.name    AS service_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN services s ON s.id = a.service_id
       WHERE a.clinic_id = $1
         AND a.scheduled_at >= ($2::date)::timestamptz AT TIME ZONE 'Asia/Kolkata'
         AND a.scheduled_at <  ($2::date + 1)::timestamptz AT TIME ZONE 'Asia/Kolkata'
         AND ($3::uuid IS NULL OR a.chair_id = $3)
         AND ($4::text IS NULL OR a.status = $4)
       ORDER BY a.scheduled_at ASC
       LIMIT $5`,
      [req.user.clinic_id, date, chair_id || null, status || null, Number(limit) || 100]
    );
    res.json({ appointments: result.rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST / (public — no auth required) ──────────────────────────────────────

router.post('/', validate(bookingSchema), async (req, res, next) => {
  try {
    const { service_id, chair_id, scheduled_at, booking_source, notes, intake_data = {}, patient } = req.body;

    // Resolve clinic_id
    let clinicId = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        clinicId = decoded.clinic_id;
      } catch { /* fall through to DEFAULT_CLINIC_ID */ }
    }
    if (!clinicId) clinicId = process.env.DEFAULT_CLINIC_ID;
    if (!clinicId) return res.status(400).json({ error: 'Cannot determine clinic' });

    // Validate service belongs to clinic and is active
    const svcResult = await db.query(
      `SELECT id, duration_minutes FROM services WHERE id = $1 AND clinic_id = $2 AND is_active = true`,
      [service_id, clinicId]
    );
    if (!svcResult.rows.length) return res.status(404).json({ error: 'Service not found or inactive' });
    const { duration_minutes } = svcResult.rows[0];

    // Validate chair belongs to clinic and is active
    const chairResult = await db.query(
      `SELECT id FROM chairs WHERE id = $1 AND clinic_id = $2 AND is_active = true`,
      [chair_id, clinicId]
    );
    if (!chairResult.rows.length) return res.status(404).json({ error: 'Chair not found or inactive' });

    // Conflict check
    if (await hasConflict(chair_id, scheduled_at, duration_minutes)) {
      return res.status(409).json({ error: 'This slot is no longer available. Please pick another time.' });
    }

    // Look up or create patient
    let patientId;
    const existingPat = await db.query(
      `SELECT id FROM patients WHERE clinic_id=$1 AND phone=$2 LIMIT 1`,
      [clinicId, patient.phone]
    );
    if (existingPat.rows.length) {
      patientId = existingPat.rows[0].id;
    } else {
      const newPat = await db.query(
        `INSERT INTO patients (clinic_id, name, phone, email) VALUES ($1,$2,$3,$4) RETURNING id`,
        [clinicId, patient.name, patient.phone, patient.email || null]
      );
      patientId = newPat.rows[0].id;
    }

    // Prevent same patient from booking an overlapping slot (unless prior booking is cancelled/no_show)
    const patientConflict = await db.query(
      `SELECT id FROM appointments
       WHERE patient_id = $1
         AND status NOT IN ('cancelled','no_show')
         AND tstzrange(scheduled_at, scheduled_at + duration_minutes * interval '1 minute')
             && tstzrange($2::timestamptz, $2::timestamptz + $3 * interval '1 minute')
       LIMIT 1`,
      [patientId, scheduled_at, duration_minutes]
    );
    if (patientConflict.rows.length) {
      return res.status(409).json({ error: 'You already have an appointment booked at this time. Please cancel it first or choose a different slot.' });
    }

    // Create appointment
    const apptResult = await db.query(
      `INSERT INTO appointments
         (clinic_id, patient_id, service_id, chair_id, scheduled_at, duration_minutes, booking_source, notes, intake_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [clinicId, patientId, service_id, chair_id, scheduled_at, duration_minutes, booking_source, notes || null, JSON.stringify(intake_data)]
    );

    const appt = apptResult.rows[0];
    const appointmentPayload = {
      id:               appt.id,
      patient_id:       appt.patient_id,
      patient_name:     patient.name,
      patient_phone:    patient.phone,
      service_id:       appt.service_id,
      service_name:     svcResult.rows[0].name,
      chair_id:         appt.chair_id,
      scheduled_at:     appt.scheduled_at,
      duration_minutes: appt.duration_minutes,
      status:           appt.status,
      booking_source:   appt.booking_source,
      notes:            appt.notes,
    };

    bus.emit('appointment:new', { clinic_id: clinicId, appointment: appointmentPayload });

    res.status(201).json({ appointment: appointmentPayload });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
         a.*,
         p.name    AS patient_name,
         p.phone   AS patient_phone,
         s.name    AS service_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN services s ON s.id = a.service_id
       WHERE a.id = $1 AND a.clinic_id = $2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ appointment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /:id/status ────────────────────────────────────────────────────────

router.patch('/:id/status', authenticate, validate(statusSchema), async (req, res, next) => {
  try {
    const apptResult = await db.query(
      `SELECT * FROM appointments WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!apptResult.rows.length) return res.status(404).json({ error: 'Appointment not found' });

    const appt    = apptResult.rows[0];
    const allowed = TRANSITIONS[appt.status];
    if (!allowed) {
      return res.status(422).json({ error: `Cannot change status of a ${appt.status} appointment` });
    }
    if (!allowed.includes(req.body.status)) {
      return res.status(422).json({
        error: `Invalid status transition from ${appt.status} to ${req.body.status}`,
      });
    }

    const updated = await db.query(
      `UPDATE appointments SET status=$1, updated_at=now() WHERE id=$2 RETURNING *`,
      [req.body.status, appt.id]
    );
    bus.emit('appointment:updated', { clinic_id: req.user.clinic_id, appointment: updated.rows[0] });
    res.json({ appointment: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /:id (reschedule) — admin + receptionist only ─────────────────────

router.patch('/:id', authenticate, authorize('admin', 'receptionist'), validate(rescheduleSchema), async (req, res, next) => {
  try {
    const apptResult = await db.query(
      `SELECT * FROM appointments WHERE id=$1 AND clinic_id=$2`,
      [req.params.id, req.user.clinic_id]
    );
    if (!apptResult.rows.length) return res.status(404).json({ error: 'Appointment not found' });

    const appt = apptResult.rows[0];
    if (!['booked', 'confirmed'].includes(appt.status)) {
      return res.status(422).json({ error: 'Can only reschedule booked or confirmed appointments' });
    }

    const newScheduledAt = req.body.scheduled_at ?? appt.scheduled_at;
    const newChairId     = req.body.chair_id     ?? appt.chair_id;
    const newNotes       = req.body.notes        !== undefined ? req.body.notes : appt.notes;

    const timeChanged  = req.body.scheduled_at !== undefined;
    const chairChanged = req.body.chair_id     !== undefined;

    if (timeChanged || chairChanged) {
      if (await hasConflict(newChairId, newScheduledAt, appt.duration_minutes, appt.id)) {
        return res.status(409).json({ error: 'This slot is no longer available. Please pick another time.' });
      }
    }

    const updated = await db.query(
      `UPDATE appointments SET scheduled_at=$1, chair_id=$2, notes=$3, updated_at=now()
       WHERE id=$4 RETURNING *`,
      [newScheduledAt, newChairId, newNotes, appt.id]
    );
    bus.emit('appointment:updated', { clinic_id: req.user.clinic_id, appointment: updated.rows[0] });
    res.json({ appointment: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
