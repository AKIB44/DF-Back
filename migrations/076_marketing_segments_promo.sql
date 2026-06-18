-- Migration 076: Marketing Strategy Module — Phase 8 (Segments, Promo Codes, WA Broadcast).
-- PRD v1 §5.3–5.5. The clinic's own B2C marketing: audience segments over the
-- patient CRM, promo codes, and a record of WhatsApp broadcast sends. Adapted to
-- (org_id, clinic_id) UUID multi-tenancy; money for promo flat discounts in paise.
-- IF NOT EXISTS = re-run safe.

-- ── 1. Audience segments (filter over the patient CRM) ───────────────────────
CREATE TABLE IF NOT EXISTS mkt_segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  clinic_id   UUID NOT NULL REFERENCES clinics(id),
  name        TEXT NOT NULL,
  filter_json JSONB NOT NULL DEFAULT '{}',
  guest_count INT NOT NULL DEFAULT 0,      -- cached, recomputed on preview
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mkt_segments_clinic ON mkt_segments(clinic_id) WHERE deleted_at IS NULL;

-- ── 2. Promo codes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_promo_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  clinic_id       UUID NOT NULL REFERENCES clinics(id),
  code            TEXT NOT NULL,
  discount_type   TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value  NUMERIC(10,2) NOT NULL CHECK (discount_value >= 0),  -- percent: %, flat: ₹
  applies_to      TEXT,                    -- 'all' | 'service:<id>' | free text
  max_redemptions INT,
  redeemed_count  INT NOT NULL DEFAULT 0,
  valid_from      DATE,
  valid_until     DATE,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_promo_clinic_code
  ON mkt_promo_codes(clinic_id, upper(code)) WHERE deleted_at IS NULL;

-- ── 3. Promo redemptions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_promo_redemptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  clinic_id      UUID NOT NULL REFERENCES clinics(id),
  promo_code_id  UUID NOT NULL REFERENCES mkt_promo_codes(id) ON DELETE CASCADE,
  patient_id     UUID REFERENCES patients(id),
  reference      TEXT,                     -- booking/appointment ref
  discount_paise INT,
  redeemed_by    UUID,
  redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_promo_redemptions ON mkt_promo_redemptions(promo_code_id, redeemed_at DESC);

-- ── 4. Campaign broadcast sends (WA Message Center handoff record) ───────────
CREATE TABLE IF NOT EXISTS mkt_campaign_sends (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  campaign_id  UUID NOT NULL REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  segment_id   UUID REFERENCES mkt_segments(id),
  channel      TEXT NOT NULL DEFAULT 'whatsapp',
  recipients   INT NOT NULL DEFAULT 0,
  sent_count   INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  provider     TEXT NOT NULL DEFAULT 'stub',
  status       TEXT NOT NULL DEFAULT 'sent',
  sent_by      UUID,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_campaign_sends_campaign ON mkt_campaign_sends(campaign_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_campaign_sends_clinic   ON mkt_campaign_sends(clinic_id, sent_at DESC);

-- ── 5. Wire the campaign → segment / promo FKs (left loose in 064) ───────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_campaigns_segment_fk') THEN
    ALTER TABLE mkt_campaigns ADD CONSTRAINT mkt_campaigns_segment_fk
      FOREIGN KEY (segment_id) REFERENCES mkt_segments(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_campaigns_promo_fk') THEN
    ALTER TABLE mkt_campaigns ADD CONSTRAINT mkt_campaigns_promo_fk
      FOREIGN KEY (promo_code_id) REFERENCES mkt_promo_codes(id);
  END IF;
END $$;
