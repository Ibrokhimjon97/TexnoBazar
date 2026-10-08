import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

const SUPABASE_URL = 'https://bnpmpdlyqmlefkrykfwq.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || '';
const R2_ENDPOINT = 'https://83ff42e129b06a230b874906dd65a57e.r2.cloudflarestorage.com';
const R2_ACCESS_KEY = '54135fdd486fe68421cda2afd58d3398';
const R2_SECRET_KEY = '68263629abdc51bf819c7a4f25888522562a8085f54af90da4810befef9bfcbf';
const R2_BUCKET = 'texnobazar-media';
const R2_PUBLIC_BASE = 'https://pub-5937e545e98947da80ae1ab2e8ead0d3.r2.dev';

const USD_RATE = 12800; // 1 USD = 12,800 UZS
const MARGIN = 1.30; // 30% ustama
const UNITS_PER_PRODUCT = 50; // Asosiy ombordagi soni

const BRANCH_ID = '7a3efcd0-0824-411a-b4f8-38be9c194950'; // Asosiy filial
const WAREHOUSE_ID = '51a8e570-f6aa-46dd-8762-eca6c85a4f05'; // Asosiy ombor
const SUPPLIER_ID = '65b1d3dc-d7c9-4911-898f-2b126511dd47'; // Artel / default supplier

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’ʻʼ']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractBrand(name) {
  const brands = [
    'Artel', 'Hofmann', 'Beko', 'Ziffler', 'Hisense', 'Avalon', 'Loretto',
    'Haier', 'Midea', 'Samsung', 'LG', 'Rulls', 'Domassi', 'Sonifer',
    'Bosch', 'Philips', 'Dyson', 'Energy', 'Elite', 'Agnat', 'Bueno',
    'Emerald', 'Mega', 'Kingway', 'Gorenje', 'Macbook', 'Apple'
  ];
  const upper = name.toUpperCase();
  for (const b of brands) {
    if (new RegExp(`\\b${b.toUpperCase()}\\b`).test(upper)) {
      return b;
    }
  }
  return 'Boshqa';
}

function mapCategory(rawCat, name) {
  const norm = (rawCat + ' ' + name).toLowerCase();
  if (norm.includes('kir') && norm.includes('moshina')) return 'Kir yuvish mashinalari';
  if (norm.includes('holodilnik') || norm.includes('morozilnik')) return 'Muzlatgichlar';
  if (norm.includes('konditsioner') || norm.includes('arc') || norm.includes('inverter')) return 'Havo sovutgichlar';
  if (norm.includes('televizor') || norm.includes('tv') || norm.includes('android14')) return 'Televizorlar';
  if (norm.includes('plisos') || norm.includes('changyutgich')) return 'Changyutgichlar';
  if (norm.includes('blender') || norm.includes('chopper') || norm.includes('myasurobka')) return 'Uy texnikasi';
  if (norm.includes('dazmol')) return 'Dazmollar';
  if (norm.includes('skuter') || norm.includes('tritsikl')) return 'Aksessuarlar';
  if (norm.includes('kolyaska')) return 'Uy texnikasi';
  if (norm.includes('karovat') || norm.includes('komod') || norm.includes('mebel')) return 'Mebellar';
  return 'Uy texnikasi';
}

const brandCache = new Map();
async function getOrCreateBrand(name) {
  if (brandCache.has(name)) return brandCache.get(name);
  const { data: existing } = await supabase.from('brands').select('id').ilike('name', name).maybeSingle();
  if (existing) {
    brandCache.set(name, existing.id);
    return existing.id;
  }
  const { data: created, error } = await supabase.from('brands').insert({
    name,
    slug: slugify(name),
    is_active: true
  }).select('id').single();
  if (error) return null;
  brandCache.set(name, created.id);
  return created.id;
}

const categoryCache = new Map();
async function getOrCreateCategory(name) {
  if (categoryCache.has(name)) return categoryCache.get(name);
  const { data: existing } = await supabase.from('categories').select('id').ilike('name', name).maybeSingle();
  if (existing) {
    categoryCache.set(name, existing.id);
    return existing.id;
  }
  const { data: created, error } = await supabase.from('categories').insert({
    name,
    slug: slugify(name),
    is_active: true
  }).select('id').single();
  if (error) return null;
  categoryCache.set(name, created.id);
  return created.id;
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
    if (buffer.length < 1000) return null; // Too small / corrupted
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

    return {
      r2_key: key,
      public_url: `${R2_PUBLIC_BASE}/${key}`,
      mime_type: contentType,
      bytes: buffer.length,
      alt_text: altText
    };
  } catch (err) {
    return null;
  }
}

