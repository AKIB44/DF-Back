-- Migration 075: Lead Finder — Places API guardrails (usage caps + result cache).
-- Protects the paid Google Places API from over-use: per-clinic daily counters
-- (searches + API calls) enforce hard caps, and a TTL result cache makes repeat
-- searches cost nothing. (org_id omitted — operational counters, clinic-scoped.)
-- IF NOT EXISTS = re-run safe.

-- ── 1. Daily usage counters (one row per clinic per day) ─────────────────────
CREATE TABLE IF NOT EXISTS mkt_places_usage (
  clinic_id      UUID NOT NULL REFERENCES clinics(id),
  usage_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  search_count   INT  NOT NULL DEFAULT 0,   -- /lead-finder/search runs
  api_calls      INT  NOT NULL DEFAULT 0,   -- billable Places API calls made
  last_search_at TIMESTAMPTZ,
  PRIMARY KEY (clinic_id, usage_date)
);

-- ── 2. TTL result cache (keyed by normalized query) ──────────────────────────
CREATE TABLE IF NOT EXISTS mkt_places_cache (
  clinic_id  UUID NOT NULL REFERENCES clinics(id),
  cache_key  TEXT NOT NULL,                 -- '<query>|<city>|<limit>' lowercased
  provider   TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clinic_id, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_mkt_places_cache_created ON mkt_places_cache(created_at);
