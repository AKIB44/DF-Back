-- Composite index that covers the schedule-screen query pattern:
-- clinic_id + scheduled_at range + optional status/chair filters.
-- Replaces the narrower idx_appts_clinic_date.
CREATE INDEX IF NOT EXISTS idx_appts_clinic_scheduled_status
  ON appointments(clinic_id, scheduled_at, status);

CREATE INDEX IF NOT EXISTS idx_appts_clinic_chair_scheduled
  ON appointments(clinic_id, chair_id, scheduled_at);
