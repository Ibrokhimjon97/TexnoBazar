import { getAccessToken, getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args = {}) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

// The AI endpoints live on the superadmin deployment because that is where the
// server-side provider keys are available. Other apps point at it via env.
function getAiApiBase() {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    const hostname = window.location.hostname;
    const port = window.location.port;

    // 1. If running inside the admin app itself (local port 5174 or production admin domain), use relative path
    if (port === '5174' || hostname.includes('admin') || hostname.includes('superadmin')) {
      return '';
    }

    const isWindowLocal = hostname === 'localhost' || hostname === '127.0.0.1';
    const configured = (import.meta.env?.VITE_AI_API_BASE || import.meta.env?.VITE_API_BASE || '').trim().replace(/\/+$/, '');

    if (configured) {
      try {
        const parsed = new URL(configured, window.location.href);
        const isConfigLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

        // Never leak localhost into production web app
        if (isConfigLocal && !isWindowLocal) {
          return 'https://texnobazar-admin.netlify.app';
        }

        if (parsed.origin === origin) return '';

        // Local loopback alignment
        if (hostname === '127.0.0.1' && parsed.hostname === 'localhost') {
          return `http://127.0.0.1:${parsed.port || '5174'}`;
        }
        if (hostname === 'localhost' && parsed.hostname === '127.0.0.1') {
          return `http://localhost:${parsed.port || '5174'}`;
        }
        return configured;
      } catch {}
    }

    // Production default for other apps (manager, seller, etc.) calling superadmin
    if (!isWindowLocal) {
      return 'https://texnobazar-admin.netlify.app';
    }
    return 'http://localhost:5174';
  }
  return (import.meta.env?.VITE_AI_API_BASE || 'https://texnobazar-admin.netlify.app').replace(/\/+$/, '');
}

async function postApi(path, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi. Qaytadan tizimga kiring.');
  const base = getAiApiBase();
  const targetUrl = `${base}${path}`;
  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    throw new Error(`AI serveriga ulanishda xatolik (${targetUrl}): ${netErr?.message || 'Tarmoq xatosi'}`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `AI so‘rovi bajarilmadi (HTTP ${response.status}).`);
  }
  return result;
}

// --- Provider configuration (superadmin only) -------------------------------
export const listAiProviders = () => rpc('list_ai_providers');
export const saveAiProvider = provider => rpc('save_ai_provider', { p_provider: provider });
export const deleteAiProvider = id => rpc('delete_ai_provider', { p_id: id });
export const testAiProvider = (providerId, model = null) =>
  postApi('/api/ai/test-provider', { provider_id: providerId, model });

// Asks the provider which models the key can use. Pass providerId for a saved
// provider, or provider+apiKey while creating one (key is used, never stored here).
export const fetchAiProviderModels = ({ providerId = null, provider = null, apiKey = null, baseUrl = null }) =>
  postApi('/api/ai/list-models', providerId
    ? { provider_id: providerId }
    : { provider, api_key: apiKey, base_url: baseUrl });

// --- Assistant --------------------------------------------------------------
export const listAiModels = () => rpc('list_ai_models');
export const sendAiMessage = ({ message, providerId = null, model = null, conversationId = null }) =>
  postApi('/api/ai/chat', {
    message,
    provider_id: providerId,
    model,
    conversation_id: conversationId,
  });

export async function listAiConversations({ limit = 20 } = {}) {
  const { data, error } = await getBrowserClient()
    .from('ai_conversations')
    .select('id,title,model,updated_at,created_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throwDataError(error, 'listAiConversations');
  return data ?? [];
}

export async function listAiMessages(conversationId) {
  const { data, error } = await getBrowserClient()
    .from('ai_messages')
    .select('id,role,content,tool_calls,created_at')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true });
  if (error) throwDataError(error, 'listAiMessages');
  return (data ?? []).filter(row => row.role !== 'tool');
}

export async function deleteAiConversation(id) {
  const { error } = await getBrowserClient().from('ai_conversations').delete().eq('id', id);
  if (error) throwDataError(error, 'deleteAiConversation');
}

export async function listAiActionLog({ limit = 50, writesOnly = false } = {}) {
  let query = getBrowserClient()
    .from('ai_action_log')
    .select('id,tool_name,arguments,result,is_write,status,error,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (writesOnly) query = query.eq('is_write', true);
  const { data, error } = await query;
  if (error) throwDataError(error, 'listAiActionLog');
  return data ?? [];
}
