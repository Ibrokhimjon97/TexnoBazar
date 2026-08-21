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
    const { data: product, error: productError } = await admin.from('products').select('id').eq('id', body.ownerId).maybeSingle();
    if (productError) throw productError;
    if (!product) throw new ApiError(404, 'Mahsulot topilmadi.', 'PRODUCT_NOT_FOUND');
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
