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
  requirePermission(P.CLINIC_SETTINGS),
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
  unit_cost:        Joi.number().min(0).allow(null).optional(),
  supplier:         Joi.string().max(200).allow('', null).optional(),
  received_at:      Joi.string().isoDate().optional(),
});

router.post(
  '/inventory/items/:id/batches',
  ...authChain,
  requirePermission(P.CLINIC_SETTINGS),
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
             (inventory_item_id, clinic_id, lot_number, expiry_date, initial_quantity, unit, unit_cost, supplier, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [itemId, clinicId, lot_number || null, expiry_date || null,
           initial_quantity, unit, req.body.unit_cost ?? null, supplier || null, received_at || null]
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

// ── GET /inventory/stock ──────────────────────────────────────────────────────
// Current stock levels for all active items in the clinic
router.get(
  '/inventory/stock',
  ...authChain,
  requirePermission(P.INVENTORY_ADJUST),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { rows } = await db.query(
        `SELECT
           i.id, i.name, i.generic_name, i.category, i.unit,
           i.is_traceable, i.is_implant, i.reorder_point, i.reorder_quantity,
           i.is_active, i.created_at, i.updated_at,
           COALESCE(SUM(cs.qty_on_hand), 0)::numeric AS qty_on_hand,
           COUNT(b.id) FILTER (
             WHERE b.expiry_date IS NOT NULL
               AND b.expiry_date >= CURRENT_DATE
               AND b.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
           )::int AS expiring_soon_batches
         FROM inventory_item i
         LEFT JOIN current_stock cs
           ON cs.inventory_item_id = i.id AND cs.clinic_id = $1
         LEFT JOIN inventory_batch b
           ON b.inventory_item_id = i.id AND b.clinic_id = $1
         WHERE i.clinic_id = $1 AND i.is_active = true
         GROUP BY i.id
         ORDER BY i.name ASC`,
        [clinicId]
      );
      return res.json({ stock: rows });
    } catch (err) { next(err); }
  }
);

// ── GET /inventory/alerts ─────────────────────────────────────────────────────
// Items at or below reorder point — ordered: out-of-stock first, then low-stock
router.get(
  '/inventory/alerts',
  ...authChain,
  requirePermission(P.INVENTORY_ADJUST),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { rows } = await db.query(
        `SELECT i.id, i.name, i.generic_name, i.category, i.unit,
                i.reorder_point, i.reorder_quantity,
                COALESCE(SUM(cs.qty_on_hand), 0)::numeric AS qty_on_hand,
                CASE WHEN COALESCE(SUM(cs.qty_on_hand), 0) <= 0
                     THEN 'OUT_OF_STOCK' ELSE 'LOW_STOCK' END AS alert_type,
                GREATEST(i.reorder_quantity - COALESCE(SUM(cs.qty_on_hand), 0), 0)::numeric AS shortage
           FROM inventory_item i
           LEFT JOIN current_stock cs
             ON cs.inventory_item_id = i.id AND cs.clinic_id = $1
          WHERE i.clinic_id = $1 AND i.is_active = true
          GROUP BY i.id
         HAVING COALESCE(SUM(cs.qty_on_hand), 0) <= i.reorder_point
          ORDER BY
            CASE WHEN COALESCE(SUM(cs.qty_on_hand), 0) <= 0 THEN 0 ELSE 1 END ASC,
            i.name ASC`,
        [clinicId]
      );
      return res.json({ alerts: rows });
    } catch (err) { next(err); }
  }
);

// ── PUT /inventory/items/:id ──────────────────────────────────────────────────
// Update item metadata (name, category, reorder levels, active flag)
const updateItemSchema = Joi.object({
  name:             Joi.string().max(200).optional(),
  generic_name:     Joi.string().max(200).allow('', null).optional(),
  category:         Joi.string().valid('dental_material','implant','membrane','medication','disposable','equipment').optional(),
  unit:             Joi.string().max(20).optional(),
  is_traceable:     Joi.boolean().optional(),
  is_implant:       Joi.boolean().optional(),
  reorder_point:    Joi.number().min(0).optional(),
  reorder_quantity: Joi.number().min(0).optional(),
  is_active:        Joi.boolean().optional(),
});

