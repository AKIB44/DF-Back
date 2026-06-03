-- Migration 039: Specialty Catalog Extension
-- Adds specialty columns to services and treatment_plan_item

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS specialty_case_type TEXT,
  ADD COLUMN IF NOT EXISTS creates_specialty_case BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE treatment_plan_item
  ADD COLUMN IF NOT EXISTS specialty_case_type TEXT,
  ADD COLUMN IF NOT EXISTS specialty_case_id UUID REFERENCES specialty_case(id) ON DELETE SET NULL;
