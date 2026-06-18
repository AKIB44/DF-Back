'use strict';

// Builds a SQL query over the patient CRM from a segment filter_json.
// Supported filters (all optional, AND-combined):
//   city            — patients.address ILIKE %city%
//   gender          — 'male' | 'female' | 'other'
//   has_email       — true → only patients with an email
//   min_visits      — ≥ N completed appointments
//   last_visit_before / last_visit_after — last completed visit date window
// Returns { inner, params } — an inner SELECT the caller wraps for count / sample
// / recipient-phone extraction.

function buildInner(clinicId, filter) {
  const params = [clinicId];
  const where = ['p.clinic_id = $1'];
  const having = [];
  const f = filter || {};

  if (f.city)      { params.push(`%${f.city}%`); where.push(`p.address ILIKE $${params.length}`); }
  if (f.gender)    { params.push(f.gender);      where.push(`p.gender = $${params.length}`); }
  if (f.has_email) { where.push(`p.email IS NOT NULL AND p.email <> ''`); }

  if (Number.isFinite(Number(f.min_visits)) && Number(f.min_visits) > 0) {
    params.push(Number(f.min_visits));
    having.push(`COUNT(a.id) FILTER (WHERE a.status = 'done') >= $${params.length}`);
  }
  if (f.last_visit_before) {
    params.push(f.last_visit_before);
    having.push(`MAX(a.scheduled_at) FILTER (WHERE a.status = 'done') < $${params.length}`);
  }
  if (f.last_visit_after) {
    params.push(f.last_visit_after);
    having.push(`MAX(a.scheduled_at) FILTER (WHERE a.status = 'done') >= $${params.length}`);
  }

  const inner = `
    SELECT p.id, p.name, p.phone, p.email,
           COUNT(a.id) FILTER (WHERE a.status = 'done')         AS visits,
           MAX(a.scheduled_at) FILTER (WHERE a.status = 'done') AS last_visit
      FROM patients p
      LEFT JOIN appointments a ON a.patient_id = p.id
     WHERE ${where.join(' AND ')}
     GROUP BY p.id, p.name, p.phone, p.email
     ${having.length ? 'HAVING ' + having.join(' AND ') : ''}`;

  return { inner, params };
}

module.exports = { buildInner };
