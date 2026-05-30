ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS request_headers JSONB;
