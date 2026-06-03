-- Migration 038: Specialty Foundation (P-S0)
-- Creates specialty_case, specialty_visit, specialty_milestone tables

DO $$ BEGIN
  CREATE TYPE case_type AS ENUM ('ORTHO','IMPLANT','PAEDO','ENDO','TMJ');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE case_status AS ENUM ('ACTIVE','PAUSED','TRANSFERRED','ABANDONED','COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE milestone_kind AS ENUM (
    'CASE_OPENED','CASE_PAUSED','CASE_RESUMED','CASE_COMPLETED','CASE_TRANSFERRED','CASE_ABANDONED',
    'VISIT_COMPLETED','CLINICAL_NOTE','PHOTO_SERIES','STUDY_MODEL','CONSENT_OBTAINED',
    'APPLIANCE_FITTED','APPLIANCE_ADJUSTED','APPLIANCE_REMOVED',
    'IMPLANT_PLACED','IMPLANT_UNCOVERED','CROWN_FITTED',
    'CUSTOM'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS specialty_case (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations(id),
  clinic_id                 UUID NOT NULL REFERENCES clinics(id),
  patient_id                UUID NOT NULL REFERENCES patients(id),
  case_type                 case_type NOT NULL,
  status                    case_status NOT NULL DEFAULT 'ACTIVE',
  primary_doctor_id         UUID NOT NULL REFERENCES users(id),
  treatment_plan_id         UUID REFERENCES treatment_plan(id) ON DELETE SET NULL,
  started_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at              TIMESTAMPTZ,
  expected_duration_months  INT,
  case_summary              TEXT,
  external_case_no          TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID NOT NULL REFERENCES users(id),
  updated_by                UUID NOT NULL REFERENCES users(id),
  deleted_at                TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spec_case_patient   ON specialty_case(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_spec_case_org_clinic ON specialty_case(org_id, clinic_id, status);
CREATE INDEX IF NOT EXISTS idx_spec_case_doctor     ON specialty_case(primary_doctor_id);

CREATE OR REPLACE FUNCTION set_specialty_case_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_specialty_case_updated_at ON specialty_case;
CREATE TRIGGER trg_specialty_case_updated_at
  BEFORE UPDATE ON specialty_case
  FOR EACH ROW EXECUTE FUNCTION set_specialty_case_updated_at();


CREATE TABLE IF NOT EXISTS specialty_visit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  case_id       UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  session_id    UUID UNIQUE REFERENCES clinical_session(id) ON DELETE SET NULL,
  visit_number  INT NOT NULL DEFAULT 1 CHECK (visit_number > 0),
  visit_type    TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID NOT NULL REFERENCES users(id),
  updated_by    UUID NOT NULL REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spec_visit_case    ON specialty_visit(case_id);
CREATE INDEX IF NOT EXISTS idx_spec_visit_session ON specialty_visit(session_id);

CREATE OR REPLACE FUNCTION set_specialty_visit_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_specialty_visit_updated_at ON specialty_visit;
CREATE TRIGGER trg_specialty_visit_updated_at
  BEFORE UPDATE ON specialty_visit
  FOR EACH ROW EXECUTE FUNCTION set_specialty_visit_updated_at();


CREATE TABLE IF NOT EXISTS specialty_milestone (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  case_id      UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id     UUID REFERENCES specialty_visit(id) ON DELETE SET NULL,
  kind         milestone_kind NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  title        TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spec_milestone_case      ON specialty_milestone(case_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_spec_milestone_visit     ON specialty_milestone(visit_id);
CREATE INDEX IF NOT EXISTS idx_spec_milestone_org_clinic ON specialty_milestone(org_id, clinic_id);

CREATE OR REPLACE FUNCTION set_specialty_milestone_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_specialty_milestone_updated_at ON specialty_milestone;
CREATE TRIGGER trg_specialty_milestone_updated_at
  BEFORE UPDATE ON specialty_milestone
  FOR EACH ROW EXECUTE FUNCTION set_specialty_milestone_updated_at();
