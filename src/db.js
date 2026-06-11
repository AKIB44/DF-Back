const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');

const queryLogStore = new AsyncLocalStorage();
const LOG_DB = process.env.LOG_DB === 'true';
const DB_LOG_SQL_MAX = Number(process.env.DB_LOG_SQL_MAX || 200);

// Return TIMESTAMPTZ (OID 1184) and TIMESTAMP (OID 1114) as raw strings so that
// JSON serialization preserves the IST offset instead of converting to UTC.
// With session timezone = Asia/Kolkata, pg returns "2026-05-08 09:45:00+05:30".
types.setTypeParser(1184, val => val);
types.setTypeParser(1114, val => val);

function buildPoolConfig(connectionStringOverride) {
  const raw = connectionStringOverride ?? process.env.DATABASE_URL ?? '';
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

const SESSION_TIMEZONE = 'Asia/Kolkata';

function withSessionTimezone(config) {
  if (config.connectionString) {
    const u = new URL(config.connectionString);
    if (!u.searchParams.has('options')) {
      u.searchParams.set('options', `-c timezone=${SESSION_TIMEZONE}`);
    }
    return { ...config, connectionString: u.toString() };
  }
  return { ...config, options: `-c timezone=${SESSION_TIMEZONE}` };
}

function createPool(connectionStringOverride) {
  return new Pool(withSessionTimezone(buildPoolConfig(connectionStringOverride)));
}

const pool = createPool();

function getConfigSummary() {
  const config = buildPoolConfig();
  if (config.connectionString) {
    try {
      const u = new URL(config.connectionString);
      return {
        host: u.hostname,
        port: Number(u.port || 5432),
        database: u.pathname.replace(/^\//, '') || '(default)',
        user: u.username || '(default)',
        ssl: !!config.ssl,
      };
    } catch {
      return { host: '(uri)', port: 5432, database: '(configured)', user: '(configured)', ssl: false };
    }
  }
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ssl: !!config.ssl,
  };
}

function summarizeSql(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > DB_LOG_SQL_MAX ? `${oneLine.slice(0, DB_LOG_SQL_MAX)}…` : oneLine;
}

async function query(text, params) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    if (LOG_DB) {
      const log = queryLogStore.getStore();
      if (log) {
        log.push({
          ms: Date.now() - started,
          rows: result.rowCount,
          sql: summarizeSql(text),
        });
      }
    }
    return result;
  } catch (err) {
    if (LOG_DB) {
      const log = queryLogStore.getStore();
      if (log) {
        log.push({
          ms: Date.now() - started,
          error: err.message,
          code: err.code,
          sql: summarizeSql(text),
        });
      }
    }
    throw err;
  }
}

function runWithQueryLog(store, fn) {
  if (!LOG_DB || !store) return fn();
  return queryLogStore.run(store, fn);
}

module.exports = {
  query,
  pool,
  createPool,
  getConfigSummary,
  runWithQueryLog,
};
