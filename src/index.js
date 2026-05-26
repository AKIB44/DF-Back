require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const logger    = require('./middleware/logger');
const { blockMethodOverride, blockPathTraversal, flattenQueryParams, validateUuidParams } = require('./middleware/security');
const { initDatabase } = require('./db/startup');

const app = express();
// Trust the first proxy hop (nginx, ALB, Cloudflare) so req.ip reflects
// the real client IP from X-Forwarded-For rather than the proxy address.
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── URL tamper protection ─────────────────────────────────────────────────────
app.use(blockPathTraversal);
app.use(blockMethodOverride);
app.use(flattenQueryParams);
// Validate :id / :*_id params are valid UUIDs before any route handler runs.
app.param('id', (req, res, next, val) => validateUuidParams(req, res, next));
app.param('prescriptionId', (req, res, next, val) => validateUuidParams(req, res, next));
app.param('userId', (req, res, next, val) => validateUuidParams(req, res, next));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors());

// ── Body limit — reject oversized payloads before any route logic ─────────────
app.use(express.json({ limit: '50kb' }));

// ── General API rate limiter — 100 requests per 15 minutes per IP ─────────────
const apiLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              100,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests. Please try again later.' },
});
app.use('/v1', apiLimiter);

// ── Auth rate limiter — 10 attempts per 15 minutes per IP ────────────────────
// Applies to login, OTP, and MFA endpoints to prevent brute-force attacks.
const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many login attempts. Please try again in 15 minutes.' },
});
app.use('/v1/auth/login',         authLimiter);
app.use('/v1/auth/otp/request',   authLimiter);
app.use('/v1/auth/otp/verify',    authLimiter);
app.use('/v1/auth/mfa/challenge', authLimiter);

// ── Prescription action limiter — 20 generates/sends per hour per IP ─────────
// PDFKit is CPU/memory intensive; WhatsApp sends cost money per call.
const rxActionLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Prescription action limit reached. Try again in an hour.' },
});
app.use('/v1/rx/prescriptions', rxActionLimiter);

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
app.use('/v1/release-notes', require('./routes/release-notes'));

app.get('/health', (_, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[UNHANDLED ERROR] ${req.method} ${req.originalUrl}`);
    console.error(err.stack);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`DentaFlow backend running on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
