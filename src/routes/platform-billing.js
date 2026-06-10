'use strict';

// Platform Accounts & Billing — Phase AC-1: subscription plan management.
// PRD_07 endpoints 7–10. Plans are DentaFlow's product catalog (platform-admin
// scope). Mounted at /v1/platform.

const express      = require('express');
const Joi          = require('joi');
const bcrypt       = require('bcryptjs');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const razorpay     = require('../services/razorpayService');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── Schemas ─────────────────────────────────────────────────────────────────
const featureSlug = Joi.string().max(60);

const planCreateSchema = Joi.object({
  slug:                   Joi.string().lowercase().max(60).pattern(/^[a-z0-9_]+$/).required(),
  display_name:           Joi.string().max(120).required(),
  description:            Joi.string().max(1000).allow('', null).optional(),
  price_monthly_paise:    Joi.number().integer().min(0).required(),
  price_yearly_paise:     Joi.number().integer().min(0).allow(null).optional(),
  billing_cycle:          Joi.string().valid('MONTHLY', 'QUARTERLY', 'YEARLY').default('MONTHLY'),
  currency:               Joi.string().length(3).uppercase().default('INR'),
  gst_pct:                Joi.number().min(0).max(100).default(18.00),
  max_staff:              Joi.number().integer().min(0).allow(null).optional(),
  max_patients:           Joi.number().integer().min(0).allow(null).optional(),
  max_daily_appointments: Joi.number().integer().min(0).allow(null).optional(),
  max_storage_gb:         Joi.number().integer().min(0).allow(null).optional(),
  features_included:      Joi.array().items(featureSlug).default([]),
  features_excluded:      Joi.array().items(featureSlug).default([]),
  is_active:              Joi.boolean().default(true),
  is_visible:             Joi.boolean().default(true),
  is_custom:              Joi.boolean().default(false),
  trial_days:             Joi.number().integer().min(0).max(90).default(14),
  grace_period_days:      Joi.number().integer().min(0).max(60).default(7),
});

// All fields optional on edit; slug is immutable (omitted).
const planUpdateSchema = planCreateSchema.fork(
  ['slug', 'display_name', 'price_monthly_paise'],
  (f) => f.optional()
).keys({ slug: Joi.forbidden() });

const COLUMNS = [
  'display_name', 'description', 'price_monthly_paise', 'price_yearly_paise',
  'billing_cycle', 'currency', 'gst_pct', 'max_staff', 'max_patients',
  'max_daily_appointments', 'max_storage_gb', 'features_included',
  'features_excluded', 'is_active', 'is_visible', 'is_custom', 'trial_days',
  'grace_period_days',
];
const JSONB_COLUMNS = new Set(['features_included', 'features_excluded']);

