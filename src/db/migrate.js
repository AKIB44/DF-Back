const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

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

async function getTableOwner(client, tableName) {
  const { rows } = await client.query(
    `SELECT pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1`,
    [tableName]
  );
  return rows[0]?.owner || null;
}

async function isTableOwner(client, tableName) {
  const { rows } = await client.query(
    `SELECT (
       pg_get_userbyid(c.relowner) = CURRENT_USER
       OR COALESCE(
         (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = CURRENT_USER),
         false
       )
     ) AS ok
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1`,
    [tableName]
  );
  return rows[0]?.ok === true;
}

/** Detects booking_source check allowing 'internal' (works across PG check_clause formats). */
async function bookingSourceAllowsInternal(client) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'appointments'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%booking_source%'
       AND pg_get_constraintdef(c.oid) ILIKE '%internal%'`
  );
  return rows.length > 0;
}

function isOwnershipError(err) {
  const code = err.code || err.cause?.code;
  const msg = `${err.message || ''} ${err.cause?.message || ''}`.toLowerCase();
  return code === '42501' || msg.includes('must be owner') || msg.includes('permission denied');
}

const OWNER_REQUIRED = {
  '012_activity_log_details.sql': 'activity_log',
  '013_add_internal_booking_source.sql': 'appointments',
  '014_users_phone.sql': 'users',
  '015_patients_age_clinical_history.sql': 'patients',
};

async function assertCanRunMigration(client, file) {
  const table = OWNER_REQUIRED[file];
  if (!table || (await isTableOwner(client, table))) {
    return;
  }

  const owner = await getTableOwner(client, table);
  const { rows } = await client.query('SELECT CURRENT_USER AS user');
  const user = rows[0].user;

  let hint =
    `As database owner (${owner || 'postgres'}), run:\n` +
    `  ALTER TABLE ${table} OWNER TO ${user};\n` +
    `Then restart the app, or run: npm run migrate`;

  if (file === '013_add_internal_booking_source.sql') {
    hint +=
      `\nAlternatively, apply once as ${owner || 'postgres'}:\n` +
      `  psql ... -f migrations/013_add_internal_booking_source.sql`;
  }

  throw new Error(`Migration ${file} requires ownership of table "${table}" (owner: ${owner}).\n${hint}`);
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
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema='public' AND table_name='prescriptions'
         AND constraint_name='prescriptions_appointment_id_key'`
    );
    return rows.length === 0;
  }
  if (file === '007_appointments_indexes.sql') {
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
  if (file === '012_activity_log_details.sql') {
    return columnExists(client, 'activity_log', 'details');
  }
  if (file === '013_add_internal_booking_source.sql') {
    return bookingSourceAllowsInternal(client);
  }
  if (file === '014_users_phone.sql') {
    return columnExists(client, 'users', 'phone');
  }
  if (file === '015_patients_age_clinical_history.sql') {
    return columnExists(client, 'patients', 'age');
  }
  return false;
}

function listMigrationFiles() {
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return { migrationsDir, migrationFiles: [] };
  }
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  return { migrationsDir, migrationFiles };
}

/**
 * Apply pending SQL migrations. Does not close the pool.
 * @param {{ log?: (msg: string) => void }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[], total: number }>}
 */
async function runMigrations(options = {}) {
  const log = options.log || (() => {});
  const { migrationsDir, migrationFiles } = listMigrationFiles();

  if (migrationFiles.length === 0) {
    log('No migration files found');
    return { applied: [], skipped: [], total: 0 };
  }

  const applied = [];
  const skipped = [];
  const client = await pool.connect();

  try {
    for (const file of migrationFiles) {
      if (await isAlreadyApplied(client, file)) {
        skipped.push(file);
        log(`Migration skipped: ${file}`);
        continue;
      }

      await assertCanRunMigration(client, file);

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        applied.push(file);
        log(`Migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');

        if (file === '013_add_internal_booking_source.sql' && isOwnershipError(err)) {
          if (await bookingSourceAllowsInternal(client)) {
            skipped.push(file);
            log(`Migration skipped: ${file} (constraint already allows internal)`);
            continue;
          }
          await assertCanRunMigration(client, file);
        }

        throw Object.assign(
          new Error(`Migration ${file} failed: ${err.message}`),
          { cause: err }
        );
      }
    }
  } finally {
    client.release();
  }

  return { applied, skipped, total: migrationFiles.length };
}

module.exports = { runMigrations, listMigrationFiles };
