-- Migration 045: Paediatric Dentistry module foundation tables

CREATE TABLE IF NOT EXISTS paedo_case_detail (
  case_id                  UUID PRIMARY KEY REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  clinic_id                UUID NOT NULL REFERENCES clinics(id),
  registration_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  referral_source          TEXT,
  developmental_status     TEXT NOT NULL DEFAULT 'TYPICAL',
  developmental_notes      TEXT,
  medical_alerts           JSONB,
  paediatrician_name       TEXT,
  preferred_language       TEXT,
  custody_arrangement      TEXT,
  custody_notes            TEXT,
  consent_authority_notes  TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID NOT NULL REFERENCES users(id),
  updated_by               UUID NOT NULL REFERENCES users(id),
  deleted_at               TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION set_paedo_case_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paedo_case_detail_updated_at ON paedo_case_detail;
CREATE TRIGGER trg_paedo_case_detail_updated_at
  BEFORE UPDATE ON paedo_case_detail
  FOR EACH ROW EXECUTE FUNCTION set_paedo_case_detail_updated_at();

-- ── paedo_guardian ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paedo_guardian (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                 UUID NOT NULL REFERENCES organizations(id),
  clinic_id              UUID NOT NULL REFERENCES clinics(id),
  name                   TEXT NOT NULL,
  relationship           TEXT NOT NULL DEFAULT 'PARENT',
  is_primary             BOOLEAN NOT NULL DEFAULT FALSE,
  can_consent_medical    BOOLEAN NOT NULL DEFAULT TRUE,
  can_consent_financial  BOOLEAN NOT NULL DEFAULT TRUE,
  can_collect_child      BOOLEAN NOT NULL DEFAULT TRUE,
  phone                  TEXT,
  email                  TEXT,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID NOT NULL REFERENCES users(id),
  updated_by             UUID NOT NULL REFERENCES users(id),
  deleted_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paedo_guardian_case ON paedo_guardian(case_id);

CREATE OR REPLACE FUNCTION set_paedo_guardian_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paedo_guardian_updated_at ON paedo_guardian;
CREATE TRIGGER trg_paedo_guardian_updated_at
  BEFORE UPDATE ON paedo_guardian
  FOR EACH ROW EXECUTE FUNCTION set_paedo_guardian_updated_at();

-- ── paedo_behaviour_assessment ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paedo_behaviour_assessment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id            UUID NOT NULL REFERENCES specialty_visit(id),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  frankl_rating       TEXT NOT NULL DEFAULT 'F3_POSITIVE',
  pre_visit_anxiety   SMALLINT CHECK (pre_visit_anxiety BETWEEN 0 AND 10),
  techniques_used     TEXT[] NOT NULL DEFAULT '{}',
  techniques_effective TEXT,
  guardian_present    BOOLEAN NOT NULL DEFAULT TRUE,
  outcome_notes       TEXT,
  next_visit_strategy TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID NOT NULL REFERENCES users(id),
  updated_by          UUID NOT NULL REFERENCES users(id),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paedo_behaviour_case ON paedo_behaviour_assessment(case_id);

CREATE OR REPLACE FUNCTION set_paedo_behaviour_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paedo_behaviour_updated_at ON paedo_behaviour_assessment;
CREATE TRIGGER trg_paedo_behaviour_updated_at
  BEFORE UPDATE ON paedo_behaviour_assessment
  FOR EACH ROW EXECUTE FUNCTION set_paedo_behaviour_updated_at();

-- ── paedo_growth_measurement ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paedo_growth_measurement (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id         UUID REFERENCES specialty_visit(id),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id),
  measured_at      DATE NOT NULL DEFAULT CURRENT_DATE,
  height_cm        NUMERIC(5,1),
  weight_kg        NUMERIC(5,1),
  age_months       INT NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID NOT NULL REFERENCES users(id),
  updated_by       UUID NOT NULL REFERENCES users(id),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paedo_growth_case ON paedo_growth_measurement(case_id, measured_at);

CREATE OR REPLACE FUNCTION set_paedo_growth_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paedo_growth_updated_at ON paedo_growth_measurement;
CREATE TRIGGER trg_paedo_growth_updated_at
  BEFORE UPDATE ON paedo_growth_measurement
  FOR EACH ROW EXECUTE FUNCTION set_paedo_growth_updated_at();

-- ── paedo_eruption_record ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paedo_eruption_norm (
  fdi_tooth           SMALLINT PRIMARY KEY,
  expected_min_months INT NOT NULL,
  expected_max_months INT NOT NULL,
  tooth_name          TEXT
);

-- Seed eruption norms (IAP reference data)
INSERT INTO paedo_eruption_norm (fdi_tooth, expected_min_months, expected_max_months, tooth_name) VALUES
  (11, 84,  96,  'Upper right central incisor'),
  (12, 96,  108, 'Upper right lateral incisor'),
  (13, 132, 156, 'Upper right canine'),
  (14, 120, 132, 'Upper right first premolar'),
  (15, 132, 144, 'Upper right second premolar'),
  (16, 72,  84,  'Upper right first molar'),
  (17, 144, 168, 'Upper right second molar'),
  (21, 84,  96,  'Upper left central incisor'),
  (22, 96,  108, 'Upper left lateral incisor'),
  (23, 132, 156, 'Upper left canine'),
  (24, 120, 132, 'Upper left first premolar'),
  (25, 132, 144, 'Upper left second premolar'),
  (26, 72,  84,  'Upper left first molar'),
  (27, 144, 168, 'Upper left second molar'),
  (31, 72,  84,  'Lower left central incisor'),
  (32, 84,  96,  'Lower left lateral incisor'),
  (33, 108, 132, 'Lower left canine'),
  (34, 120, 132, 'Lower left first premolar'),
  (35, 132, 144, 'Lower left second premolar'),
  (36, 72,  84,  'Lower left first molar'),
  (37, 132, 168, 'Lower left second molar'),
  (41, 72,  84,  'Lower right central incisor'),
  (42, 84,  96,  'Lower right lateral incisor'),
  (43, 108, 132, 'Lower right canine'),
  (44, 120, 132, 'Lower right first premolar'),
  (45, 132, 144, 'Lower right second premolar'),
  (46, 72,  84,  'Lower right first molar'),
  (47, 132, 168, 'Lower right second molar')
ON CONFLICT (fdi_tooth) DO NOTHING;

CREATE TABLE IF NOT EXISTS paedo_eruption_record (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id         UUID REFERENCES specialty_visit(id),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id),
  fdi_tooth        SMALLINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'UNERUPTED',
  observed_at      DATE NOT NULL DEFAULT CURRENT_DATE,
  deviation_flag   TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID NOT NULL REFERENCES users(id),
  updated_by       UUID NOT NULL REFERENCES users(id),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paedo_eruption_case ON paedo_eruption_record(case_id, fdi_tooth);

CREATE OR REPLACE FUNCTION set_paedo_eruption_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paedo_eruption_updated_at ON paedo_eruption_record;
CREATE TRIGGER trg_paedo_eruption_updated_at
  BEFORE UPDATE ON paedo_eruption_record
  FOR EACH ROW EXECUTE FUNCTION set_paedo_eruption_updated_at();

-- ── paedo_caries_risk_assessment ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paedo_caries_risk_assessment (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id               UUID REFERENCES specialty_visit(id),
  org_id                 UUID NOT NULL REFERENCES organizations(id),
  clinic_id              UUID NOT NULL REFERENCES clinics(id),
  assessed_at            DATE NOT NULL DEFAULT CURRENT_DATE,
  risk_level             TEXT NOT NULL DEFAULT 'MODERATE',
  disease_indicators     JSONB,
  risk_factors           JSONB,
  protective_factors     JSONB,
  recommended_recall_months INT NOT NULL DEFAULT 6,
  prevention_plan        TEXT,
  next_assessment_at     DATE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID NOT NULL REFERENCES users(id),
  updated_by             UUID NOT NULL REFERENCES users(id),
  deleted_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paedo_caries_case ON paedo_caries_risk_assessment(case_id);

CREATE OR REPLACE FUNCTION set_paedo_caries_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_paedo_caries_updated_at ON paedo_caries_risk_assessment;
CREATE TRIGGER trg_paedo_caries_updated_at
  BEFORE UPDATE ON paedo_caries_risk_assessment
  FOR EACH ROW EXECUTE FUNCTION set_paedo_caries_updated_at();
