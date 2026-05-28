-- Migration 030: Pre-operative checklist record

CREATE TABLE preop_record (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id                    UUID        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  session_id                   UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,

  -- Vitals
  bp_systolic                  INT,
  bp_diastolic                 INT,
  pulse                        INT,
  spo2                         NUMERIC(5,2),
  temperature                  NUMERIC(5,2),
  blood_sugar                  NUMERIC(6,2),
  inr_value                    NUMERIC(5,2),

  -- Allergy & clearance
  allergies_confirmed_at       TIMESTAMPTZ,
  medical_clearance_url        TEXT,

  -- Antibiotic prophylaxis
  antibiotic_prophylaxis_given BOOLEAN     NOT NULL DEFAULT false,
  antibiotic_drug              TEXT,
  antibiotic_dose              TEXT,
  antibiotic_given_at          TIMESTAMPTZ,

  -- Anaesthesia
  npo_hours                    NUMERIC(4,1),
  anaesthesia_plan             TEXT        CHECK (anaesthesia_plan IN ('local','sedation','ga')) DEFAULT 'local',
  anaesthesia_agent            TEXT,
  anaesthesia_dose             TEXT,

  -- Surgical site
  surgical_site_marked         BOOLEAN     NOT NULL DEFAULT false,

  -- Override (for out-of-range vitals)
  override_reason              TEXT,

  -- Status
  is_complete                  BOOLEAN     NOT NULL DEFAULT false,
  notes                        TEXT,
  completed_at                 TIMESTAMPTZ,
  completed_by                 UUID        REFERENCES users(id),
  created_by                   UUID        REFERENCES users(id),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (session_id)
);
CREATE INDEX idx_preop_session ON preop_record(session_id);
