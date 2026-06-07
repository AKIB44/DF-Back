// ────────────────────────────────────────────────────────────────────────────
// Access-decision audit writer (async, batched).
// ────────────────────────────────────────────────────────────────────────────
//
// PRD §10.2: audit writes are async, fire-and-forget. We use a simple
// in-process buffer flushed on a 500ms tick (or when 100 rows pile up).
// Postgres-only; no S3 archive in v1.
// ────────────────────────────────────────────────────────────────────────────

const db = require('../../db');

const BUFFER = [];
const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH         = 100;

let timer = null;

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

async function flush() {
  timer = null;
  if (BUFFER.length === 0) return;
  const batch = BUFFER.splice(0, MAX_BATCH);

  // Build a single multi-row INSERT.
  const cols  = ['user_id','role','clinic_id','branch_id','action','resource_type',
                 'resource_id','decision','policy_name','policy_version','reason',
                 'attributes','ip_address','user_agent','request_id'];
  const placeholders = [];
  const values = [];
  batch.forEach((row, i) => {
    const base = i * cols.length;
    placeholders.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
    for (const c of cols) values.push(row[c] ?? null);
  });

  try {
    await db.query(
      `INSERT INTO access_decision_log (${cols.join(',')}) VALUES ${placeholders.join(',')}`,
      values
    );
  } catch (err) {
    // Don't lose the rows if the write failed — push them back, capped.
    if (BUFFER.length < 1000) BUFFER.unshift(...batch);
    console.warn('[audit-decision] flush failed:', err.message);
  }

  if (BUFFER.length > 0) schedule();
}

/**
 * @param {import('../engine/types').PolicyContext} ctx
 * @param {import('../engine/types').DecisionResult} result
 */
async function recordDecision(ctx, result) {
  const { subject, resource, action, environment } = ctx;
  BUFFER.push({
    user_id:            subject.id,
    role:               subject.role,
    clinic_id:          resource.branchId || subject.branchId || null,
    branch_id:          resource.branchId || subject.branchId || null,
    action,
    resource_type:      resource.type,
    resource_id:        resource.id || null,
    decision:           result.decision,
    policy_name:        result.policy,
    policy_version:     result.policyVersion || null,
    reason:             result.reason || null,
    attributes:         JSON.stringify({
      specialtyTags:    subject.specialtyTags,
      hierarchyLevel:   subject.hierarchyLevel,
      resourceOwnerId:  resource.ownerId || null,
      resourceStatus:   resource.status || null,
    }),
    ip_address:         environment.ipAddress || null,
    user_agent:         environment.userAgent || null,
    request_id:         environment.requestId || null,
  });

  if (BUFFER.length >= MAX_BATCH) flush();
  else schedule();
}

module.exports = { recordDecision, _flushForTest: flush };
