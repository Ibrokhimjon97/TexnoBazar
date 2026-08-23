import { createClient } from '@supabase/supabase-js';
import {
  ApiError, createServerSupabase, getActiveActor, getBearerToken,
  handleApiError, readJsonBody, sendJson,
} from '../_lib/auth.js';
import { AI_TOOLS, TOOL_BY_NAME, buildSystemPrompt } from '../_lib/ai-tools.js';
import { callProvider } from '../_lib/ai-providers.js';
import { applyCors } from '../_lib/cors.js';

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 20;

// Tools run under the caller's JWT so every RPC re-checks their role/branch access.
function createUserClient(token, env = process.env) {
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function requireAssistantAccess(admin, actorId) {
  const { data: roles, error } = await admin
    .from('profile_roles').select('role,branch_id')
    .eq('profile_id', actorId)
    .in('role', ['superadmin', 'admin', 'manager', 'accountant']);
  if (error) throw error;
  if (!roles?.length) {
    throw new ApiError(403, 'AI yordamchisi uchun admin yoki menejer roli talab qilinadi.', 'FORBIDDEN');
  }
  return roles;
}

async function loadProvider(admin, providerId) {
  const query = admin.from('ai_providers')
    .select('id,provider,label,api_key,base_url,models,default_model,is_active')
    .eq('is_active', true);
  const { data, error } = providerId
    ? await query.eq('id', providerId).maybeSingle()
    : await query.order('sort_order').limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiError(400, 'Faol AI provayder sozlanmagan. Superadmin panelda AI sozlamalarini to‘ldiring.', 'NO_PROVIDER');
  }
  if (!data.api_key?.trim()) {
    throw new ApiError(400, `"${data.label}" provayderida API kalit yo‘q.`, 'NO_API_KEY');
  }
  return data;
}

function resolveModel(provider, requested) {
  const allowed = Array.isArray(provider.models) ? provider.models.filter(Boolean).map(String) : [];
  if (requested) {
    // Only honour a client-supplied model if the admin whitelisted it.
    if (allowed.length && !allowed.includes(requested)) {
      throw new ApiError(400, `"${requested}" modeli bu provayder uchun ruxsat etilmagan.`, 'MODEL_NOT_ALLOWED');
    }
    return requested;
  }
  return provider.default_model || allowed[0] || null;
}

async function runTool(userClient, admin, { tool, args, actorId, conversationId }) {
  const params = tool.map(args ?? {});
  const { data, error } = await userClient.rpc(tool.rpc, params);

  const logRow = {
    conversation_id: conversationId ?? null,
    actor_id: actorId,
    tool_name: tool.name,
    arguments: args ?? {},
    is_write: Boolean(tool.write),
    status: error ? 'error' : 'ok',
    error: error ? String(error.message || error) : null,
    // Writes keep their full result for auditability; reads can be large, so store a marker only.
    result: error ? null : (tool.write ? data : { ok: true }),
  };
  admin.from('ai_action_log').insert(logRow).then(({ error: logError }) => {
    if (logError) console.error('ai_action_log insert failed', logError.message);
  });

  if (error) {
    return { ok: false, error: String(error.message || 'Tool bajarilmadi.') };
  }
  return { ok: true, data };
}

