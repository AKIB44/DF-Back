-- Migration 062: Clinic-level billing — manual expense ledger + role grants.
-- Separates two money surfaces:
--   • Clinic Billing (this clinic's revenue & expense) — clinic-scoped.
--   • Subscription Management (org-level, owned by the accounts user).
-- Revenue is derived (service_performed.final_charge); inventory expense is derived
-- (purchase_order); this adds the manual expense ledger that has no other home.

-- ── 1. Manual expense ledger (clinic-scoped) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_expense (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  category     TEXT NOT NULL DEFAULT 'OTHER'
                 CHECK (category IN ('RENT','SALARIES','UTILITIES','SUPPLIES','EQUIPMENT','MARKETING','MAINTENANCE','TAX','OTHER')),
  description  TEXT,
  amount_paise INT NOT NULL CHECK (amount_paise >= 0),
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  vendor       TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID,
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_clinic_expense_clinic ON clinic_expense(clinic_id, expense_date DESC);

-- ── 2. Expense management permission ─────────────────────────────────────────
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  ('expense.manage', 'billing', 'expense_manage', 'Manage clinic expense ledger', 'clinic', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'expense.manage', 'clinic'
FROM roles r
WHERE r.code IN ('accountant', 'manager', 'clinic_admin', 'org_admin')
ON CONFLICT DO NOTHING;

-- ── 3. Accounts user owns subscription management ────────────────────────────
-- Grant the platform subscription permissions to the accountant role so the
-- org-level "Subscription Management" surface is theirs (org_admin already has
-- them from migration 061).
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'platform'
FROM roles r
CROSS JOIN (VALUES
  ('platform.plan.manage'),
  ('platform.tenant.read'),
  ('platform.billing.read'),
  ('platform.billing.manage')
) AS p(code)
WHERE r.code = 'accountant'
ON CONFLICT DO NOTHING;
