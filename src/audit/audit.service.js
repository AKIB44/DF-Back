const db = require('../db');

async function write(evt) {
  try {
    await db.query(
      `INSERT INTO rbac_audit_log
         (org_id, clinic_id, actor_type, actor_id, action,
          resource_type, resource_id, permission_used,
          ip_address, user_agent, metadata, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        evt.org_id        || null,
        evt.clinic_id     || null,
        evt.actor_type    || 'system',
        evt.actor_id      || null,
        evt.action,
        evt.resource_type || null,
        evt.resource_id   || null,
        evt.permission    || null,
        evt.ip_address    || null,
        evt.user_agent    || null,
        evt.metadata      ? JSON.stringify(evt.metadata) : null,
        evt.result        || 'success',
      ]
    );
  } catch (err) {
    // Audit failures must never crash the request
    console.error('[audit] write failed:', err.message);
  }
}

module.exports = { write };
