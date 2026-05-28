-- Migration 029: Surgical flags on services + consent tables

-- ── 1. Add surgical flags to services table ───────────────────────────────────
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS requires_consent  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_preop    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS postop_required   BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Consent templates (clinic-level, versioned) ────────────────────────────
CREATE TABLE consent_template (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id      UUID        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  procedure_type TEXT        NOT NULL,
  title          TEXT        NOT NULL,
  body_html      TEXT        NOT NULL DEFAULT '',
  version        INT         NOT NULL DEFAULT 1,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_by     UUID        REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_template_clinic ON consent_template(clinic_id);

-- ── 3. Consent records (per session, per procedure type) ─────────────────────
CREATE TABLE consent_record (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id             UUID        NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  session_id            UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  patient_id            UUID        NOT NULL REFERENCES patients(id),
  template_id           UUID        REFERENCES consent_template(id),
  procedure_type        TEXT        NOT NULL,
  service_id            UUID        REFERENCES services(id),
  patient_signature_url TEXT        NOT NULL,
  witness_signature_url TEXT,
  signed_pdf_url        TEXT,
  signature_hash        TEXT,
  is_minor              BOOLEAN     NOT NULL DEFAULT false,
  guardian_name         TEXT,
  signed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_by             UUID        REFERENCES users(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_record_session ON consent_record(session_id);
CREATE INDEX idx_consent_record_patient ON consent_record(patient_id);
