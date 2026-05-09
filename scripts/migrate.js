require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function isAlreadyApplied(client, file) {
  if (file === '001_init.sql') {
    return tableExists(client, 'clinics');
  }
  if (file === '002_add_intake_data.sql') {
    return columnExists(client, 'appointments', 'intake_data');
  }
  if (file === '003_rx_tables.sql') {
    return tableExists(client, 'prescriptions');
  }
  if (file === '004_rx_clinic_scope.sql') {
    return columnExists(client, 'rx_medicines', 'clinic_id');
  }
  if (file === '005_clinic_logo_doctor_designation.sql') {
    return columnExists(client, 'users', 'designation');
  }
  if (file === '006_allow_multiple_prescriptions_per_appointment.sql') {
    // 006 drops a unique constraint — re-running is safe (DROP CONSTRAINT IF EXISTS)
    // Skip if the constraint is already gone
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema='public' AND table_name='prescriptions'
         AND constraint_name='prescriptions_appointment_id_key'`
    );
    return rows.length === 0; // already gone = already applied
  }
  if (file === '007_appointments_indexes.sql') {
    // 007 only creates indexes — safe to re-run (IF NOT EXISTS), but skip if already done
    const { rows } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_appts_clinic_scheduled_status'`
    );
    return rows.length > 0;
  }
  if (file === '008_rbac_core.sql') {
    return tableExists(client, 'permissions');
  }
  if (file === '009_tenant_org_scope.sql') {
    return columnExists(client, 'patients', 'org_id');
  }
  if (file === '010_drop_uq_rx_appointment_index.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_rx_appointment'`
    );
    return rows.length === 0;
  }
  if (file === '011_activity_log.sql') {
    return columnExists(client, 'activity_log', 'clinic_id');
  }
  return false;
}

async function main() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of migrationFiles) {
      if (await isAlreadyApplied(client, file)) {
        console.log('Migration skipped:', file);
        continue;
      }

      const sqlPath = path.join(migrationsDir, file);
      const sql     = fs.readFileSync(sqlPath, 'utf8');

      // Run each migration atomically — on error the whole migration rolls back,
      // leaving no partial state for the next run to trip over.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log('Migration applied:', file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Migration ${file} failed: ${err.message}`),
          { cause: err }
        );
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
