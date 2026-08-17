import { getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

async function rpc(name,args){const{data,error}=await getBrowserClient().rpc(name,args);if(error)throwDataError(error,name);return data}

export const getSafeSaleReceipt=saleId=>rpc('get_safe_sale_receipt',{p_sale_id:saleId});
export function queueSaleReceipt({saleId,email,idempotencyKey=crypto.randomUUID()}){
  return rpc('queue_sale_receipt_delivery',{p_sale_id:saleId,p_email:email,p_idempotency_key:idempotencyKey});
}
export function queueOrderReceipt({orderId,idempotencyKey=crypto.randomUUID()}){
  return rpc('queue_order_receipt_delivery',{p_order_id:orderId,p_idempotency_key:idempotencyKey});
}
export function getReceiptDeliveryStatus({deliveryId=null,saleId=null,orderId=null}){
  return rpc('get_receipt_delivery_status',{p_delivery_id:deliveryId,p_sale_id:saleId,p_order_id:orderId});
}
