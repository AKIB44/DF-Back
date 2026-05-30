-- Migration 035: Purchase order workflow tables
CREATE TABLE IF NOT EXISTS purchase_order (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES organizations(id),
  clinic_id   UUID        NOT NULL REFERENCES clinics(id),
  po_number   TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','sent','received','cancelled')),
  supplier    TEXT,
  notes       TEXT,
  ordered_at  TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_by  UUID        REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_order_line (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID        NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  inventory_item_id UUID        NOT NULL REFERENCES inventory_item(id),
  quantity          NUMERIC(10,3) NOT NULL,
  unit              TEXT        NOT NULL,
  unit_cost         NUMERIC(10,2),
  lot_number        TEXT,
  expiry_date       DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_clinic ON purchase_order(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_line_po            ON purchase_order_line(purchase_order_id);
