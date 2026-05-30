/**
 * Clinic Services & Chairs — read-only reference data tests
 * GET /v1/services
 * GET /v1/chairs
 * GET /v1/clinic
 */

const { api } = require('./helpers');

describe('Reference data — services, chairs, clinic', () => {

  describe('GET /v1/services', () => {
    it('returns active services list', async () => {
      const res = await api.get('/v1/services');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('services');
      expect(Array.isArray(res.body.services)).toBe(true);
      expect(res.body.services.length).toBeGreaterThan(0);
    });

    it('each service has id, name, price fields', async () => {
      const res = await api.get('/v1/services');
      for (const s of res.body.services.slice(0, 3)) {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('name');
        expect(s).toHaveProperty('price');
        expect(typeof s.price).toBe('number');
      }
    });

    it('returns 401 without auth', async () => {
      const res = await api.anon().get('/v1/services');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/chairs', () => {
    it('returns chairs list', async () => {
      const res = await api.get('/v1/chairs');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('chairs');
      expect(Array.isArray(res.body.chairs)).toBe(true);
      expect(res.body.chairs.length).toBeGreaterThan(0);
    });

    it('each chair has id and name', async () => {
      const res = await api.get('/v1/chairs');
      for (const c of res.body.chairs) {
        expect(c).toHaveProperty('id');
        expect(c).toHaveProperty('name');
      }
    });
  });

  describe('GET /v1/clinic', () => {
    it('returns clinic info', async () => {
      const res = await api.get('/v1/clinic');
      expect(res.status).toBe(200);
      const clinic = res.body.clinic ?? res.body;
      expect(clinic).toHaveProperty('name');
    });
  });

});
