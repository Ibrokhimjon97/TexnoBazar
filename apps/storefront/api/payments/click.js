import { parseClickCallback } from '@texnobazar/server/click';
import { sha256 } from '@texnobazar/server/payments';
import { createAdmin, readForm, sendJson } from './_lib.js';

function responseBase(body, result) {
  return {
    click_trans_id: body?.click_trans_id ?? '',
    merchant_trans_id: body?.merchant_trans_id ?? '',
    merchant_prepare_id: body?.merchant_prepare_id ?? '0',
    merchant_confirm_id: body?.merchant_prepare_id ?? '0',
    ...result,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: -8, error_note: 'Method not allowed' });
  let body = {};
  try {
    body = await readForm(req);
    const parsed = parseClickCallback(body);
    if (parsed.error !== undefined) return sendJson(res, 200, responseBase(body, parsed));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.value.merchantTransId)) {
      return sendJson(res, 200, responseBase(body, { error: -5, error_note: 'User does not exist' }));
    }
    const admin = createAdmin();
    const requestHash = sha256({ provider: 'click', ...parsed.value });
    const { data, error } = await admin.rpc('click_process_callback', {
      p_click_trans_id: parsed.value.clickTransId,
      p_click_paydoc_id: parsed.value.clickPaydocId,
      p_order_id: parsed.value.merchantTransId,
      p_merchant_prepare_id: parsed.value.merchantPrepareId,
      p_amount_minor: parsed.value.amountMinor,
      p_action: parsed.value.action,
      p_provider_error: parsed.value.providerError,
      p_sign_time: parsed.value.signTime,
      p_request_hash: requestHash,
    });
    if (error) throw error;
    return sendJson(res, 200, data);
  } catch {
    return sendJson(res, 200, responseBase(body, { error: -8, error_note: 'Internal system error' }));
  }
}
