import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const ALLOWED = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif' };
const MAX = 10*1024*1024;
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json' };

function response(statusCode, error, code) {
  return { statusCode, headers:CORS, body:JSON.stringify(code ? { error, code } : { error }) };
}
function requiredEnv(...names) {
  for (const name of names) if (process.env[name]) return process.env[name];
  throw new Error(`Missing server environment: ${names.join(' or ')}`);
}
function adminClient() {
  const url = requiredEnv('SUPABASE_URL','VITE_SUPABASE_URL').replace(/\/$/,'');
  const key = requiredEnv('SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY');
  return { url, client:createClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false,detectSessionInUrl:false } }) };
}
function tokenMetadata(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    return { issuer:typeof payload.iss === 'string' ? payload.iss : null, expiresAt:Number.isFinite(payload.exp) ? payload.exp : null };
  } catch { return { issuer:null,expiresAt:null }; }
}
function sameProject(issuer, url) {
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
async function canManageMedia(admin, userId) {
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
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS };
  if (event.httpMethod !== 'POST') return response(405,'POST only');
  try {
    const token = (event.headers?.authorization||event.headers?.Authorization||'').replace(/^Bearer\s+/i,'');
    if (!token) return response(401,'Avtorizatsiya talab qilinadi.','AUTH_REQUIRED');

    const { client:admin,url:supabaseUrl } = adminClient();
    const metadata = tokenMetadata(token);
    if (!sameProject(metadata.issuer,supabaseUrl)) {
      console.error('media-presign token project mismatch',{ configuredHost:new URL(supabaseUrl).host,issuerHost:new URL(metadata.issuer).host,expiresAt:metadata.expiresAt });
      return response(401,'Sessiya boshqa loyiha uchun yaratilgan. Qayta kiring.','SESSION_PROJECT_MISMATCH');
    }
    const { data:{user}={},error:authError } = await admin.auth.getUser(token);
    if (authError||!user) {
      console.error('media-presign auth rejected',{ message:authError?.message||'User missing',configuredHost:new URL(supabaseUrl).host,issuerHost:metadata.issuer ? new URL(metadata.issuer).host : null,expiresAt:metadata.expiresAt });
      return response(401,'Sessiya yaroqsiz. Tizimga qayta kiring.','INVALID_SESSION');
    }
    if (!await canManageMedia(admin,user.id)) return response(403,'Rasm yuklash uchun ruxsat yo‘q.','FORBIDDEN');

    let body;
    try { body = JSON.parse(event.body||'{}'); } catch { return response(400,'So‘rov formati noto‘g‘ri.','INVALID_JSON'); }
    const ext = ALLOWED[body.contentType];
    if (!ext || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > MAX) return response(400,'Rasm turi yoki hajmi noto‘g‘ri.','INVALID_FILE');
    if (body.scope !== 'products' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.ownerId||'')) return response(400,'Mahsulot identifikatori noto‘g‘ri.','INVALID_INPUT');
    const { data:product,error:productError } = await admin.from('products').select('id').eq('id',body.ownerId).maybeSingle();
    if (productError) throw productError;
    if (!product) return response(404,'Mahsulot topilmadi.','PRODUCT_NOT_FOUND');

    const key = `products/${body.ownerId}/${randomUUID()}.${ext}`;
    const command = new PutObjectCommand({ Bucket:requiredEnv('R2_BUCKET'),Key:key,ContentType:body.contentType,ContentLength:body.size,CacheControl:'public, max-age=31536000, immutable' });
    const uploadUrl = await getSignedUrl(r2Client(),command,{ expiresIn:300 });
    const publicUrl = `${requiredEnv('R2_PUBLIC_BASE_URL').replace(/\/$/,'')}/${key}`;
    return { statusCode:200,headers:CORS,body:JSON.stringify({ key,uploadUrl,publicUrl,expiresIn:300 }) };
  } catch (error) {
    console.error('media-presign failed',{ name:error?.name,code:error?.code,message:error?.message });
    return response(500,'Rasm yuklash manzilini tayyorlab bo‘lmadi.','PRESIGN_FAILED');
  }
}
