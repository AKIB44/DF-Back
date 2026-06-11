const crypto = require('crypto');
const activityService = require('../activity/activity.service');
const { runWithQueryLog } = require('../db');

// LOG_LEVEL: silent | error (5xx) | warn (4xx+) | info (one-line all) | debug (full dump)
const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const SLOW_MS = Number(process.env.LOG_SLOW_MS || 3000);
const RESPONSE_PREVIEW_MAX = Number(process.env.LOG_RESPONSE_PREVIEW_MAX || 500);
const LEVEL_RANK = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const logRank = () => LEVEL_RANK[LOG_LEVEL] ?? LEVEL_RANK.info;

// Probe paths — bots/scanners; never dump headers unless LOG_LEVEL=debug
const QUIET_PATHS = [
  /^\/health$/i,
  /^\/v1\/version$/i,
  /^\/favicon\.ico$/i,
  /^\/robots\.txt$/i,
];

const SENSITIVE_KEYS = ['password', 'password_hash', 'token', 'refresh_token', 'secret'];

// Headers that carry credentials or add no diagnostic value
const HEADER_BLOCKLIST = new Set([
  'authorization', 'cookie', 'set-cookie',
  'x-api-key', 'proxy-authorization',
]);

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HEADER_BLOCKLIST.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// Returns the real client IP, normalising IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4)
// and preferring the leftmost (original client) entry in X-Forwarded-For.
function extractIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded
    ? forwarded.split(',')[0].trim()
    : (req.headers['x-real-ip'] || req.ip || '');
  return raw.replace(/^::ffff:/, '') || null;
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = JSON.parse(JSON.stringify(body));
  for (const key of SENSITIVE_KEYS) delete clone[key];
  return clone;
}

