import { getAccessToken, getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';
import { compressImageFile } from './mediaCompress.js';
import { getApiBase } from './apiBase.js';
export { compressImageFile, getApiBase };
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

async function api(path, method, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');
  const base = getApiBase();
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result = {};
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Media serveri noto‘g‘ri javob qaytardi (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(result.error || `Server amali bajarilmadi (${response.status}).`);
  }
  return result;
}

async function uploadViaProxy(key, file) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');
  const base = getApiBase();
  const contentType = (file.type || 'image/jpeg').toLowerCase();
  const response = await fetch(`${base}/api/media/upload?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
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
  const contentType = (file.type || 'image/jpeg').toLowerCase();
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: file,
  });
  if (!response.ok) {
    throw new Error(`Rasm R2 serveriga yuklanmadi (${response.status}).`);
  }
}

export async function uploadProductMedia(productId, file, altText = '', variantId = null) {
  const compressed = await compressImageFile(file, { maxWidth: 1600, maxHeight: 1600, quality: 0.82 });
  const rawType = (compressed.type || file.type || '').toLowerCase();
  const contentType = rawType === 'image/jpg' ? 'image/jpeg' : (rawType || 'image/jpeg');

  try {
    const signed = await api('/api/media/presign', 'POST', {
      contentType,
      size: compressed.size,
      scope: 'products',
      ownerId: productId,
    });
    if (!signed?.key) {
      throw new Error(signed?.error || 'Media kaliti olinmadi.');
    }
    let uploaded = false;
    if (signed?.uploadUrl) {
      try {
        await uploadToPresignedUrl(signed.uploadUrl, compressed);
        uploaded = true;
      } catch (presignErr) {
        console.warn('Direct presigned R2 upload failed, attempting proxy upload:', presignErr);
      }
    }
    if (!uploaded) {
      await uploadViaProxy(signed.key, compressed);
    }
    try {
      const completed = await api('/api/media/complete', 'POST', {
        productId,
        key: signed.key,
        altText,
        variantId: variantId || null,
      });
      return completed;
    } catch (err) {
      console.warn('Complete media RPC failed, returning signed public URL:', err);
      return { url: signed.publicUrl, publicUrl: signed.publicUrl, key: signed.key };
    }
  } catch (err) {
    console.warn('R2 upload failed, attempting Supabase storage fallback:', err);
    try {
      const client = getBrowserClient();
      const ext = (compressed.name || 'image.jpg').split('.').pop() || 'jpg';
      const path = `products/${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const { data: storageData, error: sErr } = await client.storage.from('logos').upload(path, compressed, { upsert: true });
      if (!sErr && storageData) {
        const { data: { publicUrl } } = client.storage.from('logos').getPublicUrl(path);
        let attached = false;
        try {
          const user = (await client.auth.getUser())?.data?.user;
          const { error: rpcErr } = await client.rpc('attach_product_media', {
            p_actor_id: user?.id || null,
            p_product_id: productId,
            p_r2_key: path,
            p_public_url: publicUrl,
            p_file_size: Math.max(1, compressed.size || 1024),
            p_bytes: Math.max(1, compressed.size || 1024),
            p_mime_type: contentType,
            p_alt_text: altText || null,
            p_variant_id: variantId || null,
          });
          if (!rpcErr) attached = true;
          else console.warn('attach_product_media RPC error:', rpcErr);
        } catch (rpcErr) {
          console.warn('attach_product_media RPC call failed:', rpcErr);
        }

        if (!attached) {
          try {
            await client.from('product_media').insert({
              product_id: productId,
              variant_id: variantId || null,
              r2_key: path,
              public_url: publicUrl,
              mime_type: contentType,
              bytes: Math.max(1, compressed.size || 1024),
              alt_text: altText || null,
              is_primary: true,
              sort_order: 0,
            });
          } catch (insertErr) {
            console.warn('Direct product_media insert failed:', insertErr);
          }
        }

        try {
          await client.from('products').update({ seo_image_url: publicUrl }).eq('id', productId);
        } catch (seoErr) {
          console.warn('Failed to update product seo_image_url:', seoErr);
        }

        return { url: publicUrl, publicUrl, key: path };
      }
    } catch (fallbackErr) {
      console.error('Storage fallback failed:', fallbackErr);
    }
    throw err;
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