router.put(
  '/inventory/items/:id',
  ...authChain,
  requirePermission(P.CLINIC_SETTINGS),
  validate(updateItemSchema),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const {
        name, generic_name, category, unit,
        is_traceable, is_implant, reorder_point, reorder_quantity, is_active,
      } = req.body;

      const { rows } = await db.query(
        `UPDATE inventory_item SET
           name             = COALESCE($1, name),
           generic_name     = COALESCE($2, generic_name),
           category         = COALESCE($3, category),
           unit             = COALESCE($4, unit),
           is_traceable     = COALESCE($5, is_traceable),
           is_implant       = COALESCE($6, is_implant),
           reorder_point    = COALESCE($7, reorder_point),
           reorder_quantity = COALESCE($8, reorder_quantity),
           is_active        = COALESCE($9, is_active),
           updated_at       = now()
         WHERE id = $10 AND clinic_id = $11
         RETURNING *`,
        [name ?? null, generic_name ?? null, category ?? null, unit ?? null,
         is_traceable ?? null, is_implant ?? null,
         reorder_point ?? null, reorder_quantity ?? null, is_active ?? null,
         req.params.id, clinicId]
      );
      if (!rows[0]) return next(createError(404, 'Item not found'));
      return res.json({ item: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── GET /inventory/movements ──────────────────────────────────────────────────
// Stock movement history with optional filters
router.get(
  '/inventory/movements',
  ...authChain,
  requirePermission(P.INVENTORY_ADJUST),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { item_id, from, to, type } = req.query;
      const limit = Math.min(parseInt(req.query.limit) || 200, 500);

      const conditions = ['m.clinic_id = $1'];
      const params     = [clinicId];
      let   idx        = 2;

      if (item_id) { conditions.push(`m.inventory_item_id = $${idx++}`); params.push(item_id); }
      if (from)    { conditions.push(`m.created_at >= $${idx++}`);        params.push(from); }
      if (to)      { conditions.push(`m.created_at < $${idx++}`);         params.push(to); }
      if (type)    { conditions.push(`m.movement_type = $${idx++}`);      params.push(type.toUpperCase()); }

      const { rows } = await db.query(
        `SELECT m.id, m.movement_type, m.direction, m.quantity,
                (m.direction * m.quantity)::numeric AS net_qty,
                m.source_type, m.created_at,
                i.name AS item_name, i.category, i.unit,
                b.lot_number, b.unit_cost
           FROM stock_movement m
           JOIN inventory_item i ON i.id = m.inventory_item_id
      LEFT JOIN inventory_batch b ON b.id = m.batch_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY m.created_at DESC
          LIMIT $${idx}`,
        [...params, limit]
      );
      return res.json({ movements: rows });
    } catch (err) { next(err); }
  }
);

// ── GET /inventory/value ──────────────────────────────────────────────────────
// Total on-hand inventory value (sum of qty × unit_cost per batch)
router.get(
  '/inventory/value',
  ...authChain,
  requirePermission(P.INVENTORY_ADJUST),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { rows: [result] } = await db.query(
        `SELECT COALESCE(SUM(cs.qty_on_hand * b.unit_cost), 0)::numeric AS total_value
           FROM current_stock cs
           JOIN inventory_batch b ON b.id = cs.batch_id
           JOIN inventory_item  i ON i.id = cs.inventory_item_id
          WHERE cs.clinic_id = $1 AND i.is_active = true`,
        [clinicId]
      );
      return res.json({ total_value: Number(result.total_value) });
    } catch (err) { next(err); }
  }
);

// ── Purchase Orders ───────────────────────────────────────────────────────────

const createPoSchema = Joi.object({
  supplier: Joi.string().max(200).allow('', null).optional(),
  notes:    Joi.string().max(1000).allow('', null).optional(),
  lines: Joi.array().items(Joi.object({
    inventory_item_id: Joi.string().uuid().required(),
    quantity:          Joi.number().positive().required(),
    unit:              Joi.string().max(20).required(),
    unit_cost:         Joi.number().min(0).allow(null).optional(),
    lot_number:        Joi.string().max(100).allow('', null).optional(),
    expiry_date:       Joi.string().isoDate().allow(null).optional(),
  })).min(1).required(),
});

// GET /inventory/purchase-orders
router.get(
  '/inventory/purchase-orders',
  ...authChain,
  requirePermission(P.INVENTORY_ADJUST),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { rows } = await db.query(
        `SELECT po.*, COUNT(pol.id)::int AS line_count
           FROM purchase_order po
      LEFT JOIN purchase_order_line pol ON pol.purchase_order_id = po.id
          WHERE po.clinic_id = $1
          GROUP BY po.id
          ORDER BY po.created_at DESC
          LIMIT 100`,
        [clinicId]
      );
      return res.json({ purchase_orders: rows });
    } catch (err) { next(err); }
  }
);

