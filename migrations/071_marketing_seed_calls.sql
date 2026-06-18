-- Migration 071: Marketing — sample scheduled calls + open slots (demo/testing).
-- Extends the 069 demo data so the Phase 6 "Scheduled Calls" screen has content.
-- Self-guards: skips if scheduled calls already exist. DEV/DEMO ONLY.

DO $$
DECLARE
  v_org    UUID;
  v_clinic UUID;
  v_user   UUID;
  v_lead   UUID;
  v_call   UUID;
  v_token  TEXT;
  i        INT;
BEGIN
  SELECT o.id, c.id, u.id
    INTO v_org, v_clinic, v_user
    FROM organizations o
    JOIN clinics c ON c.org_id = o.id AND c.is_active = true
    JOIN users   u ON u.clinic_id = c.id AND u.is_active = true
    ORDER BY o.created_at ASC, c.created_at ASC, u.created_at ASC
    LIMIT 1;

  IF v_clinic IS NULL THEN
    RAISE NOTICE '[seed] No org/clinic/user — scheduled-calls seed skipped';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM mkt_scheduled_calls WHERE clinic_id = v_clinic) THEN
    RAISE NOTICE '[seed] Scheduled calls already present for clinic % — skipped', v_clinic;
    RETURN;
  END IF;

  -- Link one scheduled call to a seeded lead if available.
  SELECT id INTO v_lead FROM mkt_pipeline_leads
   WHERE clinic_id = v_clinic AND stage = 'demo_scheduled' ORDER BY created_at LIMIT 1;

  -- ── Scheduled calls: one today, two upcoming, one completed ────────────────
  INSERT INTO mkt_scheduled_calls
    (org_id, clinic_id, lead_id, assigned_to_id, contact_name, contact_phone, clinic_name,
     scheduled_for, duration_minutes, google_event_id, google_meet_link, sync_status, status, created_by)
  VALUES
    (v_org, v_clinic, v_lead, v_user, 'Dr. Priya M.', '+919800000007', 'Dent Care Hub',
     date_trunc('day', NOW()) + INTERVAL '15 hours', 30, 'stub_demo_today',
     'https://meet.google.com/lookup/stub_demo_today', 'pending', 'upcoming', v_user)
  RETURNING id INTO v_call;

  INSERT INTO mkt_scheduled_calls
    (org_id, clinic_id, assigned_to_id, contact_name, contact_phone, clinic_name,
     scheduled_for, duration_minutes, google_event_id, google_meet_link, sync_status, status, created_by) VALUES
    (v_org, v_clinic, v_user, 'Dr. Anita Rao', '+919800000001', 'Bright Smile Dental',
     NOW() + INTERVAL '2 days' + INTERVAL '4 hours', 45, 'stub_demo_2',
     'https://meet.google.com/lookup/stub_demo_2', 'pending', 'upcoming', v_user),
    (v_org, v_clinic, v_user, 'Dr. Sameer Jain', '+919800000002', 'Pearl Dental Care',
     NOW() + INTERVAL '3 days' + INTERVAL '2 hours', 30, 'stub_demo_3',
     'https://meet.google.com/lookup/stub_demo_3', 'pending', 'upcoming', v_user),
    (v_org, v_clinic, v_user, 'Dr. Neha Gupta', '+919800000005', 'Happy Teeth',
     NOW() - INTERVAL '2 days', 30, 'stub_demo_done',
     'https://meet.google.com/lookup/stub_demo_done', 'pending', 'completed', v_user);

  -- ── A handful of open bookable slots for tomorrow (10:00–13:00, 30 min) ─────
  FOR i IN 0..5 LOOP
    v_token := 'slot_seed_' || encode(gen_random_bytes(6), 'hex');
    INSERT INTO mkt_call_slots (org_id, clinic_id, assigned_to_id, slot_start, slot_end, slot_token, created_by)
    VALUES (
      v_org, v_clinic, v_user,
      date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '10 hours' + (i * INTERVAL '30 minutes'),
      date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '10 hours' + ((i + 1) * INTERVAL '30 minutes'),
      v_token, v_user);
  END LOOP;

  RAISE NOTICE '[seed] Scheduled-calls demo data inserted for clinic %', v_clinic;
END $$;
