import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client, MAX_MEDIA_BYTES } from '../../../../packages/server/src/r2.js';
import {
  ApiError,
  createServerSupabase,
  getActiveActor,
  getBearerToken,
  handleApiError,
  requireCatalogPermission,
  sendJson,
} from '../_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'PUT' && req.method !== 'POST') {
    res.setHeader('Allow', 'PUT, POST');
    return sendJson(res, 405, { error: 'Faqat PUT yoki POST so‘rovi qabul qilinadi.', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const admin = createServerSupabase();
    const actor = await getActiveActor(admin, getBearerToken(req));
    await requireCatalogPermission(admin, actor.id);

    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = url.searchParams.get('key');
    if (!key || typeof key !== 'string') {
      throw new ApiError(400, 'R2 kaliti ko‘rsatilmagan.', 'KEY_REQUIRED');
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_MEDIA_BYTES) {
        throw new ApiError(400, 'Fayl hajmi 10MB dan oshmasligi kerak.', 'FILE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);
    const contentType = (req.headers['content-type'] || 'image/webp').split(';')[0].trim().toLowerCase();

    const client = createR2Client(process.env);
    const bucket = process.env.R2_BUCKET;
    if (!bucket) throw new Error('R2_BUCKET server muhiti sozlanmagan.');

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bodyBuffer,
        ContentType: contentType,
        ContentLength: bodyBuffer.length,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    res.statusCode = 204;
    return res.end();
  } catch (error) {
    return handleApiError(res, error, 'Rasmni R2 ga yuklab bo‘lmadi.');
  }
}
