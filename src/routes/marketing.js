'use strict';

// Marketing Strategy Module — Phase 1 (Foundation).
// PRD_MARKETING_STRATEGY_MODULE. Mounted at /v1/marketing.
// Everything here is scoped to the active clinic (req.context.clinicId), the
// codebase's "tenant". Campaigns + content calendar CRUD and a dashboard
// skeleton; later phases add segments, promo codes, pipeline, tasks, etc.

const express      = require('express');
const crypto       = require('crypto');
const multer       = require('multer');
const { v4: uuidv4 } = require('uuid');
const Joi          = require('joi');
const db           = require('../db');
const { uploadBuffer, getPresignedUrl } = require('../services/s3Service');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const gcal         = require('../services/googleCalendarService');
const leadFinder   = require('../services/leadFinderService');
const screening    = require('../services/leadScreeningService');
const placesGuard  = require('../services/placesGuard');
const wa           = require('../services/whatsappService');
const segmentSvc   = require('../services/marketingSegmentService');
const pitchPdf     = require('../services/pitchPdfBuilder');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

function clinicOf(req, res) {
  const clinicId = req.context.clinicId;
  if (!clinicId) { res.status(400).json({ error: 'No active clinic selected' }); return null; }
  return clinicId;
}

// ── Schemas ───────────────────────────────────────────────────────────────────
const campaignSchema = Joi.object({
  name:           Joi.string().max(160).required(),
  goal:           Joi.string().valid('bookings', 'awareness', 'lead_gen').default('bookings'),
  channel:        Joi.string().valid('whatsapp', 'instagram', 'facebook', 'offline').default('whatsapp'),
  status:         Joi.string().valid('draft', 'scheduled', 'active', 'completed', 'archived').default('draft'),
  budget_paise:   Joi.number().integer().min(0).default(0),
  start_date:     Joi.date().iso().allow(null).optional(),
  end_date:       Joi.date().iso().allow(null).optional(),
  promo_code_id:  Joi.string().uuid().allow(null).optional(),
  segment_id:     Joi.string().uuid().allow(null).optional(),
  wa_template_id: Joi.string().uuid().allow(null).optional(),
});
const campaignUpdateSchema = campaignSchema.fork(
  ['name', 'goal', 'channel', 'status', 'budget_paise'], (f) => f.optional()
);

const calendarSchema = Joi.object({
  campaign_id:   Joi.string().uuid().allow(null).optional(),
  channel:       Joi.string().valid('instagram', 'facebook', 'whatsapp_status', 'other').default('instagram'),
  title:         Joi.string().max(160).required(),
  caption:       Joi.string().allow('', null).optional(),
  media_url:     Joi.string().max(500).allow('', null).optional(),
  scheduled_for: Joi.date().iso().allow(null).optional(),
  status:        Joi.string().valid('draft', 'scheduled', 'posted', 'cancelled').default('draft'),
  owner_id:      Joi.string().uuid().allow(null).optional(),
});
const calendarUpdateSchema = calendarSchema.fork(['title'], (f) => f.optional());
const statusPatchSchema = Joi.object({
  status: Joi.string().valid('draft', 'scheduled', 'posted', 'cancelled').required(),
});

const CAMPAIGN_COLS = [
  'name', 'goal', 'channel', 'status', 'budget_paise', 'start_date', 'end_date',
  'promo_code_id', 'segment_id', 'wa_template_id',
];
const CALENDAR_COLS = [
  'campaign_id', 'channel', 'title', 'caption', 'media_url', 'scheduled_for',
  'status', 'owner_id',
];

// Build a partial UPDATE SET clause from whitelisted body keys.
function buildUpdate(body, cols, startIdx) {
  const sets = [];
  const params = [];
  for (const c of cols) {
    if (body[c] !== undefined) {
      params.push(body[c]);
      sets.push(`${c} = $${startIdx + params.length}`);
    }
  }
  return { sets, params };
}

