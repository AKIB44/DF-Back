'use strict';

// Clinic-level billing — a single clinic's own revenue & expense (operational).
// Distinct from org-level Subscription Management (platform-billing.js).
// Everything here is scoped to the active clinic (req.context.clinicId).
//
//   Revenue = sealed treatment charges (service_performed.final_charge)
//   Expense = received purchase-order line totals + manual clinic_expense ledger

const express      = require('express');
const Joi          = require('joi');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

function parsePeriod(raw, def = 30) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(365, n));
}
function periodStart(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function clinicOf(req, res) {
  const clinicId = req.context.clinicId;
  if (!clinicId) { res.status(400).json({ error: 'No active clinic selected' }); return null; }
  return clinicId;
}

const expenseSchema = Joi.object({
  category:     Joi.string().valid('RENT','SALARIES','UTILITIES','SUPPLIES','EQUIPMENT','MARKETING','MAINTENANCE','TAX','OTHER').default('OTHER'),
  description:  Joi.string().max(500).allow('', null).optional(),
  amount_paise: Joi.number().integer().min(0).required(),
  expense_date: Joi.date().iso().optional(),
  vendor:       Joi.string().max(200).allow('', null).optional(),
});
const expenseUpdateSchema = expenseSchema.fork(['amount_paise'], (f) => f.optional());

// ── GET /summary — revenue / expense / net for the active clinic ──────────────
router.get('/summary', ...authChain, requirePermission(P.BILLING_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const start = periodStart(parsePeriod(req.query.period));
    const [rev, po, manual] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(final_charge), 0)::numeric AS total
           FROM service_performed
          WHERE clinic_id = $1 AND deleted_at IS NULL
            AND status IN ('COMPLETED','PARTIAL')
            AND COALESCE(completed_at, created_at) >= $2`,
        [clinicId, start]
      ),
      db.query(
        `SELECT COALESCE(SUM(pol.quantity * COALESCE(pol.unit_cost, 0)), 0)::numeric AS total
           FROM purchase_order po
           JOIN purchase_order_line pol ON pol.purchase_order_id = po.id
          WHERE po.clinic_id = $1 AND po.status = 'received'
            AND COALESCE(po.received_at, po.created_at) >= $2`,
        [clinicId, start]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
           FROM clinic_expense
          WHERE clinic_id = $1 AND deleted_at IS NULL AND expense_date >= $2::date`,
        [clinicId, start]
      ),
    ]);

    const revenue_paise       = Math.round(parseFloat(rev.rows[0].total) * 100);
    const expense_po_paise    = Math.round(parseFloat(po.rows[0].total) * 100);
    const expense_manual_paise = parseInt(manual.rows[0].total, 10);
    const expense_paise       = expense_po_paise + expense_manual_paise;

    res.json({
      period_days: parsePeriod(req.query.period),
      revenue_paise,
      expense_paise,
      expense_po_paise,
      expense_manual_paise,
      net_paise: revenue_paise - expense_paise,
    });
  } catch (err) { next(err); }
});

// ── GET /revenue — itemized sealed charges ────────────────────────────────────
router.get('/revenue', ...authChain, requirePermission(P.BILLING_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const start = periodStart(parsePeriod(req.query.period));
    const { rows } = await db.query(
      `SELECT sp.id, s.name AS service_name, sp.final_charge,
              COALESCE(sp.completed_at, sp.created_at) AS charged_at, sp.status
         FROM service_performed sp
         JOIN services s ON s.id = sp.service_id
        WHERE sp.clinic_id = $1 AND sp.deleted_at IS NULL
          AND sp.status IN ('COMPLETED','PARTIAL')
          AND COALESCE(sp.completed_at, sp.created_at) >= $2
        ORDER BY charged_at DESC
        LIMIT 100`,
      [clinicId, start]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── Manual expense ledger CRUD ────────────────────────────────────────────────
router.get('/expenses', ...authChain, requirePermission(P.BILLING_VIEW), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const start = periodStart(parsePeriod(req.query.period));
    const { rows } = await db.query(
      `SELECT * FROM clinic_expense
        WHERE clinic_id = $1 AND deleted_at IS NULL AND expense_date >= $2::date
        ORDER BY expense_date DESC, created_at DESC`,
      [clinicId, start]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/expenses', ...authChain, requirePermission(P.EXPENSE_MANAGE), validate(expenseSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { orgId, userId } = req.context;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO clinic_expense
         (org_id, clinic_id, category, description, amount_paise, expense_date, vendor, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8,$8)
       RETURNING *`,
      [orgId, clinicId, b.category, b.description || null, b.amount_paise,
       b.expense_date || null, b.vendor || null, userId]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/expenses/:id', ...authChain, requirePermission(P.EXPENSE_MANAGE), validate(expenseUpdateSchema), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const FIELDS = ['category', 'description', 'amount_paise', 'expense_date', 'vendor'];
    const updates = [];
    const params  = [];
    for (const f of FIELDS) {
      if (req.body[f] === undefined) continue;
      params.push(req.body[f]);
      updates.push(`${f} = $${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
    params.push(req.context.userId); updates.push(`updated_by = $${params.length}`);
    updates.push('updated_at = now()');
    params.push(req.params.id);
    params.push(clinicId);
    const { rows } = await db.query(
      `UPDATE clinic_expense SET ${updates.join(', ')}
        WHERE id = $${params.length - 1} AND clinic_id = $${params.length} AND deleted_at IS NULL
        RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/expenses/:id', ...authChain, requirePermission(P.EXPENSE_MANAGE), async (req, res, next) => {
  const clinicId = clinicOf(req, res); if (!clinicId) return;
  try {
    const { rows } = await db.query(
      `UPDATE clinic_expense SET deleted_at = now(), updated_by = $3, updated_at = now()
        WHERE id = $1 AND clinic_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [req.params.id, clinicId, req.context.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
