/**
 * Runs once before all test suites.
 * Logs in against the live backend (localhost:3000) and stores the
 * token in process.env so every test file can read it without re-authenticating.
 *
 * Prerequisites: backend must be running  →  npm run dev (or node src/index.js)
 */

const request = require('supertest');

const BASE = 'http://localhost:3000';
global.__BASE__ = BASE;

module.exports = async () => {
  const res = await request(BASE)
    .post('/v1/auth/login')
    .send({ email: 'admin@sharayudental.com', password: 'Password123' });

  if (res.status !== 200) {
    throw new Error(
      `Global setup login failed (${res.status}): ${JSON.stringify(res.body)}\n` +
      `→ Is the backend running on :3000?  Run: cd back && npm run dev\n` +
      `→ Does seed data exist?  Run: npm run seed`
    );
  }

  process.env.TEST_ACCESS_TOKEN  = res.body.accessToken;
  process.env.TEST_REFRESH_TOKEN = res.body.refreshToken ?? '';
  process.env.TEST_USER_ID       = res.body.user?.id ?? '';
  process.env.TEST_CLINIC_ID     = res.body.user?.clinic_id ?? '';

  console.log(`\n✔ Global setup: authenticated as admin@sharayudental.com  (clinic: ${process.env.TEST_CLINIC_ID})\n`);
};
