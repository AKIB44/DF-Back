require('dotenv').config();
const { pool } = require('../src/db');

/** Tables from migrations/001_init.sql — only existing ones are truncated */
const DENTAFLOW_TABLES = [
  'rx_line_items',
  'prescriptions',
  'rx_service_defaults',
  'rx_procedures',
  'rx_medicines',
  'rx_sequence',
  'refresh_tokens',
  'appointments',
  'patients',
  'services',
  'chairs',
  'users',
  'clinics',
];

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [DENTAFLOW_TABLES]
    );

    if (!rows.length) {
      console.log('No DentaFlow tables found in public schema. Run npm run migrate first.');
      return;
    }

    const list = rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(', ');
    await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    console.log('Truncated:', rows.map((r) => r.tablename).join(', '));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
