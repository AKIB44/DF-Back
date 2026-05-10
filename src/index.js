require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const logger  = require('./middleware/logger');

const app = express();
// Trust the first proxy hop (nginx, ALB, Cloudflare) so req.ip reflects
// the real client IP from X-Forwarded-For rather than the proxy address.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(logger);

// ── Auth (new RBAC-aware routes replace legacy /v1/auth) ──────────────────────
app.use('/v1/auth', require('./auth/auth.routes'));

// ── Domain routes ─────────────────────────────────────────────────────────────
app.use('/v1/clinic',       require('./routes/clinic'));
app.use('/v1/clinics',      require('./routes/clinics'));
app.use('/v1/chairs',       require('./routes/chairs'));
app.use('/v1/services',     require('./routes/services'));
app.use('/v1/staff',        require('./routes/staff'));
app.use('/v1/patients',     require('./routes/patients'));
app.use('/v1/appointments', require('./routes/appointments'));
app.use('/v1/rx',           require('./routes/rx'));
app.use('/v1/rbac',         require('./routes/rbac'));
app.use('/v1/activity-log', require('./routes/activity-log'));
app.use('/v1/org/hr',       require('./routes/org-hr'));
app.use('/v1/org/accounts', require('./routes/org-accounts'));
app.use('/v1/org/roles',    require('./routes/org-roles'));

app.get('/health', (_, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[UNHANDLED ERROR] ${req.method} ${req.originalUrl}`);
    console.error(err.stack);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`DentaFlow backend running on :${process.env.PORT || 3000}`)
);
