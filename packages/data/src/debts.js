import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

export function listBranchDebts({ branchId, direction = 'all', status = null, page = 1, pageSize = 50 }) {
  return rpc('list_branch_debts', {
    p_branch_id: branchId,
    p_direction: direction,
    p_status: status,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
}
export const getBranchDebtSummary = branchId => rpc('get_branch_debt_summary', { p_branch_id: branchId });
export const getBranchDebt = id => rpc('get_branch_debt', { p_debt_id: id });
export const recordBranchDebtPayment = (
  { debtId, amount, currency, method, reference, notes },
  idempotencyKey = crypto.randomUUID(),
) => rpc('record_branch_debt_payment', {
  p_debt_id: debtId,
  p_amount: amount,
  p_currency: currency,
  p_method: method,
  p_reference: reference || null,
  p_notes: notes || null,
  p_idempotency_key: idempotencyKey,
});
