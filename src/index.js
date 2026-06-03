require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const logger    = require('./middleware/logger');
const xss       = require('./middleware/xss');
const { ddosGuard, rateLimitHandler, authRateLimitHandler } = require('./middleware/ddos');
const {
  blockMethodOverride,
  blockPathTraversal,
  flattenQueryParams,
  validateUuidParams,
  enforceJsonContentType,
  requestTimeout,
  perUserLimiter,
} = require('./middleware/security');
const { initDatabase } = require('./db/startup');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// Trust the first proxy hop (nginx, ALB, Cloudflare) so req.ip reflects
// the real client IP from X-Forwarded-For rather than the proxy address.
app.set('trust proxy', 1);

// ── Security headers (Helmet) ─────────────────────────────────────────────────
app.use(helmet({
  // HSTS: browsers remember HTTPS for 1 year, include subdomains, allow preload list
  strictTransportSecurity: {
    maxAge:            31_536_000,
    includeSubDomains: true,
    preload:           true,
  },
  // API-only server: no HTML/scripts served, so lock CSP down completely
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // Don't allow this API to be embedded in frames anywhere
  frameguard: { action: 'deny' },
  // Tell browsers not to sniff content-type
  noSniff: true,
  // Prevent referrer leakage
  referrerPolicy: { policy: 'no-referrer' },
  // Remove X-Powered-By
  hidePoweredBy: true,
}));

// ── CORS — restrict to known frontend origins ─────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow non-browser tools (curl, Postman) in non-production only
    if (!origin) {
      return cb(null, !isProd);
    }
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin '${origin}' is not allowed`));
  },
  methods:          ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders:   ['Content-Type', 'Authorization', 'X-Clinic-Id'],
  exposedHeaders:   ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  credentials:      true,
  maxAge:           600, // preflight cache: 10 minutes
}));

// ── DDoS guard — ban list, burst detector, scan/probe detection ───────────────
// Must come before every route so banned IPs are dropped before any DB work.
app.use(ddosGuard);

// ── XSS input sanitization — strip dangerous constructs from all inputs ───────
app.use(xss);

// ── URL tamper protection ─────────────────────────────────────────────────────
app.use(blockPathTraversal);
app.use(blockMethodOverride);
app.use(flattenQueryParams);

// Validate :id / :*_id params are valid UUIDs before any route handler runs.
app.param('id',             (req, res, next) => validateUuidParams(req, res, next));
app.param('prescriptionId', (req, res, next) => validateUuidParams(req, res, next));
app.param('userId',         (req, res, next) => validateUuidParams(req, res, next));

// ── Body parsing — reject oversized and non-JSON payloads ─────────────────────
app.use(express.json({ limit: '50kb' }));
app.use(enforceJsonContentType);

// ── Request timeout — kill requests that stall beyond 30 s ───────────────────
app.use(requestTimeout);

// ── General API rate limiter — 200 requests per 15 minutes per IP ────────────
const apiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             200,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
});
app.use('/v1', apiLimiter);

// ── Auth rate limiter — 10 attempts per 15 minutes per IP ────────────────────
// authRateLimitHandler counts double strikes so auth brute-force bans faster.
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            () => process.env.NODE_ENV === 'test',
  handler:         authRateLimitHandler,
});
app.use('/v1/auth/login',         authLimiter);
app.use('/v1/auth/otp/request',   authLimiter);
app.use('/v1/auth/otp/verify',    authLimiter);
app.use('/v1/auth/mfa/challenge', authLimiter);

// ── Prescription action limiter — 20 generates/sends per hour per IP ─────────
const rxActionLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         rateLimitHandler,
});
app.use('/v1/rx/prescriptions', rxActionLimiter);

// ── Per-user limiter on all authenticated API routes ─────────────────────────
// Applied after auth middleware so req.user is populated by the time it fires.
// Mounted here so it wraps every /v1 route; authenticate sets req.user upstream.
app.use('/v1', perUserLimiter);

app.use(logger);

// ── Auth ──────────────────────────────────────────────────────────────────────
app.use('/v1/auth', require('./auth/auth.routes'));

// ── Domain routes ─────────────────────────────────────────────────────────────
app.use('/v1/clinic',        require('./routes/clinic'));
app.use('/v1/clinics',       require('./routes/clinics'));
app.use('/v1/chairs',        require('./routes/chairs'));
app.use('/v1/services',      require('./routes/services'));
app.use('/v1/staff',         require('./routes/staff'));
app.use('/v1/patients',      require('./routes/patients'));
app.use('/v1/appointments',  require('./routes/appointments'));
app.use('/v1/rx',            require('./routes/rx'));
app.use('/v1/rbac',          require('./routes/rbac'));
app.use('/v1/activity-log',  require('./routes/activity-log'));
app.use('/v1/org/hr',        require('./routes/org-hr'));
app.use('/v1/org/accounts',  require('./routes/org-accounts'));
app.use('/v1/org/roles',     require('./routes/org-roles'));
app.use('/v1/release-notes', require('./routes/release-notes'));
app.use('/v1',               require('./routes/inventory'));
app.use('/v1',               require('./routes/clinical-session'));
app.use('/v1/specialty',                    require('./routes/specialty'));
app.use('/v1/specialty/orthodontic',        require('./routes/ortho'));
app.use('/v1/specialty/implantology',       require('./routes/implant'));
app.use('/v1/specialty/paediatric',         require('./routes/paedo'));
app.use('/v1/specialty/endodontic',         require('./routes/endo'));
app.use('/v1/specialty/tmj',               require('./routes/tmj'));
app.use('/v1/assistant',                   require('./routes/assistant'));
app.use('/v1/feature-flags',               require('./routes/feature-flags'));

// ── Health check (unauthenticated, no sensitive data) ────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Global error handler — never leak internals in production ────────────────
app.use((err, req, res, next) => {
  // CORS errors become 403
  if (err.message?.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }

  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.originalUrl} ${status}`);
    console.error(err.stack);
  }

  // Never expose stack traces or internal error messages in production
  const message = (isProd && status >= 500)
    ? 'Internal server error'
    : (err.message || 'Internal server error');

  res.status(status).json({ error: message });
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
