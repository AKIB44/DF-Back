-- Migration 050: TMJ service catalog seed
DO $$
DECLARE v_clinic_id UUID;
BEGIN
  SELECT id INTO v_clinic_id FROM clinics WHERE is_active = TRUE LIMIT 1;
  IF v_clinic_id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM services WHERE specialty_case_type = 'TMJ' AND clinic_id = v_clinic_id LIMIT 1) THEN RETURN; END IF;
  INSERT INTO services (clinic_id, name, duration_minutes, price, description, specialty_case_type, creates_specialty_case) VALUES
  (v_clinic_id, 'TMJ-OFP Consultation', 45, 800, 'TMJ & orofacial pain assessment', 'TMJ', TRUE),
  (v_clinic_id, 'DC/TMD Evaluation', 30, 500, 'Diagnostic Criteria for TMD evaluation', 'TMJ', FALSE),
  (v_clinic_id, 'Stabilisation Splint - Fabrication', 30, 8000, 'Michigan/stabilisation occlusal splint', 'TMJ', FALSE),
  (v_clinic_id, 'Splint Delivery and Adjustment', 20, 500, 'Splint delivery and adjustment visit', 'TMJ', FALSE),
  (v_clinic_id, 'Splint Adjustment - Routine', 15, 300, 'Routine splint equilibration', 'TMJ', FALSE),
  (v_clinic_id, 'GCPS Administration', 15, 200, 'Graded Chronic Pain Scale questionnaire', 'TMJ', FALSE),
  (v_clinic_id, 'Patient Education Session', 20, 400, 'TMJ patient education and counseling', 'TMJ', FALSE),
  (v_clinic_id, 'Emergency TMJ Visit', 30, 600, 'Urgent TMJ flare management', 'TMJ', FALSE),
  (v_clinic_id, 'Referral to Physiotherapy', 15, 0, 'Referral letter and coordination', 'TMJ', FALSE);
END $$;
