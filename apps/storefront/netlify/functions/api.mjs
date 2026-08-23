import paymentMethods from '../../api/payments/methods.js';
import paymentInitiate from '../../api/payments/initiate.js';
import paymentStatus from '../../api/payments/status.js';
import paymentClick from '../../api/payments/click.js';
import paymentPayme from '../../api/payments/payme.js';
import paymentRefunds from '../../api/payments/refunds.js';
import robots from '../../api/robots.js';
import sitemap from '../../api/sitemap.js';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const routes = new Map([
  ['/api/payments/methods', paymentMethods],
  ['/api/payments/initiate', paymentInitiate],
  ['/api/payments/status', paymentStatus],
  ['/api/payments/click', paymentClick],
  ['/api/payments/payme', paymentPayme],
  ['/api/payments/refunds', paymentRefunds],
  ['/api/robots', robots],
  ['/api/sitemap', sitemap],
]);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
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
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const handler = routes.get(pathname);
  if (!handler) return jsonResponse(404, { error: 'API route topilmadi.', code: 'NOT_FOUND' });

  let body;
  try {
    body = await readLimitedBody(request);
  } catch {
    return jsonResponse(413, { error: 'So\'rov hajmi juda katta.', code: 'BODY_TOO_LARGE' });
  }

  const responseHeaders = new Headers();
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
      responseBody = value;
    },
    writeHead(status, headers) {
      res.statusCode = status;
      if (headers) Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
    },
  };

  try { await handler(req, res); } catch (error) {
    console.error('Storefront API adapter error:', error);
    if (!ended) return jsonResponse(500, { error: 'Internal server error.', code: 'INTERNAL_ERROR' });
  }
  return new Response(responseBody || '', { status: res.statusCode, headers: responseHeaders });
}
