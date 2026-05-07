require('dotenv').config();
const db = require('../src/db');

const SERVICE_CODES = [
  ['Oral Prophylaxis', 'SVC-01'],
  ['Restoration',      'SVC-02'],
  ['Root Canal',       'SVC-03'],
  ['Extraction',       'SVC-04'],
  ['Orthodontics',     'SVC-05'],
  ['Implant',          'SVC-06'],
  ['Pulpectomy',       'SVC-07'],
];

const MEDICINES = [
  { generic_name: 'Amoxicillin',               brand_name: 'Amoxil / Mox',       category: 'antibiotic',        dosage_form: 'tablet',    strength: '500mg',  default_dose: '1-0-1 after food',       default_days: 5,    notes: 'Broad spectrum — RCT, Extraction, Implant' },
  { generic_name: 'Amoxicillin + Clavulanate',  brand_name: 'Augmentin',          category: 'antibiotic',        dosage_form: 'tablet',    strength: '625mg',  default_dose: '1-0-1 after food',       default_days: 5,    notes: 'Severe infection — Extraction, Implant' },
  { generic_name: 'Metronidazole',              brand_name: 'Flagyl / Metrogyl',  category: 'antibiotic',        dosage_form: 'tablet',    strength: '400mg',  default_dose: '1-1-1 after food',       default_days: 5,    notes: 'Anaerobic coverage — Extraction, Periodontics' },
  { generic_name: 'Azithromycin',               brand_name: 'Zithromax',          category: 'antibiotic',        dosage_form: 'tablet',    strength: '500mg',  default_dose: '1-0-0',                  default_days: 3,    notes: 'Penicillin allergy alternative' },
  { generic_name: 'Doxycycline',                brand_name: 'Doxt',               category: 'antibiotic',        dosage_form: 'capsule',   strength: '100mg',  default_dose: '1-0-1 after food',       default_days: 7,    notes: 'Periodontal adjunct' },
  { generic_name: 'Ibuprofen',                  brand_name: 'Brufen / Combiflam', category: 'anti_inflammatory', dosage_form: 'tablet',    strength: '400mg',  default_dose: '1-1-1 after food',       default_days: 3,    notes: 'Standard pain — all services' },
  { generic_name: 'Paracetamol',                brand_name: 'Crocin / Dolo',      category: 'analgesic',         dosage_form: 'tablet',    strength: '500mg',  default_dose: '1-1-1 after food',       default_days: 3,    notes: 'Mild pain — safe if NSAIDs contraindicated' },
  { generic_name: 'Diclofenac',                 brand_name: 'Voveran',            category: 'anti_inflammatory', dosage_form: 'tablet',    strength: '50mg',   default_dose: '0-1-1 after food',       default_days: 3,    notes: 'Stronger anti-inflammatory — post-surgical' },
  { generic_name: 'Pantoprazole',               brand_name: 'Pan / Pantodac',     category: 'other',             dosage_form: 'tablet',    strength: '40mg',   default_dose: '1-0-0 before breakfast', default_days: 5,    notes: 'GI protection with antibiotics' },
  { generic_name: 'Chlorhexidine mouthwash',    brand_name: 'Hexidine / Clohex',  category: 'antiseptic',        dosage_form: 'mouthwash', strength: '0.2%',   default_dose: 'Rinse 30ml 2x/day',      default_days: 7,    notes: 'Post-scaling, post-extraction, RCT' },
  { generic_name: 'Clove oil (eugenol)',         brand_name: 'Clove Oil',          category: 'topical',           dosage_form: 'drops',     strength: 'pure',   default_dose: '2 drops on cotton SOS',  default_days: null, notes: 'Inter-session RCT pain relief' },
  { generic_name: 'Lignocaine gel',              brand_name: 'Xylocaine 2%',       category: 'topical',           dosage_form: 'gel',       strength: '2%',     default_dose: 'Apply before procedure', default_days: null, notes: 'Topical anaesthesia pre-injection' },
  { generic_name: 'Fluoride varnish',            brand_name: 'Fluor Protector',    category: 'topical',           dosage_form: 'gel',       strength: '5%',     default_dose: 'Apply post-scaling',     default_days: null, notes: 'SVC-01 Oral Prophylaxis' },
  { generic_name: 'Vitamin C + Zinc',            brand_name: 'Limcee + Zincovit',  category: 'vitamin',           dosage_form: 'tablet',    strength: 'combo',  default_dose: '1-0-0',                  default_days: 7,    notes: 'Post-implant healing support' },
];

