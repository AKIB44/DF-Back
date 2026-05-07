-- Allow multiple prescriptions per appointment
ALTER TABLE prescriptions DROP CONSTRAINT IF EXISTS prescriptions_appointment_id_key;
