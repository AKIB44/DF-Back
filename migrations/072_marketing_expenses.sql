-- Migration 072: Marketing Strategy Module — Phase 7 (Structured Expense Filing).
-- PRD_MARKETING_STRATEGY_MODULE_V2 §6.19. Replaces the v1 generic expense note
-- with a structured ledger: category, vendor, amount, receipt (S3), campaign/lead
-- link, payment mode. Money in paise (INT) per codebase convention (PRD's
-- NUMERIC). Adapted to (org_id, clinic_id) UUID multi-tenancy. IF NOT EXISTS safe.

CREATE TABLE IF NOT EXISTS mkt_expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  category     TEXT NOT NULL DEFAULT 'other'
                 CHECK (category IN ('ad_spend','events','printing','travel',
                   'tools_subscriptions','caller_incentives','other')),
  vendor       TEXT,
  description  TEXT,
  amount_paise INT NOT NULL CHECK (amount_paise >= 0),
  spent_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  campaign_id  UUID REFERENCES mkt_campaigns(id),
  lead_id      UUID REFERENCES mkt_pipeline_leads(id),
  receipt_url  TEXT,   -- S3 key
  payment_mode TEXT CHECK (payment_mode IN ('upi','card','cash','bank_transfer')),
  notes        TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID,
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mkt_expenses_clinic_date ON mkt_expenses(clinic_id, spent_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_expenses_campaign    ON mkt_expenses(campaign_id) WHERE deleted_at IS NULL;
