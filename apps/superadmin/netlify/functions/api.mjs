import createEmployee from '../../api/employees/create.js';
import presignMedia from '../../api/media/presign.js';
import uploadMedia from '../../api/media/upload.js';
import completeMedia from '../../api/media/complete.js';
import deleteMedia from '../../api/media/delete.js';
import deliveryProof from '../../api/media/delivery-proof.js';
import bannerMedia from '../../api/media/banner.js';
import cleanupMedia from '../../api/media/cleanup.js';
import promotionMedia from '../../api/media/promotion.js';
import dispatchReceipts from '../../api/receipts/dispatch.js';
import telegramWebhook from '../../api/telegram/webhook.js';
import aiChat from '../../api/ai/chat.js';
import aiTestProvider from '../../api/ai/test-provider.js';
import aiListModels from '../../api/ai/list-models.js';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
// Chat turns and file uploads carry larger payloads.
const ROUTE_MAX_BODY_BYTES = new Map([
  ['/api/ai/chat', 256 * 1024],
  ['/api/media/upload', 12 * 1024 * 1024],
]);
const routes = new Map([
  ['/api/employees/create', createEmployee],
  ['/api/media/presign', presignMedia],
  ['/api/media/upload', uploadMedia],
  ['/api/media/complete', completeMedia],
  ['/api/media/delete', deleteMedia],
  ['/api/media/delivery-proof', deliveryProof],
  ['/api/media/banner', bannerMedia],
  ['/api/media/cleanup', cleanupMedia],
  ['/api/media/promotion', promotionMedia],
  ['/api/receipts/dispatch', dispatchReceipts],
  ['/api/telegram/webhook', telegramWebhook],
  ['/api/ai/chat', aiChat],
  ['/api/ai/test-provider', aiTestProvider],
  ['/api/ai/list-models', aiListModels],
]);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readLimitedBody(request, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.body) return Buffer.alloc(0);
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new RangeError('BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new RangeError('BODY_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export default async function apiAdapter(request) {
  const origin = request.headers.get('origin') || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const handler = routes.get(pathname);
  if (!handler) {
    return new Response(JSON.stringify({ error: 'API route topilmadi.', code: 'NOT_FOUND' }), {
      status: 404,
      headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
    });
  }

  let body;
  try {
    body = await readLimitedBody(request, ROUTE_MAX_BODY_BYTES.get(pathname) ?? DEFAULT_MAX_BODY_BYTES);
  } catch {
    return new Response(JSON.stringify({ error: 'So‘rov hajmi juda katta.', code: 'BODY_TOO_LARGE' }), {
      status: 413,
      headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const responseHeaders = new Headers();
  for (const [k, v] of Object.entries(corsHeaders)) {
    responseHeaders.set(k, v);
  }
  let responseBody = '';
  let ended = false;
  const req = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
    ...(body.length ? { body } : {}),
    async *[Symbol.asyncIterator]() {},
  };
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.delete(name);
      for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(item));
    },
    end(value = '') {
      ended = true;
      responseBody = Buffer.isBuffer(value) ? value : String(value);
    },
  };

  try {
    await handler(req, res);
    if (!ended) return jsonResponse(500, { error: 'Handler javobni yakunlamadi.', code: 'INTERNAL_ERROR' });
    const emptyBody = request.method === 'HEAD' || request.method === 'OPTIONS' || [204, 304].includes(res.statusCode);
    return new Response(emptyBody ? null : responseBody, { status: res.statusCode, headers: responseHeaders });
  } catch (error) {
    console.error('Netlify API adapter error', error);
    return jsonResponse(500, { error: 'Server amali bajarilmadi.', code: 'INTERNAL_ERROR' });
  }
}

export const config = { path: '/api/*' };
