import { paymeError, validatePaymeRequest, verifyPaymeAuthorization } from '@texnobazar/server/payme';
import { sha256 } from '@texnobazar/server/payments';
import { createAdmin, readJson, sendJson } from './_lib.js';

export default async function handler(req, res) {
  let body = null;
  if (req.method !== 'POST') return sendJson(res, 200, paymeError(null, -32300, 'Only POST is supported.'));
  try { body = await readJson(req); }
  catch { return sendJson(res, 200, paymeError(null, -32700, 'JSON parse error.')); }
  if (!verifyPaymeAuthorization(req.headers?.authorization)) return sendJson(res, 200, paymeError(body.id, -32504, 'Insufficient privilege.'));
  const validation = validatePaymeRequest(body);
  if (validation) return sendJson(res, 200, paymeError(body.id, validation.code, validation.message, validation.data));
  try {
    const admin = createAdmin();
    const requestHash = sha256({ method: body.method, params: body.params });
    const { data, error } = await admin.rpc('payme_process_request', { p_method: body.method, p_params: body.params, p_request_hash: requestHash });
    if (error) throw error;
    if (data?.error) return sendJson(res, 200, { id: body.id, result: null, error: data.error });
    return sendJson(res, 200, { id: body.id, result: data?.result ?? null });
  } catch {
    return sendJson(res, 200, paymeError(body.id, -32400, 'Internal system error.'));
  }
}
