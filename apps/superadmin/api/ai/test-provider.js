import {
  ApiError, createServerSupabase, getActiveActor, getBearerToken,
  handleApiError, readJsonBody, sendJson,
} from '../_lib/auth.js';
import { callProvider } from '../_lib/ai-providers.js';
import { applyCors } from '../_lib/cors.js';

// Smoke-tests a stored provider key without exposing it: the admin gets back only
// whether the round-trip worked and what the model replied.
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
      throw new ApiError(403, 'AI provayderni sinash uchun global superadmin roli talab qilinadi.', 'FORBIDDEN');
    }

    const body = await readJsonBody(req);
    const providerId = String(body?.provider_id ?? '').trim();
    if (!providerId) throw new ApiError(400, 'provider_id talab qilinadi.', 'PROVIDER_REQUIRED');

    const { data: provider, error } = await admin.from('ai_providers')
      .select('id,provider,label,api_key,base_url,models,default_model')
      .eq('id', providerId).maybeSingle();
    if (error) throw error;
    if (!provider) throw new ApiError(404, 'AI provayder topilmadi.', 'NOT_FOUND');
    if (!provider.api_key?.trim()) throw new ApiError(400, 'Bu provayderda API kalit saqlanmagan.', 'NO_API_KEY');

    const requested = body?.model ? String(body.model) : null;
    const model = requested || provider.default_model
      || (Array.isArray(provider.models) ? provider.models[0] : null);
    if (!model) throw new ApiError(400, 'Sinash uchun model tanlanmagan.', 'NO_MODEL');

    const started = Date.now();
    const result = await callProvider({
      provider: provider.provider,
      apiKey: provider.api_key,
      baseUrl: provider.base_url,
      model,
      system: 'Sen test rejimidasan. Foydalanuvchiga bir qisqa gap bilan o‘zbek tilida javob ber.',
      messages: [{ role: 'user', content: 'Ulanish ishlayaptimi? Bir gap bilan tasdiqla.' }],
      tools: [],
    });

    return sendJson(res, 200, {
      ok: true,
      provider: provider.provider,
      label: provider.label,
      model,
      latency_ms: Date.now() - started,
      reply: (result.text || '').slice(0, 500),
    });
  } catch (error) {
    if (error instanceof ApiError) return handleApiError(res, error, 'Test bajarilmadi.');
    // Provider-side failures (bad key, wrong model, network) are expected here, so
    // surface the message as a soft result instead of a 500.
    return sendJson(res, 200, { ok: false, error: String(error?.message || error).slice(0, 500) });
  }
}
