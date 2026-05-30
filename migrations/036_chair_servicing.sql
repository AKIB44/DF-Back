-- Migration 036: Chair servicing management
-- Adds operational status, service interval, and last/next service dates to chairs.
-- Creates chair_service_log for full audit trail.

ALTER TABLE chairs
  ADD COLUMN IF NOT EXISTS operational_status    TEXT    NOT NULL DEFAULT 'operational'
    CHECK (operational_status IN ('operational','under_service','out_of_order')),
  ADD COLUMN IF NOT EXISTS service_interval_days INTEGER NOT NULL DEFAULT 180,
  ADD COLUMN IF NOT EXISTS last_serviced_at      DATE,
  ADD COLUMN IF NOT EXISTS next_service_due      DATE;

CREATE TABLE IF NOT EXISTS chair_service_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chair_id      UUID        NOT NULL REFERENCES chairs(id) ON DELETE CASCADE,
  clinic_id     UUID        NOT NULL REFERENCES clinics(id),
  service_type  TEXT        NOT NULL,
  serviced_at   DATE        NOT NULL DEFAULT CURRENT_DATE,
  serviced_by   TEXT,
  notes         TEXT,
  cost          NUMERIC(10, 2),
  next_due_date DATE,
  created_by    UUID        REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_log_chair  ON chair_service_log(chair_id,   serviced_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_log_clinic ON chair_service_log(clinic_id,  serviced_at DESC);
