-- Migration 043: Implantology module foundation tables

CREATE TABLE IF NOT EXISTS implant_case_detail (
  case_id                  UUID PRIMARY KEY REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  clinic_id                UUID NOT NULL REFERENCES clinics(id),
  protocol                 TEXT NOT NULL DEFAULT 'SINGLE_TOOTH',
  is_two_stage             BOOLEAN NOT NULL DEFAULT TRUE,
  same_day_loading         BOOLEAN NOT NULL DEFAULT FALSE,
  current_stage            TEXT NOT NULL DEFAULT 'PLANNING',
  planned_fixture_count    INT NOT NULL DEFAULT 1 CHECK (planned_fixture_count > 0),
  planned_prosthesis_type  TEXT,
  bone_quality_d_class     TEXT,
  needs_bone_graft         BOOLEAN NOT NULL DEFAULT FALSE,
  needs_sinus_lift         BOOLEAN NOT NULL DEFAULT FALSE,
  sinus_lift_side          TEXT,
  surgeon_id               UUID REFERENCES users(id),
  prosthodontist_id        UUID REFERENCES users(id),
  planning_notes           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID NOT NULL REFERENCES users(id),
  updated_by               UUID NOT NULL REFERENCES users(id),
  deleted_at               TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION set_implant_case_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_implant_case_detail_updated_at ON implant_case_detail;
CREATE TRIGGER trg_implant_case_detail_updated_at
  BEFORE UPDATE ON implant_case_detail
  FOR EACH ROW EXECUTE FUNCTION set_implant_case_detail_updated_at();

-- ── implant_fixture ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS implant_fixture (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  patient_id            UUID NOT NULL REFERENCES patients(id),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  clinic_id             UUID NOT NULL REFERENCES clinics(id),
  brand                 TEXT NOT NULL,
  system                TEXT NOT NULL,
  diameter_mm           NUMERIC(4,2) NOT NULL,
  length_mm             NUMERIC(4,1) NOT NULL,
  surface               TEXT,
  lot_number            TEXT NOT NULL,
  expiry_date           DATE NOT NULL,
  scanned_barcode       TEXT,
  fdi_position          SMALLINT NOT NULL,
  placement_visit_id    UUID REFERENCES specialty_visit(id),
  placed_at             TIMESTAMPTZ,
  placed_by             UUID REFERENCES users(id),
  insertion_torque_ncm  NUMERIC(5,1),
  primary_stability_isq NUMERIC(4,1),
  bone_density          TEXT,
  technique             TEXT,
  immediate_loading     BOOLEAN NOT NULL DEFAULT FALSE,
  status                TEXT NOT NULL DEFAULT 'PLANNED',
  failed_at             TIMESTAMPTZ,
  failure_reason        TEXT,
  explanted_at          TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID NOT NULL REFERENCES users(id),
  updated_by            UUID NOT NULL REFERENCES users(id),
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_implant_fixture_case    ON implant_fixture(case_id);
CREATE INDEX IF NOT EXISTS idx_implant_fixture_patient ON implant_fixture(patient_id);
CREATE INDEX IF NOT EXISTS idx_implant_fixture_lot     ON implant_fixture(lot_number);

CREATE OR REPLACE FUNCTION set_implant_fixture_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_implant_fixture_updated_at ON implant_fixture;
CREATE TRIGGER trg_implant_fixture_updated_at
  BEFORE UPDATE ON implant_fixture
  FOR EACH ROW EXECUTE FUNCTION set_implant_fixture_updated_at();

-- ── implant_visit_detail ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS implant_visit_detail (
  visit_id            UUID PRIMARY KEY REFERENCES specialty_visit(id) ON DELETE CASCADE,
  case_id             UUID NOT NULL REFERENCES specialty_case(id),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  stage               TEXT NOT NULL,
  planned_next_stage  TEXT,
  next_interval_weeks INT,
  visit_notes         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID NOT NULL REFERENCES users(id),
  updated_by          UUID NOT NULL REFERENCES users(id),
  deleted_at          TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION set_implant_visit_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_implant_visit_detail_updated_at ON implant_visit_detail;
CREATE TRIGGER trg_implant_visit_detail_updated_at
  BEFORE UPDATE ON implant_visit_detail
  FOR EACH ROW EXECUTE FUNCTION set_implant_visit_detail_updated_at();

-- ── implant_prosthesis ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS implant_prosthesis (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id              UUID NOT NULL REFERENCES organizations(id),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  kind                TEXT NOT NULL,
  arch                TEXT,
  material            TEXT,
  status              TEXT NOT NULL DEFAULT 'DESIGN',
  impression_method   TEXT,
  shade               TEXT,
  delivered_at        TIMESTAMPTZ,
  warranty_months     INT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID NOT NULL REFERENCES users(id),
  updated_by          UUID NOT NULL REFERENCES users(id),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_implant_prosthesis_case ON implant_prosthesis(case_id);

CREATE OR REPLACE FUNCTION set_implant_prosthesis_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_implant_prosthesis_updated_at ON implant_prosthesis;
CREATE TRIGGER trg_implant_prosthesis_updated_at
  BEFORE UPDATE ON implant_prosthesis
  FOR EACH ROW EXECUTE FUNCTION set_implant_prosthesis_updated_at();

-- ── implant_complication ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS implant_complication (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id          UUID REFERENCES implant_fixture(id),
  case_id             UUID NOT NULL REFERENCES specialty_case(id),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  kind                TEXT NOT NULL,
  severity            TEXT NOT NULL DEFAULT 'MINOR',
  identified_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  identified_by       UUID NOT NULL REFERENCES users(id),
  action_taken        TEXT NOT NULL,
  resolved_at         TIMESTAMPTZ,
  outcome             TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID NOT NULL REFERENCES users(id),
  updated_by          UUID NOT NULL REFERENCES users(id),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_implant_complication_case ON implant_complication(case_id);

CREATE OR REPLACE FUNCTION set_implant_complication_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_implant_complication_updated_at ON implant_complication;
CREATE TRIGGER trg_implant_complication_updated_at
  BEFORE UPDATE ON implant_complication
  FOR EACH ROW EXECUTE FUNCTION set_implant_complication_updated_at();

-- ── implant_maintenance_visit ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS implant_maintenance_visit (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                  UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  clinic_id                UUID NOT NULL REFERENCES clinics(id),
  scheduled_at             DATE,
  attended_at              TIMESTAMPTZ,
  attended                 BOOLEAN NOT NULL DEFAULT FALSE,
  professional_clean       BOOLEAN NOT NULL DEFAULT FALSE,
  radiographic_review      BOOLEAN NOT NULL DEFAULT FALSE,
  oral_hygiene_score       SMALLINT,
  bleeding_on_probing      BOOLEAN,
  next_recall_at           DATE,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID NOT NULL REFERENCES users(id),
  updated_by               UUID NOT NULL REFERENCES users(id),
  deleted_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_implant_maintenance_case ON implant_maintenance_visit(case_id, scheduled_at);

CREATE OR REPLACE FUNCTION set_implant_maintenance_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_implant_maintenance_updated_at ON implant_maintenance_visit;
CREATE TRIGGER trg_implant_maintenance_updated_at
  BEFORE UPDATE ON implant_maintenance_visit
  FOR EACH ROW EXECUTE FUNCTION set_implant_maintenance_updated_at();
