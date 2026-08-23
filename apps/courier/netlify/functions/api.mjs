import deliveryProof from '../../api/media/delivery-proof.js';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

const routes = new Map([
  ['/api/media/delivery-proof', deliveryProof],
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
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const handler = routes.get(pathname);
  if (!handler) return jsonResponse(404, { error: 'API route topilmadi.', code: 'NOT_FOUND' });

  let body;
  try {
    body = await readLimitedBody(request);
  } catch {
    return jsonResponse(413, { error: 'So‘rov hajmi juda katta.', code: 'BODY_TOO_LARGE' });
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
      responseBody = Buffer.isBuffer(value) ? value : String(value);
    },
  };

  try {
    await handler(req, res);
    if (!ended) return jsonResponse(500, { error: 'Handler javobni yakunlamadi.', code: 'INTERNAL_ERROR' });
    const emptyBody = request.method === 'HEAD' || request.method === 'OPTIONS' || [204, 304].includes(res.statusCode);
    return new Response(emptyBody ? null : responseBody, { status: res.statusCode, headers: responseHeaders });
  } catch (error) {
    console.error('Courier API adapter error', error);
    return jsonResponse(500, { error: 'Server amali bajarilmadi.', code: 'INTERNAL_ERROR' });
  }
}

export const config = { path: '/api/*' };
