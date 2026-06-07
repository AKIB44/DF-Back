-- Migration 060: idempotency keys for offline-replayed mutations
-- The web client attaches an Idempotency-Key header to every mutating /v1 request
-- (and replays queued ones after reconnect). This table lets the server dedupe a
-- replayed request by returning the originally-captured response instead of
-- re-running the mutation, so offline sync never creates duplicate records.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INT,
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);
