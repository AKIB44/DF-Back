-- ────────────────────────────────────────────────────────────────────────────
-- Auto-seed user_roles on user creation
-- ────────────────────────────────────────────────────────────────────────────
--
-- Problem: any user created through a path that doesn't manually INSERT into
-- user_roles ends up with the legacy `users.role` text column set but no
-- entry in the RBAC join table. The permission resolver then returns {} and
-- nav menus are empty / 403s on click.
--
-- Fix: an AFTER INSERT trigger on `users` that translates the legacy role
-- column into an RBAC role assignment. Plus a one-shot backfill for any
-- existing user that's currently missing their join-row.
--
-- The trigger is idempotent (ON CONFLICT DO NOTHING) so the explicit
-- staff.js / clinics.js / rbac.js INSERTs continue to work — they just become
-- the "happy path"; the trigger is the safety net.
-- ────────────────────────────────────────────────────────────────────────────

-- ── Idempotency guard ──────────────────────────────────────────────────────
-- user_roles has no unique constraint; both the trigger and the existing
-- staff/clinics/rbac route INSERTs would otherwise race and create duplicate
-- rows. Add a partial unique index covering active (non-expired) assignments.
-- The COALESCE handles the NULL-clinic case (org-wide roles) since NULL
-- doesn't equal NULL in unique constraints.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles_active
  ON user_roles (user_id, role_id, COALESCE(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE valid_to IS NULL;

-- ── Role-code translator ───────────────────────────────────────────────────
-- Legacy `users.role` enum:  admin | doctor | receptionist | accountant
-- RBAC `roles.code`:         clinic_admin | doctor | reception | accountant
CREATE OR REPLACE FUNCTION rbac_role_code_for(legacy TEXT) RETURNS TEXT AS $$
BEGIN
  RETURN CASE LOWER(COALESCE(legacy, ''))
    WHEN 'admin'        THEN 'clinic_admin'
    WHEN 'doctor'       THEN 'doctor'
    WHEN 'receptionist' THEN 'reception'
    WHEN 'reception'    THEN 'reception'
    WHEN 'accountant'   THEN 'accountant'
    WHEN 'org_admin'    THEN 'org_admin'
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION users_autoseed_user_roles() RETURNS TRIGGER AS $$
DECLARE
  rbac_code TEXT;
  role_uuid UUID;
BEGIN
  rbac_code := rbac_role_code_for(NEW.role);
  IF rbac_code IS NULL THEN RETURN NEW; END IF;

  -- Prefer an org-scoped custom role if one exists; fall back to the system role.
  SELECT id INTO role_uuid
    FROM roles
    WHERE code = rbac_code
      AND (org_id = NEW.org_id OR (org_id IS NULL AND is_system = true))
    ORDER BY (org_id = NEW.org_id) DESC
    LIMIT 1;

  IF role_uuid IS NULL THEN RETURN NEW; END IF;

  INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by, valid_from)
  VALUES (NEW.id, role_uuid,
          CASE WHEN rbac_code IN ('org_admin') THEN NULL ELSE NEW.clinic_id END,
          NEW.id,
          NOW())
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Wire it up ─────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS users_autoseed_user_roles_trg ON users;
CREATE TRIGGER users_autoseed_user_roles_trg
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION users_autoseed_user_roles();

-- ── Backfill existing orphans ──────────────────────────────────────────────
-- For every user that has NO active user_roles row, insert one based on their
-- legacy role column. Safe to re-run.
INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by, valid_from)
SELECT u.id,
       r.id,
       CASE WHEN r.code IN ('org_admin') THEN NULL ELSE u.clinic_id END,
       u.id,
       NOW()
FROM users u
LEFT JOIN user_roles ur
  ON ur.user_id = u.id
 AND (ur.valid_to IS NULL OR ur.valid_to > NOW())
JOIN roles r
  ON r.code = rbac_role_code_for(u.role)
 AND (r.org_id = u.org_id OR (r.org_id IS NULL AND r.is_system = true))
WHERE ur.user_id IS NULL
ON CONFLICT DO NOTHING;
