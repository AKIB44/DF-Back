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
  '016_release_notes.sql': 'users',
  '017_clinical_session.sql': 'appointments',
  '018_service_performed.sql': 'clinical_session',
  '019_examination_diagnosis.sql': 'clinical_session',
  '020_tooth_chart.sql': 'clinical_session',
  '021_treatment_plan.sql': 'patients',
  '022_service_plan_link.sql': 'service_performed',
  '023_prescription_session_link.sql': 'prescriptions',
  '024_session_attachments.sql':       'clinical_session',
  '025_investigation_orders.sql':      'clinical_session',
  '026_lab_orders.sql':                    'service_performed',
  '027_inventory_base.sql':               'clinics',
  '028_material_consumption.sql':         'service_performed',
  '029_surgical_flags_consent.sql':       'services',
  '030_preop_record.sql':                 'clinical_session',
  '031_postop_record.sql':                'clinical_session',
  '032_tpa_preauth.sql':                  'clinical_session',
  '059_session_summary_pdf.sql':          'clinical_session',
  '061_platform_billing.sql':             'clinics',
  '062_clinic_billing_expense.sql':       'clinics',
  '063_patient_file.sql':                 'patients',
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
  if (file === '016_release_notes.sql') {
    hint +=
      `\n(FK to users needs ownership or REFERENCES — run scripts/admin-grant-app-ownership.sql as superuser.)`;
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
  if (file === '016_release_notes.sql') {
    return (
      tableExists(client, 'release_notes') &&
      tableExists(client, 'user_release_acks')
    );
  }
  if (file === '017_clinical_session.sql') {
    return tableExists(client, 'clinical_session');
  }
  if (file === '018_service_performed.sql') {
    return tableExists(client, 'service_performed');
  }
  if (file === '019_examination_diagnosis.sql') {
    return tableExists(client, 'examination');
  }
  if (file === '020_tooth_chart.sql') {
    return tableExists(client, 'tooth_chart_snapshot');
  }
  if (file === '021_treatment_plan.sql') {
    return tableExists(client, 'treatment_plan');
  }
  if (file === '022_service_plan_link.sql') {
    return columnExists(client, 'service_performed', 'plan_item_id');
  }
  if (file === '023_prescription_session_link.sql') {
    return columnExists(client, 'prescriptions', 'session_id');
  }
  if (file === '024_session_attachments.sql') {
    return tableExists(client, 'session_attachments');
  }
  if (file === '025_investigation_orders.sql') {
    return tableExists(client, 'investigation_order');
  }
  if (file === '026_lab_orders.sql') {
    return tableExists(client, 'lab_order');
  }
  if (file === '027_inventory_base.sql') {
    return tableExists(client, 'inventory_item');
  }
  if (file === '028_material_consumption.sql') {
    return tableExists(client, 'material_consumption');
  }
  if (file === '029_surgical_flags_consent.sql') {
    return tableExists(client, 'consent_record');
  }
  if (file === '030_preop_record.sql') {
    return tableExists(client, 'preop_record');
  }
  if (file === '031_postop_record.sql') {
    return tableExists(client, 'postop_record');
  }
  if (file === '032_tpa_preauth.sql') {
    return tableExists(client, 'tpa_preauth');
  }
  if (file === '033_inventory_seed.sql') {
    return columnExists(client, 'inventory_item', 'is_traceable');
  }
  if (file === '034_unit_cost.sql') {
    return columnExists(client, 'inventory_item', 'unit_cost');
  }
  if (file === '035_purchase_orders.sql') {
    return tableExists(client, 'purchase_order');
  }
  if (file === '036_chair_servicing.sql') {
    return tableExists(client, 'chair_service_log');
  }
  if (file === '037_activity_log_headers.sql') {
    return columnExists(client, 'activity_log', 'request_headers');
  }
  if (file === '038_specialty_foundation.sql') {
    return tableExists(client, 'specialty_case');
  }
  if (file === '039_specialty_catalog_extension.sql') {
    return columnExists(client, 'services', 'creates_specialty_case');
  }
  if (file === '040_specialty_attachment_extension.sql') {
    return tableExists(client, 'specialty_photo_series_tag');
  }
  if (file === '041_ortho_foundation.sql') {
    return tableExists(client, 'ortho_case_detail');
  }
  if (file === '042_ortho_phase_seed.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM services WHERE specialty_case_type = 'ORTHO' LIMIT 1`
    );
    return rows.length > 0;
  }
  if (file === '043_implant_foundation.sql') {
    return tableExists(client, 'implant_case_detail');
  }
  if (file === '044_implant_service_seed.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM services WHERE specialty_case_type = 'IMPLANT' LIMIT 1`
    );
    return rows.length > 0;
  }
  if (file === '045_paedo_foundation.sql') {
    return tableExists(client, 'paedo_case_detail');
  }
  if (file === '046_paedo_service_seed.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM services WHERE specialty_case_type = 'PAEDO' LIMIT 1`
    );
    return rows.length > 0;
  }
  if (file === '047_endo_foundation.sql') {
    return tableExists(client, 'endo_case_detail');
  }
  if (file === '048_endo_service_seed.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM services WHERE specialty_case_type = 'ENDO' LIMIT 1`
    );
    return rows.length > 0;
  }
  if (file === '049_tmj_foundation.sql') {
    return tableExists(client, 'tmj_case_detail');
  }
  if (file === '050_tmj_service_seed.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM services WHERE specialty_case_type = 'TMJ' LIMIT 1`
    );
    return rows.length > 0;
  }
  if (file === '051_specialty_permissions.sql') {
    const { rows } = await client.query(
      `SELECT 1 FROM permissions WHERE code = 'specialty.view' LIMIT 1`
    );
    return rows.length > 0;
  }
  if (file === '059_session_summary_pdf.sql') {
    return columnExists(client, 'clinical_session', 'summary_pdf_s3_key');
  }
  if (file === '060_idempotency_keys.sql') {
    return tableExists(client, 'idempotency_keys');
  }
  if (file === '061_platform_billing.sql') {
    return tableExists(client, 'subscription_plan');
  }
  if (file === '062_clinic_billing_expense.sql') {
    return tableExists(client, 'clinic_expense');
  }
  if (file === '063_patient_file.sql') {
    return tableExists(client, 'patient_file');
  }
  if (file === '064_marketing_foundation.sql') {
    return tableExists(client, 'mkt_pipeline_leads');
  }
  if (file === '065_marketing_feedback.sql') {
    return tableExists(client, 'mkt_caller_feedback');
  }
  if (file === '066_marketing_call_logs.sql') {
    return tableExists(client, 'mkt_call_logs');
  }
  if (file === '067_marketing_callbacks.sql') {
    return tableExists(client, 'mkt_callbacks');
  }
  if (file === '068_marketing_enquiries.sql') {
    return tableExists(client, 'mkt_digital_enquiries');
  }
  if (file === '069_marketing_seed.sql') {
    // Demo seed — re-run is harmless (self-guards), but skip once it's in.
    const { rows } = await client.query(
      "SELECT 1 FROM mkt_campaigns WHERE name = 'Summer Whitening Offer' LIMIT 1"
    );
    return rows.length > 0;
  }
  if (file === '070_marketing_scheduled_calls.sql') {
    return tableExists(client, 'mkt_scheduled_calls');
  }
  if (file === '071_marketing_seed_calls.sql') {
    const { rows } = await client.query(
      "SELECT 1 FROM mkt_scheduled_calls WHERE google_event_id = 'stub_demo_today' LIMIT 1"
    );
    return rows.length > 0;
  }
  if (file === '072_marketing_expenses.sql') {
    return tableExists(client, 'mkt_expenses');
  }
  if (file === '073_marketing_seed_expenses.sql') {
    const { rows } = await client.query("SELECT 1 FROM mkt_expenses LIMIT 1");
    return rows.length > 0;
  }
  if (file === '074_marketing_lead_finder.sql') {
    return tableExists(client, 'mkt_scraped_leads');
  }
  if (file === '075_marketing_places_guardrails.sql') {
    return tableExists(client, 'mkt_places_usage');
  }
  if (file === '076_marketing_segments_promo.sql') {
    return tableExists(client, 'mkt_segments');
  }
  if (file === '077_marketing_seed_segments_promo.sql') {
    const { rows } = await client.query("SELECT 1 FROM mkt_segments LIMIT 1");
    return rows.length > 0;
  }
  if (file === '078_marketing_onboarding_pitch.sql') {
    return tableExists(client, 'mkt_onboarding_steps');
  }
  if (file === '079_marketing_seed_onboarding_pitch.sql') {
    const { rows } = await client.query("SELECT 1 FROM mkt_onboarding_steps LIMIT 1");
    return rows.length > 0;
  }
  if (file === '080_gesture_viewer_flag.sql') {
    const { rows } = await client.query("SELECT 1 FROM feature_flags WHERE flag_key = 'gesture_viewer.enabled' LIMIT 1");
    return rows.length > 0;
  }
  if (file === '084_patient_medical_flags.sql') {
    return columnExists(client, 'patients', 'is_smoker');
  }
  if (file === '085_patient_primary_flag.sql') {
    return columnExists(client, 'patients', 'is_primary');
  }
  if (file === '086_service_performed_booked_flag.sql') {
    return columnExists(client, 'service_performed', 'is_booked_service');
  }
  if (file === '087_session_invoice_pdf.sql') {
    return columnExists(client, 'clinical_session', 'invoice_pdf_s3_key');
  }
  if (file === '088_patient_soft_delete.sql') {
    return columnExists(client, 'patients', 'deleted_at');
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
