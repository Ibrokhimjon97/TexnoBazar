import { getAccessToken, getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args = {}) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

// The AI endpoints live on the superadmin deployment because that is where the
// server-side provider keys are available. Other apps point at it via env.
const AI_API_BASE = (import.meta.env?.VITE_AI_API_BASE || '').replace(/\/+$/, '');

async function postApi(path, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi.');
  const response = await fetch(`${AI_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'AI so‘rovi bajarilmadi.');
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
