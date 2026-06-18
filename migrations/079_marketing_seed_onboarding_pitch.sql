-- Migration 079: Marketing — sample onboarding checklist + pitch doc (demo/testing).
-- Extends the 069 demo data so the Phase 9 onboarding + pitch screens have content.
-- Self-guards. DEV/DEMO ONLY.

DO $$
DECLARE
  v_org    UUID;
  v_clinic UUID;
  v_user   UUID;
  v_lead   UUID;
BEGIN
  SELECT o.id, c.id, u.id
    INTO v_org, v_clinic, v_user
    FROM organizations o
    JOIN clinics c ON c.org_id = o.id AND c.is_active = true
    JOIN users   u ON u.clinic_id = c.id AND u.is_active = true
    ORDER BY o.created_at ASC, c.created_at ASC, u.created_at ASC
    LIMIT 1;

  IF v_clinic IS NULL THEN RAISE NOTICE '[seed] No org/clinic/user — onboarding/pitch seed skipped'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM mkt_onboarding_steps WHERE clinic_id = v_clinic) THEN
    RAISE NOTICE '[seed] Onboarding already present for clinic % — skipped', v_clinic; RETURN;
  END IF;

  -- Attach a checklist to an onboarding-stage lead (fall back to any lead).
  SELECT id INTO v_lead FROM mkt_pipeline_leads
   WHERE clinic_id = v_clinic AND stage IN ('onboarded','demo_scheduled','trial')
   ORDER BY (stage = 'onboarded') DESC, created_at LIMIT 1;
  IF v_lead IS NULL THEN SELECT id INTO v_lead FROM mkt_pipeline_leads WHERE clinic_id = v_clinic LIMIT 1; END IF;

  IF v_lead IS NOT NULL THEN
    INSERT INTO mkt_onboarding_steps (org_id, clinic_id, lead_id, step_name, step_order, owner_id, status, due_date, completed_at) VALUES
      (v_org, v_clinic, v_lead, 'Agreement signed', 0, v_user, 'done',        CURRENT_DATE - 8, NOW() - INTERVAL '8 days'),
      (v_org, v_clinic, v_lead, 'Data migration',    1, v_user, 'in_progress', CURRENT_DATE + 2, NULL),
      (v_org, v_clinic, v_lead, 'Staff training',    2, v_user, 'pending',      CURRENT_DATE + 5, NULL),
      (v_org, v_clinic, v_lead, 'Go-live',           3, v_user, 'pending',      CURRENT_DATE + 9, NULL);
  END IF;

  -- A library pitch doc (no S3 file in demo data — download disabled).
  INSERT INTO mkt_pitch_documents (org_id, clinic_id, title, version, content_type, generated, created_by)
  VALUES (v_org, v_clinic, 'DentaFlow Master Deck', 'v2', 'application/pdf', false, v_user);

  RAISE NOTICE '[seed] Onboarding + pitch demo data inserted for clinic %', v_clinic;
END $$;
