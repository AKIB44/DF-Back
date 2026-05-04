const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;

let cachedClient;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required S3 config: ${name}`);
  return value;
}

function getBucket(bucket) {
  return bucket || getRequiredEnv('AWS_S3_BUCKET');
}

function normalizeKey(key) {
  if (!key || typeof key !== 'string') {
    throw new Error('S3 object key is required');
  }
  return key.replace(/^\/+/, '');
}

function getS3Client() {
  if (cachedClient) return cachedClient;

  const config = {
    region: getRequiredEnv('AWS_REGION'),
  };

  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: getRequiredEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: getRequiredEnv('AWS_SECRET_ACCESS_KEY'),
    };
  }

  if (process.env.AWS_S3_ENDPOINT) {
    config.endpoint = process.env.AWS_S3_ENDPOINT;
  }

  if (process.env.AWS_S3_FORCE_PATH_STYLE === 'true') {
    config.forcePathStyle = true;
  }

  cachedClient = new S3Client(config);
  return cachedClient;
}

async function uploadBuffer({
  key,
  buffer,
  contentType = 'application/octet-stream',
  bucket,
  metadata,
  encrypt = true,
}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('uploadBuffer expects buffer to be a Buffer');
  }

  const command = new PutObjectCommand({
    Bucket: getBucket(bucket),
    Key: normalizeKey(key),
    Body: buffer,
    ContentType: contentType,
    Metadata: metadata,
    ServerSideEncryption: encrypt ? 'AES256' : undefined,
  });

  await getS3Client().send(command);
  return { bucket: getBucket(bucket), key: normalizeKey(key) };
}

async function getPresignedUrl({ key, bucket, expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS }) {
  const command = new GetObjectCommand({
    Bucket: getBucket(bucket),
    Key: normalizeKey(key),
  });

  return getSignedUrl(getS3Client(), command, { expiresIn });
}

async function objectExists({ key, bucket }) {
  try {
    await getS3Client().send(new HeadObjectCommand({
      Bucket: getBucket(bucket),
      Key: normalizeKey(key),
    }));
    return true;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}

async function deleteObject({ key, bucket }) {
  await getS3Client().send(new DeleteObjectCommand({
    Bucket: getBucket(bucket),
    Key: normalizeKey(key),
  }));
  return { bucket: getBucket(bucket), key: normalizeKey(key) };
}

function buildPrescriptionPdfKey({ patientId, prescriptionNo }) {
  if (!patientId) throw new Error('patientId is required for prescription PDF key');
  if (!prescriptionNo) throw new Error('prescriptionNo is required for prescription PDF key');
  return `prescriptions/${patientId}/${prescriptionNo}.pdf`;
}

function resetClientForTests() {
  cachedClient = undefined;
}

module.exports = {
  buildPrescriptionPdfKey,
  deleteObject,
  getPresignedUrl,
  getS3Client,
  objectExists,
  resetClientForTests,
  uploadBuffer,
};
