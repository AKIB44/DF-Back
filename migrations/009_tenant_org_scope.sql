-- ─── 009: Add org_id to domain tables + seed default org ─────────────────────
-- Creates one default organization, links all existing clinics to it,
-- assigns org_id on users, and backfills domain tables.

-- ── Create default organization (idempotent) ──────────────────────────────────
INSERT INTO organizations (id, name, slug, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'DentaFlow Default Org',
  'dentaflow-default',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- ── Link existing clinics to default org ──────────────────────────────────────
UPDATE clinics
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

-- ── Link existing users to default org ────────────────────────────────────────
UPDATE users
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

-- ── Add org_id to patients ────────────────────────────────────────────────────
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE patients p
SET org_id = c.org_id
FROM clinics c
WHERE p.clinic_id = c.id AND p.org_id IS NULL;

-- ── Add org_id to appointments ────────────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE appointments a
SET org_id = c.org_id
FROM clinics c
WHERE a.clinic_id = c.id AND a.org_id IS NULL;

-- ── Add org_id to prescriptions ───────────────────────────────────────────────
ALTER TABLE prescriptions
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE prescriptions p
SET org_id = c.org_id
FROM clinics c
WHERE p.clinic_id = c.id AND p.org_id IS NULL;

-- ── Add org_id to rx_medicines ────────────────────────────────────────────────
ALTER TABLE rx_medicines
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE rx_medicines m
SET org_id = c.org_id
FROM clinics c
WHERE m.clinic_id = c.id AND m.org_id IS NULL;

-- ── Add org_id to rx_procedures ───────────────────────────────────────────────
ALTER TABLE rx_procedures
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE rx_procedures p
SET org_id = c.org_id
FROM clinics c
WHERE p.clinic_id = c.id AND p.org_id IS NULL;

-- ── Add org_id to rx_service_defaults ─────────────────────────────────────────
ALTER TABLE rx_service_defaults
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

UPDATE rx_service_defaults s
SET org_id = c.org_id
FROM clinics c
WHERE s.clinic_id = c.id AND s.org_id IS NULL;

-- ── Backfill user_roles from existing users.role ──────────────────────────────
-- Map legacy role strings to new system roles
INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by)
SELECT
  u.id AS user_id,
  r.id AS role_id,
  u.clinic_id,
  NULL AS granted_by
FROM users u
JOIN roles r ON r.is_system = true AND r.code = CASE
  WHEN u.role = 'admin'        THEN 'clinic_admin'
  WHEN u.role = 'doctor'       THEN 'doctor'
  WHEN u.role = 'receptionist' THEN 'reception'
  ELSE 'reception'
END
WHERE u.clinic_id IS NOT NULL
ON CONFLICT DO NOTHING;
