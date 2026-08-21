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
  if (!['POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'POST, DELETE');
    return sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new ApiError(415, 'Content-Type application/json required.', 'UNSUPPORTED_MEDIA_TYPE');
    }
    const admin = createServerSupabase();
    const actor = await getActiveActor(admin, getBearerToken(req));
    const input = await readJsonBody(req);

    if (req.method === 'DELETE') {
      if (!input.employeeId) {
        throw new ApiError(400, 'employeeId talab qilinadi.', 'INVALID_INPUT');
      }
      // Delete role assignments first
      await admin.from('profile_roles').delete().eq('profile_id', input.employeeId);
      // Deactivate profile (soft delete in DB due to FK constraints)
      await admin.from('profiles').update({ is_active: false }).eq('id', input.employeeId);
      // Delete auth user
      const { error: authErr } = await admin.auth.admin.deleteUser(input.employeeId);
      if (authErr) throw authErr;
      return sendJson(res, 200, { success: true });
    }

    const employee = await createEmployee({ admin, actorId: actor.id, input });
    return sendJson(res, 201, { employee });
  } catch (error) {
    return handleApiError(res, error, 'Amal bajarilmadi.');
  }
}
