import { createClient } from '@supabase/supabase-js';
import { createCheckoutToken } from './storefront.js';
import { throwDataError } from './errors.js';
export * from './errors.js';
export * from './auth.js';
export * from './masterData.js';
export * from './products.js';
export * from './inventory.js';
export * from './transfers.js';
export * from './debts.js';
export * from './pos.js';
export * from './receipts.js';
export * from './storefront.js';
export * from './operations.js';
export * from './delivery.js';
export * from './admin.js';
export * from './realtime.js';

/**
 * Browser uchun Supabase client yaratadi. Bu modul faqat VITE_ bilan ochiq
 * qiymatlarni qabul qiladi; service/secret kalitlarini hech qachon bermang.
 * @param {{ url?: string, anonKey?: string, options?: import('@supabase/supabase-js').SupabaseClientOptions<'public'> }} [config]
 */
export function createBrowserClient(config = {}) {
  const url = config.url ?? import.meta.env?.VITE_SUPABASE_URL;
  const anonKey = config.anonKey ?? import.meta.env?.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('VITE_SUPABASE_URL va VITE_SUPABASE_ANON_KEY talab qilinadi.');
  }
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    ...config.options,
  });
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client */
export async function getConnectionStatus(client) {
  const startedAt = Date.now();
  try {
    const { data, error } = await client.rpc('app_schema_readiness');
    if (error) throwDataError(error, 'app_schema_readiness');
    const readiness = data && typeof data === 'object' ? data : {};
    return {
      ok: readiness.ok === true,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      schemaVersion: readiness.schema_version ?? null,
      missing: Array.isArray(readiness.missing) ? readiness.missing : [],
      ...(readiness.ok === true ? {} : { message: 'Ma’lumotlar bazasi migratsiyalari to‘liq qo‘llanmagan.' }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : 'Supabase bilan aloqa o‘rnatilmadi',
    };
  }
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client @param {object} payload */
export async function createOnlineOrder(client, payload) {
  const checkoutToken = payload.checkoutToken ?? createCheckoutToken();
  const { data, error } = await client.rpc('create_online_order_v2', {
    p_customer: payload.customer,
    p_shipping_address: payload.shippingAddress,
    p_lines: payload.lines,
    p_payment_method_code: payload.paymentMethodCode,
    p_idempotency_key: payload.idempotencyKey ?? crypto.randomUUID(),
    p_checkout_token: checkoutToken,
    p_notes: payload.notes ?? null,
  });
  if (error) throw error;
  return data;
}

/** @param {import('@supabase/supabase-js').SupabaseClient} client @param {object} payload */
export async function updateCourierDeliveryStatus(client, payload) {
  const { error } = await client.rpc('courier_update_delivery_status', {
    p_delivery_id: payload.deliveryId,
    p_status: payload.status,
    p_note: payload.note ?? null,
    p_proof_id: payload.proofId ?? null,
  });
  if (error) throw error;
}
