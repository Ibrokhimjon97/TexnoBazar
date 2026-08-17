import { checkClickPayment, reverseClickPayment } from '@texnobazar/server/click';
import { sha256 } from '@texnobazar/server/payments';
import { createAdmin, cronAuthorized, sendJson } from './_lib.js';

async function finish(admin, item, outcome, providerId = null, responseHash = null, error = null) {
  const result = await admin.rpc('finish_payment_refund', {
    p_refund_id: item.id,
    p_lock_token: item.lock_token,
    p_outcome: outcome,
    p_provider_refund_id: providerId,
    p_response_hash: responseHash,
    p_error: error,
  });
  if (result.error) throw result.error;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' });
  if (!cronAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
  try {
    const admin = createAdmin();
    const claim = await admin.rpc('claim_payment_refund_batch', { p_provider: 'click', p_limit: 20 });
    if (claim.error) throw claim.error;
    const stats = { confirmed: 0, retry: 0, failed: 0, ambiguous: 0, persistence_failed: 0 };
    for (const item of claim.data || []) {
      if (!item.provider_payment_id) {
        try { await finish(admin, item, 'failed', null, null, 'Click payment ID is missing.'); stats.failed += 1; }
        catch { stats.persistence_failed += 1; }
        continue;
      }
      let result;
      if (item.operation === 'reconcile') {
        try {
          const status = await checkClickPayment({ paymentId: item.provider_payment_id });
          if (status.reversed) { await finish(admin, item, 'confirmed', status.id, sha256(status.payloadHashSource)); stats.confirmed += 1; }
          else if (status.paid) { await finish(admin, item, 'retry', null, sha256(status.payloadHashSource), 'Provider confirms payment is still active; reversal may be retried.'); stats.retry += 1; }
          else { await finish(admin, item, 'ambiguous', null, sha256(status.payloadHashSource), 'Click returned an unknown reconciliation status.'); stats.ambiguous += 1; }
        } catch (error) {
          try { await finish(admin, item, 'ambiguous', null, null, String(error?.message || 'Click reconciliation failed.').slice(0, 1000)); stats.ambiguous += 1; }
          catch { stats.persistence_failed += 1; }
        }
        continue;
      }
      try { result = await reverseClickPayment({ paymentId: item.provider_payment_id }); }
      catch (error) {
        const outcome = error?.ambiguous ? 'ambiguous' : error?.retryable ? 'retry' : 'failed';
        try { await finish(admin, item, outcome, null, null, String(error?.message || 'Click reversal failed.').slice(0, 1000)); stats[outcome] += 1; }
        catch { stats.persistence_failed += 1; }
        continue;
      }
      try { await finish(admin, item, 'confirmed', result.id, sha256(result.payloadHashSource)); stats.confirmed += 1; }
      catch { stats.persistence_failed += 1; }
    }
    return sendJson(res, 200, { ok: true, claimed: (claim.data || []).length, ...stats });
  } catch {
    return sendJson(res, 500, { error: 'Payment refund worker failed.' });
  }
}
