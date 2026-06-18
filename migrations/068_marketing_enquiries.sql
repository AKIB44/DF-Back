-- Migration 068: Marketing Strategy Module — Phase 5 (Digital Enquiries).
-- PRD_MARKETING_STRATEGY_MODULE_V2 §6.17, §7.9. Raw digital enquiries from a
-- website/referral form, ingested via a public API-key webhook and auto-promoted
-- into the pipeline (unless the clinic is already an active subscriber).
-- `mkt_ingest_keys` maps a per-clinic API key → (org_id, clinic_id) so the
-- unauthenticated webhook can resolve its tenant. (org_id, clinic_id) UUID
-- multi-tenancy; IF NOT EXISTS = re-run safe.

-- ── 1. Per-clinic ingest API keys ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_ingest_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  api_key     TEXT NOT NULL UNIQUE,
  label       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One active key per clinic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_ingest_key_clinic
  ON mkt_ingest_keys(clinic_id) WHERE active;

-- ── 2. Digital enquiries ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_digital_enquiries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  source        TEXT NOT NULL CHECK (source IN ('website','referral','social')),
  utm_campaign  TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  clinic_name   TEXT,
  contact_name  TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  message       TEXT,
  lead_id       UUID REFERENCES mkt_pipeline_leads(id),
  is_duplicate  BOOLEAN NOT NULL DEFAULT false,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_enquiries_tenant ON mkt_digital_enquiries(clinic_id, received_at);
