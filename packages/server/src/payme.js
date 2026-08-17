import { constantTimeEqual, httpsUrl, requiredEnv } from './payments.js';

export const PAYME_METHODS = new Set(['CheckPerformTransaction', 'CreateTransaction', 'PerformTransaction', 'CancelTransaction', 'CheckTransaction', 'GetStatement']);

export function paymeConfigured(env = process.env) {
  return ['PAYME_MERCHANT_ID', 'PAYME_KEY'].every(name => String(env[name] || '').trim());
}

export function verifyPaymeAuthorization(header, env = process.env) {
  const { PAYME_KEY } = requiredEnv(env, ['PAYME_KEY']);
  const match = String(header || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) return false;
  let decoded;
  try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return false; }
  return constantTimeEqual(decoded, `Paycom:${PAYME_KEY}`);
}

export function validatePaymeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'id')) {
    return { code: -32600, message: 'Invalid JSON-RPC request.' };
  }
  if (typeof body.method !== 'string' || !PAYME_METHODS.has(body.method)) {
    return { code: -32601, message: 'Method not found.', data: body.method };
  }
  if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
    return { code: -32600, message: 'Invalid JSON-RPC parameters.' };
  }
  return null;
}

export function buildPaymeCheckout({ orderId, amountMinor, env = process.env }) {
  const { PAYME_MERCHANT_ID } = requiredEnv(env, ['PAYME_MERCHANT_ID']);
  const url = httpsUrl(env.PAYME_CHECKOUT_URL, 'https://checkout.paycom.uz/');
  return {
    method: 'POST',
    url: url.toString(),
    fields: {
      merchant: PAYME_MERCHANT_ID,
      'account[order_id]': String(orderId),
      amount: String(amountMinor),
      lang: 'uz',
    },
  };
}

export function paymeError(id, code, message, data) {
  return { id: id ?? null, result: null, error: { code, message, ...(data === undefined || data === null ? {} : { data }) } };
}
