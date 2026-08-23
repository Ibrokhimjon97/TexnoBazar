import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const MAX = 10*1024*1024;
const ALLOWED = ['image/jpeg','image/png','image/webp','image/avif'];
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json' };

function response(statusCode, error, code) {
  return { statusCode,headers:CORS,body:JSON.stringify(code ? { error,code } : { error }) };
}
function requiredEnv(...names) {
  for (const name of names) if (process.env[name]) return process.env[name];
  throw new Error(`Missing server environment: ${names.join(' or ')}`);
}
function adminClient() {
  const url = requiredEnv('SUPABASE_URL','VITE_SUPABASE_URL').replace(/\/$/,'');
  const key = requiredEnv('SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY');
  return { url,client:createClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false,detectSessionInUrl:false } }) };
}
function tokenMetadata(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    return { issuer:typeof payload.iss === 'string' ? payload.iss : null,expiresAt:Number.isFinite(payload.exp) ? payload.exp : null };
  } catch { return { issuer:null,expiresAt:null }; }
}
function sameProject(issuer,url) {
  if (!issuer) return true;
  try { return new URL(issuer).host === new URL(url).host; } catch { return false; }
}
function r2Client() {
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  return new S3Client({
    region:'auto',
    endpoint:`https://${accountId}.r2.cloudflarestorage.com`,
    credentials:{ accessKeyId:requiredEnv('R2_ACCESS_KEY_ID'),secretAccessKey:requiredEnv('R2_SECRET_ACCESS_KEY') },
    requestChecksumCalculation:'WHEN_REQUIRED',
  });
}
async function canManageMedia(admin,userId) {
  const { data:profile,error:profileError } = await admin.from('profiles').select('is_active').eq('id',userId).maybeSingle();
  if (profileError) throw profileError;
  if (!profile?.is_active) return false;
  const { data:roles,error:rolesError } = await admin.from('profile_roles').select('role,branch_id').eq('profile_id',userId).in('role',['superadmin','admin','manager']);
  if (rolesError) throw rolesError;
  if (roles?.some(role => ['superadmin','admin'].includes(role.role) && role.branch_id === null)) return true;
  const branchIds = [...new Set((roles||[]).filter(role => role.role === 'manager' && role.branch_id).map(role => role.branch_id))];
  if (!branchIds.length) return false;
  const { data:branches,error:branchesError } = await admin.from('branches').select('id').in('id',branchIds).eq('is_active',true).limit(1);
  if (branchesError) throw branchesError;
  return Boolean(branches?.length);
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:204,headers:CORS };
  if (event.httpMethod !== 'POST') return response(405,'POST only');
  try {
    const token = (event.headers?.authorization||event.headers?.Authorization||'').replace(/^Bearer\s+/i,'');
    if (!token) return response(401,'Avtorizatsiya talab qilinadi.','AUTH_REQUIRED');

    const { client:admin,url:supabaseUrl } = adminClient();
    const metadata = tokenMetadata(token);
    if (!sameProject(metadata.issuer,supabaseUrl)) {
      console.error('media-complete token project mismatch',{ configuredHost:new URL(supabaseUrl).host,issuerHost:new URL(metadata.issuer).host,expiresAt:metadata.expiresAt });
      return response(401,'Sessiya boshqa loyiha uchun yaratilgan. Qayta kiring.','SESSION_PROJECT_MISMATCH');
    }
    const { data:{user}={},error:authError } = await admin.auth.getUser(token);
    if (authError||!user) {
      console.error('media-complete auth rejected',{ message:authError?.message||'User missing',configuredHost:new URL(supabaseUrl).host,issuerHost:metadata.issuer ? new URL(metadata.issuer).host : null,expiresAt:metadata.expiresAt });
      return response(401,'Sessiya yaroqsiz. Tizimga qayta kiring.','INVALID_SESSION');
    }
    if (!await canManageMedia(admin,user.id)) return response(403,'Rasm yuklash uchun ruxsat yo‘q.','FORBIDDEN');

    let body;
    try { body = JSON.parse(event.body||'{}'); } catch { return response(400,'So‘rov formati noto‘g‘ri.','INVALID_JSON'); }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.productId||'') || typeof body.key !== 'string') return response(400,'Rasm ma’lumoti noto‘g‘ri.','INVALID_DATA');
    if (!body.key.startsWith(`products/${body.productId}/`)) return response(400,'Rasm kaliti mahsulotga mos emas.','KEY_MISMATCH');

    const head = await r2Client().send(new HeadObjectCommand({ Bucket:requiredEnv('R2_BUCKET'),Key:body.key }));
    if (!ALLOWED.includes(head.ContentType) || !Number.isSafeInteger(head.ContentLength) || head.ContentLength <= 0 || head.ContentLength > MAX) return response(400,'R2 dagi fayl turi yoki hajmi noto‘g‘ri.','INVALID_FILE');

    const base = requiredEnv('R2_PUBLIC_BASE_URL').replace(/\/$/,'');
    const publicUrl = `${base}/${body.key}`;
    const { data,error } = await admin.rpc('attach_product_media',{ p_actor_id:user.id,p_product_id:body.productId,p_r2_key:body.key,p_public_url:publicUrl,p_mime_type:head.ContentType,p_bytes:head.ContentLength,p_alt_text:body.altText||null });
    if (error?.code === '42501') return response(403,'Rasmni mahsulotga biriktirish uchun ruxsat yo‘q.','FORBIDDEN');
    if (error?.code === 'P0002') return response(404,'Mahsulot topilmadi.','PRODUCT_NOT_FOUND');
    if (error) throw error;
    return { statusCode:201,headers:CORS,body:JSON.stringify({ mediaId:data,publicUrl }) };
  } catch (error) {
    console.error('media-complete failed',{ name:error?.name,code:error?.code,message:error?.message });
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return response(404,'R2 da yuklangan rasm topilmadi.','OBJECT_NOT_FOUND');
    return response(500,'Rasmni mahsulotga biriktirib bo‘lmadi.','MEDIA_COMPLETE_FAILED');
  }
}
