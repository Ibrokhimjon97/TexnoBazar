import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = 'https://bnpmpdlyqmlefkrykfwq.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || '';
const R2_ENDPOINT = 'https://83ff42e129b06a230b874906dd65a57e.r2.cloudflarestorage.com';
const R2_ACCESS_KEY = '54135fdd486fe68421cda2afd58d3398';
const R2_SECRET_KEY = '68263629abdc51bf819c7a4f25888522562a8085f54af90da4810befef9bfcbf';
const R2_BUCKET = 'texnobazar-media';
const R2_PUBLIC_BASE = 'https://pub-5937e545e98947da80ae1ab2e8ead0d3.r2.dev';

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

async function searchImage(query) {
  try {
    const tokenRes = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const tokenHtml = await tokenRes.text();
    const vqd = tokenHtml.match(/vqd=['"]?([0-9-]+)['"]?/)?.[1];
    if (!vqd) return null;
    const res = await fetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://duckduckgo.com/' }
    });
    const data = await res.json();
    return data.results?.[0]?.image || null;
  } catch {
    return null;
  }
}

async function uploadImageToR2(productId, imageUrl, altText) {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1000) return null;

    let contentType = res.headers.get('content-type') || 'image/jpeg';
    contentType = contentType.split(';')[0].trim();
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';

    const key = `products/${productId}/${randomUUID()}.${ext}`;
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    return {
      r2_key: key,
      public_url: `${R2_PUBLIC_BASE}/${key}`,
      mime_type: contentType,
      bytes: buffer.length,
      alt_text: altText
    };
  } catch (e) {
    console.error('R2 upload error:', e.message);
    return null;
  }
}

async function fixProduct(sku, query) {
  const { data: prod } = await supabase.from('products').select('id, name').eq('sku', sku).maybeSingle();
  if (!prod) {
    console.log(`Product ${sku} not found!`);
    return;
  }
  console.log(`Fixing [${sku}] ${prod.name}...`);
  const imgUrl = await searchImage(query);
  if (!imgUrl) {
    console.log(`  ❌ Image not found for: ${query}`);
    return;
  }
  console.log(`  Found image URL: ${imgUrl}`);
  const media = await uploadImageToR2(prod.id, imgUrl, prod.name);
  if (!media) {
    console.log(`  ❌ Failed to upload image to R2`);
    return;
  }

  // Insert into product_media
  const { error } = await supabase.from('product_media').insert({
    id: randomUUID(),
    product_id: prod.id,
    r2_key: media.r2_key,
    public_url: media.public_url,
    mime_type: media.mime_type,
    bytes: media.bytes,
    alt_text: prod.name,
    is_primary: true,
    sort_order: 0
  });

  if (error) {
    console.error(`  ❌ DB error:`, error.message);
  } else {
    console.log(`  ✅ Successfully uploaded to R2 and saved in DB: ${media.public_url}`);
  }
}

async function main() {
  await fixProduct('TB-10860', 'Kolyaska S866 bolalar aravachasi');
  await fixProduct('TB-10853', 'Domassi 32-Q32i televizor');
  await fixProduct('TB-10854', 'Domassi 55-Q55i televizor');
  await fixProduct('TB-102000', 'Chopper LG888 3.8L maydalagich');
}

main().catch(console.error);
