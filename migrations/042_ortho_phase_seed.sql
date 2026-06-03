-- Migration 042: Orthodontics Service Catalog Seed
-- Inserts ~10 ortho services into the services table for the first clinic
-- Idempotent: skips if any ORTHO specialty_case_type rows already exist

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM services WHERE specialty_case_type = 'ORTHO' LIMIT 1
  ) THEN
    INSERT INTO services (clinic_id, name, duration_minutes, price, description, specialty_case_type, creates_specialty_case)
    SELECT
      c.id,
      svc.name,
      svc.duration_minutes,
      svc.price,
      svc.description,
      svc.specialty_case_type,
      svc.creates_specialty_case
    FROM clinics c
    CROSS JOIN (
      VALUES
        ('Ortho Consultation',                    30,  500.00, 'Initial orthodontic consultation and records review',  'ORTHO', FALSE),
        ('Comprehensive Ortho - Metal Braces',    60, 8000.00, 'Full fixed metal brace treatment case opening',        'ORTHO', TRUE),
        ('Comprehensive Ortho - Ceramic Braces',  60,10000.00, 'Full fixed ceramic brace treatment case opening',      'ORTHO', TRUE),
        ('Comprehensive Ortho - Clear Aligners',  60,12000.00, 'Full clear aligner treatment case opening',            'ORTHO', TRUE),
        ('Archwire Change',                       20,  300.00, 'Replacement of upper and/or lower archwire',           'ORTHO', FALSE),
        ('Adjustment Visit',                      20,  250.00, 'Routine orthodontic adjustment and review',            'ORTHO', FALSE),
        ('Elastic Replacement & Instruction',     15,  150.00, 'Elastic configuration change and patient instruction', 'ORTHO', FALSE),
        ('Debond and Polish',                     45,  600.00, 'Bracket removal, debond and tooth polishing',          'ORTHO', FALSE),
        ('Fixed Retainer Placement',              30,  700.00, 'Bonded fixed retainer placement upper/lower',          'ORTHO', FALSE),
        ('Retention Check',                       15,  200.00, 'Routine retention phase review appointment',           'ORTHO', FALSE)
    ) AS svc(name, duration_minutes, price, description, specialty_case_type, creates_specialty_case)
    LIMIT 10;
  END IF;
END $$;
