-- Migration 064: Marketing Strategy Module — Foundation (PRD v2.0).
-- PRD_MARKETING_STRATEGY_MODULE_V2. Single consolidated foundation migration:
-- RBAC (3 roles + full permission catalog + grant matrix) and the foundation
-- tables (campaigns, content calendar, pipeline leads).
--
-- Adapted to this codebase's public-schema, row-level multi-tenancy: the PRD's
-- `tenant_id BIGINT` becomes the standard (org_id, clinic_id) UUID pair already
-- used by clinic_expense / specialty. Clinic = the PRD's "tenant". Money is
-- stored in paise (INT) per the codebase convention, not NUMERIC. Tables use
-- TEXT + CHECK (not ENUMs) and IF NOT EXISTS / ON CONFLICT so re-runs are safe.
-- Later phases add the remaining mkt_* tables and wire the nullable FKs.

-- ── 1. RBAC: roles (3 personas — PRD §3) ─────────────────────────────────────
INSERT INTO roles (org_id, code, name, is_system, hierarchy_level) VALUES
  (NULL, 'marketing_lead',   'Marketing Lead',        true, 70),
  (NULL, 'marketing_member', 'Marketing Team Member', true, 30),
  (NULL, 'marketing_caller', 'Marketing Caller',      true, 30)
ON CONFLICT DO NOTHING;

