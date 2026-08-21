import { createPresignedMediaPut,getMediaObjectMetadata,MAX_MEDIA_BYTES,validateMediaInput } from '../../../../packages/server/src/r2.js';
import { ApiError,createServerSupabase,getActiveActor,getBearerToken,handleApiError,readJsonBody,requireCatalogPermission,sendJson } from '../_lib/auth.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
export default async function handler(req,res){
 if(req.method!=='POST'){res.setHeader('Allow','POST');return sendJson(res,405,{error:'Faqat POST so‘rovi qabul qilinadi.',code:'METHOD_NOT_ALLOWED'})}
 try{
  const admin=createServerSupabase(),actor=await getActiveActor(admin,getBearerToken(req));await requireCatalogPermission(admin,actor.id);const body=await readJsonBody(req),slot=body?.slot||'desktop';
  if(!UUID.test(String(body?.bannerId||''))||!['presign','complete','attach','delete'].includes(body?.action)||!['desktop','mobile'].includes(slot))throw new ApiError(400,'Banner media ma’lumotlari noto‘g‘ri.','INVALID_BANNER_MEDIA');
  if(body.action==='presign'){
   validateMediaInput({contentType:body.contentType,size:body.size});const signed=await createPresignedMediaPut({contentType:body.contentType,size:body.size,scope:'banners',ownerId:body.bannerId,uploaderId:actor.id});
   const{data:upload,error}=await admin.from('banner_media_uploads').insert({banner_id:body.bannerId,uploader_id:actor.id,r2_key:signed.key,public_url:signed.publicUrl,mime_type:body.contentType,bytes:body.size,slot,status:'pending'}).select('id').single();if(error)throw error;return sendJson(res,200,{...signed,slot,uploadId:upload.id});
  }
  if(typeof body.key!=='string'||!body.key.startsWith(`banners/${body.bannerId}/`))throw new ApiError(400,'R2 kaliti bannerga tegishli emas.','INVALID_BANNER_KEY');
  if(body.action==='complete'){
   if(!UUID.test(String(body.uploadId||'')))throw new ApiError(400,'Upload ID noto‘g‘ri.','INVALID_UPLOAD_ID');const{data:upload,error}=await admin.from('banner_media_uploads').select('*').eq('id',body.uploadId).eq('banner_id',body.bannerId).eq('uploader_id',actor.id).eq('r2_key',body.key).eq('slot',slot).maybeSingle();if(error)throw error;if(!upload||upload.status!=='pending')throw new ApiError(409,'Banner upload holati noto‘g‘ri.','INVALID_UPLOAD_STATE');
   const meta=await getMediaObjectMetadata(body.key);if(!meta.contentType||!meta.size||meta.size>MAX_MEDIA_BYTES)throw new ApiError(400,'Banner rasmi yaroqsiz.','INVALID_BANNER_MEDIA');validateMediaInput({contentType:meta.contentType,size:meta.size});if(meta.contentType!==upload.mime_type||Number(meta.size)!==Number(upload.bytes))throw new ApiError(400,'Yuklangan fayl presign ma’lumotiga mos emas.','MEDIA_METADATA_MISMATCH');
   const{data:updated,error:updateError}=await admin.from('banner_media_uploads').update({status:'verified',verified_at:new Date().toISOString()}).eq('id',upload.id).eq('status','pending').select('id,public_url,r2_key,slot').maybeSingle();if(updateError)throw updateError;if(!updated)throw new ApiError(409,'Banner upload qayta ishlangan.','UPLOAD_ALREADY_PROCESSED');return sendJson(res,201,{uploadId:updated.id,publicUrl:updated.public_url,key:updated.r2_key,slot:updated.slot});
  }
  if(body.action==='attach'){
   if(!UUID.test(String(body.uploadId||'')))throw new ApiError(400,'Upload ID noto‘g‘ri.','INVALID_UPLOAD_ID');const keyColumn=slot==='mobile'?'mobile_r2_key':'r2_key';const{data:banner,error:bannerError}=await admin.from('cms_banners').select(`id,${keyColumn}`).eq('id',body.bannerId).maybeSingle();if(bannerError)throw bannerError;if(!banner||banner[keyColumn]!==body.key)throw new ApiError(409,'Banner media DB yozuviga bog‘lanmagan.','BANNER_NOT_BOUND');const{data,error}=await admin.from('banner_media_uploads').update({status:'attached',attached_at:new Date().toISOString()}).eq('id',body.uploadId).eq('banner_id',body.bannerId).eq('uploader_id',actor.id).eq('r2_key',body.key).eq('slot',slot).eq('status','verified').select('id').maybeSingle();if(error)throw error;if(!data)throw new ApiError(409,'Banner upload tasdiqlanmagan.','UPLOAD_NOT_VERIFIED');return sendJson(res,200,{attached:true});
  }
  if(!UUID.test(String(body.uploadId||'')))throw new ApiError(400,'Cleanup uchun upload ID talab qilinadi.','INVALID_UPLOAD_ID');
  const{data:upload,error:uploadError}=await admin.from('banner_media_uploads').select('id').eq('id',body.uploadId).eq('banner_id',body.bannerId).eq('uploader_id',actor.id).eq('r2_key',body.key).eq('slot',slot).maybeSingle();if(uploadError)throw uploadError;if(!upload)throw new ApiError(404,'Banner upload topilmadi.','UPLOAD_NOT_FOUND');
  const{error:queueError}=await admin.rpc('queue_banner_media_cleanup',{p_banner_id:body.bannerId,p_upload_id:body.uploadId,p_r2_key:body.key,p_uploader_id:actor.id});if(queueError)throw queueError;return sendJson(res,202,{deleted:false,r2CleanupPending:true});
 }catch(error){return handleApiError(res,error,'Banner media amali bajarilmadi.')}
}
