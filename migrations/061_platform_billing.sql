-- Migration 061: Platform Accounts & Billing — Phase AC-1 (schema + plan management)
-- PRD_07_Platform_Accounts_Billing.md. Adapted to this codebase's public-schema,
-- row-level multi-tenancy: the PRD's "organization" maps to public.organizations
-- and "tenant" maps to public.clinics (already org-scoped). No separate `platform`
-- schema is created. Status columns use TEXT + CHECK (not ENUMs) so re-runs are safe.

-- ── 1. Extend organizations with billing identity ────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS legal_name           TEXT,
  ADD COLUMN IF NOT EXISTS gstin                TEXT,
  ADD COLUMN IF NOT EXISTS pan                  TEXT,
  ADD COLUMN IF NOT EXISTS billing_email        TEXT,
  ADD COLUMN IF NOT EXISTS billing_phone        TEXT,
  ADD COLUMN IF NOT EXISTS billing_address      JSONB,
  ADD COLUMN IF NOT EXISTS razorpay_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS onboarded_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_notes        TEXT;

-- ── 2. Extend clinics with tenant lifecycle / billing status ─────────────────
ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS subdomain           TEXT,
  ADD COLUMN IF NOT EXISTS tenant_status       TEXT NOT NULL DEFAULT 'TRIAL'
    CHECK (tenant_status IN ('TRIAL','ACTIVE','GRACE','SUSPENDED','CHURNED','REVOKED')),
  ADD COLUMN IF NOT EXISTS trial_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_reason       TEXT,
  ADD COLUMN IF NOT EXISTS revoked_by          UUID,
  ADD COLUMN IF NOT EXISTS data_retained_until DATE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinic_subdomain
  ON clinics(subdomain) WHERE subdomain IS NOT NULL;