-- ── 2. RBAC: permission catalog (PRD §3.1 — v2 complete) ─────────────────────
INSERT INTO permissions (code, module, action, description, default_scope, is_sensitive) VALUES
  -- Campaigns & calendar
  ('marketing.campaign.view',   'marketing', 'campaign_view',   'View marketing campaigns',     'clinic', false),
  ('marketing.campaign.create', 'marketing', 'campaign_create', 'Create marketing campaign',    'clinic', false),
  ('marketing.campaign.edit',   'marketing', 'campaign_edit',   'Edit marketing campaign',      'clinic', false),
  ('marketing.campaign.delete', 'marketing', 'campaign_delete', 'Delete marketing campaign',    'clinic', false),
  ('marketing.campaign.send',   'marketing', 'campaign_send',   'Send campaign via WhatsApp',   'clinic', true),
  ('marketing.calendar.view',   'marketing', 'calendar_view',   'View content calendar',        'clinic', false),
  ('marketing.calendar.create', 'marketing', 'calendar_create', 'Create calendar entry',        'clinic', false),
  ('marketing.calendar.edit',   'marketing', 'calendar_edit',   'Edit calendar entry',          'clinic', false),
  ('marketing.calendar.delete', 'marketing', 'calendar_delete', 'Delete calendar entry',        'clinic', false),
  -- Audience segments & promo codes
  ('marketing.segment.view',    'marketing', 'segment_view',    'View audience segments',       'clinic', false),
  ('marketing.segment.create',  'marketing', 'segment_create',  'Create audience segment',      'clinic', false),
  ('marketing.promocode.view',  'marketing', 'promocode_view',  'View promo codes',             'clinic', false),
  ('marketing.promocode.create','marketing', 'promocode_create','Create promo code',            'clinic', false),
  ('marketing.promocode.edit',  'marketing', 'promocode_edit',  'Edit promo code',              'clinic', false),
  -- Pipeline & onboarding
  ('marketing.pipeline.view',   'marketing', 'pipeline_view',   'View lead/clinic pipeline',    'clinic', false),
  ('marketing.pipeline.edit',   'marketing', 'pipeline_edit',   'Edit pipeline leads',          'clinic', false),
  ('marketing.onboarding.view', 'marketing', 'onboarding_view', 'View onboarding steps',        'clinic', false),
  ('marketing.onboarding.edit', 'marketing', 'onboarding_edit', 'Edit onboarding steps',        'clinic', false),
  -- Feedback (v2)
  ('marketing.feedback.view',         'marketing', 'feedback_view',         'View marketing lead feedback', 'clinic', false),
  ('marketing.feedback.create',       'marketing', 'feedback_create',       'Log marketing lead feedback',  'clinic', false),
  ('marketing.caller_feedback.view',  'marketing', 'caller_feedback_view',  'View caller feedback',         'clinic', false),
  -- Acceptance ratio (v2)
  ('marketing.acceptance.view',       'marketing', 'acceptance_view',       'View clinic acceptance ratio', 'clinic', false),
  ('marketing.acceptance.edit',       'marketing', 'acceptance_edit',       'Capture clinic accept/reject', 'clinic', false),
  -- Caller workflow (v2)
  ('marketing.callqueue.view_own',    'marketing', 'callqueue_view_own',    'View own call queue',          'own',    false),
  ('marketing.callqueue.view_all',    'marketing', 'callqueue_view_all',    'View all call queues',         'clinic', false),
  ('marketing.calloutcome.create',    'marketing', 'calloutcome_create',    'Log a call outcome',           'own',    false),
  ('marketing.callback.schedule',     'marketing', 'callback_schedule',     'Schedule a callback',          'own',    false),
  -- Digital enquiries (v2)
  ('marketing.enquiry.view',          'marketing', 'enquiry_view',          'View digital enquiries',       'clinic', false),
  ('marketing.enquiry.edit',          'marketing', 'enquiry_edit',          'Manage digital enquiries',     'clinic', false),
  -- Calendar-synced scheduled calls (v2)
  ('marketing.scheduled_calls.view',  'marketing', 'scheduled_calls_view',  'View scheduled calls',         'clinic', false),
  ('marketing.scheduled_calls.create','marketing', 'scheduled_calls_create','Create scheduled calls',       'clinic', false),
  -- Pitch, revenue, expenses, team, tasks
  ('marketing.pitch.view',      'marketing', 'pitch_view',      'View pitch library',           'clinic', false),
  ('marketing.pitch.edit',      'marketing', 'pitch_edit',      'Manage pitch library',         'clinic', false),
  ('marketing.revenue.view',    'marketing', 'revenue_view',    'View marketing revenue',       'clinic', true),
  ('marketing.expense.view',    'marketing', 'expense_view',    'View marketing expenses',      'clinic', false),
  ('marketing.expense.create',  'marketing', 'expense_create',  'Log marketing expense',        'clinic', false),
  ('marketing.expense.edit',    'marketing', 'expense_edit',    'Edit marketing expense',       'clinic', false),
  ('marketing.team.manage',     'marketing', 'team_manage',     'Manage marketing team',        'clinic', true),
  ('marketing.task.view_all',   'marketing', 'task_view_all',   'View all marketing tasks',     'clinic', false),
  ('marketing.task.view_own',   'marketing', 'task_view_own',   'View own marketing tasks',     'own',    false),
  ('marketing.task.edit',       'marketing', 'task_edit',       'Edit marketing tasks',         'clinic', false)
ON CONFLICT (code) DO NOTHING;

-- ── 3. RBAC: grant matrix (PRD §3) ───────────────────────────────────────────
-- marketing_lead → every marketing code.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'marketing_lead' AND p.module = 'marketing'
ON CONFLICT DO NOTHING;

-- marketing_member → campaigns/calendar read + own edits, segments, own tasks,
-- own feedback, acceptance capture, enquiry + scheduled-calls view.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'marketing_member'
  AND p.code IN (
    'marketing.campaign.view',
    'marketing.calendar.view', 'marketing.calendar.create', 'marketing.calendar.edit',
    'marketing.segment.view',
    'marketing.task.view_own', 'marketing.task.edit',
    'marketing.feedback.view', 'marketing.feedback.create',
    'marketing.acceptance.view', 'marketing.acceptance.edit',
    'marketing.enquiry.view',
    'marketing.scheduled_calls.view'
  )
ON CONFLICT DO NOTHING;