// ══════════════════════════════════════════════════════════════════════════════
// Campaigns
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /campaigns ────────────────────────────────────────────────────────────
router.get('/campaigns', ...authChain, requirePermission(P.MKT_CAMPAIGN_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'clinic_id = $1 AND deleted_at IS NULL';
    if (req.query.status) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
    if (req.query.channel) { params.push(req.query.channel); where += ` AND channel = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM mkt_campaigns WHERE ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /campaigns/:id ────────────────────────────────────────────────────────
router.get('/campaigns/:id', ...authChain, requirePermission(P.MKT_CAMPAIGN_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT * FROM mkt_campaigns WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /campaigns ───────────────────────────────────────────────────────────
router.post('/campaigns', ...authChain, requirePermission(P.MKT_CAMPAIGN_CREATE), validate(campaignSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO mkt_campaigns
         (org_id, clinic_id, name, goal, channel, status, budget_paise,
          start_date, end_date, promo_code_id, segment_id, wa_template_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [orgId, clinicId, b.name, b.goal, b.channel, b.status, b.budget_paise,
       b.start_date ?? null, b.end_date ?? null, b.promo_code_id ?? null,
       b.segment_id ?? null, b.wa_template_id ?? null, userId]
    );
    req.audit?.write({ action: 'marketing.campaign.create', resource_type: 'mkt_campaign', resource_id: rows[0].id, result: 'success' }).catch(() => {});
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /campaigns/:id ────────────────────────────────────────────────────────
router.put('/campaigns/:id', ...authChain, requirePermission(P.MKT_CAMPAIGN_EDIT), validate(campaignUpdateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { sets, params } = buildUpdate(req.body, CAMPAIGN_COLS, 2);
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.context.userId);
    sets.push(`updated_by = $${2 + params.length - 1}`);
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_campaigns SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $${2 + params.length} AND deleted_at IS NULL
        RETURNING *`,
      [req.params.id, ...params, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /campaigns/:id — soft delete ───────────────────────────────────────
router.delete('/campaigns/:id', ...authChain, requirePermission(P.MKT_CAMPAIGN_DELETE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      `UPDATE mkt_campaigns SET deleted_at = NOW(), updated_by = $3
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId, req.context.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Campaign not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── POST /campaigns/:id/send — resolve segment → recipients → WA broadcast ────
router.post('/campaigns/:id/send', ...authChain, requirePermission(P.MKT_CAMPAIGN_SEND), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const campRes = await db.query(
      `SELECT * FROM mkt_campaigns WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId]
    );
    if (!campRes.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = campRes.rows[0];

    // Resolve the linked segment to a recipient phone list (whole CRM if none).
    let phones = [];
    if (campaign.segment_id) {
      const seg = await db.query(
        `SELECT filter_json FROM mkt_segments WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
        [campaign.segment_id, clinicId]
      );
      if (!seg.rows.length) return res.status(400).json({ error: 'Linked segment not found' });
      const { inner, params } = segmentSvc.buildInner(clinicId, seg.rows[0].filter_json);
      const r = await db.query(`SELECT phone FROM (${inner}) s WHERE phone IS NOT NULL`, params);
      phones = r.rows.map((x) => x.phone);
    } else {
      const r = await db.query('SELECT phone FROM patients WHERE clinic_id = $1 AND phone IS NOT NULL', [clinicId]);
      phones = r.rows.map((x) => x.phone);
    }

    const result = await wa.broadcast({ recipients: phones, template: campaign.wa_template_id });

    const send = await db.query(
      `INSERT INTO mkt_campaign_sends
         (org_id, clinic_id, campaign_id, segment_id, channel, recipients, sent_count, failed_count, provider, status, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [orgId, clinicId, campaign.id, campaign.segment_id ?? null, campaign.channel,
       phones.length, result.sent, result.failed, result.provider, result.status, userId]
    );

    const updated = await db.query(
      `UPDATE mkt_campaigns SET status = 'active', updated_at = NOW(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [campaign.id, userId]
    );

    req.audit?.write({ action: 'marketing.campaign.send', resource_type: 'mkt_campaign', resource_id: campaign.id, result: 'success' }).catch(() => {});
    res.json({
      data: updated.rows[0],
      dispatched: wa.isEnabled(),
      recipients: phones.length,
      sent: result.sent,
      failed: result.failed,
      provider: result.provider,
      send_id: send.rows[0].id,
      message: wa.isEnabled() ? 'Broadcast dispatched.' : 'Demo mode — recipients resolved but no WhatsApp provider configured.',
    });
  } catch (err) { next(err); }
});

// ── GET /campaigns/:id/performance — stub (Phase 3 attribution) ────────────────
router.get('/campaigns/:id/performance', ...authChain, requirePermission(P.MKT_CAMPAIGN_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT id FROM mkt_campaigns WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ data: { campaign_id: req.params.id, sends: 0, clicks: 0, bookings: 0, revenue: 0, conversion_rate: 0, roi: 0 } });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Content Calendar
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /calendar ─────────────────────────────────────────────────────────────
router.get('/calendar', ...authChain, requirePermission(P.MKT_CALENDAR_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'clinic_id = $1 AND deleted_at IS NULL';
    if (req.query.from) { params.push(req.query.from); where += ` AND scheduled_for >= $${params.length}`; }
    if (req.query.to)   { params.push(req.query.to);   where += ` AND scheduled_for <= $${params.length}`; }
    if (req.query.channel) { params.push(req.query.channel); where += ` AND channel = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM mkt_content_calendar WHERE ${where} ORDER BY scheduled_for NULLS LAST, created_at DESC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /calendar ────────────────────────────────────────────────────────────
router.post('/calendar', ...authChain, requirePermission(P.MKT_CALENDAR_CREATE), validate(calendarSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO mkt_content_calendar
         (org_id, clinic_id, campaign_id, channel, title, caption, media_url,
          scheduled_for, status, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [orgId, clinicId, b.campaign_id ?? null, b.channel, b.title, b.caption ?? null,
       b.media_url ?? null, b.scheduled_for ?? null, b.status, b.owner_id ?? userId, userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /calendar/:id ─────────────────────────────────────────────────────────
router.put('/calendar/:id', ...authChain, requirePermission(P.MKT_CALENDAR_EDIT), validate(calendarUpdateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { sets, params } = buildUpdate(req.body, CALENDAR_COLS, 2);
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.context.userId);
    sets.push(`updated_by = $${2 + params.length - 1}`);
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_content_calendar SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $${2 + params.length} AND deleted_at IS NULL
        RETURNING *`,
      [req.params.id, ...params, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Calendar entry not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /calendar/:id/status — drag-drop status change ──────────────────────
router.patch('/calendar/:id/status', ...authChain, requirePermission(P.MKT_CALENDAR_EDIT), validate(statusPatchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `UPDATE mkt_content_calendar SET status = $3, updated_at = NOW(), updated_by = $4
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL
        RETURNING *`,
      [req.params.id, clinicId, req.body.status, req.context.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Calendar entry not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /calendar/:id — soft delete ────────────────────────────────────────
router.delete('/calendar/:id', ...authChain, requirePermission(P.MKT_CALENDAR_DELETE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      `UPDATE mkt_content_calendar SET deleted_at = NOW(), updated_by = $3
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId, req.context.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Calendar entry not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Dashboard (skeleton — tiles fleshed out as later phases land)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /dashboard ────────────────────────────────────────────────────────────
router.get('/dashboard', ...authChain, requirePermission(P.MKT_CAMPAIGN_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const [campaigns, calendar, pipeline, callbacks, schedCalls, waReach] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active')                       AS active_campaign_count,
           COALESCE(SUM(budget_paise) FILTER (WHERE status = 'active'), 0) AS active_budget_paise
         FROM mkt_campaigns WHERE clinic_id = $1 AND deleted_at IS NULL`,
        [clinicId]
      ),
      db.query(
        `SELECT COUNT(*) AS scheduled_posts
           FROM mkt_content_calendar
          WHERE clinic_id = $1 AND deleted_at IS NULL AND status = 'scheduled'`,
        [clinicId]
      ),
      db.query(
        `SELECT COUNT(*) AS pipeline_count
           FROM mkt_pipeline_leads
          WHERE clinic_id = $1 AND deleted_at IS NULL
            AND stage NOT IN ('onboarded', 'lost')`,
        [clinicId]
      ),
      db.query(
        `SELECT COUNT(*) AS pending_callbacks
           FROM mkt_callbacks
          WHERE clinic_id = $1 AND status = 'pending'`,
        [clinicId]
      ),
      db.query(
        `SELECT COUNT(*) AS scheduled_calls_today
           FROM mkt_scheduled_calls
          WHERE clinic_id = $1 AND status = 'upcoming'
            AND scheduled_for::date = CURRENT_DATE`,
        [clinicId]
      ),
      db.query(
        `SELECT COALESCE(sent_count, 0) AS wa_reach
           FROM mkt_campaign_sends
          WHERE clinic_id = $1 ORDER BY sent_at DESC LIMIT 1`,
        [clinicId]
      ),
    ]);
    res.json({
      data: {
        mrr: 0,
        marketing_spend_mtd_paise: 0,
        pipeline_count: Number(pipeline.rows[0].pipeline_count),
        active_campaign_count: Number(campaigns.rows[0].active_campaign_count),
        active_budget_paise:   Number(campaigns.rows[0].active_budget_paise),
        scheduled_posts:       Number(calendar.rows[0].scheduled_posts),
        pending_callbacks:     Number(callbacks.rows[0].pending_callbacks),
        scheduled_calls_today: Number(schedCalls.rows[0].scheduled_calls_today),
        wa_reach_last_broadcast: Number(waReach.rows[0]?.wa_reach || 0),
        team_today: [],
        campaign_conversions: [],
      },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Pipeline leads (minimal surface — full kanban + onboarding arrive in Phase 9)
// ══════════════════════════════════════════════════════════════════════════════

const LEAD_STAGES = ['new', 'marketing_qualified', 'routed_to_caller', 'called',
  'demo_scheduled', 'trial', 'onboarded', 'lost'];
const LEAD_SOURCES = ['manual', 'digital', 'referral'];
const FINAL_DISPOSITIONS = ['accepted', 'rejected', 'pending'];
const DISPOSITIONS = ['interested', 'price_concern', 'data_privacy', 'timing',
  'competitor', 'features', 'trust', 'no_decision_maker', 'other'];
const REJECTION_REASONS = DISPOSITIONS.filter((d) => d !== 'interested');
const SENTIMENTS = ['positive', 'neutral', 'negative'];

const leadCreateSchema = Joi.object({
  clinic_name:        Joi.string().max(160).required(),
  contact_name:       Joi.string().max(120).allow('', null).optional(),
  contact_phone:      Joi.string().max(20).allow('', null).optional(),
  contact_email:      Joi.string().max(160).allow('', null).optional(),
  city:               Joi.string().max(80).allow('', null).optional(),
  stage:              Joi.string().valid(...LEAD_STAGES).default('new'),
  source:             Joi.string().valid(...LEAD_SOURCES).default('manual'),
  utm_campaign:       Joi.string().max(120).allow('', null).optional(),
  utm_source:         Joi.string().max(80).allow('', null).optional(),
  utm_medium:         Joi.string().max(80).allow('', null).optional(),
  notes:              Joi.string().allow('', null).optional(),
  next_followup:      Joi.date().iso().allow(null).optional(),
  owner_id:           Joi.string().uuid().allow(null).optional(),
  assigned_caller_id: Joi.string().uuid().allow(null).optional(),
});
const leadUpdateSchema = leadCreateSchema.fork(['clinic_name'], (f) => f.optional()).keys({
  final_disposition: Joi.string().valid(...FINAL_DISPOSITIONS).allow(null).optional(),
});
const leadStagePatchSchema = Joi.object({ stage: Joi.string().valid(...LEAD_STAGES).required() });

const LEAD_COLS = ['clinic_name', 'contact_name', 'contact_phone', 'contact_email', 'city',
  'stage', 'source', 'utm_campaign', 'utm_source', 'utm_medium', 'notes', 'next_followup',
  'owner_id', 'assigned_caller_id', 'final_disposition'];

// Resolve a lead in the active clinic; writes 404 and returns null if missing.
async function leadInClinic(req, res, leadId) {
  const { rows } = await db.query(
    `SELECT * FROM mkt_pipeline_leads WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
    [leadId, req.context.clinicId]
  );
  if (!rows.length) { res.status(404).json({ error: 'Lead not found' }); return null; }
  return rows[0];
}

// ── GET /pipeline ─────────────────────────────────────────────────────────────
router.get('/pipeline', ...authChain, requirePermission(P.MKT_PIPELINE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'clinic_id = $1 AND deleted_at IS NULL';
    if (req.query.stage)           { params.push(req.query.stage);           where += ` AND stage = $${params.length}`; }
    if (req.query.source)          { params.push(req.query.source);          where += ` AND source = $${params.length}`; }
    if (req.query.assigned_caller) { params.push(req.query.assigned_caller); where += ` AND assigned_caller_id = $${params.length}`; }
    if (req.query.disposition)     { params.push(req.query.disposition);     where += ` AND final_disposition = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM mkt_pipeline_leads WHERE ${where} ORDER BY created_at DESC`, params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /pipeline ────────────────────────────────────────────────────────────
router.post('/pipeline', ...authChain, requirePermission(P.MKT_PIPELINE_EDIT), validate(leadCreateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO mkt_pipeline_leads
         (org_id, clinic_id, clinic_name, contact_name, contact_phone, contact_email, city,
          stage, source, utm_campaign, utm_source, utm_medium, notes, next_followup,
          owner_id, assigned_caller_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [orgId, clinicId, b.clinic_name, b.contact_name ?? null, b.contact_phone ?? null,
       b.contact_email ?? null, b.city ?? null, b.stage, b.source, b.utm_campaign ?? null,
       b.utm_source ?? null, b.utm_medium ?? null, b.notes ?? null, b.next_followup ?? null,
       b.owner_id ?? userId, b.assigned_caller_id ?? null, userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /pipeline/:id ─────────────────────────────────────────────────────────
router.get('/pipeline/:id', ...authChain, requirePermission(P.MKT_PIPELINE_VIEW), async (req, res, next) => {
  if (!clinicOf(req, res)) return;
  try {
    const lead = await leadInClinic(req, res, req.params.id);
    if (lead) res.json({ data: lead });
  } catch (err) { next(err); }
});

// ── PUT /pipeline/:id ─────────────────────────────────────────────────────────
router.put('/pipeline/:id', ...authChain, requirePermission(P.MKT_PIPELINE_EDIT), validate(leadUpdateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { sets, params } = buildUpdate(req.body, LEAD_COLS, 2);
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.context.userId);
    sets.push(`updated_by = $${2 + params.length - 1}`);
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_pipeline_leads SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $${2 + params.length} AND deleted_at IS NULL
        RETURNING *`,
      [req.params.id, ...params, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /pipeline/:id/stage — kanban drag ───────────────────────────────────
router.patch('/pipeline/:id/stage', ...authChain, requirePermission(P.MKT_PIPELINE_EDIT), validate(leadStagePatchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `UPDATE mkt_pipeline_leads SET stage = $3, updated_at = NOW(), updated_by = $4
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL RETURNING *`,
      [req.params.id, clinicId, req.body.stage, req.context.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Feedback (Phase 2)
// ══════════════════════════════════════════════════════════════════════════════

const leadFeedbackSchema = Joi.object({
  feedback_text:    Joi.string().max(4000).required(),
  disposition:      Joi.string().valid(...DISPOSITIONS).required(),
  rejection_reason: Joi.string().valid(...REJECTION_REASONS).allow(null).optional(),
  rejection_notes:  Joi.string().allow('', null).optional(),
});
const callerFeedbackSchema = Joi.object({
  call_log_id:      Joi.string().uuid().allow(null).optional(),
  sentiment:        Joi.string().valid(...SENTIMENTS).required(),
  feedback_text:    Joi.string().max(4000).required(),
  key_objection:    Joi.string().valid(...REJECTION_REASONS).allow(null).optional(),
  follow_up_needed: Joi.boolean().default(false),
});

// ── GET /leads/:id/feedback ───────────────────────────────────────────────────
router.get('/leads/:id/feedback', ...authChain, requirePermission(P.MKT_FEEDBACK_VIEW), async (req, res, next) => {
  if (!clinicOf(req, res)) return;
  try {
    if (!await leadInClinic(req, res, req.params.id)) return;
    const { rows } = await db.query(
      `SELECT f.*, u.first_name, u.last_name
         FROM mkt_lead_feedback f
         LEFT JOIN users u ON u.id = f.author_id
        WHERE f.lead_id = $1 ORDER BY f.created_at DESC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /leads/:id/feedback ──────────────────────────────────────────────────
router.post('/leads/:id/feedback', ...authChain, requirePermission(P.MKT_FEEDBACK_CREATE), validate(leadFeedbackSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const lead = await leadInClinic(req, res, req.params.id);
    if (!lead) return;
    const { orgId, userId } = req.context;
    const b = req.body;
    // A rejection disposition implies a rejection reason (mirrors disposition when omitted).
    const reason = b.disposition === 'interested' ? null : (b.rejection_reason ?? b.disposition);
    const { rows } = await db.query(
      `INSERT INTO mkt_lead_feedback
         (org_id, clinic_id, lead_id, author_id, feedback_text, disposition, rejection_reason, rejection_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, clinicId, req.params.id, userId, b.feedback_text, b.disposition, reason, b.rejection_notes ?? null]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /leads/:id/caller-feedback ────────────────────────────────────────────
router.get('/leads/:id/caller-feedback', ...authChain, requirePermission(P.MKT_CALLER_FEEDBACK_VIEW), async (req, res, next) => {
  if (!clinicOf(req, res)) return;
  try {
    if (!await leadInClinic(req, res, req.params.id)) return;
    const { rows } = await db.query(
      `SELECT f.*, u.first_name, u.last_name
         FROM mkt_caller_feedback f
         LEFT JOIN users u ON u.id = f.caller_id
        WHERE f.lead_id = $1 ORDER BY f.created_at DESC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /leads/:id/caller-feedback ───────────────────────────────────────────
// Gated on calloutcome.create — the caller's "produce output" capability.
router.post('/leads/:id/caller-feedback', ...authChain, requirePermission(P.MKT_CALLOUTCOME_CREATE), validate(callerFeedbackSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    if (!await leadInClinic(req, res, req.params.id)) return;
    const { orgId, userId } = req.context;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO mkt_caller_feedback
         (org_id, clinic_id, lead_id, call_log_id, caller_id, sentiment, feedback_text, key_objection, follow_up_needed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [orgId, clinicId, req.params.id, b.call_log_id ?? null, userId, b.sentiment,
       b.feedback_text, b.key_objection ?? null, b.follow_up_needed]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /acceptance-ratio ─────────────────────────────────────────────────────
// PRD §5.4: accepted / (leads with a recorded disposition) * 100, plus rejection
// breakdown from mkt_lead_feedback.rejection_reason. Filters: author_id, from, to.
router.get('/acceptance-ratio', ...authChain, requirePermission(P.MKT_ACCEPTANCE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { author_id, from, to } = req.query;

    const leadParams = [clinicId];
    let leadWhere = 'clinic_id = $1 AND deleted_at IS NULL AND final_disposition IS NOT NULL';
    if (author_id) { leadParams.push(author_id); leadWhere += ` AND owner_id = $${leadParams.length}`; }
    if (from)      { leadParams.push(from);      leadWhere += ` AND created_at >= $${leadParams.length}`; }
    if (to)        { leadParams.push(to);        leadWhere += ` AND created_at <= $${leadParams.length}`; }

    const counts = await db.query(
      `SELECT
         COUNT(*)                                          AS total,
         COUNT(*) FILTER (WHERE final_disposition='accepted') AS accepted,
         COUNT(*) FILTER (WHERE final_disposition='rejected') AS rejected,
         COUNT(*) FILTER (WHERE final_disposition='pending')  AS pending
       FROM mkt_pipeline_leads WHERE ${leadWhere}`,
      leadParams
    );

    const fbParams = [clinicId];
    let fbWhere = 'clinic_id = $1 AND rejection_reason IS NOT NULL';
    if (author_id) { fbParams.push(author_id); fbWhere += ` AND author_id = $${fbParams.length}`; }
    if (from)      { fbParams.push(from);      fbWhere += ` AND created_at >= $${fbParams.length}`; }
    if (to)        { fbParams.push(to);        fbWhere += ` AND created_at <= $${fbParams.length}`; }
    const breakdown = await db.query(
      `SELECT rejection_reason AS reason, COUNT(*)::int AS count
         FROM mkt_lead_feedback WHERE ${fbWhere}
        GROUP BY rejection_reason ORDER BY count DESC`,
      fbParams
    );

    const c = counts.rows[0];
    const total = Number(c.total);
    const accepted = Number(c.accepted);
    res.json({
      data: {
        total,
        accepted,
        rejected: Number(c.rejected),
        pending:  Number(c.pending),
        ratio:    total ? Math.round((accepted / total) * 1000) / 10 : 0,
        breakdown_by_reason: breakdown.rows,
      },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Caller workflow (Phase 3)
// ══════════════════════════════════════════════════════════════════════════════

const CALL_OUTCOMES = ['reached_interested', 'reached_not_interested', 'reached_callback',
  'not_reached_busy', 'not_reached_no_answer', 'not_reached_switched_off'];
// Lead stage transition triggered by a call outcome (PRD §5.1).
const OUTCOME_STAGE = {
  reached_interested:      'demo_scheduled',
  reached_not_interested:  'lost',
  reached_callback:        'called',
  not_reached_busy:        'called',
  not_reached_no_answer:   'called',
  not_reached_switched_off:'called',
};

// Max not-reached attempts before a lead auto-closes (PRD §5.1 / §14 Q4).
const MAX_CALL_ATTEMPTS = 3;
// How far out a not-reached retry is auto-scheduled.
const RETRY_DELAY_HOURS = 24;

const callLogSchema = Joi.object({
  lead_id:               Joi.string().uuid().required(),
  outcome:               Joi.string().valid(...CALL_OUTCOMES).required(),
  notes:                 Joi.string().allow('', null).optional(),
  duration_secs:         Joi.number().integer().min(0).allow(null).optional(),
  // Required when outcome = 'reached_callback' — the date/time the prospect asked for.
  callback_scheduled_for: Joi.when('outcome', {
    is: 'reached_callback',
    then: Joi.date().iso().required(),
    otherwise: Joi.date().iso().allow(null).optional(),
  }),
  callback_notes:        Joi.string().allow('', null).optional(),
});
const assignCallerSchema = Joi.object({ caller_id: Joi.string().uuid().required() });
const activeCheckSchema = Joi.object({
  phone:       Joi.string().max(20).allow('', null).optional(),
  email:       Joi.string().max(160).allow('', null).optional(),
  clinic_name: Joi.string().max(160).allow('', null).optional(),
}).or('phone', 'email', 'clinic_name');

// Active-clinic guard: is this prospect already an active subscriber anywhere on
// the platform? Matches against existing clinics by name/phone/email (PRD §7.8).
async function checkActiveSubscriber({ clinic_name, phone, email }) {
  const { rows } = await db.query(
    `SELECT c.id, c.activated_at AS subscriber_since, sp.display_name AS plan
       FROM clinics c
       LEFT JOIN subscription s      ON s.tenant_id = c.id AND s.status = 'ACTIVE'
       LEFT JOIN subscription_plan sp ON sp.id = s.plan_id
      WHERE c.tenant_status = 'ACTIVE'
        AND ( ($1::text IS NOT NULL AND c.name ILIKE $1)
           OR ($2::text IS NOT NULL AND c.phone = $2)
           OR ($3::text IS NOT NULL AND c.email = $3) )
      LIMIT 1`,
    [clinic_name || null, phone || null, email || null]
  );
  if (!rows.length) return { is_active: false };
  return { is_active: true, subscriber_since: rows[0].subscriber_since, plan: rows[0].plan };
}

// ── POST /internal/check-active-subscriber ────────────────────────────────────
router.post('/internal/check-active-subscriber', ...authChain, requirePermission(P.MKT_PIPELINE_VIEW), validate(activeCheckSchema), async (req, res, next) => {
  if (!clinicOf(req, res)) return;
  try {
    res.json({ data: await checkActiveSubscriber(req.body) });
  } catch (err) { next(err); }
});

// ── GET /callers — clinic users holding the marketing_caller role ─────────────
router.get('/callers', ...authChain, requirePermission(P.MKT_PIPELINE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT u.id, u.first_name, u.last_name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id AND ur.clinic_id = $1
           AND (ur.valid_to IS NULL OR ur.valid_to > now()) AND ur.valid_from <= now()
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'marketing_caller' AND u.is_active = true
        ORDER BY u.first_name, u.last_name`,
      [clinicId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── PATCH /pipeline/:id/assign-caller — guarded routing to a caller ───────────
router.patch('/pipeline/:id/assign-caller', ...authChain, requirePermission(P.MKT_PIPELINE_EDIT), validate(assignCallerSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const lead = await leadInClinic(req, res, req.params.id);
    if (!lead) return;

    // Active clinic guard — block routing a clinic already actively subscribed.
    const guard = await checkActiveSubscriber({
      clinic_name: lead.clinic_name, phone: lead.contact_phone, email: lead.contact_email,
    });
    if (guard.is_active) {
      await db.query(
        `UPDATE mkt_pipeline_leads
            SET is_active_subscriber = true, subscriber_checked_at = NOW(), updated_at = NOW(), updated_by = $2
          WHERE id = $1`,
        [lead.id, req.context.userId]
      );
      return res.status(409).json({ error: 'ALREADY_ACTIVE', message: 'This clinic is already an active subscriber.', guard });
    }

    const { rows } = await db.query(
      `UPDATE mkt_pipeline_leads
          SET assigned_caller_id = $3, stage = 'routed_to_caller',
              is_active_subscriber = false, subscriber_checked_at = NOW(),
              updated_at = NOW(), updated_by = $4
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL
        RETURNING *`,
      [lead.id, clinicId, req.body.caller_id, req.context.userId]
    );
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /caller-queue — current caller's open leads (guard-filtered) ──────────
function callerQueueQuery(extraWhere, params) {
  return `SELECT l.*,
            (SELECT cl.outcome FROM mkt_call_logs cl WHERE cl.lead_id = l.id ORDER BY cl.called_at DESC LIMIT 1) AS last_call_outcome,
            (SELECT COUNT(*) FROM mkt_call_logs cl WHERE cl.lead_id = l.id)::int                                 AS call_attempt_count,
            (SELECT MIN(cb.scheduled_for) FROM mkt_callbacks cb WHERE cb.lead_id = l.id AND cb.status = 'pending') AS next_callback_at
          FROM mkt_pipeline_leads l
         WHERE l.clinic_id = $1 AND l.deleted_at IS NULL
           AND l.is_active_subscriber = false
           AND l.stage NOT IN ('lost','onboarded')
           ${extraWhere}
         ORDER BY next_callback_at NULLS LAST, l.next_followup NULLS LAST, l.created_at`;
}

router.get('/caller-queue', ...authChain, requirePermission(P.MKT_CALLQUEUE_VIEW_OWN), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(callerQueueQuery('AND l.assigned_caller_id = $2', null), [clinicId, req.context.userId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /caller-queue/all — marketing lead view of every caller's queue ───────
router.get('/caller-queue/all', ...authChain, requirePermission(P.MKT_CALLQUEUE_VIEW_ALL), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(callerQueueQuery('AND l.assigned_caller_id IS NOT NULL', null), [clinicId]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /call-logs — log a call outcome (advances lead stage) ────────────────
router.post('/call-logs', ...authChain, requirePermission(P.MKT_CALLOUTCOME_CREATE), validate(callLogSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const lead = await leadInClinic(req, res, req.body.lead_id);
    if (!lead) return;
    const { orgId, userId } = req.context;
    const b = req.body;

    const attemptRes = await db.query(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM mkt_call_logs WHERE lead_id = $1`,
      [b.lead_id]
    );
    const attempt = attemptRes.rows[0].n;

    const { rows } = await db.query(
      `INSERT INTO mkt_call_logs
         (org_id, clinic_id, lead_id, caller_id, duration_secs, outcome, notes, attempt_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, clinicId, b.lead_id, userId, b.duration_secs ?? null, b.outcome, b.notes ?? null, attempt]
    );
    const callLog = rows[0];

    // Resolve next lead stage + any callback side effect (PRD §5.1).
    let nextStage = OUTCOME_STAGE[b.outcome];
    let callback = null;
    const isNotReached = b.outcome.startsWith('not_reached');

    if (b.outcome === 'reached_callback') {
      // Prospect asked to be called later — schedule it.
      callback = (await db.query(
        `INSERT INTO mkt_callbacks (org_id, clinic_id, lead_id, call_log_id, caller_id, scheduled_for, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [orgId, clinicId, b.lead_id, callLog.id, userId, b.callback_scheduled_for, b.callback_notes ?? null]
      )).rows[0];
    } else if (isNotReached) {
      if (attempt >= MAX_CALL_ATTEMPTS) {
        // Exhausted retries — auto-close the lead.
        nextStage = 'lost';
      } else {
        // Auto-schedule the next attempt.
        callback = (await db.query(
          `INSERT INTO mkt_callbacks (org_id, clinic_id, lead_id, call_log_id, caller_id, scheduled_for, notes)
           VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' hours')::interval, $7) RETURNING *`,
          [orgId, clinicId, b.lead_id, callLog.id, userId, String(RETRY_DELAY_HOURS),
           `Auto-scheduled retry (attempt ${attempt + 1} of ${MAX_CALL_ATTEMPTS})`]
        )).rows[0];
      }
    }

    const leadRes = await db.query(
      `UPDATE mkt_pipeline_leads SET stage = $3, updated_at = NOW(), updated_by = $4
        WHERE id = $1 AND clinic_id = $2 RETURNING *`,
      [b.lead_id, clinicId, nextStage, userId]
    );

    res.status(201).json({ data: callLog, lead: leadRes.rows[0], callback });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Callbacks (Phase 4)
// ══════════════════════════════════════════════════════════════════════════════

const callbackCreateSchema = Joi.object({
  lead_id:       Joi.string().uuid().required(),
  call_log_id:   Joi.string().uuid().allow(null).optional(),
  scheduled_for: Joi.date().iso().required(),
  notes:         Joi.string().allow('', null).optional(),
});
const callbackPatchSchema = Joi.object({
  status:        Joi.string().valid('pending', 'called', 'rescheduled', 'cancelled').optional(),
  scheduled_for: Joi.date().iso().optional(),
  notes:         Joi.string().allow('', null).optional(),
}).or('status', 'scheduled_for', 'notes');

// ── POST /callbacks — schedule a callback ─────────────────────────────────────
router.post('/callbacks', ...authChain, requirePermission(P.MKT_CALLBACK_SCHEDULE), validate(callbackCreateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    if (!await leadInClinic(req, res, req.body.lead_id)) return;
    const { orgId, userId } = req.context;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO mkt_callbacks (org_id, clinic_id, lead_id, call_log_id, caller_id, scheduled_for, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, clinicId, b.lead_id, b.call_log_id ?? null, userId, b.scheduled_for, b.notes ?? null]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /callbacks — due callbacks for the caller queue ───────────────────────
// Defaults to the current user's callbacks; a lead can pass ?caller_id= to scope.
router.get('/callbacks', ...authChain, requirePermission(P.MKT_CALLQUEUE_VIEW_OWN), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId, req.query.caller_id || req.context.userId];
    let where = 'cb.clinic_id = $1 AND cb.caller_id = $2';
    if (req.query.status) { params.push(req.query.status); where += ` AND cb.status = $${params.length}`; }
    if (req.query.from)   { params.push(req.query.from);   where += ` AND cb.scheduled_for >= $${params.length}`; }
    if (req.query.to)     { params.push(req.query.to);     where += ` AND cb.scheduled_for <= $${params.length}`; }
    const { rows } = await db.query(
      `SELECT cb.*, l.clinic_name, l.contact_name, l.contact_phone
         FROM mkt_callbacks cb
         JOIN mkt_pipeline_leads l ON l.id = cb.lead_id
        WHERE ${where} ORDER BY cb.scheduled_for ASC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── PATCH /callbacks/:id — mark called / reschedule / cancel ──────────────────
router.patch('/callbacks/:id', ...authChain, requirePermission(P.MKT_CALLBACK_SCHEDULE), validate(callbackPatchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const sets = [];
    const params = [req.params.id, clinicId];
    for (const col of ['status', 'scheduled_for', 'notes']) {
      if (req.body[col] !== undefined) { params.push(req.body[col]); sets.push(`${col} = $${params.length}`); }
    }
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_callbacks SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Callback not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /call-logs — filterable list (caller defaults to self) ────────────────
router.get('/call-logs', ...authChain, requirePermission(P.MKT_CALLQUEUE_VIEW_OWN), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'cl.clinic_id = $1';
    if (req.query.lead_id)   { params.push(req.query.lead_id);   where += ` AND cl.lead_id = $${params.length}`; }
    if (req.query.caller_id) { params.push(req.query.caller_id); where += ` AND cl.caller_id = $${params.length}`; }
    if (req.query.from)      { params.push(req.query.from);      where += ` AND cl.called_at >= $${params.length}`; }
    if (req.query.to)        { params.push(req.query.to);        where += ` AND cl.called_at <= $${params.length}`; }
    const { rows } = await db.query(
      `SELECT cl.*, u.first_name, u.last_name
         FROM mkt_call_logs cl
         LEFT JOIN users u ON u.id = cl.caller_id
        WHERE ${where} ORDER BY cl.called_at DESC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /call-logs/:id ────────────────────────────────────────────────────────
router.get('/call-logs/:id', ...authChain, requirePermission(P.MKT_CALLQUEUE_VIEW_OWN), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT cl.*, u.first_name, u.last_name
         FROM mkt_call_logs cl LEFT JOIN users u ON u.id = cl.caller_id
        WHERE cl.id = $1 AND cl.clinic_id = $2`,
      [req.params.id, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Call log not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Digital enquiries (Phase 5)
// ══════════════════════════════════════════════════════════════════════════════

const enquiryIngestSchema = Joi.object({
  api_key:       Joi.string().max(120).optional(),  // may also arrive via X-Api-Key header
  source:        Joi.string().valid('website', 'referral', 'social').required(),
  utm_campaign:  Joi.string().max(120).allow('', null).optional(),
  utm_source:    Joi.string().max(80).allow('', null).optional(),
  utm_medium:    Joi.string().max(80).allow('', null).optional(),
  clinic_name:   Joi.string().max(160).required(),
  contact_name:  Joi.string().max(120).allow('', null).optional(),
  contact_phone: Joi.string().max(20).allow('', null).optional(),
  contact_email: Joi.string().max(160).allow('', null).optional(),
  message:       Joi.string().allow('', null).optional(),
});
const enquiryConvertSchema = Joi.object({ lead_id: Joi.string().uuid().optional() });
const enquiryPatchSchema   = Joi.object({ is_duplicate: Joi.boolean().required() });

// Resolve the per-clinic ingest API key → tenant context (public webhook auth).
async function ingestAuth(req, res, next) {
  const key = req.get('X-Api-Key') || req.body?.api_key;
  if (!key) return res.status(401).json({ error: 'Missing API key' });
  try {
    const { rows } = await db.query(
      'SELECT org_id, clinic_id FROM mkt_ingest_keys WHERE api_key = $1 AND active = true',
      [key]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid API key' });
    req.context = { orgId: rows[0].org_id, clinicId: rows[0].clinic_id, userId: null, actorType: 'ingest' };
    next();
  } catch (err) { next(err); }
}

// Map an enquiry source to the pipeline lead source taxonomy.
function enquiryLeadSource(source) {
  return source === 'referral' ? 'referral' : 'digital';
}

// ── POST /enquiries/ingest — public webhook (API-key auth, no JWT) ────────────
router.post('/enquiries/ingest', ingestAuth, validate(enquiryIngestSchema), async (req, res, next) => {
  try {
    const { orgId, clinicId } = req.context;
    const b = req.body;

    // Active clinic guard — skip lead creation if already an active subscriber.
    const guard = await checkActiveSubscriber({
      clinic_name: b.clinic_name, phone: b.contact_phone, email: b.contact_email,
    });
    const isDuplicate = guard.is_active;

    let leadId = null;
    if (!isDuplicate) {
      const lead = await db.query(
        `INSERT INTO mkt_pipeline_leads
           (org_id, clinic_id, clinic_name, contact_name, contact_phone, contact_email,
            stage, source, utm_campaign, utm_source, utm_medium, notes)
         VALUES ($1,$2,$3,$4,$5,$6,'new',$7,$8,$9,$10,$11) RETURNING id`,
        [orgId, clinicId, b.clinic_name, b.contact_name ?? null, b.contact_phone ?? null,
         b.contact_email ?? null, enquiryLeadSource(b.source), b.utm_campaign ?? null,
         b.utm_source ?? null, b.utm_medium ?? null, b.message ?? null]
      );
      leadId = lead.rows[0].id;
    }

    const { rows } = await db.query(
      `INSERT INTO mkt_digital_enquiries
         (org_id, clinic_id, source, utm_campaign, utm_source, utm_medium,
          clinic_name, contact_name, contact_phone, contact_email, message, lead_id, is_duplicate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [orgId, clinicId, b.source, b.utm_campaign ?? null, b.utm_source ?? null, b.utm_medium ?? null,
       b.clinic_name, b.contact_name ?? null, b.contact_phone ?? null, b.contact_email ?? null,
       b.message ?? null, leadId, isDuplicate]
    );
    // TODO Phase 5+: notify the marketing lead (in-app badge already covers it; WA is PRD §14 Q5).
    res.status(201).json({ data: rows[0], duplicate: isDuplicate });
  } catch (err) { next(err); }
});

// ── GET /enquiries/key — fetch (or lazily create) this clinic's ingest key ────
router.get('/enquiries/key', ...authChain, requirePermission(P.MKT_ENQUIRY_EDIT), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    let { rows } = await db.query(
      'SELECT * FROM mkt_ingest_keys WHERE clinic_id = $1 AND active = true', [clinicId]
    );
    if (!rows.length) {
      const apiKey = 'mkt_' + crypto.randomBytes(24).toString('hex');
      rows = (await db.query(
        `INSERT INTO mkt_ingest_keys (org_id, clinic_id, api_key, label, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orgId, clinicId, apiKey, 'Website form', userId]
      )).rows;
    }
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /enquiries/key/rotate — issue a fresh key (revokes the old) ──────────
router.post('/enquiries/key/rotate', ...authChain, requirePermission(P.MKT_ENQUIRY_EDIT), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    await db.query('UPDATE mkt_ingest_keys SET active = false WHERE clinic_id = $1 AND active = true', [clinicId]);
    const apiKey = 'mkt_' + crypto.randomBytes(24).toString('hex');
    const { rows } = await db.query(
      `INSERT INTO mkt_ingest_keys (org_id, clinic_id, api_key, label, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orgId, clinicId, apiKey, 'Website form', userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /enquiries — list ─────────────────────────────────────────────────────
router.get('/enquiries', ...authChain, requirePermission(P.MKT_ENQUIRY_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'clinic_id = $1';
    if (req.query.source)       { params.push(req.query.source); where += ` AND source = $${params.length}`; }
    if (req.query.from)         { params.push(req.query.from);   where += ` AND received_at >= $${params.length}`; }
    if (req.query.to)           { params.push(req.query.to);     where += ` AND received_at <= $${params.length}`; }
    if (req.query.is_duplicate !== undefined) {
      params.push(req.query.is_duplicate === 'true'); where += ` AND is_duplicate = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT * FROM mkt_digital_enquiries WHERE ${where} ORDER BY received_at DESC`, params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /enquiries/:id ────────────────────────────────────────────────────────
router.get('/enquiries/:id', ...authChain, requirePermission(P.MKT_ENQUIRY_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      'SELECT * FROM mkt_digital_enquiries WHERE id = $1 AND clinic_id = $2', [req.params.id, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /enquiries/:id/convert — link to (or create) a pipeline lead ────────
router.patch('/enquiries/:id/convert', ...authChain, requirePermission(P.MKT_ENQUIRY_EDIT), validate(enquiryConvertSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const enqRes = await db.query(
      'SELECT * FROM mkt_digital_enquiries WHERE id = $1 AND clinic_id = $2', [req.params.id, clinicId]
    );
    if (!enqRes.rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    const enq = enqRes.rows[0];

    let leadId = req.body.lead_id || enq.lead_id;
    let lead = null;
    if (leadId) {
      const l = await db.query('SELECT * FROM mkt_pipeline_leads WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL', [leadId, clinicId]);
      if (!l.rows.length) return res.status(404).json({ error: 'Lead not found' });
      lead = l.rows[0];
    } else {
      // Create a fresh lead from the enquiry.
      lead = (await db.query(
        `INSERT INTO mkt_pipeline_leads
           (org_id, clinic_id, clinic_name, contact_name, contact_phone, contact_email,
            stage, source, utm_campaign, utm_source, utm_medium, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'new',$7,$8,$9,$10,$11,$12) RETURNING *`,
        [orgId, clinicId, enq.clinic_name || 'Enquiry', enq.contact_name, enq.contact_phone,
         enq.contact_email, enquiryLeadSource(enq.source), enq.utm_campaign, enq.utm_source,
         enq.utm_medium, enq.message, userId]
      )).rows[0];
      leadId = lead.id;
    }

    const { rows } = await db.query(
      'UPDATE mkt_digital_enquiries SET lead_id = $1, is_duplicate = false WHERE id = $2 RETURNING *',
      [leadId, req.params.id]
    );
    res.json({ data: rows[0], lead });
  } catch (err) { next(err); }
});

// ── PATCH /enquiries/:id — flag / unflag duplicate ────────────────────────────
router.patch('/enquiries/:id', ...authChain, requirePermission(P.MKT_ENQUIRY_EDIT), validate(enquiryPatchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      'UPDATE mkt_digital_enquiries SET is_duplicate = $3 WHERE id = $1 AND clinic_id = $2 RETURNING *',
      [req.params.id, clinicId, req.body.is_duplicate]
    );
    if (!rows.length) return res.status(404).json({ error: 'Enquiry not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Scheduled calls / calendar sync (Phase 6)
// ══════════════════════════════════════════════════════════════════════════════

const scheduledCallSchema = Joi.object({
  lead_id:          Joi.string().uuid().allow(null).optional(),
  assigned_to_id:   Joi.string().uuid().allow(null).optional(),
  contact_name:     Joi.string().max(120).allow('', null).optional(),
  contact_phone:    Joi.string().max(20).allow('', null).optional(),
  contact_email:    Joi.string().max(160).allow('', null).optional(),
  clinic_name:      Joi.string().max(160).allow('', null).optional(),
  scheduled_for:    Joi.date().iso().required(),
  duration_minutes: Joi.number().integer().min(5).max(240).default(30),
});
const scheduledCallPatchSchema = Joi.object({
  status:          Joi.string().valid('upcoming', 'completed', 'no_show', 'rescheduled').optional(),
  scheduled_for:   Joi.date().iso().optional(),
  post_call_notes: Joi.string().allow('', null).optional(),
}).or('status', 'scheduled_for', 'post_call_notes');
const slotsGenerateSchema = Joi.object({
  from:                  Joi.date().iso().required(),
  to:                    Joi.date().iso().required(),
  slot_duration_minutes: Joi.number().integer().min(10).max(120).default(30),
  assigned_to_id:        Joi.string().uuid().allow(null).optional(),
  daily_start_hour:      Joi.number().integer().min(0).max(23).default(10),
  daily_end_hour:        Joi.number().integer().min(1).max(24).default(18),
});
const slotBookSchema = Joi.object({
  slot_token:    Joi.string().max(120).required(),
  contact_name:  Joi.string().max(120).required(),
  contact_phone: Joi.string().max(20).allow('', null).optional(),
  contact_email: Joi.string().max(160).allow('', null).optional(),
  clinic_name:   Joi.string().max(160).allow('', null).optional(),
});

// Create the scheduled-call row + (stub) Google Calendar event.
async function createScheduledCall(orgId, clinicId, userId, fields) {
  let event = { eventId: null, meetLink: null, synced: false };
  try {
    event = await gcal.createEvent({
      summary:     `DentaFlow Demo — ${fields.clinic_name || 'Prospect'}`,
      description: `Lead contact: ${fields.contact_name || ''} ${fields.contact_phone || ''}`,
      start:       fields.scheduled_for,
      organizerUserId: fields.assigned_to_id,
    });
  } catch (_) { /* keep sync_status pending on failure */ }

  const { rows } = await db.query(
    `INSERT INTO mkt_scheduled_calls
       (org_id, clinic_id, lead_id, assigned_to_id, contact_name, contact_phone, contact_email,
        clinic_name, scheduled_for, duration_minutes, google_event_id, google_meet_link, sync_status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [orgId, clinicId, fields.lead_id ?? null, fields.assigned_to_id ?? null, fields.contact_name ?? null,
     fields.contact_phone ?? null, fields.contact_email ?? null, fields.clinic_name ?? null,
     fields.scheduled_for, fields.duration_minutes ?? 30, event.eventId, event.meetLink,
     event.synced ? 'synced' : 'pending', userId]
  );
  return rows[0];
}

// ── GET /scheduled-calls/calendar-status — is Google sync live? ───────────────
router.get('/scheduled-calls/calendar-status', ...authChain, requirePermission(P.MKT_SCHEDULED_CALLS_VIEW), async (req, res) => {
  res.json({ data: { enabled: gcal.isEnabled(), connected: gcal.isEnabled() } });
});

// ── GET /scheduled-calls/slots — available (unbooked) slots ───────────────────
router.get('/scheduled-calls/slots', ...authChain, requirePermission(P.MKT_SCHEDULED_CALLS_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'clinic_id = $1 AND is_booked = false AND slot_start >= NOW()';
    if (req.query.from)           { params.push(req.query.from);           where += ` AND slot_start >= $${params.length}`; }
    if (req.query.to)             { params.push(req.query.to);             where += ` AND slot_start <= $${params.length}`; }
    if (req.query.assigned_to_id) { params.push(req.query.assigned_to_id); where += ` AND assigned_to_id = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM mkt_call_slots WHERE ${where} ORDER BY slot_start ASC LIMIT 500`, params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /scheduled-calls/slots/generate — pre-create bookable slots ──────────
router.post('/scheduled-calls/slots/generate', ...authChain, requirePermission(P.MKT_SCHEDULED_CALLS_CREATE), validate(slotsGenerateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const b = req.body;
    const from = new Date(b.from);
    const to   = new Date(b.to);
    if (to <= from) return res.status(400).json({ error: 'to must be after from' });

    const rows = [];
    const dayMs = 24 * 60 * 60 * 1000;
    const stepMs = b.slot_duration_minutes * 60 * 1000;
    // Walk each calendar day in range; within a day, step through the working band.
    for (let day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
         day <= to && rows.length < 2000; day = new Date(day.getTime() + dayMs)) {
      const bandStart = new Date(day); bandStart.setHours(b.daily_start_hour, 0, 0, 0);
      const bandEnd   = new Date(day); bandEnd.setHours(b.daily_end_hour, 0, 0, 0);
      for (let t = bandStart.getTime(); t + stepMs <= bandEnd.getTime() && rows.length < 2000; t += stepMs) {
        const s = new Date(t);
        if (s < from || s > to) continue;
        rows.push({ start: s, end: new Date(t + stepMs) });
      }
    }

    if (!rows.length) return res.json({ data: [], created: 0 });

    const values = [];
    const params = [];
    rows.forEach((r, i) => {
      const base = i * 6;
      params.push(orgId, clinicId, b.assigned_to_id ?? userId, r.start.toISOString(), r.end.toISOString(),
        'slot_' + crypto.randomBytes(12).toString('hex'));
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
    });
    const { rows: created } = await db.query(
      `INSERT INTO mkt_call_slots (org_id, clinic_id, assigned_to_id, slot_start, slot_end, slot_token)
       VALUES ${values.join(',')} RETURNING *`,
      params
    );
    res.status(201).json({ data: created, created: created.length });
  } catch (err) { next(err); }
});

// ── POST /scheduled-calls/book — PUBLIC prospect booking via slot_token ───────
router.post('/scheduled-calls/book', validate(slotBookSchema), async (req, res, next) => {
  try {
    const b = req.body;
    const slotRes = await db.query(
      'SELECT * FROM mkt_call_slots WHERE slot_token = $1 AND is_booked = false', [b.slot_token]
    );
    if (!slotRes.rows.length) return res.status(404).json({ error: 'Slot unavailable' });
    const slot = slotRes.rows[0];

    const call = await createScheduledCall(slot.org_id, slot.clinic_id, null, {
      assigned_to_id: slot.assigned_to_id,
      contact_name:   b.contact_name,
      contact_phone:  b.contact_phone,
      contact_email:  b.contact_email,
      clinic_name:    b.clinic_name,
      scheduled_for:  slot.slot_start,
      duration_minutes: Math.round((new Date(slot.slot_end) - new Date(slot.slot_start)) / 60000),
    });

    await db.query(
      'UPDATE mkt_call_slots SET is_booked = true, scheduled_call_id = $2 WHERE id = $1',
      [slot.id, call.id]
    );
    res.status(201).json({ data: { scheduled_for: call.scheduled_for, meet_link: call.google_meet_link } });
  } catch (err) { next(err); }
});

// ── POST /scheduled-calls — create + sync ─────────────────────────────────────
router.post('/scheduled-calls', ...authChain, requirePermission(P.MKT_SCHEDULED_CALLS_CREATE), validate(scheduledCallSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const call = await createScheduledCall(orgId, clinicId, userId, req.body);
    res.status(201).json({ data: call });
  } catch (err) { next(err); }
});

// ── GET /scheduled-calls — list ───────────────────────────────────────────────
router.get('/scheduled-calls', ...authChain, requirePermission(P.MKT_SCHEDULED_CALLS_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'sc.clinic_id = $1';
    if (req.query.assigned_to_id) { params.push(req.query.assigned_to_id); where += ` AND sc.assigned_to_id = $${params.length}`; }
    if (req.query.status)         { params.push(req.query.status);         where += ` AND sc.status = $${params.length}`; }
    if (req.query.from)           { params.push(req.query.from);           where += ` AND sc.scheduled_for >= $${params.length}`; }
    if (req.query.to)             { params.push(req.query.to);             where += ` AND sc.scheduled_for <= $${params.length}`; }
    const { rows } = await db.query(
      `SELECT sc.*, u.first_name, u.last_name
         FROM mkt_scheduled_calls sc
         LEFT JOIN users u ON u.id = sc.assigned_to_id
        WHERE ${where} ORDER BY sc.scheduled_for ASC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── PATCH /scheduled-calls/:id — status / reschedule / notes ──────────────────
router.patch('/scheduled-calls/:id', ...authChain, requirePermission(P.MKT_SCHEDULED_CALLS_CREATE), validate(scheduledCallPatchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const sets = [];
    const params = [req.params.id, clinicId];
    for (const col of ['status', 'scheduled_for', 'post_call_notes']) {
      if (req.body[col] !== undefined) { params.push(req.body[col]); sets.push(`${col} = $${params.length}`); }
    }
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_scheduled_calls SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Scheduled call not found' });
    if (req.body.scheduled_for && rows[0].google_event_id) {
      gcal.updateEvent(rows[0].google_event_id, { start: req.body.scheduled_for }).catch(() => {});
    }
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Marketing expenses (Phase 7)
// ══════════════════════════════════════════════════════════════════════════════

const expenseUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const EXPENSE_CATEGORIES = ['ad_spend', 'events', 'printing', 'travel',
  'tools_subscriptions', 'caller_incentives', 'other'];
const PAYMENT_MODES = ['upi', 'card', 'cash', 'bank_transfer'];

const expenseSchema = Joi.object({
  category:     Joi.string().valid(...EXPENSE_CATEGORIES).default('other'),
  vendor:       Joi.string().max(120).allow('', null).optional(),
  description:  Joi.string().allow('', null).optional(),
  amount_paise: Joi.number().integer().min(0).required(),
  spent_on:     Joi.date().iso().optional(),
  campaign_id:  Joi.string().uuid().allow(null, '').optional(),
  lead_id:      Joi.string().uuid().allow(null, '').optional(),
  payment_mode: Joi.string().valid(...PAYMENT_MODES).allow(null, '').optional(),
  notes:        Joi.string().allow('', null).optional(),
});
const expenseUpdateSchema = expenseSchema.fork(['amount_paise'], (f) => f.optional());
const EXPENSE_COLS = ['category', 'vendor', 'description', 'amount_paise', 'spent_on',
  'campaign_id', 'lead_id', 'payment_mode', 'notes'];

// multipart sends everything as strings — coerce before Joi.
function normalizeExpenseBody(b) {
  const out = { ...b };
  if (out.amount_paise !== undefined) out.amount_paise = Number(out.amount_paise);
  for (const k of ['campaign_id', 'lead_id', 'payment_mode', 'vendor', 'description', 'notes']) {
    if (out[k] === '') out[k] = null;
  }
  return out;
}

// ── GET /expenses — list ──────────────────────────────────────────────────────
router.get('/expenses', ...authChain, requirePermission(P.MKT_EXPENSE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'e.clinic_id = $1 AND e.deleted_at IS NULL';
    if (req.query.category)    { params.push(req.query.category);    where += ` AND e.category = $${params.length}`; }
    if (req.query.campaign_id) { params.push(req.query.campaign_id); where += ` AND e.campaign_id = $${params.length}`; }
    if (req.query.from)        { params.push(req.query.from);        where += ` AND e.spent_on >= $${params.length}`; }
    if (req.query.to)          { params.push(req.query.to);          where += ` AND e.spent_on <= $${params.length}`; }
    const { rows } = await db.query(
      `SELECT e.*, c.name AS campaign_name, (e.receipt_url IS NOT NULL) AS has_receipt
         FROM mkt_expenses e
         LEFT JOIN mkt_campaigns c ON c.id = e.campaign_id
        WHERE ${where} ORDER BY e.spent_on DESC, e.created_at DESC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /expenses/summary — totals by category + month-over-month ─────────────
router.get('/expenses/summary', ...authChain, requirePermission(P.MKT_EXPENSE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    // month = 'YYYY-MM'; default current month.
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
    const start = month ? `${month}-01` : null;

    const byCat = await db.query(
      `SELECT category, COALESCE(SUM(amount_paise),0)::bigint AS total_paise, COUNT(*)::int AS count
         FROM mkt_expenses
        WHERE clinic_id = $1 AND deleted_at IS NULL
          AND spent_on >= COALESCE($2::date, date_trunc('month', CURRENT_DATE))
          AND spent_on <  COALESCE($2::date, date_trunc('month', CURRENT_DATE)) + INTERVAL '1 month'
        GROUP BY category ORDER BY total_paise DESC`,
      [clinicId, start]
    );

    const totals = await db.query(
      `SELECT
         (SELECT COALESCE(SUM(amount_paise),0)::bigint FROM mkt_expenses
           WHERE clinic_id = $1 AND deleted_at IS NULL
             AND spent_on >= COALESCE($2::date, date_trunc('month', CURRENT_DATE))
             AND spent_on <  COALESCE($2::date, date_trunc('month', CURRENT_DATE)) + INTERVAL '1 month') AS this_month,
         (SELECT COALESCE(SUM(amount_paise),0)::bigint FROM mkt_expenses
           WHERE clinic_id = $1 AND deleted_at IS NULL
             AND spent_on >= COALESCE($2::date, date_trunc('month', CURRENT_DATE)) - INTERVAL '1 month'
             AND spent_on <  COALESCE($2::date, date_trunc('month', CURRENT_DATE))) AS last_month`,
      [clinicId, start]
    );

    const t = totals.rows[0];
    const thisMonth = Number(t.this_month);
    const lastMonth = Number(t.last_month);
    res.json({
      data: {
        month: month || new Date().toISOString().slice(0, 7),
        this_month_paise: thisMonth,
        last_month_paise: lastMonth,
        delta_paise: thisMonth - lastMonth,
        by_category: byCat.rows.map((r) => ({ category: r.category, total_paise: Number(r.total_paise), count: r.count })),
      },
    });
  } catch (err) { next(err); }
});

// ── POST /expenses — one-shot multipart (fields + optional receipt) ───────────
router.post('/expenses', ...authChain, requirePermission(P.MKT_EXPENSE_CREATE), expenseUpload.single('receipt'), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { value, error } = expenseSchema.validate(normalizeExpenseBody(req.body), { abortEarly: false });
    if (error) return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });

    const { orgId, userId } = req.context;
    let receiptKey = null;
    if (req.file) {
      const ext = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop().toLowerCase() : 'bin';
      receiptKey = `marketing/${clinicId}/receipts/${uuidv4()}.${ext}`;
      await uploadBuffer({ key: receiptKey, buffer: req.file.buffer, contentType: req.file.mimetype, encrypt: true });
    }

    const b = value;
    const { rows } = await db.query(
      `INSERT INTO mkt_expenses
         (org_id, clinic_id, category, vendor, description, amount_paise, spent_on,
          campaign_id, lead_id, receipt_url, payment_mode, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [orgId, clinicId, b.category, b.vendor ?? null, b.description ?? null, b.amount_paise,
       b.spent_on ?? new Date(), b.campaign_id ?? null, b.lead_id ?? null, receiptKey,
       b.payment_mode ?? null, b.notes ?? null, userId]
    );
    res.status(201).json({ data: { ...rows[0], has_receipt: !!receiptKey } });
  } catch (err) { next(err); }
});

// ── PUT /expenses/:id — update fields (receipt unchanged) ─────────────────────
router.put('/expenses/:id', ...authChain, requirePermission(P.MKT_EXPENSE_EDIT), validate(expenseUpdateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { sets, params } = buildUpdate(req.body, EXPENSE_COLS, 2);
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.context.userId);
    sets.push(`updated_by = $${2 + params.length - 1}`);
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_expenses SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $${2 + params.length} AND deleted_at IS NULL RETURNING *`,
      [req.params.id, ...params, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /expenses/:id — soft delete ────────────────────────────────────────
router.delete('/expenses/:id', ...authChain, requirePermission(P.MKT_EXPENSE_EDIT), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      `UPDATE mkt_expenses SET deleted_at = NOW(), updated_by = $3
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId, req.context.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Expense not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── GET /expenses/:id/receipt — presigned download URL ────────────────────────
router.get('/expenses/:id/receipt', ...authChain, requirePermission(P.MKT_EXPENSE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      'SELECT receipt_url FROM mkt_expenses WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL',
      [req.params.id, clinicId]
    );
    if (!rows.length || !rows[0].receipt_url) return res.status(404).json({ error: 'No receipt' });
    const url = await getPresignedUrl({ key: rows[0].receipt_url, expiresIn: 300 });
    res.json({ data: { url } });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Lead Finder — Google Maps discovery → screen → import into pipeline
// ══════════════════════════════════════════════════════════════════════════════

const leadSearchSchema = Joi.object({
  query: Joi.string().max(120).default('dental clinic'),
  city:  Joi.string().max(80).allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(40).default(20),
});
const leadImportSchema = Joi.object({
  ids: Joi.array().items(Joi.string().uuid()).min(1).required(),
});

// ── GET /lead-finder/status — which provider will be used ─────────────────────
router.get('/lead-finder/status', ...authChain, requirePermission(P.MKT_LEADFINDER_MANAGE), async (req, res) => {
  const s = leadFinder.status();
  const provider = s.scraper_available ? 'scrape' : (s.places_enabled ? 'places' : 'mock');
  res.json({ data: { ...s, active_provider: provider, limits: placesGuard.limits() } });
});

// ── GET /lead-finder/usage — today's Places usage vs caps ─────────────────────
router.get('/lead-finder/usage', ...authChain, requirePermission(P.MKT_LEADFINDER_MANAGE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    res.json({ data: await placesGuard.usage(clinicId) });
  } catch (err) { next(err); }
});

// ── GET /lead-finder/results — staged results ─────────────────────────────────
router.get('/lead-finder/results', ...authChain, requirePermission(P.MKT_LEADFINDER_MANAGE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const params = [clinicId];
    let where = 'clinic_id = $1';
    if (req.query.status) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM mkt_scraped_leads WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /lead-finder/search — discover + screen + stage ──────────────────────
router.post('/lead-finder/search', ...authChain, requirePermission(P.MKT_LEADFINDER_MANAGE), validate(leadSearchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  const { orgId, userId } = req.context;
  const { query, city, limit } = req.body;
  const key = placesGuard.cacheKey(query, city, limit);

  // Guardrails: cooldown + daily caps + in-flight dedupe (reserves a search slot).
  let reservation;
  try {
    reservation = await placesGuard.reserve(clinicId, key);
  } catch (e) {
    if (e instanceof placesGuard.GuardError) return res.status(e.status).json({ error: e.code, message: e.message });
    return next(e);
  }

  try {
    // Serve from cache when possible — zero API cost.
    let discovered = await placesGuard.getCache(clinicId, key);
    let fromCache = !!discovered;
    let callsUsed = 0;

    if (!discovered) {
      const meter = { calls: 0, cap: reservation.remainingCalls };
      try {
        discovered = await leadFinder.discover({ query, city, limit, meter });
      } catch (e) {
        await placesGuard.recordCalls(clinicId, meter.calls);   // bill partial usage
        if (e.code === 'BUDGET_EXHAUSTED') return res.status(429).json({ error: 'DAILY_CALL_CAP', message: e.message });
        return res.status(502).json({ error: 'Discovery failed', message: e.message });
      }
      callsUsed = meter.calls;
      await placesGuard.recordCalls(clinicId, callsUsed);
      if (discovered.provider === 'places') await placesGuard.setCache(clinicId, key, discovered);
    }

    const staged = [];
    const seenPhones = new Set();   // dedupe within this batch

    for (const r of discovered.results) {
      const s = screening.screen(r);
      let { status, phone, reject_reason } = s;

      // Dedupe only results that otherwise passed.
      if (status === 'passed') {
        if (seenPhones.has(phone)) {
          status = 'duplicate'; reject_reason = 'Duplicate within this search';
        } else {
          seenPhones.add(phone);
          // Active subscriber guard (reuses the caller-workflow guard).
          const guard = await checkActiveSubscriber({ clinic_name: r.name, phone });
          if (guard.is_active) {
            status = 'duplicate'; reject_reason = 'Already an active subscriber';
          } else {
            const dup = await db.query(
              `SELECT 1 FROM mkt_pipeline_leads
                WHERE clinic_id = $1 AND deleted_at IS NULL
                  AND (contact_phone = $2 OR lower(clinic_name) = lower($3)) LIMIT 1`,
              [clinicId, phone, r.name]
            );
            if (dup.rows.length) {
              status = 'duplicate'; reject_reason = 'Already in the pipeline';
            } else {
              const stagedDup = await db.query(
                `SELECT 1 FROM mkt_scraped_leads
                  WHERE clinic_id = $1 AND phone = $2 AND status IN ('passed','imported') LIMIT 1`,
                [clinicId, phone]
              );
              if (stagedDup.rows.length) { status = 'duplicate'; reject_reason = 'Already discovered earlier'; }
            }
          }
        }
      }

      const { rows } = await db.query(
        `INSERT INTO mkt_scraped_leads
           (org_id, clinic_id, search_query, search_city, provider, name, address, phone_raw, phone,
            website, rating, category, place_id, enriched, status, reject_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [orgId, clinicId, query, city ?? null, discovered.provider, r.name, r.address ?? null,
         r.phone_raw ?? null, phone, r.website ?? null, r.rating ?? null, r.category ?? null,
         r.place_id ?? null, !!r.enriched, status, reject_reason, userId]
      );
      staged.push(rows[0]);
    }

    const summary = staged.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
    res.status(201).json({
      data: staged,
      provider: discovered.provider,
      summary,
      from_cache: fromCache,
      calls_used: callsUsed,
      usage: await placesGuard.usage(clinicId),
    });
  } catch (err) {
    next(err);
  } finally {
    placesGuard.release(reservation.flightKey);
  }
});

// ── POST /lead-finder/import — promote passed results into the pipeline ───────
router.post('/lead-finder/import', ...authChain, requirePermission(P.MKT_LEADFINDER_MANAGE), validate(leadImportSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const { rows: candidates } = await db.query(
      `SELECT * FROM mkt_scraped_leads
        WHERE clinic_id = $1 AND status = 'passed' AND id = ANY($2::uuid[])`,
      [clinicId, req.body.ids]
    );

    const imported = [];
    for (const c of candidates) {
      const lead = await db.query(
        `INSERT INTO mkt_pipeline_leads
           (org_id, clinic_id, clinic_name, contact_phone, city, stage, source, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'new','scraped',$6,$7) RETURNING id`,
        [orgId, clinicId, c.name, c.phone, c.search_city,
         [c.address, c.website ? `Website: ${c.website}` : null, c.rating ? `Rating: ${c.rating}` : null]
           .filter(Boolean).join(' · ') || null,
         userId]
      );
      await db.query(
        `UPDATE mkt_scraped_leads SET status = 'imported', lead_id = $2 WHERE id = $1`,
        [c.id, lead.rows[0].id]
      );
      imported.push({ scraped_id: c.id, lead_id: lead.rows[0].id });
    }
    res.json({ data: { imported: imported.length, leads: imported } });
  } catch (err) { next(err); }
});

// ── DELETE /lead-finder/results/:id — discard a staged result ─────────────────
router.delete('/lead-finder/results/:id', ...authChain, requirePermission(P.MKT_LEADFINDER_MANAGE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      'DELETE FROM mkt_scraped_leads WHERE id = $1 AND clinic_id = $2 AND status <> $3',
      [req.params.id, clinicId, 'imported']
    );
    if (!rowCount) return res.status(404).json({ error: 'Result not found or already imported' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Audience segments (Phase 8)
// ══════════════════════════════════════════════════════════════════════════════

const segmentFilterSchema = Joi.object({
  city:              Joi.string().max(80).allow('', null).optional(),
  gender:            Joi.string().valid('male', 'female', 'other').allow('', null).optional(),
  has_email:         Joi.boolean().optional(),
  min_visits:        Joi.number().integer().min(0).allow(null).optional(),
  last_visit_before: Joi.date().iso().allow(null).optional(),
  last_visit_after:  Joi.date().iso().allow(null).optional(),
}).unknown(false);
const segmentCreateSchema = Joi.object({
  name:        Joi.string().max(120).required(),
  filter_json: segmentFilterSchema.default({}),
});
const segmentPreviewSchema = Joi.object({ filter_json: segmentFilterSchema.default({}) });

// Count + sample for a filter (does not persist).
async function previewSegment(clinicId, filter) {
  const { inner, params } = segmentSvc.buildInner(clinicId, filter);
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM (${inner}) s`, params);
  const sample = await db.query(`SELECT id, name, phone, email, visits, last_visit FROM (${inner}) s ORDER BY last_visit DESC NULLS LAST LIMIT 10`, params);
  return { count: count.rows[0].n, sample: sample.rows };
}

// ── GET /segments ─────────────────────────────────────────────────────────────
router.get('/segments', ...authChain, requirePermission(P.MKT_SEGMENT_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT * FROM mkt_segments WHERE clinic_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [clinicId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /segments/preview ────────────────────────────────────────────────────
router.post('/segments/preview', ...authChain, requirePermission(P.MKT_SEGMENT_VIEW), validate(segmentPreviewSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    res.json({ data: await previewSegment(clinicId, req.body.filter_json) });
  } catch (err) { next(err); }
});

// ── POST /segments ────────────────────────────────────────────────────────────
router.post('/segments', ...authChain, requirePermission(P.MKT_SEGMENT_CREATE), validate(segmentCreateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const { count } = await previewSegment(clinicId, req.body.filter_json);
    const { rows } = await db.query(
      `INSERT INTO mkt_segments (org_id, clinic_id, name, filter_json, guest_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, clinicId, req.body.name, req.body.filter_json, count, userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /segments/:id — soft delete ────────────────────────────────────────
router.delete('/segments/:id', ...authChain, requirePermission(P.MKT_SEGMENT_CREATE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      `UPDATE mkt_segments SET deleted_at = NOW() WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL`,
      [req.params.id, clinicId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Segment not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Promo codes (Phase 8)
// ══════════════════════════════════════════════════════════════════════════════

const promoCreateSchema = Joi.object({
  code:            Joi.string().max(40).uppercase().pattern(/^[A-Z0-9_-]+$/).required(),
  discount_type:   Joi.string().valid('percent', 'flat').required(),
  discount_value:  Joi.number().min(0).required(),
  applies_to:      Joi.string().max(40).allow('', null).optional(),
  max_redemptions: Joi.number().integer().min(0).allow(null).optional(),
  valid_from:      Joi.date().iso().allow(null).optional(),
  valid_until:     Joi.date().iso().allow(null).optional(),
  active:          Joi.boolean().default(true),
});
const promoUpdateSchema = promoCreateSchema.fork(['code', 'discount_type', 'discount_value'], (f) => f.optional()).keys({ code: Joi.forbidden() });
const promoRedeemSchema = Joi.object({
  patient_id:     Joi.string().uuid().allow(null).optional(),
  reference:      Joi.string().max(120).allow('', null).optional(),
  discount_paise: Joi.number().integer().min(0).allow(null).optional(),
});
const PROMO_COLS = ['discount_type', 'discount_value', 'applies_to', 'max_redemptions', 'valid_from', 'valid_until', 'active'];

// ── GET /promo-codes ──────────────────────────────────────────────────────────
router.get('/promo-codes', ...authChain, requirePermission(P.MKT_PROMOCODE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT * FROM mkt_promo_codes WHERE clinic_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [clinicId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /promo-codes ─────────────────────────────────────────────────────────
router.post('/promo-codes', ...authChain, requirePermission(P.MKT_PROMOCODE_CREATE), validate(promoCreateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const b = req.body;
    const dup = await db.query(
      `SELECT 1 FROM mkt_promo_codes WHERE clinic_id = $1 AND upper(code) = upper($2) AND deleted_at IS NULL`,
      [clinicId, b.code]
    );
    if (dup.rows.length) return res.status(409).json({ error: 'A promo code with this code already exists' });
    const { rows } = await db.query(
      `INSERT INTO mkt_promo_codes
         (org_id, clinic_id, code, discount_type, discount_value, applies_to, max_redemptions, valid_from, valid_until, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [orgId, clinicId, b.code, b.discount_type, b.discount_value, b.applies_to ?? 'all',
       b.max_redemptions ?? null, b.valid_from ?? null, b.valid_until ?? null, b.active, userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /promo-codes/:id ──────────────────────────────────────────────────────
router.put('/promo-codes/:id', ...authChain, requirePermission(P.MKT_PROMOCODE_EDIT), validate(promoUpdateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { sets, params } = buildUpdate(req.body, PROMO_COLS, 2);
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_promo_codes SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $${2 + params.length} AND deleted_at IS NULL RETURNING *`,
      [req.params.id, ...params, clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Promo code not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /promo-codes/:id/redemptions ──────────────────────────────────────────
router.get('/promo-codes/:id/redemptions', ...authChain, requirePermission(P.MKT_PROMOCODE_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT r.*, p.name AS patient_name
         FROM mkt_promo_redemptions r
         LEFT JOIN patients p ON p.id = r.patient_id
        WHERE r.promo_code_id = $1 AND r.clinic_id = $2 ORDER BY r.redeemed_at DESC`,
      [req.params.id, clinicId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /promo-codes/:id/redeem — record a redemption (atomic vs max) ────────
router.post('/promo-codes/:id/redeem', ...authChain, requirePermission(P.MKT_PROMOCODE_EDIT), validate(promoRedeemSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    // Atomically bump the counter only while under the cap / valid / active.
    const upd = await db.query(
      `UPDATE mkt_promo_codes
          SET redeemed_count = redeemed_count + 1, updated_at = NOW()
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL AND active = true
          AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
          AND (valid_from  IS NULL OR valid_from  <= CURRENT_DATE)
          AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
        RETURNING *`,
      [req.params.id, clinicId]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'Code not redeemable (inactive, expired, or limit reached)' });
    const b = req.body;
    const red = await db.query(
      `INSERT INTO mkt_promo_redemptions (org_id, clinic_id, promo_code_id, patient_id, reference, discount_paise, redeemed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, clinicId, req.params.id, b.patient_id ?? null, b.reference ?? null, b.discount_paise ?? null, userId]
    );
    res.status(201).json({ data: red.rows[0], promo: upd.rows[0] });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Onboarding checklist + lead timeline (Phase 9)
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_ONBOARDING = [
  'Agreement signed', 'Data migration', 'Staff training', 'Go-live',
];
const onboardingStepSchema = Joi.object({
  step_name:  Joi.string().max(120).required(),
  step_order: Joi.number().integer().min(0).optional(),
  owner_id:   Joi.string().uuid().allow(null).optional(),
  due_date:   Joi.date().iso().allow(null).optional(),
});
const onboardingPatchSchema = Joi.object({
  status:   Joi.string().valid('pending', 'in_progress', 'done').optional(),
  owner_id: Joi.string().uuid().allow(null).optional(),
  due_date: Joi.date().iso().allow(null).optional(),
  step_name: Joi.string().max(120).optional(),
}).or('status', 'owner_id', 'due_date', 'step_name');

// ── GET /pipeline/:id/onboarding ──────────────────────────────────────────────
router.get('/pipeline/:id/onboarding', ...authChain, requirePermission(P.MKT_ONBOARDING_VIEW), async (req, res, next) => {
  if (!clinicOf(req, res)) return;
  try {
    if (!await leadInClinic(req, res, req.params.id)) return;
    const { rows } = await db.query(
      `SELECT s.*, u.first_name, u.last_name
         FROM mkt_onboarding_steps s LEFT JOIN users u ON u.id = s.owner_id
        WHERE s.lead_id = $1 ORDER BY s.step_order, s.created_at`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /pipeline/:id/onboarding — add a step, or seed the default checklist ──
router.post('/pipeline/:id/onboarding', ...authChain, requirePermission(P.MKT_ONBOARDING_EDIT), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const lead = await leadInClinic(req, res, req.params.id);
    if (!lead) return;
    const { orgId } = req.context;

    // Empty body → seed the default checklist (if none exists yet).
    if (!req.body || !req.body.step_name) {
      const existing = await db.query('SELECT 1 FROM mkt_onboarding_steps WHERE lead_id = $1 LIMIT 1', [req.params.id]);
      if (existing.rows.length) return res.status(409).json({ error: 'Checklist already exists' });
      const values = DEFAULT_ONBOARDING.map((_, i) => `($1,$2,$3,$${4 + i * 2},$${5 + i * 2})`);
      const params = [orgId, clinicId, req.params.id];
      DEFAULT_ONBOARDING.forEach((name, i) => params.push(name, i));
      const { rows } = await db.query(
        `INSERT INTO mkt_onboarding_steps (org_id, clinic_id, lead_id, step_name, step_order)
         VALUES ${values.join(',')} RETURNING *`,
        params
      );
      return res.status(201).json({ data: rows });
    }

    const { error, value } = onboardingStepSchema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ error: 'Validation failed', details: error.details.map((d) => d.message) });
    const { rows } = await db.query(
      `INSERT INTO mkt_onboarding_steps (org_id, clinic_id, lead_id, step_name, step_order, owner_id, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, clinicId, req.params.id, value.step_name, value.step_order ?? 99, value.owner_id ?? null, value.due_date ?? null]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /onboarding-steps/:id ───────────────────────────────────────────────
router.patch('/onboarding-steps/:id', ...authChain, requirePermission(P.MKT_ONBOARDING_EDIT), validate(onboardingPatchSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const sets = [];
    const params = [req.params.id, clinicId];
    for (const col of ['status', 'owner_id', 'due_date', 'step_name']) {
      if (req.body[col] !== undefined) { params.push(req.body[col]); sets.push(`${col} = $${params.length}`); }
    }
    // Stamp completion when moving to done; clear it otherwise.
    if (req.body.status === 'done') sets.push('completed_at = NOW()');
    else if (req.body.status) sets.push('completed_at = NULL');
    sets.push('updated_at = NOW()');
    const { rows } = await db.query(
      `UPDATE mkt_onboarding_steps SET ${sets.join(', ')}
        WHERE id = $1 AND clinic_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Step not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /onboarding-steps/:id ──────────────────────────────────────────────
router.delete('/onboarding-steps/:id', ...authChain, requirePermission(P.MKT_ONBOARDING_EDIT), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      'DELETE FROM mkt_onboarding_steps WHERE id = $1 AND clinic_id = $2', [req.params.id, clinicId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Step not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── GET /pipeline/:id/timeline — unified activity feed for a lead ─────────────
router.get('/pipeline/:id/timeline', ...authChain, requirePermission(P.MKT_PIPELINE_VIEW), async (req, res, next) => {
  if (!clinicOf(req, res)) return;
  try {
    if (!await leadInClinic(req, res, req.params.id)) return;
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT 'marketing_feedback' AS type, f.created_at AS at,
                TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')) AS actor,
                f.disposition AS label, f.feedback_text AS detail
           FROM mkt_lead_feedback f LEFT JOIN users u ON u.id = f.author_id WHERE f.lead_id = $1
         UNION ALL
         SELECT 'caller_feedback', cf.created_at,
                TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),
                cf.sentiment, cf.feedback_text
           FROM mkt_caller_feedback cf LEFT JOIN users u ON u.id = cf.caller_id WHERE cf.lead_id = $1
         UNION ALL
         SELECT 'call', cl.called_at,
                TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),
                cl.outcome, cl.notes
           FROM mkt_call_logs cl LEFT JOIN users u ON u.id = cl.caller_id WHERE cl.lead_id = $1
         UNION ALL
         SELECT 'callback', cb.created_at, NULL,
                cb.status, COALESCE(cb.notes,'') || ' (for ' || to_char(cb.scheduled_for, 'Mon DD, HH24:MI') || ')'
           FROM mkt_callbacks cb WHERE cb.lead_id = $1
         UNION ALL
         SELECT 'scheduled_call', sc.created_at, NULL,
                sc.status, 'Meeting ' || to_char(sc.scheduled_for, 'Mon DD, HH24:MI')
           FROM mkt_scheduled_calls sc WHERE sc.lead_id = $1
       ) t ORDER BY at DESC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Pitch library (Phase 9)
// ══════════════════════════════════════════════════════════════════════════════

const pitchUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const pitchGenerateSchema = Joi.object({
  lead_id: Joi.string().uuid().required(),
  title:   Joi.string().max(160).allow('', null).optional(),
  points:  Joi.array().items(Joi.string().max(300)).optional(),
});

// ── GET /pitch-documents ──────────────────────────────────────────────────────
router.get('/pitch-documents', ...authChain, requirePermission(P.MKT_PITCH_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `SELECT p.*, (p.file_url IS NOT NULL) AS has_file, l.clinic_name AS lead_name
         FROM mkt_pitch_documents p LEFT JOIN mkt_pipeline_leads l ON l.id = p.lead_id
        WHERE p.clinic_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
      [clinicId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /pitch-documents — upload a deck ─────────────────────────────────────
router.post('/pitch-documents', ...authChain, requirePermission(P.MKT_PITCH_EDIT), pitchUpload.single('file'), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!req.body.title) return res.status(400).json({ error: 'Title is required' });
    const ext = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop().toLowerCase() : 'bin';
    const key = `marketing/${clinicId}/pitch/${uuidv4()}.${ext}`;
    await uploadBuffer({ key, buffer: req.file.buffer, contentType: req.file.mimetype, encrypt: true });
    const { rows } = await db.query(
      `INSERT INTO mkt_pitch_documents (org_id, clinic_id, title, version, file_url, content_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, clinicId, req.body.title, req.body.version || 'v1', key, req.file.mimetype, userId]
    );
    res.status(201).json({ data: { ...rows[0], has_file: true } });
  } catch (err) { next(err); }
});

// ── POST /pitch-documents/generate — per-prospect PDF (pdfkit → S3) ───────────
router.post('/pitch-documents/generate', ...authChain, requirePermission(P.MKT_PITCH_EDIT), validate(pitchGenerateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const lead = await leadInClinic(req, res, req.body.lead_id);
    if (!lead) return;
    const { orgId, userId } = req.context;
    const title = req.body.title || `Proposal — ${lead.clinic_name}`;
    const buffer = await pitchPdf.buildPitchPdf({
      clinicName: lead.clinic_name, contactName: lead.contact_name, city: lead.city, title, points: req.body.points,
    });
    const key = `marketing/${clinicId}/pitch/${uuidv4()}.pdf`;
    await uploadBuffer({ key, buffer, contentType: 'application/pdf', encrypt: true });
    const { rows } = await db.query(
      `INSERT INTO mkt_pitch_documents (org_id, clinic_id, title, version, file_url, content_type, generated, lead_id, template_json, created_by)
       VALUES ($1,$2,$3,'v1',$4,'application/pdf',true,$5,$6,$7) RETURNING *`,
      [orgId, clinicId, title, key, lead.id, JSON.stringify({ points: req.body.points || null }), userId]
    );
    const url = await getPresignedUrl({ key, expiresIn: 300 });
    res.status(201).json({ data: { ...rows[0], has_file: true }, url });
  } catch (err) { next(err); }
});

// ── GET /pitch-documents/:id/download — presigned URL ─────────────────────────
router.get('/pitch-documents/:id/download', ...authChain, requirePermission(P.MKT_PITCH_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      'SELECT file_url FROM mkt_pitch_documents WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL',
      [req.params.id, clinicId]
    );
    if (!rows.length || !rows[0].file_url) return res.status(404).json({ error: 'No file' });
    res.json({ data: { url: await getPresignedUrl({ key: rows[0].file_url, expiresIn: 300 }) } });
  } catch (err) { next(err); }
});

// ── DELETE /pitch-documents/:id — soft delete ─────────────────────────────────
router.delete('/pitch-documents/:id', ...authChain, requirePermission(P.MKT_PITCH_EDIT), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rowCount } = await db.query(
      'UPDATE mkt_pitch_documents SET deleted_at = NOW() WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL',
      [req.params.id, clinicId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Document not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
