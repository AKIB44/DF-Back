'use strict';

// Patient-level file store — 3D models, DICOM scans, images, PDFs, video.
// S3-backed; mirrors the session-attachment presign flow. Mounted at
// /v1/patients/:patientId/files (mergeParams to read :patientId).

const express      = require('express');
const Joi          = require('joi');
const multer       = require('multer');
const { v4: uuidv4 } = require('uuid');
const db           = require('../db');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const tenantScope  = require('../rbac/tenant-scope.middleware');
const auditMw      = require('../audit/audit.middleware');
const { requirePermission } = require('../rbac/require-permission.middleware');
const P            = require('../rbac/permissions.constants');
const { getPresignedPutUrl, getPresignedUrl, deleteObject, getS3Client, uploadBuffer } = require('../services/s3Service');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

const router    = express.Router({ mergeParams: true });
const authChain = [authenticate, tenantScope, auditMw];
const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

const SIGN_TTL     = 300;   // 5 min to upload
const DOWNLOAD_TTL = 900;   // 15 min view link

const MODEL3D = new Set(['stl', 'obj', 'ply', 'glb', 'gltf', '3mf']);
const IMAGE   = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);
const VIDEO   = new Set(['mp4', 'webm', 'mov', 'ogg']);

function kindOf(filename, contentType) {
  const ext = (filename.includes('.') ? filename.split('.').pop() : '').toLowerCase();
  const ct  = (contentType || '').toLowerCase();
  if (MODEL3D.has(ext)) return 'model3d';
  if (ext === 'dcm' || ct === 'application/dicom') return 'dicom';
  if (ext === 'pdf' || ct === 'application/pdf') return 'pdf';
  if (IMAGE.has(ext) || ct.startsWith('image/')) return 'image';
  if (VIDEO.has(ext) || ct.startsWith('video/')) return 'video';
  return 'other';
}

async function assertPatient(req, res) {
  const { patientId } = req.params;
  const { rows } = await db.query(
    'SELECT id FROM patients WHERE id = $1 AND clinic_id = $2',
    [patientId, req.context.clinicId]
  );
  if (!rows.length) { res.status(404).json({ error: 'Patient not found' }); return false; }
  return true;
}

