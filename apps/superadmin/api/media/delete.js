import { deleteMediaObject } from '@texnobazar/server/r2';
import { ApiError, createServerSupabase, getActiveActor, getBearerToken, handleApiError, readJsonBody, requireCatalogPermission, sendJson } from '../_lib/auth.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
export default async function handler(req,res){
 if(req.method!=='DELETE'){res.setHeader('Allow','DELETE');return sendJson(res,405,{error:'Faqat DELETE so‘rovi qabul qilinadi.',code:'METHOD_NOT_ALLOWED'})}
 try{
  const admin=createServerSupabase(),actor=await getActiveActor(admin,getBearerToken(req));await requireCatalogPermission(admin,actor.id);
  const body=await readJsonBody(req);if(!UUID.test(String(body?.mediaId||'')))throw new ApiError(400,'Media ID noto‘g‘ri.','INVALID_MEDIA');
  const{data:key,error}=await admin.rpc('detach_product_media',{p_actor_id:actor.id,p_media_id:body.mediaId});if(error)throw error;
  try{await deleteMediaObject(key)}catch(cleanupError){console.error('R2 media cleanup keyingi urinishni talab qiladi.');return sendJson(res,202,{deleted:true,r2CleanupPending:true})}
  return sendJson(res,200,{deleted:true,r2CleanupPending:false});
 }catch(error){return handleApiError(res,error,'Media o‘chirilmadi.')}
}