const PROCEDURES = [
  { procedure_code: 'PROP-SCAL',  procedure_name: 'Scaling and polishing',                        svc_id: 'SVC-01', procedure_step: null, duration_days: 1, followup_days: 180, default_notes: 'Avoid hard/crunchy food for 24 hours. Mild sensitivity normal for 48 hours. Use soft toothbrush.' },
  { procedure_code: 'REST-COMP',  procedure_name: 'Composite restoration',                        svc_id: 'SVC-02', procedure_step: null, duration_days: 1, followup_days: 7,   default_notes: 'Avoid biting on filled side for 2 hours. No staining foods for 24 hours.' },
  { procedure_code: 'RCT-ACCESS', procedure_name: 'Access opening and pulp extirpation',          svc_id: 'SVC-03', procedure_step: 1,    duration_days: 2, followup_days: 7,   default_notes: 'Sensitivity expected for 24-48 hours. Use clove oil on cotton SOS. Avoid hard food on this side.' },
  { procedure_code: 'RCT-BIOM',   procedure_name: 'Biomechanical preparation',                   svc_id: 'SVC-03', procedure_step: 2,    duration_days: 3, followup_days: 7,   default_notes: 'Mild soreness normal for 2-3 days. Continue antibiotics. Return immediately if severe swelling or fever above 101F.' },
  { procedure_code: 'RCT-OBTUR',  procedure_name: 'Obturation (gutta-percha fill)',               svc_id: 'SVC-03', procedure_step: 3,    duration_days: 5, followup_days: 14,  default_notes: 'Tooth may feel tender 3-5 days. Crown placement is next and final step — book within 2 weeks.' },
  { procedure_code: 'RCT-CROWN',  procedure_name: 'Post and core plus crown placement',           svc_id: 'SVC-03', procedure_step: 4,    duration_days: 0, followup_days: 365, default_notes: 'Avoid very hard foods on crown for 1 week. Annual review recommended.' },
  { procedure_code: 'EXT-SIMPLE', procedure_name: 'Simple extraction',                            svc_id: 'SVC-04', procedure_step: null, duration_days: 3, followup_days: 7,   default_notes: 'Bite on gauze 30 minutes. No rinsing for 24 hours. No smoking or alcohol for 48 hours. Soft foods 3 days.' },
  { procedure_code: 'EXT-SURG',   procedure_name: 'Surgical extraction (impacted tooth)',         svc_id: 'SVC-04', procedure_step: null, duration_days: 5, followup_days: 7,   default_notes: 'Swelling peaks at 48 hours. Ice pack first 24 hours. Stitches removed in 7 days.' },
  { procedure_code: 'ORTHO-BOND', procedure_name: 'Bracket bonding session',                     svc_id: 'SVC-05', procedure_step: null, duration_days: 3, followup_days: 30,  default_notes: 'Mild soreness 3-5 days — completely normal. Avoid sticky/hard foods.' },
  { procedure_code: 'ORTHO-ADJ',  procedure_name: 'Wire adjustment and activation',              svc_id: 'SVC-05', procedure_step: null, duration_days: 2, followup_days: 30,  default_notes: 'Teeth sore 2-4 days after each adjustment. Take paracetamol if needed.' },
  { procedure_code: 'ORTHO-DEB',  procedure_name: 'Debonding and retainer fitting',              svc_id: 'SVC-05', procedure_step: null, duration_days: 1, followup_days: 30,  default_notes: 'Wear retainer as instructed — full time first 6 months then night only.' },
  { procedure_code: 'IMP-PLACE',  procedure_name: 'Implant fixture placement',                   svc_id: 'SVC-06', procedure_step: 1,    duration_days: 7, followup_days: 90,  default_notes: 'Swelling and bruising normal 3-5 days. Soft foods only 2 weeks. No smoking critical for osseointegration.' },
  { procedure_code: 'IMP-ABUT',   procedure_name: 'Abutment placement (post-osseointegration)',  svc_id: 'SVC-06', procedure_step: 2,    duration_days: 3, followup_days: 14,  default_notes: 'Gum may be slightly sore for a few days. Soft toothbrush around abutment.' },
  { procedure_code: 'IMP-CROWN',  procedure_name: 'Implant crown delivery',                      svc_id: 'SVC-06', procedure_step: 3,    duration_days: 0, followup_days: 365, default_notes: 'Avoid very hard foods on crown for 1 week. Floss daily around implant. Annual review mandatory.' },
  { procedure_code: 'PULP-PULP',  procedure_name: 'Pulpectomy and medicated dressing',           svc_id: 'SVC-07', procedure_step: 1,    duration_days: 2, followup_days: 7,   default_notes: 'Child may have mild soreness 1-2 days. Give paracetamol syrup if uncomfortable.' },
  { procedure_code: 'PULP-FILL',  procedure_name: 'Pulp canal filling with ZOE paste',           svc_id: 'SVC-07', procedure_step: 2,    duration_days: 1, followup_days: 7,   default_notes: 'Avoid hard foods on this side. Child should have minimal discomfort.' },
  { procedure_code: 'PULP-CROWN', procedure_name: 'Stainless steel crown placement',             svc_id: 'SVC-07', procedure_step: 3,    duration_days: 0, followup_days: 180, default_notes: 'The stainless steel crown will come out with the baby tooth naturally. Brush and floss normally.' },
];

