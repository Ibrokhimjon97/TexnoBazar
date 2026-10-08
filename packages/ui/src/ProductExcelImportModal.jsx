import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Globe2,
  Image as ImageIcon,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Tag,
  Upload,
  X,
} from 'lucide-react';
import { getBrowserClient, uploadProductMedia } from '@texnobazar/data';
import { formatMoney, useExchangeRate } from './index.jsx';

async function getExcelJS() {
  const mod = await import('exceljs');
  return mod.default || mod;
}

function slugify(text, fallback = 'item') {
  let s = String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['‘’ʻʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) {
    s = `${fallback}-${Date.now().toString(36)}`;
  }
  return s;
}

function extractBrand(name) {
  const brands = [
    'Artel', 'Hofmann', 'Beko', 'Ziffler', 'Hisense', 'Avalon', 'Loretto',
    'Haier', 'Midea', 'Samsung', 'LG', 'Rulls', 'Domassi', 'Sonifer',
    'Bosch', 'Philips', 'Dyson', 'Energy', 'Elite', 'Agnat', 'Bueno',
    'Emerald', 'Mega', 'Kingway', 'Gorenje', 'Macbook', 'Apple', 'Xiaomi',
    'Honor', 'Huawei', 'Realme', 'Sony', 'Panasonic', 'Tefal'
  ];
  const upper = (name || '').toUpperCase();
  for (const b of brands) {
    if (new RegExp(`\\b${b.toUpperCase()}\\b`).test(upper)) {
      return b;
    }
  }
  return null;
}

