CREATE TABLE IF NOT EXISTS investigation_order (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  clinic_id           UUID        NOT NULL,
  ordered_by          UUID        NOT NULL REFERENCES users(id),
  kind                TEXT        NOT NULL,
  tooth_numbers       INTEGER[],
  cbct_fov            TEXT        CHECK (cbct_fov IN ('small','medium','large')),
  vendor              TEXT,
  clinical_indication TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'ORDERED'
                                  CHECK (status IN ('ORDERED','RECEIVED','READ','CANCELLED')),
  s3_key              TEXT,
  interpretation      TEXT,
  received_at         TIMESTAMPTZ,
  vendor_report_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_investigation_session
  ON investigation_order(session_id);
CREATE INDEX IF NOT EXISTS idx_investigation_clinic
  ON investigation_order(clinic_id, created_at DESC);
