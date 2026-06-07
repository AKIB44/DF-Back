-- ────────────────────────────────────────────────────────────────────────────
-- Revoke specialty.view from reception.
-- ────────────────────────────────────────────────────────────────────────────
-- Migration 051 originally granted specialty.view to reception "for
-- scheduling" — but the specialty pages aren't usable by reception (no
-- create/update perms, child routes 403), so showing the parent menu just
-- to deny every action inside is confusing UX.
--
-- This migration revokes the grant. To re-enable for a specific clinic /
-- org, do it as a per-user override in user_role_overrides.
-- ────────────────────────────────────────────────────────────────────────────

DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.code = 'reception'
  AND rp.permission_code = 'specialty.view';

-- Bump role_version on every reception user so their permission cache
-- invalidates on the next request.
UPDATE users
   SET role_version = COALESCE(role_version, 1) + 1
 WHERE id IN (
   SELECT ur.user_id
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
    WHERE r.code = 'reception'
      AND (ur.valid_to IS NULL OR ur.valid_to > NOW())
 );