function formatRequestUser(user) {
  if (!user?.sub && !user?.display_name && !user?.email) return '—';
  const name = user.display_name
    || [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const parts = [];
  if (name) parts.push(name);
  if (user.email) parts.push(`<${user.email}>`);
  if (user.sub) parts.push(`id=${user.sub}`);
  return parts.join(' ') || String(user.sub);
}

// Most-specific patterns first
function resolveAction(method, path) {
  const p   = path.replace(/^\/v1\//, '');
  const seg = p.split('/');

  if (method === 'POST' && seg[0] === 'rx' && seg[1] === 'prescriptions' && seg[2] && seg[3] === 'generate')
    return { action: 'Generated prescription PDF', entityType: 'prescription', entityId: seg[2] };
  if (method === 'POST' && seg[0] === 'rx' && seg[1] === 'prescriptions' && seg[2] && seg[3] === 'send')
    return { action: 'Sent prescription on WhatsApp', entityType: 'prescription', entityId: seg[2] };
  if (seg[0] === 'rx' && seg[1] === 'prescriptions' && seg[2]) {
    if (method === 'PUT')    return { action: 'Updated prescription', entityType: 'prescription', entityId: seg[2] };
    if (method === 'DELETE') return { action: 'Deleted prescription', entityType: 'prescription', entityId: seg[2] };
  }
  if (method === 'POST' && seg[0] === 'rx' && seg[1] === 'prescriptions')
    return { action: 'Created prescription', entityType: 'prescription', entityId: null };

  if (seg[0] === 'rx' && seg[1] === 'master' && seg[2] === 'medicines' && seg[3]) {
    if (method === 'PATCH')  return { action: 'Updated medicine',  entityType: 'rx_medicine', entityId: seg[3] };
    if (method === 'DELETE') return { action: 'Deleted medicine',  entityType: 'rx_medicine', entityId: seg[3] };
  }
  if (method === 'POST' && seg[0] === 'rx' && seg[1] === 'master' && seg[2] === 'medicines')
    return { action: 'Added medicine', entityType: 'rx_medicine', entityId: null };

  if (seg[0] === 'rx' && seg[1] === 'master' && seg[2] === 'procedures' && seg[3]) {
    if (method === 'PATCH')  return { action: 'Updated procedure', entityType: 'rx_procedure', entityId: seg[3] };
    if (method === 'DELETE') return { action: 'Deleted procedure', entityType: 'rx_procedure', entityId: seg[3] };
  }
  if (method === 'POST' && seg[0] === 'rx' && seg[1] === 'master' && seg[2] === 'procedures')
    return { action: 'Added procedure', entityType: 'rx_procedure', entityId: null };

  if (method === 'PUT' && seg[0] === 'rbac' && seg[1] === 'users' && seg[2] && seg[3] === 'role')
    return { action: 'Assigned role to user', entityType: 'user', entityId: seg[2] };
  if (method === 'DELETE' && seg[0] === 'rbac' && seg[1] === 'users' && seg[2] && seg[3] === 'overrides' && seg[4])
    return { action: 'Removed permission override', entityType: 'user', entityId: seg[2] };
  if (method === 'POST' && seg[0] === 'rbac' && seg[1] === 'users' && seg[2] && seg[3] === 'overrides')
    return { action: 'Set permission override', entityType: 'user', entityId: seg[2] };

  if (seg[0] === 'patients' && seg[1]) {
    if (method === 'PUT' || method === 'PATCH') return { action: 'Updated patient', entityType: 'patient', entityId: seg[1] };
    if (method === 'DELETE')                    return { action: 'Deleted patient', entityType: 'patient', entityId: seg[1] };
  }
  if (method === 'POST' && seg[0] === 'patients')
    return { action: 'Created patient', entityType: 'patient', entityId: null };

  if (seg[0] === 'appointments' && seg[1]) {
    if (method === 'PUT' || method === 'PATCH') return { action: 'Updated appointment', entityType: 'appointment', entityId: seg[1] };
    if (method === 'DELETE')                    return { action: 'Cancelled appointment', entityType: 'appointment', entityId: seg[1] };
  }
  if (method === 'POST' && seg[0] === 'appointments')
    return { action: 'Created appointment', entityType: 'appointment', entityId: null };

  if (seg[0] === 'staff' && seg[1]) {
    if (method === 'PUT' || method === 'PATCH') return { action: 'Updated staff user', entityType: 'staff', entityId: seg[1] };
    if (method === 'DELETE')                    return { action: 'Deleted staff user', entityType: 'staff', entityId: seg[1] };
  }
  if (method === 'POST' && seg[0] === 'staff')
    return { action: 'Created staff user', entityType: 'staff', entityId: null };

  if (seg[0] === 'services' && seg[1]) {
    if (method === 'PUT' || method === 'PATCH') return { action: 'Updated service', entityType: 'service', entityId: seg[1] };
    if (method === 'DELETE')                    return { action: 'Deleted service', entityType: 'service', entityId: seg[1] };
  }
  if (method === 'POST' && seg[0] === 'services')
    return { action: 'Created service', entityType: 'service', entityId: null };

  if (seg[0] === 'chairs' && seg[1]) {
    if (method === 'PUT' || method === 'PATCH') return { action: 'Updated chair/room', entityType: 'chair', entityId: seg[1] };
    if (method === 'DELETE')                    return { action: 'Deleted chair/room', entityType: 'chair', entityId: seg[1] };
  }
  if (method === 'POST' && seg[0] === 'chairs')
    return { action: 'Created chair/room', entityType: 'chair', entityId: null };

  if (seg[0] === 'clinic' && (method === 'PUT' || method === 'PATCH'))
    return { action: 'Updated clinic profile', entityType: 'clinic', entityId: null };

  if (seg[0] === 'auth' && seg[1] === 'login'  && method === 'POST') return { action: 'User login',  entityType: 'auth', entityId: null };
  if (seg[0] === 'auth' && seg[1] === 'logout' && method === 'POST') return { action: 'User logout', entityType: 'auth', entityId: null };

  return { action: null, entityType: null, entityId: null };
}

function buildDetail(method, path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const p   = path.replace(/^\/v1\//, '');
  const seg = p.split('/');
  const parts = [];

  if (seg[0] === 'rx' && seg[1] === 'prescriptions' && method !== 'DELETE') {
    if (body.diagnosis)      parts.push(`Diagnosis: ${body.diagnosis}`);
    if (body.clinical_notes) parts.push(`Notes: ${String(body.clinical_notes).slice(0, 100)}${body.clinical_notes.length > 100 ? '…' : ''}`);
    if (Array.isArray(body.items) && body.items.length) {
      const meds  = body.items.filter(i => i.item_type === 'medicine').length;
      const procs = body.items.filter(i => i.item_type === 'procedure').length;
      parts.push(`${body.items.length} item${body.items.length !== 1 ? 's' : ''} (${meds} medicine${meds !== 1 ? 's' : ''}, ${procs} procedure${procs !== 1 ? 's' : ''})`);
    }
  }

  if (seg[0] === 'staff') {
    const name = [body.first_name, body.last_name].filter(Boolean).join(' ');
    if (name)                         parts.push(`Name: ${name}`);
    if (body.email)                   parts.push(`Email: ${body.email}`);
    if (body.role)                    parts.push(`Role: ${body.role}`);
    if (body.designation)             parts.push(`Designation: ${body.designation}`);
    if (body.is_active !== undefined) parts.push(`Active: ${body.is_active}`);
  }

  if (seg[0] === 'patients') {
    if (body.name)   parts.push(`Name: ${body.name}`);
    if (body.phone)  parts.push(`Phone: ${body.phone}`);
    if (body.email)  parts.push(`Email: ${body.email}`);
    if (body.dob)    parts.push(`DOB: ${body.dob}`);
    if (body.gender) parts.push(`Gender: ${body.gender}`);
    if (body.address) parts.push(`Address: ${String(body.address).slice(0, 80)}`);
  }

  if (seg[0] === 'appointments') {
    if (body.service_id)    parts.push(`Service: ${body.service_id}`);
    if (body.chair_id)      parts.push(`Chair: ${body.chair_id}`);
    if (body.scheduled_at)  parts.push(`Scheduled: ${new Date(body.scheduled_at).toLocaleString()}`);
    if (body.booking_source) parts.push(`Source: ${body.booking_source}`);
    if (body.status)        parts.push(`Status: ${body.status}`);
    if (body.notes)         parts.push(`Notes: ${String(body.notes).slice(0, 80)}`);
    if (body.patient?.name) parts.push(`Patient: ${body.patient.name}`);
  }

  if (seg[0] === 'rbac' && seg[3] === 'role') {
    if (body.roleCode) parts.push(`New role: ${body.roleCode}`);
    if (body.roleId)   parts.push(`Role ID: ${body.roleId}`);
  }

  if (seg[0] === 'rbac' && seg[3] === 'overrides') {
    if (body.permissionCode) parts.push(`Permission: ${body.permissionCode}`);
    if (body.effect)         parts.push(`Effect: ${body.effect}`);
    if (body.reason)         parts.push(`Reason: ${body.reason}`);
  }

  if (seg[0] === 'services') {
    if (body.name)                    parts.push(`Name: ${body.name}`);
    if (body.duration_minutes)        parts.push(`Duration: ${body.duration_minutes}min`);
    if (body.price !== undefined)     parts.push(`Price: ${body.price}`);
    if (body.description)             parts.push(`Description: ${String(body.description).slice(0, 80)}`);
    if (body.is_active !== undefined) parts.push(`Active: ${body.is_active}`);
  }

  if (seg[0] === 'chairs') {
    if (body.name)                    parts.push(`Name: ${body.name}`);
    if (body.is_active !== undefined) parts.push(`Active: ${body.is_active}`);
  }

  if (seg[0] === 'rx' && seg[1] === 'master' && seg[2] === 'medicines') {
    if (body.generic_name) parts.push(`Medicine: ${body.generic_name}`);
    if (body.brand_name)   parts.push(`Brand: ${body.brand_name}`);
    if (body.category)     parts.push(`Category: ${body.category}`);
    if (body.dosage_form)  parts.push(`Form: ${body.dosage_form}`);
    if (body.strength)     parts.push(`Strength: ${body.strength}`);
  }

  if (seg[0] === 'rx' && seg[1] === 'master' && seg[2] === 'procedures') {
    if (body.procedure_name) parts.push(`Procedure: ${body.procedure_name}`);
    if (body.procedure_code) parts.push(`Code: ${body.procedure_code}`);
    if (body.svc_id)         parts.push(`Service: ${body.svc_id}`);
    if (body.procedure_step) parts.push(`Step: ${body.procedure_step}`);
  }

  if (seg[0] === 'clinic') {
    if (body.name)    parts.push(`Name: ${body.name}`);
    if (body.phone)   parts.push(`Phone: ${body.phone}`);
    if (body.email)   parts.push(`Email: ${body.email}`);
    if (body.address) parts.push(`Address: ${body.address}`);
    if (body.city)    parts.push(`City: ${body.city}`);
    if (body.state)   parts.push(`State: ${body.state}`);
  }

  return parts.length ? parts.join('  ·  ') : null;
}

function isQuietPath(path) {
  return QUIET_PATHS.some((re) => re.test(path));
}

function shouldLog(status) {
  const rank = logRank();
  if (rank === 0) return false;
  if (status >= 500) return rank >= 1;
  if (status >= 400) return rank >= 2;
  return rank >= 3;
}

function clinicLabel(user) {
  return user?.clinic_id || user?.active_clinic_id || null;
}

function formatRoute(req) {
  if (!req.route) return '— (no route match)';
  return req.baseUrl ? `${req.baseUrl}${req.route.path}` : req.route.path;
}

function authHeaderSummary(req) {
  const h = req.headers.authorization;
  if (!h) return 'missing';
  if (h.startsWith('Bearer ')) return `Bearer (${h.length - 7} chars)`;
  return `${h.split(' ')[0] || 'present'} (non-bearer)`;
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

function previewJson(value, max = RESPONSE_PREVIEW_MAX) {
  if (value == null) return null;
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  } catch {
    return '[unserializable]';
  }
}

function formatPgError(err) {
  if (!err || !err.code) return null;
  const lines = [];
  if (err.code) lines.push(`code=${err.code}`);
  if (err.detail) lines.push(`detail=${err.detail}`);
  if (err.hint) lines.push(`hint=${err.hint}`);
  if (err.table) lines.push(`table=${err.table}`);
  if (err.constraint) lines.push(`constraint=${err.constraint}`);
  if (err.column) lines.push(`column=${err.column}`);
  return lines.length ? lines.join(' | ') : null;
}

function pickRateLimitHeaders(res) {
  const names = [
    'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
    'retry-after',
  ];
  const out = {};
  for (const n of names) {
    const v = res.getHeader(n);
    if (v != null) out[n] = v;
  }
  return Object.keys(out).length ? out : null;
}

function buildExtraDiagnostics(req, res, { status, ms, responseBody, capturedPath }) {
  const lines = [];
  const { action, entityType, entityId } = resolveAction(req.method, capturedPath);

  if (req.id) lines.push(['Request-Id', req.id]);
  lines.push(['Route', formatRoute(req)]);

  if (req.params && Object.keys(req.params).length) {
    lines.push(['Params', JSON.stringify(req.params)]);
  }

  const u = req.user;
  if (u) {
    if (u.role) lines.push(['Role', u.role]);
    if (u.type) lines.push(['Actor', u.type]);
    if (u.is_org_admin) lines.push(['Org-admin', 'true']);
    if (u.rv != null) lines.push(['Token-rv', String(u.rv)]);
    if (u.org_id) lines.push(['Org', u.org_id]);
  }

  if (req.context) {
    lines.push(['Context', JSON.stringify(req.context)]);
  }

  const xClinic = req.headers['x-clinic-id'];
  if (xClinic) lines.push(['X-Clinic-Id', xClinic]);

  const idem = req.headers['idempotency-key'];
  if (idem) lines.push(['Idempotency', idem]);

  lines.push(['Auth', authHeaderSummary(req)]);

  if (req.headers.origin) lines.push(['Origin', req.headers.origin]);
  if (req.headers.referer) lines.push(['Referer', req.headers.referer]);
  if (req.headers['content-type']) lines.push(['Content-Type', req.headers['content-type']]);
  if (req.headers['content-length']) lines.push(['Content-Length', req.headers['content-length']]);

  if (action) lines.push(['Action', action]);
  if (entityType) lines.push(['Entity', `${entityType}${entityId ? ` / ${entityId}` : ''}`]);

  if (req.resource) {
    lines.push(['Resource', JSON.stringify({
      type: req.resource.type,
      id: req.resource.id,
      clinic_id: req.resource.clinic_id,
      status: req.resource.status,
    })]);
  }

  if (req._abacSubject) {
    lines.push(['ABAC-subject', JSON.stringify({
      role: req._abacSubject.role,
      hierarchyLevel: req._abacSubject.hierarchyLevel,
      specialtyTags: req._abacSubject.specialtyTags,
      branchId: req._abacSubject.branchId,
    })]);
  }

  if (req.abacDecision) {
    lines.push(['ABAC-decision', JSON.stringify({
      decision: req.abacDecision.decision,
      policy: req.abacDecision.policy,
      reason: req.abacDecision.reason,
    })]);
  }

  const respSize = responseBody != null ? Buffer.byteLength(previewJson(responseBody, Infinity) || '', 'utf8') : null;
  lines.push(['Response-size', formatBytes(respSize)]);

  const rateLimit = pickRateLimitHeaders(res);
  if (rateLimit) lines.push(['Rate-limit', JSON.stringify(rateLimit)]);

  const tenantStatus = res.getHeader('x-tenant-status');
  if (tenantStatus) lines.push(['Tenant-status', String(tenantStatus)]);

  const abacWarn = res.getHeader('x-abac-warning');
  if (abacWarn) lines.push(['ABAC-warning', String(abacWarn)]);

  if (ms >= SLOW_MS) lines.push(['Slow', `yes (>${SLOW_MS}ms)`]);

  if (status >= 400 && responseBody) {
    const preview = previewJson(responseBody);
    if (preview) lines.push(['Response', preview]);
  }

  const err = res.locals?.__err;
  if (err) {
    if (err.message) lines.push(['Exception', err.message]);
    const pg = formatPgError(err);
    if (pg) lines.push(['PostgreSQL', pg]);
  }

  if (req._dbLog?.length) {
    const totalDbMs = req._dbLog.reduce((n, q) => n + (q.ms || 0), 0);
    lines.push(['DB-queries', `${req._dbLog.length} (${totalDbMs}ms total)`]);
    for (const [i, q] of req._dbLog.entries()) {
      if (q.error) {
        lines.push([`  DB#${i + 1}`, `${q.ms}ms FAIL ${q.code || ''} ${q.error} — ${q.sql}`]);
      } else {
        lines.push([`  DB#${i + 1}`, `${q.ms}ms rows=${q.rows ?? '?'} — ${q.sql}`]);
      }
    }
  }

  return { lines, stack: res.locals?.__err?.stack && status >= 500 ? res.locals.__err.stack : null };
}

function writeRequestLog(req, res, { status, ms, responseBody, capturedPath }) {
  if (!shouldLog(status)) return;

  // Scanner noise — skip unless explicitly enabled
  if (isQuietPath(capturedPath) && logRank() < 4 && process.env.LOG_PROBE !== 'true') {
    return;
  }

  const ip = extractIp(req);
  const user = formatRequestUser(req.user);
  const clinic = clinicLabel(req.user);
  const ts = new Date().toISOString();
  const line = `${req.method} ${req.originalUrl} → ${status} ${ms}ms`;
  const emit = status >= 500 ? console.error.bind(console)
    : status >= 400 ? console.error.bind(console)
      : console.log.bind(console);

  const quiet = isQuietPath(capturedPath);
  const verbose = logRank() >= 4 && !quiet;

  if (!verbose) {
    const parts = [`[${ts}] ${line}`, `req=${req.id || '?'}`, `ip=${ip || '?'}`];
    if (user !== '—') parts.push(`user=${user}`);
    if (clinic) parts.push(`clinic=${clinic}`);
    if (req.user?.role) parts.push(`role=${req.user.role}`);
    if (status >= 400 && responseBody?.error) parts.push(`err="${responseBody.error}"`);
    if (status >= 400 && responseBody?.details) {
      parts.push(`details=${JSON.stringify(responseBody.details)}`);
    }
    const err = res.locals?.__err;
    if (err?.message) parts.push(`exception="${err.message}"`);
    if (err?.code) parts.push(`pg=${err.code}`);
    if (ms >= SLOW_MS) parts.push(`slow=${ms}ms`);
    emit(parts.join(' | '));
    if (status >= 500 && err?.stack) console.error(err.stack);
    return;
  }

  const queryParams = Object.keys(req.query).length ? req.query : null;
  const safeHeaders = sanitizeHeaders(req.headers);

  emit('─'.repeat(72));
  emit(`[${ts}] ${line}`);
  emit(`  IP         : ${ip || 'unknown'}`);
  emit(`  User       : ${user}`);
  if (clinic) emit(`  Clinic     : ${clinic}`);
  emit(`  User-Agent : ${req.headers['user-agent'] || '—'}`);

  if (queryParams) emit(`  Query      : ${JSON.stringify(queryParams)}`);

  const headerLines = Object.entries(safeHeaders)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join('\n');
  emit(`  Headers    :\n${headerLines}`);

  if (req.method !== 'GET' && req.body && Object.keys(req.body).length) {
    emit(`  Body       : ${JSON.stringify(sanitizeBody(req.body))}`);
  }

  if (status >= 400) {
    if (responseBody?.error) emit(`  Error      : ${responseBody.error}`);
    if (responseBody?.details) emit(`  Details    : ${JSON.stringify(responseBody.details)}`);
  }

  const { lines: extras, stack } = buildExtraDiagnostics(req, res, { status, ms, responseBody, capturedPath });
  if (extras.length) {
    emit('  Diagnostics:');
    for (const [label, value] of extras) {
      emit(`    ${String(label).padEnd(14)}: ${value}`);
    }
  }
  if (stack) console.error(stack);

  emit('─'.repeat(72));
}

const logger = (req, res, next) => {
  const start = Date.now();
  // Capture early — Express rewrites req.path/req.url when dispatching into sub-routers,
  // so by the time 'finish' fires the path no longer matches the original mount.
  const capturedPath = req.originalUrl.split('?')[0];

  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req._dbLog = [];

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let responseBody;
  res.json = (body) => {
    // Guard against double-send (e.g. requestTimeout's 503 fires, then a slow
    // handler completes and tries to respond): writing again throws
    // ERR_HTTP_HEADERS_SENT and crashes the request.
    if (res.headersSent) {
      console.error(
        `[logger] duplicate response suppressed: ${req.method} ${req.originalUrl} ` +
        `(request-id=${req.id}, status=${res.statusCode})`
      );
      return res;
    }
    responseBody = body;
    return originalJson(body);
  };
  res.send = (body) => {
    if (res.headersSent) {
      console.error(
        `[logger] duplicate send suppressed: ${req.method} ${req.originalUrl} ` +
        `(request-id=${req.id}, status=${res.statusCode})`
      );
      return res;
    }
    if (responseBody == null && body != null) {
      try {
        responseBody = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        responseBody = { _raw: String(body).slice(0, RESPONSE_PREVIEW_MAX) };
      }
    }
    return originalSend(body);
  };

  res.on('finish', () => {
    const ms     = Date.now() - start;
    const status = res.statusCode;

    writeRequestLog(req, res, { status, ms, responseBody, capturedPath });

    {
      const { action, entityType, entityId } = resolveAction(req.method, capturedPath);
      const user = req.user;

      activityService.write({
        user_id:         user?.sub       || null,
        user_name:       user?.display_name || null,
        user_email:      user?.email || null,
        clinic_id:       user?.clinic_id || user?.active_clinic_id || null,
        method:          req.method,
        path:            req.originalUrl,
        action,
        details:         buildDetail(req.method, capturedPath, req.body),
        entity_type:     entityType,
        entity_id:       entityId ? String(entityId) : null,
        status_code:     status,
        duration_ms:     ms,
        ip_address:      extractIp(req),
        user_agent:      req.headers['user-agent'] || null,
        request_body:    req.method !== 'GET' ? sanitizeBody(req.body) : null,
        request_headers: sanitizeHeaders(req.headers),
      });
    }
  });

  runWithQueryLog(req._dbLog, () => next());
};

module.exports = logger;
