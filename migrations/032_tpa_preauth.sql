-- Migration 032: TPA / Insurance pre-authorisation (T6.6)

CREATE TABLE tpa_preauth (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id           UUID        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  session_id          UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patients(id),

  insurer_name        TEXT        NOT NULL,
  policy_number       TEXT,
  preauth_number      TEXT,
  approved_amount     NUMERIC(12,2),
  approved_services   JSONB       NOT NULL DEFAULT '[]',
  copay_pct           NUMERIC(5,2) NOT NULL DEFAULT 0,
  copay_flat          NUMERIC(10,2) NOT NULL DEFAULT 0,

  status              TEXT        NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','PARTIALLY_APPROVED','REJECTED','CANCELLED')),
  submitted_at        TIMESTAMPTZ,
  responded_at        TIMESTAMPTZ,
  rejection_reason    TEXT,
  notes               TEXT,

  created_by          UUID        REFERENCES users(id),
  updated_by          UUID        REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tpa_preauth_session ON tpa_preauth(session_id);
CREATE INDEX idx_tpa_preauth_patient ON tpa_preauth(patient_id);
