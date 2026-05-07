const { Pool, types } = require('pg');

// Return TIMESTAMPTZ (OID 1184) and TIMESTAMP (OID 1114) as raw strings so that
// JSON serialization preserves the IST offset instead of converting to UTC.
// With session timezone = Asia/Kolkata, pg returns "2026-05-08 09:45:00+05:30".
types.setTypeParser(1184, val => val);
types.setTypeParser(1114, val => val);

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

// Set session timezone to IST for every new connection so all TIMESTAMPTZ
// values are returned with +05:30 offset.
pool.on('connect', client => {
  client.query("SET timezone = 'Asia/Kolkata'").catch(() => {});
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
