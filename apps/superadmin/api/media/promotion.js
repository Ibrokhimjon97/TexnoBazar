import { createPresignedMediaPut, deleteMediaObject, getMediaObjectMetadata, MAX_MEDIA_BYTES, validateMediaInput } from '../../../../packages/server/src/r2.js';
import { ApiError, createServerSupabase, getActiveActor, getBearerToken, handleApiError, readJsonBody, requireCatalogPermission, sendJson } from '../_lib/auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

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
    const promotionId = String(body?.promotionId || '');
    if (!UUID.test(promotionId) || !['presign', 'complete', 'delete'].includes(body?.action)) {
      throw new ApiError(400, 'Aksiya media ma’lumotlari noto‘g‘ri.', 'INVALID_PROMOTION_MEDIA');
    }

    if (body.action === 'presign') {
      validateMediaInput({ contentType: body.contentType, size: body.size });
      const signed = await createPresignedMediaPut({
        contentType: body.contentType, size: body.size, scope: 'promotions', ownerId: promotionId, uploaderId: actor.id,
      });
      return sendJson(res, 200, signed);
    }

    if (typeof body.key !== 'string' || !body.key.startsWith(`promotions/${promotionId}/`)) {
      throw new ApiError(400, 'R2 kaliti aksiyaga tegishli emas.', 'INVALID_PROMOTION_KEY');
    }

    if (body.action === 'complete') {
      const meta = await getMediaObjectMetadata(body.key);
      if (!meta.contentType || !meta.size || meta.size > MAX_MEDIA_BYTES) {
        throw new ApiError(400, 'Aksiya rasmi yaroqsiz.', 'INVALID_PROMOTION_MEDIA');
      }
      validateMediaInput({ contentType: meta.contentType, size: meta.size });
      const publicBase = String(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (!publicBase.startsWith('https://')) throw new ApiError(500, 'R2 public manzili sozlanmagan.', 'R2_PUBLIC_URL_MISSING');
      return sendJson(res, 201, { publicUrl: `${publicBase}/${body.key}`, key: body.key });
    }

    await deleteMediaObject(body.key);
    return sendJson(res, 200, { deleted: true });
  } catch (error) {
    return handleApiError(res, error, 'Aksiya media amali bajarilmadi.');
  }
}
