import {
  ApiError, createServerSupabase, getActiveActor, getBearerToken,
  handleApiError, readJsonBody, sendJson,
} from '../_lib/auth.js';
import { fetchProviderModels } from '../_lib/ai-providers.js';
import { applyCors } from '../_lib/cors.js';

// Returns the models the given key can actually use, so the settings UI can offer a
// real dropdown instead of a hand-typed list that goes stale.
//
// Two modes:
//   * provider_id  -> uses the stored key (nothing secret crosses the wire)
//   * provider + api_key -> for a provider being created, before it is saved
export default async function handler(req, res) {
  if (applyCors(req, res)) return undefined;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Faqat POST usuli qo‘llanadi.', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const token = getBearerToken(req);
    const admin = createServerSupabase();
    const actor = await getActiveActor(admin, token);

    const { data: roles, error: roleError } = await admin.from('profile_roles')
      .select('role,branch_id').eq('profile_id', actor.id).eq('role', 'superadmin');
    if (roleError) throw roleError;
    if (!roles?.some(r => r.branch_id === null)) {
      throw new ApiError(403, 'Model ro‘yxatini olish uchun global superadmin roli talab qilinadi.', 'FORBIDDEN');
    }

    const body = await readJsonBody(req);
    const providerId = String(body?.provider_id ?? '').trim();

    let provider;
    let apiKey;
    let baseUrl;

    if (providerId) {
      const { data, error } = await admin.from('ai_providers')
        .select('provider,api_key,base_url').eq('id', providerId).maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, 'AI provayder topilmadi.', 'NOT_FOUND');
      provider = data.provider;
      apiKey = data.api_key;
      baseUrl = data.base_url;
    } else {
      provider = String(body?.provider ?? '').trim();
      apiKey = String(body?.api_key ?? '').trim();
      baseUrl = String(body?.base_url ?? '').trim() || null;
      if (!provider) throw new ApiError(400, 'provider talab qilinadi.', 'PROVIDER_REQUIRED');
      if (!apiKey) throw new ApiError(400, 'API kalit talab qilinadi.', 'API_KEY_REQUIRED');
    }

    if (!apiKey?.trim()) throw new ApiError(400, 'Bu provayderda API kalit saqlanmagan.', 'NO_API_KEY');

    const models = await fetchProviderModels({ provider, apiKey, baseUrl });
    return sendJson(res, 200, { ok: true, provider, models });
  } catch (error) {
    if (error instanceof ApiError) return handleApiError(res, error, 'Model ro‘yxati olinmadi.');
    // A rejected key or an unreachable endpoint is an expected outcome here, so report
    // it as a soft failure the UI can render inline rather than a 500.
    return sendJson(res, 200, { ok: false, error: String(error?.message || error).slice(0, 500) });
  }
}
