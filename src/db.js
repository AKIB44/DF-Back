const { Pool } = require('pg');

function buildPoolConfig() {
  const raw = process.env.DATABASE_URL || '';
  // Full URI — must include postgresql:// or relative resolution uses host "base" (pg-connection-string quirk)
  if (/^postgres(ql)?:\/\//i.test(raw)) {
    return { connectionString: raw };
  }

  const host = raw || process.env.DB_HOST;
  if (!host) {
    throw new Error(
      'Database not configured: set DATABASE_URL to a postgresql://... URI, or set DB_HOST (or host-only DATABASE_URL) with DB_USER and DB_NAME'
    );
  }

  const config = {
    host,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
  if (!config.user || !config.database) {
    throw new Error('When not using a full postgresql:// DATABASE_URL, DB_USER and DB_NAME are required');
  }
  applySslFromEnv(config);
  return config;
}

function applySslFromEnv(config) {
  if (process.env.DB_SSL !== 'true') return;
  if (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
    config.ssl = { rejectUnauthorized: false };
  } else {
    config.ssl = true;
  }
}

const pool = new Pool(buildPoolConfig());

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
