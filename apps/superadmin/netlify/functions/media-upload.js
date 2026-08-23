import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const ALLOWED = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif' };
const MAX = 10*1024*1024;
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'PUT,OPTIONS','Content-Type':'application/json' };
const KEY_PATTERN = /^products\/([0-9a-f]{8}-[0-9a-f-]{27})\/([0-9a-f-]{36})\.(jpg|png|webp|avif)$/i;

function response(statusCode,error,code) {
  return { statusCode,headers:CORS,body:statusCode === 204 ? '' : JSON.stringify(code ? { error,code } : { error }) };
}
function requiredEnv(...names) {
  for (const name of names) if (process.env[name]) return process.env[name];
  throw new Error(`Missing server environment: ${names.join(' or ')}`);
}
function adminClient() {
  const url = requiredEnv('SUPABASE_URL','VITE_SUPABASE_URL').replace(/\/$/,'');
  const key = requiredEnv('SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false,detectSessionInUrl:false } });
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
  if (event.httpMethod !== 'PUT') return response(405,'PUT only');
  try {
    const token = (event.headers?.authorization||event.headers?.Authorization||'').replace(/^Bearer\s+/i,'');
    if (!token) return response(401,'Avtorizatsiya talab qilinadi.','AUTH_REQUIRED');
    const admin = adminClient();
    const { data:{user}={},error:authError } = await admin.auth.getUser(token);
    if (authError||!user) return response(401,'Sessiya yaroqsiz. Tizimga qayta kiring.','INVALID_SESSION');
    if (!await canManageMedia(admin,user.id)) return response(403,'Rasm yuklash uchun ruxsat yo‘q.','FORBIDDEN');

    const key = event.queryStringParameters?.key||'';
    const keyMatch = key.match(KEY_PATTERN);
    const contentType = (event.headers?.['content-type']||event.headers?.['Content-Type']||'').split(';')[0].trim().toLowerCase();
    if (!keyMatch || !ALLOWED[contentType] || keyMatch[3].toLowerCase() !== ALLOWED[contentType]) return response(400,'Rasm kaliti yoki turi noto‘g‘ri.','INVALID_FILE');
    const productId = keyMatch[1];
    const { data:product,error:productError } = await admin.from('products').select('id').eq('id',productId).maybeSingle();
    if (productError) throw productError;
    if (!product) return response(404,'Mahsulot topilmadi.','PRODUCT_NOT_FOUND');

    const body = event.isBase64Encoded ? Buffer.from(event.body||'','base64') : Buffer.from(event.body||'','binary');
    if (!body.length || body.length > MAX) return response(400,'Rasm hajmi noto‘g‘ri.','INVALID_FILE_SIZE');
    await r2Client().send(new PutObjectCommand({ Bucket:requiredEnv('R2_BUCKET'),Key:key,Body:body,ContentType:contentType,ContentLength:body.length,CacheControl:'public, max-age=31536000, immutable' }));
    return response(204);
  } catch (error) {
    console.error('media-upload failed',{ name:error?.name,code:error?.code,message:error?.message });
    return response(500,'Rasmni R2 serveriga yuklab bo‘lmadi.','MEDIA_UPLOAD_FAILED');
  }
}
