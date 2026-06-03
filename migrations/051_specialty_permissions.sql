-- Migration 051: Grant specialty permissions to all clinical roles
-- Inserts the 3 specialty permission codes that were added to the backend
-- permission constants but were missing from the DB seed.

-- 1. Register the permissions
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  ('specialty.view',   'specialty', 'view',   'View specialty cases',   'clinic', false),
  ('specialty.create', 'specialty', 'create', 'Create specialty cases', 'clinic', false),
  ('specialty.update', 'specialty', 'update', 'Update specialty cases', 'clinic', false)
ON CONFLICT (code) DO NOTHING;

-- 2. Grant all three to clinic_admin (already has every non-org permission)
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'clinic_admin'
  AND p.code IN ('specialty.view', 'specialty.create', 'specialty.update')
ON CONFLICT DO NOTHING;

-- 3. Grant all three to org_admin (same as clinic_admin but org-scoped)
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'org_admin'
  AND p.code IN ('specialty.view', 'specialty.create', 'specialty.update')
ON CONFLICT DO NOTHING;

-- 4. Grant all three to doctor (clinical role — views and creates specialty cases)
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'doctor'
  AND p.code IN ('specialty.view', 'specialty.create', 'specialty.update')
ON CONFLICT DO NOTHING;

-- 5. Grant view-only to reception (needs to see specialty cases for scheduling)
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'reception'
  AND p.code = 'specialty.view'
ON CONFLICT DO NOTHING;
