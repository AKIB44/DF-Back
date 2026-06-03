-- Migration 044: Implantology service catalog seed
DO $$
DECLARE v_clinic_id UUID;
BEGIN
  SELECT id INTO v_clinic_id FROM clinics WHERE is_active = TRUE LIMIT 1;
  IF v_clinic_id IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM services WHERE specialty_case_type = 'IMPLANT' AND clinic_id = v_clinic_id LIMIT 1) THEN RETURN; END IF;
  INSERT INTO services (clinic_id, name, duration_minutes, price, description, specialty_case_type, creates_specialty_case) VALUES
  (v_clinic_id, 'Implant Consultation', 30, 500, 'Initial implant assessment', 'IMPLANT', FALSE),
  (v_clinic_id, 'Implant Placement - Single Fixture', 90, 30000, 'Single dental implant placement', 'IMPLANT', TRUE),
  (v_clinic_id, 'Implant Placement - Multiple', 120, 28000, 'Multiple implant placement (per fixture)', 'IMPLANT', TRUE),
  (v_clinic_id, 'Bone Graft - Xenograft', 60, 15000, 'Xenograft bone augmentation', 'IMPLANT', FALSE),
  (v_clinic_id, 'Sinus Lift - Direct', 90, 20000, 'Direct sinus augmentation', 'IMPLANT', FALSE),
  (v_clinic_id, 'Second Stage Surgery', 45, 5000, 'Implant uncovering and healing abutment', 'IMPLANT', FALSE),
  (v_clinic_id, 'Implant Crown - Screw Retained', 60, 18000, 'Screw-retained implant crown', 'IMPLANT', FALSE),
  (v_clinic_id, 'Implant Crown - Cement Retained', 60, 16000, 'Cement-retained implant crown', 'IMPLANT', FALSE),
  (v_clinic_id, 'Annual Implant Maintenance', 30, 2000, 'Annual peri-implant maintenance', 'IMPLANT', FALSE),
  (v_clinic_id, 'Implant Explantation', 60, 8000, 'Removal of failed implant', 'IMPLANT', FALSE);
END $$;
