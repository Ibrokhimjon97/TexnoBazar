import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
async function rpc(name,args){const{data,error}=await getBrowserClient().rpc(name,args);if(error)throwDataError(error,name);return data}
export const getInventoryReferences=branchId=>rpc('get_inventory_references',{p_branch_id:branchId});
export const getStockReceipt=id=>rpc('get_stock_receipt',{p_receipt_id:id});
export const listReceiptQrLabels=(receiptId,page=1,pageSize=100)=>rpc('list_receipt_qr_labels',{p_receipt_id:receiptId,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const createStockReceipt=(header,lines,idempotencyKey=crypto.randomUUID())=>rpc('receive_stock',{p_header:header,p_lines:lines,p_idempotency_key:idempotencyKey});
export function listStockReceipts({branchId=null,query=null,page=1,pageSize=20}={}){return rpc('list_stock_receipts',{p_branch_id:branchId,p_query:query||null,p_limit:pageSize,p_offset:(page-1)*pageSize})}
export function listInventoryBalances({branchId=null,locationId=null,query=null,page=1,pageSize=50}={}){return rpc('list_inventory_balances',{p_branch_id:branchId,p_location_id:locationId,p_query:query||null,p_limit:pageSize,p_offset:(page-1)*pageSize})}
export const getInventoryUnitPassport=code=>rpc('get_inventory_unit_passport',{p_code:code});
export const placeInventoryUnits=(targetLocationId,codes,requestId=crypto.randomUUID())=>rpc('place_inventory_units',{p_target_location_id:targetLocationId,p_codes:codes,p_request_id:requestId});
export const listInventorySearchSellers=()=>rpc('list_inventory_search_sellers',{});
export function searchInventoryUnits({filters={},page=1,pageSize=50}={}){return rpc('search_inventory_units',{p_filters:filters,p_limit:pageSize,p_offset:(page-1)*pageSize})}