import { buildClickCheckout, clickConfigured } from '@texnobazar/server/click';
import { buildPaymeCheckout, paymeConfigured } from '@texnobazar/server/payme';
import { PaymentApiError, apiError, createAdmin, optionalActor, readJson, sendJson } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    const provider = String(body.provider || '').toLowerCase();
    if (!['click', 'payme'].includes(provider)) throw new PaymentApiError(400, 'Unsupported payment provider.', 'INVALID_PROVIDER');
    if ((provider === 'click' && !clickConfigured()) || (provider === 'payme' && !paymeConfigured())) {
      throw new PaymentApiError(503, 'Selected payment provider is not configured.', 'PROVIDER_UNAVAILABLE');
    }
    const admin = createAdmin();
    const actorId = await optionalActor(admin, req);
    const { data, error } = await admin.rpc('create_online_payment_attempt', {
      p_order_id: body.orderId,
      p_provider: provider,
      p_checkout_token: body.checkoutToken || null,
      p_customer_user_id: actorId,
      p_idempotency_key: body.idempotencyKey,
    });
    if (error) throw error;
    const checkout = provider === 'click'
      ? buildClickCheckout({ orderId: data.order_id, amountMinor: Number(data.amount_minor) })
      : buildPaymeCheckout({ orderId: data.order_id, amountMinor: Number(data.amount_minor) });
    return sendJson(res, 200, { orderId: data.order_id, provider, state: data.state, checkout });
  } catch (error) { return apiError(res, error, 'Payment initiation failed.'); }
}
