import JSZip from 'jszip';
import { getAccessToken, getBrowserClient } from './auth.js';
import { throwDataError } from './errors.js';

const API_BASE = (import.meta.env?.VITE_API_BASE || '').replace(/\/+$/, '');

async function rpc(name, args = {}) {
  const { data, error } = await getBrowserClient().rpc(name, args);
  if (error) throwDataError(error, name);
  return data;
}

/**
 * Eksport uchun ma'lumotlar soni va xulosasini oladi.
 */
export async function getBackupSummary(branchId = null) {
  const data = await rpc('export_backup_data', { p_branch_id: branchId || null });
  return {
    categories: data.categories?.length || 0,
    brands: data.brands?.length || 0,
    products: data.products?.length || 0,
    variants: data.product_variants?.length || 0,
    media: data.product_media?.length || 0,
    batches: data.stock_batches?.length || 0,
    receipts: data.stock_receipts?.length || 0,
    units: data.inventory_units?.length || 0,
    suppliers: data.suppliers?.length || 0,
    locations: data.locations?.length || 0,
    branches: data.branches?.length || 0,
    balances: data.inventory_balances?.length || 0,
  };
}

/**
 * Barcha tovarlar, partiyalar, narxlar va Cloudflare R2 rasmlarini ZIP qilib yuklaydi.
 */
