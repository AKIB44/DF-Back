-- ────────────────────────────────────────────────────────────────────────────
-- ABAC Phase 1: staff attributes + role hierarchy + new roles
-- ────────────────────────────────────────────────────────────────────────────
-- Adds the attribute columns the policy engine needs to evaluate policies
-- without re-querying for staff context on every request. Also seeds the
-- additional roles (manager, hygienist, assistant, patient) referenced by the
-- PRD policy catalog.
--
-- Zero behaviour change on its own — the policy engine that consumes these
-- columns lands in a subsequent migration / code drop.
-- ────────────────────────────────────────────────────────────────────────────

-- ── Role hierarchy ─────────────────────────────────────────────────────────
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS hierarchy_level INT NOT NULL DEFAULT 30;

UPDATE roles SET hierarchy_level = CASE code
  WHEN 'org_admin'    THEN 95
  WHEN 'clinic_admin' THEN 90
  WHEN 'manager'      THEN 80
  WHEN 'doctor'       THEN 60
  WHEN 'hygienist'    THEN 50
  WHEN 'assistant'    THEN 40
  WHEN 'accountant'   THEN 35
  WHEN 'reception'    THEN 30
  WHEN 'lab_tech'     THEN 20
  WHEN 'patient'      THEN 10
  ELSE hierarchy_level
END
WHERE is_system = true;

-- ── New roles (PRD §4.1) ───────────────────────────────────────────────────
INSERT INTO roles (org_id, code, name, is_system, hierarchy_level) VALUES
  (NULL, 'manager',   'Manager',         true, 80),
  (NULL, 'hygienist', 'Dental Hygienist', true, 50),
  (NULL, 'assistant', 'Dental Assistant', true, 40),
  (NULL, 'patient',   'Patient (portal)', true, 10)
ON CONFLICT DO NOTHING;

-- ── Staff ABAC attributes ──────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS specialty_tags   TEXT[]        NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS branch_id        UUID,
  ADD COLUMN IF NOT EXISTS max_discount_pct NUMERIC(5,2)  NOT NULL DEFAULT 10.00,
  ADD COLUMN IF NOT EXISTS shift_start      TIME,
  ADD COLUMN IF NOT EXISTS shift_end        TIME;

-- A "branch" in the PRD == "clinic" in our schema. We keep branch_id as an
-- optional override so future multi-branch-within-clinic doesn't need a
-- second migration. Default to the user's clinic.
UPDATE users SET branch_id = clinic_id WHERE branch_id IS NULL AND clinic_id IS NOT NULL;

-- ── Index for branch lookups ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_branch     ON users(branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_specialty  ON users USING GIN(specialty_tags);
