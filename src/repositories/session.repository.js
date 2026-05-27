const db = require('../db');

/**
 * All queries are scoped to org_id + clinic_id unless crossOrg is true.
 * ctx = { orgId, clinicId, userId }
 */

async function createSession(client, { orgId, clinicId, appointmentId, patientId, doctorId, userId }) {
  const { rows } = await client.query(
    `INSERT INTO clinical_session
       (org_id, clinic_id, appointment_id, patient_id, primary_doctor_id,
        status, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,'INITIALISED',$6,$6)
     RETURNING *`,
    [orgId, clinicId, appointmentId, patientId, doctorId, userId]
  );
  return rows[0];
}

async function findByAppointment(client, { orgId, clinicId, appointmentId }) {
  const { rows } = await client.query(
    `SELECT * FROM clinical_session
     WHERE org_id = $1 AND clinic_id = $2 AND appointment_id = $3
       AND deleted_at IS NULL
     ORDER BY started_at DESC
     LIMIT 1`,
    [orgId, clinicId, appointmentId]
  );
  return rows[0] || null;
}

async function findById(ctx, sessionId) {
  const { rows } = await db.query(
    `SELECT cs.*,
            p.name  AS patient_name,  p.phone AS patient_phone,
            p.age   AS patient_age,   p.gender AS patient_gender,
            p.clinical_history AS patient_clinical_history,
            a.scheduled_at, a.status AS appointment_status,
            u.first_name AS doctor_first_name, u.last_name AS doctor_last_name
     FROM clinical_session cs
     JOIN patients      p ON p.id = cs.patient_id
     JOIN appointments  a ON a.id = cs.appointment_id
     JOIN users         u ON u.id = cs.primary_doctor_id
     WHERE cs.id = $1
       AND cs.org_id = $2
       AND cs.clinic_id = $3
       AND cs.deleted_at IS NULL`,
    [sessionId, ctx.orgId, ctx.clinicId]
  );
  return rows[0] || null;
}

async function updateStatus(client, { orgId, clinicId, sessionId, status, userId, extra = {} }) {
  const setExtra = Object.entries(extra)
    .map(([k], i) => `"${k}" = $${i + 5}`)
    .join(', ');
  const extraVals = Object.values(extra);

  const { rows } = await client.query(
    `UPDATE clinical_session
     SET status = $1, updated_at = NOW(), updated_by = $2
         ${setExtra ? ', ' + setExtra : ''}
     WHERE id = $3 AND org_id = $4 AND clinic_id = $5 AND deleted_at IS NULL
     RETURNING *`,
    [status, userId, sessionId, orgId, clinicId, ...extraVals]
  );
  return rows[0] || null;
}

async function getNoteBySession(sessionId) {
  const { rows } = await db.query(
    `SELECT * FROM clinical_note WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId]
  );
  return rows[0] || null;
}

async function upsertNote(client, { orgId, clinicId, sessionId, userId, subjective, objective, assessment, plan }) {
  const { rows } = await client.query(
    `INSERT INTO clinical_note
       (org_id, clinic_id, session_id, subjective, objective, assessment, plan,
        created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (session_id) DO UPDATE
       SET subjective  = EXCLUDED.subjective,
           objective   = EXCLUDED.objective,
           assessment  = EXCLUDED.assessment,
           plan        = EXCLUDED.plan,
           updated_at  = NOW(),
           updated_by  = EXCLUDED.updated_by
     RETURNING *`,
    [orgId, clinicId, sessionId, subjective ?? '', objective ?? '', assessment ?? '', plan ?? '', userId]
  );
  return rows[0];
}

module.exports = {
  createSession,
  findByAppointment,
  findById,
  updateStatus,
  getNoteBySession,
  upsertNote,
};
