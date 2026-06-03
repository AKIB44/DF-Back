-- Migration 049: TMJ & Orofacial Pain module foundation tables

CREATE TABLE IF NOT EXISTS tmj_case_detail (
  case_id                   UUID PRIMARY KEY REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                    UUID NOT NULL REFERENCES organizations(id),
  clinic_id                 UUID NOT NULL REFERENCES clinics(id),
  chief_complaint           TEXT NOT NULL,
  pain_onset_date           DATE,
  pain_onset_circumstance   TEXT,
  pain_duration             TEXT,
  suspected_axis_i          TEXT,
  confirmed_axis_i          TEXT[],
  contributing_factors      JSONB,
  past_treatments_attempted TEXT,
  current_phase             TEXT NOT NULL DEFAULT 'INITIAL_EVALUATION',
  primary_doctor_id         UUID REFERENCES users(id),
  expected_review_weeks     INT NOT NULL DEFAULT 4,
  case_summary              TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID NOT NULL REFERENCES users(id),
  updated_by                UUID NOT NULL REFERENCES users(id),
  deleted_at                TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION set_tmj_case_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tmj_case_detail_updated_at ON tmj_case_detail;
CREATE TRIGGER trg_tmj_case_detail_updated_at
  BEFORE UPDATE ON tmj_case_detail
  FOR EACH ROW EXECUTE FUNCTION set_tmj_case_detail_updated_at();

-- ── tmj_joint_finding ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tmj_joint_finding (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id      UUID NOT NULL REFERENCES specialty_visit(id),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  side          TEXT NOT NULL CHECK (side IN ('RIGHT', 'LEFT')),
  joint_sound   TEXT NOT NULL DEFAULT 'NONE',
  locking       TEXT NOT NULL DEFAULT 'NONE',
  tenderness    TEXT NOT NULL DEFAULT 'NONE',
  swelling      BOOLEAN NOT NULL DEFAULT FALSE,
  warmth        BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID NOT NULL REFERENCES users(id),
  updated_by    UUID NOT NULL REFERENCES users(id),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (visit_id, side)
);
CREATE INDEX IF NOT EXISTS idx_tmj_joint_case ON tmj_joint_finding(case_id);

CREATE OR REPLACE FUNCTION set_tmj_joint_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tmj_joint_updated_at ON tmj_joint_finding;
CREATE TRIGGER trg_tmj_joint_updated_at
  BEFORE UPDATE ON tmj_joint_finding
  FOR EACH ROW EXECUTE FUNCTION set_tmj_joint_updated_at();

-- ── tmj_rom_measurement ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tmj_rom_measurement (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id             UUID REFERENCES specialty_visit(id),
  org_id               UUID NOT NULL REFERENCES organizations(id),
  clinic_id            UUID NOT NULL REFERENCES clinics(id),
  measured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mio_unassisted_mm    NUMERIC(4,1),
  mio_assisted_mm      NUMERIC(4,1),
  pain_free_opening_mm NUMERIC(4,1),
  right_lateral_mm     NUMERIC(4,1),
  left_lateral_mm      NUMERIC(4,1),
  protrusive_mm        NUMERIC(4,1),
  opening_deviation    TEXT,
  opening_pain         SMALLINT CHECK (opening_pain BETWEEN 0 AND 10),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID NOT NULL REFERENCES users(id),
  updated_by           UUID NOT NULL REFERENCES users(id),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tmj_rom_case ON tmj_rom_measurement(case_id, measured_at);

CREATE OR REPLACE FUNCTION set_tmj_rom_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tmj_rom_updated_at ON tmj_rom_measurement;
CREATE TRIGGER trg_tmj_rom_updated_at
  BEFORE UPDATE ON tmj_rom_measurement
  FOR EACH ROW EXECUTE FUNCTION set_tmj_rom_updated_at();

-- ── tmj_pain_record ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tmj_pain_record (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id             UUID REFERENCES specialty_visit(id),
  org_id               UUID NOT NULL REFERENCES organizations(id),
  clinic_id            UUID NOT NULL REFERENCES clinics(id),
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source               TEXT NOT NULL DEFAULT 'CLINICAL_VISIT',
  intensity_now        SMALLINT CHECK (intensity_now BETWEEN 0 AND 10),
  intensity_max_24h    SMALLINT CHECK (intensity_max_24h BETWEEN 0 AND 10),
  intensity_avg_24h    SMALLINT CHECK (intensity_avg_24h BETWEEN 0 AND 10),
  sites                JSONB,
  character            TEXT[],
  triggers             TEXT[],
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID NOT NULL REFERENCES users(id),
  updated_by           UUID NOT NULL REFERENCES users(id),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tmj_pain_case ON tmj_pain_record(case_id, recorded_at);

CREATE OR REPLACE FUNCTION set_tmj_pain_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tmj_pain_updated_at ON tmj_pain_record;
CREATE TRIGGER trg_tmj_pain_updated_at
  BEFORE UPDATE ON tmj_pain_record
  FOR EACH ROW EXECUTE FUNCTION set_tmj_pain_updated_at();

-- ── tmj_splint ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tmj_splint (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES organizations(id),
  clinic_id         UUID NOT NULL REFERENCES clinics(id),
  kind              TEXT NOT NULL DEFAULT 'STABILISATION_FULL_COVERAGE',
  arch              TEXT NOT NULL CHECK (arch IN ('UPPER', 'LOWER', 'BOTH')),
  prescribed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prescribed_by     UUID NOT NULL REFERENCES users(id),
  rationale         TEXT,
  material          TEXT,
  wear_schedule     TEXT,
  status            TEXT NOT NULL DEFAULT 'PRESCRIBED',
  delivered_at      TIMESTAMPTZ,
  discontinued_at   TIMESTAMPTZ,
  outcome           TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID NOT NULL REFERENCES users(id),
  updated_by        UUID NOT NULL REFERENCES users(id),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tmj_splint_case ON tmj_splint(case_id);

CREATE OR REPLACE FUNCTION set_tmj_splint_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tmj_splint_updated_at ON tmj_splint;
CREATE TRIGGER trg_tmj_splint_updated_at
  BEFORE UPDATE ON tmj_splint
  FOR EACH ROW EXECUTE FUNCTION set_tmj_splint_updated_at();

-- ── tmj_diary_entry ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tmj_diary_entry (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id            UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id             UUID NOT NULL REFERENCES organizations(id),
  clinic_id          UUID NOT NULL REFERENCES clinics(id),
  entry_date         DATE NOT NULL,
  pain_morning       SMALLINT CHECK (pain_morning BETWEEN 0 AND 10),
  pain_afternoon     SMALLINT CHECK (pain_afternoon BETWEEN 0 AND 10),
  pain_evening       SMALLINT CHECK (pain_evening BETWEEN 0 AND 10),
  worst_today        SMALLINT CHECK (worst_today BETWEEN 0 AND 10),
  sleep_disturbed    BOOLEAN,
  jaw_locking_episode BOOLEAN,
  medication_taken   JSONB,
  major_triggers     TEXT[],
  free_text          TEXT,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submission_channel TEXT NOT NULL DEFAULT 'WEB_FORM',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ,
  UNIQUE (case_id, entry_date)
);
CREATE INDEX IF NOT EXISTS idx_tmj_diary_case ON tmj_diary_entry(case_id, entry_date);
