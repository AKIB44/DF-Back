-- Migration 027: Inventory base — items, batches, stock movements (T4.1)

-- ── 1. inventory_item ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_item (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES organizations(id),
  clinic_id        UUID        NOT NULL REFERENCES clinics(id),
  name             TEXT        NOT NULL,
  generic_name     TEXT,
  category         TEXT        NOT NULL DEFAULT 'dental_material'
                   CHECK (category IN (
                     'dental_material','implant','membrane',
                     'medication','disposable','equipment'
                   )),
  unit             TEXT        NOT NULL DEFAULT 'piece',
  is_traceable     BOOLEAN     NOT NULL DEFAULT FALSE,
  is_implant       BOOLEAN     NOT NULL DEFAULT FALSE,
  reorder_point    NUMERIC(10,3) NOT NULL DEFAULT 0,
  reorder_quantity NUMERIC(10,3) NOT NULL DEFAULT 0,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_item_clinic ON inventory_item(clinic_id, is_active);
CREATE INDEX IF NOT EXISTS idx_inv_item_name   ON inventory_item USING gin(to_tsvector('simple', name));

-- ── 2. inventory_batch ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_batch (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id UUID        NOT NULL REFERENCES inventory_item(id) ON DELETE CASCADE,
  clinic_id         UUID        NOT NULL,
  lot_number        TEXT,
  expiry_date       DATE,
  initial_quantity  NUMERIC(10,3) NOT NULL CHECK (initial_quantity > 0),
  unit              TEXT        NOT NULL,
  supplier          TEXT,
  received_at       DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_item    ON inventory_batch(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_batch_expiry  ON inventory_batch(expiry_date) WHERE expiry_date IS NOT NULL;

-- ── 3. stock_movement (append-only ledger) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movement (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type     TEXT        NOT NULL
                    CHECK (movement_type IN (
                      'GOODS_RECEIPT','CONSUMPTION','WASTAGE',
                      'RETURN_TO_VENDOR','ADJUSTMENT','EXPIRY','TRANSFER_IN'
                    )),
  inventory_item_id UUID        NOT NULL REFERENCES inventory_item(id),
  batch_id          UUID        REFERENCES inventory_batch(id),
  clinic_id         UUID        NOT NULL,
  direction         SMALLINT    NOT NULL CHECK (direction IN (-1, 1)),
  quantity          NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  source_ref        TEXT,
  source_type       TEXT,
  actor_id          UUID        NOT NULL REFERENCES users(id),
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sm_item_date ON stock_movement(inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sm_batch     ON stock_movement(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sm_clinic    ON stock_movement(clinic_id, created_at DESC);

-- ── 4. current_stock materialised view ────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS current_stock AS
SELECT
  inventory_item_id,
  batch_id,
  clinic_id,
  SUM(direction * quantity) AS qty_on_hand
FROM stock_movement
GROUP BY inventory_item_id, batch_id, clinic_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_current_stock_uniq
  ON current_stock(inventory_item_id, COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid), clinic_id);
