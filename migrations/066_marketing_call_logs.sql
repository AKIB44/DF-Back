-- Migration 066: Marketing Strategy Module — Phase 3 (Caller Workflow).
-- PRD_MARKETING_STRATEGY_MODULE_V2 §6.14. One row per call attempt by a caller,
-- with outcome + auto-incremented attempt number. Also wires the FK from
-- mkt_caller_feedback.call_log_id (deferred from Phase 2). Adapted to
-- (org_id, clinic_id) UUID multi-tenancy. IF NOT EXISTS so re-runs are safe.

-- ── 1. mkt_call_logs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_call_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  clinic_id      UUID NOT NULL REFERENCES clinics(id),
  lead_id        UUID NOT NULL REFERENCES mkt_pipeline_leads(id) ON DELETE CASCADE,
  caller_id      UUID NOT NULL REFERENCES users(id),
  called_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_secs  INT,
  outcome        TEXT NOT NULL
                   CHECK (outcome IN ('reached_interested','reached_not_interested',
                     'reached_callback','not_reached_busy','not_reached_no_answer',
                     'not_reached_switched_off')),
  notes          TEXT,
  attempt_number SMALLINT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_call_logs_lead   ON mkt_call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_mkt_call_logs_caller ON mkt_call_logs(caller_id, called_at);

-- ── 2. Wire the deferred caller-feedback → call-log FK (Phase 2 left it loose) ─
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_caller_feedback_call_log_fk') THEN
    ALTER TABLE mkt_caller_feedback
      ADD CONSTRAINT mkt_caller_feedback_call_log_fk
      FOREIGN KEY (call_log_id) REFERENCES mkt_call_logs(id);
  END IF;
END $$;