export async function exportBackupArchive({ branchId = null, includeMedia = true, onProgress } = {}) {
  onProgress?.({ stage: 'fetching_data', percent: 10, message: 'Baza ma’lumotlari olinmoqda…' });

  const data = await rpc('export_backup_data', { p_branch_id: branchId || null });
  const zip = new JSZip();

  const counts = {
    categories: data.categories?.length || 0,
    brands: data.brands?.length || 0,
    products: data.products?.length || 0,
    variants: data.product_variants?.length || 0,
    media: data.product_media?.length || 0,
    batches: data.stock_batches?.length || 0,
    receipts: data.stock_receipts?.length || 0,
    units: data.inventory_units?.length || 0,
    suppliers: data.suppliers?.length || 0,
    locations: data.locations?.length || 0,
    branches: data.branches?.length || 0,
  };

  const manifest = {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    system: 'Texnobazar ERP/POS',
    branch_id: branchId,
    include_media: includeMedia,
    counts,
  };

  // 1. Tovarlar nomlari xaritasi (fayl tizimida xavfsiz va tushunarli bo'lishi uchun)
  const nameCounts = {};
  if (Array.isArray(data.products)) {
    for (const p of data.products) {
      const safe = (p.name || 'tovar').replace(/[\\/:*?"<>|]/g, ' - ').trim().replace(/\s+/g, ' ');
      nameCounts[safe] = (nameCounts[safe] || 0) + 1;
    }
  }

  const productNameMap = new Map();
  const seenCounts = {};
  if (Array.isArray(data.products)) {
    for (const p of data.products) {
      const safe = (p.name || 'tovar').replace(/[\\/:*?"<>|]/g, ' - ').trim().replace(/\s+/g, ' ');
      if (nameCounts[safe] > 1) {
        seenCounts[safe] = (seenCounts[safe] || 0) + 1;
        productNameMap.set(p.id, `${safe} (${seenCounts[safe]})`);
      } else {
        productNameMap.set(p.id, safe);
      }
    }
  }

  // R2 rasmlarini (tovarlar, bannerlar, kategoriyalar) yuklab olib ZIP ga joylashtirish
  if (includeMedia) {
    const mediaMap = new Map(); // zipKey -> { r2Key, url }

    // 1. Mahsulot rasmlari: products/{tovar_nomi}/{fayl_nomi}
    if (Array.isArray(data.product_media)) {
      for (const m of data.product_media) {
        if (!m.r2_key) continue;
        let zipKey = m.r2_key;
        if (m.r2_key.startsWith('products/')) {
          const parts = m.r2_key.split('/');
          const prodId = parts[1];
          const fileName = parts.slice(2).join('/');
          const humanName = productNameMap.get(prodId) || prodId;
          zipKey = `products/${humanName}/${fileName}`;
        }
        mediaMap.set(zipKey, { r2Key: m.r2_key, url: m.public_url || '' });
      }
    }

    // 2. Bosh sahifa banner rasmlari
    if (Array.isArray(data.cms_banners)) {
      for (const b of data.cms_banners) {
        if (b.r2_key) mediaMap.set(b.r2_key, { r2Key: b.r2_key, url: b.image_url || '' });
        if (b.mobile_r2_key) mediaMap.set(b.mobile_r2_key, { r2Key: b.mobile_r2_key, url: b.mobile_image_url || '' });
      }
    }

    // 3. Kategoriya rasmlari
    if (Array.isArray(data.categories)) {
      for (const c of data.categories) {
        const catUrl = c.seo_image_url || c.image_url;
        if (catUrl && catUrl.includes('/categories/')) {
          const key = 'categories/' + catUrl.split('/categories/')[1];
          if (!mediaMap.has(key)) mediaMap.set(key, { r2Key: key, url: catUrl });
        }
      }
    }

    // zip_path -> r2_key xaritasini manifestga yozamiz
    const mediaKeyMap = {};
    for (const [zipKey, obj] of mediaMap.entries()) {
      mediaKeyMap[zipKey] = obj.r2Key;
    }
    manifest.media_map = mediaKeyMap;
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('data.json', JSON.stringify(data, null, 2));

    const mediaEntries = Array.from(mediaMap.entries()).map(([zipKey, obj]) => ({
      zipKey,
      r2Key: obj.r2Key,
      url: obj.url,
    }));

    if (mediaEntries.length > 0) {
      const mediaFolder = zip.folder('media');

      for (let i = 0; i < mediaEntries.length; i++) {
        const item = mediaEntries[i];
        const progressPercent = 10 + Math.round(((i + 1) / mediaEntries.length) * 55);
        onProgress?.({
          stage: 'fetching_media',
          current: i + 1,
          total: mediaEntries.length,
          percent: progressPercent,
          message: `Rasm yuklanmoqda (${i + 1}/${mediaEntries.length})…`,
        });

        try {
          let resp = null;
          // Avval to'g'ridan-to'g'ri urinib ko'ramiz
          if (item.url) {
            try {
              resp = await fetch(item.url);
            } catch {
              // CORS xatosi yuz bersa proxy orqali olamiz
            }
          }
          // Agar yuklanmasa yoki CORS bo'lsa, server media-proxy orqali 100% yuklab olamiz
          if (!resp || !resp.ok) {
            resp = await fetch(`${API_BASE}/api/backup/media-proxy?key=${encodeURIComponent(item.r2Key)}`);
          }
          if (resp && resp.ok) {
            const buffer = await resp.arrayBuffer();
            mediaFolder.file(item.zipKey, buffer);
          }
        } catch (err) {
          console.warn(`Rasm yuklab olinmadi: ${item.zipKey}`, err);
        }
      }
    }
  } else {
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('data.json', JSON.stringify(data, null, 2));
  }


  onProgress?.({ stage: 'zipping', percent: 70, message: 'ZIP arxiv qadoqlanmoqda…' });

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    metadata => {
      onProgress?.({
        stage: 'zipping',
        percent: 70 + Math.round(metadata.percent * 0.28),
        message: `ZIP arxiv qadoqlanmoqda: ${Math.round(metadata.percent)}%…`,
      });
    }
  );

  onProgress?.({ stage: 'done', percent: 100, message: 'Zahira tayyor!' });

  // Brauzer orqali avtomatik yuklab olish
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const filename = `texnobazar-backup-${dateStr}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  return { filename, size: blob.size, counts };
}

/**
 * Yuklangan ZIP arxivni tahlil qilib, uning tarkibini qaytaradi.
 */
export async function inspectBackupArchive(file) {
  if (!file) throw new Error('Zahira ZIP fayli tanlanmadi.');
  const zip = await JSZip.loadAsync(file);

  const manifestFile = zip.file('manifest.json');
  const dataFile = zip.file('data.json');

  if (!dataFile) {
    throw new Error('ZIP faylda data.json topilmadi. Bu yaroqli Texnobazar zahira fayli emas.');
  }

  let manifest = null;
  if (manifestFile) {
    try {
      manifest = JSON.parse(await manifestFile.async('text'));
    } catch {
      manifest = null;
    }
  }

  const data = JSON.parse(await dataFile.async('text'));

  // Media fayllar ro'yxatini aniqlash
  const mediaFiles = [];
  zip.folder('media')?.forEach((relativePath, fileObj) => {
    if (!fileObj.dir) {
      mediaFiles.push(relativePath);
    }
  });

  return {
    isValid: true,
    manifest,
    data,
    counts: {
      categories: data.categories?.length || 0,
      brands: data.brands?.length || 0,
      products: data.products?.length || 0,
      variants: data.product_variants?.length || 0,
      media: data.product_media?.length || 0,
      batches: data.stock_batches?.length || 0,
      receipts: data.stock_receipts?.length || 0,
      units: data.inventory_units?.length || 0,
      mediaFilesCount: mediaFiles.length,
    },
    mediaFiles,
  };
}

/**
 * ZIP faylni o'qib, Cloudflare R2 rasmlarini va Supabase bazasini 100% tiklaydi.
 */
export async function restoreBackupArchive(file, { onProgress } = {}) {
  onProgress?.({ stage: 'reading_zip', percent: 10, message: 'ZIP arxiv o‘qilmoqda va tekshirilmoqda…' });

  const inspected = await inspectBackupArchive(file);
  const { data, manifest } = inspected;
  const mediaMap = manifest?.media_map || {};
  const zip = await JSZip.loadAsync(file);

  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');

  // 1. Cloudflare R2 ga rasmlarni tiklash
  const mediaFolder = zip.folder('media');
  const mediaEntries = [];

  if (mediaFolder) {
    mediaFolder.forEach((relativePath, fileObj) => {
      if (!fileObj.dir) {
        mediaEntries.push({ key: relativePath, fileObj });
      }
    });
  }

  if (mediaEntries.length > 0) {
    onProgress?.({ stage: 'restoring_media', percent: 15, message: `Cloudflare R2 ga ${mediaEntries.length} ta rasm tiklanmoqda…` });

    // R2 ga rasmlarni kichik partiyalar bilan (har 3 tadan) yuboramiz
    const batchSize = 3;
    for (let i = 0; i < mediaEntries.length; i += batchSize) {
      const slice = mediaEntries.slice(i, i + batchSize);
      const preparedFiles = [];

      for (const entry of slice) {
        const base64 = await entry.fileObj.async('base64');
        const ext = entry.key.split('.').pop()?.toLowerCase();
        const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
        const targetR2Key = mediaMap[entry.key] || entry.key;
        preparedFiles.push({
          key: targetR2Key,
          base64,
          contentType,
        });
      }

      const progressPercent = 15 + Math.round(((i + slice.length) / mediaEntries.length) * 45);
      onProgress?.({
        stage: 'restoring_media',
        current: Math.min(i + slice.length, mediaEntries.length),
        total: mediaEntries.length,
        percent: progressPercent,
        message: `Cloudflare R2 ga rasmlar tiklanmoqda (${Math.min(i + slice.length, mediaEntries.length)}/${mediaEntries.length})…`,
      });

      const res = await fetch(`${API_BASE}/api/backup/restore-media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ files: preparedFiles }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        console.warn('R2 media tiklashda xatolik:', errJson.error || res.statusText);
      }
    }
  }

  // 2. Supabase bazasiga ma'lumotlarni tiklash
  onProgress?.({ stage: 'restoring_db', percent: 70, message: 'Baza ma’lumotlari (tovarlar, narxlar, qoldiqlar) tiklanmoqda…' });

  const restoreResult = await rpc('restore_backup_data', { p_payload: data });

  onProgress?.({ stage: 'done', percent: 100, message: 'Barcha ma’lumotlar va rasmlar 100% tiklandi!' });

  return {
    success: true,
    result: restoreResult,
    mediaRestored: mediaEntries.length,
  };
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Bitta partiya / inventarizatsiyani (receiptId) to'liq barcha tovarlari, narxlari va birliklari bilan JSON zahiraga eksport qiladi.
 */
