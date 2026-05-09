const activityService = require('../activity/activity.service');

const SENSITIVE_KEYS = ['password', 'password_hash', 'token', 'refresh_token', 'secret'];

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

const logger = (req, res, next) => {
  const start = Date.now();
  // Capture early — Express rewrites req.path/req.url when dispatching into sub-routers,
  // so by the time 'finish' fires the path no longer matches the original mount.
  const capturedPath = req.originalUrl.split('?')[0];

  const originalJson = res.json.bind(res);
  let responseBody;
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    const ms     = Date.now() - start;
    const status = res.statusCode;
    const line   = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status} (${ms}ms)`;

    if (status >= 400) {
      console.error(line);
      if (responseBody?.error)   console.error('  error:', responseBody.error);
      if (responseBody?.details) console.error('  details:', responseBody.details);
    } else {
      console.log(line);
    }

    if (req.method !== 'GET' || status >= 400) {
      const { action, entityType, entityId } = resolveAction(req.method, capturedPath);
      const user = req.user;

      activityService.write({
        user_id:      user?.sub       || null,
        clinic_id:    user?.clinic_id || user?.active_clinic_id || null,
        method:       req.method,
        path:         req.originalUrl,
        action,
        details:      buildDetail(req.method, capturedPath, req.body),
        entity_type:  entityType,
        entity_id:    entityId ? String(entityId) : null,
        status_code:  status,
        duration_ms:  ms,
        ip_address:   extractIp(req),
        user_agent:   req.headers['user-agent'] || null,
        request_body: req.method !== 'GET' ? sanitizeBody(req.body) : null,
      });
    }
  });

  next();
};

module.exports = logger;
