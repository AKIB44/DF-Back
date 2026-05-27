-- Migration 021: treatment plan (T2.4)

DO $$ BEGIN
  CREATE TYPE plan_priority AS ENUM ('urgent','recommended','optional','cosmetic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE plan_decline_reason AS ENUM ('cost','time','fear','second_opinion','medical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS treatment_plan (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  patient_id   UUID NOT NULL REFERENCES patients(id),
  title        TEXT NOT NULL DEFAULT 'Treatment Plan',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_plan_patient ON treatment_plan(patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS treatment_plan_item (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id),
  clinic_id            UUID NOT NULL REFERENCES clinics(id),
  plan_id              UUID NOT NULL REFERENCES treatment_plan(id) ON DELETE CASCADE,
  service_id           UUID NOT NULL REFERENCES services(id),
  linked_diagnosis_id  UUID REFERENCES diagnosis(id) ON DELETE SET NULL,
  tooth_numbers        SMALLINT[] NOT NULL DEFAULT '{}',
  estimated_sessions   INT NOT NULL DEFAULT 1 CHECK (estimated_sessions > 0),
  done_sessions        INT NOT NULL DEFAULT 0 CHECK (done_sessions >= 0),
  cost_min             NUMERIC(10,2),
  cost_max             NUMERIC(10,2),
  priority             plan_priority NOT NULL DEFAULT 'recommended',
  status               plan_item_status NOT NULL DEFAULT 'PROPOSED',
  decline_reason       plan_decline_reason,
  patient_facing_notes TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID NOT NULL REFERENCES users(id),
  updated_by           UUID NOT NULL REFERENCES users(id),
  deleted_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_plan_item_plan    ON treatment_plan_item(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_item_patient ON treatment_plan_item(org_id, clinic_id, plan_id);

CREATE OR REPLACE FUNCTION set_plan_item_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_item_updated_at ON treatment_plan_item;
CREATE TRIGGER trg_plan_item_updated_at
  BEFORE UPDATE ON treatment_plan_item
  FOR EACH ROW EXECUTE FUNCTION set_plan_item_updated_at();
