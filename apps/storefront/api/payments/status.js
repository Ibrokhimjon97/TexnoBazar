import { apiError, createAdmin, optionalActor, readJson, sendJson } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    const admin = createAdmin();
    const actorId = await optionalActor(admin, req);
    const { data, error } = await admin.rpc('get_online_payment_status', {
      p_order_id: body.orderId,
      p_checkout_token: body.checkoutToken || null,
      p_customer_user_id: actorId,
    });
    if (error) throw error;
    return sendJson(res, 200, data);
  } catch (error) { return apiError(res, error, 'Payment status could not be loaded.'); }
}
