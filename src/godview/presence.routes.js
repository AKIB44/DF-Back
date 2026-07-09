// ── Presence — user self-reports precise browser geolocation ────────────────
//
// Any authenticated user may post their own GPS/WiFi coordinates (captured via
// navigator.geolocation in the browser). Stored in-memory only; surfaced to the
// god view, where it overrides the coarse IP-based location.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const authenticate = require('../middleware/authenticate');
const { recordPrecise } = require('./presence.service');

const router = express.Router();
router.use(authenticate);

router.post('/location', (req, res) => {
  const { lat, lng, accuracy } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number'
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat/lng required' });
  }
  recordPrecise(req.user.sub, lat, lng, typeof accuracy === 'number' ? accuracy : null);
  res.json({ ok: true });
});

module.exports = router;
