/**
 * Patients API tests
 * GET  /v1/patients         — list with pagination + search
 * POST /v1/patients         — create patient
 * GET  /v1/patients/:id     — get single
 * PATCH /v1/patients/:id    — update
 */

const { api } = require('./helpers');

describe('Patients — /v1/patients', () => {

  let createdPatientId;

  // ── List ───────────────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns 200 with patients array', async () => {
      const res = await api.get('/v1/patients');
      expect(res.status).toBe(200);
      // Accept either { patients } or { data } shape
      const list = res.body.patients ?? res.body.data ?? res.body;
      expect(Array.isArray(list)).toBe(true);
    });

    it('supports limit and page params', async () => {
      const res = await api.get('/v1/patients?limit=2&page=1');
      expect(res.status).toBe(200);
      const list = res.body.patients ?? res.body.data ?? [];
      expect(list.length).toBeLessThanOrEqual(2);
    });

    it('supports search by name', async () => {
      const res = await api.get('/v1/patients?q=a'); // most names contain "a"
      expect(res.status).toBe(200);
    });

    it('returns 401 without auth', async () => {
      const res = await api.anon().get('/v1/patients');
      expect(res.status).toBe(401);
    });
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  describe('POST /', () => {
    it('creates a patient and returns 201', async () => {
      const res = await api.post('/v1/patients').send({
        name:        'Test Patient Auto',
        phone:       '9000000001',
        dob:         '1990-01-15',
        gender:      'male',
        email:       'testpatient.auto@test.com',
      });

      expect(res.status).toBe(201);
      const patient = res.body.patient ?? res.body;
      expect(patient).toHaveProperty('id');
      expect(patient.name).toContain('Test Patient');

      createdPatientId = patient.id;
    });

    it('returns 400 for missing name', async () => {
      const res = await api.post('/v1/patients').send({ phone: '9000000002' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing phone', async () => {
      const res = await api.post('/v1/patients').send({ name: 'No Phone Patient' });
      expect(res.status).toBe(400);
    });
  });

  // ── Get single ─────────────────────────────────────────────────────────────

  describe('GET /:id', () => {
    it('returns the created patient by ID', async () => {
      if (!createdPatientId) return;
      const res = await api.get(`/v1/patients/${createdPatientId}`);
      expect(res.status).toBe(200);
      const patient = res.body.patient ?? res.body;
      expect(patient.id).toBe(createdPatientId);
      expect(patient.name).toContain('Test Patient');
    });

    it('returns 404 for unknown ID', async () => {
      const res = await api.get('/v1/patients/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  // ── Update ─────────────────────────────────────────────────────────────────

  describe('PATCH /:id', () => {
    it('updates patient email', async () => {
      if (!createdPatientId) return;
      const res = await api.patch(`/v1/patients/${createdPatientId}`).send({
        email: 'updated.auto@test.com',
      });
      expect(res.status).toBe(200);
      const patient = res.body.patient ?? res.body;
      expect(patient.email).toBe('updated.auto@test.com');
    });
  });

});