export function ProductExcelImportModal({
  open,
  onClose,
  onImported,
  branchId = null,
  toast,
}) {
  const latestRate = useExchangeRate();
  const fileInputRef = useRef(null);
  const abortRef = useRef(false);

  // Steps: 'upload' -> 'preview' -> 'importing' -> 'completed'
  const [step, setStep] = useState('upload');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState('');

  // Parsed products
  const [parsedItems, setParsedItems] = useState([]);
  const [detectedCategories, setDetectedCategories] = useState([]);
  const [totalImagesFound, setTotalImagesFound] = useState(0);

  // Settings
  const [isPublished, setIsPublished] = useState(true);
  const [autoCreateCategory, setAutoCreateCategory] = useState(true);
  const [uploadImages, setUploadImages] = useState(true);
  const [exchangeRate, setExchangeRate] = useState(12800);
  const [markupPercent, setMarkupPercent] = useState(25);
  const [initialStockQty, setInitialStockQty] = useState(0);

  // DB references
  const [existingCategories, setExistingCategories] = useState([]);
  const [existingBrands, setExistingBrands] = useState([]);

  // Import execution state
  const [progress, setProgress] = useState(0);
  const [currentAction, setCurrentAction] = useState('');
  const [stats, setStats] = useState({
    total: 0,
    created: 0,
    updated: 0,
    categoriesCreated: 0,
    imagesUploaded: 0,
    skipped: 0,
    errors: [],
  });

  // Sync exchange rate
  useEffect(() => {
    if (latestRate && Number(latestRate) > 0) {
      setExchangeRate(Number(latestRate));
    }
  }, [latestRate]);

  // Load existing categories and brands on open
  useEffect(() => {
    if (!open) {
      // Reset state on close
      setStep('upload');
      setFileName('');
      setFileSize(0);
      setParsedItems([]);
      setDetectedCategories([]);
      setFileError('');
      setProgress(0);
      setStats({
        total: 0,
        created: 0,
        updated: 0,
        categoriesCreated: 0,
        imagesUploaded: 0,
        skipped: 0,
        errors: [],
      });
      return;
    }

    const client = getBrowserClient();
    Promise.all([
      client.from('categories').select('id, name, slug, parent_id').order('name'),
      client.from('brands').select('id, name, slug').order('name'),
    ]).then(([{ data: cats }, { data: brs }]) => {
      setExistingCategories(cats || []);
      setExistingBrands(brs || []);
    }).catch(err => {
      console.error('Error fetching categories/brands:', err);
    });
  }, [open]);

  // Download Sample Template
  const handleDownloadSample = async () => {
    try {
      const ExcelJS = await getExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Texnobazar';
      wb.created = new Date();
      const ws = wb.addWorksheet('Tovarlar');

      ws.columns = [
        { header: '№', key: 'no', width: 6 },
        { header: 'Kod', key: 'code', width: 14 },
        { header: 'Mahsulot nomi', key: 'name', width: 44 },
        { header: 'Kategoriya', key: 'category', width: 28 },
        { header: 'Tannarxi', key: 'cost_price', width: 14 },
        { header: 'sotish narxi', key: 'retail_price', width: 16 },
        { header: 'ulgurji narxi', key: 'wholesale_price', width: 16 },
        { header: 'minimal sotuv narxi', key: 'min_price', width: 18 },
        { header: 'Ushbu tovar boshqa saytdagi url (rasmini olish uchun)', key: 'url', width: 34 },
        { header: 'Mahsulot tavsifi', key: 'description', width: 55 },
        { header: 'Mahsulot rasmi', key: 'image', width: 24 },
      ];

      // Style header
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF97316' }, // Texnobazar orange
      };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      headerRow.height = 32;

      // Helper to generate crisp sample canvas images
      const makeSampleImg = (title, sub, color1, color2) => {
        try {
          if (typeof document === 'undefined') return null;
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 160;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          const grad = ctx.createLinearGradient(0, 0, 160, 160);
          grad.addColorStop(0, color1);
          grad.addColorStop(1, color2);
          ctx.fillStyle = grad;
          if (ctx.roundRect) ctx.roundRect(8, 8, 144, 144, 20);
          else ctx.rect(8, 8, 144, 144);
          ctx.fill();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
          ctx.lineWidth = 3;
          if (ctx.roundRect) ctx.roundRect(14, 14, 132, 132, 16);
          else ctx.rect(14, 14, 132, 132);
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(title, 80, 68);

          ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.fillText(sub, 80, 94);

          return wb.addImage({
            base64: canvas.toDataURL('image/png'),
            extension: 'png',
          });
        } catch (canvasErr) {
          console.warn('Canvas sample img warning:', canvasErr);
          return null;
        }
      };

      const img1 = makeSampleImg('BELANCHAK', 'MODEL 450', '#ea580c', '#c2410c');
      const img2 = makeSampleImg('HOFMANN', '8 KG INVERTOR', '#2563eb', '#1d4ed8');
      const img3 = makeSampleImg('ARTEL', '8 KG PURE', '#059669', '#047857');

      const sampleRows = [
        {
          no: 1,
          code: '10892',
          name: 'TEMIR BELANCHAK MODEL 450',
          category: 'BOLALAR UCHUN MAXSULOTLAR',
          cost_price: 36.73,
          retail_price: 45.00,
          wholesale_price: 40.00,
          min_price: 38.00,
          url: 'https://texnobazar.uz/samples/belanchak-450.jpg',
          description: "Temir Belanchak Model 450 bolalar uchun mo'ljallangan mustahkam va xavfsiz belanchak.",
          image: '',
          imgId: img1,
        },
        {
          no: 2,
          code: '10891',
          name: 'HOFMANN WM814SDG/HF 8 KG AVTOMAT KIR MOSHINA',
          category: 'Avtomat Kir Yuvish moshinalar',
          cost_price: 495.00,
          retail_price: '',
          wholesale_price: '',
          min_price: '',
          url: 'https://texnobazar.uz/samples/hofmann-8kg.jpg',
          description: "Hofmann 8 kg sig'imli zamonaviy invertor motorli avtomat kir yuvish mashinasi.",
          image: '',
          imgId: img2,
        },
        {
          no: 3,
          code: '10890',
          name: 'ARTEL 8 KG ART-WM8002 B PURE AVTOMAT KIR MOSHINA',
          category: 'Avtomat Kir Yuvish moshinalar',
          cost_price: 391.00,
          retail_price: 460.00,
          wholesale_price: 430.00,
          min_price: 400.00,
          url: 'https://texnobazar.uz/samples/artel-wm8002.jpg',
          description: "Artel Pure seriyasidagi 8 kg avtomat kir yuvish mashinasi.",
          image: '',
          imgId: img3,
        },
      ];

      sampleRows.forEach((item, idx) => {
        const row = ws.addRow(item);
        row.height = 65;
        row.alignment = { vertical: 'middle' };

        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          };
        });

        // Add sample image into Mahsulot rasmi cell (Col 11 = 0-indexed 10, Row 2, 3, 4 = 0-indexed 1, 2, 3)
        if (item.imgId != null) {
          ws.addImage(item.imgId, {
            tl: { col: 10, row: idx + 1 },
            ext: { width: 55, height: 55 },
            editAs: 'oneCell',
          });
        }
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'texnobazar_tovarlar_namuna.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e) {
      alert('Namunani yuklab olishda xatolik: ' + e.message);
    }
  };

  // Helper to extract row/col from any ExcelJS image anchor
  const getAnchorRow = (img) => {
    if (!img || !img.range) return null;
    const tl = img.range.tl || img.range;
    if (tl) {
      if (tl.nativeRow !== undefined) return Number(tl.nativeRow) + 1;
      if (tl.row !== undefined) return Math.floor(Number(tl.row)) + 1;
    }
    if (typeof img.range === 'string') {
      const m = img.range.match(/\d+/);
      if (m) return parseInt(m[0], 10);
    }
    return null;
  };

  const getAnchorCol = (img) => {
    if (!img || !img.range) return null;
    const tl = img.range.tl || img.range;
    if (tl) {
      if (tl.nativeCol !== undefined) return Number(tl.nativeCol) + 1;
      if (tl.col !== undefined) return Math.floor(Number(tl.col)) + 1;
    }
    return null;
  };

  // Process Excel file
  const processFile = async (file) => {
    if (!file) return;
    setLoadingFile(true);
    setFileError('');
    setFileName(file.name);
    setFileSize(file.size);

    try {
      const ExcelJS = await getExcelJS();
      const JSZip = (await import('jszip')).default || (await import('jszip'));
      const rawBuffer = await file.arrayBuffer();

      // 1. Direct image extraction via JSZip: 100% reliable, fast, and immune to ExcelJS drawing bugs
      const zip = await JSZip.loadAsync(rawBuffer);
      const directRowImages = new Map();

      try {
        // Parse all relationships (.rels) in order-independent fashion
        const rIdMap = {};
        for (const name of Object.keys(zip.files)) {
          if (/xl\/drawings\/_rels\/.*\.rels$/i.test(name)) {
            const relsXml = await zip.files[name].async('string');
            const relTags = relsXml.match(/<Relationship\b[^>]*\/?>/gi) || [];
            for (const tag of relTags) {
              const idM = tag.match(/\bId="([^"]+)"/i);
              const targetM = tag.match(/\bTarget="([^"]+)"/i);
              if (idM && targetM) {
                let cleanTarget = targetM[1].replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
                if (!cleanTarget.startsWith('xl/')) {
                  cleanTarget = 'xl/' + cleanTarget;
                }
                rIdMap[idM[1]] = cleanTarget;
              }
            }
          }
        }

        // Parse drawings XML: extract anchor blocks (oneCellAnchor or twoCellAnchor)
        for (const name of Object.keys(zip.files)) {
          if (/xl\/drawings\/.*\.xml$/i.test(name) && !name.includes('_rels')) {
            const xml = await zip.files[name].async('string');
            const anchorRegex = /<(?:[a-zA-Z0-9]+:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?(?:oneCellAnchor|twoCellAnchor)>/gi;
            const blocks = xml.match(anchorRegex) || [];

            for (const block of blocks) {
              // Prefer row inside <from> element to get top-left cell anchor
              const fromMatch = block.match(/<(?:[a-zA-Z0-9]+:)?from\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?from>/i);
              const targetXml = fromMatch ? fromMatch[0] : block;
              const rowMatch = targetXml.match(/<(?:[a-zA-Z0-9]+:)?row>(\d+)<\/(?:[a-zA-Z0-9]+:)?row>/i);
              const blipMatch = block.match(/<[a-zA-Z0-9:]*blip\b[^>]+(?:r:embed|embed)="([^"]+)"/i);

              if (rowMatch && blipMatch) {
                const rowIdx = parseInt(rowMatch[1], 10) + 1; // 1-based row index
                const rId = blipMatch[1];
                const mediaPath = rIdMap[rId];
                if (mediaPath) {
                  // Find file entry in zip with case-insensitive fallback
                  let mediaEntry = zip.files[mediaPath];
                  if (!mediaEntry) {
                    const lower = mediaPath.toLowerCase();
                    for (const k of Object.keys(zip.files)) {
                      if (k.toLowerCase() === lower) {
                        mediaEntry = zip.files[k];
                        break;
                      }
                    }
                  }

                  if (mediaEntry) {
                    const ext = (mediaPath.split('.').pop() || 'png').toLowerCase();
                    const imgBuf = await mediaEntry.async('arraybuffer');
                    directRowImages.set(rowIdx, { buffer: imgBuf, ext });
                  }
                }
              }
            }
          }
        }
      } catch (zipExtractErr) {
        console.warn('Direct zip image extraction notice:', zipExtractErr);
      }

      // 2. Prepare clean zip for ExcelJS: strip drawings so ExcelJS NEVER crashes on 'anchors'
      let cleanBuffer = rawBuffer;
      try {
        const cleanZip = new JSZip();
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          const cleanName = name.replace(/\\/g, '/');

          // Exclude drawings from the buffer passed to ExcelJS
          if (/^xl\/drawings\//i.test(cleanName)) continue;

          if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(cleanName)) {
            let sheetXml = await entry.async('string');
            sheetXml = sheetXml.replace(/<drawing\s+[^>]*\/>/gi, '');
            cleanZip.file(cleanName, sheetXml);
          } else if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/i.test(cleanName)) {
            let relsXml = await entry.async('string');
            relsXml = relsXml.replace(/<Relationship[^>]+Type="[^"]*drawing"[^>]*\/>/gi, '');
            cleanZip.file(cleanName, relsXml);
          } else {
            const data = await entry.async('arraybuffer');
            cleanZip.file(cleanName, data);
          }
        }
        cleanBuffer = await cleanZip.generateAsync({ type: 'arraybuffer' });
      } catch (cleanErr) {
        console.warn('Zip cleaning notice:', cleanErr);
      }

      // 3. Load with ExcelJS without any drawing errors
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(cleanBuffer);

      const ws = workbook.worksheets[0];
      if (!ws || ws.rowCount < 2) {
        throw new Error('Excel faylida yetarli qatorlar mavjud emas.');
      }

      // Detect header row and column mapping
      let headerRowIndex = 1;
      const colMap = {};

      for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
        const row = ws.getRow(r);
        let foundHeaders = 0;
        row.eachCell((cell, colNumber) => {
          const val = String(cell.value || '').trim().toLowerCase();
          if (/mahsulot\s*nomi|tovar\s*nomi|^nomi$|^mahsulot$|^tovar$/i.test(val)) {
            colMap.name = colNumber;
            foundHeaders++;
          } else if (/^kod$|^artikul$|^sku$|^code$/i.test(val)) {
            colMap.code = colNumber;
            foundHeaders++;
          } else if (/kategoriya|category|bo['‘`]?lim/i.test(val)) {
            colMap.category = colNumber;
            foundHeaders++;
          } else if (/tannarx|tan\s*narx|kirim\s*narx|cost/i.test(val)) {
            colMap.costPrice = colNumber;
            foundHeaders++;
          } else if (/sotish\s*narx|sotuv\s*narx|chakana|retail|^narx$/i.test(val)) {
            colMap.retailPrice = colNumber;
          } else if (/ulgurji|optom|wholesale/i.test(val)) {
            colMap.wholesalePrice = colNumber;
          } else if (/minimal|min\s*narx/i.test(val)) {
            colMap.minPrice = colNumber;
          } else if (/boshqa\s*sayt|saytdagi\s*url|link|^url$/i.test(val)) {
            colMap.url = colNumber;
          } else if (/tavsif|description|izoh/i.test(val)) {
            colMap.description = colNumber;
          } else if (/rasm|image|foto|picture/i.test(val)) {
            colMap.image = colNumber;
          }
        });

        if (foundHeaders >= 2) {
          headerRowIndex = r;
          break;
        }
      }

      // Default fallback column positions matching the 11-column standard
      if (!colMap.name) colMap.name = 3;
      if (!colMap.code) colMap.code = 2;
      if (!colMap.category) colMap.category = 4;
      if (!colMap.costPrice) colMap.costPrice = 5;
      if (!colMap.retailPrice) colMap.retailPrice = 6;
      if (!colMap.wholesalePrice) colMap.wholesalePrice = 7;
      if (!colMap.minPrice) colMap.minPrice = 8;
      if (!colMap.url) colMap.url = 9;
      if (!colMap.description) colMap.description = 10;
      if (!colMap.image) colMap.image = 11;

      const items = [];
      const categorySet = new Set();

      for (let r = headerRowIndex + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const nameVal = String(row.getCell(colMap.name).value || '').trim();
        if (!nameVal) continue; // Skip empty rows

        const codeVal = String(row.getCell(colMap.code).value || '').trim();
        const catVal = String(row.getCell(colMap.category).value || '').trim() || 'Umumiy';
        categorySet.add(catVal);

        const costRaw = row.getCell(colMap.costPrice).value;
        const costNum = Number(typeof costRaw === 'object' ? costRaw?.result || 0 : costRaw) || 0;

        const retailRaw = colMap.retailPrice ? row.getCell(colMap.retailPrice).value : null;
        const retailNum = retailRaw != null && retailRaw !== ''
          ? Number(typeof retailRaw === 'object' ? retailRaw?.result || 0 : retailRaw) || null
          : null;

        const wholesaleRaw = colMap.wholesalePrice ? row.getCell(colMap.wholesalePrice).value : null;
        const wholesaleNum = wholesaleRaw != null && wholesaleRaw !== ''
          ? Number(typeof wholesaleRaw === 'object' ? wholesaleRaw?.result || 0 : wholesaleRaw) || null
          : null;

        const minRaw = colMap.minPrice ? row.getCell(colMap.minPrice).value : null;
        const minNum = minRaw != null && minRaw !== ''
          ? Number(typeof minRaw === 'object' ? minRaw?.result || 0 : minRaw) || null
          : null;

        const descVal = colMap.description ? String(row.getCell(colMap.description).value || '').trim() : '';

        // Extract embedded image or image URL for this product
        let imageFile = null;
        let imagePreviewUrl = null;
        let imageUrl = null;

        // 1. Direct extracted image from zip
        if (directRowImages.has(r)) {
          const imgObj = directRowImages.get(r);
          const ext = imgObj.ext === 'jpg' ? 'jpeg' : (imgObj.ext || 'png');
          imageFile = new File(
            [imgObj.buffer],
            `product-${codeVal || r}.${imgObj.ext || 'png'}`,
            { type: `image/${ext}` }
          );
          imagePreviewUrl = URL.createObjectURL(imageFile);
        }

        // 2. Image URL from cell text (if no embedded image)
        if (!imageFile) {
          const readUrlCell = (colIdx) => {
            if (!colIdx) return null;
            const c = row.getCell(colIdx);
            if (!c || c.value == null) return null;
            let val = c.value;
            if (typeof val === 'object') {
              val = val.hyperlink || val.text || val.result || '';
            }
            val = String(val || '').trim();
            if (/^https?:\/\//i.test(val) || /^data:image\//i.test(val)) {
              if (colIdx === colMap.image || /^data:image\//i.test(val) || /\.(jpe?g|png|webp|gif|svg|avif)(\?.*)?$/i.test(val) || /\/(images?|media|cdn|photos?)\//i.test(val)) {
                return val;
              }
            }
            return null;
          };

          const detectedUrl = readUrlCell(colMap.image) || readUrlCell(colMap.url);
          if (detectedUrl) {
            imageUrl = detectedUrl;
            imagePreviewUrl = detectedUrl;
          }
        }

        items.push({
          row: r,
          code: codeVal,
          name: nameVal,
          categoryName: catVal,
          costPrice: costNum,
          retailPrice: retailNum,
          wholesalePrice: wholesaleNum,
          minPrice: minNum,
          description: descVal,
          imageFile,
          imageUrl,
          imagePreviewUrl,
        });
      }

      if (items.length === 0) {
        throw new Error("Excel faylidan bitta ham tovar aniqlanmadi. Ustun nomlari va qatorlarni tekshiring.");
      }

      const totalFoundImages = items.filter(it => it.imageFile || it.imageUrl).length;
      setTotalImagesFound(totalFoundImages);
      setParsedItems(items);
      setDetectedCategories([...categorySet]);
      setStep('preview');
    } catch (err) {
      setFileError(err.message || 'Excel faylini o‘qishda xatolik yuz berdi.');
    } finally {
      setLoadingFile(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  // Execute Import
  const startImport = async () => {
    if (parsedItems.length === 0) return;
    setStep('importing');
    setProgress(0);
    abortRef.current = false;

    const client = getBrowserClient();
    const rate = Number(exchangeRate) || 12800;
    const margin = 1 + (Number(markupPercent) || 0) / 100;

    let createdCount = 0;
    let categoriesCreatedCount = 0;
    let imagesUploadedCount = 0;
    let skippedCount = 0;
    const errors = [];

    try {
      // 1. Refresh & ensure categories map
      setCurrentAction('Kategoriyalar tekshirilmoqda…');
      const { data: freshCats } = await client.from('categories').select('id, name, slug');
      const categoryMap = new Map();
      const categorySlugSet = new Set();
      (freshCats || []).forEach(c => {
        categoryMap.set(c.name.trim().toLowerCase(), c.id);
        categorySlugSet.add(c.slug);
      });

      // Auto-create missing categories if enabled
      if (autoCreateCategory) {
        for (const catName of detectedCategories) {
          const norm = catName.trim().toLowerCase();
          if (!categoryMap.has(norm)) {
            setCurrentAction(`Yangi kategoriya yaratilmoqda: “${catName}”…`);
            let baseSlug = slugify(catName, 'cat');
            let candidateSlug = baseSlug;
            let counter = 1;
            while (categorySlugSet.has(candidateSlug)) {
              candidateSlug = `${baseSlug}-${counter++}`;
            }

            const { data: createdCat, error: catErr } = await client.from('categories').insert({
              name: catName.trim(),
              slug: candidateSlug,
              is_active: true,
              sort_order: 10,
            }).select('id, name, slug').single();

            if (!catErr && createdCat) {
              categoryMap.set(norm, createdCat.id);
              categorySlugSet.add(createdCat.slug);
              categoriesCreatedCount++;
            } else {
              console.warn('Category creation notice:', catErr);
            }
          }
        }
      }

      // 2. Fetch existing products SKU and slugs to prevent duplicates
      setCurrentAction('Mavjud tovarlar tekshirilmoqda…');
      const { data: existingProducts } = await client.from('products').select('id, sku, slug');
      const existingSkuSet = new Set((existingProducts || []).map(p => p.sku.toUpperCase()));
      const existingSlugSet = new Set((existingProducts || []).map(p => p.slug));

      // Brand mapping
      const brandMap = new Map();
      (existingBrands || []).forEach(b => brandMap.set(b.name.toUpperCase(), b.id));

      // 3. Process products in chunks of 15
      const total = parsedItems.length;
      const chunkSize = 15;

      for (let i = 0; i < total; i += chunkSize) {
        if (abortRef.current) {
          errors.push('Foydalanuvchi tomonidan to‘xtatildi.');
          break;
        }

        const chunk = parsedItems.slice(i, i + chunkSize);
        const productsToInsert = [];
        const itemsWithImages = [];

        for (const item of chunk) {
          // Determine SKU
          let sku = item.code ? `TB-${item.code.toUpperCase()}` : `TB-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
          if (existingSkuSet.has(sku)) {
            // Unique SKU variant
            sku = `${sku}-${Math.floor(10 + Math.random() * 90)}`;
          }
          existingSkuSet.add(sku);

          // Determine slug
          let baseSlug = slugify(item.name, 'prod');
          if (item.code) baseSlug = `${baseSlug}-${item.code.toLowerCase()}`;
          let uniqueSlug = baseSlug;
          let counter = 1;
          while (existingSlugSet.has(uniqueSlug)) {
            uniqueSlug = `${baseSlug}-${counter++}`;
          }
          existingSlugSet.add(uniqueSlug);

          // Category ID
          const catId = categoryMap.get(item.categoryName.trim().toLowerCase()) || null;

          // Brand ID
          const detectedBrand = extractBrand(item.name);
          const brandId = detectedBrand ? (brandMap.get(detectedBrand.toUpperCase()) || null) : null;

          // Price calculation (convert USD to UZS if small, apply markup if retail is missing)
          let costUzs = Number(item.costPrice) || 0;
          if (costUzs > 0 && costUzs < 5000) {
            costUzs = Math.round(costUzs * rate);
          }

          let retailUzs = item.retailPrice != null ? Number(item.retailPrice) : null;
          if (retailUzs != null && retailUzs > 0 && retailUzs < 5000) {
            retailUzs = Math.round(retailUzs * rate);
          }
          if (retailUzs == null || retailUzs <= 0) {
            retailUzs = Math.round(costUzs * margin);
          }
          if (retailUzs < costUzs) {
            retailUzs = costUzs;
          }

          let wholesaleUzs = item.wholesalePrice != null ? Number(item.wholesalePrice) : null;
          if (wholesaleUzs != null && wholesaleUzs > 0 && wholesaleUzs < 5000) {
            wholesaleUzs = Math.round(wholesaleUzs * rate);
          }

          let minPriceUzs = item.minPrice != null ? Number(item.minPrice) : null;
          if (minPriceUzs != null && minPriceUzs > 0 && minPriceUzs < 5000) {
            minPriceUzs = Math.round(minPriceUzs * rate);
          }
          if (minPriceUzs == null || minPriceUzs <= 0) {
            minPriceUzs = costUzs;
          }

          const desc = item.description || `${item.name} — eng so‘nggi model, kafolatlangan yuqori sifat va rasmiy servis.`;

          productsToInsert.push({
            name: item.name,
            sku,
            barcode: item.code && /^\d+$/.test(item.code) ? `2000000${item.code}`.slice(0, 13) : null,
            slug: uniqueSlug,
            category_id: catId,
            brand_id: brandId,
            cost_price: costUzs,
            retail_price: retailUzs,
            wholesale_price: wholesaleUzs,
            minimum_sale_price: minPriceUzs,
            description: desc,
            status: isPublished ? 'active' : 'draft',
            is_published: Boolean(isPublished),
            track_individual_units: true,
            tax_rate: 0,
            seo_title: `${item.name} — narxlar va xususiyatlar`,
            seo_description: `${item.name} sotib olish. Tez yetkazib berish va rasmiy kafolat.`,
          });

          if (item.imageFile || item.imageUrl) {
            itemsWithImages.push({
              sku,
              imageFile: item.imageFile,
              imageUrl: item.imageUrl,
              name: item.name,
            });
          }
        }

        setCurrentAction(`Tovarlar saqlanmoqda (${i + 1}–${Math.min(i + chunkSize, total)} / ${total})…`);

        const { data: inserted, error: insErr } = await client
          .from('products')
          .insert(productsToInsert)
          .select('id, sku, name');

        if (insErr) {
          console.error('Batch insert error:', insErr);
          errors.push(`Qatorlar ${i + 1}–${i + chunk.length}: ${insErr.message}`);
          skippedCount += chunk.length;
        } else {
          createdCount += (inserted || []).length;

          // 4. Upload images to Cloudflare R2 for inserted products if enabled
          if (uploadImages && itemsWithImages.length > 0) {
            const insertedMap = new Map((inserted || []).map(p => [p.sku, p.id]));
            for (const imgItem of itemsWithImages) {
              const productId = insertedMap.get(imgItem.sku);
              if (productId) {
                try {
                  setCurrentAction(`Rasm Cloudflare R2 ga yuklanmoqda: ${imgItem.name.slice(0, 28)}…`);
                  let fileToUpload = imgItem.imageFile;

                  if (!fileToUpload && imgItem.imageUrl) {
                    try {
                      const res = await fetch(imgItem.imageUrl);
                      if (res.ok) {
                        const blob = await res.blob();
                        const ext = blob.type?.includes('png') ? 'png' : 'jpeg';
                        fileToUpload = new File([blob], `product-${imgItem.sku}.${ext}`, {
                          type: blob.type || 'image/jpeg',
                        });
                      }
                    } catch (fetchErr) {
                      console.warn(`URL fetch notice for ${imgItem.imageUrl}:`, fetchErr);
                    }
                  }

                  if (fileToUpload) {
                    await uploadProductMedia(productId, fileToUpload, imgItem.name);
                    imagesUploadedCount++;
                  } else if (imgItem.imageUrl) {
                    await client.from('products').update({ seo_image_url: imgItem.imageUrl }).eq('id', productId);
                  }
                } catch (mediaErr) {
                  console.warn(`Media upload notice for ${imgItem.sku}:`, mediaErr);
                }
              }
            }
          }
        }

        const currentProgress = Math.min(100, Math.round(((i + chunk.length) / total) * 100));
        setProgress(currentProgress);
        setStats({
          total,
          created: createdCount,
          updated: 0,
          categoriesCreated: categoriesCreatedCount,
          imagesUploaded: imagesUploadedCount,
          skipped: skippedCount,
          errors,
        });
      }

      setStep('completed');
      if (toast) {
        toast(`${createdCount} ta tovar muvaffaqiyatli import qilindi!`);
      }
      if (onImported) {
        onImported();
      }
    } catch (fatalErr) {
      errors.push(`Jiddiy xatolik: ${fatalErr.message}`);
      setStats(prev => ({ ...prev, errors }));
      setStep('completed');
    }
  };

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && step !== 'importing' && onClose()}>
      <div className="modal modal-wide excel-import-modal">
        {/* Header */}
        <div className="modal-header between">
          <div className="row" style={{ gap: 10 }}>
            <div className="excel-import-icon">
              <FileSpreadsheet size={22} color="var(--orange)" />
            </div>
            <div>
              <h2 className="section-title" style={{ fontSize: 19 }}>
                Tovarlarni Exceldan import qilish
              </h2>
              <span className="muted small">
                .xlsx yoki .xls fayldagi tovarlar, narxlar va rasmlarni bazaga avtomatik kiritish
              </span>
            </div>
          </div>
          {step !== 'importing' && (
            <button type="button" className="icon-btn modal-close-btn" onClick={onClose} aria-label="Yopish">
              <X size={19} />
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="modal-body-scroll" style={{ padding: '4px 0 12px' }}>
          {/* STEP 1: Upload */}
          {step === 'upload' && (
            <div className="excel-upload-step">
              <div
                className="excel-dropzone"
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx, .xls"
                  style={{ display: 'none' }}
                  onChange={e => e.target.files?.[0] && processFile(e.target.files[0])}
                />
                {loadingFile ? (
                  <div className="excel-loading">
                    <Loader2 className="spin" size={38} color="var(--orange)" />
                    <b>Excel fayli o‘qilmoqda…</b>
                    <small>Tovarlar, kategoriyalar va ichki rasmlar tahlil qilinmoqda</small>
                  </div>
                ) : (
                  <>
                    <div className="dropzone-icon">
                      <Upload size={32} />
                    </div>
                    <b>Excel faylini bu yerga tashlang yoki tanlang</b>
                    <span>.xlsx yoki .xls formatidagi fayllar qabul qilinadi</span>
                    <button type="button" className="btn btn-outline" style={{ marginTop: 12 }}>
                      Faylni tanlash
                    </button>
                  </>
                )}
              </div>

              {fileError && (
                <div className="excel-error-banner">
                  <AlertTriangle size={18} />
                  <span>{fileError}</span>
                </div>
              )}

              {/* Sample template download strip */}
              <div className="excel-sample-card">
                <div className="row" style={{ gap: 10 }}>
                  <FileSpreadsheet size={22} color="#16a34a" />
                  <div>
                    <b>Qanday formatda tayyorlash kerak?</b>
                    <p className="muted small" style={{ margin: '2px 0 0 0', lineHeight: 1.4 }}>
                      Standart 11 ta ustun: <code>№</code>, <code>Kod</code>, <code>Mahsulot nomi</code>, <code>Kategoriya</code>, <code>Tannarxi</code>, <code>sotish narxi</code>, <code>ulgurji narxi</code>, <code>minimal sotuv narxi</code>, <code>Ushbu tovar boshqa saytdagi url</code>, <code>Mahsulot tavsifi</code>, <b><code>Mahsulot rasmi</code></b>.
                    </p>
                    <p className="muted small" style={{ margin: '3px 0 0 0', color: 'var(--orange)', fontWeight: 500 }}>
                      💡 «Mahsulot rasmi» katagiga Excel orqali rasm joylashtiriladi. Import jarayonida ushbu rasmlar avtomatik Cloudflare R2 bulutiga yuklanadi.
                    </p>
                  </div>
                </div>
                <button type="button" className="btn btn-outline btn-sm" onClick={handleDownloadSample}>
                  <Download size={14} />
                  Namuna shablonni yuklab olish (.xlsx)
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Preview & Settings */}
          {step === 'preview' && (
            <div className="excel-preview-step">
              {/* Summary KPIs */}
              <div className="excel-kpi-grid">
                <div className="excel-kpi-card">
                  <Package size={20} color="var(--orange)" />
                  <div>
                    <b>{parsedItems.length} ta</b>
                    <small>Tovarlar aniqlandi</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <Tag size={20} color="#2563eb" />
                  <div>
                    <b>{detectedCategories.length} ta</b>
                    <small>Kategoriya turlari</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <ImageIcon size={20} color="#16a34a" />
                  <div>
                    <b>{totalImagesFound} ta</b>
                    <small>Ichki rasm topildi</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <Globe2 size={20} color={isPublished ? '#16a34a' : '#6b7280'} />
                  <div>
                    <b>{isPublished ? 'Saytda faol' : 'Qoralama'}</b>
                    <small>Nashr holati</small>
                  </div>
                </div>
              </div>

              {/* Import Settings Card */}
              <div className="excel-settings-card card pad">
                <h4 style={{ margin: '0 0 12px 0', fontSize: 14 }}>Import sozlamalari</h4>
                <div className="excel-settings-grid">
                  {/* CRITICAL CHECKBOX: Saytda ko'rinsinmi */}
                  <label className="excel-checkbox-label primary-toggle">
                    <input
                      type="checkbox"
                      checked={isPublished}
                      onChange={e => setIsPublished(e.target.checked)}
                    />
                    <div>
                      <b>Tovarlar saytda ko‘rinsin (Storefront nashri)</b>
                      <small>
                        Belgilansa, tovarlar darhol online do‘konda ko‘rinadi va holati «Faol» (active) bo‘ladi. Belgilanmasa, «Qoralama» (draft) holatida saqlanadi.
                      </small>
                    </div>
                  </label>

                  {/* CRITICAL CHECKBOX: Kategoriyalarni avtomatik yaratish */}
                  <label className="excel-checkbox-label">
                    <input
                      type="checkbox"
                      checked={autoCreateCategory}
                      onChange={e => setAutoCreateCategory(e.target.checked)}
                    />
                    <div>
                      <b>Mavjud bo‘lmagan kategoriyalarni avtomatik yaratish</b>
                      <small>
                        Agar Exceldagi kategoriya saytda bo‘lmasa, tizim avtomatik ravishda yangi kategoriya ochadi va unga biriktiradi.
                      </small>
                    </div>
                  </label>

                  {/* Image upload toggle */}
                  {totalImagesFound > 0 && (
                    <label className="excel-checkbox-label">
                      <input
                        type="checkbox"
                        checked={uploadImages}
                        onChange={e => setUploadImages(e.target.checked)}
                      />
                      <div>
                        <b>Exceldagi {totalImagesFound} ta rasmni Cloudflare R2 ga yuklash</b>
                        <small>Rasmlar avtomatik siqilib Cloudflare R2 bulut xotirasiga joylanadi.</small>
                      </div>
                    </label>
                  )}
                </div>

                {/* Additional Price Settings Row */}
                <div className="excel-prices-row" style={{ marginTop: 14 }}>
                  <label className="field">
                    <span className="label">Valyuta kursi (1 USD = ? UZS)</span>
                    <input
                      className="input"
                      type="number"
                      value={exchangeRate}
                      onChange={e => setExchangeRate(Number(e.target.value))}
                    />
                    <small className="muted" style={{ fontSize: 11 }}>Kichik narxlar ($) bo‘lsa, shu kurs bo‘yicha hisoblanadi</small>
                  </label>

                  <label className="field">
                    <span className="label">Sotish narxi ustamasi (%)</span>
                    <input
                      className="input"
                      type="number"
                      value={markupPercent}
                      onChange={e => setMarkupPercent(Number(e.target.value))}
                    />
                    <small className="muted" style={{ fontSize: 11 }}>Excelda sotish narxi bo‘sh bo‘lsa qo‘llaniladi</small>
                  </label>
                </div>
              </div>

              {/* Sample Preview Table */}
              <div style={{ marginTop: 14 }}>
                <div className="between" style={{ marginBottom: 6 }}>
                  <b>Tovarlar ko‘rinishi (birinchi 8 ta namunasi):</b>
                  <small className="muted">{parsedItems.length} tadan 8 tasi ko‘rsatilmoqda</small>
                </div>
                <div className="table-wrap excel-preview-table-wrap">
                  <table className="table" style={{ fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 44 }}>Rasm</th>
                        <th>Kod</th>
                        <th>Mahsulot nomi</th>
                        <th>Kategoriya</th>
                        <th>Tannarxi</th>
                        <th>Sotish narxi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedItems.slice(0, 8).map((item, idx) => {
                        const isCatExist = existingCategories.some(
                          c => c.name.trim().toLowerCase() === item.categoryName.trim().toLowerCase()
                        );
                        let costUzs = item.costPrice > 0 && item.costPrice < 5000 ? Math.round(item.costPrice * exchangeRate) : item.costPrice;
                        let retailUzs = item.retailPrice != null
                          ? (item.retailPrice > 0 && item.retailPrice < 5000 ? Math.round(item.retailPrice * exchangeRate) : item.retailPrice)
                          : Math.round(costUzs * (1 + markupPercent / 100));

                        return (
                          <tr key={idx}>
                            <td>
                              <div style={{ width: 36, height: 36, position: 'relative', borderRadius: 6, overflow: 'hidden', background: '#f8fafc', border: '1px solid var(--border)' }}>
                                {item.imagePreviewUrl && (
                                  <img
                                    src={item.imagePreviewUrl}
                                    alt=""
                                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', position: 'relative', zIndex: 1, background: '#fff' }}
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none';
                                    }}
                                  />
                                )}
                                <div
                                  style={{
                                    position: 'absolute',
                                    inset: 0,
                                    display: 'grid',
                                    placeItems: 'center',
                                    zIndex: 0,
                                    background: '#f1f5f9',
                                  }}
                                >
                                  <Package size={16} color="#94a3b8" />
                                </div>
                              </div>
                            </td>
                            <td><code>{item.code || '—'}</code></td>
                            <td>
                              <b style={{ display: 'block', maxWidth: 280, whiteSpace: 'normal' }}>
                                {item.name}
                              </b>
                            </td>
                            <td>
                              <span className={`badge ${isCatExist ? 'blue' : 'green'}`} style={{ fontSize: 11 }}>
                                {item.categoryName} {!isCatExist && ' (yangi)'}
                              </span>
                            </td>
                            <td>
                              <span>{formatMoney(costUzs)}</span>
                              {item.costPrice < 5000 && <small className="muted" style={{ display: 'block' }}>${item.costPrice}</small>}
                            </td>
                            <td>
                              <b style={{ color: 'var(--orange-dark)' }}>{formatMoney(retailUzs)}</b>
                              {item.retailPrice == null && <small className="muted" style={{ display: 'block' }}>+{markupPercent}%</small>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bottom Action Bar */}
              <div className="between" style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <button type="button" className="btn btn-outline" onClick={() => setStep('upload')}>
                  Boshqa fayl tanlash
                </button>
                <button type="button" className="btn btn-primary" onClick={startImport} style={{ minWidth: 220 }}>
                  <Upload size={16} />
                  Importni boshlash ({parsedItems.length} ta tovar)
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: Progress & Realtime Status */}
          {step === 'importing' && (
            <div className="excel-importing-step">
              <div className="excel-progress-box">
                <Loader2 className="spin" size={44} color="var(--orange)" />
                <h3 style={{ margin: '14px 0 6px 0', fontSize: 18 }}>Tovarlar import qilinmoqda…</h3>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>{currentAction}</p>

                {/* Progress bar */}
                <div className="excel-progress-bar-wrap">
                  <div className="excel-progress-bar-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="between" style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)' }}>
                  <span>{stats.created} / {stats.total} ta tovar saqlandi</span>
                  <b>{progress}%</b>
                </div>

                {/* Live Counters */}
                <div className="excel-live-counters">
                  <div><b>{stats.created}</b><span>Yaratildi</span></div>
                  <div><b>{stats.categoriesCreated}</b><span>Yangi kategoriya</span></div>
                  <div><b>{stats.imagesUploaded}</b><span>Yuklangan rasm</span></div>
                  {stats.skipped > 0 && <div className="text-red"><b>{stats.skipped}</b><span>Xato/O‘tkazildi</span></div>}
                </div>

                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: 18 }}
                  onClick={() => { abortRef.current = true; }}
                >
                  To‘xtatish
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Completed Summary */}
          {step === 'completed' && (
            <div className="excel-completed-step">
              <div className="completed-header" style={{ textAlign: 'center', padding: '16px 0 24px' }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#dcfce7', color: '#16a34a', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}>
                  <CheckCircle2 size={34} />
                </div>
                <h3 style={{ fontSize: 22, margin: '0 0 6px 0' }}>Import yakunlandi!</h3>
                <p className="muted" style={{ margin: 0 }}>
                  Barcha tovarlar ma’lumotlar bazasiga muvaffaqiyatli yuklandi.
                </p>
              </div>

              <div className="excel-kpi-grid">
                <div className="excel-kpi-card">
                  <Package size={20} color="#16a34a" />
                  <div>
                    <b>{stats.created} ta</b>
                    <small>Yaratilgan tovarlar</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <Tag size={20} color="#2563eb" />
                  <div>
                    <b>{stats.categoriesCreated} ta</b>
                    <small>Yangi ochilgan kategoriya</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <ImageIcon size={20} color="var(--orange)" />
                  <div>
                    <b>{stats.imagesUploaded} ta</b>
                    <small>R2 ga yuklangan rasmlar</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <Globe2 size={20} color={isPublished ? '#16a34a' : '#6b7280'} />
                  <div>
                    <b>{isPublished ? 'Saytda faol' : 'Qoralama'}</b>
                    <small>Ko‘rinish holati</small>
                  </div>
                </div>
              </div>

              {stats.errors.length > 0 && (
                <div className="excel-error-banner" style={{ marginTop: 16 }}>
                  <AlertTriangle size={18} />
                  <div>
                    <b>Ba’zi xatoliklar yuz berdi:</b>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
                      {stats.errors.map((err, i) => <li key={i}>{err}</li>)}
                    </ul>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 24, textAlign: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={onClose} style={{ minWidth: 180 }}>
                  Yopish va ro‘yxatni yangilash
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
