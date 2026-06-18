/**
 * Generates printable backend mindmap docs:
 *   docs/backend-mindmap/diagrams/*.svg
 *   docs/backend-mindmap/backend-mindmap-combined.svg
 *   docs/backend-mindmap/backend-mindmap.html
 *
 * Run: node scripts/generate-backend-mindmap.js
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '../docs/backend-mindmap');
const DIAG = path.join(OUT, 'diagrams');

const COLORS = {
  bg: '#ffffff',
  surface: '#f8fafc',
  border: '#cbd5e1',
  text: '#0f172a',
  muted: '#475569',
  accent: '#2563eb',
  accentLight: '#dbeafe',
  green: '#059669',
  greenLight: '#d1fae5',
  purple: '#7c3aed',
  purpleLight: '#ede9fe',
  orange: '#d97706',
  orangeLight: '#ffedd5',
};

const NODE_W = 260;
const NODE_PAD = 12;
const LINE_H = 16;
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function wrapLines(text, maxChars = 34) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function nodeHeight(title, lines = [], monoLines = []) {
  const titleLines = wrapLines(title, 30);
  const bodyLines = lines.flatMap((l) => wrapLines(l, 34));
  const mono = monoLines.flatMap((l) => wrapLines(l, 36));
  const rows = titleLines.length + bodyLines.length + mono.length;
  const extra = (bodyLines.length || mono.length) ? 6 : 0;
  return NODE_PAD * 2 + titleLines.length * LINE_H + bodyLines.length * LINE_H + mono.length * LINE_H + extra + 4;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function drawNode(x, y, opts) {
  const {
    title,
    lines = [],
    monoLines = [],
    fill = COLORS.surface,
    stroke = COLORS.border,
    titleColor = COLORS.text,
    accent = false,
  } = opts;
  const h = nodeHeight(title, lines, monoLines);
  const titleWrapped = wrapLines(title, 30);
  let inner = '';
  let ty = y + NODE_PAD + 12;

  for (const tl of titleWrapped) {
    inner += `<text x="${x + NODE_PAD}" y="${ty}" fill="${titleColor}" font-family="${FONT}" font-size="13" font-weight="600">${esc(tl)}</text>\n`;
    ty += LINE_H;
  }

  const bodyLines = lines.flatMap((l) => wrapLines(l, 34));
  if (bodyLines.length) ty += 4;
  for (const bl of bodyLines) {
    inner += `<text x="${x + NODE_PAD}" y="${ty}" fill="${COLORS.muted}" font-family="${FONT}" font-size="11">${esc(bl)}</text>\n`;
    ty += LINE_H;
  }

  const mono = monoLines.flatMap((l) => wrapLines(l, 36));
  if (mono.length) ty += 4;
  for (const ml of mono) {
    inner += `<text x="${x + NODE_PAD}" y="${ty}" fill="${COLORS.muted}" font-family="${FONT_MONO}" font-size="10">${esc(ml)}</text>\n`;
    ty += LINE_H;
  }

  const strokeW = accent ? 2 : 1;
  const strokeCol = accent ? COLORS.accent : stroke;

  return {
    svg: `<g class="node">
  <rect x="${x}" y="${y}" width="${NODE_W}" height="${h}" rx="8" fill="${fill}" stroke="${strokeCol}" stroke-width="${strokeW}"/>
  ${inner}
</g>`,
    x,
    y,
    w: NODE_W,
    h,
    cx: x + NODE_W / 2,
    cy: y + h / 2,
    bottom: y + h,
    right: x + NODE_W,
  };
}

function arrow(x1, y1, x2, y2) {
  const midY = (y1 + y2) / 2;
  return `<path d="M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}" fill="none" stroke="${COLORS.border}" stroke-width="1.5" marker-end="url(#arrow)"/>`;
}

function arrowDown(cx, y1, y2) {
  return `<line x1="${cx}" y1="${y1}" x2="${cx}" y2="${y2}" stroke="${COLORS.border}" stroke-width="1.5" marker-end="url(#arrow)"/>`;
}

function svgHeader(width, height, title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="${COLORS.border}"/>
    </marker>
    <style>
      text { user-select: none; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="${COLORS.bg}"/>
  <text x="24" y="32" fill="${COLORS.text}" font-family="${FONT}" font-size="18" font-weight="700">${esc(title)}</text>
  <text x="24" y="50" fill="${COLORS.muted}" font-family="${FONT}" font-size="11">DentaFlow Backend — entity relationships &amp; data flow</text>
  <line x1="24" y1="58" x2="${width - 24}" y2="58" stroke="${COLORS.border}" stroke-width="1"/>
`;
}

function layoutVertical(nodes, startX, startY, gap = 20) {
  const placed = [];
  let y = startY;
  const x = startX;
  for (const n of nodes) {
    const node = drawNode(x, y, n);
    placed.push({ ...node, meta: n });
    y = node.bottom + gap;
  }
  return { placed, width: NODE_W + startX * 2, height: y + 24 };
}

function layoutGrid(nodeDefs, startX, startY, cols, gapX = 24, gapY = 20) {
  const placed = [];
  let maxBottom = startY;
  const colWidths = Array(cols).fill(0);

  for (let i = 0; i < nodeDefs.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const prevInCol = placed.filter((_, idx) => idx % cols === col);
    const y =
      prevInCol.length === 0
        ? startY
        : Math.max(...prevInCol.map((p) => p.bottom)) + gapY;
    const x = startX + col * (NODE_W + gapX);
    const node = drawNode(x, y, nodeDefs[i]);
    placed.push({ ...node, col, row });
    colWidths[col] = Math.max(colWidths[col], NODE_W);
    maxBottom = Math.max(maxBottom, node.bottom);
  }

  const width = startX * 2 + cols * NODE_W + (cols - 1) * gapX;
  return { placed, width, height: maxBottom + 24 };
}

function buildArchitecture() {
  const startY = 72;
  const gap = 18;
  const nodes = [
    {
      title: 'HTTP Request',
      lines: ['Helmet, CORS, rate limits, XSS'],
      fill: COLORS.accentLight,
      accent: true,
    },
    { title: 'authenticate.js', monoLines: ['JWT verify → req.user'] },
    { title: 'authorize.js', monoLines: ['RBAC + ABAC policy gate'] },
    { title: 'validate.js', lines: ['Joi schema per route'] },
    { title: 'Route Handler', lines: ['src/routes/*.js'] },
    { title: 'db.js (pg Pool)', lines: ['Raw SQL, no ORM'], fill: COLORS.greenLight },
  ];

  let y = startY;
  const parts = [];
  const arrows = [];
  const x = 40;
  const placed = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = drawNode(x, y, nodes[i]);
    placed.push(n);
    if (i > 0) {
      arrows.push(arrowDown(n.cx, placed[i - 1].bottom, y - 4));
    }
    y = n.bottom + gap;
  }

  for (const p of placed) parts.push(p.svg);
  const w = NODE_W + 80;
  const h = y + 24;
  let svg = svgHeader(w, h, 'Request Flow');
  svg += parts.join('\n') + arrows.join('\n') + '</svg>';
  return { name: '01-request-flow', svg, w, h };
}

function buildTenancy() {
  const startY = 72;
  const x = 40;
  const gap = 18;
  const nodes = [
    {
      title: 'organizations',
      lines: ['Top tenant', 'Billing identity (GSTIN)'],
      fill: COLORS.purpleLight,
      accent: true,
    },
    {
      title: 'clinics',
      lines: ['Tenant / branch', 'tenant_status: TRIAL→ACTIVE'],
      fill: COLORS.accentLight,
    },
    {
      title: 'Domain tables',
      monoLines: ['org_id + clinic_id on every row'],
      lines: ['JWT supplies scope — never from body'],
      fill: COLORS.greenLight,
    },
  ];

  let y = startY;
  const parts = [];
  const arrows = [];
  const placed = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = drawNode(x, y, nodes[i]);
    placed.push(n);
    if (i > 0) arrows.push(arrowDown(n.cx, placed[i - 1].bottom, y - 4));
    y = n.bottom + gap;
  }
  for (const p of placed) parts.push(p.svg);

  // Side branch: users
  const ux = x + NODE_W + 48;
  const u1 = drawNode(ux, startY + 40, {
    title: 'users (staff)',
    lines: ['clinic_id, org_id', 'user_roles, refresh_tokens'],
  });
  const u2 = drawNode(ux, u1.bottom + gap, {
    title: 'RBAC',
    monoLines: ['permissions → roles', 'role_permissions', 'user_roles', 'permission_overrides'],
  });
  parts.push(u1.svg, u2.svg);
  parts.push(arrow(placed[1].right, placed[1].cy, ux, u1.cy));

  const w = ux + NODE_W + 40;
  const h = Math.max(y, u2.bottom) + 24;
  let svg = svgHeader(w, h, 'Multi-Tenancy & Identity');
  svg += parts.join('\n') + arrows.join('\n') + '</svg>';
  return { name: '02-tenancy-identity', svg, w, h };
}

function buildCoreOps() {
  const startY = 72;
  const { placed: patients } = layoutGrid(
    [
      { title: 'patients', lines: ['name, phone, clinical_history'], fill: COLORS.accentLight, accent: true },
      { title: 'patient_file', lines: ['S3: 3D, DICOM, PDF, video'] },
      { title: 'appointments', monoLines: ['status: booked→confirmed→in_treatment→done'] },
      { title: 'services', lines: ['duration, price, consent flags'] },
      { title: 'chairs', lines: ['Treatment rooms'] },
      { title: 'chair_service_log', lines: ['Maintenance log'] },
    ],
    40,
    startY,
    3,
    24,
    20
  );

  const w = 40 * 2 + 3 * NODE_W + 2 * 24;
  const h = Math.max(...patients.map((p) => p.bottom)) + 24;
  let svg = svgHeader(w, h, 'Core Clinic Operations');
  svg += patients.map((p) => p.svg).join('\n');
  svg += `<text x="40" y="${h - 12}" fill="${COLORS.muted}" font-family="${FONT}" font-size="10">Routes: /v1/patients, /v1/appointments, /v1/services, /v1/chairs, /v1/staff</text>`;
  svg += '</svg>';
  return { name: '03-core-operations', svg, w, h };
}

function buildClinicalHub() {
  const startY = 72;
  const x = 40;
  const gap = 16;

  const appt = drawNode(x + 200, startY, {
    title: 'appointments',
    fill: COLORS.orangeLight,
    accent: true,
  });
  const session = drawNode(x + 200, appt.bottom + gap, {
    title: 'clinical_session',
    lines: ['Central workflow hub'],
    monoLines: ['INITIALISED → EXAMINING → … → COMPLETED'],
    fill: COLORS.accentLight,
    accent: true,
  });

  const children = [
    { title: 'clinical_note', lines: ['SOAP — 1 per session'] },
    { title: 'examination', lines: ['Chief complaint, findings'] },
    { title: 'diagnosis', lines: ['provisional / final'] },
    { title: 'tooth_chart_snapshot', lines: ['JSONB chart'] },
    { title: 'service_performed', lines: ['Charges, discounts'] },
    { title: 'session_attachments', lines: ['Session S3 files'] },
    { title: 'investigation_order', lines: ['Imaging / lab orders'] },
    { title: 'lab_order', lines: ['External lab work'] },
    { title: 'preop_record', lines: ['Surgical pre-op'] },
    { title: 'postop_record', lines: ['Surgical post-op'] },
    { title: 'consent_record', lines: ['Signed consent PDFs'] },
    { title: 'tpa_preauth', lines: ['Insurance pre-auth'] },
    { title: 'prescriptions', lines: ['Rx + session_id'] },
    { title: 'material_consumption', lines: ['Inventory cart'] },
    { title: 'patient_device_register', lines: ['Implant traceability'] },
  ];

  const gridY = session.bottom + gap + 8;
  const { placed: grid } = layoutGrid(children, x, gridY, 3, 24, 16);

  const arrows = [
    arrowDown(session.cx, appt.bottom, session.y - 2),
    arrowDown(session.cx, session.bottom, gridY - 8),
  ];

  const w = x * 2 + 3 * NODE_W + 2 * 24;
  const h = Math.max(...grid.map((p) => p.bottom)) + 36;
  let svg = svgHeader(w, h, 'Clinical Session Hub');
  svg += appt.svg + session.svg;
  svg += grid.map((p) => p.svg).join('\n');
  svg += arrows.join('\n');
  svg += `<text x="40" y="${h - 12}" fill="${COLORS.muted}" font-family="${FONT}" font-size="10">Routes: /v1 clinical-session, /v1/rx, /v1/specialty/*</text>`;
  svg += '</svg>';
  return { name: '04-clinical-session-hub', svg, w, h };
}

function buildSpecialty() {
  const startY = 72;
  const x = 40;

  const caseN = drawNode(x + 180, startY, {
    title: 'specialty_case',
    monoLines: ['ORTHO | IMPLANT | PAEDO | ENDO | TMJ'],
    fill: COLORS.purpleLight,
    accent: true,
  });

  const extensions = [
    { title: 'ortho_* (6 tables)', lines: ['archwire, elastic, aligner logs'] },
    { title: 'implant_* (6 tables)', lines: ['fixtures, prosthesis'] },
    { title: 'endo_* (5 tables)', lines: ['canal records, recalls'] },
    { title: 'paedo_* (7 tables)', lines: ['guardians, eruption'] },
    { title: 'tmj_* (6 tables)', lines: ['ROM, pain, splints'] },
    { title: 'specialty_milestone', lines: ['Case timeline events'] },
  ];
  const gridY = caseN.bottom + 24;
  const { placed: ext } = layoutGrid(extensions, x, gridY, 3, 24, 16);

  const chainY = Math.max(...ext.map((p) => p.bottom)) + 28;
  const visit = drawNode(x + 180, chainY, {
    title: 'specialty_visit',
    lines: ['Links to clinical_session'],
    fill: COLORS.accentLight,
  });
  const session = drawNode(x + 180, visit.bottom + 16, {
    title: 'clinical_session',
    fill: COLORS.greenLight,
  });

  const arrows = [
    arrowDown(caseN.cx, caseN.bottom, gridY - 4),
    arrowDown(visit.cx, visit.bottom, session.y - 2),
  ];

  const w = x * 2 + 3 * NODE_W + 2 * 24;
  const h = session.bottom + 24;
  let svg = svgHeader(w, h, 'Specialty Modules');
  svg += caseN.svg;
  svg += ext.map((p) => p.svg).join('\n');
  svg += visit.svg + session.svg;
  svg += arrows.join('\n');
  svg += `<text x="40" y="${h - 12}" fill="${COLORS.muted}" font-family="${FONT}" font-size="10">Routes: /v1/specialty, /v1/specialty/orthodontic, implantology, paediatric, endodontic, tmj</text>`;
  svg += '</svg>';
  return { name: '05-specialty-modules', svg, w, h };
}

function buildMarketing() {
  const startY = 72;
  const hub = drawNode(200, startY, {
    title: 'mkt_pipeline_leads',
    lines: ['Sales / onboarding hub'],
    fill: COLORS.orangeLight,
    accent: true,
  });

  const satellites = [
    { title: 'mkt_lead_feedback' },
    { title: 'mkt_caller_feedback' },
    { title: 'mkt_call_logs' },
    { title: 'mkt_callbacks' },
    { title: 'mkt_scheduled_calls' },
    { title: 'mkt_onboarding_steps' },
    { title: 'mkt_pitch_documents' },
    { title: 'mkt_digital_enquiries' },
    { title: 'mkt_scraped_leads' },
  ];
  const { placed: sat } = layoutGrid(satellites, 40, hub.bottom + 24, 3, 24, 14);

  const campaignRow = [
    { title: 'mkt_campaigns', fill: COLORS.accentLight },
    { title: 'mkt_content_calendar' },
    { title: 'mkt_campaign_sends' },
    { title: 'mkt_segments' },
    { title: 'mkt_promo_codes' },
    { title: 'mkt_promo_redemptions' },
    { title: 'mkt_expenses' },
    { title: 'mkt_places_usage/cache' },
  ];
  const cy = Math.max(...sat.map((p) => p.bottom)) + 28;
  const { placed: camp } = layoutGrid(campaignRow, 40, cy, 4, 24, 14);

  const arrows = [arrowDown(hub.cx, hub.bottom, sat[0].y - 8)];

  const w = 40 * 2 + 4 * NODE_W + 3 * 24;
  const h = Math.max(...camp.map((p) => p.bottom)) + 24;
  let svg = svgHeader(w, h, 'Marketing Module');
  svg += hub.svg;
  svg += sat.map((p) => p.svg).join('\n');
  svg += camp.map((p) => p.svg).join('\n');
  svg += arrows.join('\n');
  svg += `<text x="40" y="${h - 12}" fill="${COLORS.muted}" font-family="${FONT}" font-size="10">Route: /v1/marketing/* — Roles: marketing_lead, marketing_member, marketing_caller</text>`;
  svg += '</svg>';
  return { name: '06-marketing', svg, w, h };
}

function buildBillingInventory() {
  const startY = 72;
  const billing = [
    { title: 'subscription_plan', lines: ['Product catalog'], fill: COLORS.purpleLight },
    { title: 'subscription', lines: ['clinics = tenant_id'], fill: COLORS.accentLight, accent: true },
    { title: 'platform_invoice' },
    { title: 'platform_payment' },
    { title: 'clinic_expense', lines: ['Clinic-level expenses'] },
  ];
  const inv = [
    { title: 'inventory_item', fill: COLORS.greenLight },
    { title: 'inventory_batch' },
    { title: 'stock_movement', lines: ['Append-only ledger'] },
    { title: 'current_stock', lines: ['Materialized view'] },
    { title: 'purchase_order + lines' },
    { title: 'material_consumption', lines: ['Links to session'] },
  ];

  const { placed: b } = layoutGrid(billing, 40, startY, 2, 24, 16);
  const invY = Math.max(...b.map((p) => p.bottom)) + 40;
  const { placed: i } = layoutGrid(inv, 40, invY, 3, 24, 16);

  const w = 40 * 2 + 3 * NODE_W + 2 * 24;
  const h = Math.max(...i.map((p) => p.bottom)) + 24;
  let svg = svgHeader(w, h, 'Platform Billing & Inventory');
  svg += `<text x="40" y="${invY - 16}" fill="${COLORS.muted}" font-family="${FONT}" font-size="12" font-weight="600">Inventory</text>`;
  svg += b.map((p) => p.svg).join('\n');
  svg += i.map((p) => p.svg).join('\n');
  svg += '</svg>';
  return { name: '07-billing-inventory', svg, w, h };
}

function buildTreatmentPlan() {
  const startY = 72;
  const x = 40;
  const gap = 16;
  const patient = drawNode(x + 140, startY, {
    title: 'patients',
    fill: COLORS.accentLight,
    accent: true,
  });
  const plan = drawNode(x + 140, patient.bottom + gap, {
    title: 'treatment_plan',
    lines: ['Multi-step care plan'],
    fill: COLORS.purpleLight,
    accent: true,
  });
  const item = drawNode(x + 140, plan.bottom + gap, {
    title: 'treatment_plan_item',
    monoLines: ['service_id, linked_diagnosis_id', 'status: PROPOSED→DONE'],
  });
  const svc = drawNode(x, item.bottom + gap + 8, {
    title: 'services',
    lines: ['Procedure catalog'],
    fill: COLORS.greenLight,
  });
  const diag = drawNode(x + 280, item.bottom + gap + 8, {
    title: 'diagnosis',
    lines: ['Optional link'],
  });
  const sp = drawNode(x + 140, Math.max(svc.bottom, diag.bottom) + gap, {
    title: 'service_performed',
    lines: ['plan_item_id optional FK'],
    fill: COLORS.orangeLight,
  });
  const spec = drawNode(x + 140, sp.bottom + gap, {
    title: 'specialty_case',
    lines: ['treatment_plan_id optional'],
    fill: COLORS.accentLight,
  });

  const arrows = [
    arrowDown(plan.cx, patient.bottom, plan.y - 2),
    arrowDown(item.cx, plan.bottom, item.y - 2),
    arrowDown(svc.cx + NODE_W / 2, item.bottom, svc.y - 2),
    arrow(item.right, item.cy, diag.x, diag.cy),
    arrowDown(sp.cx, Math.max(svc.bottom, diag.bottom), sp.y - 2),
    arrowDown(spec.cx, sp.bottom, spec.y - 2),
  ];

  const w = x * 2 + NODE_W + 280 + 40;
  const h = spec.bottom + 24;
  let svg = svgHeader(w, h, 'Treatment Planning');
  svg +=
    patient.svg +
    plan.svg +
    item.svg +
    svc.svg +
    diag.svg +
    sp.svg +
    spec.svg +
    arrows.join('\n');
  svg += '</svg>';
  return { name: '09-treatment-planning', svg, w, h };
}

function buildPrescriptions() {
  const startY = 72;
  const catalog = [
    { title: 'rx_medicines', lines: ['Drug catalog per clinic'] },
    { title: 'rx_procedures', lines: ['Procedure codes'] },
    { title: 'rx_service_defaults', lines: ['Service → medicine defaults'] },
    { title: 'rx_sequence', lines: ['Rx numbering'] },
  ];
  const { placed: cat } = layoutGrid(catalog, 40, startY, 2, 24, 16);

  const py = Math.max(...cat.map((p) => p.bottom)) + 32;
  const rx = drawNode(200, py, {
    title: 'prescriptions',
    monoLines: ['patient_id, appointment_id', 'doctor_id, session_id'],
    fill: COLORS.accentLight,
    accent: true,
  });
  const lines = drawNode(200, rx.bottom + 16, {
    title: 'rx_line_items',
    lines: ['Medicine lines per prescription'],
  });

  const w = 40 * 2 + 2 * NODE_W + 24;
  const h = lines.bottom + 24;
  let svg = svgHeader(w, h, 'Prescriptions (Rx)');
  svg += cat.map((p) => p.svg).join('\n');
  svg += rx.svg + lines.svg;
  svg += arrowDown(rx.cx, rx.bottom, lines.y - 2);
  svg += `<text x="40" y="${h - 12}" fill="${COLORS.muted}" font-family="${FONT}" font-size="10">Route: /v1/rx</text>`;
  svg += '</svg>';
  return { name: '10-prescriptions', svg, w, h };
}

function buildRoutesTable() {
  const routes = [
    ['/v1/auth', 'Login, OTP, MFA, refresh tokens'],
    ['/v1/patients', 'Patient registry + files'],
    ['/v1/appointments', 'Booking + public slots'],
    ['/v1/clinical-session', 'Session workflow'],
    ['/v1/rx', 'Prescriptions'],
    ['/v1/specialty/*', '5 specialty modules'],
    ['/v1/inventory', 'Stock + purchase orders'],
    ['/v1/platform', 'SaaS billing'],
    ['/v1/marketing', 'Marketing pipeline'],
    ['/v1/rbac', 'Roles & permissions'],
    ['/v1/activity-log', 'HTTP audit'],
    ['/v1/feature-flags', 'Feature toggles'],
  ];

  const startY = 72;
  const rowH = 28;
  const w = 720;
  const h = startY + routes.length * rowH + 40;
  let svg = svgHeader(w, h, 'API Route Map');
  let y = startY;
  for (const [route, desc] of routes) {
    svg += `<text x="40" y="${y + 14}" fill="${COLORS.accent}" font-family="${FONT_MONO}" font-size="11" font-weight="600">${esc(route)}</text>`;
    svg += `<text x="220" y="${y + 14}" fill="${COLORS.muted}" font-family="${FONT}" font-size="11">${esc(desc)}</text>`;
    y += rowH;
  }
  svg += '</svg>';
  return { name: '11-api-routes', svg, w, h };
}

function buildCombined(diagrams) {
  const pad = 32;
  const maxW = Math.max(...diagrams.map((d) => d.w));
  let y = 0;
  const parts = [];

  for (const d of diagrams) {
    const offsetX = (maxW - d.w) / 2;
    parts.push(`<g transform="translate(${offsetX}, ${y})">`);
    // Strip outer svg wrapper — embed inner content
    const inner = d.svg
      .replace(/<\?xml[^>]*>/, '')
      .replace(/<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '');
    parts.push(inner);
    parts.push('</g>');
    y += d.h + pad;
  }

  const w = maxW;
  const h = y;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/1999/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="${COLORS.bg}"/>
  <text x="${w / 2}" y="40" text-anchor="middle" fill="${COLORS.text}" font-family="${FONT}" font-size="22" font-weight="700">DentaFlow Backend Mindmap</text>
  <text x="${w / 2}" y="62" text-anchor="middle" fill="${COLORS.muted}" font-family="${FONT}" font-size="12">Database entities, relationships &amp; API routes — ${new Date().toISOString().slice(0, 10)}</text>
  <g transform="translate(0, 80)">${parts.join('\n')}</g>
</svg>`;
}

function buildHtml(diagrams) {
  const diagramSections = diagrams
    .map(
      (d) => `
    <section class="diagram-page">
      <h2>${esc(d.title || d.name.replace(/^\d+-/, '').replace(/-/g, ' '))}</h2>
      <figure class="diagram-figure">
        <img src="diagrams/${d.name}.svg" alt="${esc(d.name)}" class="diagram-img" />
      </figure>
    </section>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>DentaFlow Backend Mindmap</title>
  <link rel="stylesheet" href="print.css"/>
</head>
<body>
  <header class="cover">
    <h1>DentaFlow Backend Mindmap</h1>
    <p class="subtitle">Database structure, entity relationships, API routes</p>
    <p class="meta">Generated ${new Date().toISOString().slice(0, 10)} · 90+ tables · 31 route modules</p>
    <p class="print-hint">Print: File → Print → Save as PDF (A4, margins default)</p>
  </header>

  <section class="summary">
    <h2>Summary</h2>
    <div class="summary-grid">
      <div class="card"><strong>Spine</strong><p>Organization → Clinic → Patient → Appointment → Clinical Session</p></div>
      <div class="card"><strong>Tenancy</strong><p><code>org_id</code> + <code>clinic_id</code> from JWT on every row</p></div>
      <div class="card"><strong>Clinical hub</strong><p>Notes, chart, diagnosis, services, consent, Rx, inventory radiate from session</p></div>
      <div class="card"><strong>Specialty</strong><p>5 case types with 30+ extension tables via <code>specialty_case</code></p></div>
      <div class="card"><strong>Marketing</strong><p>20+ <code>mkt_*</code> tables around <code>mkt_pipeline_leads</code></p></div>
      <div class="card"><strong>Public APIs</strong><p><code>POST /v1/auth/*</code>, <code>GET /v1/appointments/slots</code>, <code>GET /health</code></p></div>
    </div>
  </section>

  <section class="entity-counts">
    <h2>Entity Count by Domain</h2>
    <table>
      <thead><tr><th>Domain</th><th>Tables</th></tr></thead>
      <tbody>
        <tr><td>Core / identity</td><td>~15</td></tr>
        <tr><td>Clinical session workflow</td><td>~20</td></tr>
        <tr><td>Specialty extensions</td><td>~30</td></tr>
        <tr><td>Inventory / procurement</td><td>~7</td></tr>
        <tr><td>Prescriptions (Rx)</td><td>~7</td></tr>
        <tr><td>Platform billing</td><td>~8</td></tr>
        <tr><td>Marketing</td><td>~20</td></tr>
        <tr><td>Audit / infra</td><td>~5</td></tr>
      </tbody>
    </table>
  </section>

${diagramSections}

  <footer class="doc-footer">
    <p>DentaFlow MVP Backend · docs/backend-mindmap/</p>
  </footer>
</body>
</html>`;
}

function main() {
  fs.mkdirSync(DIAG, { recursive: true });

  const builders = [
    buildArchitecture,
    buildTenancy,
    buildCoreOps,
    buildClinicalHub,
    buildSpecialty,
    buildMarketing,
    buildBillingInventory,
    buildTreatmentPlan,
    buildPrescriptions,
    buildRoutesTable,
  ];

  const diagrams = builders.map((fn) => {
    const d = fn();
    d.title = d.name.replace(/^\d+-/, '').replace(/-/g, ' ');
    fs.writeFileSync(path.join(DIAG, `${d.name}.svg`), d.svg, 'utf8');
    console.log(`  ✓ diagrams/${d.name}.svg (${d.w}×${d.h})`);
    return d;
  });

  const combined = buildCombined(diagrams);
  fs.writeFileSync(path.join(OUT, 'backend-mindmap-combined.svg'), combined, 'utf8');
  console.log(`  ✓ backend-mindmap-combined.svg`);

  fs.writeFileSync(path.join(OUT, 'backend-mindmap.html'), buildHtml(diagrams), 'utf8');
  console.log(`  ✓ backend-mindmap.html`);

  console.log('\nOpen docs/backend-mindmap/backend-mindmap.html in browser → Print → Save as PDF');
}

main();
