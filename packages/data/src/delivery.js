import { getAccessToken,getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
import { compressImageFile } from './mediaCompress.js';
async function rpc(name,args={}){
  const{data,error}=await getBrowserClient().rpc(name,args);
  if(error){
    // Debug: log raw PostgREST error
    console.error('[DEBUG] Raw PostgREST Error:', JSON.stringify({
      name,
      args,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    }, null, 2));
    throwDataError(error,name);
  }
  return data;
}
export function listCourierDeliveries({status=null,page=1,pageSize=30}={}){return rpc('list_courier_deliveries',{p_status:status||null,p_limit:pageSize,p_offset:(page-1)*pageSize})}
export const getCourierStats=(from=null,to=null)=>rpc('get_courier_stats',{...(from?{p_from:from}:{}),...(to?{p_to:to}:{})});
export const listCourierPerformance=({from,to,branchId=null,courierId=null})=>rpc('list_courier_performance',{p_from:from,p_to:to,p_branch_id:branchId||null,p_courier_id:courierId||null});
export const setCourierDeliveryStatus=({deliveryId,status,note=null,proofId=null})=>rpc('courier_update_delivery_status',{p_delivery_id:deliveryId,p_status:status,p_note:note,p_proof_id:proofId});
export const sendCourierTracking=({deliveryId,latitude,longitude,accuracy=null})=>rpc('insert_courier_tracking',{p_delivery_id:deliveryId,p_latitude:latitude,p_longitude:longitude,p_accuracy_m:accuracy});
export function getCurrentPosition(options={enableHighAccuracy:true,timeout:12000,maximumAge:30000}){return new Promise((resolve,reject)=>{if(!navigator.geolocation)return reject(new Error('Brauzer geolokatsiyani qo‘llamaydi.'));navigator.geolocation.getCurrentPosition(({coords})=>resolve({latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy}),e=>reject(new Error(e.message||'Joylashuv olinmadi.')),options)})}
export function watchCourierPosition(deliveryId,onPosition,onError){if(!navigator.geolocation){onError?.(new Error('Brauzer geolokatsiyani qo‘llamaydi.'));return()=>{}}let sending=false,lastSent=0,pending=null,stopped=false;const send=async p=>{if(stopped)return;if(sending){pending=p;return}if(Date.now()-lastSent<10000)return;sending=true;try{await sendCourierTracking(p);lastSent=Date.now();onPosition?.(p)}catch(e){onError?.(e)}finally{sending=false;if(pending){const next=pending;pending=null;setTimeout(()=>send(next),Math.max(0,10000-(Date.now()-lastSent)))}}};const id=navigator.geolocation.watchPosition(({coords})=>send({deliveryId,latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy}),e=>onError?.(new Error(e.message||'Joylashuv olinmadi.')),{enableHighAccuracy:true,maximumAge:15000,timeout:20000});return()=>{stopped=true;pending=null;navigator.geolocation.clearWatch(id)}}
export async function uploadDeliveryProof(deliveryId,file){const allowed=new Set(['image/jpeg','image/png','image/webp','image/avif']);if(!file||!allowed.has(file.type))throw new Error('Yetkazish isboti JPEG, PNG, WebP yoki AVIF rasm bo‘lishi kerak.');if(file.size<1)throw new Error('Bo‘sh rasm yuklab bo‘lmaydi.');if(file.size>20*1024*1024)throw new Error('Rasm 20 MiB dan oshmasligi kerak.');const compressed=await compressImageFile(file,{maxWidth:1280,maxHeight:1280,quality:0.8});const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi.');const headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};const presign=await fetch('/api/media/delivery-proof',{method:'POST',headers,body:JSON.stringify({action:'presign',deliveryId,contentType:compressed.type,size:compressed.size})});const signed=await presign.json().catch(()=>({}));if(!presign.ok)throw new Error(signed.error||'Yuklash URL olinmadi.');const upload=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':compressed.type},body:compressed});if(!upload.ok){await deleteDeliveryProof({deliveryId,proofId:signed.proofId,key:signed.key}).catch(()=>{});throw new Error('Yetkazish isboti R2 serveriga yuklanmadi.')}const complete=await fetch('/api/media/delivery-proof',{method:'POST',headers,body:JSON.stringify({action:'complete',deliveryId,proofId:signed.proofId,key:signed.key})});const result=await complete.json().catch(()=>({}));if(!complete.ok){await deleteDeliveryProof({deliveryId,proofId:signed.proofId,key:signed.key}).catch(()=>{});throw new Error(result.error||'Yetkazish isboti tasdiqlanmadi.')}return result}
export async function deleteDeliveryProof({deliveryId,proofId,key}){const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi.');const response=await fetch('/api/media/delivery-proof',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action:'delete',deliveryId,proofId,key})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Yetkazish isboti tozalanmadi.');return result}


// Courier cash handover
export const listCourierPendingCash = () => rpc('list_courier_pending_cash', {});
export const listBranchCourierCash = branchId => rpc('list_branch_courier_cash', { p_branch_id: branchId });
export const acceptCourierCash = handoverId => rpc('accept_courier_cash', { p_handover_id: handoverId });
export const rejectCourierDelivery = (handoverId, reason = null) => rpc('reject_courier_delivery', { p_handover_id: handoverId, p_reason: reason });


// Order unit QR verification (manager assigns exact physical unit, courier confirms by scan)
export const getOrderUnitAssignments = orderId => rpc('get_order_unit_assignments', { p_order_id: orderId });
export const managerReassignOrderUnit = (orderLineId, qrCode) => rpc('manager_reassign_order_unit', { p_order_line_id: orderLineId, p_qr_code: qrCode });
export const courierVerifyOrderUnit = (orderId, qrCode) => rpc('courier_verify_order_unit', { p_order_id: orderId, p_qr_code: qrCode });
export const getCourierOrderVerification = orderId => rpc('get_courier_order_verification', { p_order_id: orderId });
