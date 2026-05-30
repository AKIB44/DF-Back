/**
 * Appointments API tests
 * GET  /v1/appointments          — list / filter
 * POST /v1/appointments          — create booking
 * GET  /v1/appointments/:id      — get single
 * PATCH /v1/appointments/:id/status — status transition
 * GET  /v1/appointments/slots    — available slots
 */

const { api, tomorrowSlot, todayIso } = require('./helpers');

describe('Appointments — /v1/appointments', () => {

  let createdId;       // appointment created in POST test, reused below
  let serviceId;       // fetched from /v1/services
  let chairId;         // fetched from /v1/chairs
  let patientId;       // fetched from /v1/patients

  // ── Fetch prerequisite IDs ─────────────────────────────────────────────────
  beforeAll(async () => {
    const [svcRes, chairRes, patRes] = await Promise.all([
      api.get('/v1/services'),
      api.get('/v1/chairs'),
      api.get('/v1/patients?limit=1'),
    ]);

    serviceId = svcRes.body?.services?.[0]?.id;
    chairId   = chairRes.body?.chairs?.[0]?.id;
    patientId = patRes.body?.patients?.[0]?.id ?? patRes.body?.data?.[0]?.id;
  });

  // ── List ───────────────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns 200 with appointments array', async () => {
      const res = await api.get(`/v1/appointments?date=${todayIso()}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('appointments');
      expect(Array.isArray(res.body.appointments)).toBe(true);
    });

    it('filters by date correctly', async () => {
      const date = todayIso();
      const res  = await api.get(`/v1/appointments?date=${date}`);
      expect(res.status).toBe(200);
      for (const a of res.body.appointments) {
        expect(a.scheduled_at).toContain(date);
      }
    });

    it('returns 401 without a token', async () => {
      const res = await api.anon().get('/v1/appointments');
      expect(res.status).toBe(401);
    });
  });

  // ── Slots ──────────────────────────────────────────────────────────────────

  describe('GET /slots', () => {
    it('returns available slots for a given date + service', async () => {
      if (!serviceId || !chairId) return;
      const date = tomorrowSlot().slice(0, 10);
      const res  = await api.anon().get(
        `/v1/appointments/slots?date=${date}&service_id=${serviceId}&chair_id=${chairId}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('slots');
      expect(Array.isArray(res.body.slots)).toBe(true);
    });
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  describe('POST /', () => {
    it('creates a booking and returns 201', async () => {
      if (!serviceId || !chairId || !patientId) {
        console.warn('Skipping create — missing prerequisite IDs');
        return;
      }

      const res = await api.post('/v1/appointments').send({
        patient_id:      patientId,
        service_id:      serviceId,
        chair_id:        chairId,
        scheduled_at:    tomorrowSlot(),
        duration_minutes: 30,
        booking_source:  'direct',
        notes:           'Created by automated test',
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('appointment');
      expect(res.body.appointment).toHaveProperty('id');
      expect(res.body.appointment.status).toBe('booked');

      createdId = res.body.appointment.id;
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await api.post('/v1/appointments').send({
        patient_id: patientId,
        // missing service_id, chair_id, scheduled_at
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Get single ─────────────────────────────────────────────────────────────

  describe('GET /:id', () => {
    it('returns the appointment by ID', async () => {
      if (!createdId) return;
      const res = await api.get(`/v1/appointments/${createdId}`);
      expect(res.status).toBe(200);
      expect(res.body.appointment?.id ?? res.body?.id).toBe(createdId);
    });

    it('returns 404 for non-existent ID', async () => {
      const res = await api.get('/v1/appointments/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  // ── Status transition ──────────────────────────────────────────────────────

  describe('PATCH /:id/status', () => {
    it('transitions booked → confirmed', async () => {
      if (!createdId) return;
      const res = await api.patch(`/v1/appointments/${createdId}/status`).send({ status: 'confirmed' });
      expect(res.status).toBe(200);
      const appt = res.body.appointment ?? res.body;
      expect(appt.status).toBe('confirmed');
    });

    it('transitions confirmed → in_progress', async () => {
      if (!createdId) return;
      const res = await api.patch(`/v1/appointments/${createdId}/status`).send({ status: 'in_progress' });
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid status value', async () => {
      if (!createdId) return;
      const res = await api.patch(`/v1/appointments/${createdId}/status`).send({ status: 'flying' });
      expect(res.status).toBe(400);
    });

    it('cancels the test appointment (cleanup)', async () => {
      if (!createdId) return;
      const res = await api.patch(`/v1/appointments/${createdId}/status`).send({
        status: 'cancelled',
        cancel_reason: 'Test cleanup',
      });
      expect([200, 409]).toContain(res.status); // 409 if already in_progress (session started)
    });
  });

});
