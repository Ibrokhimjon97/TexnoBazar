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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://duckduckgo.com/'
      }
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
  } catch {
    return null;
  }
}

async function fixOne(sku, queries) {
  const { data: prod } = await supabase.from('products').select('id, name').eq('sku', sku).single();
  console.log(`Fixing [${sku}] ${prod.name}...`);
  let imgUrl = null;
  for (const q of queries) {
    imgUrl = await searchImage(q);
    if (imgUrl) {
      console.log(`  Found with query "${q}": ${imgUrl.slice(0, 60)}...`);
      const up = await uploadImageToR2(prod.id, imgUrl, prod.name);
      if (up) {
        await supabase.from('product_media').insert({
          id: randomUUID(),
          product_id: prod.id,
          r2_key: up.r2_key,
          public_url: up.public_url,
          mime_type: up.mime_type,
          bytes: up.bytes,
          alt_text: prod.name,
          is_primary: true,
          sort_order: 0
        });
        console.log(`  ✅ Successfully saved to R2 and DB!`);
        return true;
      }
    }
  }
  console.log(`  ❌ Could not fix [${sku}]`);
  return false;
}

async function main() {
  await fixOne('TB-10637', [
    'Veko A0110 ventilyator',
    'Ventilyator Veko polga',
    'Ventilyator polga oq zamonaviy'
  ]);

  await fixOne('TB-10843', [
    'Holodilnik Energy RF 330 oq',
    'Energy RF 330 holodilnik',
    'Elite RF-330 oq holodilnik'
  ]);
}

main().catch(console.error);
