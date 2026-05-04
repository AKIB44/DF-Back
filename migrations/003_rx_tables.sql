-- Add short code to services so frontend can map service UUID → svc_id code
ALTER TABLE services ADD COLUMN IF NOT EXISTS code VARCHAR(10) UNIQUE;

-- ─── Rx sequence (per financial year) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rx_sequence (
  fy_year  INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- ─── Master medicines ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rx_medicines (
  id           SERIAL PRIMARY KEY,
  generic_name VARCHAR(150) NOT NULL,
  brand_name   VARCHAR(150),
  category     TEXT NOT NULL CHECK (category IN (
                  'antibiotic','analgesic','anti_inflammatory',
                  'antifungal','antiseptic','vitamin','topical','other')),
  dosage_form  TEXT NOT NULL CHECK (dosage_form IN (
                  'tablet','capsule','syrup','gel','drops','injection','mouthwash')),
  strength     VARCHAR(50) NOT NULL,
  default_dose VARCHAR(80),
  default_days SMALLINT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  notes        VARCHAR(500),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rxmed_category ON rx_medicines(category);
CREATE INDEX IF NOT EXISTS idx_rxmed_active   ON rx_medicines(is_active);
CREATE INDEX IF NOT EXISTS idx_rxmed_name     ON rx_medicines(generic_name);

-- ─── Master procedures ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rx_procedures (
  id             SERIAL PRIMARY KEY,
  procedure_code VARCHAR(30) NOT NULL UNIQUE,
  procedure_name VARCHAR(200) NOT NULL,
  svc_id         VARCHAR(10) NOT NULL,
  procedure_step SMALLINT,
  default_notes  TEXT,
  duration_days  SMALLINT NOT NULL DEFAULT 0,
  followup_days  SMALLINT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rxproc_svc    ON rx_procedures(svc_id);
CREATE INDEX IF NOT EXISTS idx_rxproc_active ON rx_procedures(is_active);

-- ─── Service default medicines ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rx_service_defaults (
  id          SERIAL PRIMARY KEY,
  svc_id      VARCHAR(10) NOT NULL,
  medicine_id INTEGER NOT NULL REFERENCES rx_medicines(id) ON DELETE CASCADE,
  sort_order  SMALLINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (svc_id, medicine_id)
);
CREATE INDEX IF NOT EXISTS idx_rxsvcdef_svc ON rx_service_defaults(svc_id);

-- ─── Prescriptions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prescriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_no  VARCHAR(30) NOT NULL UNIQUE,
  patient_id       UUID NOT NULL REFERENCES patients(id),
  appointment_id   UUID NOT NULL REFERENCES appointments(id),
  doctor_id        UUID NOT NULL REFERENCES users(id),
  clinic_id        UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  diagnosis        VARCHAR(500),
  clinical_notes   TEXT,
  pdf_s3_key       VARCHAR(500),
  pdf_generated    BOOLEAN NOT NULL DEFAULT false,
  pdf_generated_at TIMESTAMPTZ,
  wa_sent          BOOLEAN NOT NULL DEFAULT false,
  wa_sent_at       TIMESTAMPTZ,
  valid_days       SMALLINT NOT NULL DEFAULT 7,
  refillable       BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rx_appointment ON prescriptions(appointment_id);
CREATE INDEX        IF NOT EXISTS idx_rx_patient    ON prescriptions(patient_id);
CREATE INDEX        IF NOT EXISTS idx_rx_clinic     ON prescriptions(clinic_id);
CREATE INDEX        IF NOT EXISTS idx_rx_created    ON prescriptions(created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prescriptions_updated_at'
  ) THEN
    CREATE TRIGGER trg_prescriptions_updated_at
      BEFORE UPDATE ON prescriptions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ─── Prescription line items ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rx_line_items (
  id               SERIAL PRIMARY KEY,
  prescription_id  UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  item_type        TEXT NOT NULL CHECK (item_type IN ('medicine','procedure')),
  ref_id           INTEGER NOT NULL,
  sort_order       SMALLINT NOT NULL DEFAULT 1,
  dosage           VARCHAR(80),
  frequency        VARCHAR(60),
  duration         VARCHAR(40),
  quantity         VARCHAR(40),
  procedure_status TEXT CHECK (procedure_status IN ('planned','done','skipped')) DEFAULT 'planned',
  instructions     TEXT,
  is_deleted       BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rxline_prescription ON rx_line_items(prescription_id);
CREATE INDEX IF NOT EXISTS idx_rxline_active       ON rx_line_items(prescription_id, is_deleted);
