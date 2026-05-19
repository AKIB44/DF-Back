require('dotenv').config();
const { pool } = require('../src/db');
const { runMigrations } = require('../src/db/migrate');

runMigrations({ log: (msg) => console.log(msg) })
  .then(({ applied, skipped }) => {
    console.log(`Done: ${applied.length} applied, ${skipped.length} skipped`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
