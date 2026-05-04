require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function isAlreadyApplied(client, file) {
  if (file === '001_init.sql') {
    return tableExists(client, 'clinics');
  }
  if (file === '002_add_intake_data.sql') {
    return columnExists(client, 'appointments', 'intake_data');
  }
  if (file === '003_rx_tables.sql') {
    return tableExists(client, 'prescriptions');
  }
  return false;
}

async function main() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of migrationFiles) {
      if (await isAlreadyApplied(client, file)) {
        console.log('Migration skipped:', file);
        continue;
      }

      const sqlPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await client.query(sql);
      console.log('Migration applied:', sqlPath);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
