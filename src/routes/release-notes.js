const express    = require('express');
const Joi        = require('joi');
const db         = require('../db');
const authenticate          = require('../middleware/authenticate');
const validate              = require('../middleware/validate');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P                     = require('../rbac/permissions.constants');

const router = express.Router();

const createSchema = Joi.object({
  version: Joi.string().max(20).required(),
  title:   Joi.string().max(200).required(),
  body:    Joi.string().required(),
  publish: Joi.boolean().default(false),
});

const updateSchema = Joi.object({
  title:   Joi.string().max(200).optional(),
  body:    Joi.string().optional(),
  publish: Joi.boolean().optional(),
}).min(1);

// ── GET /pending — latest published note not yet acked by the current user ────
router.get('/pending', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { rows } = await db.query(
      `SELECT rn.id, rn.version, rn.title, rn.body, rn.published_at
       FROM release_notes rn
       WHERE rn.is_published = true
         AND NOT EXISTS (
           SELECT 1 FROM user_release_acks a
           WHERE a.release_note_id = rn.id AND a.user_id = $1
         )
       ORDER BY rn.published_at DESC
       LIMIT 1`,
      [userId]
    );
    res.json({ note: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/ack — mark a release note as acknowledged ──────────────────────
router.post('/:id/ack', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { id }  = req.params;

    const { rows } = await db.query(
      `SELECT id FROM release_notes WHERE id = $1 AND is_published = true`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Release note not found' });

    await db.query(
      `INSERT INTO user_release_acks (user_id, release_note_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, release_note_id) DO NOTHING`,
      [userId, id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET / — list all release notes (org admin) ───────────────────────────────
router.get('/', authenticate, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, version, title, body, is_published, published_at, created_at
       FROM release_notes
       ORDER BY created_at DESC`
    );
    res.json({ notes: rows });
  } catch (err) {
    next(err);
  }
});

// ── POST / — create a new release note (org admin) ───────────────────────────
router.post('/', authenticate, requirePermission(P.ORG_MANAGE), validate(createSchema), async (req, res, next) => {
  try {
    const { version, title, body, publish } = req.body;
    const { rows } = await db.query(
      `INSERT INTO release_notes (version, title, body, is_published, published_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [version, title, body, publish, publish ? new Date() : null]
    );
    res.status(201).json({ note: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Version "${req.body.version}" already exists.` });
    next(err);
  }
});

// ── PATCH /:id — update / publish a release note (org admin) ─────────────────
router.patch('/:id', authenticate, requirePermission(P.ORG_MANAGE), validate(updateSchema), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, body, publish } = req.body;

    const { rows: existing } = await db.query(
      `SELECT id, is_published FROM release_notes WHERE id = $1`, [id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Release note not found' });

    const sets = [];
    const vals = [];

    if (title !== undefined) { vals.push(title); sets.push(`title = $${vals.length}`); }
    if (body  !== undefined) { vals.push(body);  sets.push(`body  = $${vals.length}`); }
    if (publish !== undefined) {
      vals.push(publish);
      sets.push(`is_published = $${vals.length}`);
      if (publish && !existing[0].is_published) {
        sets.push(`published_at = now()`);
      }
    }

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE release_notes SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    res.json({ note: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id — delete a draft note (org admin, unpublished only) ───────────
router.delete('/:id', authenticate, requirePermission(P.ORG_MANAGE), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM release_notes WHERE id = $1 AND is_published = false RETURNING id`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Draft not found or already published.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
