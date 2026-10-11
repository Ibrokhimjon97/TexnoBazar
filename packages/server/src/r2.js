import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

export const ALLOWED_MEDIA_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
});
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 300;

function requireValue(value, name) {
  if (!value) throw new Error(`${name} server muhiti qiymati talab qilinadi.`);
  return value;
}

export function createR2Client(env = process.env) {
  const accountId = requireValue(env.R2_ACCOUNT_ID, 'R2_ACCOUNT_ID');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireValue(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: requireValue(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
    },
  });
}

export function validateMediaInput({ contentType, size }) {
  const extension = ALLOWED_MEDIA_TYPES[contentType];
  if (!extension) throw new TypeError('Faqat JPEG, PNG, WebP yoki AVIF rasm yuklash mumkin.');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_BYTES) {
    throw new RangeError(`Fayl hajmi 1-${MAX_MEDIA_BYTES} bayt oralig‘ida bo‘lishi kerak.`);
  }
  return extension;
}

export function sanitizeKeyPart(value) {
  const clean = String(value ?? '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return clean || 'media';
}

export function createMediaKey({ scope = 'products', ownerId = 'shared', contentType }) {
  const extension = ALLOWED_MEDIA_TYPES[contentType];
  if (!extension) throw new TypeError('Noto‘g‘ri media turi.');
  return `${sanitizeKeyPart(scope)}/${sanitizeKeyPart(ownerId)}/${randomUUID()}.${extension}`;
}

export async function createPresignedMediaPut(input, env = process.env) {
  validateMediaInput(input);
  const key = createMediaKey(input);
  const bucket = requireValue(env.R2_BUCKET, 'R2_BUCKET');
  const client = createR2Client(env);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: input.contentType,
    ContentLength: input.size,
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: { uploader: sanitizeKeyPart(input.uploaderId ?? 'unknown') },
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: PRESIGN_TTL_SECONDS });
  const publicBaseUrl = requireValue(env.R2_PUBLIC_BASE_URL, 'R2_PUBLIC_BASE_URL').replace(/\/$/, '');
  return { key, uploadUrl, publicUrl: `${publicBaseUrl}/${key}`, expiresIn: PRESIGN_TTL_SECONDS };
}

export async function deleteMediaObject(key, env = process.env) {
  const normalized = String(key ?? '');
  if (!/^[a-z0-9_-]+\/[a-z0-9_-]+\/[0-9a-f-]+\.(?:jpg|png|webp|avif)$/.test(normalized)) {
    throw new TypeError('R2 kaliti noto‘g‘ri.');
  }
  await createR2Client(env).send(new DeleteObjectCommand({
    Bucket: requireValue(env.R2_BUCKET, 'R2_BUCKET'),
    Key: normalized,
  }));
}

export async function getMediaObjectMetadata(key, env = process.env) {
  const normalized = String(key ?? '');
  if (!/^(?:products|delivery-proofs|banners|promotions)\/[0-9a-f-]{36}\/[0-9a-f-]+\.(?:jpg|png|webp|avif)$/.test(normalized)) {
    throw new TypeError('R2 media kaliti noto‘g‘ri.');
  }
  const result = await createR2Client(env).send(new HeadObjectCommand({
    Bucket: requireValue(env.R2_BUCKET, 'R2_BUCKET'), Key: normalized,
  }));
  return { contentType: result.ContentType, size: result.ContentLength };
}
