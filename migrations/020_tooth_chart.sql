-- Migration 020: tooth chart snapshot (T2.1)

CREATE TABLE IF NOT EXISTS tooth_chart_snapshot (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  session_id   UUID NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  chart_data   JSONB NOT NULL DEFAULT '{}',
  baseline_ref UUID REFERENCES tooth_chart_snapshot(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_chart_session ON tooth_chart_snapshot(session_id);

CREATE OR REPLACE FUNCTION set_chart_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chart_updated_at ON tooth_chart_snapshot;
CREATE TRIGGER trg_chart_updated_at
  BEFORE UPDATE ON tooth_chart_snapshot
  FOR EACH ROW EXECUTE FUNCTION set_chart_updated_at();
