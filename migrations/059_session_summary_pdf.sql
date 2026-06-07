-- Migration 059: treatment summary + invoice PDF for sealed sessions
-- Generated server-side on seal, stored in S3, referenced from clinical_session.

ALTER TABLE clinical_session
  ADD COLUMN IF NOT EXISTS invoice_no               TEXT,
  ADD COLUMN IF NOT EXISTS summary_pdf_s3_key       VARCHAR(500),
  ADD COLUMN IF NOT EXISTS summary_pdf_generated_at TIMESTAMPTZ;
