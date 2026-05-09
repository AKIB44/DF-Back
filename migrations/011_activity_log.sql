DROP TABLE IF EXISTS activity_log CASCADE;

CREATE TABLE activity_log (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  clinic_id    UUID         REFERENCES clinics(id) ON DELETE CASCADE,
  user_name    TEXT,
  user_email   TEXT,
  method       VARCHAR(10)  NOT NULL,
  path         TEXT         NOT NULL,
  action       TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  status_code  INT          NOT NULL,
  duration_ms  INT,
  ip_address   TEXT,
  user_agent   TEXT,
  request_body JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_log_clinic   ON activity_log(clinic_id, created_at DESC);
CREATE INDEX idx_activity_log_user     ON activity_log(user_id, created_at DESC);
CREATE INDEX idx_activity_log_entity   ON activity_log(entity_type, entity_id);
