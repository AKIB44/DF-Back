const db = require('../db');

async function write(evt) {
  try {
    let { user_name, user_email } = evt;

    // JWT payload has no name/email — resolve from DB using user_id
    if (evt.user_id && !user_name) {
      const { rows } = await db.query(
        `SELECT first_name, last_name, email FROM users WHERE id = $1`,
        [evt.user_id]
      );
      if (rows[0]) {
        user_name  = `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim() || null;
        user_email = rows[0].email || null;
      }
    }

    await db.query(
      `INSERT INTO activity_log
         (user_id, clinic_id, user_name, user_email, method, path, action, details,
          entity_type, entity_id, status_code, duration_ms, ip_address,
          user_agent, request_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        evt.user_id     || null,
        evt.clinic_id   || null,
        user_name       || null,
        user_email      || null,
        evt.method,
        evt.path,
        evt.action      || null,
        evt.details     || null,
        evt.entity_type || null,
        evt.entity_id   || null,
        evt.status_code,
        evt.duration_ms || null,
        evt.ip_address  || null,
        evt.user_agent  || null,
        evt.request_body ? JSON.stringify(evt.request_body) : null,
      ]
    );
  } catch (err) {
    console.error('[activity] write failed:', err.message);
  }
}

module.exports = { write };
