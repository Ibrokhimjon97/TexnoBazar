import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from '@texnobazar/server/r2';
import {
  ApiError,
  createServerSupabase,
  getActiveActor,
  getBearerToken,
  handleApiError,
  readJsonBody,
  sendJson,
} from '../_lib/auth.js';
import { applyCors } from '../_lib/cors.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const admin = createServerSupabase();
    const token = getBearerToken(req);
    const actor = await getActiveActor(admin, token);

    // Verify actor has role superadmin, admin or manager
    const { data: roles, error: rolesError } = await admin
      .from('profile_roles')
      .select('role')
      .eq('profile_id', actor.id)
      .in('role', ['superadmin', 'admin', 'manager']);

    if (rolesError) throw rolesError;
    if (!roles || roles.length === 0) {
      throw new ApiError(403, 'Media tiklash uchun ruxsat yo‘q.', 'FORBIDDEN');
    }

    const body = await readJsonBody(req);
    const r2 = createR2Client();
    const bucket = process.env.R2_BUCKET;
    const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');

    // Support both single file and array of files
    const files = Array.isArray(body.files)
      ? body.files
      : body.key && body.base64
      ? [body]
      : [];

    if (!files.length) {
      throw new ApiError(400, 'Tiklanadigan rasm fayllari berilmadi.', 'INVALID_PAYLOAD');
    }

    const results = [];
    for (const item of files) {
      const { key, base64, contentType = 'image/jpeg' } = item;
      if (!key || !base64) continue;

      // Sanitize key
      const cleanKey = String(key).replace(/^\/+/, '');
      const buffer = Buffer.from(base64, 'base64');

      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: cleanKey,
          Body: buffer,
          ContentType: contentType,
          ContentLength: buffer.length,
          CacheControl: 'public, max-age=31536000, immutable',
        })
      );

      results.push({
        key: cleanKey,
        publicUrl: `${publicBaseUrl}/${cleanKey}`,
        bytes: buffer.length,
        ok: true,
      });
    }

    return sendJson(res, 200, {
      success: true,
      restored_count: results.length,
      files: results,
    });
  } catch (error) {
    return handleApiError(res, error, 'Media tiklanmadi.');
  }
}