export async function exportReceiptBackup(receiptId) {
  const client = getBrowserClient();
  const { data: receipt, error: rErr } = await client
    .from('stock_receipts')
    .select('*')
    .eq('id', receiptId)
    .single();
  if (rErr) throwDataError(rErr, 'get_stock_receipt');

  const { data: batches, error: bErr } = await client
    .from('stock_batches')
    .select('*')
    .eq('receipt_id', receiptId);
  if (bErr) throwDataError(bErr, 'get_stock_batches');

  const batchIds = (batches || []).map(b => b.id);
  const productIds = [...new Set((batches || []).map(b => b.product_id).filter(Boolean))];
  const variantIds = [...new Set((batches || []).map(b => b.variant_id).filter(Boolean))];
  const locationIds = [...new Set([
    receipt.receiving_location_id,
    ...(batches || []).map(b => b.location_id)
  ].filter(Boolean))];

  let units = [];
  if (batchIds.length > 0) {
    const { data: uData, error: uErr } = await client
      .from('inventory_units')
      .select('*')
      .in('batch_id', batchIds);
    if (uErr) throwDataError(uErr, 'get_inventory_units');
    units = uData || [];
    units.forEach(u => {
      if (u.location_id) locationIds.push(u.location_id);
    });
  }

  let products = [];
  if (productIds.length > 0) {
    const { data: pData } = await client.from('products').select('*').in('id', productIds);
    products = pData || [];
  }

  let productVariants = [];
  if (variantIds.length > 0) {
    const { data: vData } = await client.from('product_variants').select('*').in('id', variantIds);
    productVariants = vData || [];
  }

  let suppliers = [];
  if (receipt.supplier_id) {
    const { data: sData } = await client.from('suppliers').select('*').eq('id', receipt.supplier_id);
    suppliers = sData || [];
  }

  let locations = [];
  const uniqueLocIds = [...new Set(locationIds)];
  if (uniqueLocIds.length > 0) {
    const { data: lData } = await client.from('locations').select('*').in('id', uniqueLocIds);
    locations = lData || [];
  }

  const payload = {
    version: '1.0.0',
    type: 'texnobazar_single_receipt_backup',
    exported_at: new Date().toISOString(),
    receipt_no: receipt.receipt_no,
    branch_id: receipt.branch_id,
    counts: {
      receipts: 1,
      batches: batches?.length || 0,
      units: units.length,
      products: products.length
    },
    data: {
      products,
      product_variants: productVariants,
      suppliers,
      locations,
      stock_receipts: [receipt],
      stock_batches: batches || [],
      inventory_units: units
    }
  };

  const filename = `texnobazar-partiya-${receipt.receipt_no}-${new Date().toISOString().slice(0, 10)}.json`;
  downloadJsonFile(filename, payload);
  return { filename, counts: payload.counts };
}

