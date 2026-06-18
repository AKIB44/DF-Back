-- Migration 070: Marketing Strategy Module — Phase 6 (Calendar Sync / Scheduled Calls).
-- PRD_MARKETING_STRATEGY_MODULE_V2 §6.18, §7.10, §12. Prospect-booked meeting
-- slots that sync to Google Calendar (event id + Meet link). `mkt_call_slots`
-- holds pre-generated bookable slots fronted by a public slot_token. Adapted to
-- (org_id, clinic_id) UUID multi-tenancy. IF NOT EXISTS = re-run safe.

-- ── 1. Scheduled calls ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_scheduled_calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id),
  lead_id          UUID REFERENCES mkt_pipeline_leads(id),
  assigned_to_id   UUID REFERENCES users(id),   -- caller or marketing person
  contact_name     TEXT,
  contact_phone    TEXT,
  contact_email    TEXT,
  clinic_name      TEXT,
  scheduled_for    TIMESTAMPTZ NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 30,
  google_event_id  TEXT,
  google_meet_link TEXT,
  sync_status      TEXT NOT NULL DEFAULT 'pending'
                     CHECK (sync_status IN ('pending','synced','error')),
  status           TEXT NOT NULL DEFAULT 'upcoming'
                     CHECK (status IN ('upcoming','completed','no_show','rescheduled')),
  post_call_notes  TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_scheduled_calls_date     ON mkt_scheduled_calls(clinic_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_mkt_scheduled_calls_assignee ON mkt_scheduled_calls(assigned_to_id, scheduled_for);

-- ── 2. Bookable slots (public slot picker) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_call_slots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  clinic_id         UUID NOT NULL REFERENCES clinics(id),
  assigned_to_id    UUID REFERENCES users(id),
  slot_start        TIMESTAMPTZ NOT NULL,
  slot_end          TIMESTAMPTZ NOT NULL,
  slot_token        TEXT NOT NULL UNIQUE,
  is_booked         BOOLEAN NOT NULL DEFAULT false,
  scheduled_call_id UUID REFERENCES mkt_scheduled_calls(id),
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_call_slots_clinic_start ON mkt_call_slots(clinic_id, slot_start) WHERE NOT is_booked;
