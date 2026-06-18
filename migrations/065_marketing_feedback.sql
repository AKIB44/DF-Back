-- Migration 065: Marketing Strategy Module — Phase 2 (Feedback & Acceptance Ratio).
-- PRD_MARKETING_STRATEGY_MODULE_V2 §6.13–6.15. Dual-source feedback per lead:
-- marketing-person feedback (with acceptance disposition + rejection taxonomy) and
-- caller feedback (post-call sentiment). Adapted to (org_id, clinic_id) UUID
-- multi-tenancy. `call_log_id` is a nullable UUID without an FK until Phase 3
-- creates mkt_call_logs. IF NOT EXISTS so re-runs are safe.

-- ── 1. mkt_lead_feedback (marketing person) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_lead_feedback (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id),
  lead_id          UUID NOT NULL REFERENCES mkt_pipeline_leads(id) ON DELETE CASCADE,
  author_id        UUID NOT NULL REFERENCES users(id),
  feedback_text    TEXT NOT NULL,
  disposition      TEXT NOT NULL
                     CHECK (disposition IN ('interested','price_concern','data_privacy',
                       'timing','competitor','features','trust','no_decision_maker','other')),
  rejection_reason TEXT
                     CHECK (rejection_reason IN ('price_concern','data_privacy','timing',
                       'competitor','features','trust','no_decision_maker','other')),
  rejection_notes  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_lead_feedback_lead   ON mkt_lead_feedback(lead_id);
CREATE INDEX IF NOT EXISTS idx_mkt_lead_feedback_author ON mkt_lead_feedback(author_id, created_at);

-- ── 2. mkt_caller_feedback (caller, post-call) ───────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_caller_feedback (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id),
  lead_id          UUID NOT NULL REFERENCES mkt_pipeline_leads(id) ON DELETE CASCADE,
  call_log_id      UUID,   -- FK to mkt_call_logs added in Phase 3
  caller_id        UUID NOT NULL REFERENCES users(id),
  sentiment        TEXT NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
  feedback_text    TEXT NOT NULL,
  key_objection    TEXT
                     CHECK (key_objection IN ('price_concern','data_privacy','timing',
                       'competitor','features','trust','no_decision_maker','other')),
  follow_up_needed BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_caller_fb_lead ON mkt_caller_feedback(lead_id);
