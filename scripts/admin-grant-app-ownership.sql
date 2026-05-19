-- Run once as PostgreSQL superuser or the current table owner (usually postgres).
-- Set the role name to match DATABASE_URL user (default: dentaflow_app).
--
--   psql "postgresql://postgres:...@host:5432/dentaflow" -f scripts/admin-grant-app-ownership.sql

ALTER TABLE IF EXISTS appointments OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS activity_log OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS users OWNER TO dentaflow_app;
ALTER TABLE IF EXISTS patients OWNER TO dentaflow_app;

-- Migration 013: allow booking_source = 'internal' (skip if already applied)
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_booking_source_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_booking_source_check
  CHECK (booking_source IN ('website','whatsapp','direct','staff','internal'));
