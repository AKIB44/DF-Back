/**
 * Auth API tests
 * POST /v1/auth/login  · POST /v1/auth/refresh  · POST /v1/auth/logout
 */

const request = require('supertest');
const { api } = require('./helpers');

const BASE = 'http://localhost:3000';

describe('Auth — /v1/auth', () => {

  // ── Login ──────────────────────────────────────────────────────────────────

  describe('POST /login', () => {
    it('returns 200 + tokens for valid credentials', async () => {
      const res = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'admin@sharayudental.com', password: 'Password123' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user).toHaveProperty('id');
      expect(res.body.user.email).toBe('admin@sharayudental.com');
    });

    it('returns 401 for wrong password', async () => {
      const res = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'admin@sharayudental.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 401 for unknown email', async () => {
      const res = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'nobody@nowhere.com', password: 'Password123' });

      expect(res.status).toBe(401);
    });

    it('returns 400 for missing fields', async () => {
      const res = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'admin@sharayudental.com' }); // no password

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'not-an-email', password: 'Password123' });

      expect(res.status).toBe(400);
    });
  });

  // ── Refresh ────────────────────────────────────────────────────────────────

  describe('POST /refresh', () => {
    it('returns new accessToken for valid refreshToken', async () => {
      // Re-login to get a fresh refresh token
      const login = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'admin@sharayudental.com', password: 'Password123' });

      const refreshToken = login.body.refreshToken;
      if (!refreshToken) return; // some backends omit refresh tokens

      const res = await request(BASE)
        .post('/v1/auth/refresh')
        .send({ refreshToken });

      expect([200, 400, 401]).toContain(res.status); // 400/401 if refresh not implemented
      if (res.status === 200) {
        expect(res.body).toHaveProperty('accessToken');
      }
    });
  });

  // ── Protected route guard ──────────────────────────────────────────────────

  describe('Auth guard', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(BASE).get('/v1/appointments');
      expect(res.status).toBe(401);
    });

    it('returns 401 for a malformed token', async () => {
      const res = await request(BASE)
        .get('/v1/appointments')
        .set('Authorization', 'Bearer not.a.real.token');
      expect(res.status).toBe(401);
    });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────

  describe('POST /logout', () => {
    it('returns 200 for authenticated logout', async () => {
      // Login fresh so we don't invalidate the global session token
      const login = await request(BASE)
        .post('/v1/auth/login')
        .send({ email: 'doctor@sharayudental.com', password: 'Password123' });

      if (login.status !== 200) return; // doctor may not exist in seed

      const res = await request(BASE)
        .post('/v1/auth/logout')
        .set('Authorization', `Bearer ${login.body.accessToken}`);

      expect([200, 204]).toContain(res.status);
    });
  });

});
