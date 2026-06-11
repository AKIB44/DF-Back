-- Migration 063: patient-level file store (3D models, DICOM scans, images, PDFs, video)
-- S3-backed, like session_attachments but scoped to a patient (not a session).

CREATE TABLE IF NOT EXISTS patient_file (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organizations(id),
  clinic_id    UUID NOT NULL REFERENCES clinics(id),
  patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  uploaded_by  UUID REFERENCES users(id),
  s3_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size    BIGINT,
  kind         TEXT NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('model3d','dicom','image','pdf','video','other')),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_patient_file_patient ON patient_file(patient_id, created_at DESC);
