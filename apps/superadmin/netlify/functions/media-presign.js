import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const ALLOWED = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif' };
const MAX = 10*1024*1024;
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
    const ext = ALLOWED[body.contentType];
    if (!ext || !body.size || body.size > MAX) return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Invalid file'}) };
    if (body.scope !== 'products' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.ownerId||'')) return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Invalid input'}) };

    const key = `products/${body.ownerId}/${randomUUID()}.${ext}`;
    const cmd = new PutObjectCommand({ Bucket:process.env.R2_BUCKET, Key:key, ContentType:body.contentType, ContentLength:body.size, CacheControl:'public, max-age=31536000, immutable' });
    const uploadUrl = await getSignedUrl(r2Client(), cmd, { expiresIn:300 });
    const publicUrl = `${(process.env.R2_PUBLIC_BASE_URL||'').replace(/\/$/,'')}/${key}`;
    return { statusCode:200, headers:CORS, body:JSON.stringify({ key, uploadUrl, publicUrl, expiresIn:300 }) };
  } catch(e) { return { statusCode:500, headers:CORS, body:JSON.stringify({error:e.message}) }; }
}
