-- Marks the service auto-populated from the appointment booking. This one is the
-- default procedure for the visit: it can be abandoned but never removed
-- (cancelled) from the session, so it always stays in the service log.

ALTER TABLE service_performed
  ADD COLUMN IF NOT EXISTS is_booked_service BOOLEAN NOT NULL DEFAULT FALSE;
