import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
const client=()=>getBrowserClient();
async function rpc(name,args={}){const{data,error}=await client().rpc(name,args);if(error)throwDataError(error,name);return data}
async function list(table,select='*',configure=q=>q){const{data,error}=await configure(client().from(table).select(select));if(error)throw error;return data??[]}

export const createInventoryCount=({locationId,scope={mode:'full'},notes=null,idempotencyKey=crypto.randomUUID()})=>rpc('create_inventory_count',{p_location_id:locationId,p_scope:scope,p_notes:notes,p_idempotency_key:idempotencyKey});
export const startInventoryCount=id=>rpc('start_inventory_count',{p_count_id:id});
export const scanInventoryCountUnit=(id,code)=>rpc('count_inventory_unit',{p_count_id:id,p_code:code});
export const reviewInventoryCount=id=>rpc('review_inventory_count',{p_count_id:id});
export const postInventoryCount=id=>rpc('post_inventory_count',{p_count_id:id});
export const cancelInventoryCount=(id,reason)=>rpc('cancel_inventory_count',{p_count_id:id,p_reason:reason});
export const listInventoryCounts=({locationId=null}={})=>list('inventory_counts','*,inventory_count_lines(*)',q=>{q=q.order('created_at',{ascending:false});return locationId?q.eq('location_id',locationId):q});

export const createWriteoff=({locationId,reason,idempotencyKey=crypto.randomUUID()})=>rpc('create_writeoff',{p_location_id:locationId,p_reason:reason,p_idempotency_key:idempotencyKey});
export const addWriteoffUnit=(id,code)=>rpc('add_writeoff_unit',{p_writeoff_id:id,p_code:code});
export const approveWriteoff=id=>rpc('approve_writeoff',{p_writeoff_id:id});
export const postWriteoff=id=>rpc('post_writeoff',{p_writeoff_id:id});
export const cancelWriteoff=(id,reason)=>rpc('cancel_writeoff',{p_writeoff_id:id,p_reason:reason});
export const listWriteoffs=({locationId=null}={})=>list('writeoffs','*,writeoff_lines(*)',q=>{q=q.order('created_at',{ascending:false});return locationId?q.eq('location_id',locationId):q});

export const requestSaleReturn=({saleId,kind='return',reason,lines,idempotencyKey=crypto.randomUUID()})=>rpc('request_sale_return',{p_sale_id:saleId,p_kind:kind,p_reason:reason,p_lines:lines,p_idempotency_key:idempotencyKey});
export const approveSaleReturn=id=>rpc('approve_sale_return',{p_return_id:id});
export const completeSaleReturn=(id,resellLocationId,replacementSaleId=null)=>rpc('complete_sale_return',{p_return_id:id,p_resell_location_id:resellLocationId,p_replacement_sale_id:replacementSaleId});
export const cancelSaleReturn=(id,reason)=>rpc('cancel_sale_return',{p_return_id:id,p_reason:reason});
export const listSaleReturns=({branchId=null}={})=>list('sale_returns','*,sale_return_lines(*)',q=>{q=q.order('created_at',{ascending:false});return branchId?q.eq('branch_id',branchId):q});
export const listProviderRefunds=branchId=>rpc('list_provider_refunds',{p_branch_id:branchId});
export const getExchangeQuote=(returnId,replacementPendingSaleId)=>rpc('get_exchange_quote',{p_return_id:returnId,p_replacement_pending_sale_id:replacementPendingSaleId});
export const executeSaleExchange=({returnId,replacementPendingSaleId,resellLocationId,settlements=[],refundSettlement=null,idempotencyKey=crypto.randomUUID()})=>rpc('execute_sale_exchange',{p_return_id:returnId,p_replacement_pending_sale_id:replacementPendingSaleId,p_resell_location_id:resellLocationId,p_settlements:settlements,p_refund_settlement:refundSettlement,p_idempotency_key:idempotencyKey});

