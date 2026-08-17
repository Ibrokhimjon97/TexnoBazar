import {
  ApiError,
  createServerSupabase,
  getActiveActor,
  getBearerToken,
  handleApiError,
  readJsonBody,
  sendJson,
} from '../_lib/auth.js';
import { createEmployee } from '../_lib/employees.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Faqat POST so‘rovi qabul qilinadi.', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new ApiError(415, 'Content-Type application/json bo‘lishi kerak.', 'UNSUPPORTED_MEDIA_TYPE');
    }
    const admin = createServerSupabase();
    const actor = await getActiveActor(admin, getBearerToken(req));
    const input = await readJsonBody(req);
    const employee = await createEmployee({ admin, actorId: actor.id, input });
    return sendJson(res, 201, { employee });
  } catch (error) {
    return handleApiError(res, error, 'Xodim yaratilmadi.');
  }
}
