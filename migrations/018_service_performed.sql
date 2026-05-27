-- Migration 018: service_performed table + charge_line extension
-- Uses existing `services` table as the catalog for Phase 1.

-- ── service_performed ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_performed (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id),
  clinic_id              UUID NOT NULL REFERENCES clinics(id),
  session_id             UUID NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  service_id             UUID NOT NULL REFERENCES services(id),
  tooth_numbers          SMALLINT[],
  quantity               INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  performed_by           UUID NOT NULL REFERENCES users(id),
  base_price             NUMERIC(10,2) NOT NULL,
  discount_pct           NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  discount_flat          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount_flat >= 0),
  discount_reason        TEXT,
  discount_authorised_by UUID REFERENCES users(id),
  final_charge           NUMERIC(10,2) NOT NULL,
  gst_applicable         BOOLEAN NOT NULL DEFAULT false,
  status                 service_status NOT NULL DEFAULT 'IN_PROGRESS',
  abandon_reason         TEXT,
  notes                  TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID NOT NULL REFERENCES users(id),
  updated_by             UUID NOT NULL REFERENCES users(id),
  deleted_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_svc_perf_session  ON service_performed(session_id);
CREATE INDEX IF NOT EXISTS idx_svc_perf_service  ON service_performed(service_id);
CREATE INDEX IF NOT EXISTS idx_svc_perf_clinic   ON service_performed(clinic_id);

-- ── Trigger: keep updated_at current ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_service_performed_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_svc_perf_updated_at ON service_performed;
CREATE TRIGGER trg_svc_perf_updated_at
  BEFORE UPDATE ON service_performed
  FOR EACH ROW EXECUTE FUNCTION set_service_performed_updated_at();