// ── GET /plans — list ─────────────────────────────────────────────────────────
router.get('/plans', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  try {
    const params = [];
    let where = 'deleted_at IS NULL';
    if (req.query.is_active !== undefined) {
      params.push(req.query.is_active === 'true');
      where += ` AND is_active = $${params.length}`;
    }
    if (req.query.is_visible !== undefined) {
      params.push(req.query.is_visible === 'true');
      where += ` AND is_visible = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT * FROM subscription_plan WHERE ${where} ORDER BY price_monthly_paise ASC`,
      params
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── POST /plans — create + Razorpay sync ───────────────────────────────────────
router.post('/plans', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), validate(planCreateSchema), async (req, res, next) => {
  try {
    const b      = req.body;
    const userId = req.context.userId;

    const dup = await db.query('SELECT id FROM subscription_plan WHERE slug = $1', [b.slug]);
    if (dup.rows.length) return res.status(409).json({ error: 'A plan with this slug already exists' });

    const { razorpay_plan_id } = await razorpay.createPlan(b);

    const { rows } = await db.query(
      `INSERT INTO subscription_plan
         (slug, display_name, description, price_monthly_paise, price_yearly_paise,
          billing_cycle, currency, gst_pct, max_staff, max_patients,
          max_daily_appointments, max_storage_gb, features_included, features_excluded,
          is_active, is_visible, is_custom, trial_days, grace_period_days,
          razorpay_plan_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,
               $15,$16,$17,$18,$19,$20,$21,$21)
       RETURNING *`,
      [b.slug, b.display_name, b.description || null, b.price_monthly_paise, b.price_yearly_paise ?? null,
       b.billing_cycle, b.currency, b.gst_pct, b.max_staff ?? null, b.max_patients ?? null,
       b.max_daily_appointments ?? null, b.max_storage_gb ?? null,
       JSON.stringify(b.features_included || []), JSON.stringify(b.features_excluded || []),
       b.is_active, b.is_visible, b.is_custom, b.trial_days, b.grace_period_days,
       razorpay_plan_id, userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /plans/:id — edit (does not affect existing subscriptions) ───────────
router.patch('/plans/:id', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), validate(planUpdateSchema), async (req, res, next) => {
  try {
    const existing = await db.query('SELECT * FROM subscription_plan WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Plan not found' });

    const updates = [];
    const params  = [];
    for (const col of COLUMNS) {
      if (req.body[col] === undefined) continue;
      const val = JSONB_COLUMNS.has(col) ? JSON.stringify(req.body[col]) : req.body[col];
      params.push(val);
      updates.push(`${col} = $${params.length}${JSONB_COLUMNS.has(col) ? '::jsonb' : ''}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    // Re-sync to Razorpay (stub) — price/feature changes apply to NEW subscriptions only.
    const { razorpay_plan_id } = await razorpay.updatePlan({ ...existing.rows[0], ...req.body });
    params.push(razorpay_plan_id);  updates.push(`razorpay_plan_id = $${params.length}`);
    params.push(req.context.userId); updates.push(`updated_by = $${params.length}`);
    updates.push('updated_at = now()');

    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE subscription_plan SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /plans/:id — soft archive ───────────────────────────────────────────
router.delete('/plans/:id', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE subscription_plan
          SET is_active = false, deleted_at = now(), updated_by = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [req.params.id, req.context.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── GET /subscriptions — every clinic in the org × its current subscription ───
router.get('/subscriptions', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  try {
    const orgId = req.context.orgId;
    if (!orgId) return res.status(400).json({ error: 'No org_id in token' });

    const { rows } = await db.query(
      `SELECT c.id            AS clinic_id,
              c.name          AS clinic_name,
              c.tenant_status,
              sub.id          AS subscription_id,
              sub.status,
              sub.amount_paise,
              sub.total_paise,
              sub.next_billing_date,
              p.id            AS plan_id,
              p.slug          AS plan_slug,
              p.display_name  AS plan_name
         FROM clinics c
         LEFT JOIN LATERAL (
           SELECT * FROM subscription s
            WHERE s.tenant_id = c.id AND s.deleted_at IS NULL
            ORDER BY s.created_at DESC LIMIT 1
         ) sub ON true
         LEFT JOIN subscription_plan p ON p.id = sub.plan_id
        WHERE c.org_id = $1
        ORDER BY c.name ASC`,
      [orgId]
    );

    const subtotal_paise = rows.reduce((sum, r) => sum + (r.total_paise || 0), 0);
    res.json({ data: rows, subtotal_paise });
  } catch (err) { next(err); }
});

// ── POST /clinics/:clinicId/subscription — assign / change a clinic's plan ────
const assignSchema = Joi.object({ plan_id: Joi.string().uuid().required() });

router.post('/clinics/:clinicId/subscription', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), validate(assignSchema), async (req, res, next) => {
  try {
    const { orgId, userId } = req.context;
    const { clinicId } = req.params;

    const clinic = await db.query('SELECT id FROM clinics WHERE id = $1 AND org_id = $2', [clinicId, orgId]);
    if (!clinic.rows.length) return res.status(404).json({ error: 'Clinic not found in this org' });

    const planRes = await db.query('SELECT * FROM subscription_plan WHERE id = $1 AND deleted_at IS NULL', [req.body.plan_id]);
    if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRes.rows[0];

    const amount = plan.price_monthly_paise;
    const gst    = Math.round(amount * parseFloat(plan.gst_pct) / 100);
    const total  = amount + gst;

    const { razorpay_subscription_id } = await razorpay.createSubscription({
      planRazorpayId: plan.razorpay_plan_id, tenantId: clinicId,
    });

    // One active subscription row per clinic — update the latest, else insert.
    const existing = await db.query(
      `SELECT id, plan_id FROM subscription WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [clinicId]
    );

    let row, action, fromStatus = null;
    if (existing.rows.length) {
      const prev = existing.rows[0];
      const upd = await db.query(
        `UPDATE subscription
            SET previous_plan_id = plan_id, plan_id = $2, plan_changed_at = now(),
                amount_paise = $3, gst_paise = $4, total_paise = $5,
                status = 'ACTIVE', razorpay_subscription_id = $6,
                updated_by = $7, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [prev.id, plan.id, amount, gst, total, razorpay_subscription_id, userId]
      );
      row = upd.rows[0]; action = 'PLAN_CHANGED';
    } else {
      const ins = await db.query(
        `INSERT INTO subscription
           (tenant_id, org_id, plan_id, status, amount_paise, gst_paise, total_paise,
            activated_at, razorpay_subscription_id, created_by, updated_by)
         VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6, now(), $7, $8, $8)
         RETURNING *`,
        [clinicId, orgId, plan.id, amount, gst, total, razorpay_subscription_id, userId]
      );
      row = ins.rows[0]; action = 'ACTIVATED';
    }

    await db.query(
      `INSERT INTO tenant_access_log (tenant_id, action, to_status, performed_by, metadata)
       VALUES ($1, $2, 'ACTIVE', $3, $4)`,
      [clinicId, action, userId, JSON.stringify({ plan_slug: plan.slug, amount_paise: amount })]
    );

    // mark the clinic active if it was on trial / lapsed
    await db.query(
      `UPDATE clinics SET tenant_status = 'ACTIVE', activated_at = COALESCE(activated_at, now())
        WHERE id = $1 AND tenant_status IN ('TRIAL','GRACE','SUSPENDED')`,
      [clinicId]
    );
    tenantScope.invalidateTenantStatus(clinicId); // drop the read-only cache entry

    res.json({ data: row });
  } catch (err) { next(err); }
});

// ── POST /clinics/provision — onboard a new clinic on a 14-day trial ──────────
const provisionSchema = Joi.object({
  clinic_name:      Joi.string().max(200).required(),
  phone:            Joi.string().max(20).required(),
  email:            Joi.string().email().max(200).required(),
  city:             Joi.string().max(120).allow('', null).optional(),
  subdomain:        Joi.string().lowercase().max(60).pattern(/^[a-z0-9-]+$/).allow('', null).optional(),
  owner_first_name: Joi.string().max(120).required(),
  owner_last_name:  Joi.string().max(120).allow('', null).optional(),
  owner_email:      Joi.string().email().max(200).required(),
  owner_password:   Joi.string().min(8).max(200).required(),
  plan_id:          Joi.string().uuid().required(),
});

router.post('/clinics/provision', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), validate(provisionSchema), async (req, res, next) => {
  const orgId  = req.context.orgId;
  const userId = req.context.userId;
  if (!orgId) return res.status(400).json({ error: 'No org_id in token' });
  const b = req.body;

  const client = await db.pool.connect();
  try {
    const planRes = await client.query('SELECT * FROM subscription_plan WHERE id = $1 AND deleted_at IS NULL', [b.plan_id]);
    if (!planRes.rows.length) { client.release(); return res.status(404).json({ error: 'Plan not found' }); }
    const plan = planRes.rows[0];

    // Owner email must be unique
    const dupe = await client.query('SELECT 1 FROM users WHERE email = $1', [b.owner_email]);
    if (dupe.rows.length) { client.release(); return res.status(409).json({ error: 'A user with the owner email already exists' }); }

    await client.query('BEGIN');

    const clinicRes = await client.query(
      `INSERT INTO clinics (org_id, name, phone, email, city, subdomain,
                            tenant_status, trial_started_at, trial_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,'TRIAL', now(), now() + ($7 || ' days')::interval)
       RETURNING id`,
      [orgId, b.clinic_name, b.phone, b.email, b.city || '', b.subdomain || null, String(plan.trial_days)]
    );
    const clinicId = clinicRes.rows[0].id;

    const password_hash = await bcrypt.hash(b.owner_password, 12);
    const ownerRes = await client.query(
      `INSERT INTO users (org_id, clinic_id, first_name, last_name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,$6,'admin')
       RETURNING id`,
      [orgId, clinicId, b.owner_first_name, b.owner_last_name || '', b.owner_email, password_hash]
    );
    const ownerId = ownerRes.rows[0].id;

    const roleRow = await client.query(`SELECT id FROM roles WHERE code = 'clinic_admin' AND is_system = true`);
    if (roleRow.rows.length) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, clinic_id, granted_by) VALUES ($1,$2,$3,$4)`,
        [ownerId, roleRow.rows[0].id, clinicId, userId]
      );
    }

    const amount = plan.price_monthly_paise;
    const gst    = Math.round(amount * parseFloat(plan.gst_pct) / 100);
    await client.query(
      `INSERT INTO subscription
         (tenant_id, org_id, plan_id, status, trial_start, trial_end,
          amount_paise, gst_paise, total_paise, created_by, updated_by)
       VALUES ($1,$2,$3,'TRIALING', CURRENT_DATE, CURRENT_DATE + ($4 || ' days')::interval,
               $5,$6,$7,$8,$8)`,
      [clinicId, orgId, plan.id, String(plan.trial_days), amount, gst, amount + gst, userId]
    );

    await client.query(
      `INSERT INTO tenant_access_log (tenant_id, action, to_status, performed_by, metadata)
       VALUES ($1, 'TRIAL_STARTED', 'TRIAL', $2, $3)`,
      [clinicId, userId, JSON.stringify({ plan_slug: plan.slug, trial_days: plan.trial_days })]
    );

    await client.query('COMMIT');
    res.status(201).json({ data: { clinic_id: clinicId, owner_id: ownerId, trial_days: plan.trial_days } });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /my-tenant-status — trial/lifecycle status for the active clinic ──────
// Any authenticated role may read this (drives the FE trial banner / overlay).
router.get('/my-tenant-status', ...authChain, async (req, res, next) => {
  const clinicId = req.context.clinicId;
  if (!clinicId) return res.json({ tenant_status: null, trial_ends_at: null, days_remaining: null });
  try {
    const { rows } = await db.query(
      `SELECT tenant_status, trial_ends_at,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400))::int AS days_remaining
         FROM clinics WHERE id = $1`,
      [clinicId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Clinic not found' });
    const r = rows[0];
    res.json({
      tenant_status:  r.tenant_status,
      trial_ends_at:  r.trial_ends_at,
      days_remaining: r.trial_ends_at ? r.days_remaining : null,
    });
  } catch (err) { next(err); }
});

// ── Tenant lifecycle actions ─────────────────────────────────────────────────
async function loadOrgClinic(orgId, clinicId) {
  const { rows } = await db.query(
    `SELECT id, tenant_status, trial_started_at, trial_ends_at FROM clinics WHERE id = $1 AND org_id = $2`,
    [clinicId, orgId]
  );
  return rows[0] || null;
}
async function logTenant(clinicId, action, fromStatus, toStatus, userId, reason) {
  await db.query(
    `INSERT INTO tenant_access_log (tenant_id, action, from_status, to_status, performed_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [clinicId, action, fromStatus, toStatus, userId, reason || null]
  );
}

router.post('/tenants/:clinicId/suspend', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  const { orgId, userId } = req.context;
  const { clinicId } = req.params;
  try {
    const clinic = await loadOrgClinic(orgId, clinicId);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found in this org' });
    await db.query(`UPDATE clinics SET tenant_status='SUSPENDED', suspended_at=now() WHERE id=$1`, [clinicId]);
    await db.query(`UPDATE subscription SET status='SUSPENDED', suspended_at=now(), updated_at=now() WHERE tenant_id=$1 AND deleted_at IS NULL`, [clinicId]);
    await logTenant(clinicId, 'SUSPENDED', clinic.tenant_status, 'SUSPENDED', userId, req.body?.reason);
    tenantScope.invalidateTenantStatus(clinicId);
    res.json({ data: { tenant_status: 'SUSPENDED' } });
  } catch (err) { next(err); }
});

router.post('/tenants/:clinicId/reactivate', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  const { orgId, userId } = req.context;
  const { clinicId } = req.params;
  try {
    const clinic = await loadOrgClinic(orgId, clinicId);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found in this org' });
    const sub = await db.query(`SELECT id FROM subscription WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [clinicId]);
    const newStatus = sub.rows.length ? 'ACTIVE' : 'TRIAL';
    await db.query(`UPDATE clinics SET tenant_status=$2, activated_at=COALESCE(activated_at, now()), revoked_at=NULL, revoke_reason=NULL WHERE id=$1`, [clinicId, newStatus]);
    if (sub.rows.length) await db.query(`UPDATE subscription SET status='ACTIVE', updated_at=now() WHERE id=$1`, [sub.rows[0].id]);
    await logTenant(clinicId, 'REACTIVATED', clinic.tenant_status, newStatus, userId, req.body?.reason);
    tenantScope.invalidateTenantStatus(clinicId);
    res.json({ data: { tenant_status: newStatus } });
  } catch (err) { next(err); }
});

const extendSchema = Joi.object({ days: Joi.number().integer().min(1).max(30).required() });
router.post('/tenants/:clinicId/extend-trial', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), validate(extendSchema), async (req, res, next) => {
  const { orgId, userId } = req.context;
  const { clinicId } = req.params;
  try {
    const clinic = await loadOrgClinic(orgId, clinicId);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found in this org' });
    // Cap total trial at 30 days from trial start (ACEC-2).
    const { rows } = await db.query(
      `UPDATE clinics
          SET tenant_status='TRIAL', suspended_at=NULL,
              trial_ends_at = LEAST(
                COALESCE(trial_ends_at, now()) + ($2 || ' days')::interval,
                COALESCE(trial_started_at, now()) + interval '30 days')
        WHERE id=$1
        RETURNING trial_ends_at`,
      [clinicId, String(req.body.days)]
    );
    await db.query(`UPDATE subscription SET status='TRIALING', trial_end=$2::date, updated_at=now() WHERE tenant_id=$1 AND deleted_at IS NULL`, [clinicId, rows[0].trial_ends_at]);
    await logTenant(clinicId, 'TRIAL_EXTENDED', clinic.tenant_status, 'TRIAL', userId, `+${req.body.days}d`);
    tenantScope.invalidateTenantStatus(clinicId);
    res.json({ data: { trial_ends_at: rows[0].trial_ends_at } });
  } catch (err) { next(err); }
});

const revokeSchema = Joi.object({ reason: Joi.string().max(500).required() });
router.post('/tenants/:clinicId/revoke', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), validate(revokeSchema), async (req, res, next) => {
  const { orgId, userId } = req.context;
  const { clinicId } = req.params;
  try {
    const clinic = await loadOrgClinic(orgId, clinicId);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found in this org' });
    await db.query(
      `UPDATE clinics SET tenant_status='REVOKED', revoked_at=now(), revoke_reason=$2, revoked_by=$3 WHERE id=$1`,
      [clinicId, req.body.reason, userId]
    );
    await db.query(`UPDATE subscription SET status='REVOKED', updated_at=now() WHERE tenant_id=$1 AND deleted_at IS NULL`, [clinicId]);
    await logTenant(clinicId, 'REVOKED', clinic.tenant_status, 'REVOKED', userId, req.body.reason);
    tenantScope.invalidateTenantStatus(clinicId);
    res.json({ data: { tenant_status: 'REVOKED' } });
  } catch (err) { next(err); }
});

// ── GET /dashboard/metrics — org subscription overview ───────────────────────
router.get('/dashboard/metrics', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  const orgId = req.context.orgId;
  if (!orgId) return res.status(400).json({ error: 'No org_id in token' });
  try {
    const [agg, expiring] = await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(s.amount_paise) FILTER (WHERE s.status = 'ACTIVE'), 0)::bigint AS mrr_paise,
           COALESCE(SUM(s.total_paise)  FILTER (WHERE s.status = 'ACTIVE'), 0)::bigint AS billing_paise,
           COUNT(*) FILTER (WHERE c.tenant_status = 'ACTIVE')::int    AS active,
           COUNT(*) FILTER (WHERE c.tenant_status = 'TRIAL')::int     AS trialing,
           COUNT(*) FILTER (WHERE c.tenant_status IN ('SUSPENDED','REVOKED','CHURNED'))::int AS suspended,
           COUNT(*)::int AS total
         FROM clinics c
         LEFT JOIN LATERAL (
           SELECT * FROM subscription s WHERE s.tenant_id = c.id AND s.deleted_at IS NULL
           ORDER BY s.created_at DESC LIMIT 1
         ) s ON true
         WHERE c.org_id = $1`,
        [orgId]
      ),
      db.query(
        `SELECT id AS clinic_id, name AS clinic_name,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400))::int AS days_remaining
           FROM clinics
          WHERE org_id = $1 AND tenant_status = 'TRIAL'
            AND trial_ends_at IS NOT NULL AND trial_ends_at < now() + interval '7 days'
          ORDER BY trial_ends_at ASC`,
        [orgId]
      ),
    ]);
    const a = agg.rows[0];
    res.json({
      mrr_paise:     Number(a.mrr_paise),
      billing_paise: Number(a.billing_paise),
      counts: { active: a.active, trialing: a.trialing, suspended: a.suspended, total: a.total },
      expiring_soon: expiring.rows,
    });
  } catch (err) { next(err); }
});

// ── GET /tenants/:clinicId — full tenant detail ──────────────────────────────
router.get('/tenants/:clinicId', ...authChain, requirePermission(P.PLATFORM_PLAN_MANAGE), async (req, res, next) => {
  const orgId = req.context.orgId;
  const { clinicId } = req.params;
  try {
    const clinicRes = await db.query(
      `SELECT c.id, c.name, c.subdomain, c.tenant_status, c.trial_started_at, c.trial_ends_at,
              c.activated_at, c.suspended_at, c.revoked_at, c.revoke_reason,
              s.id AS subscription_id, s.status AS sub_status, s.amount_paise, s.total_paise,
              s.trial_end, s.next_billing_date,
              p.display_name AS plan_name, p.slug AS plan_slug, p.max_staff, p.max_patients
         FROM clinics c
         LEFT JOIN LATERAL (
           SELECT * FROM subscription s WHERE s.tenant_id = c.id AND s.deleted_at IS NULL
           ORDER BY s.created_at DESC LIMIT 1
         ) s ON true
         LEFT JOIN subscription_plan p ON p.id = s.plan_id
        WHERE c.id = $1 AND c.org_id = $2`,
      [clinicId, orgId]
    );
    if (!clinicRes.rows.length) return res.status(404).json({ error: 'Clinic not found in this org' });
    const row = clinicRes.rows[0];

    const [usage, contacts, log] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM users    WHERE clinic_id = $1 AND is_active = true) AS staff_count,
           (SELECT COUNT(*)::int FROM patients WHERE clinic_id = $1)                      AS patient_count`,
        [clinicId]
      ),
      db.query(`SELECT * FROM tenant_contact WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC`, [clinicId]),
      db.query(`SELECT action, from_status, to_status, reason, occurred_at FROM tenant_access_log WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 20`, [clinicId]),
    ]);

    res.json({
      clinic: {
        id: row.id, name: row.name, subdomain: row.subdomain, tenant_status: row.tenant_status,
        trial_started_at: row.trial_started_at, trial_ends_at: row.trial_ends_at,
        activated_at: row.activated_at, suspended_at: row.suspended_at,
        revoked_at: row.revoked_at, revoke_reason: row.revoke_reason,
      },
      subscription: row.subscription_id ? {
        id: row.subscription_id, status: row.sub_status, amount_paise: row.amount_paise,
        total_paise: row.total_paise, trial_end: row.trial_end, next_billing_date: row.next_billing_date,
        plan_name: row.plan_name, plan_slug: row.plan_slug,
      } : null,
      usage: {
        staff_count: usage.rows[0].staff_count, patient_count: usage.rows[0].patient_count,
        max_staff: row.max_staff, max_patients: row.max_patients,
      },
      contacts: contacts.rows,
      access_log: log.rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;
