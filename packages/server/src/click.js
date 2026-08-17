import { createHash } from 'node:crypto';
import { constantTimeEqual, decimalToMinor, httpsUrl, minorToDecimal, requiredEnv } from './payments.js';

const CLICK_FIELDS = ['click_trans_id', 'service_id', 'click_paydoc_id', 'merchant_trans_id', 'amount', 'action', 'error', 'error_note', 'sign_time', 'sign_string'];

export function clickConfigured(env = process.env) {
  return ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_MERCHANT_USER_ID', 'CLICK_SECRET_KEY', 'CLICK_RETURN_URL'].every(name => String(env[name] || '').trim());
}

export function parseClickCallback(body, env = process.env) {
  const config = requiredEnv(env, ['CLICK_SERVICE_ID', 'CLICK_SECRET_KEY']);
  if (!body || typeof body !== 'object' || CLICK_FIELDS.some(field => body[field] === undefined || body[field] === null)) {
    return { error: -8, error_note: 'Error in request from Click' };
  }
  const action = Number(body.action);
  if (![0, 1].includes(action) || (action === 1 && (body.merchant_prepare_id === undefined || body.merchant_prepare_id === null))) {
    return { error: -3, error_note: 'Action not found' };
  }
  if (!constantTimeEqual(String(body.service_id), config.CLICK_SERVICE_ID)) {
    return { error: -8, error_note: 'Service does not match' };
  }
  const signatureInput = `${body.click_trans_id}${body.service_id}${config.CLICK_SECRET_KEY}${body.merchant_trans_id}${action === 1 ? body.merchant_prepare_id : ''}${body.amount}${body.action}${body.sign_time}`;
  const expected = createHash('md5').update(signatureInput).digest('hex');
  if (!constantTimeEqual(String(body.sign_string).toLowerCase(), expected)) {
    return { error: -1, error_note: 'SIGN CHECK FAILED!' };
  }
  try {
    return {
      value: {
        clickTransId: String(body.click_trans_id),
        clickPaydocId: String(body.click_paydoc_id),
        merchantTransId: String(body.merchant_trans_id),
        merchantPrepareId: action === 1 ? String(body.merchant_prepare_id) : null,
        amountMinor: decimalToMinor(body.amount),
        action,
        providerError: Number(body.error),
        signTime: String(body.sign_time),
      },
    };
  } catch {
    return { error: -2, error_note: 'Incorrect parameter amount' };
  }
}

export function buildClickCheckout({ orderId, amountMinor, env = process.env }) {
  const config = requiredEnv(env, ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_RETURN_URL']);
  const returnUrl = httpsUrl(config.CLICK_RETURN_URL);
  const url = httpsUrl(env.CLICK_CHECKOUT_URL, 'https://my.click.uz/services/pay');
  url.searchParams.set('service_id', config.CLICK_SERVICE_ID);
  url.searchParams.set('merchant_id', config.CLICK_MERCHANT_ID);
  url.searchParams.set('amount', minorToDecimal(amountMinor));
  url.searchParams.set('transaction_param', String(orderId));
  url.searchParams.set('return_url', returnUrl.toString());
  return { method: 'GET', url: url.toString(), fields: {} };
}

export async function reverseClickPayment({ paymentId, env = process.env, timeoutMs = 10_000 }) {
  const config = requiredEnv(env, ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_USER_ID', 'CLICK_SECRET_KEY']);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(paymentId))) throw new TypeError('Click payment ID is invalid.');
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHash('sha1').update(`${timestamp}${config.CLICK_SECRET_KEY}`).digest('hex');
  const endpoint = httpsUrl(env.CLICK_MERCHANT_API_URL, 'https://api.click.uz/v2/merchant/');
  const url = new URL(`payment/reversal/${encodeURIComponent(config.CLICK_SERVICE_ID)}/${encodeURIComponent(String(paymentId))}`, endpoint);
  let response;
  try {
    response = await fetch(url, {
      method: 'DELETE',
      headers: { Accept: 'application/json', Auth: `${config.CLICK_MERCHANT_USER_ID}:${digest}:${timestamp}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error('Click reversal outcome is ambiguous.', { cause });
    error.ambiguous = true;
    throw error;
  }
  let payload;
  try { payload = await response.json(); } catch {
    const error = new Error('Click reversal returned an unreadable response.');
    error.ambiguous = response.ok;
    error.retryable = !response.ok && response.status >= 500;
    throw error;
  }
  if (response.ok && Number(payload?.error_code) === 0) {
    return { id: String(payload.payment_id ?? paymentId), payloadHashSource: payload };
  }
  const error = new Error(String(payload?.error_note || `Click reversal failed with HTTP ${response.status}.`));
  error.retryable = response.status >= 500;
  throw error;
}

export async function checkClickPayment({ paymentId, env = process.env, timeoutMs = 10_000 }) {
  const config = requiredEnv(env, ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_USER_ID', 'CLICK_SECRET_KEY']);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(paymentId))) throw new TypeError('Click payment ID is invalid.');
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHash('sha1').update(`${timestamp}${config.CLICK_SECRET_KEY}`).digest('hex');
  const endpoint = httpsUrl(env.CLICK_MERCHANT_API_URL, 'https://api.click.uz/v2/merchant/');
  const url = new URL(`payment/status/${encodeURIComponent(config.CLICK_SERVICE_ID)}/${encodeURIComponent(String(paymentId))}`, endpoint);
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', Auth: `${config.CLICK_MERCHANT_USER_ID}:${digest}:${timestamp}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const error = new Error('Click payment status could not be reconciled.', { cause }); error.ambiguous = true; throw error;
  }
  let payload;
  try { payload = await response.json(); } catch { const error = new Error('Click status returned an unreadable response.'); error.ambiguous = true; throw error; }
  if (!response.ok || Number(payload?.error_code) !== 0) {
    const error = new Error(String(payload?.error_note || `Click status failed with HTTP ${response.status}.`)); error.retryable = response.status >= 500; throw error;
  }
  const status = Number(payload.status);
  return { reversed: status === -99, paid: status > 0, id: String(payload.payment_id ?? paymentId), payloadHashSource: payload };
}
