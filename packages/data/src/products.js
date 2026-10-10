import { getAccessToken, getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
import { compressImageFile } from './mediaCompress.js';
export { compressImageFile };
async function rpc(name,args){const{data,error}=await getBrowserClient().rpc(name,args);if(error)throwDataError(error,name);return data}
export async function listCatalogProducts({query=null,status=null,categoryId=null,brandId=null,page=1,pageSize=20}={}){
 return rpc('list_catalog_products',{p_query:query||null,p_status:status||null,p_category_id:categoryId||null,p_brand_id:brandId||null,p_limit:pageSize,p_offset:(page-1)*pageSize});
}
export const getCatalogProduct=id=>rpc('get_catalog_product',{p_product_id:id});
export const saveCatalogProduct=(product,attributes=[])=>rpc('save_catalog_product',{p_product:product,p_attributes:attributes});
export const setCatalogProductPublication=(id,publish)=>rpc('set_catalog_product_publication',{p_product_id:id,p_publish:publish});
export const archiveCatalogProduct=id=>rpc('archive_catalog_product',{p_product_id:id});
export const setPrimaryProductMedia=(productId,mediaId)=>rpc('set_primary_product_media',{p_product_id:productId,p_media_id:mediaId});
// Rang variantlari: har bir variant o'zining narxi (ixtiyoriy), zaxirasi va rasmlariga ega bo'ladi.
export const saveProductVariants=(productId,variants=[])=>rpc('save_product_variants',{p_product_id:productId,p_variants:variants});
export const bulkDeleteProducts=productIds=>rpc('delete_products_cascade',{p_product_ids:productIds});
export const deleteCategoryProducts=(categoryId,includeChildren=true)=>rpc('delete_category_products_cascade',{p_category_id:categoryId,p_include_children:includeChildren});
async function api(path,method,body){const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');const base=(import.meta.env?.VITE_API_BASE||'').replace(/\/$/,'');const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});const text=await response.text();let result={};try{result=text?JSON.parse(text):{}}catch{if(!response.ok)throw new Error(`Media serveri noto‘g‘ri javob qaytardi (${response.status}).`)}if(!response.ok)throw new Error(result.error||`Server amali bajarilmadi (${response.status}).`);return result}
async function uploadViaProxy(key, file) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');
  const base = (import.meta.env?.VITE_API_BASE || '').replace(/\/$/, '');
  const response = await fetch(`${base}/api/media/upload?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, Authorization: `Bearer ${token}` },
    body: file,
  });
  if (!response.ok) {
    const text = await response.text();
    let result = {};
    try { result = text ? JSON.parse(text) : {}; } catch {}
    throw new Error(result.error || `Rasm R2 serveriga yuklanmadi (${response.status}).`);
  }
}
async function uploadToPresignedUrl(uploadUrl, file) {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!response.ok) {
    throw new Error(`Rasm R2 serveriga yuklanmadi (${response.status}).`);
  }
}

export async function uploadProductMedia(productId, file, altText = '', variantId = null) {
  const compressed = await compressImageFile(file, { maxWidth: 1600, maxHeight: 1600, quality: 0.82 });
  const signed = await api('/api/media/presign', 'POST', {
    contentType: compressed.type,
    size: compressed.size,
    scope: 'products',
    ownerId: productId,
  });
  let uploaded = false;
  if (signed?.uploadUrl) {
    try {
      await uploadToPresignedUrl(signed.uploadUrl, compressed);
      uploaded = true;
    } catch {
      // Direct presigned upload failed (e.g. CORS on R2 bucket), fall back to proxy
    }
  }
  if (!uploaded) {
    await uploadViaProxy(signed.key, compressed);
  }
  try {
    return await api('/api/media/complete', 'POST', {
      productId,
      key: signed.key,
      altText,
      variantId: variantId || null,
    });
  } catch (err) {
    return { url: signed.publicUrl, publicUrl: signed.publicUrl, key: signed.key };
  }
}

export const deleteProductMedia = async mediaId => {
  try {
    return await rpc('delete_product_media', { p_media_id: mediaId });
  } catch (err) {
    try {
      const client = getBrowserClient();
      const { data: { user } } = await client.auth.getUser();
      if (user?.id) {
        return await rpc('detach_product_media', { p_actor_id: user.id, p_media_id: mediaId });
      }
    } catch {
      // Fall through to direct table delete
    }
    const client = getBrowserClient();
    const { error } = await client.from('product_media').delete().eq('id', mediaId);
    if (error) throwDataError(error, 'deleteProductMedia');
    return { success: true };
  }
};
export const updateProductTextFields=(productId,{description,seoImageUrl}={})=>rpc('update_product_text_fields',{p_product_id:productId,p_description:description??null,p_seo_image_url:seoImageUrl??null});

export const listInventoryCatalogCandidates=({query=null,onlyUnpublished=true,page=1,pageSize=50}={})=>rpc('list_inventory_catalog_candidates',{p_query:query||null,p_only_unpublished:onlyUnpublished,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const bulkPublishInventoryProducts=productIds=>rpc('bulk_publish_inventory_products',{p_product_ids:[...new Set(productIds||[])]});