// ── God view — live monitor (in-memory, no persistence) ─────────────────────
//
// Access is an explicit env allowlist (GODVIEW_EMAILS), not an RBAC permission.
// A non-allowlisted caller gets 404 — the surface stays invisible.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const authenticate = require('../middleware/authenticate');
const { snapshot, clientIp } = require('./presence.service');
const { getLogs, source: logSource } = require('./serverlogs');

const router = express.Router();

const ALLOWED = String(process.env.GODVIEW_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function godGate(req, res, next) {
  const email = String(req.user?.email || '').toLowerCase();
  if (!email || !ALLOWED.includes(email)) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(authenticate, godGate);

// Whether the caller is authorised (used by the UI to decide render vs hide).
// Also hands the allowlisted operator the Google Maps key from the server env
// (GOOGLE_MAPS_API_KEY — a dedicated, HTTP-referrer-restricted key, separate
// from the server-side Places key). Kept out of the frontend bundle; delivered
// only to authorised callers over this gated endpoint.
router.get('/access', (req, res) => res.json({
  ok: true,
  email: req.user.email,
  mapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
}));

// Live snapshot — sessions (with lat/lon) + activity feed + server logs.
router.get('/live', (req, res) => res.json({ ...snapshot(), logs: getLogs(150), logSource: logSource() }));

// Server-Sent Events stream — pushes a fresh snapshot every 3s for real-time UI.
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = () => {
    try { res.write(`data: ${JSON.stringify({ ...snapshot(), logs: getLogs(150) })}\n\n`); } catch { /* client gone */ }
  };
  send();
  const timer = setInterval(send, 3000);
  req.on('close', () => clearInterval(timer));
});

module.exports = router;
