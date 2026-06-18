-- Migration 077: Marketing — sample segments + promo codes (demo/testing).
-- Extends the 069 demo data so the Phase 8 screens have content. guest_count is
-- computed from the clinic's real patients. Self-guards. DEV/DEMO ONLY.

DO $$
DECLARE
  v_org    UUID;
  v_clinic UUID;
  v_user   UUID;
  v_all    INT;
  v_email  INT;
BEGIN
  SELECT o.id, c.id, u.id
    INTO v_org, v_clinic, v_user
    FROM organizations o
    JOIN clinics c ON c.org_id = o.id AND c.is_active = true
    JOIN users   u ON u.clinic_id = c.id AND u.is_active = true
    ORDER BY o.created_at ASC, c.created_at ASC, u.created_at ASC
    LIMIT 1;

  IF v_clinic IS NULL THEN
    RAISE NOTICE '[seed] No org/clinic/user — segments/promo seed skipped';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM mkt_segments WHERE clinic_id = v_clinic) THEN
    RAISE NOTICE '[seed] Segments already present for clinic % — skipped', v_clinic;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_all   FROM patients WHERE clinic_id = v_clinic;
  SELECT COUNT(*) INTO v_email FROM patients WHERE clinic_id = v_clinic AND email IS NOT NULL AND email <> '';

  -- ── Segments ───────────────────────────────────────────────────────────────
  INSERT INTO mkt_segments (org_id, clinic_id, name, filter_json, guest_count, created_by) VALUES
    (v_org, v_clinic, 'All patients',        '{}'::jsonb,                                         v_all,   v_user),
    (v_org, v_clinic, 'Patients with email', '{"has_email": true}'::jsonb,                        v_email, v_user),
    (v_org, v_clinic, 'Lapsed (6+ months)',  jsonb_build_object('last_visit_before', to_char(CURRENT_DATE - INTERVAL '6 months', 'YYYY-MM-DD')), 0, v_user);

  -- ── Promo codes ────────────────────────────────────────────────────────────
  INSERT INTO mkt_promo_codes (org_id, clinic_id, code, discount_type, discount_value, applies_to, max_redemptions, valid_from, valid_until, active, created_by) VALUES
    (v_org, v_clinic, 'SUMMER20',   'percent', 20, 'all', 100, CURRENT_DATE - 10, CURRENT_DATE + 30, true,  v_user),
    (v_org, v_clinic, 'NEWPATIENT', 'flat',    500, 'all', NULL, NULL,             NULL,             true,  v_user),
    (v_org, v_clinic, 'WHITEN15',   'percent', 15, 'all', 50,  CURRENT_DATE - 40, CURRENT_DATE - 5,  false, v_user);

  RAISE NOTICE '[seed] Segments + promo demo data inserted for clinic %', v_clinic;
END $$;
