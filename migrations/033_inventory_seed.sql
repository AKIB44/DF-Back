-- Migration 033: Inventory seed data for testing
-- Inserts 10 realistic dental items covering all stock states:
--   In Stock (5), Low Stock (3), Out of Stock (2), Expiring Soon (2)
-- Skips automatically if ≥5 items already exist for the clinic.

DO $$
DECLARE
  v_org_id    UUID;
  v_clinic_id UUID;
  v_actor_id  UUID;
  v_item      UUID;
  v_batch     UUID;
BEGIN

  -- ── Resolve context: first active org → clinic → user ──────────────────────
  SELECT o.id, c.id, u.id
    INTO v_org_id, v_clinic_id, v_actor_id
    FROM organizations o
    JOIN clinics c ON c.org_id = o.id AND c.is_active = true
    JOIN users   u ON u.clinic_id = c.id AND u.is_active = true
    ORDER BY o.created_at ASC, c.created_at ASC, u.created_at ASC
    LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE NOTICE '[seed] No org/clinic/user found — inventory seed skipped';
    RETURN;
  END IF;

  IF (SELECT COUNT(*) FROM inventory_item WHERE clinic_id = v_clinic_id) >= 5 THEN
    RAISE NOTICE '[seed] Inventory already seeded for clinic % — skipped', v_clinic_id;
    RETURN;
  END IF;

  RAISE NOTICE '[seed] Seeding inventory for clinic %', v_clinic_id;

  -- ── 1. Composite Resin A2 — IN STOCK ──────────────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Composite Resin A2', '3M Filtek Z250', 'dental_material', 'piece', 5, 10, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'CR-2024-01', '2026-06-30', 20, 'piece', 'Dental Depot', '2024-01-15')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 20, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1,  8, 'seed', v_actor_id);
  -- Net: 12 units  →  IN STOCK (reorder_point = 5)

  -- ── 2. Dental Bonding Agent — LOW STOCK + EXPIRING SOON ───────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Dental Bonding Agent', 'Scotchbond Universal', 'dental_material', 'vial', 3, 6, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'BA-2023-09', (CURRENT_DATE + INTERVAL '18 days')::date, 15, 'vial', 'Dental Depot', '2023-09-10')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 15, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 13, 'seed', v_actor_id);
  -- Net: 2 vials  →  LOW STOCK (reorder_point = 3) + expiring in 18 days

  -- ── 3. Lidocaine 2% (Cartridge) — OUT OF STOCK ────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Lidocaine 2% Cartridge', 'Lignocaine HCl', 'medication', 'piece', 10, 20, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'LID-2023-06', '2025-12-31', 30, 'piece', 'MedPharm Suppliers', '2023-06-01')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 30, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 30, 'seed', v_actor_id);
  -- Net: 0  →  OUT OF STOCK

  -- ── 4. Surgical Blade #15 — IN STOCK ──────────────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Surgical Blade #15', NULL, 'disposable', 'piece', 10, 25, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'SB-2024-03', '2027-03-31', 50, 'piece', 'Surgi Supplies Co.', '2024-03-05')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 50, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 20, 'seed', v_actor_id);
  -- Net: 30 pieces  →  IN STOCK

  -- ── 5. Alginate Impression Material — LOW STOCK + EXPIRING SOON ───────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Alginate Impression Material', 'Jeltrate Plus', 'dental_material', 'sachet', 5, 10, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'AIM-2023-11', (CURRENT_DATE + INTERVAL '10 days')::date, 12, 'sachet', 'Orthodontic World', '2023-11-20')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 12, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 10, 'seed', v_actor_id);
  -- Net: 2 sachets  →  LOW STOCK (reorder_point = 5) + expiring in 10 days

  -- ── 6. Titanium Implant 3.5×10mm — IN STOCK ───────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable, is_implant)
  VALUES
    (v_org_id, v_clinic_id, 'Titanium Implant 3.5×10mm', 'Nobel Parallel CC', 'implant', 'piece', 2, 5, true, true)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'IMP-2024-A1', '2029-12-31', 8, 'piece', 'Nobel Biocare India', '2024-02-10')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 8, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 3, 'seed', v_actor_id);
  -- Net: 5 pieces  →  IN STOCK (reorder_point = 2)

  -- ── 7. Vicryl Suture 3-0 — LOW STOCK ─────────────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Vicryl Suture 3-0', 'Polyglactin 910', 'disposable', 'piece', 5, 10, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'SUT-2023-12', '2026-09-30', 20, 'piece', 'Ethicon Distributor', '2023-12-01')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 20, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 18, 'seed', v_actor_id);
  -- Net: 2 pieces  →  LOW STOCK (reorder_point = 5)

  -- ── 8. Collagen Membrane — OUT OF STOCK ───────────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable, is_implant)
  VALUES
    (v_org_id, v_clinic_id, 'Collagen Membrane 20×30mm', 'Bio-Gide', 'membrane', 'piece', 2, 4, true, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'MEM-2023-08', '2025-08-31', 5, 'piece', 'Geistlich India', '2023-08-20')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 5, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1, 5, 'seed', v_actor_id);
  -- Net: 0  →  OUT OF STOCK

  -- ── 9. Fluoride Varnish — IN STOCK ────────────────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Fluoride Varnish 5%', 'Colgate Duraphat', 'dental_material', 'tube', 3, 6, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'FV-2024-02', '2026-02-28', 10, 'tube', 'Colgate Medical', '2024-02-01')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 10, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1,  2, 'seed', v_actor_id);
  -- Net: 8 tubes  →  IN STOCK (reorder_point = 3)

  -- ── 10. Latex Exam Gloves — IN STOCK ─────────────────────────────────────
  INSERT INTO inventory_item
    (org_id, clinic_id, name, generic_name, category, unit, reorder_point, reorder_quantity, is_traceable)
  VALUES
    (v_org_id, v_clinic_id, 'Latex Exam Gloves (Medium)', NULL, 'disposable', 'box', 5, 10, false)
  RETURNING id INTO v_item;

  INSERT INTO inventory_batch
    (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
  VALUES
    (v_item, v_clinic_id, 'GLV-2024-03', '2027-06-30', 20, 'box', 'SafeGuard Medicals', '2024-03-10')
  RETURNING id INTO v_batch;

  INSERT INTO stock_movement
    (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
  VALUES
    ('GOODS_RECEIPT', v_item, v_batch, v_clinic_id,  1, 20, 'seed', v_actor_id),
    ('CONSUMPTION',   v_item, v_batch, v_clinic_id, -1,  4, 'seed', v_actor_id);
  -- Net: 16 boxes  →  IN STOCK (reorder_point = 5)

  -- ── Refresh materialised view so GET /inventory/stock returns live data ────
  REFRESH MATERIALIZED VIEW current_stock;

  RAISE NOTICE '[seed] Done — 10 items seeded for clinic %', v_clinic_id;

END $$;
