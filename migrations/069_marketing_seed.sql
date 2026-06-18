-- Migration 069: Marketing Strategy Module — sample/demo data for testing.
-- Mirrors the 033 inventory-seed style: resolves the first active org→clinic→user,
-- skips if marketing data already exists, then seeds campaigns, content calendar,
-- pipeline leads (across stages + dispositions), dual-source feedback, call logs,
-- callbacks, and digital enquiries so every Phase 1–5 screen has something to show.
-- DEV/DEMO ONLY — safe to delete this migration once real data exists.

DO $$
DECLARE
  v_org    UUID;
  v_clinic UUID;
  v_user   UUID;   -- acts as marketing lead / owner
  v_caller UUID;   -- acts as the assigned caller
  v_camp1  UUID;
  v_la UUID; v_lb UUID; v_lc UUID; v_ld UUID; v_le UUID; v_lf UUID; v_lg UUID; v_lh UUID;
  v_call1 UUID; v_call2 UUID; v_call3 UUID;
BEGIN
  -- ── Resolve context: first active org → clinic → user ──────────────────────
  SELECT o.id, c.id, u.id
    INTO v_org, v_clinic, v_user
    FROM organizations o
    JOIN clinics c ON c.org_id = o.id AND c.is_active = true
    JOIN users   u ON u.clinic_id = c.id AND u.is_active = true
    ORDER BY o.created_at ASC, c.created_at ASC, u.created_at ASC
    LIMIT 1;

  IF v_clinic IS NULL THEN
    RAISE NOTICE '[seed] No org/clinic/user found — marketing seed skipped';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM mkt_campaigns WHERE clinic_id = v_clinic) THEN
    RAISE NOTICE '[seed] Marketing data already present for clinic % — skipped', v_clinic;
    RETURN;
  END IF;

  -- Use the same primary user as the caller so the call queue + callbacks are
  -- immediately visible to whoever logs in first (typically the admin tester).
  v_caller := v_user;

  RAISE NOTICE '[seed] Seeding marketing data for clinic %', v_clinic;

  -- ── Campaigns ──────────────────────────────────────────────────────────────
  INSERT INTO mkt_campaigns (org_id, clinic_id, name, goal, channel, status, budget_paise, start_date, end_date, created_by)
  VALUES (v_org, v_clinic, 'Summer Whitening Offer', 'bookings', 'whatsapp', 'active', 2500000, CURRENT_DATE - 10, CURRENT_DATE + 20, v_user)
  RETURNING id INTO v_camp1;

  INSERT INTO mkt_campaigns (org_id, clinic_id, name, goal, channel, status, budget_paise, start_date, end_date, created_by) VALUES
    (v_org, v_clinic, 'Diwali Awareness Push', 'awareness', 'instagram', 'scheduled', 1500000, CURRENT_DATE + 5,  CURRENT_DATE + 25, v_user),
    (v_org, v_clinic, 'New Year Lead Gen',     'lead_gen',  'facebook',  'draft',     800000,  NULL,              NULL,              v_user),
    (v_org, v_clinic, 'Referral Drive Q2',     'bookings',  'offline',   'completed', 1000000, CURRENT_DATE - 60, CURRENT_DATE - 20, v_user);

  -- ── Content calendar ───────────────────────────────────────────────────────
  INSERT INTO mkt_content_calendar (org_id, clinic_id, campaign_id, channel, title, caption, scheduled_for, status, owner_id, created_by) VALUES
    (v_org, v_clinic, v_camp1, 'instagram',       'Whitening before & after', 'Real patient results ✨', NOW() + INTERVAL '2 days', 'scheduled', v_user, v_user),
    (v_org, v_clinic, v_camp1, 'facebook',        'Patient testimonial',      'Hear from Dr. Mehta''s patients', NULL,           'draft',     v_user, v_user),
    (v_org, v_clinic, NULL,    'instagram',       'Clinic tour reel',         'A peek inside our clinic', NOW() - INTERVAL '3 days', 'posted',    v_user, v_user),
    (v_org, v_clinic, v_camp1, 'whatsapp_status', '20% off this week',        'Limited-time whitening offer', NOW() + INTERVAL '1 day','scheduled', v_user, v_user);

  -- ── Pipeline leads ─────────────────────────────────────────────────────────
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Bright Smile Dental', 'Dr. Anita Rao',  '+919800000001', 'Pune',   'new',                 'digital', NULL,       v_user, NULL,     v_user) RETURNING id INTO v_la;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Pearl Dental Care',   'Dr. Sameer Jain','+919800000002', 'Mumbai', 'marketing_qualified', 'manual',  'pending',  v_user, NULL,     v_user) RETURNING id INTO v_lb;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Smile Studio',        'Dr. Reema Shah', '+919800000003', 'Nashik', 'routed_to_caller',    'referral','pending',  v_user, v_caller, v_user) RETURNING id INTO v_lc;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, next_followup, created_by)
  VALUES (v_org, v_clinic, 'City Dental',         'Dr. Vikram K.',  '+919800000004', 'Pune',   'called',              'manual',  'pending',  v_user, v_caller, CURRENT_DATE + 1, v_user) RETURNING id INTO v_ld;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Happy Teeth',         'Dr. Neha Gupta', '+919800000005', 'Pune',   'onboarded',           'manual',  'accepted', v_user, v_caller, v_user) RETURNING id INTO v_le;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Ortho Plus',          'Dr. Imran S.',   '+919800000006', 'Thane',  'lost',                'referral','rejected', v_user, v_caller, v_user) RETURNING id INTO v_lf;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Dent Care Hub',       'Dr. Priya M.',   '+919800000007', 'Pune',   'demo_scheduled',      'digital', 'accepted', v_user, v_caller, v_user) RETURNING id INTO v_lg;
  INSERT INTO mkt_pipeline_leads (org_id, clinic_id, clinic_name, contact_name, contact_phone, city, stage, source, final_disposition, owner_id, assigned_caller_id, created_by)
  VALUES (v_org, v_clinic, 'Tooth Fairy Clinic',  'Dr. Karan B.',   '+919800000008', 'Mumbai', 'lost',                'manual',  'rejected', v_user, NULL,     v_user) RETURNING id INTO v_lh;

  -- ── Marketing-person feedback (drives acceptance ratio + reason breakdown) ──
  INSERT INTO mkt_lead_feedback (org_id, clinic_id, lead_id, author_id, feedback_text, disposition, rejection_reason) VALUES
    (v_org, v_clinic, v_lb, v_user, 'Doctor keen, wants pricing details.',        'interested',    NULL),
    (v_org, v_clinic, v_le, v_user, 'Signed up after the demo — great fit.',      'interested',    NULL),
    (v_org, v_clinic, v_lg, v_user, 'Very interested, demo booked.',              'interested',    NULL),
    (v_org, v_clinic, v_lc, v_user, 'Concerned about patient data storage.',      'data_privacy',  'data_privacy'),
    (v_org, v_clinic, v_ld, v_user, 'Mentioned a competitor they already use.',   'competitor',    'competitor'),
    (v_org, v_clinic, v_lf, v_user, 'Budget too tight this quarter.',             'price_concern', 'price_concern'),
    (v_org, v_clinic, v_lh, v_user, 'Current contract running, revisit later.',   'timing',        'timing');

  -- ── Call logs (City Dental: missed then callback; Ortho Plus: not interested)
  INSERT INTO mkt_call_logs (org_id, clinic_id, lead_id, caller_id, duration_secs, outcome, notes, attempt_number, called_at)
  VALUES (v_org, v_clinic, v_ld, v_caller, NULL, 'not_reached_no_answer', 'No answer, will retry.', 1, NOW() - INTERVAL '2 days')
  RETURNING id INTO v_call1;
  INSERT INTO mkt_call_logs (org_id, clinic_id, lead_id, caller_id, duration_secs, outcome, notes, attempt_number, called_at)
  VALUES (v_org, v_clinic, v_ld, v_caller, 240, 'reached_callback', 'Doctor in OPD, asked to call back.', 2, NOW() - INTERVAL '6 hours')
  RETURNING id INTO v_call2;
  INSERT INTO mkt_call_logs (org_id, clinic_id, lead_id, caller_id, duration_secs, outcome, notes, attempt_number, called_at)
  VALUES (v_org, v_clinic, v_lf, v_caller, 180, 'reached_not_interested', 'Not interested due to budget.', 1, NOW() - INTERVAL '1 day')
  RETURNING id INTO v_call3;

  -- ── Caller feedback ────────────────────────────────────────────────────────
  INSERT INTO mkt_caller_feedback (org_id, clinic_id, lead_id, call_log_id, caller_id, sentiment, feedback_text, key_objection, follow_up_needed) VALUES
    (v_org, v_clinic, v_ld, v_call2, v_caller, 'neutral',  'Engaged but timing-sensitive.',     'timing',        true),
    (v_org, v_clinic, v_lf, v_call3, v_caller, 'negative', 'Firm no on price for now.',          'price_concern', false);

  -- ── Callbacks (one overdue, one upcoming) for City Dental ──────────────────
  INSERT INTO mkt_callbacks (org_id, clinic_id, lead_id, call_log_id, caller_id, scheduled_for, status, notes) VALUES
    (v_org, v_clinic, v_ld, v_call2, v_caller, NOW() - INTERVAL '3 hours', 'pending', 'Call back — was in OPD'),
    (v_org, v_clinic, v_ld, NULL,    v_caller, NOW() + INTERVAL '1 day',   'pending', 'Follow-up after callback');

  -- ── Digital enquiries (converted, new, duplicate) ──────────────────────────
  INSERT INTO mkt_digital_enquiries (org_id, clinic_id, source, utm_campaign, utm_source, utm_medium, clinic_name, contact_name, contact_phone, contact_email, message, lead_id, is_duplicate) VALUES
    (v_org, v_clinic, 'website',  'summer_whitening', 'google',    'cpc',      'Bright Smile Dental', 'Dr. Anita Rao', '+919800000001', 'anita@brightsmile.in', 'Interested in a demo of the platform.', v_la, false),
    (v_org, v_clinic, 'referral', 'partner_program',  'partner',   'referral', 'Referred Clinic',     'Dr. Mohan L.',  '+919800000010', 'mohan@clinic.in',      'Referred by Happy Teeth.',               NULL, false),
    (v_org, v_clinic, 'social',   'insta_reel',       'instagram', 'social',   'Insta Lead Clinic',   'Dr. Sara P.',   '+919800000011', 'sara@clinic.in',       'Saw your reel, want info.',              NULL, true);

  RAISE NOTICE '[seed] Marketing sample data inserted for clinic %', v_clinic;
END $$;