// ── GET / — list files for the patient (with presigned view URLs) ────────────
router.get('/', ...authChain, requirePermission(P.PATIENT_VIEW), async (req, res, next) => {
  try {
    if (!(await assertPatient(req, res))) return;
    const { rows } = await db.query(
      `SELECT id, filename, content_type, file_size, kind, notes, s3_key, created_at
         FROM patient_file
        WHERE patient_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [req.params.patientId]
    );
    const data = await Promise.all(rows.map(async (r) => ({
      id: r.id, filename: r.filename, content_type: r.content_type, file_size: r.file_size,
      kind: r.kind, notes: r.notes, created_at: r.created_at,
      url: await getPresignedUrl({ key: r.s3_key, expiresIn: DOWNLOAD_TTL }),
    })));
    res.json({ data });
  } catch (err) { next(err); }
});

// ── POST /sign — presigned PUT for a direct-to-S3 upload ─────────────────────
const signSchema = Joi.object({
  filename:     Joi.string().max(255).required(),
  content_type: Joi.string().max(128).default('application/octet-stream'),
});
router.post('/sign', ...authChain, requirePermission(P.PATIENT_UPDATE), validate(signSchema), async (req, res, next) => {
  try {
    if (!(await assertPatient(req, res))) return;
    const ext   = req.body.filename.includes('.') ? req.body.filename.split('.').pop().toLowerCase() : 'bin';
    const s3Key = `patients/${req.params.patientId}/files/${uuidv4()}.${ext}`;
    const upload_url = await getPresignedPutUrl({
      key: s3Key, contentType: req.body.content_type, expiresIn: SIGN_TTL,
    });
    res.json({ upload_url, s3_key: s3Key });
  } catch (err) { next(err); }
});

// ── POST / — register the file after the client uploads to S3 ────────────────
const registerSchema = Joi.object({
  s3_key:       Joi.string().max(512).required(),
  filename:     Joi.string().max(255).required(),
  content_type: Joi.string().max(128).default('application/octet-stream'),
  file_size:    Joi.number().integer().min(0).allow(null).optional(),
  notes:        Joi.string().max(1000).allow('', null).optional(),
});
router.post('/', ...authChain, requirePermission(P.PATIENT_UPDATE), validate(registerSchema), async (req, res, next) => {
  try {
    if (!(await assertPatient(req, res))) return;
    const b = req.body;
    const kind = kindOf(b.filename, b.content_type);
    const { rows } = await db.query(
      `INSERT INTO patient_file
         (org_id, clinic_id, patient_id, uploaded_by, s3_key, filename, content_type, file_size, kind, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, filename, content_type, file_size, kind, notes, s3_key, created_at`,
      [req.context.orgId, req.context.clinicId, req.params.patientId, req.context.userId,
       b.s3_key, b.filename, b.content_type, b.file_size ?? null, kind, b.notes || null]
    );
    const r = rows[0];
    res.status(201).json({
      data: {
        id: r.id, filename: r.filename, content_type: r.content_type, file_size: r.file_size,
        kind: r.kind, notes: r.notes, created_at: r.created_at,
        url: await getPresignedUrl({ key: r.s3_key, expiresIn: DOWNLOAD_TTL }),
      },
    });
  } catch (err) { next(err); }
});

// ── POST /upload — one-shot multipart upload through the backend ─────────────
// Same-origin (no S3 CORS). Backend streams the file to S3 and registers it.
router.post('/upload', ...authChain, requirePermission(P.PATIENT_UPDATE), upload.single('file'), async (req, res, next) => {
  try {
    if (!(await assertPatient(req, res))) return;
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file provided' });

    const contentType = f.mimetype || 'application/octet-stream';
    const ext   = f.originalname.includes('.') ? f.originalname.split('.').pop().toLowerCase() : 'bin';
    const s3Key = `patients/${req.params.patientId}/files/${uuidv4()}.${ext}`;
    await uploadBuffer({ key: s3Key, buffer: f.buffer, contentType, encrypt: true });

    const kind = kindOf(f.originalname, contentType);
    const { rows } = await db.query(
      `INSERT INTO patient_file
         (org_id, clinic_id, patient_id, uploaded_by, s3_key, filename, content_type, file_size, kind, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, filename, content_type, file_size, kind, notes, s3_key, created_at`,
      [req.context.orgId, req.context.clinicId, req.params.patientId, req.context.userId,
       s3Key, f.originalname, contentType, f.size, kind, (req.body && req.body.notes) || null]
    );
    const r = rows[0];
    res.status(201).json({
      data: {
        id: r.id, filename: r.filename, content_type: r.content_type, file_size: r.file_size,
        kind: r.kind, notes: r.notes, created_at: r.created_at,
        url: await getPresignedUrl({ key: r.s3_key, expiresIn: DOWNLOAD_TTL }),
      },
    });
  } catch (err) { next(err); }
});

// ── GET /:fileId/raw — stream bytes same-origin (for 3D/DICOM viewers) ───────
// Avoids S3 CORS + lets the auth interceptor protect the request.
router.get('/:fileId/raw', ...authChain, requirePermission(P.PATIENT_VIEW), async (req, res, next) => {
  try {
    if (!(await assertPatient(req, res))) return;
    const { rows } = await db.query(
      `SELECT s3_key, content_type FROM patient_file
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
      [req.params.fileId, req.params.patientId]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });

    const obj = await getS3Client().send(new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET, Key: rows[0].s3_key,
    }));
    res.setHeader('Content-Type', rows[0].content_type || 'application/octet-stream');
    if (obj.ContentLength) res.setHeader('Content-Length', obj.ContentLength);
    res.setHeader('Cache-Control', 'private, max-age=300');
    obj.Body.on('error', (e) => { if (!res.headersSent) res.status(502).end(); else res.destroy(e); });
    obj.Body.pipe(res);
  } catch (err) { next(err); }
});

// ── DELETE /:fileId — soft delete + remove from S3 (best-effort) ─────────────
router.delete('/:fileId', ...authChain, requirePermission(P.PATIENT_UPDATE), async (req, res, next) => {
  try {
    if (!(await assertPatient(req, res))) return;
    const { rows } = await db.query(
      `UPDATE patient_file SET deleted_at = now()
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL
        RETURNING s3_key`,
      [req.params.fileId, req.params.patientId]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    deleteObject({ key: rows[0].s3_key }).catch(() => {});
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
