-- Clinic logo stored in S3 (key replaces the free-text logo_url)
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS logo_s3_key VARCHAR(500);

-- Doctor designation (BDS, MDS, etc.) shown on prescriptions
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(100);
