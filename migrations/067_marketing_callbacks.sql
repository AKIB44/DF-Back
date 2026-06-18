-- Migration 067: Marketing Strategy Module — Phase 4 (Callback Scheduler).
-- PRD_MARKETING_STRATEGY_MODULE_V2 §6.16. Scheduled callback entries — when a
-- prospect says "call me later" (reached_callback) or a not-reached attempt is
-- auto-retried in 24h. A lead re-surfaces on the caller queue at scheduled_for.
-- Adapted to (org_id, clinic_id) UUID multi-tenancy. IF NOT EXISTS = re-run safe.

CREATE TABLE IF NOT EXISTS mkt_callbacks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  lead_id       UUID NOT NULL REFERENCES mkt_pipeline_leads(id) ON DELETE CASCADE,
  call_log_id   UUID REFERENCES mkt_call_logs(id),   -- the call where it was requested
  caller_id     UUID NOT NULL REFERENCES users(id),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','called','rescheduled','cancelled')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_callbacks_caller_date ON mkt_callbacks(caller_id, scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_mkt_callbacks_lead        ON mkt_callbacks(lead_id);
CREATE INDEX IF NOT EXISTS idx_mkt_callbacks_clinic_status ON mkt_callbacks(clinic_id, status) WHERE status = 'pending';
