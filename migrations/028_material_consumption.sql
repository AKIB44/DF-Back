-- Migration 028: Material consumption cart + patient device register (T4.2, T4.4)

-- ── 1. material_consumption (cart items per service) ─────────────────────────
CREATE TABLE IF NOT EXISTS material_consumption (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  service_id        UUID        NOT NULL REFERENCES service_performed(id) ON DELETE CASCADE,
  clinic_id         UUID        NOT NULL,
  inventory_item_id UUID        NOT NULL REFERENCES inventory_item(id),
  batch_id          UUID        REFERENCES inventory_batch(id),
  quantity          NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  unit              TEXT        NOT NULL,
  lot_number        TEXT,
  expiry_date       DATE,
  scanned           BOOLEAN     NOT NULL DEFAULT FALSE,
  state             TEXT        NOT NULL DEFAULT 'RESERVED'
                    CHECK (state IN ('RESERVED','COMMITTED','RETURNED','WASTED')),
  return_reason     TEXT,
  waste_reason      TEXT,
  created_by        UUID        NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mc_service ON material_consumption(service_id);
CREATE INDEX IF NOT EXISTS idx_mc_session ON material_consumption(session_id);

-- ── 2. patient_device_register (implant / graft traceability) ─────────────────
CREATE TABLE IF NOT EXISTS patient_device_register (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID        NOT NULL REFERENCES patients(id),
  session_id        UUID        NOT NULL REFERENCES clinical_session(id),
  service_id        UUID        NOT NULL REFERENCES service_performed(id),
  consumption_id    UUID        NOT NULL REFERENCES material_consumption(id),
  clinic_id         UUID        NOT NULL,
  inventory_item_id UUID        NOT NULL REFERENCES inventory_item(id),
  item_name         TEXT        NOT NULL,
  lot_number        TEXT,
  expiry_date       DATE,
  implanted_by      UUID        NOT NULL REFERENCES users(id),
  implanted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  tooth_numbers     INTEGER[],
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdr_patient ON patient_device_register(patient_id);
CREATE INDEX IF NOT EXISTS idx_pdr_lot     ON patient_device_register(lot_number) WHERE lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pdr_item    ON patient_device_register(inventory_item_id);
