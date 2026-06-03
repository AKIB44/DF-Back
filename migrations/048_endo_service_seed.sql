-- Migration 048: Endodontics service catalog seed
DO $$
DECLARE v_clinic_id UUID;
BEGIN
  SELECT id INTO v_clinic_id FROM clinics WHERE is_active = TRUE LIMIT 1;
  IF v_clinic_id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM services WHERE specialty_case_type = 'ENDO' AND clinic_id = v_clinic_id LIMIT 1) THEN RETURN; END IF;
  INSERT INTO services (clinic_id, name, duration_minutes, price, description, specialty_case_type, creates_specialty_case) VALUES
  (v_clinic_id, 'Endo Consultation', 30, 500, 'Endodontic assessment', 'ENDO', FALSE),
  (v_clinic_id, 'RCT - Anterior (1 canal)', 60, 5000, 'Root canal treatment - single canal', 'ENDO', TRUE),
  (v_clinic_id, 'RCT - Premolar (2 canals)', 75, 7000, 'Root canal treatment - premolar', 'ENDO', TRUE),
  (v_clinic_id, 'RCT - Molar (3-4 canals)', 90, 10000, 'Root canal treatment - molar', 'ENDO', TRUE),
  (v_clinic_id, 'Retreatment - Molar', 90, 12000, 'Endodontic retreatment - molar', 'ENDO', TRUE),
  (v_clinic_id, 'Apicoectomy - Anterior', 60, 15000, 'Surgical root-end resection', 'ENDO', TRUE),
  (v_clinic_id, 'Pulp Capping - Direct', 30, 1500, 'Direct pulp capping (MTA/Biodentine)', 'ENDO', FALSE),
  (v_clinic_id, 'Emergency Endo Visit', 30, 1000, 'Emergency pain management', 'ENDO', FALSE),
  (v_clinic_id, 'Post and Core - Fibre', 45, 4000, 'Fibre post and composite core', 'ENDO', FALSE);
END $$;
