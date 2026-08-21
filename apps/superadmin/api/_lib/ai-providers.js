// Provider adapters.
//
// Three wire formats cover every provider we support:
//   * OpenAI chat-completions  -> openai, groq, kimi (moonshot), deepseek, openrouter, custom
//   * Anthropic messages       -> anthropic
//   * Gemini generateContent   -> gemini
//
// Each adapter normalises to the same internal shape so the tool loop in chat.js
// stays provider-agnostic:
//   request:  { system, messages: [{role:'user'|'assistant'|'tool', ...}], tools }
//   response: { text, toolCalls: [{ id, name, args }] }

const DEFAULT_BASE = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  kimi: 'https://api.moonshot.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export const PROVIDER_FAMILY = {
  openai: 'openai',
  groq: 'openai',
  kimi: 'openai',
  deepseek: 'openai',
  openrouter: 'openai',
  custom: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
};

export const SUGGESTED_MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'],
  gemini: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  kimi: ['moonshot-v1-128k', 'moonshot-v1-32k'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['openai/gpt-4o', 'anthropic/claude-3.7-sonnet'],
  custom: [],
};

function baseUrlFor(provider, configured) {
  const trimmed = configured?.replace(/\/+$/, '');
  return trimmed || DEFAULT_BASE[provider] || null;
}

async function postJson(url, headers, body, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!response.ok) {
      const detail = json?.error?.message || json?.message || text?.slice(0, 400) || `HTTP ${response.status}`;
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    return json;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('AI provayder javob bermadi (timeout).');
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// --- OpenAI-compatible ------------------------------------------------------
function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      });
    } else {
      out.push({ role: message.role, content: message.content ?? '' });
    }
  }
  return out;
}

async function callOpenAi({ provider, apiKey, baseUrl, model, system, messages, tools }) {
  const url = `${baseUrlFor(provider, baseUrl)}/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (provider === 'openrouter') headers['X-Title'] = 'Texnobazar AI';

  const body = {
    model,
    messages: toOpenAiMessages(system, messages),
    temperature: 0.2,
  };
  if (tools?.length) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const json = await postJson(url, headers, body);
  const choice = json?.choices?.[0]?.message;
  const toolCalls = (choice?.tool_calls ?? [])
    .filter(call => call?.function?.name)
    .map(call => {
      let args = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
      return { id: call.id, name: call.function.name, args };
    });
  return { text: choice?.content ?? '', toolCalls };
}

// --- Anthropic --------------------------------------------------------------
function toAnthropicMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
      });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: message.role, content: message.content ?? '' });
    }
  }
  return out;
}

async function callAnthropic({ apiKey, baseUrl, model, system, messages, tools }) {
  const url = `${baseUrlFor('anthropic', baseUrl)}/messages`;
  const body = {
    model,
    system,
    max_tokens: 4096,
    temperature: 0.2,
    messages: toAnthropicMessages(messages),
  };
  if (tools?.length) {
    body.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  const json = await postJson(url, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }, body);

  let text = '';
  const toolCalls = [];
  for (const block of json?.content ?? []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
  }
  return { text, toolCalls };
}

// --- Gemini -----------------------------------------------------------------
// Gemini has no tool_call ids, so we correlate by function name instead.
function toGeminiContents(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      let parsed;
      try { parsed = JSON.parse(message.content); } catch { parsed = { result: message.content }; }
      out.push({
        role: 'user',
        parts: [{ functionResponse: { name: message.toolName, response: { result: parsed } } }],
      });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
      }
      out.push({ role: 'model', parts });
    } else {
      out.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content ?? '' }] });
    }
  }
  return out;
}

// Gemini rejects JSON-Schema keywords it does not know, so strip to the subset it accepts.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required?.length) out.required = schema.required;
  return out;
}

async function callGemini({ apiKey, baseUrl, model, system, messages, tools }) {
  const url = `${baseUrlFor('gemini', baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  };
  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map(tool => {
        const declaration = { name: tool.name, description: tool.description };
        const params = toGeminiSchema(tool.parameters);
        // Gemini errors on an OBJECT schema with no properties; omit it instead.
        if (params?.properties && Object.keys(params.properties).length) declaration.parameters = params;
        return declaration;
      }),
    }];
  }

  const json = await postJson(url, { 'x-goog-api-key': apiKey }, body);
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  let text = '';
  const toolCalls = [];
  for (const part of parts) {
    if (part.text) text += part.text;
    else if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${part.functionCall.name}-${toolCalls.length}`,
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      });
    }
  }
  return { text, toolCalls };
}

export async function callProvider(config) {
  const family = PROVIDER_FAMILY[config.provider] || 'openai';
  if (family === 'anthropic') return callAnthropic(config);
  if (family === 'gemini') return callGemini(config);
  return callOpenAi(config);
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------
// Hardcoded model lists go stale fast (providers retire and rename models, and
// availability differs per account/plan). So we ask each provider for the list its
// key can actually use, and the admin picks from that.

async function getJson(url, headers, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!response.ok) {
      const detail = json?.error?.message || json?.message || text?.slice(0, 400) || `HTTP ${response.status}`;
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    return json;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('Provayder model ro‘yxatini bermadi (timeout).');
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI-style /models also returns embeddings, audio and image models that cannot
// serve chat completions, so filter the obvious non-chat families out.
const NON_CHAT_PATTERN = /(embedding|embed|whisper|tts|audio|dall-e|dalle|image|moderation|rerank|guard|davinci|babbage|curie|ada-|search|similarity|edit)/i;

function sortModels(ids) {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export async function fetchProviderModels({ provider, apiKey, baseUrl }) {
  const family = PROVIDER_FAMILY[provider] || 'openai';

  if (family === 'gemini') {
    const json = await getJson(`${baseUrlFor('gemini', baseUrl)}/models?pageSize=200`, { 'x-goog-api-key': apiKey });
    const ids = (json?.models ?? [])
      // Only models that can answer a chat turn.
      .filter(model => (model.supportedGenerationMethods ?? []).includes('generateContent'))
      // Gemini returns "models/gemini-x"; our request path adds the prefix itself.
      .map(model => String(model.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .filter(id => !NON_CHAT_PATTERN.test(id));
    return sortModels(ids);
  }

  if (family === 'anthropic') {
    const json = await getJson(`${baseUrlFor('anthropic', baseUrl)}/models?limit=100`, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });
    return sortModels((json?.data ?? []).map(model => String(model.id || '')).filter(Boolean));
  }

  const json = await getJson(`${baseUrlFor(provider, baseUrl)}/models`, { Authorization: `Bearer ${apiKey}` });
  const ids = (json?.data ?? json?.models ?? [])
    .map(model => String(model?.id || model?.name || ''))
    .filter(Boolean)
    .filter(id => !NON_CHAT_PATTERN.test(id));
  return sortModels(ids);
}
