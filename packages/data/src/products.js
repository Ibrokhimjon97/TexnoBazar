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
async function api(path,method,body){const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');const base=(import.meta.env?.VITE_API_BASE||'').replace(/\/$/,'');const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});const text=await response.text();let result={};try{result=text?JSON.parse(text):{}}catch{if(!response.ok)throw new Error(`Media serveri noto‘g‘ri javob qaytardi (${response.status}).`)}if(!response.ok)throw new Error(result.error||`Server amali bajarilmadi (${response.status}).`);return result}
async function uploadViaProxy(key,file){const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');const base=(import.meta.env?.VITE_API_BASE||'').replace(/\/$/,'');const response=await fetch(`${base}/.netlify/functions/media-upload?key=${encodeURIComponent(key)}`,{method:'PUT',headers:{'Content-Type':file.type,Authorization:`Bearer ${token}`},body:file});if(!response.ok){const text=await response.text();let result={};try{result=text?JSON.parse(text):{}}catch{}throw new Error(result.error||`Rasm R2 serveriga yuklanmadi (${response.status}).`)}}
// Client-side image compression: resizes to max 1600px and compresses to ~200-400KB WebP/JPEG
async function compressImage(file, { maxWidth = 1600, maxHeight = 1600, quality = 0.82 } = {}) {
  // Skip if already small enough (under 500KB)
  if (file.size <= 500 * 1024) return file;
  // Only compress raster images
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      // Prefer WebP, fallback to JPEG
      const outputType = 'image/webp';
      canvas.toBlob((blob) => {
        if (!blob || blob.size >= file.size) { resolve(file); return; }
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: outputType }));
      }, outputType, quality);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

export async function uploadProductMedia(productId,file,altText=''){
 const compressed = await compressImage(file);
 const signed=await api('/.netlify/functions/media-presign','POST',{contentType:compressed.type,size:compressed.size,scope:'products',ownerId:productId});
 await uploadViaProxy(signed.key,compressed);
 return api('/.netlify/functions/media-complete','POST',{productId,key:signed.key,altText});
}
export const deleteProductMedia=mediaId=>api('/api/media/delete','DELETE',{mediaId});
export const updateProductTextFields=(productId,{description,seoImageUrl}={})=>rpc('update_product_text_fields',{p_product_id:productId,p_description:description??null,p_seo_image_url:seoImageUrl??null});

export const listInventoryCatalogCandidates=({query=null,onlyUnpublished=true,page=1,pageSize=50}={})=>rpc('list_inventory_catalog_candidates',{p_query:query||null,p_only_unpublished:onlyUnpublished,p_limit:pageSize,p_offset:(page-1)*pageSize});
export const bulkPublishInventoryProducts=productIds=>rpc('bulk_publish_inventory_products',{p_product_ids:[...new Set(productIds||[])]});