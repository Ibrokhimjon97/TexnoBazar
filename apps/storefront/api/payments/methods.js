import { clickConfigured } from '@texnobazar/server/click';
import { paymeConfigured } from '@texnobazar/server/payme';
import { apiError, createAdmin, sendJson } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const admin = createAdmin();
    const { data, error } = await admin.rpc('storefront_payment_methods', {
      p_click_enabled: clickConfigured(),
      p_payme_enabled: paymeConfigured(),
    });
    if (error) throw error;
    return sendJson(res, 200, { methods: data || [] });
  } catch (error) { return apiError(res, error, 'Payment methods could not be loaded.'); }
}
