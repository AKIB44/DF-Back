-- Migration 080: Feature flag for the Gesture-Controlled 3D Viewer.
-- Org-scoped opt-in toggle (PRD_08). OFF by default for every existing org;
-- absence of a row is also treated as FALSE by the GET /feature-flags catalog.
-- Idempotent. org_admin / clinic_admin already hold feature_flag.manage.

INSERT INTO feature_flags (org_id, flag_key, enabled)
SELECT id, 'gesture_viewer.enabled', FALSE
FROM organizations
ON CONFLICT (org_id, flag_key) DO NOTHING;
