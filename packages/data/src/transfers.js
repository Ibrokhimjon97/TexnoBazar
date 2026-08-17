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
export const createBranchTransfer = (header, lines, idempotencyKey = crypto.randomUUID()) => rpc('create_branch_transfer', {
  p_header: header,
  p_lines: lines,
  p_idempotency_key: idempotencyKey,
});
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
