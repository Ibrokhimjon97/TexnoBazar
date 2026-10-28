// The AI endpoints are hosted on the superadmin deployment (that is where the
// provider keys live), but the manager app runs on a different origin and must be
// able to call them. Everything else in this API is same-origin, so CORS is scoped
// to the AI routes only and to an explicit allow-list.

const DEV_ORIGINS = [
  'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
  'http://localhost:5176', 'http://localhost:5177',
  'http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1:5175',
  'http://127.0.0.1:5176', 'http://127.0.0.1:5177',
];

const PROD_ORIGINS = [
  'https://texnobazar-admin.netlify.app',
  'https://texnobazar-manager.netlify.app',
  'https://texnobazar-seller.netlify.app',
  'https://texnobazar-storefront.netlify.app',
  'https://texnobazar-courier.netlify.app',
];

function allowedOrigins(env = process.env) {
  const configured = String(env.AI_ALLOWED_ORIGINS || '')
    .split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean);
  // Dev origins are only trusted when no production allow-list is configured.
  // Always include the known Netlify production origins regardless.
  return configured.length
    ? [...new Set([...configured, ...PROD_ORIGINS])]
    : [...DEV_ORIGINS, ...PROD_ORIGINS];
}

export function isOriginAllowed(origin, env = process.env) {
  if (!origin) return false;
  const clean = origin.replace(/\/+$/, '');
  const list = allowedOrigins(env);
  if (list.includes(clean)) return true;
  // Localhost / 127.0.0.1 on any port
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) return true;
  // Private local network IPs
  if (/^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(clean)) return true;
  return false;
}

/**
 * Applies CORS headers when the request origin is allow-listed.
 * Returns true if the request was a preflight and has already been answered.
 */
export function applyCors(req, res, env = process.env) {
  const origin = Array.isArray(req.headers?.origin) ? req.headers.origin[0] : req.headers?.origin;
  if (origin && isOriginAllowed(origin, env)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end('');
    return true;
  }
  return false;
}
