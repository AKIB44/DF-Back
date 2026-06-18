-- Migration 073: Marketing — sample expenses (demo/testing).
-- Extends the 069 demo data so the Phase 7 expenses + summary screens have
-- content this month and last month (for the MoM comparison). Self-guards.
-- DEV/DEMO ONLY.

DO $$
DECLARE
  v_org    UUID;
  v_clinic UUID;
  v_user   UUID;
  v_camp   UUID;
BEGIN
  SELECT o.id, c.id, u.id
    INTO v_org, v_clinic, v_user
    FROM organizations o
    JOIN clinics c ON c.org_id = o.id AND c.is_active = true
    JOIN users   u ON u.clinic_id = c.id AND u.is_active = true
    ORDER BY o.created_at ASC, c.created_at ASC, u.created_at ASC
    LIMIT 1;

  IF v_clinic IS NULL THEN
    RAISE NOTICE '[seed] No org/clinic/user — expenses seed skipped';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM mkt_expenses WHERE clinic_id = v_clinic) THEN
    RAISE NOTICE '[seed] Marketing expenses already present for clinic % — skipped', v_clinic;
    RETURN;
  END IF;

  SELECT id INTO v_camp FROM mkt_campaigns
   WHERE clinic_id = v_clinic AND name = 'Summer Whitening Offer' LIMIT 1;

  -- This month.
  INSERT INTO mkt_expenses (org_id, clinic_id, category, vendor, description, amount_paise, spent_on, campaign_id, payment_mode, created_by) VALUES
    (v_org, v_clinic, 'ad_spend',            'Meta Ads',      'Instagram boost — whitening', 1500000, date_trunc('month', CURRENT_DATE) + INTERVAL '3 days',  v_camp, 'card', v_user),
    (v_org, v_clinic, 'printing',            'PrintHub',      'Flyers & standees',            450000, date_trunc('month', CURRENT_DATE) + INTERVAL '5 days',  v_camp, 'upi',  v_user),
    (v_org, v_clinic, 'tools_subscriptions', 'Canva Pro',     'Design subscription',          120000, date_trunc('month', CURRENT_DATE) + INTERVAL '1 day',   NULL,   'card', v_user),
    (v_org, v_clinic, 'caller_incentives',   NULL,            'Caller incentive — June',      300000, date_trunc('month', CURRENT_DATE) + INTERVAL '8 days',  NULL,   'bank_transfer', v_user),
    (v_org, v_clinic, 'travel',              'Uber',          'Clinic visits',                 85000, date_trunc('month', CURRENT_DATE) + INTERVAL '6 days',  NULL,   'upi',  v_user);

  -- Last month (for the MoM comparison).
  INSERT INTO mkt_expenses (org_id, clinic_id, category, vendor, description, amount_paise, spent_on, payment_mode, created_by) VALUES
    (v_org, v_clinic, 'ad_spend', 'Google Ads', 'Search campaign', 2000000, date_trunc('month', CURRENT_DATE) - INTERVAL '20 days', 'card', v_user),
    (v_org, v_clinic, 'events',   'Expo India', 'Dental expo stall', 750000, date_trunc('month', CURRENT_DATE) - INTERVAL '15 days', 'bank_transfer', v_user);

  RAISE NOTICE '[seed] Marketing expenses demo data inserted for clinic %', v_clinic;
END $$;
