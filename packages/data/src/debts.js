import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

export function listBranchDebts({ branchId, direction = 'all', status = null, page = 1, pageSize = 50 }) {
  return rpc('list_branch_debts', {
    p_branch_id: branchId || null,
    p_direction: direction,
    p_status: status,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
}
export const getBranchDebtSummary = branchId => rpc('get_branch_debt_summary', { p_branch_id: branchId || null });
export const getBranchDebt = id => rpc('get_branch_debt', { p_debt_id: id });
export const recordBranchDebtPayment = (
  { debtId, amount, currency, method, reference, notes, payerBranchId = null },
  idempotencyKey = crypto.randomUUID(),
) => rpc('record_branch_debt_payment', {
  p_debt_id: debtId,
  p_amount: amount,
  p_currency: currency,
  p_method: method,
  p_reference: reference || null,
  p_notes: notes || null,
  p_idempotency_key: idempotencyKey,
  p_payer_branch_id: payerBranchId || null,
});

export const registerBranchDebt = ({
  creditorBranchId,
  debtorBranchId = null,
  targetBranchName,
  amount,
  currency = 'USD',
  notes = null,
}) => rpc('register_branch_debt', {
  p_creditor_branch_id: creditorBranchId,
  p_debtor_branch_id: debtorBranchId,
  p_target_branch_name: targetBranchName,
  p_amount: amount,
  p_currency: currency,
  p_notes: notes,
});

export const confirmBranchDebt = debtId => rpc('confirm_branch_debt', { p_debt_id: debtId });
export const confirmBranchDebtPayment = paymentId => rpc('confirm_branch_debt_payment', { p_payment_id: paymentId });
export const rejectBranchDebtPayment = (paymentId, reason = null) => rpc('reject_branch_debt_payment', { p_payment_id: paymentId, p_reason: reason });

export const registerSupplierDebt = ({
  supplierId = null,
  supplierName = null,
  amount,
  currency = 'USD',
  notes = null,
  branchId = null,
}) => rpc('register_supplier_debt', {
  p_supplier_id: supplierId,
  p_supplier_name: supplierName,
  p_amount: amount,
  p_currency: currency,
  p_notes: notes,
  p_branch_id: branchId,
});


