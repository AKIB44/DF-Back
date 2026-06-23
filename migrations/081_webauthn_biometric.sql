-- Migration 081: WebAuthn biometric credentials for the audit-log gate.
-- Server-verified Face ID / Touch ID (platform authenticators) used to step-up
-- before viewing the activity log. Per-user enrolled credentials + a short-lived
-- per-user challenge slot for in-flight registration/authentication ceremonies.
-- Idempotent (IF NOT EXISTS) = re-run safe.

-- ── 1. Enrolled platform credentials ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_webauthn_credential (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        UUID REFERENCES organizations(id),
  credential_id TEXT NOT NULL UNIQUE,            -- Base64URL credential id
  public_key    BYTEA NOT NULL,                  -- COSE public key bytes
  counter       BIGINT NOT NULL DEFAULT 0,       -- signature counter (replay guard)
  transports    TEXT[],                          -- e.g. {internal,hybrid}
  device_type   TEXT,                            -- singleDevice | multiDevice
  backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
  device_label  TEXT,                            -- friendly name for the UI
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_cred_user ON user_webauthn_credential(user_id);

-- ── 2. In-flight ceremony challenge (one active per user) ─────────────────────
CREATE TABLE IF NOT EXISTS user_webauthn_challenge (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL,                      -- register | authenticate
  expires_at TIMESTAMPTZ NOT NULL
);
