-- Migration 022: link service_performed to treatment_plan_item (T2.4 completion)

ALTER TABLE service_performed
  ADD COLUMN IF NOT EXISTS plan_item_id UUID REFERENCES treatment_plan_item(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_svc_perf_plan_item ON service_performed(plan_item_id);
