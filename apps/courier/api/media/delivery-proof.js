import{createPresignedMediaPut,getMediaObjectMetadata,MAX_MEDIA_BYTES,validateMediaInput}from'@texnobazar/server/r2';
import{ApiError,actor,bearer,fail,json,sendJson,serverClient}from'../_lib/auth.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
export default async function handler(req,res){
 if(req.method!=='POST'){res.setHeader('Allow','POST');return sendJson(res,405,{error:'Faqat POST so‘rovi qabul qilinadi.'})}
 try{
  const admin=serverClient(),me=await actor(admin,bearer(req)),body=await json(req);
  if(!UUID.test(String(body?.deliveryId||''))||!['presign','complete','delete'].includes(body?.action))throw new ApiError(400,'Isbot ma’lumotlari noto‘g‘ri.');
  const{data:d,error}=await admin.from('deliveries').select('id,courier_id,status').eq('id',body.deliveryId).maybeSingle();if(error)throw error;if(!d)throw new ApiError(404,'Yetkazish topilmadi.');if(d.courier_id!==me.id)throw new ApiError(403,'Bu yetkazishga ruxsat yo‘q.');
  if(body.action==='presign'){
   if(d.status!=='in_transit')throw new ApiError(409,'Isbot faqat yo‘ldagi yetkazish uchun yuklanadi.');validateMediaInput({contentType:body.contentType,size:body.size});
   const signed=await createPresignedMediaPut({contentType:body.contentType,size:body.size,scope:'delivery-proofs',ownerId:body.deliveryId,uploaderId:me.id});
   const{data:proof,error:insertError}=await admin.from('delivery_proofs').insert({delivery_id:body.deliveryId,courier_id:me.id,r2_key:signed.key,public_url:signed.publicUrl,mime_type:body.contentType,bytes:body.size,status:'pending'}).select('id').single();if(insertError)throw insertError;return sendJson(res,200,{...signed,proofId:proof.id});
  }
  if(!UUID.test(String(body?.proofId||''))||typeof body.key!=='string'||!body.key.startsWith(`delivery-proofs/${body.deliveryId}/`))throw new ApiError(400,'R2 proof identifikatori noto‘g‘ri.');
  const{data:proof,error:proofError}=await admin.from('delivery_proofs').select('id,r2_key,mime_type,bytes,status').eq('id',body.proofId).eq('delivery_id',body.deliveryId).eq('courier_id',me.id).maybeSingle();if(proofError)throw proofError;if(!proof||proof.r2_key!==body.key)throw new ApiError(404,'Yetkazish isboti topilmadi.');
  if(body.action==='complete'){
   if(d.status!=='in_transit'||proof.status!=='pending')throw new ApiError(409,'Isbotni tasdiqlash holati noto‘g‘ri.');const meta=await getMediaObjectMetadata(body.key);if(!meta.contentType||!meta.size||meta.size>MAX_MEDIA_BYTES)throw new ApiError(400,'Isbot yaroqsiz.');validateMediaInput({contentType:meta.contentType,size:meta.size});if(meta.contentType!==proof.mime_type||Number(meta.size)!==Number(proof.bytes))throw new ApiError(400,'Yuklangan fayl presign ma’lumotiga mos emas.');
   const{data:updated,error:updateError}=await admin.from('delivery_proofs').update({status:'verified',verified_at:new Date().toISOString()}).eq('id',proof.id).eq('status','pending').select('id,public_url,r2_key,mime_type,bytes').maybeSingle();if(updateError)throw updateError;if(!updated)throw new ApiError(409,'Isbot allaqachon qayta ishlangan.');return sendJson(res,201,{proofId:updated.id,publicUrl:updated.public_url,key:updated.r2_key,mimeType:updated.mime_type,bytes:updated.bytes});
  }
  if(!['pending','verified','delete_pending'].includes(proof.status))throw new ApiError(409,'Ishlatilgan isbotni o‘chirib bo‘lmaydi.');
  const{data:queuedKey,error:queueError}=await admin.rpc('queue_delivery_proof_cleanup',{p_proof_id:proof.id,p_delivery_id:body.deliveryId,p_courier_id:me.id});if(queueError)throw queueError;if(queuedKey!==proof.r2_key)throw new Error('Proof cleanup kaliti mos emas.');return sendJson(res,202,{deleted:false,r2CleanupPending:true});
 }catch(error){return fail(res,error)}
}
