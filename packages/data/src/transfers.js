import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

export const getTransferReferences = branchId => rpc('get_transfer_references', { p_branch_id: branchId });
export const findTransferUnit = (branchId, fromLocationId, code) => rpc('find_transfer_unit', {
  p_branch_id: branchId,
  p_from_location_id: fromLocationId,
  p_code: code,
});
export const searchTransferUnits = (branchId, fromLocationId, query, limit = 20) => rpc('search_transfer_units', {
  p_branch_id: branchId,
  p_from_location_id: fromLocationId,
  p_query: query,
  p_limit: limit,
});
export function createBranchTransfer(header, lines, initialPayment = null, keys = {}) {
  if (typeof initialPayment === 'string') {
    keys = { ...keys, transferKey: initialPayment };
    initialPayment = null;
  }
  return rpc('create_branch_transfer_with_payment', {
    p_header: header,
    p_lines: lines,
    p_initial_payment: initialPayment,
    p_transfer_idempotency_key: keys.transferKey || crypto.randomUUID(),
    p_payment_idempotency_key: initialPayment ? (keys.paymentKey || crypto.randomUUID()) : null,
  });
}
export function listBranchTransfers({ branchId, direction = 'all', status = null, query = null, page = 1, pageSize = 30 }) {
  return rpc('list_branch_transfers', {
    p_branch_id: branchId,
    p_direction: direction,
    p_status: status,
    p_query: query || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
}
export const getBranchTransfer = id => rpc('get_branch_transfer', { p_transfer_id: id });
export const approveBranchTransfer = id => rpc('approve_branch_transfer', { p_transfer_id: id });
export const shipBranchTransfer = id => rpc('ship_branch_transfer', { p_transfer_id: id });
export const receiveBranchTransfer = id => rpc('receive_branch_transfer', { p_transfer_id: id });
export const recordBranchTransferPayment = (
  { transferId, amount, currency, paidAt, method, reference, notes },
  idempotencyKey = crypto.randomUUID(),
) => rpc('record_branch_transfer_payment', {
  p_transfer_id: transferId,
  p_amount: amount,
  p_currency: currency,
  p_paid_at: paidAt || null,
  p_method: method,
  p_reference: reference || null,
  p_notes: notes || null,
  p_idempotency_key: idempotencyKey,
});

export const editBranchTransfer = (transferId, lines) => rpc('edit_branch_transfer', {
  p_transfer_id: transferId,
  p_lines: lines,
});
