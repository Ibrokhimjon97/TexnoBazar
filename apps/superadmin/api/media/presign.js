import { createPresignedMediaPut } from '../../../../packages/server/src/r2.js';
import {
  ApiError,
  createServerSupabase,
  getActiveActor,
  getBearerToken,
  handleApiError,
  readJsonBody,
  requireCatalogPermission,
  sendJson,
} from '../_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Faqat POST so‘rovi qabul qilinadi.', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const admin = createServerSupabase();
    const actor = await getActiveActor(admin, getBearerToken(req));
    await requireCatalogPermission(admin, actor.id);
    const body = await readJsonBody(req);
    if (body?.scope !== 'products' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(body?.ownerId ?? ''))) {
      throw new ApiError(400, 'Mahsulot media ma’lumotlari noto‘g‘ri.', 'INVALID_MEDIA_OWNER');
    }
    // Actor already has catalog permission. Allow presigning for existing products or newly drafted ones.
    const result = await createPresignedMediaPut({
      contentType: body?.contentType,
      size: body?.size,
      scope: body?.scope,
      ownerId: body?.ownerId,
      uploaderId: actor.id,
    });
    return sendJson(res, 200, result);
  } catch (error) {
    return handleApiError(res, error, 'Media URL yaratilmadi.');
  }
}
