import { createClient } from '@supabase/supabase-js';

export class PaymentApiError extends Error {
  constructor(status, message, code = 'PAYMENT_API_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createAdmin(env = process.env) {
  const url = String(env.VITE_SUPABASE_URL || '').trim();
  const key = String(env.SUPABASE_SECRET_KEY || '').trim();
  if (!url || !key) throw new Error('Supabase server payment configuration is incomplete.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req, { maxBytes = 32 * 1024 } = {}) {
  if (req.body !== undefined) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new PaymentApiError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  const body = await readBody(req);
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (!String(body || '').trim()) throw new PaymentApiError(400, 'JSON body is required.', 'BODY_REQUIRED');
  return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
}

export async function readForm(req) {
  const body = await readBody(req);
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  return Object.fromEntries(new URLSearchParams(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')));
}

export async function optionalActor(admin, req) {
  const header = Array.isArray(req.headers?.authorization) ? req.headers.authorization[0] : req.headers?.authorization;
  if (!header) return null;
  const match = String(header).match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw new PaymentApiError(401, 'Invalid authorization header.', 'INVALID_SESSION');
  const { data, error } = await admin.auth.getUser(match[1]);
  if (error || !data.user) throw new PaymentApiError(401, 'Session is invalid.', 'INVALID_SESSION');
  return data.user.id;
}

export function apiError(res, error, fallback = 'Payment service failed.') {
  if (error instanceof PaymentApiError) return sendJson(res, error.status, { error: error.message, code: error.code });
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return sendJson(res, 400, { error: error.message, code: 'INVALID_INPUT' });
  const diagnostic = {
    name: String(error?.name || 'Error'),
    code: String(error?.code || 'INTERNAL_ERROR'),
    message: String(error?.message || fallback).slice(0, 500),
  };
  console.error(fallback, diagnostic);
  return sendJson(res, 500, { error: fallback, code: 'INTERNAL_ERROR' });
}

export function cronAuthorized(req, env = process.env) {
  const expected = String(env.PAYMENT_REFUND_CRON_SECRET || env.CRON_SECRET || '');
  const header = Array.isArray(req.headers?.authorization) ? req.headers.authorization[0] : req.headers?.authorization;
  const actual = String(header || '').replace(/^Bearer\s+/i, '');
  if (!expected || !actual || expected.length !== actual.length) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) different |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return different === 0;
}