-- ── 3. Subscription plan (product catalog) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plan (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   TEXT NOT NULL UNIQUE,
  display_name           TEXT NOT NULL,
  description            TEXT,
  price_monthly_paise    INT NOT NULL,
  price_yearly_paise     INT,
  billing_cycle          TEXT NOT NULL DEFAULT 'MONTHLY'
    CHECK (billing_cycle IN ('MONTHLY','QUARTERLY','YEARLY')),
  currency               TEXT NOT NULL DEFAULT 'INR',
  gst_pct                NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  razorpay_plan_id       TEXT,
  -- feature limits (NULL = unlimited)
  max_staff              INT,
  max_patients           INT,
  max_daily_appointments INT,
  max_storage_gb         INT,
  features_included      JSONB NOT NULL DEFAULT '[]',
  features_excluded      JSONB NOT NULL DEFAULT '[]',
  -- lifecycle
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  is_visible             BOOLEAN NOT NULL DEFAULT TRUE,
  is_custom              BOOLEAN NOT NULL DEFAULT FALSE,
  trial_days             INT NOT NULL DEFAULT 14,
  grace_period_days      INT NOT NULL DEFAULT 7,
  -- standard audit
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID,
  updated_by             UUID,
  deleted_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_plan_active ON subscription_plan(is_active);

-- ── 4. Subscription (a tenant's active plan) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES clinics(id),
  org_id                   UUID NOT NULL REFERENCES organizations(id),
  plan_id                  UUID NOT NULL REFERENCES subscription_plan(id),
  status                   TEXT NOT NULL DEFAULT 'TRIALING'
    CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED','EXPIRED','REVOKED')),
  razorpay_subscription_id TEXT,
  trial_start              DATE,
  trial_end                DATE,
  current_period_start     DATE,
  current_period_end       DATE,
  next_billing_date        DATE,
  amount_paise             INT NOT NULL,
  gst_paise                INT NOT NULL DEFAULT 0,
  total_paise              INT NOT NULL,
  activated_at             TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_at             TIMESTAMPTZ,
  grace_started_at         TIMESTAMPTZ,
  grace_ends_at            DATE,
  previous_plan_id         UUID REFERENCES subscription_plan(id),
  plan_changed_at          TIMESTAMPTZ,
  proration_credit_paise   INT NOT NULL DEFAULT 0,
  payment_method_type      TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID,
  updated_by               UUID,
  deleted_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sub_tenant       ON subscription(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sub_status       ON subscription(status);
CREATE INDEX IF NOT EXISTS idx_sub_next_billing ON subscription(next_billing_date);

-- ── 5. Platform invoice (generated each billing cycle) ───────────────────────
CREATE TABLE IF NOT EXISTS platform_invoice (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number      TEXT NOT NULL UNIQUE,
  tenant_id           UUID NOT NULL REFERENCES clinics(id),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  subscription_id     UUID REFERENCES subscription(id),
  plan_id             UUID REFERENCES subscription_plan(id),
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  subtotal_paise      INT NOT NULL,
  discount_paise      INT NOT NULL DEFAULT 0,
  discount_reason     TEXT,
  taxable_paise       INT NOT NULL,
  cgst_paise          INT NOT NULL DEFAULT 0,
  sgst_paise          INT NOT NULL DEFAULT 0,
  igst_paise          INT NOT NULL DEFAULT 0,
  total_paise         INT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PAID','PARTIALLY_PAID','OVERDUE','VOID','REFUNDED')),
  paid_at             TIMESTAMPTZ,
  payment_id          UUID,
  razorpay_invoice_id TEXT,
  pdf_s3_key          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID,
  updated_by          UUID,
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invoice_tenant ON platform_invoice(tenant_id, period_start);
CREATE INDEX IF NOT EXISTS idx_invoice_status ON platform_invoice(status);

-- ── 6. Platform payment (each payment against an invoice) ────────────────────
CREATE TABLE IF NOT EXISTS platform_payment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          UUID NOT NULL REFERENCES platform_invoice(id),
  tenant_id           UUID NOT NULL REFERENCES clinics(id),
  amount_paise        INT NOT NULL,
  method              TEXT NOT NULL,
  razorpay_payment_id TEXT,
  status              TEXT NOT NULL DEFAULT 'CAPTURED'
    CHECK (status IN ('CAPTURED','FAILED','REFUNDED')),
  captured_at         TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  failure_reason      TEXT,
  refunded_at         TIMESTAMPTZ,
  refund_reason       TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID,
  updated_by          UUID,
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_invoice ON platform_payment(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_tenant  ON platform_payment(tenant_id);

-- ── 7. Tenant contacts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_contact (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES clinics(id),
  name               TEXT NOT NULL,
  role_title         TEXT,
  email              TEXT,
  phone              TEXT NOT NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
  is_billing_contact BOOLEAN NOT NULL DEFAULT FALSE,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID,
  updated_by         UUID,
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contact_tenant ON tenant_contact(tenant_id);

-- ── 8. Tenant access log (status changes, revocations, reactivations) ────────
CREATE TABLE IF NOT EXISTS tenant_access_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES clinics(id),
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  performed_by UUID,
  reason       TEXT,
  metadata     JSONB,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_access_log_tenant ON tenant_access_log(tenant_id, occurred_at);

-- ── 9. Per-tenant feature flag override ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flag_override (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES clinics(id),
  feature_slug TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL,
  reason       TEXT,
  expires_at   TIMESTAMPTZ,
  set_by       UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, feature_slug)
);

-- ── 10. Seed Basic + Pro plans (PRD §4.2) ────────────────────────────────────
INSERT INTO subscription_plan
  (slug, display_name, description, price_monthly_paise, billing_cycle, gst_pct,
   max_staff, max_patients, max_daily_appointments, max_storage_gb,
   features_included, trial_days, grace_period_days, is_active, is_visible)
VALUES
  ('basic', 'Basic', 'Essential dental practice management',
   349900, 'MONTHLY', 18.00,
   5, 500, 30, 5,
   '["BOOKING","CHARTING","BILLING","PRESCRIPTIONS","BASIC_REPORTS"]'::jsonb,
   14, 7, true, true),
  ('pro', 'Pro', 'Full-featured with specialty modules and integrations',
   549900, 'MONTHLY', 18.00,
   15, NULL, NULL, 25,
   '["BOOKING","CHARTING","BILLING","PRESCRIPTIONS","BASIC_REPORTS",
     "SPECIALTY_MODULES","INVENTORY","LAB_ORDERS","ADVANCED_REPORTS",
     "WHATSAPP_API","VOICE_AGENT","HARDWARE_INTEGRATION","MULTI_DOCTOR"]'::jsonb,
   14, 7, true, true)
ON CONFLICT (slug) DO NOTHING;

-- ── 11. Seed platform RBAC permissions + grant to org_admin (interim) ────────
-- NOTE: a dedicated SYSTEM-scope platform_admin role is a later phase; for AC-1
-- these are granted to org_admin so the plan-management surface is usable/testable.
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  ('platform.plan.manage',    'platform', 'plan_manage',    'Create / edit / archive subscription plans', 'platform', true),
  ('platform.tenant.read',    'platform', 'tenant_read',    'View platform tenants and billing',          'platform', true),
  ('platform.tenant.manage',  'platform', 'tenant_manage',  'Manage tenant lifecycle / access',           'platform', true),
  ('platform.billing.read',   'platform', 'billing_read',   'View platform billing / invoices',           'platform', true),
  ('platform.billing.manage', 'platform', 'billing_manage', 'Manage platform billing / invoices',         'platform', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, 'platform'
FROM roles r
CROSS JOIN (VALUES
  ('platform.plan.manage'),
  ('platform.tenant.read'),
  ('platform.tenant.manage'),
  ('platform.billing.read'),
  ('platform.billing.manage')
) AS p(code)
WHERE r.code = 'org_admin'
ON CONFLICT DO NOTHING;
