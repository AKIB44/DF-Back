/**
 * Prescriptions (Rx) API tests
 * POST /v1/rx/prescriptions
 * GET  /v1/rx/prescriptions/:id
 * GET  /v1/rx/prescriptions/:id/pdf
 * POST /v1/rx/prescriptions/:id/generate
 * GET  /v1/rx/prescriptions?patient_id=
 */

const { api } = require('./helpers');

describe('Prescriptions — /v1/rx', () => {

  let prescriptionId;
  let patientId;
  let medicineId;

  beforeAll(async () => {
    // Fetch a patient and a medicine to use
    const [patRes, medRes] = await Promise.all([
      api.get('/v1/patients?limit=1'),
      api.get('/v1/rx/medicines?limit=1'),
    ]);

    patientId  = (patRes.body?.patients ?? patRes.body?.data ?? [])[0]?.id;
    medicineId = (medRes.body?.medicines ?? medRes.body?.data ?? [])[0]?.id;
  });

  // ── Create prescription ────────────────────────────────────────────────────

  describe('POST /prescriptions', () => {
    it('creates a prescription and returns 201', async () => {
      if (!patientId) { console.warn('No patient — skipping Rx create'); return; }

      const body = {
        patient_id:     patientId,
        diagnosis:      'Test diagnosis from automation',
        clinical_notes: 'Automated test prescription',
        items: medicineId ? [{
          medicine_id:  medicineId,
          dosage:       '1 tablet',
          frequency:    'TID',
          duration:     '5 days',
          quantity:     '15',
          instructions: 'After meals',
        }] : [],
      };

      const res = await api.post('/v1/rx/prescriptions').send(body);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('prescription_no');
      expect(res.body.patient_id ?? res.body.prescription?.patient_id).toBe(patientId);

      prescriptionId = res.body.id ?? res.body.prescription?.id;
    });

    it('returns 400 when diagnosis is missing', async () => {
      if (!patientId) return;
      const res = await api.post('/v1/rx/prescriptions').send({
        patient_id: patientId,
        items: [],
        // missing diagnosis
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Get prescription ───────────────────────────────────────────────────────

  describe('GET /prescriptions/:id', () => {
    it('retrieves the created prescription', async () => {
      if (!prescriptionId) return;
      const res = await api.get(`/v1/rx/prescriptions/${prescriptionId}`);
      expect(res.status).toBe(200);
      const rx = res.body.data ?? res.body;
      expect(rx.id ?? rx.prescription?.id).toBe(prescriptionId);
    });

    it('returns 404 for unknown ID', async () => {
      const res = await api.get('/v1/rx/prescriptions/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  // ── List by patient ────────────────────────────────────────────────────────

  describe('GET /prescriptions?patient_id=', () => {
    it('returns prescriptions for a patient', async () => {
      if (!patientId) return;
      const res = await api.get(`/v1/rx/prescriptions?patient_id=${patientId}`);
      expect(res.status).toBe(200);
      const list = res.body.data ?? res.body.prescriptions ?? [];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ── PDF check (before generate) ───────────────────────────────────────────

  describe('GET /prescriptions/:id/pdf', () => {
    it('returns pdf url (null if not yet generated)', async () => {
      if (!prescriptionId) return;
      const res = await api.get(`/v1/rx/prescriptions/${prescriptionId}/pdf`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('url'); // null or string
    });
  });

  // ── Generate PDF ───────────────────────────────────────────────────────────

  describe('POST /prescriptions/:id/generate', () => {
    it('generates a PDF and returns a URL', async () => {
      if (!prescriptionId) return;
      const res = await api.post(`/v1/rx/prescriptions/${prescriptionId}/generate`).send({});

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('url');
      expect(typeof res.body.url).toBe('string');
      expect(res.body.url.length).toBeGreaterThan(0);
    }, 30000); // PDF generation can take up to 30s
  });

});
