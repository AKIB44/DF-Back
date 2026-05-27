-- Run ONCE as PostgreSQL superuser to permanently fix app user permissions.
-- After this, no manual grants are needed for any future migrations.
--
--   psql "postgresql://postgres:<pass>@<host>:5432/dentaflow" \
--        -f scripts/admin-grant-app-ownership.sql

-- ── 1. Schema-level: allow app user to create tables forever ──────────────────
GRANT USAGE, CREATE ON SCHEMA public TO dentaflow_app;

-- ── 2. Transfer ownership of all existing tables to the app user ──────────────
-- This means app user can ALTER/DROP its own tables and add FK constraints.
ALTER TABLE IF EXISTS clinics             OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS users               OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS services            OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS chairs              OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS patients            OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS appointments        OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS refresh_tokens      OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS organizations       OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS permissions         OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS roles               OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS role_permissions    OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS user_roles          OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS permission_overrides OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS rbac_audit_log      OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS break_glass_sessions OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS activity_log        OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS rx_sequence         OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS rx_medicines        OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS rx_procedures       OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS rx_service_defaults OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS prescriptions       OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS rx_line_items       OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS release_notes       OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS user_release_acks   OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS clinical_session    OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS clinical_note       OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS service_performed   OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS examination         OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS diagnosis           OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS tooth_chart_snapshot  OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS treatment_plan        OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS treatment_plan_item   OWNER TO dentaflow_app;

-- Transfer sequence ownership too
ALTER SEQUENCE IF EXISTS rx_sequence_seq OWNER TO dentaflow_app;

-- ── 3. Default privileges — any future object created by postgres or any other
--       superuser is automatically accessible to dentaflow_app.
--       This is the permanent fix: no grant needed for future migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO dentaflow_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO dentaflow_app;

-- ── 4. Migration 013: booking_source constraint (idempotent) ──────────────────
ALTER TABLE IF EXISTS appointments
  DROP CONSTRAINT IF EXISTS appointments_booking_source_check;
ALTER TABLE IF EXISTS appointments
  ADD CONSTRAINT appointments_booking_source_check
  CHECK (booking_source IN ('website','whatsapp','direct','staff','internal'));
