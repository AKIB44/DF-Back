const express  = require('express');
const multer   = require('multer');
const Joi      = require('joi');
const db       = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { uploadBuffer, getPresignedUrl, deleteObject, objectExists } = require('../services/s3Service');

const authChain = [authenticate, tenantScope, auditMw];

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024 },   // 2 MB
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Only JPEG, PNG, or WebP images are accepted'), { status: 400 }));
  },
});

const LOGO_URL_TTL = Number(process.env.AWS_S3_SIGNED_URL_TTL_SECONDS || 900);

async function clinicWithLogoUrl(row) {
  if (!row) return row;
  const clinic = { ...row };
  if (clinic.logo_s3_key) {
    try {
      clinic.logo_url = await getPresignedUrl({ key: clinic.logo_s3_key, expiresIn: LOGO_URL_TTL });
    } catch {
      clinic.logo_url = null;
    }
  }
  return clinic;
}

const updateSchema = Joi.object({
  name:    Joi.string().required(),
  phone:   Joi.string().required(),
  email:   Joi.string().email().required(),
  address: Joi.string().required(),
  city:    Joi.string().required(),
  state:   Joi.string().optional().allow(''),
});

// ─── Public endpoint — no auth ────────────────────────────────────────────────

router.get('/public', async (req, res, next) => {
  try {
    let id = process.env.DEFAULT_CLINIC_ID;
    if (!id) {
      const first = await db.query(
        `SELECT id FROM clinics WHERE is_active = true ORDER BY created_at ASC LIMIT 1`
      );
      if (first.rows.length) id = first.rows[0].id;
    }
    if (!id) return res.status(404).json({ error: 'No clinic available for public booking' });

    const result = await db.query(
      `SELECT id, name, city, phone, email FROM clinics WHERE id=$1 AND is_active=true`, [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ clinic: result.rows[0] });
  } catch (err) { next(err); }
});

// ─── Authenticated routes (all roles) ────────────────────────────────────────

router.get('/', ...authChain, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT * FROM clinics WHERE id=$1`, [req.user.clinic_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ clinic: await clinicWithLogoUrl(result.rows[0]) });
  } catch (err) { next(err); }
});

// ─── Admin-only routes ────────────────────────────────────────────────────────

router.use(...authChain, requirePermission(P.CLINIC_SETTINGS));

router.put('/', validate(updateSchema), async (req, res, next) => {
  try {
    const { name, phone, email, address, city, state } = req.body;
    const result = await db.query(
      `UPDATE clinics SET name=$1, phone=$2, email=$3, address=$4, city=$5, state=$6
       WHERE id=$7 RETURNING *`,
      [name, phone, email, address, city, state || null, req.user.clinic_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ clinic: await clinicWithLogoUrl(result.rows[0]) });
  } catch (err) { next(err); }
});

// ─── Logo upload ──────────────────────────────────────────────────────────────

router.post('/logo', upload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No logo file uploaded' });

    const ext    = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const s3Key  = `clinics/${req.user.clinic_id}/logo.${ext}`;

    // Delete old logo if different key exists
    const existing = await db.query(
      `SELECT logo_s3_key FROM clinics WHERE id=$1`, [req.user.clinic_id]
    );
    const oldKey = existing.rows[0]?.logo_s3_key;
    if (oldKey && oldKey !== s3Key) {
      try { await deleteObject({ key: oldKey }); } catch (_) {}
    }

    await uploadBuffer({
      key:         s3Key,
      buffer:      req.file.buffer,
      contentType: req.file.mimetype,
      encrypt:     false,           // logos are not sensitive
      metadata:    { clinic_id: req.user.clinic_id },
    });

    await db.query(
      `UPDATE clinics SET logo_s3_key=$1 WHERE id=$2`,
      [s3Key, req.user.clinic_id]
    );

    const logoUrl = await getPresignedUrl({ key: s3Key, expiresIn: LOGO_URL_TTL });
    res.json({ logo_url: logoUrl, logo_s3_key: s3Key });
  } catch (err) { next(err); }
});

router.delete('/logo', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT logo_s3_key FROM clinics WHERE id=$1`, [req.user.clinic_id]
    );
    const key = result.rows[0]?.logo_s3_key;
    if (key) {
      try { await deleteObject({ key }); } catch (_) {}
      await db.query(`UPDATE clinics SET logo_s3_key=NULL WHERE id=$1`, [req.user.clinic_id]);
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
