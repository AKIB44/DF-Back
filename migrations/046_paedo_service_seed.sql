-- Migration 046: Paediatric service catalog seed
DO $$
DECLARE v_clinic_id UUID;
BEGIN
  SELECT id INTO v_clinic_id FROM clinics WHERE is_active = TRUE LIMIT 1;
  IF v_clinic_id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM services WHERE specialty_case_type = 'PAEDO' AND clinic_id = v_clinic_id LIMIT 1) THEN RETURN; END IF;
  INSERT INTO services (clinic_id, name, duration_minutes, price, description, specialty_case_type, creates_specialty_case) VALUES
  (v_clinic_id, 'Paedo Consultation', 30, 400, 'Paediatric dental assessment', 'PAEDO', TRUE),
  (v_clinic_id, 'Fluoride Varnish', 15, 500, 'Fluoride varnish application', 'PAEDO', FALSE),
  (v_clinic_id, 'Pit and Fissure Sealant', 20, 800, 'Sealant on permanent molar', 'PAEDO', FALSE),
  (v_clinic_id, 'Pulpotomy - Deciduous', 45, 2500, 'Pulpotomy on deciduous tooth', 'PAEDO', FALSE),
  (v_clinic_id, 'Stainless Steel Crown - Deciduous', 45, 3000, 'SSC on deciduous tooth', 'PAEDO', FALSE),
  (v_clinic_id, 'Extraction - Deciduous', 20, 800, 'Extraction of deciduous tooth', 'PAEDO', FALSE),
  (v_clinic_id, 'Space Maintainer', 30, 3500, 'Band and loop space maintainer', 'PAEDO', FALSE),
  (v_clinic_id, 'Nitrous Oxide Sedation', 30, 2000, 'N2O sedation for anxious child', 'PAEDO', FALSE),
  (v_clinic_id, 'Caries Risk Assessment', 15, 300, 'CAMBRA-style risk assessment', 'PAEDO', FALSE);
END $$;
