import { getMediaObjectMetadata, MAX_MEDIA_BYTES, validateMediaInput } from '../../../../packages/server/src/r2.js';
import { ApiError, createServerSupabase, getActiveActor, getBearerToken, handleApiError, readJsonBody, requireCatalogPermission, sendJson } from '../_lib/auth.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS'){res.statusCode=204;return res.end()}
  if(req.method!=='POST'){res.setHeader('Allow','POST');return sendJson(res,405,{error:'Faqat POST so‘rovi qabul qilinadi.',code:'METHOD_NOT_ALLOWED'})}
  try{
    const admin=createServerSupabase(),actor=await getActiveActor(admin,getBearerToken(req));await requireCatalogPermission(admin,actor.id);
    const body=await readJsonBody(req);if(!UUID.test(String(body?.productId||''))||typeof body?.key!=='string')throw new ApiError(400,'Media ma’lumotlari noto‘g‘ri.','INVALID_MEDIA');
    if(!body.key.startsWith(`products/${body.productId}/`))throw new ApiError(400,'R2 kaliti mahsulotga tegishli emas.','INVALID_MEDIA_KEY');
    const meta=await getMediaObjectMetadata(body.key);if(!meta.contentType||!meta.size||meta.size>MAX_MEDIA_BYTES)throw new ApiError(400,'Yuklangan media yaroqsiz.','INVALID_MEDIA');validateMediaInput({contentType:meta.contentType,size:meta.size});
    const base=String(process.env.R2_PUBLIC_BASE_URL||'').replace(/\/$/,'');if(!base)throw new Error('R2_PUBLIC_BASE_URL sozlanmagan.');
    const { data: product } = await admin.from('products').select('id, seo_image_url').eq('id', body.productId).maybeSingle();
    if (!product) {
      return sendJson(res, 200, { publicUrl: `${base}/${body.key}`, key: body.key });
    }
    const publicUrl = `${base}/${body.key}`;
    const{data,error}=await admin.rpc('attach_product_media',{
      p_actor_id:actor.id,
      p_product_id:body.productId,
      p_r2_key:body.key,
      p_public_url:publicUrl,
      p_mime_type:meta.contentType,
      p_bytes:meta.size,
      p_alt_text:body.altText||null,
      p_variant_id:body.variantId||null
    });
    if(error)throw error;
    if(!product.seo_image_url){
      await admin.from('products').update({ seo_image_url: publicUrl }).eq('id', body.productId).catch(()=>{});
    }
    return sendJson(res,201,{mediaId:data,publicUrl,key:body.key});
  }catch(error){return handleApiError(res,error,'Media mahsulotga biriktirilmadi.')}
}
