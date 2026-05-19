/**
 * Provision a new database: sync from old DB and/or seed demo + Rx master data.
 *
 * From old production/staging copy:
 *   SOURCE_DATABASE_URL=postgresql://...old... \
 *   DATABASE_URL=postgresql://...new... \
 *   npm run db:provision -- --yes
 *
 * Fresh empty DB (demo users + services):
 *   DATABASE_URL=postgresql://...new... \
 *   npm run db:provision
 */
require('dotenv').config();
const { pool } = require('../src/db');
const { runSync } = require('./sync-from-source');
const { seed } = require('../seeds/seed');
const { run: seedRx } = require('../seeds/rxMasterSeed');

async function count(pool, sql) {
  const { rows } = await pool.query(sql);
  return Number(rows[0].n);
}

async function backfillUserRoles() {
  const { rowCount } = await pool.query(
    `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by)
     SELECT u.id, r.id, u.clinic_id, NULL
     FROM users u
     JOIN roles r ON r.is_system = true AND r.code = CASE
       WHEN u.role = 'admin'        THEN 'clinic_admin'
       WHEN u.role = 'doctor'       THEN 'doctor'
       WHEN u.role = 'receptionist' THEN 'reception'
       ELSE 'reception'
     END
     WHERE u.clinic_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = u.id AND ur.clinic_id = u.clinic_id
       )`
  );
  return rowCount || 0;
}

async function main() {
  const yes = process.argv.includes('--yes');
  const skipCatalog = process.argv.includes('--skip-catalog');

  if (process.env.SOURCE_DATABASE_URL) {
    console.log('[provision] Copying data from SOURCE_DATABASE_URL → DATABASE_URL');
    await runSync({ yes, skipCatalog });
  } else {
    const clinics = await count(pool, 'SELECT COUNT(*)::int AS n FROM clinics');
    if (clinics === 0) {
      console.log('[provision] No clinics — running base seed (users, services, chairs)');
      await seed();
    } else {
      console.log(`[provision] ${clinics} clinic(s) present — skipping base seed`);
    }
  }

  const rolesAdded = await backfillUserRoles();
  if (rolesAdded) {
    console.log(`[provision] Linked ${rolesAdded} user(s) to RBAC roles`);
  }

  const rxRows = await count(pool, 'SELECT COUNT(*)::int AS n FROM rx_medicines');
  if (rxRows === 0) {
    console.log('[provision] No Rx master data — running seed:rx');
    await seedRx();
  } else {
    console.log(`[provision] Rx master data present (${rxRows} medicines) — skipping seed:rx`);
  }

  const users = await count(pool, 'SELECT COUNT(*)::int AS n FROM users');
  const patients = await count(pool, 'SELECT COUNT(*)::int AS n FROM patients');
  console.log(`[provision] Done — users: ${users}, patients: ${patients}`);
}

main()
  .catch((err) => {
    console.error('[provision] Failed:', err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
