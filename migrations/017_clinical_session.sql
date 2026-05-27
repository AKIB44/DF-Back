-- Migration 017: Clinical Session — state machine table and supporting enums
-- Adapts PRD §10.1 + §10.2 to existing table names (appointments, users, patients).

-- ── 1. Add in_treatment status to appointments ────────────────────────────────
-- Drop and recreate the CHECK constraint to include the new status.
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('booked','confirmed','in_progress','in_treatment','done','no_show','cancelled'));

-- ── 2. Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE session_status AS ENUM (
    'INITIALISED', 'EXAMINING', 'CHARTING', 'DIAGNOSING',
    'ORDERING_INVESTIGATIONS', 'PERFORMING_SERVICES',
    'PAUSED', 'COMPLETED', 'ABANDONED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE service_status AS ENUM (
    'IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'ABANDONED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE consumption_state AS ENUM (
    'RESERVED', 'COMMITTED', 'RETURNED', 'WASTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE movement_type AS ENUM (
    'GOODS_RECEIPT', 'TRANSFER_IN', 'CONSUMPTION',
    'WASTAGE', 'EXPIRY', 'RETURN_TO_VENDOR', 'ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE plan_item_status AS ENUM (
    'PROPOSED', 'ACCEPTED', 'DECLINED', 'IN_PROGRESS',
    'DONE', 'PARTIAL', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. clinical_session table ─────────────────────────────────────────────────
-- References: appointments(id), patients(id), users(id)
CREATE TABLE IF NOT EXISTS clinical_session (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  clinic_id           UUID NOT NULL REFERENCES clinics(id),
  appointment_id      UUID NOT NULL REFERENCES appointments(id),
  patient_id          UUID NOT NULL REFERENCES patients(id),
  primary_doctor_id   UUID NOT NULL REFERENCES users(id),
  status              session_status NOT NULL DEFAULT 'INITIALISED',
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  end_reason          TEXT,
  sealed_at           TIMESTAMPTZ,
  sealed_by           UUID REFERENCES users(id),
  variance_reason     TEXT,
  patient_ack_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID NOT NULL REFERENCES users(id),
  updated_by          UUID NOT NULL REFERENCES users(id),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_appointment ON clinical_session(appointment_id);
CREATE INDEX IF NOT EXISTS idx_session_patient     ON clinical_session(patient_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_clinic      ON clinical_session(clinic_id, started_at DESC);

-- ── 4. clinical_note table (SOAP — needed for T1.3) ──────────────────────────
CREATE TABLE IF NOT EXISTS clinical_note (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  session_id  UUID NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  subjective  TEXT NOT NULL DEFAULT '',
  objective   TEXT NOT NULL DEFAULT '',
  assessment  TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL DEFAULT '',
  addenda     JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID NOT NULL REFERENCES users(id),
  updated_by  UUID NOT NULL REFERENCES users(id),
  deleted_at  TIMESTAMPTZ,
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_note_session ON clinical_note(session_id);
