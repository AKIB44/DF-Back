const express      = require('express');
const Joi          = require('joi');
const createError  = require('http-errors');
const db           = require('../db');
const authenticate  = require('../middleware/authenticate');
const validate      = require('../middleware/validate');
const tenantScope   = require('../rbac/tenant-scope.middleware');
const auditMw       = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P             = require('../rbac/permissions.constants');

const router    = express.Router();
const authChain = [authenticate, tenantScope, auditMw];

// ── GET /inventory/items?q=&limit= ───────────────────────────────────────────
// Search inventory items for autocomplete in materials cart
router.get(
  '/inventory/items',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const q     = (req.query.q || '').trim();
      const limit = Math.min(parseInt(req.query.limit) || 20, 50);

      const { rows } = await db.query(
        `SELECT id, name, generic_name, category, unit, is_traceable, is_implant,
                reorder_point, reorder_quantity
           FROM inventory_item
          WHERE clinic_id = $1 AND is_active = true
            AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR generic_name ILIKE '%' || $2 || '%')
          ORDER BY name ASC
          LIMIT $3`,
        [clinicId, q, limit]
      );
      return res.json({ items: rows });
    } catch (err) { next(err); }
  }
);

// ── GET /inventory/items/:id/batches ─────────────────────────────────────────
// List batches for an item with available stock (for batch selector in cart)
router.get(
  '/inventory/items/:id/batches',
  ...authChain,
  requirePermission(P.APPOINTMENT_VIEW),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { id: itemId } = req.params;

      const { rows } = await db.query(
        `SELECT b.id, b.lot_number, b.expiry_date, b.unit, b.supplier, b.received_at,
                COALESCE(cs.qty_on_hand, 0) AS qty_on_hand
           FROM inventory_batch b
           LEFT JOIN current_stock cs
             ON cs.batch_id = b.id AND cs.inventory_item_id = b.inventory_item_id
          WHERE b.inventory_item_id = $1 AND b.clinic_id = $2
            AND (cs.qty_on_hand IS NULL OR cs.qty_on_hand > 0)
            AND (b.expiry_date IS NULL OR b.expiry_date >= CURRENT_DATE)
          ORDER BY b.expiry_date ASC NULLS LAST, b.received_at ASC`,
        [itemId, clinicId]
      );
      return res.json({ batches: rows });
    } catch (err) { next(err); }
  }
);

// ── POST /inventory/items ─────────────────────────────────────────────────────
// Create a new inventory item (admin / manager)
const createItemSchema = Joi.object({
  name:             Joi.string().max(200).required(),
  generic_name:     Joi.string().max(200).allow('', null).optional(),
  category:         Joi.string().valid('dental_material','implant','membrane','medication','disposable','equipment').required(),
  unit:             Joi.string().max(20).required(),
  is_traceable:     Joi.boolean().optional(),
  is_implant:       Joi.boolean().optional(),
  reorder_point:    Joi.number().min(0).optional(),
  reorder_quantity: Joi.number().min(0).optional(),
});

router.post(
  '/inventory/items',
  ...authChain,
  requirePermission(P.CLINIC_MANAGE),
  validate(createItemSchema),
  async (req, res, next) => {
    try {
      const { orgId, clinicId } = req.context;
      const { name, generic_name, category, unit, is_traceable, is_implant, reorder_point, reorder_quantity } = req.body;

      const { rows } = await db.query(
        `INSERT INTO inventory_item
           (org_id, clinic_id, name, generic_name, category, unit, is_traceable, is_implant, reorder_point, reorder_quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [orgId, clinicId, name, generic_name || null, category, unit,
         is_traceable ?? false, is_implant ?? false,
         reorder_point ?? 0, reorder_quantity ?? 0]
      );
      return res.status(201).json({ item: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── POST /inventory/items/:id/batches ─────────────────────────────────────────
// Receive a new batch (goods receipt)
const receiveBatchSchema = Joi.object({
  lot_number:       Joi.string().max(100).allow('', null).optional(),
  expiry_date:      Joi.string().isoDate().allow(null).optional(),
  initial_quantity: Joi.number().positive().required(),
  unit:             Joi.string().max(20).required(),
  supplier:         Joi.string().max(200).allow('', null).optional(),
  received_at:      Joi.string().isoDate().optional(),
});

router.post(
  '/inventory/items/:id/batches',
  ...authChain,
  requirePermission(P.CLINIC_MANAGE),
  validate(receiveBatchSchema),
  async (req, res, next) => {
    try {
      const { clinicId, userId } = req.context;
      const { id: itemId } = req.params;
      const { lot_number, expiry_date, initial_quantity, unit, supplier, received_at } = req.body;

      const item = await db.query(
        `SELECT id FROM inventory_item WHERE id=$1 AND clinic_id=$2`,
        [itemId, clinicId]
      );
      if (!item.rows[0]) return next(createError(404, 'Item not found'));

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: batchRows } = await client.query(
          `INSERT INTO inventory_batch
             (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, supplier, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [itemId, clinicId, lot_number || null, expiry_date || null,
           initial_quantity, unit, supplier || null, received_at || null]
        );
        const batch = batchRows[0];

        await client.query(
          `INSERT INTO stock_movement
             (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
           VALUES ('GOODS_RECEIPT',$1,$2,$3,1,$4,'batch_receive',$5)`,
          [itemId, batch.id, clinicId, initial_quantity, userId]
        );

        // Refresh mat view
        await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY current_stock`).catch(() =>
          client.query(`REFRESH MATERIALIZED VIEW current_stock`)
        );

        await client.query('COMMIT');
        return res.status(201).json({ batch });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) { next(err); }
  }
);

module.exports = router;