export const createRepairOrder=({branchId,unitCode,issue,isWarranty=false,expectedAt=null,idempotencyKey=crypto.randomUUID()})=>rpc('create_repair_order',{p_branch_id:branchId,p_unit_code:unitCode,p_issue:issue,p_is_warranty:isWarranty,p_expected_at:expectedAt||null,p_idempotency_key:idempotencyKey});
export const transitionRepairOrder=({id,target,destinationLocationId=null,diagnosis=null,resolution=null,note=null})=>rpc('transition_repair_order',{p_repair_id:id,p_target:target,p_destination_location_id:destinationLocationId||null,p_diagnosis:diagnosis||null,p_resolution:resolution||null,p_note:note||null});
export const addRepairCost=({id,costType,amount,description,currency,idempotencyKey=crypto.randomUUID()})=>rpc('add_repair_cost',{p_repair_id:id,p_cost_type:costType,p_amount:amount,p_description:description,p_currency:currency,p_idempotency_key:idempotencyKey});
export const listRepairOrders=({branchId,status=null,query='',page=1,pageSize=50})=>rpc('list_repair_orders',{p_branch_id:branchId,p_status:status||null,p_query:query||null,p_limit:pageSize,p_offset:(page-1)*pageSize});

export const requestBusinessCorrection=({entityId,reason,payload={},idempotencyKey=crypto.randomUUID()})=>rpc('request_business_correction',{p_entity_type:'sale',p_entity_id:entityId,p_reason:reason,p_payload:payload,p_idempotency_key:idempotencyKey});
export const approveBusinessCorrection=id=>rpc('approve_business_correction',{p_correction_id:id});
export const rejectBusinessCorrection=(id,reason)=>rpc('reject_business_correction',{p_correction_id:id,p_reason:reason});
export const applyBusinessCorrection=(id,{settlements=[],refundSettlement=null}={})=>rpc('apply_business_correction',{p_correction_id:id,p_settlements:settlements,p_refund_settlement:refundSettlement});
export const listBusinessCorrections=({branchId,status=null,page=1,pageSize=50})=>rpc('list_business_corrections',{p_branch_id:branchId,p_status:status||null,p_limit:pageSize,p_offset:(page-1)*pageSize});

export const listOnlineOrders=({branchId=null,status=null,page=1,pageSize=50}={})=>list('orders','*,order_lines(*),deliveries(*)',q=>{q=q.order('placed_at',{ascending:false}).range((page-1)*pageSize,page*pageSize-1);if(branchId)q=q.eq('branch_id',branchId);if(status)q=q.eq('status',status);return q});
export const transitionOnlineOrder=(id,target,branchId=null,note=null)=>rpc('transition_online_order',{p_order_id:id,p_target:target,p_branch_id:branchId,p_note:note});
export const cancelOnlineOrder=(id,reason)=>rpc('cancel_online_order',{p_order_id:id,p_reason:reason});
export const assignOrderCourier=(orderId,courierId)=>rpc('assign_order_courier',{p_order_id:orderId,p_courier_id:courierId});
export async function listBranchCouriers(branchId){const rows=await rpc('list_employees');return(rows||[]).filter(x=>x.is_active&&(x.roles||[]).some(r=>r.role==='courier'&&r.branch_id===branchId))}

