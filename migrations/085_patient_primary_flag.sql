-- Family grouping by phone: one PRIMARY patient per (clinic, phone), others
-- SECONDARY (e.g. parent = primary, children = secondary sharing the number).

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill: within each (clinic_id, phone) group, keep the earliest-created
-- record as primary and demote the rest to secondary.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY clinic_id, phone ORDER BY created_at ASC, id ASC) AS rn
    FROM patients
)
UPDATE patients p
   SET is_primary = (r.rn = 1)
  FROM ranked r
 WHERE r.id = p.id;

CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone_primary
  ON patients(clinic_id, phone, is_primary);
