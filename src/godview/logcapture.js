// ── God view — in-memory capture of backend console output ──────────────────
//
// Tees console.log/info/warn/error into a rolling buffer so the god-view UI can
// show the live server log. The original console behaviour is untouched (real
// stdout/stderr still fire). Nothing is persisted; the buffer is process-local.
// ─────────────────────────────────────────────────────────────────────────────

const MAX = 400;
const buffer = [];
let seq = 0;
let installed = false;

// Skip self-referential noise: the god-view's own 3s polling + health probes
// would otherwise flood the panel. Also drop pure separator/blank lines.
const NOISE_RX = /\/v1\/godview\b|\/v1\/health\b|\/health\b|favicon\.ico/;
const SEPARATOR_RX = /^[\s─―—=_.-]*$/;

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function fmt(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function install() {
  if (installed) return;
  installed = true;
  for (const lvl of ['log', 'info', 'warn', 'error']) {
    const original = console[lvl].bind(console);
    console[lvl] = (...args) => {
      try {
        const msg = stripAnsi(args.map(fmt).join(' ')).trimEnd();
        if (msg && !SEPARATOR_RX.test(msg) && !NOISE_RX.test(msg)) {
          buffer.push({ id: ++seq, at: Date.now(), level: lvl === 'log' ? 'info' : lvl, msg });
          if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
        }
      } catch { /* never let logging break logging */ }
      original(...args);
    };
  }
}

/** Newest-first slice for the UI. */
function getLogs(limit = 150) {
  return buffer.slice(-limit).reverse();
}

module.exports = { install, getLogs };