// GET /inventory/purchase-orders/:id
router.get(
  '/inventory/purchase-orders/:id',
  ...authChain,
  requirePermission(P.INVENTORY_ADJUST),
  async (req, res, next) => {
    try {
      const { clinicId } = req.context;
      const { rows: [po] } = await db.query(
        `SELECT * FROM purchase_order WHERE id=$1 AND clinic_id=$2`,
        [req.params.id, clinicId]
      );
      if (!po) return next(createError(404, 'Purchase order not found'));

      const { rows: lines } = await db.query(
        `SELECT pol.*, i.name AS item_name
           FROM purchase_order_line pol
           JOIN inventory_item i ON i.id = pol.inventory_item_id
          WHERE pol.purchase_order_id = $1
          ORDER BY pol.created_at ASC`,
        [po.id]
      );
      return res.json({ purchase_order: { ...po, lines } });
    } catch (err) { next(err); }
  }
);

// POST /inventory/purchase-orders
router.post(
  '/inventory/purchase-orders',
  ...authChain,
  requirePermission(P.CLINIC_SETTINGS),
  validate(createPoSchema),
  async (req, res, next) => {
    try {
      const { orgId, clinicId, userId } = req.context;
      const { supplier, notes, lines }  = req.body;

      const date      = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const suffix    = Math.random().toString(36).slice(2, 6).toUpperCase();
      const po_number = `PO-${date}-${suffix}`;

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: [po] } = await client.query(
          `INSERT INTO purchase_order (org_id, clinic_id, po_number, supplier, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [orgId, clinicId, po_number, supplier || null, notes || null, userId]
        );

        const lineRows = [];
        for (const line of lines) {
          const { rows: [l] } = await client.query(
            `INSERT INTO purchase_order_line
               (purchase_order_id, inventory_item_id, quantity, unit, unit_cost, lot_number, expiry_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [po.id, line.inventory_item_id, line.quantity, line.unit,
             line.unit_cost ?? null, line.lot_number || null, line.expiry_date || null]
          );
          lineRows.push(l);
        }

        await client.query('COMMIT');
        return res.status(201).json({ purchase_order: { ...po, lines: lineRows } });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) { next(err); }
  }
);

// PUT /inventory/purchase-orders/:id/status
const updatePoStatusSchema = Joi.object({
  action: Joi.string().valid('send', 'receive', 'cancel').required(),
});

router.put(
  '/inventory/purchase-orders/:id/status',
  ...authChain,
  requirePermission(P.CLINIC_SETTINGS),
  validate(updatePoStatusSchema),
  async (req, res, next) => {
    try {
      const { clinicId, userId } = req.context;
      const { action }           = req.body;

      const { rows: [po] } = await db.query(
        `SELECT * FROM purchase_order WHERE id=$1 AND clinic_id=$2`,
        [req.params.id, clinicId]
      );
      if (!po) return next(createError(404, 'Purchase order not found'));

      const validFrom = { send: ['draft'], receive: ['sent'], cancel: ['draft', 'sent'] };
      if (!validFrom[action].includes(po.status)) {
        return next(createError(409, `Cannot ${action} a PO with status '${po.status}'`));
      }

      if (action === 'receive') {
        const { rows: lines } = await db.query(
          `SELECT * FROM purchase_order_line WHERE purchase_order_id = $1`, [po.id]
        );
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');

          for (const line of lines) {
            const { rows: [batch] } = await client.query(
              `INSERT INTO inventory_batch
                 (inventory_item_id, clinic_id, lot_number, expiry_date,
                  initial_quantity, unit, unit_cost, supplier, received_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id`,
              [line.inventory_item_id, clinicId, line.lot_number, line.expiry_date,
               line.quantity, line.unit, line.unit_cost, po.supplier || null]
            );
            await client.query(
              `INSERT INTO stock_movement
                 (movement_type, inventory_item_id, batch_id, clinic_id, direction, quantity, source_type, actor_id)
               VALUES ('GOODS_RECEIPT',$1,$2,$3,1,$4,'purchase_order',$5)`,
              [line.inventory_item_id, batch.id, clinicId, line.quantity, userId]
            );
          }

          await client.query(
            `UPDATE purchase_order
                SET status='received', received_at=now(), updated_at=now()
              WHERE id=$1`,
            [po.id]
          );

          await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY current_stock`).catch(() =>
            client.query(`REFRESH MATERIALIZED VIEW current_stock`)
          );

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } else {
        const newStatus = action === 'send' ? 'sent' : 'cancelled';
        const extra     = action === 'send' ? ', ordered_at = now()' : '';
        await db.query(
          `UPDATE purchase_order SET status=$1${extra}, updated_at=now() WHERE id=$2`,
          [newStatus, po.id]
        );
      }

      const { rows: [updated] } = await db.query(
        `SELECT * FROM purchase_order WHERE id=$1`, [po.id]
      );
      return res.json({ purchase_order: updated });
    } catch (err) { next(err); }
  }
);

module.exports = router;
