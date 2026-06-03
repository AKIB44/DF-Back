-- Migration 041: Orthodontics Foundation (P-S1)
-- Creates ortho-specific detail tables, logs, and triggers

-- ── ortho_case_detail ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_case_detail (
  case_id                   UUID PRIMARY KEY REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                    UUID NOT NULL REFERENCES organizations(id),
  clinic_id                 UUID NOT NULL REFERENCES clinics(id),
  appliance_type            TEXT,
  angle_class_molar         TEXT,
  angle_class_canine        TEXT,
  overjet_mm                NUMERIC(4,2),
  overbite_mm               NUMERIC(4,2),
  open_bite                 BOOLEAN DEFAULT FALSE,
  crowding_upper_mm         NUMERIC(4,2),
  crowding_lower_mm         NUMERIC(4,2),
  spacing_upper_mm          NUMERIC(4,2),
  spacing_lower_mm          NUMERIC(4,2),
  extraction_plan           JSONB NOT NULL DEFAULT '[]',
  expected_duration_months  INT,
  treatment_objectives      TEXT,
  mechanics_notes           TEXT,
  current_phase             TEXT NOT NULL DEFAULT 'RECORDS',
  slot_size                 TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID NOT NULL REFERENCES users(id),
  updated_by                UUID NOT NULL REFERENCES users(id)
);

CREATE OR REPLACE FUNCTION set_ortho_case_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_case_detail_updated_at ON ortho_case_detail;
CREATE TRIGGER trg_ortho_case_detail_updated_at
  BEFORE UPDATE ON ortho_case_detail
  FOR EACH ROW EXECUTE FUNCTION set_ortho_case_detail_updated_at();

-- ── ortho_visit_detail ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_visit_detail (
  visit_id                   UUID PRIMARY KEY REFERENCES specialty_visit(id) ON DELETE CASCADE,
  org_id                     UUID NOT NULL REFERENCES organizations(id),
  clinic_id                  UUID NOT NULL REFERENCES clinics(id),
  case_id                    UUID NOT NULL REFERENCES specialty_case(id),
  phase                      TEXT,
  archwire_upper             TEXT,
  archwire_lower             TEXT,
  archwire_changed_upper     BOOLEAN NOT NULL DEFAULT FALSE,
  archwire_changed_lower     BOOLEAN NOT NULL DEFAULT FALSE,
  elastics_config            JSONB,
  compliance_self_report     JSONB,
  oral_hygiene_score         SMALLINT,
  next_interval_weeks        INT,
  visit_summary              TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                 UUID NOT NULL REFERENCES users(id),
  updated_by                 UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ortho_visit_case ON ortho_visit_detail(case_id);

CREATE OR REPLACE FUNCTION set_ortho_visit_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_visit_detail_updated_at ON ortho_visit_detail;
CREATE TRIGGER trg_ortho_visit_detail_updated_at
  BEFORE UPDATE ON ortho_visit_detail
  FOR EACH ROW EXECUTE FUNCTION set_ortho_visit_detail_updated_at();

-- ── ortho_archwire_log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_archwire_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id),
  case_id          UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id         UUID REFERENCES specialty_visit(id) ON DELETE SET NULL,
  arch             TEXT NOT NULL CHECK (arch IN ('UPPER', 'LOWER')),
  wire_description TEXT,
  placed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at       TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID NOT NULL REFERENCES users(id),
  updated_by       UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ortho_archwire_case ON ortho_archwire_log(case_id, arch);

CREATE OR REPLACE FUNCTION set_ortho_archwire_log_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_archwire_log_updated_at ON ortho_archwire_log;
CREATE TRIGGER trg_ortho_archwire_log_updated_at
  BEFORE UPDATE ON ortho_archwire_log
  FOR EACH ROW EXECUTE FUNCTION set_ortho_archwire_log_updated_at();

-- ── ortho_elastic_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_elastic_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  clinic_id         UUID NOT NULL REFERENCES clinics(id),
  case_id           UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id          UUID REFERENCES specialty_visit(id) ON DELETE SET NULL,
  configuration     JSONB NOT NULL DEFAULT '{}',
  prescribed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  discontinued_at   TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID NOT NULL REFERENCES users(id),
  updated_by        UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ortho_elastic_case ON ortho_elastic_log(case_id);

CREATE OR REPLACE FUNCTION set_ortho_elastic_log_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_elastic_log_updated_at ON ortho_elastic_log;
CREATE TRIGGER trg_ortho_elastic_log_updated_at
  BEFORE UPDATE ON ortho_elastic_log
  FOR EACH ROW EXECUTE FUNCTION set_ortho_elastic_log_updated_at();

-- ── ortho_retention_plan ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_retention_plan (
  case_id                UUID PRIMARY KEY REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                 UUID NOT NULL REFERENCES organizations(id),
  clinic_id              UUID NOT NULL REFERENCES clinics(id),
  fixed_upper            BOOLEAN NOT NULL DEFAULT FALSE,
  fixed_lower            BOOLEAN NOT NULL DEFAULT FALSE,
  removable_type         TEXT,
  wear_schedule          TEXT,
  recall_cadence_months  INT NOT NULL DEFAULT 6,
  retention_started_at   TIMESTAMPTZ,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID NOT NULL REFERENCES users(id),
  updated_by             UUID NOT NULL REFERENCES users(id)
);

