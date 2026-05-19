const { pool, getConfigSummary } = require('../db');
const { runMigrations, listMigrationFiles } = require('./migrate');

const PREFIX = '[database]';

function log(msg) {
  console.log(`${PREFIX} ${msg}`);
}

async function testConnection() {
  const { rows } = await pool.query(
    `SELECT current_database() AS database,
            current_user AS user,
            version() AS version`
  );
  return rows[0];
}

/**
 * Verify DB config, test connection, run pending migrations.
 * @returns {Promise<void>}
 */
async function initDatabase() {
  let summary;
  try {
    summary = getConfigSummary();
  } catch (err) {
    console.error(`${PREFIX} Configuration error: ${err.message}`);
    throw err;
  }

  const parts = [
    `host=${summary.host}`,
    `port=${summary.port}`,
    `database=${summary.database}`,
    `user=${summary.user}`,
  ];
  if (summary.ssl) parts.push('ssl=true');
  log(`Config: ${parts.join(', ')}`);

  try {
    const conn = await testConnection();
    const pgVersion = conn.version.split(' ')[1] || conn.version;
    log(`Connected (PostgreSQL ${pgVersion}, db="${conn.database}", user="${conn.user}")`);
  } catch (err) {
    console.error(`${PREFIX} Connection failed: ${err.message}`);
    throw err;
  }

  const { migrationFiles } = listMigrationFiles();
  if (migrationFiles.length === 0) {
    log('No migrations directory or SQL files — schema sync skipped');
    return;
  }

  log(`Syncing ${migrationFiles.length} migration(s)...`);
  const migrationLog = (msg) => log(msg);

  try {
    const { applied, skipped, total } = await runMigrations({ log: migrationLog });
    log(
      `Schema sync complete: ${applied.length} applied, ${skipped.length} up to date (${total} total)`
    );
  } catch (err) {
    console.error(`${PREFIX} ${err.message}`);
    throw err;
  }
}

module.exports = { initDatabase, testConnection };
