import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const MAX = 10*1024*1024;
const ALLOWED = ['image/jpeg','image/png','image/webp','image/avif'];
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json' };

function r2Client() {
  return new S3Client({ region:'auto', endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials:{ accessKeyId:process.env.R2_ACCESS_KEY_ID, secretAccessKey:process.env.R2_SECRET_ACCESS_KEY }});
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS };
  if (event.httpMethod !== 'POST') return { statusCode:405, headers:CORS, body:JSON.stringify({error:'POST only'}) };
  try {
    const token = (event.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if (!token) return { statusCode:401, headers:CORS, body:JSON.stringify({error:'Auth required'}) };
    const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {auth:{persistSession:false}});
    const { data:{user}, error:authErr } = await admin.auth.getUser(token);
    if (authErr||!user) return { statusCode:401, headers:CORS, body:JSON.stringify({error:'Invalid session'}) };
    const { data:roles } = await admin.from('profile_roles').select('role').eq('profile_id',user.id).in('role',['superadmin','admin','manager']);
    if (!roles?.length) return { statusCode:403, headers:CORS, body:JSON.stringify({error:'Forbidden'}) };

    const body = JSON.parse(event.body||'{}');
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.productId||'') || typeof body.key !== 'string') return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Invalid data'}) };
    if (!body.key.startsWith(`products/${body.productId}/`)) return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Key mismatch'}) };

    const head = await r2Client().send(new HeadObjectCommand({ Bucket:process.env.R2_BUCKET, Key:body.key }));
    if (!ALLOWED.includes(head.ContentType) || !head.ContentLength || head.ContentLength > MAX) return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Invalid file'}) };

    const base = (process.env.R2_PUBLIC_BASE_URL||'').replace(/\/$/,'');
    const { data, error } = await admin.rpc('attach_product_media', { p_actor_id:user.id, p_product_id:body.productId, p_r2_key:body.key, p_public_url:`${base}/${body.key}`, p_mime_type:head.ContentType, p_bytes:head.ContentLength, p_alt_text:body.altText||null });
    if (error) throw error;
    return { statusCode:201, headers:CORS, body:JSON.stringify({ mediaId:data, publicUrl:`${base}/${body.key}` }) };
  } catch(e) { return { statusCode:500, headers:CORS, body:JSON.stringify({error:e.message}) }; }
}
