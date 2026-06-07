// ────────────────────────────────────────────────────────────────────────────
// Response field filter (PRD §6).
// ────────────────────────────────────────────────────────────────────────────
//
// Strips fields the subject's role isn't allowed to see before the response
// leaves the server. Wraps res.json so the controller code stays clean.
//
//   router.get('/sessions/:id',
//     authenticate, loadResource('session','id'),
//     authorize('read','session'),
//     fieldFilter('session'),
//     ctrl.getById);
//
// Visibility profiles live in this file; new roles / resources extend the
// VISIBILITY_PROFILES map. '*' means all fields; [] means deny-all.
// ────────────────────────────────────────────────────────────────────────────

const { buildSubject } = require('../helpers/build-subject');

const ALL = ['*'];
const NONE = [];

const VISIBILITY_PROFILES = {
  reception: {
    session:           ['id', 'booking_id', 'patient_id', 'status', 'started_at', 'ended_at'],
    patient:           ['id', 'name', 'phone', 'email', 'age', 'gender', 'address', 'created_at'],
    charge_line:       ALL,
    payment:           ALL,
    invoice:           ALL,
    booking:           ALL,
    clinical_note:     NONE,
    examination:       NONE,
    diagnosis:         NONE,
    prescription:      NONE,
    service_performed: ['id', 'service_catalog_id', 'final_charge', 'status'],
  },
  assistant: {
    session:           ['id', 'booking_id', 'patient_id', 'status', 'doctor_id', 'started_at', 'ended_at'],
    patient:           ['id', 'name', 'phone', 'age', 'gender', 'clinical_history'],
    charge_line:       NONE,
    payment:           NONE,
    invoice:           NONE,
    clinical_note:     ALL,
    examination:       ALL,
    diagnosis:         ALL,
    prescription:      ALL,
    service_performed: ['id', 'service_catalog_id', 'tooth_numbers', 'status', 'performed_by', 'notes'],
  },
  hygienist: {
    session:           ALL,
    patient:           ALL,
    charge_line:       NONE,
    payment:           NONE,
    invoice:           NONE,
    clinical_note:     ALL,
    examination:       ALL,
    diagnosis:         ALL,
    prescription:      ALL,
    service_performed: ALL,
  },
  // Doctor / clinic_admin / org_admin / super_admin / manager / accountant
  // default to '*' across the board — they are added at lookup time.
};

function profileFor(role, resourceType) {
  const fallbackAll = ALL;
  if (['doctor','manager','clinic_admin','org_admin','accountant','lab_tech'].includes(role)) {
    return fallbackAll;
  }
  const map = VISIBILITY_PROFILES[role];
  if (!map) return fallbackAll;
  return map[resourceType] || fallbackAll;
}

function pickFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  if (fields === ALL || fields.includes('*')) return obj;
  if (fields.length === 0) return {};      // deny-all
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

/**
 * @param {string} resourceType
 * @param {Object} [opts]
 * @param {string} [opts.collection]  property name on the response holding the array (e.g. 'sessions')
 * @param {string} [opts.entity]      property name holding a single entity (e.g. 'session')
 */
function fieldFilter(resourceType, opts = {}) {
  return async function fieldFilterMw(req, res, next) {
    try {
      const subject = await buildSubject(req);
      const fields  = profileFor(subject.role, resourceType);
      // Hot path: nothing to do for full-access roles.
      if (fields === ALL || (Array.isArray(fields) && fields.includes('*'))) return next();

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        try {
          if (!body || typeof body !== 'object') return originalJson(body);
          const out = { ...body };
          if (opts.collection && Array.isArray(out[opts.collection])) {
            out[opts.collection] = out[opts.collection].map(o => pickFields(o, fields));
          } else if (opts.entity && out[opts.entity]) {
            out[opts.entity] = pickFields(out[opts.entity], fields);
          } else {
            // Naive top-level pick — works when the controller returns the
            // resource at the root.
            return originalJson(pickFields(out, fields));
          }
          return originalJson(out);
        } catch (e) {
          console.warn('[field-filter] passthrough on error:', e.message);
          return originalJson(body);
        }
      };
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { fieldFilter, VISIBILITY_PROFILES, profileFor };
