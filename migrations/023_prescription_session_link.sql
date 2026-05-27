-- Migration 023: link prescriptions to clinical_session (T2.5)

ALTER TABLE prescriptions
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES clinical_session(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rx_session ON prescriptions(session_id);
