/**
 * Copy data from an old database into the target (DATABASE_URL).
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgresql://...old... \
 *   DATABASE_URL=postgresql://...new... \
 *   node scripts/sync-from-source.js --yes
 *
 * Prerequisites on target: npm run migrate (schema + RBAC catalog from migrations).
 */
require('dotenv').config();
const { createPool, getConfigSummary } = require('../src/db');

const TABLE_ORDER = [
  'organizations',
  'clinics',
  'permissions',
  'roles',
  'role_permissions',
  'users',
  'user_roles',
  'permission_overrides',
  'chairs',
  'services',
  'patients',
  'appointments',
  'refresh_tokens',
  'rx_sequence',
  'rx_medicines',
  'rx_procedures',
  'rx_service_defaults',
  'prescriptions',
  'rx_line_items',
  'rbac_audit_log',
  'break_glass_sessions',
  'activity_log',
];

const SERIAL_TABLES = new Set(['activity_log']);

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function summarizeUrl(url, label) {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    const s = getConfigSummary();
    return `${label}: ${s.host}:${s.port}/${s.database} (${s.user})`;
  } finally {
    process.env.DATABASE_URL = prev;
  }
}

async function listTables(pool) {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  return new Set(rows.map((r) => r.tablename));
}

async function getColumns(pool, table) {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function copyTable(source, target, table, columns) {
  const colList = columns.map(quoteIdent).join(', ');
  const { rows } = await source.query(`SELECT ${colList} FROM ${quoteIdent(table)}`);
  if (!rows.length) {
    return 0;
  }

  const chunkSize = 100;
  let copied = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const tuples = chunk.map((row, rowIdx) => {
      const base = rowIdx * columns.length;
      const ph = columns.map((col, colIdx) => {
        values.push(row[col]);
        return `$${base + colIdx + 1}`;
      });
      return `(${ph.join(', ')})`;
    });

    const insertSql = SERIAL_TABLES.has(table)
      ? `INSERT INTO ${quoteIdent(table)} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`
      : `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${tuples.join(', ')}`;

    await target.query(insertSql, values);
    copied += chunk.length;
  }

  if (SERIAL_TABLES.has(table)) {
    await target.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1)
       )`,
      [table]
    );
  }

  return copied;
}

async function truncateTarget(target, tables) {
  const list = tables.map(quoteIdent).join(', ');
  await target.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function backfillUserRoles(target) {
  const { rowCount } = await target.query(
    `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by)
     SELECT
       u.id,
       r.id,
       u.clinic_id,
       NULL
     FROM users u
     JOIN roles r ON r.is_system = true AND r.code = CASE
       WHEN u.role = 'admin'        THEN 'clinic_admin'
       WHEN u.role = 'doctor'       THEN 'doctor'
       WHEN u.role = 'receptionist' THEN 'reception'
       ELSE 'reception'
     END
     WHERE u.clinic_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = u.id AND ur.clinic_id = u.clinic_id
       )`
  );
  return rowCount || 0;
}

async function runSync({ yes = false, skipCatalog = false } = {}) {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;

  if (!sourceUrl) {
    throw new Error('SOURCE_DATABASE_URL is required (old database connection string)');
  }
  if (!targetUrl) {
    throw new Error('DATABASE_URL is required (new/target database connection string)');
  }
  if (sourceUrl === targetUrl) {
    throw new Error('SOURCE_DATABASE_URL and DATABASE_URL must be different');
  }

  console.log(summarizeUrl(sourceUrl, 'Source'));
  console.log(summarizeUrl(targetUrl, 'Target'));

  const source = createPool(sourceUrl);
  const target = createPool(targetUrl);

  try {
    await source.query('SELECT 1');
    await target.query('SELECT 1');
    console.log('[sync] Both databases reachable');

    const sourceTables = await listTables(source);
    const targetTables = await listTables(target);

    let tables = TABLE_ORDER.filter((t) => sourceTables.has(t) && targetTables.has(t));
    if (skipCatalog) {
      tables = tables.filter((t) => !['permissions', 'role_permissions'].includes(t));
      console.log('[sync] Skipping permissions catalog (using migration seed on target)');
    }

    const missingOnSource = TABLE_ORDER.filter((t) => targetTables.has(t) && !sourceTables.has(t));
    if (missingOnSource.length) {
      console.log('[sync] Not on source (skipped):', missingOnSource.join(', '));
    }

    if (!tables.length) {
      throw new Error('No overlapping tables to copy');
    }

    if (!yes) {
      throw new Error('Refusing to truncate target without --yes');
    }

    console.log('[sync] Truncating target tables:', tables.join(', '));
    await truncateTarget(target, tables);

    for (const table of tables) {
      const sourceCols = await getColumns(source, table);
      const targetCols = await getColumns(target, table);
      const targetSet = new Set(targetCols);
      const columns = sourceCols.filter((c) => targetSet.has(c));

      if (!columns.length) {
        console.log(`[sync] ${table}: skipped (no shared columns)`);
        continue;
      }

      const dropped = sourceCols.filter((c) => !targetSet.has(c));
      if (dropped.length) {
        console.log(`[sync] ${table}: omitting source-only columns: ${dropped.join(', ')}`);
      }

      const count = await copyTable(source, target, table, columns);
      console.log(`[sync] ${table}: ${count} row(s)`);
    }

    const rolesAdded = await backfillUserRoles(target);
    if (rolesAdded) {
      console.log(`[sync] user_roles backfill: ${rolesAdded} row(s)`);
    }

    console.log('[sync] Complete');
  } finally {
    await source.end();
    await target.end();
  }
}

if (require.main === module) {
  const yes = process.argv.includes('--yes');
  const skipCatalog = process.argv.includes('--skip-catalog');

  runSync({ yes, skipCatalog }).catch((err) => {
    console.error('[sync] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runSync };
