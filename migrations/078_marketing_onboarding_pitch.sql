-- Migration 078: Marketing Strategy Module — Phase 9 (Onboarding + Pitch Library).
-- PRD v1 §5.7–5.8. Per-lead onboarding checklist (agreement → migration → training
-- → go-live) and a versioned pitch-deck library (S3) with per-prospect generation.
-- Adapted to (org_id, clinic_id) UUID multi-tenancy. IF NOT EXISTS = re-run safe.

-- ── 1. Onboarding steps (per pipeline lead) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_onboarding_steps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  lead_id      UUID NOT NULL REFERENCES mkt_pipeline_leads(id) ON DELETE CASCADE,
  step_name    TEXT NOT NULL,
  step_order   SMALLINT NOT NULL DEFAULT 0,
  owner_id     UUID REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_progress','done')),
  due_date     DATE,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_onboarding_lead ON mkt_onboarding_steps(lead_id, step_order);

-- ── 2. Pitch documents (versioned, S3-backed) ────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_pitch_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  title         TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT 'v1',
  file_url      TEXT,                 -- S3 key (uploaded or generated)
  content_type  TEXT,
  generated     BOOLEAN NOT NULL DEFAULT false,
  lead_id       UUID REFERENCES mkt_pipeline_leads(id),  -- set for per-prospect PDFs
  template_json JSONB,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mkt_pitch_clinic ON mkt_pitch_documents(clinic_id, created_at DESC) WHERE deleted_at IS NULL;