/**
 * Filialdagi barcha partiyalar va inventarizatsiyalarni JSON faylga eksport qiladi.
 */
export async function exportBatchesBackup(branchId = null) {
  const data = await rpc('export_backup_data', { p_branch_id: branchId || null });
  const payload = {
    version: '1.0.0',
    type: 'texnobazar_batches_backup',
    exported_at: new Date().toISOString(),
    branch_id: branchId,
    counts: {
      receipts: data.stock_receipts?.length || 0,
      batches: data.stock_batches?.length || 0,
      units: data.inventory_units?.length || 0,
      products: data.products?.length || 0,
    },
    data: {
      categories: data.categories || [],
      brands: data.brands || [],
      products: data.products || [],
      product_variants: data.product_variants || [],
      suppliers: data.suppliers || [],
      locations: data.locations || [],
      branches: data.branches || [],
      stock_receipts: data.stock_receipts || [],
      stock_batches: data.stock_batches || [],
      inventory_units: data.inventory_units || []
    }
  };

  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `texnobazar-partiyalar-va-inventarizatsiya-${dateStr}.json`;
  downloadJsonFile(filename, payload);
  return { filename, counts: payload.counts };
}

/**
 * Yuklangan partiyalar/inventarizatsiya zahira faylini (.json yoki .zip) tahlil qiladi.
 */
export async function inspectBatchesBackupFile(file) {
  if (!file) throw new Error('Fayl tanlanmadi.');

  if (file.name.endsWith('.zip')) {
    const inspected = await inspectBackupArchive(file);
    const data = inspected.data || {};
    return {
      isValid: true,
      fileType: 'zip',
      fileName: file.name,
      exported_at: inspected.manifest?.exported_at || null,
      counts: inspected.counts,
      receiptsList: (data.stock_receipts || []).map(r => ({
        id: r.id,
        receipt_no: r.receipt_no,
        received_at: r.received_at,
        payment_status: r.payment_status,
      })),
      rawPayload: data
    };
  }

  const text = await file.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Fayl yaroqli JSON formatida emas.');
  }

  const payload = json.data || json;
  const receipts = payload.stock_receipts || [];
  const batches = payload.stock_batches || [];
  const units = payload.inventory_units || [];

  if (!receipts.length && !batches.length && !units.length) {
    throw new Error('Ushbu faylda partiyalar yoki inventarizatsiya maʼlumotlari topilmadi.');
  }

  return {
    isValid: true,
    fileType: 'json',
    fileName: file.name,
    exported_at: json.exported_at || null,
    counts: {
      receipts: receipts.length,
      batches: batches.length,
      units: units.length,
      products: (payload.products || []).length
    },
    receiptsList: receipts.map(r => ({
      id: r.id,
      receipt_no: r.receipt_no,
      received_at: r.received_at,
      payment_status: r.payment_status,
    })),
    rawPayload: payload
  };
}

/**
 * Zahira faylidan partiyalar va inventarizatsiyalarni bazaga tiklaydi.
 */
export async function restoreBatchesBackupFile(file, { onProgress } = {}) {
  onProgress?.({ percent: 20, message: 'Fayl tekshirilmoqda…' });
  const inspected = await inspectBatchesBackupFile(file);

  if (inspected.fileType === 'zip') {
    return restoreBackupArchive(file, { onProgress });
  }

  onProgress?.({ percent: 50, message: 'Partiyalar, tovarlar va birliklar bazaga tiklanmoqda…' });
  const res = await rpc('restore_backup_data', { p_payload: inspected.rawPayload });

  onProgress?.({ percent: 100, message: 'Tiklash muvaffaqiyatli yakunlandi!' });
  return {
    success: true,
    counts: inspected.counts,
    result: res
  };
}

