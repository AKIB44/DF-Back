-- Migration 031: Post-operative record

CREATE TABLE postop_record (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id                   UUID        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  session_id                  UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,

  -- Complications (array of { type, severity, action_taken })
  complications               JSONB       NOT NULL DEFAULT '[]',

  -- Sutures
  suture_count                INT,
  suture_type                 TEXT        CHECK (suture_type IN ('resorbable','non-resorbable')),
  suture_removal_date         DATE,

  -- Specimen
  specimen_sent               BOOLEAN     NOT NULL DEFAULT false,
  specimen_lab_id             TEXT,
  specimen_request_slip_no    TEXT,
  specimen_expected_report_date DATE,

  -- Recovery vitals series (array of { time, bp_sys, bp_dia, pulse, spo2 })
  recovery_vitals             JSONB       NOT NULL DEFAULT '[]',

  -- Post-op instructions
  postop_instructions_given   BOOLEAN     NOT NULL DEFAULT false,
  postop_instructions_text    TEXT,
  patient_acknowledged_at     TIMESTAMPTZ,

  -- Follow-up
  follow_up_date              DATE,
  follow_up_notes             TEXT,

  -- Status
  notes                       TEXT,
  created_by                  UUID        REFERENCES users(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (session_id)
);
CREATE INDEX idx_postop_session ON postop_record(session_id);
