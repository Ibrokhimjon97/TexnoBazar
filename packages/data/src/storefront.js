import { getBrowserClient } from './auth.js';
import { DATABASE_UPDATE_MESSAGE, isSchemaCompatibilityError, throwDataError } from './errors.js';

async function rpc(name, args = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data, error } = await getBrowserClient().rpc(name, args);
    if (!error) return data;

    const status = error.status || (error.code === '57014' ? 504 : null);
    const isRetryable = status === 500 || status === 502 || status === 503 || status === 504
      || error.code === '57014'
      || (error.message && (error.message.includes('timeout') || error.message.includes('fetch') || error.message.includes('network')));

    if (isRetryable && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    throwDataError(error, name);
  }
}
const emptyFacets=()=>({categories:[],brands:[],attributes:{},price:{}});
export async function loadStorefrontCatalog({query=null,categoryId=null,categoryIds=[],brandIds=[],attributes={},minPrice=null,maxPrice=null,inStock=false,sort='name',page=1,pageSize=24}={}){const categories=categoryIds.length?categoryIds:(categoryId?[categoryId]:[]);try{return await rpc('storefront_catalog_faceted',{p_filters:{query:query||null,category_ids:categories,brand_ids:brandIds,attributes,min_price:minPrice,max_price:maxPrice,in_stock:inStock,sort},p_limit:pageSize,p_offset:(page-1)*pageSize})}catch(error){if(!isSchemaCompatibilityError(error))throw error;const legacyCompatible=categories.length<=1&&brandIds.length===0&&Object.keys(attributes||{}).length===0&&(minPrice===null||minPrice==='')&&(maxPrice===null||maxPrice==='')&&!inStock&&sort==='name';if(!legacyCompatible)throw error;console.warn(`${DATABASE_UPDATE_MESSAGE} storefront_catalog_faceted o‘rniga cheklangan legacy katalog ishlatildi.`);const legacy=await rpc('storefront_catalog',{p_query:query||null,p_category_id:categories[0]||null,p_limit:pageSize,p_offset:(page-1)*pageSize});return{items:legacy?.items||[],total:Number(legacy?.total||0),facets:emptyFacets(),schema_warning:DATABASE_UPDATE_MESSAGE}}}
export const loadStorefrontProduct=slug=>rpc('storefront_product_detail',{p_slug:slug});
export async function loadStorefrontProducts(productIds){const ids=[...new Set((productIds||[]).map(id=>String(id).split('_')[0]))];const items=[];for(let offset=0;offset<ids.length;offset+=100){const batch=await rpc('storefront_products_by_ids',{p_product_ids:ids.slice(offset,offset+100)});items.push(...(batch||[]))}return items}
export async function loadStorefrontCms(){try{return await rpc('storefront_cms_payload')}catch(error){if(!isSchemaCompatibilityError(error))throw error;console.warn(`${DATABASE_UPDATE_MESSAGE} CMS uchun bo‘sh compatibility payload ishlatildi.`);return{banners:[],home_blocks:[],menu_items:[],promotions:[],pages:[],settings:{},schema_warning:DATABASE_UPDATE_MESSAGE}}}
export const loadStorefrontReferences=()=>rpc('storefront_references');
export function createCheckoutToken(){const bytes=new Uint8Array(32);globalThis.crypto.getRandomValues(bytes);return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('')}
export function submitOnlineOrder({customer,shippingAddress,lines,paymentMethodCode,idempotencyKey=crypto.randomUUID(),checkoutToken=createCheckoutToken(),notes=null}){return rpc('create_online_order_v2',{p_customer:customer,p_shipping_address:shippingAddress,p_lines:lines,p_payment_method_code:paymentMethodCode,p_idempotency_key:idempotencyKey,p_checkout_token:checkoutToken,p_notes:notes||null})}
async function paymentApi(path,{method='GET',body}={}){const{data}=await getBrowserClient().auth.getSession();const response=await fetch(`/api/payments/${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(data.session?.access_token?{Authorization:`Bearer ${data.session.access_token}`}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||'Payment API request failed.');return payload}
export async function loadStorefrontPaymentMethods(){const payload=await paymentApi('methods');return payload.methods||[]}
export function initiateOnlinePayment({orderId,checkoutToken,provider,idempotencyKey=crypto.randomUUID()}){return paymentApi('initiate',{method:'POST',body:{orderId,checkoutToken,provider,idempotencyKey}})}
export function getOnlinePaymentStatus({orderId,checkoutToken}){return paymentApi('status',{method:'POST',body:{orderId,checkoutToken}})}
export const loadCustomerAccount=()=>rpc('get_customer_account');
export const saveCustomerProfile=profile=>rpc('save_customer_profile',{p_profile:profile});
export const saveCustomerAddress=address=>rpc('save_customer_address',{p_address:address});
export const removeCustomerAddress=id=>rpc('delete_customer_address',{p_address_id:id});
export const setCustomerFavorite=(productId,favorite)=>rpc('set_customer_favorite',{p_product_id:productId,p_favorite:favorite});
export const setCustomerCartItem=(productId,quantity,variantId=null)=>{
  const safeVariantId = (variantId && variantId !== 'standard' && variantId !== 'default') ? variantId : null;
  return rpc('set_customer_cart_item',{p_product_id:productId,p_quantity:quantity,p_variant_id:safeVariantId});
};
export function loadCustomerOrders({page=1,pageSize=20}={}){return rpc('customer_order_history',{p_limit:pageSize,p_offset:(page-1)*pageSize})}
export async function getStorefrontSession(){const{data,error}=await getBrowserClient().auth.getSession();if(error)throw error;return data.session}
export async function signInCustomer(email,password){const{data,error}=await getBrowserClient().auth.signInWithPassword({email,password});if(error)throw error;return data}
export async function signUpCustomer({email,password,fullName,phone}){const{data,error}=await getBrowserClient().auth.signUp({email,password,options:{data:{full_name:fullName,phone}}});if(error)throw error;return data}
export async function signOutCustomer(){const{error}=await getBrowserClient().auth.signOut();if(error)throw error}
