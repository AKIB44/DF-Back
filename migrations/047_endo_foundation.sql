-- Migration 047: Endodontics module foundation tables

CREATE TABLE IF NOT EXISTS endo_case_detail (
  case_id                  UUID PRIMARY KEY REFERENCES specialty_case(id) ON DELETE CASCADE,
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  clinic_id                UUID NOT NULL REFERENCES clinics(id),
  fdi_tooth                SMALLINT NOT NULL,
  is_retreatment           BOOLEAN NOT NULL DEFAULT FALSE,
  is_apicoectomy           BOOLEAN NOT NULL DEFAULT FALSE,
  pulp_diagnosis           TEXT,
  periapical_diagnosis     TEXT,
  expected_canal_count     SMALLINT NOT NULL DEFAULT 1 CHECK (expected_canal_count BETWEEN 1 AND 6),
  actual_canal_count       SMALLINT,
  protocol                 TEXT NOT NULL DEFAULT 'SINGLE_VISIT',
  current_stage            TEXT NOT NULL DEFAULT 'DIAGNOSED',
  microscope_used          BOOLEAN NOT NULL DEFAULT FALSE,
  rubber_dam_used          BOOLEAN NOT NULL DEFAULT TRUE,
  primary_doctor_id        UUID REFERENCES users(id),
  presentation_notes       TEXT,
  treatment_rationale      TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID NOT NULL REFERENCES users(id),
  updated_by               UUID NOT NULL REFERENCES users(id),
  deleted_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_endo_case_tooth ON endo_case_detail(fdi_tooth);

CREATE OR REPLACE FUNCTION set_endo_case_detail_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_endo_case_detail_updated_at ON endo_case_detail;
CREATE TRIGGER trg_endo_case_detail_updated_at
  BEFORE UPDATE ON endo_case_detail
  FOR EACH ROW EXECUTE FUNCTION set_endo_case_detail_updated_at();

-- ── endo_canal_record ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS endo_canal_record (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                      UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id                     UUID NOT NULL REFERENCES specialty_visit(id),
  org_id                       UUID NOT NULL REFERENCES organizations(id),
  clinic_id                    UUID NOT NULL REFERENCES clinics(id),
  canal_designation            TEXT NOT NULL DEFAULT 'SINGLE',
  working_length_mm            NUMERIC(4,1),
  apex_locator_reading_mm      NUMERIC(4,1),
  master_apical_file_size      SMALLINT,
  taper_pct                    NUMERIC(4,2),
  rotary_system                TEXT,
  file_sequence                JSONB,
  irrigation_protocol          JSONB,
  intra_canal_medication       TEXT,
  obturation_technique         TEXT,
  obturation_length_mm         NUMERIC(4,1),
  sealer                       TEXT,
  master_cone_size             SMALLINT,
  status                       TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  complications                JSONB,
  notes                        TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                   UUID NOT NULL REFERENCES users(id),
  updated_by                   UUID NOT NULL REFERENCES users(id),
  deleted_at                   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_endo_canal_case            ON endo_canal_record(case_id);
CREATE INDEX IF NOT EXISTS idx_endo_canal_case_designation ON endo_canal_record(case_id, canal_designation);

CREATE OR REPLACE FUNCTION set_endo_canal_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_endo_canal_updated_at ON endo_canal_record;
CREATE TRIGGER trg_endo_canal_updated_at
  BEFORE UPDATE ON endo_canal_record
  FOR EACH ROW EXECUTE FUNCTION set_endo_canal_updated_at();

-- ── endo_post_op_followup ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS endo_post_op_followup (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                  UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id                 UUID REFERENCES specialty_visit(id),
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  clinic_id                UUID NOT NULL REFERENCES clinics(id),
  scheduled_for            TIMESTAMPTZ NOT NULL,
  interval_hours           SMALLINT NOT NULL DEFAULT 24,
  channel                  TEXT NOT NULL DEFAULT 'WHATSAPP',
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  sent_at                  TIMESTAMPTZ,
  responded_at             TIMESTAMPTZ,
  pain_score               SMALLINT CHECK (pain_score BETWEEN 0 AND 10),
  swelling                 BOOLEAN,
  taking_prescribed_medication BOOLEAN,
  any_concerns             TEXT,
  doctor_review_required   BOOLEAN NOT NULL DEFAULT FALSE,
  doctor_action            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID NOT NULL REFERENCES users(id),
  updated_by               UUID NOT NULL REFERENCES users(id),
  deleted_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_endo_followup_case    ON endo_post_op_followup(case_id);
CREATE INDEX IF NOT EXISTS idx_endo_followup_pending ON endo_post_op_followup(status, scheduled_for) WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION set_endo_followup_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_endo_followup_updated_at ON endo_post_op_followup;
CREATE TRIGGER trg_endo_followup_updated_at
  BEFORE UPDATE ON endo_post_op_followup
  FOR EACH ROW EXECUTE FUNCTION set_endo_followup_updated_at();

-- ── endo_recall ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS endo_recall (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID NOT NULL REFERENCES specialty_case(id) ON DELETE CASCADE,
  visit_id        UUID REFERENCES specialty_visit(id),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  clinic_id       UUID NOT NULL REFERENCES clinics(id),
  kind            TEXT NOT NULL,
  scheduled_for   DATE NOT NULL,
  attended        BOOLEAN NOT NULL DEFAULT FALSE,
  attended_at     TIMESTAMPTZ,
  healing_status  TEXT,
  symptoms_present BOOLEAN,
  doctor_decision TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID NOT NULL REFERENCES users(id),
  updated_by      UUID NOT NULL REFERENCES users(id),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_endo_recall_case ON endo_recall(case_id, scheduled_for);

CREATE OR REPLACE FUNCTION set_endo_recall_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_endo_recall_updated_at ON endo_recall;
CREATE TRIGGER trg_endo_recall_updated_at
  BEFORE UPDATE ON endo_recall
  FOR EACH ROW EXECUTE FUNCTION set_endo_recall_updated_at();

-- ── endo_canal_anatomy_reference ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS endo_canal_anatomy_reference (
  fdi_tooth        SMALLINT PRIMARY KEY,
  typical_count    SMALLINT NOT NULL DEFAULT 1,
  designations     TEXT[] NOT NULL DEFAULT '{"SINGLE"}'
);

INSERT INTO endo_canal_anatomy_reference (fdi_tooth, typical_count, designations) VALUES
  (11, 1, '{"SINGLE"}'), (12, 1, '{"SINGLE"}'), (13, 1, '{"SINGLE"}'),
  (14, 2, '{"BUCCAL","LINGUAL"}'), (15, 2, '{"BUCCAL","LINGUAL"}'),
  (16, 4, '{"MB","MB2","DB","P"}'), (17, 3, '{"MB","DB","P"}'),
  (21, 1, '{"SINGLE"}'), (22, 1, '{"SINGLE"}'), (23, 1, '{"SINGLE"}'),
  (24, 2, '{"BUCCAL","LINGUAL"}'), (25, 2, '{"BUCCAL","LINGUAL"}'),
  (26, 4, '{"MB","MB2","DB","P"}'), (27, 3, '{"MB","DB","P"}'),
  (31, 1, '{"SINGLE"}'), (32, 1, '{"SINGLE"}'), (33, 1, '{"SINGLE"}'),
  (34, 1, '{"SINGLE"}'), (35, 1, '{"SINGLE"}'),
  (36, 3, '{"MB","ML","DISTAL"}'), (37, 3, '{"MB","ML","DISTAL"}'),
  (41, 1, '{"SINGLE"}'), (42, 1, '{"SINGLE"}'), (43, 1, '{"SINGLE"}'),
  (44, 1, '{"SINGLE"}'), (45, 1, '{"SINGLE"}'),
  (46, 3, '{"MB","ML","DISTAL"}'), (47, 3, '{"MB","ML","DISTAL"}')
ON CONFLICT (fdi_tooth) DO NOTHING;
