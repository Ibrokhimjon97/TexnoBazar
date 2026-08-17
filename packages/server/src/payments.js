import { createHash, timingSafeEqual } from 'node:crypto';

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function decimalToMinor(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new TypeError('Amount must be a non-negative decimal with at most two fraction digits.');
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount is too large.');
  return Number(minor);
}

export function minorToDecimal(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new TypeError('Minor amount must be a non-negative safe integer.');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export function requiredEnv(env, names) {
  const values = {};
  for (const name of names) {
    const value = String(env[name] ?? '').trim();
    if (!value) throw new Error(`Server payment configuration is incomplete: ${name}.`);
    values[name] = value;
  }
  return values;
}

export function httpsUrl(value, fallback) {
  const url = new URL(String(value || fallback));
  if (url.protocol !== 'https:') throw new Error('Payment endpoint must use HTTPS.');
  return url;
}
