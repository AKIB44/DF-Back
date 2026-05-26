-- Release notes: versioned entries managed by org admin
CREATE TABLE IF NOT EXISTS release_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version      VARCHAR(20)  NOT NULL UNIQUE,   -- e.g. "1.4.0"
  title        VARCHAR(200) NOT NULL,
  body         TEXT         NOT NULL,           -- markdown or plain text
  is_published BOOLEAN      NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Per-user acknowledgements (one row per user per release)
CREATE TABLE IF NOT EXISTS user_release_acks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_note_id UUID        NOT NULL REFERENCES release_notes(id) ON DELETE CASCADE,
  acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, release_note_id)
);

CREATE INDEX IF NOT EXISTS idx_release_acks_user ON user_release_acks (user_id);
