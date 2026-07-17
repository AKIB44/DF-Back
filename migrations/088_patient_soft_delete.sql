-- Migration 088: soft-delete for patients.
-- Deleting a patient never removes the row (clinical/billing history must survive);
-- it stamps deleted_at so the patient drops out of search, records and family
-- grouping while staying restorable by an admin.

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- Fast "active patients only" filtering.
CREATE INDEX IF NOT EXISTS idx_patients_active
  ON patients (clinic_id) WHERE deleted_at IS NULL;

-- ── Permission: patient.delete ────────────────────────────────────────────────
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  ('patient.delete', 'patient', 'delete', 'Archive (soft-delete) a patient', 'clinic', true)
ON CONFLICT (code) DO NOTHING;

-- Grant to the roles that already manage patient records. The catalog-wide grant
-- in 008 only ran for permissions that existed then, so a new permission must be
-- granted explicitly here (org_admin included so the UI shows it for them; org
-- admins also bypass permission checks server-side).
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'patient.delete', 'clinic'
FROM roles r
WHERE r.code IN ('clinic_admin', 'doctor', 'reception', 'org_admin')
ON CONFLICT DO NOTHING;
