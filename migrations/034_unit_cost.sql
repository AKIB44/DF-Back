-- Migration 034: Add unit_cost to inventory_batch for cost tracking
ALTER TABLE inventory_batch ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10, 2);
