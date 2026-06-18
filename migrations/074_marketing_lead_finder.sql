-- Migration 074: Marketing Strategy Module — Lead Finder (Google Maps scraper).
-- Staging area for clinic leads discovered from Google Maps (scrape) and enriched
-- via the Places API, screened (phone present + valid + de-duplicated) before being
-- promoted into mkt_pipeline_leads (source='scraped'). (org_id, clinic_id) UUID
-- multi-tenancy; IF NOT EXISTS = re-run safe.

-- ── 1. Allow 'scraped' as a pipeline lead source ─────────────────────────────
ALTER TABLE mkt_pipeline_leads DROP CONSTRAINT IF EXISTS mkt_pipeline_leads_source_check;
ALTER TABLE mkt_pipeline_leads
  ADD CONSTRAINT mkt_pipeline_leads_source_check
  CHECK (source IN ('manual','digital','referral','scraped'));

-- ── 2. Staging table for discovered/screened results ─────────────────────────
CREATE TABLE IF NOT EXISTS mkt_scraped_leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  search_query  TEXT,
  search_city   TEXT,
  provider      TEXT NOT NULL DEFAULT 'mock'    -- 'places' | 'scrape' | 'mock'
                  CHECK (provider IN ('places','scrape','mock')),
  name          TEXT NOT NULL,
  address       TEXT,
  phone_raw     TEXT,
  phone         TEXT,                            -- normalized +91…
  website       TEXT,
  rating        NUMERIC(2,1),
  category      TEXT,
  place_id      TEXT,                            -- Google place id (dedupe key)
  enriched      BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'passed'
                  CHECK (status IN ('passed','no_phone','invalid_phone','duplicate','imported','rejected')),
  reject_reason TEXT,
  lead_id       UUID REFERENCES mkt_pipeline_leads(id),
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_scraped_clinic_status ON mkt_scraped_leads(clinic_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_scraped_phone         ON mkt_scraped_leads(clinic_id, phone);

-- ── 3. Permission for the Lead Finder ────────────────────────────────────────
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  ('marketing.leadfinder.manage', 'marketing', 'leadfinder_manage', 'Run the lead finder and import scraped leads', 'clinic', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'marketing.leadfinder.manage', 'clinic'
FROM roles r
WHERE r.code IN ('marketing_lead', 'clinic_admin', 'org_admin')
ON CONFLICT DO NOTHING;
