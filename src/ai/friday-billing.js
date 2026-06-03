// Friday — resolve patient billing from voice (DB search or UI context).

const db = require('../db');

const BILLING_SQL = `
  SELECT
    COUNT(DISTINCT cs.id)::int                         AS session_count,
    COALESCE(SUM(sp.final_charge), 0)::numeric        AS total_billed,
    COUNT(sp.id)::int                                  AS procedure_count
  FROM clinical_session cs
  LEFT JOIN service_performed sp ON sp.session_id = cs.id
  WHERE cs.patient_id = $1 AND cs.clinic_id = $2
`;

function formatInr(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '₹0';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n);
}

function billingMessage(patientName, billing, aspect) {
  const total = Number(billing.total_billed);
  const due   = Number(billing.due_amount);
  const visits = billing.session_count;
  const procs  = billing.procedure_count;

  if (aspect === 'total') {
    return `${patientName} has ${formatInr(total)} in total charges across ${visits} visit${visits === 1 ? '' : 's'} (${procs} procedure${procs === 1 ? '' : 's'}).`;
  }
  if (total === 0) {
    return `${patientName} has no clinical charges on file yet.`;
  }
  const note = billing.payments_tracked
    ? ''
    : ' Payment tracking is not enabled yet — due equals total charges.';
  return `${patientName} has ${formatInr(due)} due (${formatInr(total)} total billed, ${visits} visit${visits === 1 ? '' : 's'}).${note}`;
}

async function fetchBillingSummary(patientId, clinicId) {
  const { rows } = await db.query(BILLING_SQL, [patientId, clinicId]);
  const row = rows[0] || { session_count: 0, total_billed: 0, procedure_count: 0 };
  const total = Number(row.total_billed);
  return {
    session_count:    row.session_count,
    procedure_count:  row.procedure_count,
    total_billed:     total,
    due_amount:       total,
    payments_tracked: false,
  };
}

async function findPatientsByQuery(clinicId, query, limit = 5) {
  const { rows } = await db.query(
    `SELECT id, name, phone
       FROM patients
      WHERE clinic_id = $1
        AND (name ILIKE '%' || $2 || '%' OR phone ILIKE '%' || $2 || '%')
      ORDER BY name ASC
      LIMIT $3`,
    [clinicId, query, limit]
  );
  return rows;
}

async function getPatientById(clinicId, patientId) {
  const { rows } = await db.query(
    `SELECT id, name, phone FROM patients WHERE id = $1 AND clinic_id = $2`,
    [patientId, clinicId]
  );
  return rows[0] || null;
}

/**
 * Resolve billing for a patient using UI context (patient_id) and/or spoken name search.
 */
async function resolveBillingForPatient(clinicId, { patient_id, query, aspect }) {
  const aspectNorm = aspect === 'total' ? 'total' : 'due';
  let patient     = null;
  let source      = null;

  if (patient_id) {
    patient = await getPatientById(clinicId, patient_id);
    if (patient) source = 'ui';
  }

  if (!patient && query && String(query).trim().length >= 2) {
    const matches = await findPatientsByQuery(clinicId, String(query).trim());
    if (matches.length === 1) {
      patient = matches[0];
      source  = 'search';
    } else if (matches.length > 1) {
      return {
        status:  'ambiguous',
        source:  'search',
        message: `I found ${matches.length} patients matching "${query}". Say the full name or open their chart.`,
        action:  { type: 'select_patient', candidates: matches },
        candidates: matches.map(p => ({ id: p.id, name: p.name, phone: p.phone })),
      };
    } else {
      return {
        status:  'not_found',
        source:  'search',
        message: `No patient found matching "${query}".`,
        action:  { type: 'search_patient', query: String(query).trim() },
      };
    }
  }

  if (!patient && !query) {
    return {
      status:  'need_patient',
      message: 'Which patient should I check billing for? Say a name or open their chart first.',
      action:  { type: 'need_patient' },
    };
  }

  if (!patient) {
    return {
      status:  'not_found',
      message: 'Patient not found.',
      action:  { type: 'search_patient', query: query || null },
    };
  }

  const billing = await fetchBillingSummary(patient.id, clinicId);
  const message = billingMessage(patient.name, billing, aspectNorm);

  return {
    status:   'ok',
    source,
    patient:  { id: patient.id, name: patient.name, phone: patient.phone },
    billing,
    message,
    action: {
      type:       'open_patient_billing',
      patient_id: patient.id,
      target:     'accounts',
    },
  };
}

module.exports = {
  resolveBillingForPatient,
  fetchBillingSummary,
  formatInr,
};
