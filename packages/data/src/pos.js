import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name, args) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

export const getPosReferences = branchId => rpc('get_pos_references', { p_branch_id: branchId });
export const findPosUnit = (branchId, code) => rpc('find_pos_unit', { p_branch_id: branchId, p_code: code });
export const getPosUnitContext = (branchId, code) => rpc('get_pos_unit_context', { p_branch_id: branchId, p_code: code });
export const getPosProductAvailability = (branchId, productId) => rpc('get_pos_product_availability', { p_branch_id: branchId, p_product_id: productId });
export const relocatePosUnits = (branchId, codes, direction, requestId = crypto.randomUUID()) => rpc('pos_relocate_units', { p_branch_id: branchId, p_codes: codes, p_direction: direction, p_request_id: requestId });
export function listPosUnits({ branchId, query = null, page = 1, pageSize = 30 }) {
  return rpc('list_pos_units', { p_branch_id: branchId, p_query: query || null, p_limit: pageSize, p_offset: (page - 1) * pageSize });
}
export function createPosPendingSale({ branchId, lines, payments, notes = null, customer = null }, idempotencyKey = crypto.randomUUID()) {
  return rpc('create_pos_pending_sale', { p_branch_id: branchId, p_lines: lines, p_payments: payments, p_idempotency_key: idempotencyKey, p_notes: notes || null, p_customer: customer || null });
}
export function updatePosPendingSale({ pendingId, lines, payments, notes = null, customer = null }) {
  return rpc('update_pos_pending_sale', { p_pending_id: pendingId, p_lines: lines, p_payments: payments, p_notes: notes || null, p_customer: customer || null });
}
export const releaseExpiredPosSales = branchId => rpc('release_expired_pos_sales', { p_branch_id: branchId });
export const getPosPendingSale = id => rpc('get_pos_pending_sale', { p_pending_id: id });
export function listPosPendingSales({
  branchId,
  status = null,
  query = null,
  page = 1,
  pageSize = 30,
  startDate = null,
  endDate = null,
  paymentFilter = null,
  sortBy = null
}) {
  return rpc('list_pos_pending_sales', {
    p_branch_id: branchId,
    p_status: status || null,
    p_query: query || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
    p_start_date: startDate || null,
    p_end_date: endDate || null,
    p_payment_filter: paymentFilter || null,
    p_sort_by: sortBy || null
  });
}
export const rejectPosPendingSale = (id, reason) => rpc('reject_pos_pending_sale', { p_pending_id: id, p_reason: reason });
export const confirmPosSale = (id, payments = null, customer = null, notes = null) =>
  rpc('manager_confirm_sale', {
    p_pending_sale_id: id,
    p_payments: payments,
    p_customer: customer,
    p_notes: notes || null
  });
export function listMyPosSales({ branchId, date = null, query = null, page = 1, pageSize = 100 }) {
  return rpc('list_my_pos_sales_filtered', { p_branch_id: branchId, p_date: date || null, p_query: query || null, p_limit: pageSize, p_offset: (page - 1) * pageSize });
}
export function listMyPosPendingSalesByDate({ branchId, date = null, page = 1, pageSize = 100 }) {
  return rpc('list_my_pos_pending_sales_by_date', { p_branch_id: branchId, p_date: date || null, p_limit: pageSize, p_offset: (page - 1) * pageSize });
}
export const getSaleReceipt = id => rpc('get_safe_sale_receipt', { p_sale_id: id });
export async function getPendingSaleReceipt(pendingSaleId) {
  const saleId = await confirmPosSale(pendingSaleId, null);
  if (!saleId) throw new Error('Ushbu kassa so‘rovi uchun tasdiqlangan sotuv topilmadi');
  return getSaleReceipt(saleId);
}
export const getPosBatchUnits = (branchId, code, count = 1, excludeIds = [], preferLocation = null) =>
  rpc('get_pos_batch_units', { p_branch_id: branchId, p_code: code, p_count: count, p_exclude_ids: excludeIds, p_prefer_location: preferLocation });

export const updateConfirmedSalePayments = ({ pendingSaleId, payments, delivery = null }) =>
  rpc('manager_update_sale_payments', {
    p_pending_sale_id: pendingSaleId,
    p_payments: payments,
    p_delivery: delivery,
  });

export const addPosCashExpense = ({ branchId, amount, note, category = 'other', date = null, paymentMethod = 'cash' }) =>
  rpc('add_pos_cash_expense', {
    p_branch_id: branchId,
    p_amount: Number(amount),
    p_note: note,
    p_category: category,
    p_date: date || null,
    p_payment_method: paymentMethod || 'cash'
  });

export const updatePosCashExpense = ({ expenseId, amount, note, category = 'other', date = null, paymentMethod = 'cash' }) =>
  rpc('update_pos_cash_expense', {
    p_expense_id: expenseId,
    p_amount: Number(amount),
    p_note: note,
    p_category: category,
    p_date: date || null,
    p_payment_method: paymentMethod || 'cash'
  });

export const listPosCashExpenses = ({ branchId, startDate = null, endDate = null }) =>
  rpc('list_pos_cash_expenses', {
    p_branch_id: branchId,
    p_start_date: startDate || null,
    p_end_date: endDate || null
  });

export const deletePosCashExpense = (expenseId) =>
  rpc('delete_pos_cash_expense', {
    p_expense_id: expenseId
  });

export const getPosConfirmedProfitDetails = ({ branchId, startDate = null, endDate = null }) =>
  rpc('get_pos_confirmed_profit_details', {
    p_branch_id: branchId,
    p_start_date: startDate || null,
    p_end_date: endDate || null
  });
