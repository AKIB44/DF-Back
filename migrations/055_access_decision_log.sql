-- ────────────────────────────────────────────────────────────────────────────
-- ABAC Phase 1: access decision audit log (Postgres-only retention)
-- ────────────────────────────────────────────────────────────────────────────
-- Every authorize() decision is written here. Writes are async (BullMQ-style
-- queue in node); this just defines the destination table + indexes.
--
-- Retention: 90 days hot. A nightly job (added later) deletes rows older than
-- 90 days.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS access_decision_log (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         TEXT,
  user_id            UUID         NOT NULL,
  role               TEXT,
  clinic_id          UUID,
  branch_id          UUID,
  action             TEXT         NOT NULL,
  resource_type      TEXT         NOT NULL,
  resource_id        UUID,
  decision           TEXT         NOT NULL CHECK (decision IN ('PERMIT','DENY')),
  policy_name        TEXT         NOT NULL,
  policy_version     INT,
  reason             TEXT,
  attributes         JSONB,                       -- snapshot of relevant ctx attributes
  ip_address         INET,
  user_agent         TEXT,
  decided_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adl_user_time     ON access_decision_log(user_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_adl_decision_time ON access_decision_log(decision, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_adl_resource      ON access_decision_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_adl_clinic_time   ON access_decision_log(clinic_id, decided_at DESC);
