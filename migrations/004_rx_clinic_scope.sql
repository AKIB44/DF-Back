-- Scope rx master data to individual clinics (mirrors how services/chairs work).
-- Safe to run on empty rx tables; if you have existing global seed data run
-- `npm run seed:rx` again after this to re-seed per clinic.

-- ─── 1. Add clinic_id (nullable first to avoid breaking existing rows) ─────────
ALTER TABLE rx_medicines        ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE;
ALTER TABLE rx_procedures       ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE;
ALTER TABLE rx_service_defaults ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE;

-- ─── 2. Drop old global unique/index constraints ──────────────────────────────
DROP INDEX IF EXISTS uq_proc_code;        -- was UNIQUE(procedure_code)
DROP INDEX IF EXISTS uq_svc_med;          -- was UNIQUE(svc_id, medicine_id)
ALTER TABLE rx_procedures       DROP CONSTRAINT IF EXISTS rx_procedures_procedure_code_key;
ALTER TABLE rx_service_defaults DROP CONSTRAINT IF EXISTS rx_service_defaults_svc_id_medicine_id_key;

-- ─── 3. New clinic-scoped unique constraints ──────────────────────────────────
-- Each clinic can have its own medicine list (generic_name unique per clinic)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_clinic_med_name'
  ) THEN
    ALTER TABLE rx_medicines ADD CONSTRAINT uq_clinic_med_name
      UNIQUE (clinic_id, generic_name);
  END IF;
END $$;

-- Each clinic has its own procedure codes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_clinic_proc_code'
  ) THEN
    ALTER TABLE rx_procedures ADD CONSTRAINT uq_clinic_proc_code
      UNIQUE (clinic_id, procedure_code);
  END IF;
END $$;

-- Each clinic's service defaults are unique per svc_id + medicine
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_clinic_svc_med'
  ) THEN
    ALTER TABLE rx_service_defaults ADD CONSTRAINT uq_clinic_svc_med
      UNIQUE (clinic_id, svc_id, medicine_id);
  END IF;
END $$;

-- ─── 4. Per-clinic indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rxmed_clinic        ON rx_medicines(clinic_id);
CREATE INDEX IF NOT EXISTS idx_rxproc_clinic       ON rx_procedures(clinic_id);
CREATE INDEX IF NOT EXISTS idx_rxsvcdef_clinic_svc ON rx_service_defaults(clinic_id, svc_id);
