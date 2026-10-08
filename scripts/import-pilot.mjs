import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

const SUPABASE_URL = 'https://bnpmpdlyqmlefkrykfwq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJucG1wZGx5cW1sZWZrcnlrZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3ODg5MjMsImV4cCI6MjEwMjM2NDkyM30.cx1xjo9jOSPuqJWm0Nb6XG1kDYcnZt1DD4TTW439tQI';
const R2_ENDPOINT = 'https://83ff42e129b06a230b874906dd65a57e.r2.cloudflarestorage.com';
const R2_ACCESS_KEY = '54135fdd486fe68421cda2afd58d3398';
const R2_SECRET_KEY = '68263629abdc51bf819c7a4f25888522562a8085f54af90da4810befef9bfcbf';
const R2_BUCKET = 'texnobazar-media';
const R2_PUBLIC_BASE = 'https://pub-5937e545e98947da80ae1ab2e8ead0d3.r2.dev';

const USD_RATE = 12800; // 1 USD = 12,800 UZS
const MARGIN = 1.30; // 30% marja

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
});

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’ʻʼ']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function uploadImageToR2(productId, imageUrl, altText = '') {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const key = `products/${productId}/${randomUUID()}.${ext}`;

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    const publicUrl = `${R2_PUBLIC_BASE}/${key}`;
    return {
      r2_key: key,
      public_url: publicUrl,
      mime_type: contentType,
      bytes: buffer.length,
      alt_text: altText
    };
  } catch (err) {
    console.error(`  [R2 Upload error] ${imageUrl}:`, err.message);
    return null;
  }
}

async function scrapeAsaxiy(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'uz,ru;q=0.9'
    }
  });
  if (!res.ok) return null;
  const html = await res.text();
  const ogImg = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1];
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1];

  // Also extract gallery images
  const galleryMatches = [...html.matchAll(/https:\/\/assets\.asaxiy\.uz\/product\/[^\s"']+\.(?:jpg|png|webp)/gi)];
  const images = [];
  if (ogImg) images.push(ogImg);
  for (const m of galleryMatches) {
    if (!images.includes(m[0])) images.push(m[0]);
  }

  return {
    title: ogTitle,
    description: ogDesc,
    images: images.slice(0, 5)
  };
}

async function scrapeUzum(url) {
  // Extract images from uzum page
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru,uz;q=0.9,en;q=0.8'
      }
    });
    const html = await res.text();
    const ogImg = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1];
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
    const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1];
    const imgMatches = [...html.matchAll(/https:\/\/images\.uzum\.uz\/[a-z0-9]+\/(?:original|t_product_540_high)\.jpg/gi)];
    const images = [];
    if (ogImg) images.push(ogImg);
    for (const m of imgMatches) {
      const orig = m[0].replace(/t_product_[0-9]+_high/g, 'original');
      if (!images.includes(orig)) images.push(orig);
    }
    return {
      title: ogTitle,
      description: ogDesc,
      images: images.slice(0, 5)
    };
  } catch (err) {
    console.error('  [Uzum scraper error]:', err.message);
    return null;
  }
}

async function scrapeUrl(url) {
  if (!url) return null;
  if (url.includes('asaxiy.uz')) return scrapeAsaxiy(url);
  if (url.includes('uzum.uz')) return scrapeUzum(url);
  // Generic fallback
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const ogImg = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1];
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
    const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1];
    return {
      title: ogTitle,
      description: ogDesc,
      images: ogImg ? [ogImg] : []
    };
  } catch {
    return null;
  }
}

async function ensureBrand(name) {
  if (!name) return null;
  const clean = name.trim();
  const { data: existing } = await supabase.from('brands').select('id, name').ilike('name', clean).maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await supabase.from('brands').insert({
    name: clean,
    slug: slugify(clean),
    is_active: true
  }).select('id').single();
  if (error) {
    console.error('  Brand insert error:', error.message);
    return null;
  }
  return created.id;
}

async function ensureCategory(name, parentName = null) {
  const clean = name.trim();
  const { data: existing } = await supabase.from('categories').select('id, name').ilike('name', clean).maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await supabase.from('categories').insert({
    name: clean,
    slug: slugify(clean),
    is_active: true
  }).select('id').single();
  if (error) {
    console.error('  Category insert error:', error.message);
    return null;
  }
  return created.id;
}

