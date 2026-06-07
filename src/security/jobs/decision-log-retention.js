// ────────────────────────────────────────────────────────────────────────────
// 90-day retention for access_decision_log (postgres-only).
// ────────────────────────────────────────────────────────────────────────────
//   require('./security/jobs/decision-log-retention').start();
// Runs at boot, then every 24h. Deletes rows older than 90 days.
// ────────────────────────────────────────────────────────────────────────────

const db = require('../../db');

const RETENTION_DAYS = Number(process.env.ABAC_DECISION_LOG_RETENTION_DAYS || 90);
const TICK_MS        = 24 * 60 * 60 * 1000;

let timer = null;

async function prune() {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM access_decision_log
         WHERE decided_at < NOW() - ($1 || ' days')::interval`,
      [RETENTION_DAYS]
    );
    if (rowCount) console.log(`[abac] pruned ${rowCount} access_decision_log rows older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.warn('[abac] decision-log prune failed:', err.message);
  }
}

function start() {
  if (timer) return;
  // Initial run after 30s so we don't slam the DB on boot.
  setTimeout(prune, 30_000).unref?.();
  timer = setInterval(prune, TICK_MS);
  timer.unref?.();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, _prune: prune };
