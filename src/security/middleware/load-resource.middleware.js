// ────────────────────────────────────────────────────────────────────────────
// loadResource(type, idParam) — pre-fetches a resource for the policy engine.
// ────────────────────────────────────────────────────────────────────────────
//
// The policy engine needs to know who *owns* a resource, its current status,
// and which branch it lives in — none of which are in the JWT. Each
// resource type has its own loader function that fetches the relevant
// attributes (not the full row) from the DB.
//
// Registry-based so new resource types can plug in without changing the
// middleware itself. A loader returns either an object or null (→ 404).
// ────────────────────────────────────────────────────────────────────────────

const db = require('../../db');

/** @type {Object<string, (id: string, req: any) => Promise<any|null>>} */
const loaders = {};

function registerLoader(type, loader) {
  loaders[type] = loader;
}

// ── Default loaders for resources already in the schema ───────────────────
registerLoader('session', async (id) => {
  const { rows } = await db.query(
    `SELECT cs.id, cs.patient_id, cs.primary_doctor_id AS owner_id, cs.status,
            cs.sealed_at, cs.clinic_id AS branch_id, cs.created_by,
            COALESCE(array_remove(array_agg(DISTINCT sp.performed_by), NULL), '{}') AS assistant_ids
       FROM clinical_session cs
       LEFT JOIN service_performed sp
              ON sp.session_id = cs.id
             AND sp.deleted_at IS NULL
       WHERE cs.id = $1
         AND cs.deleted_at IS NULL
       GROUP BY cs.id`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('patient', async (id) => {
  const { rows } = await db.query(
    `SELECT id, clinic_id AS branch_id FROM patients WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('booking', async (id) => {
  const { rows } = await db.query(
    `SELECT id, patient_id, status, clinic_id AS branch_id
       FROM appointments WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('specialty_case', async (id) => {
  const { rows } = await db.query(
    `SELECT id, patient_id, primary_doctor_id AS owner_id, status,
            case_type AS specialty_case_type, clinic_id AS branch_id
       FROM specialty_case
       WHERE id = $1
         AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('charge_line', async (id) => {
  const { rows } = await db.query(
    `SELECT sp.id, sp.session_id, sp.clinic_id AS branch_id, sp.status,
            cs.primary_doctor_id AS owner_id,
            sp.discount_pct,
            30 AS discount_hard_cap
       FROM service_performed sp
       JOIN clinical_session cs ON cs.id = sp.session_id
       WHERE sp.id = $1
         AND sp.deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('service_performed', async (id) => {
  const { rows } = await db.query(
    `SELECT sp.id, sp.session_id, sp.performed_by, sp.status,
            sp.clinic_id AS branch_id, sp.discount_pct,
            cs.patient_id, cs.primary_doctor_id AS owner_id, cs.sealed_at
       FROM service_performed sp
       JOIN clinical_session cs ON cs.id = sp.session_id
      WHERE sp.id = $1
        AND sp.deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('inventory_item', async (id) => {
  const { rows } = await db.query(
    `SELECT id, clinic_id AS branch_id
       FROM inventory_item
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('lab_order', async (id) => {
  const { rows } = await db.query(
    `SELECT lo.id, cs.patient_id, lo.status, lo.clinic_id AS branch_id,
            cs.primary_doctor_id AS owner_id, cs.sealed_at
       FROM lab_order lo
       JOIN clinical_session cs ON cs.id = lo.session_id
      WHERE lo.id = $1`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('investigation', async (id) => {
  const { rows } = await db.query(
    `SELECT io.id, io.session_id, cs.patient_id, io.status, io.clinic_id AS branch_id,
            cs.primary_doctor_id AS owner_id, cs.sealed_at
       FROM investigation_order io
       JOIN clinical_session cs ON cs.id = io.session_id
      WHERE io.id = $1`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('treatment_plan', async (id) => {
  const { rows } = await db.query(
    `SELECT id, patient_id, created_by AS owner_id, clinic_id AS branch_id
       FROM treatment_plan
      WHERE id = $1
        AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
});

registerLoader('treatment_plan_item', async (id) => {
  const { rows } = await db.query(
    `SELECT tpi.id, tpi.plan_id, tpi.status, tpi.clinic_id AS branch_id,
            tp.patient_id, tp.created_by AS owner_id
       FROM treatment_plan_item tpi
       JOIN treatment_plan tp ON tp.id = tpi.plan_id
      WHERE tpi.id = $1
        AND tpi.deleted_at IS NULL
        AND tp.deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
});

// Resources without a dedicated table (e.g. derived rows) can be loaded inline
// by the controller into req.resource and skip the middleware.

function loadResource(type, idParam = 'id') {
  return async function loadResourceMw(req, res, next) {
    try {
      const loader = loaders[type];
      if (!loader) {
        // No loader registered yet — let the controller set req.resource
        // and let authorize() run with the minimum attributes.
        req.resource = { type };
        return next();
      }
      const id = req.params[idParam];
      if (!id) {
        req.resource = { type };
        return next();
      }
      const row = await loader(id, req);
      if (!row) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      req.resource = {
        type,
        id:                 row.id,
        ownerId:            row.owner_id || row.created_by || null,
        patientId:          row.patient_id || null,
        status:             row.status || null,
        branchId:           row.branch_id || null,
        specialtyCaseType:  row.specialty_case_type || null,
        sealedAt:           row.sealed_at || null,
        extras:             row,
      };
      next();
    } catch (err) { next(err); }
  };
}

function mapLoadedResource(type, extra = {}) {
  return function mapLoadedResourceMw(req, _res, next) {
    req.resource = {
      ...(req.resource || {}),
      ...extra,
      type,
    };
    next();
  };
}

module.exports = { loadResource, registerLoader, mapLoadedResource };