async function main() {
  console.log('🚀 1-BOSQICH: Test tariqasida 5 ta mahsulotni import qilish boshlandi...\n');

  // 1. Authenticate as superadmin
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: 'superadmin@texnobazar.uz',
    password: 'TnbSuper2026Q7'
  });
  if (authErr) throw new Error('Superadmin auth failed: ' + authErr.message);
  console.log('✅ Superadmin avtorizatsiyadan o‘tdi.');

  // Test 5 products curated with accurate models and URLs
  const pilotProducts = [
    {
      code: '10891',
      name: 'Hofmann WM814SDG/HF 8 kg avtomat kir yuvish mashinasi',
      brand: 'Hofmann',
      category: 'Kir yuvish mashinalari',
      costUsd: 495,
      url: 'https://asaxiy.uz/product/stiralnaya-mashina-hofmann-wm814sdghf-8-kg'
    },
    {
      code: '10890',
      name: 'Artel ART-WM8002 B Pure 8 kg avtomat kir yuvish mashinasi',
      brand: 'Artel',
      category: 'Kir yuvish mashinalari',
      costUsd: 391,
      url: 'https://uzum.uz/ru/product/stiralnaya-mashina-artel-artwm-8002pure-8-1801637?skuId=6275674'
    },
    {
      code: '10889',
      name: 'Beko WDB 7425 7 kg avtomat kir yuvish mashinasi',
      brand: 'Beko',
      category: 'Kir yuvish mashinalari',
      costUsd: 420,
      url: 'https://asaxiy.uz/product/stiralnaya-mashina-s-sushkoj-beko-wdb-7425-r2w'
    },
    {
      code: '10873',
      name: 'Ziffler BWM8-A5DBG 8 kg avtomat kir yuvish mashinasi',
      brand: 'Ziffler',
      category: 'Kir yuvish mashinalari',
      costUsd: 216,
      url: 'https://asaxiy.uz/product/stiralnaya-mashina-ziffler-bwm8-a5dbg-8-kg'
    },
    {
      code: '10869',
      name: 'Hisense RD39WCR-INOX muzlatgich',
      brand: 'Hisense',
      category: 'Muzlatgichlar',
      costUsd: 401,
      url: 'https://asaxiy.uz/ru/product/holodilnik-hisense-rd39wcr-inox'
    }
  ];

  const createdProductIds = [];
  const linesForBatch = [];

  for (const item of pilotProducts) {
    console.log(`\n📦 [${item.code}] ${item.name} tayyorlanmoqda...`);

    const costUzs = Math.round(item.costUsd * USD_RATE);
    const retailUzs = Math.round(costUzs * MARGIN);
    const minPriceUzs = retailUzs; // user requested 30% margin

    const brandId = await ensureBrand(item.brand);
    const categoryId = await ensureCategory(item.category);

    console.log(`  🌐 Scraper: ${item.url}`);
    const scraped = await scrapeUrl(item.url);
    console.log(`  🔍 Scraped: title=${scraped?.title ? 'topildi' : 'yoq'}, rasmlar soni=${scraped?.images?.length || 0}`);

    // Create product in DB
    const productId = randomUUID();
    const productSlug = `${slugify(item.name)}-${item.code}`;

    const { error: pErr } = await supabase.from('products').insert({
      id: productId,
      sku: `TB-${item.code}`,
      barcode: `2000000${item.code}`.slice(0, 13),
      name: item.name,
      slug: productSlug,
      category_id: categoryId,
      brand_id: brandId,
      cost_price: costUzs,
      retail_price: retailUzs,
      minimum_sale_price: minPriceUzs,
      status: 'active',
      is_published: true,
      track_individual_units: true,
      description: scraped?.description || `${item.name} — eng so'nggi model, kafolatlangan yuqori sifat va rasmiy servis.`,
      seo_title: `${item.name} — eng arzon narxda Texnobazarda`,
      seo_description: `${item.name} sotib olish. Tez yetkazib berish va rasmiy kafolat.`
    });

    if (pErr) {
      console.error('  ❌ Product yaratishda xatolik:', pErr.message);
      continue;
    }
    console.log(`  ✅ Mahsulot DB da yaratildi: ID = ${productId}`);
    createdProductIds.push(productId);

    // Upload images to R2 and insert into product_media
    let isPrimary = true;
    const imagesToUpload = scraped?.images?.length ? scraped.images : [];
    for (const imgUrl of imagesToUpload) {
      console.log(`  🖼️ R2 ga yuklanmoqda: ${imgUrl}`);
      const media = await uploadImageToR2(productId, imgUrl, item.name);
      if (media) {
        await supabase.from('product_media').insert({
          id: randomUUID(),
          product_id: productId,
          r2_key: media.r2_key,
          public_url: media.public_url,
          mime_type: media.mime_type,
          bytes: media.bytes,
          alt_text: item.name,
          is_primary: isPrimary,
          sort_order: isPrimary ? 0 : 1
        });
        isPrimary = false;
      }
    }

    linesForBatch.push({
      product_id: productId,
      quantity: 50,
      unit_cost: item.costUsd, // batch receiving in USD
      retail_price: retailUzs,
      minimum_sale_price: minPriceUzs
    });
  }

  // 2. Kirim qilish (Stock Receiving into Asosiy ombor)
  console.log('\n🏬 Partiya qabuli: 5 ta tovardan 50 tadan Asosiy omborga kirim qilinmoqda...');
  const header = {
    branch_id: '7a3efcd0-0824-411a-b4f8-38be9c194950', // Asosiy filial
    receiving_location_id: '51a8e570-f6aa-46dd-8762-eca6c85a4f05', // Asosiy ombor
    supplier_id: '65b1d3dc-d7c9-4911-898f-2b126511dd47', // Artel / default supplier
    receipt_no: `PILOT-${Date.now().toString().slice(-6)}`,
    currency: 'USD',
    payment_status: 'paid',
    received_at: new Date().toISOString()
  };

  const { data: receiptResult, error: receiptError } = await supabase.rpc('receive_stock', {
    p_header: header,
    p_lines: linesForBatch,
    p_idempotency_key: randomUUID()
  });

  if (receiptError) {
    console.error('❌ Partiya qabul qilishda xatolik:', receiptError.message);
  } else {
    console.log(`✅ Partiya qabul qilindi! Partiya raqami: ${header.receipt_no}`);
    console.log(`   Jami mahsulot birliklari (inventory_units): ${linesForBatch.length * 50} ta QR kod yaratildi!`);
  }

  console.log('\n🎉 1-BOSQICH (Test) muvaffaqiyatli yakunlandi!');
}

main().catch(console.error);
