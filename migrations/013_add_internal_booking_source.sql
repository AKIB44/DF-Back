-- Add 'internal' as a valid booking_source value
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_booking_source_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_booking_source_check
  CHECK (booking_source IN ('website','whatsapp','direct','staff','internal'));
