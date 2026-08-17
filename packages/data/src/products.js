import { getAccessToken, getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
async function rpc(name,args){const{data,error}=await getBrowserClient().rpc(name,args);if(error)throwDataError(error,name);return data}
export async function listCatalogProducts({query=null,status=null,categoryId=null,brandId=null,page=1,pageSize=20}={}){
 return rpc('list_catalog_products',{p_query:query||null,p_status:status||null,p_category_id:categoryId||null,p_brand_id:brandId||null,p_limit:pageSize,p_offset:(page-1)*pageSize});
}
export const getCatalogProduct=id=>rpc('get_catalog_product',{p_product_id:id});
export const saveCatalogProduct=(product,attributes=[])=>rpc('save_catalog_product',{p_product:product,p_attributes:attributes});
export const setCatalogProductPublication=(id,publish)=>rpc('set_catalog_product_publication',{p_product_id:id,p_publish:publish});
export const archiveCatalogProduct=id=>rpc('archive_catalog_product',{p_product_id:id});
export const setPrimaryProductMedia=(productId,mediaId)=>rpc('set_primary_product_media',{p_product_id:productId,p_media_id:mediaId});
async function api(path,method,body){const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi.');const response=await fetch(path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Server amali bajarilmadi.');return result}
export async function uploadProductMedia(productId,file,altText=''){
 const signed=await api('/api/media/presign','POST',{contentType:file.type,size:file.size,scope:'products',ownerId:productId});
 const upload=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':file.type},body:file});if(!upload.ok)throw new Error('Rasm R2 serveriga yuklanmadi.');
 return api('/api/media/complete','POST',{productId,key:signed.key,altText});
}
export const deleteProductMedia=mediaId=>api('/api/media/delete','DELETE',{mediaId});

export const listInventoryCatalogCandidates=({query=null,onlyUnpublished=true,page=1,pageSize=50}={})=>rpc('list_inventory_catalog_candidates',{p_query:query||null,p_only_unpublished:onlyUnpublished,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const bulkPublishInventoryProducts=productIds=>rpc('bulk_publish_inventory_products',{p_product_ids:[...new Set(productIds||[])]});