function truncateForModel(value, maxChars = 24_000) {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n…(natija qisqartirildi, aniqroq filtr bilan qayta so‘rang)`;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return undefined;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Faqat POST usuli qo‘llanadi.', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const token = getBearerToken(req);
    const admin = createServerSupabase();
    const actor = await getActiveActor(admin, token);
    const roles = await requireAssistantAccess(admin, actor.id);

    const body = await readJsonBody(req, { maxBytes: 256 * 1024 });
    const message = String(body?.message ?? '').trim();
    if (!message) throw new ApiError(400, 'Savol matni talab qilinadi.', 'MESSAGE_REQUIRED');
    if (message.length > 8000) throw new ApiError(400, 'Savol juda uzun.', 'MESSAGE_TOO_LONG');

    const provider = await loadProvider(admin, body?.provider_id ?? null);
    const model = resolveModel(provider, body?.model ? String(body.model) : null);
    if (!model) throw new ApiError(400, 'Model tanlanmagan va provayderda standart model yo‘q.', 'NO_MODEL');

    const userClient = createUserClient(token);

    // Conversation is optional: a missing/foreign id simply means "don't persist".
    let conversationId = body?.conversation_id ?? null;
    if (conversationId) {
      const { data: owned } = await admin.from('ai_conversations')
        .select('id').eq('id', conversationId).eq('owner_id', actor.id).maybeSingle();
      if (!owned) conversationId = null;
    }
    if (!conversationId) {
      const { data: created, error: createError } = await admin.from('ai_conversations')
        .insert({
          owner_id: actor.id,
          title: message.slice(0, 80),
          provider_id: provider.id,
          model,
        }).select('id').single();
      if (createError) throw createError;
      conversationId = created.id;
    }

    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', actor.id).maybeSingle();
    const { data: branchRows } = await userClient.rpc('ai_list_branches');
    const branches = Array.isArray(branchRows) ? branchRows.filter(b => b.can_access) : [];

    const system = buildSystemPrompt({
      actorName: profile?.full_name,
      roles: roles.map(r => ({ role: r.role, branch_name: branches.find(b => b.branch_id === r.branch_id)?.name })),
      branches,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()),
    });

    // Replay prior turns so the model can honour "yes, that one" style follow-ups.
    const { data: history } = await admin.from('ai_messages')
      .select('role,content,tool_calls,tool_name')
      .eq('conversation_id', conversationId)
      .order('id', { ascending: false })
      .limit(MAX_HISTORY);

    const messages = (history ?? []).reverse()
      .filter(row => row.role !== 'tool')
      .map(row => ({ role: row.role, content: row.content ?? '' }));
    messages.push({ role: 'user', content: message });

    await admin.from('ai_messages').insert({ conversation_id: conversationId, role: 'user', content: message });

    const toolTrace = [];
    let finalText = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const isLastRound = round === MAX_TOOL_ROUNDS;
      let result;
      try {
        result = await callProvider({
          provider: provider.provider,
          apiKey: provider.api_key,
          baseUrl: provider.base_url,
          model,
          system,
          messages,
          tools: isLastRound ? [] : AI_TOOLS,
        });
      } catch (providerError) {
        console.error('AI provider call failed', { provider: provider.provider, model, message: providerError?.message, status: providerError?.status });
        throw new ApiError(
          providerError?.status === 504 ? 504 : 502,
          `AI provayder xatosi: ${providerError?.message || 'Nomalum xato'}`,
          'PROVIDER_ERROR',
        );
      }

      if (!result.toolCalls?.length) {
        finalText = result.text || '';
        break;
      }

      messages.push({ role: 'assistant', content: result.text || '', toolCalls: result.toolCalls });

      for (const call of result.toolCalls) {
        const tool = TOOL_BY_NAME.get(call.name);
        if (!tool) {
          messages.push({
            role: 'tool', toolCallId: call.id, toolName: call.name,
            content: JSON.stringify({ ok: false, error: `Noma'lum tool: ${call.name}` }),
          });
          continue;
        }
        const outcome = await runTool(userClient, admin, {
          tool, args: call.args, actorId: actor.id, conversationId,
        });
        toolTrace.push({
          name: tool.name,
          is_write: Boolean(tool.write),
          ok: outcome.ok,
          error: outcome.ok ? null : outcome.error,
        });
        messages.push({
          role: 'tool', toolCallId: call.id, toolName: call.name,
          content: outcome.ok ? truncateForModel(outcome.data) : JSON.stringify({ ok: false, error: outcome.error }),
        });
      }
    }

    if (!finalText) {
      finalText = 'Javobni shakllantira olmadim. Savolni aniqroq qilib qayta yuboring.';
    }

    await admin.from('ai_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: finalText,
      tool_calls: toolTrace.length ? toolTrace : null,
    });
    await admin.from('ai_conversations').update({ updated_at: new Date().toISOString(), model }).eq('id', conversationId);

    return sendJson(res, 200, {
      conversation_id: conversationId,
      message: finalText,
      model,
      provider: provider.provider,
      provider_label: provider.label,
      tools_used: toolTrace,
    });
  } catch (error) {
    return handleApiError(res, error, 'AI javobini olishda xatolik yuz berdi.');
  }
}
