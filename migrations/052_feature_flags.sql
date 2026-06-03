-- ────────────────────────────────────────────────────────────────────────────
-- Feature flags — org-scoped on/off toggles for opt-in features
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feature_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  flag_key    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID,
  UNIQUE (org_id, flag_key)
);

CREATE INDEX IF NOT EXISTS feature_flags_org_idx ON feature_flags(org_id);
CREATE INDEX IF NOT EXISTS feature_flags_key_idx ON feature_flags(flag_key);

-- Seed: Friday voice assistant — OFF by default for every existing org.
-- New orgs default to FALSE via the column default when a row is first inserted
-- (or absence is treated as FALSE by the GET endpoint).
INSERT INTO feature_flags (org_id, flag_key, enabled)
SELECT id, 'voice_assistant.friday', FALSE
FROM organizations
ON CONFLICT (org_id, flag_key) DO NOTHING;

-- Permission for managing feature flags — org_admin / clinic_admin only.
INSERT INTO permissions (code, module, action, description, default_scope)
VALUES ('feature_flag.manage', 'feature_flag', 'manage', 'Toggle org-level feature flags', 'org')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'feature_flag.manage', 'org'
FROM roles r
WHERE r.code IN ('org_admin', 'clinic_admin')
ON CONFLICT DO NOTHING;