CREATE OR REPLACE FUNCTION set_ortho_retention_plan_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_retention_plan_updated_at ON ortho_retention_plan;
CREATE TRIGGER trg_ortho_retention_plan_updated_at
  BEFORE UPDATE ON ortho_retention_plan
  FOR EACH ROW EXECUTE FUNCTION set_ortho_retention_plan_updated_at();

-- ── ortho_compliance_record ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_compliance_record (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     UUID NOT NULL REFERENCES organizations(id),
  clinic_id                  UUID NOT NULL REFERENCES clinics(id),
  case_id                    UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id                   UUID REFERENCES specialty_visit(id) ON DELETE SET NULL,
  source                     TEXT NOT NULL DEFAULT 'CLINICAL',
  reporting_period_start     DATE,
  reporting_period_end       DATE,
  aligner_hours_per_day_avg  NUMERIC(4,2),
  elastic_compliance         TEXT,
  oh_score                   SMALLINT,
  notes                      TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                 UUID NOT NULL REFERENCES users(id),
  updated_by                 UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ortho_compliance_case ON ortho_compliance_record(case_id);

CREATE OR REPLACE FUNCTION set_ortho_compliance_record_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_compliance_record_updated_at ON ortho_compliance_record;
CREATE TRIGGER trg_ortho_compliance_record_updated_at
  BEFORE UPDATE ON ortho_compliance_record
  FOR EACH ROW EXECUTE FUNCTION set_ortho_compliance_record_updated_at();

-- ── ortho_aligner_tray_log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ortho_aligner_tray_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  clinic_id             UUID NOT NULL REFERENCES clinics(id),
  case_id               UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id              UUID REFERENCES specialty_visit(id) ON DELETE SET NULL,
  tray_number           INT NOT NULL,
  arch                  TEXT NOT NULL DEFAULT 'BOTH',
  prescribed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expected_completed_at TIMESTAMPTZ,
  actual_completed_at   TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID NOT NULL REFERENCES users(id),
  updated_by            UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ortho_tray_case ON ortho_aligner_tray_log(case_id);

CREATE OR REPLACE FUNCTION set_ortho_aligner_tray_log_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_aligner_tray_log_updated_at ON ortho_aligner_tray_log;
CREATE TRIGGER trg_ortho_aligner_tray_log_updated_at
  BEFORE UPDATE ON ortho_aligner_tray_log
  FOR EACH ROW EXECUTE FUNCTION set_ortho_aligner_tray_log_updated_at();

-- ── Archwire auto-log trigger on ortho_visit_detail ───────────────────────────
-- When archwire_changed_upper = TRUE: close previous active UPPER wire and
-- insert a new row in ortho_archwire_log. Same logic for LOWER.
CREATE OR REPLACE FUNCTION trg_ortho_visit_archwire_log_fn()
RETURNS TRIGGER AS $$
DECLARE
  v_org_id    UUID;
  v_clinic_id UUID;
  v_case_id   UUID;
  v_created_by UUID;
BEGIN
  -- Fetch scoping from the visit detail record (NEW)
  v_org_id     := NEW.org_id;
  v_clinic_id  := NEW.clinic_id;
  v_case_id    := NEW.case_id;
  v_created_by := NEW.created_by;

  -- UPPER archwire changed
  IF NEW.archwire_changed_upper = TRUE AND NEW.archwire_upper IS NOT NULL THEN
    -- Close any active UPPER wire for this case
    UPDATE ortho_archwire_log
       SET removed_at = NOW(), updated_at = NOW(), updated_by = v_created_by
     WHERE case_id = v_case_id
       AND arch = 'UPPER'
       AND removed_at IS NULL;

    -- Insert new UPPER wire log
    INSERT INTO ortho_archwire_log
      (org_id, clinic_id, case_id, visit_id, arch, wire_description, placed_at, created_by, updated_by)
    VALUES
      (v_org_id, v_clinic_id, v_case_id, NEW.visit_id, 'UPPER', NEW.archwire_upper, NOW(), v_created_by, v_created_by);
  END IF;

  -- LOWER archwire changed
  IF NEW.archwire_changed_lower = TRUE AND NEW.archwire_lower IS NOT NULL THEN
    -- Close any active LOWER wire for this case
    UPDATE ortho_archwire_log
       SET removed_at = NOW(), updated_at = NOW(), updated_by = v_created_by
     WHERE case_id = v_case_id
       AND arch = 'LOWER'
       AND removed_at IS NULL;

    -- Insert new LOWER wire log
    INSERT INTO ortho_archwire_log
      (org_id, clinic_id, case_id, visit_id, arch, wire_description, placed_at, created_by, updated_by)
    VALUES
      (v_org_id, v_clinic_id, v_case_id, NEW.visit_id, 'LOWER', NEW.archwire_lower, NOW(), v_created_by, v_created_by);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_visit_archwire_log ON ortho_visit_detail;
CREATE TRIGGER trg_ortho_visit_archwire_log
  AFTER INSERT OR UPDATE ON ortho_visit_detail
  FOR EACH ROW EXECUTE FUNCTION trg_ortho_visit_archwire_log_fn();
