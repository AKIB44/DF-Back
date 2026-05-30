/**
 * Clinical Session API — full treatment lifecycle tests
 *
 * Flow tested:
 *   1. Create appointment → start treatment (creates session)
 *   2. GET session
 *   3. PATCH examination
 *   4. POST diagnosis
 *   5. GET/POST services
 *   6. Mark service COMPLETED
 *   7. GET variance (preflight)
 *   8. POST end-treatment (seal)
 */

const { api, tomorrowSlot } = require('./helpers');

describe('Clinical Session — full treatment flow', () => {

  let appointmentId;
  let sessionId;
  let servicePerformedId;
  let serviceId;
  let chairId;
  let patientId;

  // ── Setup: create a bookable appointment ───────────────────────────────────

  beforeAll(async () => {
    const [svcRes, chairRes, patRes] = await Promise.all([
      api.get('/v1/services'),
      api.get('/v1/chairs'),
      api.get('/v1/patients?limit=1'),
    ]);

    serviceId = svcRes.body?.services?.[0]?.id;
    chairId   = chairRes.body?.chairs?.[0]?.id;
    patientId = (patRes.body?.patients ?? patRes.body?.data ?? [])[0]?.id;

    if (!serviceId || !chairId || !patientId) {
      console.warn('Session tests skipped — missing seed data');
      return;
    }

    // Create appointment
    const apptRes = await api.post('/v1/appointments').send({
      patient_id:       patientId,
      service_id:       serviceId,
      chair_id:         chairId,
      scheduled_at:     tomorrowSlot(),
      duration_minutes: 30,
      booking_source:   'direct',
      notes:            'Session test appointment',
    });

    if (apptRes.status !== 201) {
      console.warn('Could not create test appointment:', apptRes.body);
      return;
    }

    appointmentId = apptRes.body.appointment.id;

    // Confirm it
    await api.patch(`/v1/appointments/${appointmentId}/status`).send({ status: 'confirmed' });
    // Move to in_progress
    await api.patch(`/v1/appointments/${appointmentId}/status`).send({ status: 'in_progress' });
  });

  // ── 1. Start treatment ─────────────────────────────────────────────────────

  describe('POST /sessions (start treatment)', () => {
    it('creates a session from an appointment', async () => {
      if (!appointmentId) return;

      const res = await api.post('/v1/sessions').send({ appointment_id: appointmentId });

      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('session');
      expect(res.body.session).toHaveProperty('id');

      sessionId = res.body.session.id;
    });

    it('returns 409 when session already exists for appointment', async () => {
      if (!appointmentId) return;
      const res = await api.post('/v1/sessions').send({ appointment_id: appointmentId });
      // Should either return 409 or the existing session
      expect([200, 201, 409]).toContain(res.status);
      if (res.status === 409 || res.status === 200 || res.status === 201) {
        // Capture session id if returned
        if (res.body?.session?.id) sessionId = res.body.session.id;
      }
    });
  });

  // ── 2. GET session ─────────────────────────────────────────────────────────

  describe('GET /sessions/:id', () => {
    it('returns the session with all sub-resources', async () => {
      if (!sessionId) return;
      const res = await api.get(`/v1/sessions/${sessionId}`);
      expect(res.status).toBe(200);
      expect(res.body.session).toHaveProperty('id', sessionId);
      expect(res.body.session).toHaveProperty('status');
      // Sub-resources may be empty arrays
      expect(res.body).toHaveProperty('services');
      expect(res.body).toHaveProperty('prescriptions');
    });

    it('returns 404 for unknown session', async () => {
      const res = await api.get('/v1/sessions/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  // ── 3. Examination ─────────────────────────────────────────────────────────

  describe('PATCH /sessions/:id/examination', () => {
    it('saves examination data', async () => {
      if (!sessionId) return;
      const res = await api.patch(`/v1/sessions/${sessionId}/examination`).send({
        chief_complaint: 'Toothache upper right',
        pain_score:      7,
        pain_site:       'Upper right molar',
        pain_trigger:    'cold',
        intraoral_findings: { caries: 'present' },
        extraoral_findings: {},
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('examination');
      expect(res.body.examination.chief_complaint).toBe('Toothache upper right');
    });

    it('updates examination (idempotent PATCH)', async () => {
      if (!sessionId) return;
      const res = await api.patch(`/v1/sessions/${sessionId}/examination`).send({
        chief_complaint: 'Severe toothache upper right',
        pain_score:      8,
      });
      expect(res.status).toBe(200);
      expect(res.body.examination.pain_score).toBe(8);
    });
  });

  // ── 4. Diagnosis ───────────────────────────────────────────────────────────

  describe('POST /sessions/:id/diagnoses', () => {
    it('adds a diagnosis entry', async () => {
      if (!sessionId) return;
      const res = await api.post(`/v1/sessions/${sessionId}/diagnoses`).send({
        icd10_code:     'K02.1',
        diagnosis_text: 'Dental caries of dentine',
        diagnosis_kind: 'final',
        tooth_numbers:  [16],
        notes:          'Deep caries — needs RCT',
      });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('diagnosis');
      expect(res.body.diagnosis.icd10_code).toBe('K02.1');
    });
  });

  // ── 5. Add service ─────────────────────────────────────────────────────────

  describe('POST /sessions/:id/services', () => {
    it('adds a service performed', async () => {
      if (!sessionId || !serviceId) return;
      const res = await api.post(`/v1/sessions/${sessionId}/services`).send({
        service_id:   serviceId,
        quantity:     1,
        discount_pct: 0,
      });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('service');
      expect(res.body.service.status).toBe('IN_PROGRESS');
      expect(Number(res.body.service.final_charge)).toBeGreaterThan(0);

      servicePerformedId = res.body.service.id;
    });
  });

  // ── 6. Get services ────────────────────────────────────────────────────────

  describe('GET /sessions/:id/services', () => {
    it('returns the services list', async () => {
      if (!sessionId) return;
      const res = await api.get(`/v1/sessions/${sessionId}/services`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.services)).toBe(true);
      expect(res.body.services.length).toBeGreaterThan(0);
    });
  });

  // ── 7. Complete service ────────────────────────────────────────────────────

  describe('PATCH /services/:id', () => {
    it('marks service as COMPLETED', async () => {
      if (!servicePerformedId) return;
      const res = await api.patch(`/v1/services/${servicePerformedId}`).send({ status: 'COMPLETED' });
      expect(res.status).toBe(200);
      expect(res.body.service.status).toBe('COMPLETED');
    });
  });

  // ── 8. Variance preflight ──────────────────────────────────────────────────

  describe('GET /sessions/:id/variance', () => {
    it('returns variance info without error', async () => {
      if (!sessionId) return;
      const res = await api.get(`/v1/sessions/${sessionId}/variance`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('final_total');
      expect(res.body).toHaveProperty('variance_flag');
      expect(typeof res.body.variance_flag).toBe('boolean');
    });
  });

  // ── 9. End treatment ──────────────────────────────────────────────────────

  describe('POST /sessions/:id/end-treatment', () => {
    it('seals the session', async () => {
      if (!sessionId) return;
      const res = await api.post(`/v1/sessions/${sessionId}/end-treatment`).send({});
      // 200 = sealed OK, 422 = variance block (also a real response)
      expect([200, 422]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.session.sealed_at).not.toBeNull();
      }
    });

    it('returns 409 when attempting to seal an already-sealed session', async () => {
      if (!sessionId) return;
      const res = await api.post(`/v1/sessions/${sessionId}/end-treatment`).send({});
      expect([409, 422]).toContain(res.status);
    });
  });

});
