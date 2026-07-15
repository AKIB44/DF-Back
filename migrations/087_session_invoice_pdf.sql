-- Migration 087: standalone patient-facing invoice PDF for a clinical session.
-- Separate from the clinical treatment-summary (059): this is a clean bill of the
-- services performed + charges, generated on demand, stored in S3, referenced from
-- clinical_session so it can be viewed or sent (WhatsApp) later. invoice_no is
-- reused from 059.

ALTER TABLE clinical_session
  ADD COLUMN IF NOT EXISTS invoice_pdf_s3_key       VARCHAR(500),
  ADD COLUMN IF NOT EXISTS invoice_pdf_generated_at TIMESTAMPTZ;
