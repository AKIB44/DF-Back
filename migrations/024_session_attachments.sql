CREATE TABLE IF NOT EXISTS session_attachments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID        NOT NULL REFERENCES clinical_session(id) ON DELETE CASCADE,
  clinic_id    UUID        NOT NULL,
  uploaded_by  UUID        NOT NULL REFERENCES users(id),
  s3_key       TEXT        NOT NULL,
  filename     TEXT        NOT NULL,
  content_type TEXT        NOT NULL DEFAULT 'application/octet-stream',
  file_size    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_attachments_session
  ON session_attachments(session_id);
