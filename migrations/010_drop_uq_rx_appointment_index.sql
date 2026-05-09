-- Migration 006 dropped the wrong constraint name.
-- The actual unique index preventing multiple prescriptions per appointment is uq_rx_appointment.
DROP INDEX IF EXISTS uq_rx_appointment;