-- marketing_caller → call queue / outcome / callback, own caller feedback,
-- read-only pipeline, enquiry + scheduled-calls view, own tasks.
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code = 'marketing_caller'
  AND p.code IN (
    'marketing.pipeline.view',
    'marketing.caller_feedback.view',
    'marketing.callqueue.view_own',
    'marketing.calloutcome.create',
    'marketing.callback.schedule',
    'marketing.enquiry.view',
    'marketing.scheduled_calls.view',
    'marketing.task.view_own', 'marketing.task.edit'
  )
ON CONFLICT DO NOTHING;

-- clinic_admin + org_admin → every marketing code (admins own the module).
INSERT INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, p.code, p.default_scope
FROM roles r, permissions p
WHERE r.code IN ('clinic_admin', 'org_admin') AND p.module = 'marketing'
ON CONFLICT DO NOTHING;

-- ── 4. mkt_campaigns ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_campaigns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  clinic_id      UUID NOT NULL REFERENCES clinics(id),
  name           TEXT NOT NULL,
  goal           TEXT NOT NULL DEFAULT 'bookings'
                   CHECK (goal IN ('bookings','awareness','lead_gen')),
  channel        TEXT NOT NULL DEFAULT 'whatsapp'
                   CHECK (channel IN ('whatsapp','instagram','facebook','offline')),
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','active','completed','archived')),
  budget_paise   INT NOT NULL DEFAULT 0 CHECK (budget_paise >= 0),
  start_date     DATE,
  end_date       DATE,
  promo_code_id  UUID,   -- FK to mkt_promo_codes added in a later phase
  segment_id     UUID,   -- FK to mkt_segments added in a later phase
  wa_template_id UUID,   -- FK to WA template module added in a later phase
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     UUID,
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_clinic_status
  ON mkt_campaigns(clinic_id, status) WHERE deleted_at IS NULL;

-- ── 5. mkt_content_calendar ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_content_calendar (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  clinic_id     UUID NOT NULL REFERENCES clinics(id),
  campaign_id   UUID REFERENCES mkt_campaigns(id),
  channel       TEXT NOT NULL DEFAULT 'instagram'
                  CHECK (channel IN ('instagram','facebook','whatsapp_status','other')),
  title         TEXT NOT NULL,
  caption       TEXT,
  media_url     TEXT,
  scheduled_for TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','posted','cancelled')),
  owner_id      UUID REFERENCES users(id),
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mkt_calendar_clinic_date
  ON mkt_content_calendar(clinic_id, scheduled_for) WHERE deleted_at IS NULL;

-- ── 6. mkt_pipeline_leads (PRD v2 §6.2) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_pipeline_leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  clinic_id             UUID NOT NULL REFERENCES clinics(id),
  clinic_name           TEXT NOT NULL,
  contact_name          TEXT,
  contact_phone         TEXT,
  contact_email         TEXT,
  city                  TEXT,
  stage                 TEXT NOT NULL DEFAULT 'new'
                          CHECK (stage IN ('new','marketing_qualified','routed_to_caller',
                                           'called','demo_scheduled','trial','onboarded','lost')),
  source                TEXT NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual','digital','referral')),
  utm_campaign          TEXT,
  utm_source            TEXT,
  utm_medium            TEXT,
  final_disposition     TEXT CHECK (final_disposition IN ('accepted','rejected','pending')),
  is_active_subscriber  BOOLEAN NOT NULL DEFAULT false,
  subscriber_checked_at TIMESTAMPTZ,
  assigned_caller_id    UUID REFERENCES users(id),
  notes                 TEXT,
  next_followup         DATE,
  owner_id              UUID REFERENCES users(id),
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            UUID,
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mkt_pipeline_clinic_stage
  ON mkt_pipeline_leads(clinic_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_pipeline_caller
  ON mkt_pipeline_leads(assigned_caller_id) WHERE deleted_at IS NULL;
