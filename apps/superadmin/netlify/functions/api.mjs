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

function buildCorsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && origin !== '*') {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  return headers;
}

export async function handler(event, context) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: '',
    };
  }

  let pathname = event.path || '';
  if (pathname.startsWith('/.netlify/functions/api')) {
    pathname = pathname.slice('/.netlify/functions/api'.length) || '/';
    if (!pathname.startsWith('/api')) {
      pathname = '/api' + (pathname.startsWith('/') ? pathname : '/' + pathname);
    }
  }
  pathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  const routeHandler = routes.get(pathname);
  if (!routeHandler) {
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'API route topilmadi.', code: 'NOT_FOUND' }),
    };
  }

  let bodyBuffer = Buffer.alloc(0);
  if (event.body) {
    bodyBuffer = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'binary');
  }

  const maxBytes = ROUTE_MAX_BODY_BYTES.get(pathname) ?? DEFAULT_MAX_BODY_BYTES;
  if (bodyBuffer.length > maxBytes) {
    return {
      statusCode: 413,
      headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'So‘rov hajmi juda katta.', code: 'BODY_TOO_LARGE' }),
    };
  }

  const qs = event.rawQuery || (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : '');
  const url = pathname + (qs ? `?${qs}` : '');

  const responseHeaders = { ...corsHeaders };
  let responseStatusCode = 200;
  let responseBody = '';

  const req = {
    method: event.httpMethod,
    url,
    headers: event.headers || {},
    body: bodyBuffer,
    async *[Symbol.asyncIterator]() {
      if (bodyBuffer.length) yield bodyBuffer;
    },
  };

  const res = {
    get statusCode() { return responseStatusCode; },
    set statusCode(code) { responseStatusCode = code; },
    getHeader(name) {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(responseHeaders)) {
        if (k.toLowerCase() === lower) return v;
      }
      return undefined;
    },
    hasHeader(name) {
      return this.getHeader(name) !== undefined;
    },
    setHeader(name, value) {
      responseHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value);
    },
    end(value = '') {
      responseBody = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    },
  };

  try {
    await routeHandler(req, res);
    return {
      statusCode: responseStatusCode,
      headers: responseHeaders,
      body: responseStatusCode === 204 ? '' : responseBody,
    };
  } catch (error) {
    console.error('Netlify API Lambda handler error', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Server amali bajarilmadi.', code: 'INTERNAL_ERROR' }),
    };
  }
}

export default async function apiAdapter(request, context) {
  if (request && typeof request.httpMethod === 'string') {
    return handler(request, context);
  }

  const origin = request.headers.get('origin') || '';
  const corsHeaders = buildCorsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const url = new URL(request.url);
  let pathname = url.pathname || '';
  if (pathname.startsWith('/.netlify/functions/api')) {
    pathname = pathname.slice('/.netlify/functions/api'.length) || '/';
    if (!pathname.startsWith('/api')) {
      pathname = '/api' + (pathname.startsWith('/') ? pathname : '/' + pathname);
    }
  }
  pathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const routeHandler = routes.get(pathname);
  if (!routeHandler) {
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
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body;
    },
  };
  const res = {
    statusCode: 200,
    getHeader(name) {
      return responseHeaders.get(name);
    },
    hasHeader(name) {
      return responseHeaders.has(name);
    },
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
    await routeHandler(req, res);
    if (!ended) return jsonResponse(500, { error: 'Handler javobni yakunlamadi.', code: 'INTERNAL_ERROR' });
    const emptyBody = request.method === 'HEAD' || request.method === 'OPTIONS' || [204, 304].includes(res.statusCode);
    return new Response(emptyBody ? null : responseBody, { status: res.statusCode, headers: responseHeaders });
  } catch (error) {
    console.error('Netlify API adapter error', error);
    return jsonResponse(500, { error: 'Server amali bajarilmadi.', code: 'INTERNAL_ERROR' });
  }
}

