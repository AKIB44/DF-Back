-- Migration 040: Specialty Attachment Extension
-- Links session_attachments to specialty cases and adds photo series tagging

ALTER TABLE session_attachments
  ADD COLUMN IF NOT EXISTS specialty_case_id UUID REFERENCES specialty_case(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS photo_series_tag TEXT;

CREATE INDEX IF NOT EXISTS idx_session_att_spec_case ON session_attachments(specialty_case_id)
  WHERE specialty_case_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS specialty_photo_series_tag (
  tag           TEXT PRIMARY KEY,
  specialty     TEXT NOT NULL,
  label         TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0
);

-- Seed shared tags
INSERT INTO specialty_photo_series_tag (tag, specialty, label, display_order) VALUES
  ('FRONT_FACE',       'SHARED', 'Full Face – Frontal',         10),
  ('SMILE',            'SHARED', 'Smile View',                  20),
  ('PROFILE_LEFT',     'SHARED', 'Profile – Left',              30),
  ('PROFILE_RIGHT',    'SHARED', 'Profile – Right',             40),
  ('UPPER_OCCLUSAL',   'SHARED', 'Occlusal – Upper Arch',       50),
  ('LOWER_OCCLUSAL',   'SHARED', 'Occlusal – Lower Arch',       60),
  ('BUCCAL_LEFT',      'SHARED', 'Buccal – Left',               70),
  ('BUCCAL_RIGHT',     'SHARED', 'Buccal – Right',              80),
  ('FRONTAL_OCCL',     'SHARED', 'Frontal – In Occlusion',      90),
  ('OPG',              'SHARED', 'OPG Radiograph',             100),
  ('CEPH',             'ORTHO',  'Cephalometric Radiograph',   110),
  ('STUDY_MODEL',      'ORTHO',  'Study Model',                120),
  ('WIRE_CHANGE',      'ORTHO',  'Wire Change Record',         130),
  ('IMPLANT_PRE',      'IMPLANT','Pre-Implant Site',           140),
  ('IMPLANT_POST',     'IMPLANT','Post-Implant Placement',     150),
  ('IMPLANT_UNCOVERY', 'IMPLANT','Implant Uncovery',           160),
  ('CROWN_TRY',        'IMPLANT','Crown Try-in',               170),
  ('PAEDO_SPACE',      'PAEDO', 'Space Maintainer',            180),
  ('PAEDO_PULP',       'PAEDO', 'Pulpotomy Record',            190),
  ('ENDO_WORKING_LEN', 'ENDO',  'Working Length Radiograph',   200),
  ('ENDO_OBTURATION',  'ENDO',  'Obturation Radiograph',       210),
  ('TMJ_MRI',          'TMJ',   'TMJ MRI',                     220),
  ('TMJ_SPLINT',       'TMJ',   'Occlusal Splint',             230)
ON CONFLICT (tag) DO NOTHING;
