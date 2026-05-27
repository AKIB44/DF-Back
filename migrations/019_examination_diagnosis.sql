-- Migration 019: examination and diagnosis tables (Phase 2 — T2.2, T2.3)

-- ── examination (one row per session, upserted) ───────────────────────────────
CREATE TABLE IF NOT EXISTS examination (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  session_id          UUID NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  chief_complaint     TEXT NOT NULL DEFAULT '',
  pain_score          SMALLINT CHECK (pain_score IS NULL OR (pain_score >= 0 AND pain_score <= 10)),
  pain_site           TEXT,
  pain_trigger        TEXT CHECK (pain_trigger IN ('cold','hot','sweet','biting','spontaneous','none') OR pain_trigger IS NULL),
  intraoral_findings  JSONB NOT NULL DEFAULT '{}',
  extraoral_findings  JSONB NOT NULL DEFAULT '{}',
  soft_tissue_findings JSONB NOT NULL DEFAULT '{}',
  occlusion_notes     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID NOT NULL REFERENCES users(id),
  updated_by          UUID NOT NULL REFERENCES users(id),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_session ON examination(session_id);

CREATE OR REPLACE FUNCTION set_examination_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exam_updated_at ON examination;
CREATE TRIGGER trg_exam_updated_at
  BEFORE UPDATE ON examination
  FOR EACH ROW EXECUTE FUNCTION set_examination_updated_at();

-- ── diagnosis (many per session) ──────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE diagnosis_kind AS ENUM ('provisional', 'differential', 'final');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS diagnosis (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  clinic_id       UUID NOT NULL REFERENCES clinics(id),
  session_id      UUID NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  diagnosis_text  TEXT NOT NULL,
  icd10_code      VARCHAR(10),
  tooth_numbers   SMALLINT[],
  kind            diagnosis_kind NOT NULL DEFAULT 'provisional',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID NOT NULL REFERENCES users(id),
  updated_by      UUID NOT NULL REFERENCES users(id),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_session ON diagnosis(session_id);
