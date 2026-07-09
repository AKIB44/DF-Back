// ── God view — unified server-log source ────────────────────────────────────
//
// Under PM2: tail the real PM2 log files (all instances + raw stdout).
// Otherwise (plain `node`, dev): fall back to capturing this process's console.
// Using one or the other avoids duplicating lines (console → stdout → PM2 file).
// ─────────────────────────────────────────────────────────────────────────────

const logcapture = require('./logcapture');
const pm2logs    = require('./pm2logs');

let usePm2 = false;

function install() {
  usePm2 = pm2logs.start();          // true only when running under PM2
  if (!usePm2) logcapture.install();  // dev / non-PM2 → console capture
}

function getLogs(limit = 150) {
  return usePm2 ? pm2logs.getLogs(limit) : logcapture.getLogs(limit);
}

function source() { return usePm2 ? 'pm2' : 'console'; }

module.exports = { install, getLogs, source };
