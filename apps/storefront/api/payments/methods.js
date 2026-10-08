import { apiError, createAdmin, sendJson } from './_lib.js';

function clickConfigured(env = process.env) {
  return ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_MERCHANT_USER_ID', 'CLICK_SECRET_KEY', 'CLICK_RETURN_URL']
    .every(name => String(env[name] || '').trim());
}

function paymeConfigured(env = process.env) {
  return ['PAYME_MERCHANT_ID', 'PAYME_KEY'].every(name => String(env[name] || '').trim());
}

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
