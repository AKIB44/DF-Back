const db = require('../db');

async function checkIsOrgAdmin(userId) {
  const { rows } = await db.query(
    `SELECT 1 FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND r.code = 'org_admin'
       AND (ur.valid_to IS NULL OR ur.valid_to > now())
       AND ur.valid_from <= now()
     LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

async function getAvailableClinics(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT clinic_id FROM user_roles
     WHERE user_id = $1 AND clinic_id IS NOT NULL
       AND (valid_to IS NULL OR valid_to > now())
       AND valid_from <= now()`,
    [userId]
  );
  return rows.map(r => r.clinic_id);
}

module.exports = { checkIsOrgAdmin, getAvailableClinics };
