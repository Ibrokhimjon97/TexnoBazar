import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
async function rpc(name,args){const{data,error}=await getBrowserClient().rpc(name,args);if(error)throwDataError(error,name);return data}
export const getInventoryReferences=branchId=>rpc('get_inventory_references',{p_branch_id:branchId});
export const getStockReceipt=id=>rpc('get_stock_receipt',{p_receipt_id:id});
export const updateStockReceipt=(id,updates)=>rpc('update_stock_receipt',{p_receipt_id:id,p_updates:updates});
export const deleteStockReceipt=(id,password=null)=>rpc('delete_stock_receipt',{p_receipt_id:id,p_password:password||null});
export const listReceiptQrLabels=(receiptId,page=1,pageSize=100)=>rpc('list_receipt_qr_labels',{p_receipt_id:receiptId,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const createStockReceipt=(header,lines,idempotencyKey=crypto.randomUUID())=>rpc('receive_stock',{p_header:header,p_lines:lines,p_idempotency_key:idempotencyKey});
export function listStockReceipts({branchId=null,locationId=null,query=null,date=null,page=1,pageSize=500}={}){return rpc('list_stock_receipts',{p_branch_id:branchId,p_location_id:locationId||null,p_query:query||null,p_limit:pageSize,p_offset:(page-1)*pageSize,p_date:date||null})}
export function listInventoryBalances({branchId=null,locationId=null,query=null,categoryId=null,minPrice=null,maxPrice=null,availability=null,page=1,pageSize=50}={}){return rpc('list_inventory_balances',{p_branch_id:branchId||null,p_location_id:locationId||null,p_query:query||null,p_category_id:categoryId||null,p_min_price:minPrice?Number(minPrice):null,p_max_price:maxPrice?Number(maxPrice):null,p_availability:availability||null,p_limit:pageSize,p_offset:(page-1)*pageSize})}
export const getInventoryUnitPassport=code=>rpc('get_inventory_unit_passport',{p_code:code});
export const placeInventoryUnits=(targetLocationId,codes,requestId=crypto.randomUUID())=>rpc('place_inventory_units',{p_target_location_id:targetLocationId,p_codes:codes,p_request_id:requestId});
// Manager-only: sotilgan birlikni balansga qaytaradi va sotuv summasini hisobdan chiqaradi.
export const revertUnitSale=(unitId,locationId,reason=null)=>rpc('manager_revert_unit_sale',{p_unit_id:unitId,p_location_id:locationId,p_reason:reason||null});
export const listInventorySearchSellers=()=>rpc('list_inventory_search_sellers',{});
export function searchInventoryUnits({filters={},page=1,pageSize=50}={}){return rpc('search_inventory_units',{p_filters:filters,p_limit:pageSize,p_offset:(page-1)*pageSize})}

export const getLatestExchangeRate = (from = 'USD', to = 'UZS') => rpc('get_latest_exchange_rate', { p_from: from, p_to: to }).catch(() => null);


export const listSupplierDebts = (branchId = null) => rpc('list_supplier_debts', { p_branch_id: branchId });
export const updateReceiptPayment = (receiptId, paidAmount, paymentStatus = null) => rpc('update_receipt_payment', { p_receipt_id: receiptId, p_paid_amount: paidAmount, p_payment_status: paymentStatus });
export const bulkUpdateBatchPrices = ({ branchId = null, currency = 'UZS', items = [] } = {}) => rpc('bulk_update_batch_prices', { p_branch_id: branchId, p_currency: currency, p_items: items });
export const getProductStockDistribution = productId => rpc('get_product_stock_distribution', { p_product_id: productId });