async function scrapeUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'uz,ru;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const ogImg = html.match(/<meta\s+property=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i)?.[1];
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title>([^<]+)<\/title>/i)?.[1];
    const ogDesc = html.match(/<meta\s+property=["'](?:og:description|description)["']\s+content=["']([^"']+)["']/i)?.[1];

    const images = [];
    if (ogImg && ogImg.startsWith('http')) images.push(ogImg);

    // Site-specific gallery images
    if (url.includes('asaxiy.uz')) {
      const matches = [...html.matchAll(/https:\/\/assets\.asaxiy\.uz\/product\/[^\s"']+\.(?:jpg|png|webp)/gi)];
      for (const m of matches) if (!images.includes(m[0])) images.push(m[0]);
    } else if (url.includes('uzum.uz')) {
      const matches = [...html.matchAll(/https:\/\/images\.uzum\.uz\/[a-z0-9]+\/(?:original|t_product_540_high)\.jpg/gi)];
      for (const m of matches) {
        const orig = m[0].replace(/t_product_[0-9]+_high/g, 'original');
        if (!images.includes(orig)) images.push(orig);
      }
    } else if (url.includes('mediapark.uz')) {
      const matches = [...html.matchAll(/https:\/\/mediapark\.uz\/[^\s"']+\.(?:jpg|png|webp)/gi)];
      for (const m of matches) if (!images.includes(m[0])) images.push(m[0]);
    } else if (url.includes('alifshop.uz')) {
      const matches = [...html.matchAll(/https:\/\/alifshop\.uz\/[^\s"']+\.(?:jpg|png|webp)/gi)];
      for (const m of matches) if (!images.includes(m[0])) images.push(m[0]);
    }

    return {
      title: ogTitle?.trim(),
      description: ogDesc?.trim(),
      images: images.slice(0, 4)
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log('=== TEXNOBAZAR TOVARLARINI TO‘LIQ IMPORT QILISH BOSHLANDI ===\n');

  // Load existing products from DB to avoid duplicate SKU / names
  const { data: existingProducts } = await supabase.from('products').select('id, sku, name');
  const existingSkuSet = new Set((existingProducts || []).map(p => p.sku));
  console.log(`Bazada avvaldan mavjud tovarlar: ${existingProducts?.length || 0} ta.`);

  // Load Excel
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('tovarlar.xlsx');
  const ws = wb.worksheets[0];

  const products = [];
  const allUrls = [];

  for (let r = 5; r <= ws.rowCount; r++) {
    const val = ws.getRow(r).values;
    const code = String(val[3] || '').trim();
    const name = String(val[4] || '').trim();
    const cat = String(val[5] || '').trim();
    const cost = Number(val[6] || 0);
    const url = val[7];
    const urlStr = (typeof url === 'object' ? url.text || url.hyperlink : (url || '')).trim();

    if (name) {
      products.push({ row: r, code, name, cat, cost, url: urlStr });
    }
    if (urlStr && urlStr.startsWith('http')) {
      allUrls.push({ row: r, url: urlStr });
    }
  }

  console.log(`Exceldagi tovarlar: ${products.length} ta, URLlar: ${allUrls.length} ta.`);

  // Smart URL Matching: map each product to its most accurate URL
  function getTokens(name) {
    return name.toLowerCase().split(/[\s/,\-_()]+/).filter(w => w.length >= 2 && !['avtomat', 'kir', 'moshina', 'holodilnik', 'konditsioner', 'televizor', 'kg', 'seriy', 'oq'].includes(w));
  }

  const usedUrls = new Set();
  const importQueue = [];

  for (const p of products) {
    const pTokens = getTokens(p.name);
    let bestUrl = null;
    let maxScore = 0;

    for (const u of allUrls) {
      if (usedUrls.has(u.url)) continue;
      const urlNorm = u.url.toLowerCase();
      let score = 0;
      for (const t of pTokens) {
        if (t.length >= 3 && urlNorm.includes(t)) {
          score += (t.length >= 4 ? 3 : 1);
        }
      }
      if (score > maxScore && score >= 3) {
        maxScore = score;
        bestUrl = u.url;
      }
    }

    // If smart matching found a match
    if (bestUrl) {
      usedUrls.add(bestUrl);
      importQueue.push({ ...p, matchedUrl: bestUrl });
    } else if (p.url && p.url.startsWith('http') && !usedUrls.has(p.url)) {
      // Fallback: use direct row URL if not claimed
      usedUrls.add(p.url);
      importQueue.push({ ...p, matchedUrl: p.url });
    }
  }

  console.log(`\nImport qilinadigan URLli tovarlar: ${importQueue.length} ta.\n`);

  const createdLinesForBatch = [];
  let processedCount = 0;
  let successCount = 0;

  for (const item of importQueue) {
    processedCount++;
    const sku = `TB-${item.code}`;

    if (existingSkuSet.has(sku)) {
      console.log(`[${processedCount}/${importQueue.length}] O'tkazildi (avval mavjud): ${sku} - ${item.name}`);
      continue;
    }

    console.log(`[${processedCount}/${importQueue.length}] Ishlanmoqda: [${item.code}] ${item.name.slice(0, 40)}...`);

    const brandName = extractBrand(item.name);
    const categoryName = mapCategory(item.cat, item.name);

    const brandId = await getOrCreateBrand(brandName);
    const categoryId = await getOrCreateCategory(categoryName);

    const costUzs = Math.max(10000, Math.round((item.cost || 100) * USD_RATE));
    const retailUzs = Math.round(costUzs * MARGIN);
    const minPriceUzs = retailUzs;

    // Scrape data & images
    const scraped = await scrapeUrl(item.matchedUrl);
    const productId = randomUUID();
    const productSlug = `${slugify(item.name)}-${item.code}`;

    const title = scraped?.title || item.name;
    const desc = scraped?.description || `${item.name} — eng so'nggi model, kafolatlangan yuqori sifat va rasmiy servis.`;

    // 1. Insert product
    const { error: pErr } = await supabase.from('products').insert({
      id: productId,
      sku,
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
      description: desc,
      seo_title: `${item.name} — narxlar, tavsif va xususiyatlar`,
      seo_description: `${item.name} sotib olish. Tez yetkazib berish va rasmiy kafolat.`
    });

    if (pErr) {
      console.error(`  ❌ DB xatosi (${sku}):`, pErr.message);
      continue;
    }

    existingSkuSet.add(sku);
    successCount++;

    // 2. Upload images to R2 and insert into product_media
    const images = scraped?.images || [];
    let isPrimary = true;
    let order = 0;

    for (const imgUrl of images) {
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
          sort_order: order++
        });
        isPrimary = false;
      }
    }

    // Add to batch receiving list
    createdLinesForBatch.push({
      product_id: productId,
      quantity: UNITS_PER_PRODUCT,
      unit_cost: item.cost || 100,
      retail_price: retailUzs,
      minimum_sale_price: minPriceUzs
    });

    // Receive stock in batches of 30 products
    if (createdLinesForBatch.length >= 30) {
      await receiveStockChunk(createdLinesForBatch.splice(0, 30));
    }
  }

  // Receive remaining lines
  if (createdLinesForBatch.length > 0) {
    await receiveStockChunk(createdLinesForBatch);
  }

  console.log(`\n======================================================`);
  console.log(`🎉 BARCHA TOVARLAR MUVAFFAQIYATLI IMPORT QILINDI!`);
  console.log(`   Yangi qo'shilgan mahsulotlar: ${successCount} ta`);
  console.log(`   Har biriga ${UNITS_PER_PRODUCT} tadan Asosiy omborga kirim qilindi.`);
  console.log(`======================================================\n`);
}

async function receiveStockChunk(lines) {
  const receiptNo = `BATCH-${Date.now().toString().slice(-7)}`;
  console.log(`\n🏬 Ombor kirimi: ${lines.length} ta tovardan ${UNITS_PER_PRODUCT} tadan (${receiptNo})...`);

  const header = {
    branch_id: BRANCH_ID,
    receiving_location_id: WAREHOUSE_ID,
    supplier_id: SUPPLIER_ID,
    receipt_no: receiptNo,
    currency: 'USD',
    payment_status: 'paid',
    received_at: new Date().toISOString()
  };

  const { error } = await supabase.rpc('receive_stock', {
    p_header: header,
    p_lines: lines,
    p_idempotency_key: randomUUID()
  });

  if (error) {
    console.error('  ❌ Partiya kirimida xatolik:', error.message);
  } else {
    console.log(`  ✅ ${lines.length * UNITS_PER_PRODUCT} dona mahsulot birligi va QR kodlari yaratildi!`);
  }
}

main().catch(console.error);
