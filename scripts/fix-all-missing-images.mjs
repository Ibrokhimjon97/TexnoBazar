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

function buildSearchQueries(name) {
  // Clean internal codes like R159, R270, 7TSDG, etc.
  const cleanName = name
    .replace(/\bR\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const queries = [cleanName];

  // Model-specific short query
  const words = cleanName.split(' ');
  if (words.length > 3) {
    queries.push(words.slice(0, 3).join(' '));
  }

  return queries;
}

async function searchImage(query) {
  try {
    const tokenRes = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
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

async function main() {
  console.log('=== RASMSIZ TOVARLARGA RASM TOPISH VA YUKLASH ===\n');

  // 1. Unpublish non-product items (accounting debt balances)
  await supabase.from('products').update({ is_published: false }).eq('sku', 'TB-10799');
  console.log('✅ TB-10799 (Ostatka qarzdorlik) unpublish qilindi.');

  // 2. Find published products missing media
  const { data: products } = await supabase
    .from('products')
    .select('id, sku, name')
    .eq('is_published', true);

  const { data: media } = await supabase.from('product_media').select('product_id');
  const hasMedia = new Set(media.map(m => m.product_id));

  const missing = products.filter(p => !hasMedia.has(p.id));
  console.log(`Rasmsiz qolgan tovarlar soni: ${missing.length} ta.\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < missing.length; i++) {
    const p = missing[i];
    console.log(`[${i + 1}/${missing.length}] Ishlanmoqda: [${p.sku}] ${p.name}...`);

    const queries = buildSearchQueries(p.name);
    let imgUrl = null;

    for (const q of queries) {
      imgUrl = await searchImage(q);
      if (imgUrl) break;
      await new Promise(r => setTimeout(r, 400));
    }

    if (!imgUrl) {
      console.log(`  ⚠️ Rasm topilmadi: ${p.name}`);
      failCount++;
      continue;
    }

    console.log(`  Topilgan rasm: ${imgUrl.slice(0, 70)}...`);
    const uploaded = await uploadImageToR2(p.id, imgUrl, p.name);

    if (!uploaded) {
      console.log(`  ❌ R2 ga yuklab bo'lmadi`);
      failCount++;
      continue;
    }

    const { error: insErr } = await supabase.from('product_media').insert({
      id: randomUUID(),
      product_id: p.id,
      r2_key: uploaded.r2_key,
      public_url: uploaded.public_url,
      mime_type: uploaded.mime_type,
      bytes: uploaded.bytes,
      alt_text: p.name,
      is_primary: true,
      sort_order: 0
    });

    if (insErr) {
      console.log(`  ❌ DB insert xatosi:`, insErr.message);
      failCount++;
    } else {
      console.log(`  ✅ Muvaffaqiyatli saqlandi!`);
      successCount++;
    }

    // Small delay to be polite to search
    await new Promise(r => setTimeout(r, 600));
  }

  console.log('\n=========================================');
  console.log(`🎉 YAKUNLANDI! Muvaffaqiyatli yuklangan: ${successCount} ta, Qolgan: ${failCount} ta`);
  console.log('=========================================');
}

main().catch(console.error);