export const saveFinanceAccount=account=>rpc('save_finance_account',{p_account:account});
export const listFinanceAccounts=({branchId=null}={})=>list('finance_accounts','*',q=>{q=q.order('created_at',{ascending:false});return branchId?q.eq('branch_id',branchId):q});
export const postFinanceTransaction=({accountId,type,category,amount,occurredAt=new Date().toISOString(),description=null,referenceType=null,referenceId=null,idempotencyKey=crypto.randomUUID()})=>rpc('post_finance_transaction',{p_account_id:accountId,p_type:type,p_category:category,p_amount:amount,p_occurred_at:occurredAt,p_description:description,p_reference_type:referenceType,p_reference_id:referenceId,p_idempotency_key:idempotencyKey});
export const listFinanceTransactions=({branchId=null,page=1,pageSize=100}={})=>list('finance_transactions','*',q=>{q=q.order('occurred_at',{ascending:false}).range((page-1)*pageSize,page*pageSize-1);return branchId?q.eq('branch_id',branchId):q});
export const recordSupplierPayment=({supplierId,branchId,accountId,amount,method,reference=null,notes=null,idempotencyKey=crypto.randomUUID()})=>rpc('record_supplier_payment',{p_supplier_id:supplierId,p_branch_id:branchId,p_account_id:accountId,p_amount:amount,p_method:method,p_reference:reference,p_notes:notes,p_idempotency_key:idempotencyKey});
export const createSupplierReturn=({supplierId,locationId,reason,unitIds,idempotencyKey=crypto.randomUUID()})=>rpc('create_supplier_return',{p_supplier_id:supplierId,p_location_id:locationId,p_reason:reason,p_unit_ids:unitIds,p_idempotency_key:idempotencyKey});
export const postSupplierReturn=id=>rpc('post_supplier_return',{p_return_id:id});
export const cancelSupplierReturn=(id,reason)=>rpc('cancel_supplier_return',{p_return_id:id,p_reason:reason});
export const createPayrollRun=({branchId,periodStart,periodEnd,items,idempotencyKey=crypto.randomUUID()})=>rpc('create_payroll_run',{p_branch_id:branchId,p_period_start:periodStart,p_period_end:periodEnd,p_items:items,p_idempotency_key:idempotencyKey});
export const approvePayrollRun=id=>rpc('approve_payroll_run',{p_payroll_run_id:id});
export const payPayrollRun=(id,accountId,idempotencyKey=crypto.randomUUID())=>rpc('pay_payroll_run',{p_payroll_run_id:id,p_account_id:accountId,p_idempotency_key:idempotencyKey});

// Least-privilege manager read helpers and workflow support lists.
export const listAdminOnlineOrders=({branchId=null,status=null,query='',page=1,pageSize=50}={})=>rpc('list_admin_orders',{p_branch_id:branchId||null,p_status:status||null,p_query:query||null,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const getSaleForReturn=(branchId,query='')=>rpc('get_sale_for_return',{p_branch_id:branchId,p_query:query||null});
export const listManagerOnlineOrders=({branchId,status=null,query='',page=1,pageSize=50})=>rpc('list_manager_orders',{p_branch_id:branchId,p_status:status||null,p_query:query||null,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const managerCancelOnlineOrder=(id,branchId,reason)=>rpc('manager_cancel_online_order',{p_order_id:id,p_branch_id:branchId,p_reason:reason});
export const getManagerWorkspaceReferences=branchId=>rpc('get_manager_workspace_references',{p_branch_id:branchId});
export const listSupplierPayments=({branchId,page=1,pageSize=50})=>list('supplier_payments','id,supplier_id,branch_id,account_id,amount,currency,method,reference,notes,paid_at,created_at',q=>q.eq('branch_id',branchId).order('paid_at',{ascending:false}).range((page-1)*pageSize,page*pageSize-1));
export const listSupplierReturns=({branchId,page=1,pageSize=50})=>list('supplier_returns','id,return_no,supplier_id,branch_id,from_location_id,status,reason,total_amount,posted_at,cancelled_at,created_at,supplier_return_lines(id,unit_id,product_id,unit_cost)',q=>q.eq('branch_id',branchId).order('created_at',{ascending:false}).range((page-1)*pageSize,page*pageSize-1));
export const listPayrollRuns=({branchId,page=1,pageSize=50})=>list('payroll_runs','id,branch_id,period_start,period_end,status,total,approved_by,paid_at,created_at,payroll_items(id,employee_id,gross,deductions,net,metadata)',q=>q.eq('branch_id',branchId).order('created_at',{ascending:false}).range((page-1)*pageSize,page*pageSize-1));