const SERVICE_DEFAULTS = {
  'SVC-01': [['Chlorhexidine mouthwash', 1], ['Fluoride varnish', 2]],
  'SVC-03': [['Amoxicillin', 1], ['Ibuprofen', 2], ['Pantoprazole', 3], ['Clove oil (eugenol)', 4], ['Chlorhexidine mouthwash', 5]],
  'SVC-04': [['Amoxicillin', 1], ['Metronidazole', 2], ['Ibuprofen', 3], ['Pantoprazole', 4], ['Chlorhexidine mouthwash', 5]],
  'SVC-06': [['Amoxicillin + Clavulanate', 1], ['Ibuprofen', 2], ['Pantoprazole', 3], ['Vitamin C + Zinc', 4]],
  'SVC-07': [['Paracetamol', 1], ['Amoxicillin', 2]],
};

async function seedForClinic(clinicId) {
  console.log(`\nSeeding rx master data for clinic: ${clinicId}`);

  // 1. Stamp service codes
  for (const [name, code] of SERVICE_CODES) {
    await db.query(
      `UPDATE services SET code = $1 WHERE name = $2 AND clinic_id = $3 AND code IS NULL`,
      [code, name, clinicId]
    );
  }

  // 2. Seed medicines — skip if already present for this clinic
  const medIds = {};
  for (const m of MEDICINES) {
    const existing = await db.query(
      `SELECT id FROM rx_medicines WHERE clinic_id = $1 AND generic_name = $2`,
      [clinicId, m.generic_name]
    );
    if (existing.rows.length) {
      medIds[m.generic_name] = existing.rows[0].id;
      continue;
    }
    const result = await db.query(
      `INSERT INTO rx_medicines
         (clinic_id, generic_name, brand_name, category, dosage_form, strength, default_dose, default_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [clinicId, m.generic_name, m.brand_name, m.category, m.dosage_form,
       m.strength, m.default_dose, m.default_days ?? null, m.notes]
    );
    medIds[m.generic_name] = result.rows[0].id;
  }
  console.log(`  Medicines: ${Object.keys(medIds).length} ready.`);

  // 3. Seed procedures
  for (const p of PROCEDURES) {
    await db.query(
      `INSERT INTO rx_procedures
         (clinic_id, procedure_code, procedure_name, svc_id, procedure_step,
          default_notes, duration_days, followup_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (clinic_id, procedure_code) DO NOTHING`,
      [clinicId, p.procedure_code, p.procedure_name, p.svc_id,
       p.procedure_step ?? null, p.default_notes, p.duration_days, p.followup_days ?? null]
    );
  }
  console.log(`  Procedures: ${PROCEDURES.length} ready.`);

  // 4. Seed service defaults
  for (const [svcId, pairs] of Object.entries(SERVICE_DEFAULTS)) {
    for (const [genericName, sortOrder] of pairs) {
      const medId = medIds[genericName];
      if (!medId) continue;
      await db.query(
        `INSERT INTO rx_service_defaults (clinic_id, svc_id, medicine_id, sort_order)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (clinic_id, svc_id, medicine_id) DO NOTHING`,
        [clinicId, svcId, medId, sortOrder]
      );
    }
  }
  console.log(`  Service defaults ready.`);
}

async function run() {
  // Accept a specific clinic_id from CLI arg, or seed all clinics
  const targetClinicId = process.argv[2];

  let clinicIds;
  if (targetClinicId) {
    clinicIds = [targetClinicId];
  } else {
    const result = await db.query(`SELECT id FROM clinics WHERE is_active = true ORDER BY created_at ASC`);
    clinicIds = result.rows.map(r => r.id);
  }
  
  if (!clinicIds.length) {
    console.log('No clinics found. Run the main seed first: npm run seed');
    return;
  }

  for (const clinicId of clinicIds) {
    await seedForClinic(clinicId);
  }

  console.log('\nRx master seed complete.');
}

run().catch(console.error).finally(async () => {
  try { await db.pool.end(); } catch (_) {}
  process.exit();
});
