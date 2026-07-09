// ── God view — tail the live PM2 log files ──────────────────────────────────
//
// When the app runs under PM2, PM2 pipes stdout/stderr to files and exposes the
// paths via env vars (pm_out_log_path / pm_err_log_path). We tail those files so
// the god view shows the REAL server log — every request, every instance, and
// anything written straight to stdout — not just this process's console.* calls.
//
// Only NEW lines (from the current end of file onward) are streamed, so we never
// load the whole history. Falls back cleanly (available() === false) when not
// running under PM2 — the caller then uses the in-process console capture.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');

const MAX = 600;
const POLL_MS = 1500;

const buffer = [];
let seq = 0;
let started = false;

const OUT = process.env.pm_out_log_path || process.env.PM2_OUT_LOG || '';
const ERR = process.env.pm_err_log_path || process.env.PM2_ERR_LOG || '';
const offsets = new Map(); // path → byte offset already read

// Same self-noise filter used by the console capture.
const NOISE_RX = /\/v1\/godview\b|\/v1\/health\b|\/health\b|favicon\.ico/;
const SEPARATOR_RX = /^[\s─―—=_.-]*$/;

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function push(level, raw) {
  const msg = stripAnsi(raw).trimEnd();
  if (!msg || SEPARATOR_RX.test(msg) || NOISE_RX.test(msg)) return;
  // Upgrade level when the line itself signals an error/warning.
  const lvl = /\b(error|err|exception|fail)\b/i.test(msg) ? 'error'
            : /\bwarn\b/i.test(msg) ? 'warn' : level;
  buffer.push({ id: ++seq, at: Date.now(), level: lvl, msg });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

function tail(path, level) {
  if (!path) return;
  fs.stat(path, (err, st) => {
    if (err) return;
    let from = offsets.get(path);
    if (from === undefined) from = st.size;   // first pass: start at EOF (skip old history)
    if (st.size < from) from = 0;             // file rotated/truncated → re-read from start
    if (st.size <= from) { offsets.set(path, st.size); return; }

    const stream = fs.createReadStream(path, { start: from, end: st.size - 1, encoding: 'utf8' });
    let data = '';
    stream.on('data', (d) => { data += d; });
    stream.on('end', () => {
      offsets.set(path, st.size);
      for (const line of data.split(/\r?\n/)) if (line) push(level, line);
    });
    stream.on('error', () => {});
  });
}

/** True when running under PM2 (log file paths are known). */
function available() {
  return !!(OUT || ERR);
}

function start() {
  if (started || !available()) return available();
  started = true;
  // Seed offsets at current EOF so we only stream new lines.
  for (const p of [OUT, ERR]) {
    if (!p) continue;
    try { offsets.set(p, fs.statSync(p).size); } catch { /* file not there yet */ }
  }
  setInterval(() => { tail(OUT, 'info'); tail(ERR, 'error'); }, POLL_MS).unref?.();
  return true;
}

function getLogs(limit = 150) {
  return buffer.slice(-limit).reverse();
}

module.exports = { available, start, getLogs };
