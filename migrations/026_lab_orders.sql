-- Migration 026: Lab work orders (T3.3)

CREATE TABLE IF NOT EXISTS lab_order (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  service_id             UUID        NOT NULL REFERENCES service_performed(id) ON DELETE CASCADE,
  clinic_id              UUID        NOT NULL,
  created_by             UUID        NOT NULL REFERENCES users(id),
  shade                  TEXT,
  specifications         JSONB       NOT NULL DEFAULT '{}',
  pickup_date            DATE,
  expected_delivery_date DATE,
  lab_cost               NUMERIC(10,2),
  status                 TEXT        NOT NULL DEFAULT 'created'
                         CHECK (status IN (
                           'created','picked_up','in_progress',
                           'delivered','trial_returned','completed','cancelled'
                         )),
  trial_sessions_count   INTEGER     NOT NULL DEFAULT 0,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lab_order_session ON lab_order(session_id);
CREATE INDEX IF NOT EXISTS idx_lab_order_service ON lab_order(service_id);
