import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const ALLOWED = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif' };
const MAX = 5*1024*1024;
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'PUT,OPTIONS','Content-Type':'application/json' };

function response(statusCode,error,code) {
  return { statusCode,headers:CORS,body:JSON.stringify(code ? { error,code } : { error }) };
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

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:204,headers:CORS };
  if (event.httpMethod !== 'PUT') return response(405,'PUT only');
  try {
    const token = (event.headers?.authorization||event.headers?.Authorization||'').replace(/^Bearer\s+/i,'');
    if (!token) return response(401,'Avtorizatsiya talab qilinadi.','AUTH_REQUIRED');
    const admin = adminClient();
    const { data:{user}={},error:authError } = await admin.auth.getUser(token);
    if (authError||!user) {
      console.error('avatar-upload auth rejected',{ message:authError?.message||'User missing' });
      return response(401,'Sessiya yaroqsiz. Tizimga qayta kiring.','INVALID_SESSION');
    }
    const { data:profile,error:profileError } = await admin.from('profiles').select('is_active').eq('id',user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.is_active) return response(403,'Faol profil topilmadi.','FORBIDDEN');

    const contentType = (event.headers?.['content-type']||event.headers?.['Content-Type']||'').split(';')[0].trim().toLowerCase();
    const ext = ALLOWED[contentType];
    if (!ext) return response(400,'Faqat JPG, PNG, WebP yoki AVIF rasm.','INVALID_TYPE');
    const body = event.isBase64Encoded ? Buffer.from(event.body||'','base64') : Buffer.from(event.body||'','binary');
    if (!body.length || body.length > MAX) return response(400,'Rasm hajmi 5MB dan kichik bo‘lishi kerak.','INVALID_SIZE');

    // Users may only write their own avatar prefix; the key is generated server-side.
    const key = `avatars/${user.id}/${randomUUID()}.${ext}`;
    await r2Client().send(new PutObjectCommand({ Bucket:requiredEnv('R2_BUCKET'),Key:key,Body:body,ContentType:contentType,ContentLength:body.length,CacheControl:'public, max-age=31536000, immutable' }));
    const publicUrl = `${requiredEnv('R2_PUBLIC_BASE_URL').replace(/\/$/,'')}/${key}`;
    const { error:updateError } = await admin.from('profiles').update({ avatar_url:publicUrl }).eq('id',user.id);
    if (updateError) throw updateError;
    return { statusCode:200,headers:CORS,body:JSON.stringify({ publicUrl,key }) };
  } catch (error) {
    console.error('avatar-upload failed',{ name:error?.name,code:error?.code,message:error?.message });
    return response(500,'Profil rasmini yuklab bo‘lmadi.','AVATAR_UPLOAD_FAILED');
  }
}
