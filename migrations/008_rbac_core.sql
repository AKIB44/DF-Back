-- ─── 008: Multi-Tenant RBAC core tables ──────────────────────────────────────
-- Adds: organizations, permissions, roles, role_permissions, user_roles,
--       permission_overrides, rbac_audit_log, break_glass_sessions
-- Extends: users (org_id, role_version, status_rbac, mfa_*, last_login_at, failed_login_count)

-- ── Organizations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  slug       TEXT        NOT NULL UNIQUE,
  status     TEXT        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Extend clinics with org reference ─────────────────────────────────────────
ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

-- ── Extend users ──────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS org_id             UUID REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS role_version       INT         NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status_rbac        TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status_rbac IN ('active','disabled','locked')),
  ADD COLUMN IF NOT EXISTS mfa_enabled        BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_secret         TEXT,
  ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_login_count INT         NOT NULL DEFAULT 0;

-- ── Permissions catalog ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permissions (
  code          TEXT PRIMARY KEY,
  module        TEXT NOT NULL,
  action        TEXT NOT NULL,
  description   TEXT NOT NULL,
  default_scope TEXT NOT NULL DEFAULT 'clinic'
                  CHECK (default_scope IN ('own','clinic','org','platform')),
  is_sensitive  BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Roles ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        REFERENCES organizations(id),
  code        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  is_system   BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two partial indexes to handle NULL org_id (system roles) vs org-scoped roles
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_role_code
  ON roles(code) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_role_code
  ON roles(org_id, code) WHERE org_id IS NOT NULL;

-- ── Role → Permission assignments ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code),
  scope           TEXT NOT NULL DEFAULT 'clinic'
                    CHECK (scope IN ('own','clinic','org','platform')),
  PRIMARY KEY (role_id, permission_code)
);

-- ── User → Role assignments (per-clinic) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_roles (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    UUID        NOT NULL REFERENCES roles(id),
  clinic_id  UUID        REFERENCES clinics(id),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to   TIMESTAMPTZ,
  granted_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_roles_active ON user_roles(user_id, clinic_id);

-- ── Per-user permission overrides (allow / deny) ───────────────────────────────
CREATE TABLE IF NOT EXISTS permission_overrides (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id       UUID        REFERENCES clinics(id),
  permission_code TEXT        NOT NULL REFERENCES permissions(code),
  effect          TEXT        NOT NULL CHECK (effect IN ('allow','deny')),
  scope           TEXT        NOT NULL DEFAULT 'clinic'
                    CHECK (scope IN ('own','clinic','org','platform')),
  reason          TEXT,
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ,
  granted_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RBAC Audit log (append-only, separate from legacy audit_log) ──────────────
CREATE TABLE IF NOT EXISTS rbac_audit_log (
  id              BIGSERIAL   PRIMARY KEY,
  org_id          UUID,
  clinic_id       UUID,
  actor_type      TEXT        NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user','platform_admin','system')),
  actor_id        UUID,
  action          TEXT        NOT NULL,
  resource_type   TEXT,
  resource_id     UUID,
  permission_used TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  metadata        JSONB,
  result          TEXT        NOT NULL DEFAULT 'success'
                    CHECK (result IN ('success','denied','error')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_actor    ON rbac_audit_log(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_resource ON rbac_audit_log(resource_type, resource_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_clinic   ON rbac_audit_log(clinic_id, created_at);

-- ── Break-glass emergency sessions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS break_glass_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id),
  reason      TEXT        NOT NULL,
  patient_id  UUID,
  approved_by UUID,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

-- ── Seed: permissions catalog ──────────────────────────────────────────────────
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  ('appointment.view',            'appointment', 'view',     'View appointments',                   'clinic', false),
  ('appointment.create',          'appointment', 'create',   'Create appointment',                  'clinic', false),
  ('appointment.update',          'appointment', 'update',   'Update appointment',                  'clinic', false),
  ('appointment.cancel',          'appointment', 'cancel',   'Cancel appointment',                  'clinic', false),
  ('patient.view',                'patient',     'view',     'View patient record',                 'clinic', false),
  ('patient.create',              'patient',     'create',   'Register patient',                    'clinic', false),
  ('patient.update',              'patient',     'update',   'Edit patient record',                 'clinic', false),
  ('patient.medical_history.view','patient',     'view_mh',  'View clinical history',               'clinic', true),
  ('prescription.create',         'prescription','create',   'Create prescription',                 'own',    true),
  ('prescription.sign',           'prescription','sign',     'Digitally sign prescription',         'own',    true),
  ('billing.view',                'billing',     'view',     'View bills',                          'clinic', false),
  ('billing.create',              'billing',     'create',   'Generate invoice',                    'clinic', false),
  ('billing.refund',              'billing',     'refund',   'Issue refund',                        'clinic', true),
  ('billing.export',              'billing',     'export',   'Export billing data',                 'clinic', true),
  ('inventory.adjust',            'inventory',   'adjust',   'Adjust stock',                        'clinic', false),
  ('staff.manage',                'staff',       'manage',   'Manage clinic staff and roles',       'clinic', true),
  ('clinic.settings',             'clinic',      'settings', 'Edit clinic settings',                'clinic', true),
  ('audit.view',                  'audit',       'view',     'View audit logs',                     'clinic', true),
  ('org.manage',                  'org',         'manage',   'Manage organization',                 'org',    true),
  ('platform.manage',             'platform',    'manage',   'Platform-wide admin',                 'platform', true)
ON CONFLICT (code) DO NOTHING;

-- ── Seed: system roles ────────────────────────────────────────────────────────
INSERT INTO roles (org_id, code, name, is_system) VALUES
  (NULL, 'org_admin',    'Organization Admin', true),
  (NULL, 'clinic_admin', 'Clinic Admin',       true),
  (NULL, 'doctor',       'Doctor',             true),
  (NULL, 'reception',    'Receptionist',       true),
  (NULL, 'lab_tech',     'Lab Technician',     true),
  (NULL, 'accountant',   'Accountant',         true)
ON CONFLICT DO NOTHING;

-- ── Seed: role → permission assignments ───────────────────────────────────────
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'clinic_admin' AND p.code NOT IN ('org.manage','platform.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code,
  CASE WHEN p.code IN ('prescription.create','prescription.sign') THEN 'own' ELSE p.default_scope END
FROM roles r, permissions p
WHERE r.code = 'doctor'
  AND p.code IN (
    'appointment.view','appointment.update',
    'patient.view','patient.update','patient.medical_history.view',
    'prescription.create','prescription.sign','billing.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'reception'
  AND p.code IN (
    'appointment.view','appointment.create','appointment.update','appointment.cancel',
    'patient.view','patient.create','patient.update',
    'billing.view','billing.create'
  )
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'accountant'
  AND p.code IN ('billing.view','billing.create','billing.refund','billing.export')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'org_admin' AND p.code != 'platform.manage'
ON CONFLICT DO NOTHING;
