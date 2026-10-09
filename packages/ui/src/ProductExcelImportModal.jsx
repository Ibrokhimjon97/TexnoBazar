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
  Layers,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Tag,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { getBrowserClient, uploadProductMedia, saveProductVariants } from '@texnobazar/data';
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

const COLOR_HEX_MAP = {
  'oq': '#FFFFFF',
  'qora': '#1A1A1A',
  'kulrang': '#8C8C8C',
  'kumush': '#C7CBD1',
  'qizil': '#E53935',
  'ko‘k': '#1E88E5',
  'kok': '#1E88E5',
  'ko`k': '#1E88E5',
  'yashil': '#43A047',
  'sariq': '#FDD835',
  'jigarrang': '#6D4C41',
  'bej': '#E8DCC8',
  'oltin': '#C9A227',
  'pushti': '#EC80A0',
  'binafsha': '#8E24AA',
  'moviy': '#00ACC1',
  'to‘q ko‘k': '#0D47A1',
  'toq kok': '#0D47A1',
  'tilla': '#D4AF37',
  'bronza': '#CD7F32',
};

function getColorHex(name) {
  if (!name) return '#CCCCCC';
  const clean = String(name).trim().toLowerCase();
  return COLOR_HEX_MAP[clean] || '#CCCCCC';
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
  const [detectedBrands, setDetectedBrands] = useState([]);
  const [totalImagesFound, setTotalImagesFound] = useState(0);
  const [totalVariantsFound, setTotalVariantsFound] = useState(0);
  const [skippedRows, setSkippedRows] = useState([]);

  // Settings
  const [isPublished, setIsPublished] = useState(true);
  const [autoCreateCategory, setAutoCreateCategory] = useState(true);
  const [autoCreateBrand, setAutoCreateBrand] = useState(true);
  const [uploadImages, setUploadImages] = useState(true);
  const [exchangeRate, setExchangeRate] = useState(12800);
  const [markupPercent, setMarkupPercent] = useState(25);

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
    brandsCreated: 0,
    variantsCreated: 0,
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
      setDetectedBrands([]);
      setTotalImagesFound(0);
      setTotalVariantsFound(0);
      setSkippedRows([]);
      setFileError('');
      setProgress(0);
      setStats({
        total: 0,
        created: 0,
        updated: 0,
        categoriesCreated: 0,
        brandsCreated: 0,
        variantsCreated: 0,
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

  // Download Sample Template with full 29 columns (Main product + 2-rang + 3-rang)
  const handleDownloadSample = async () => {
    try {
      const ExcelJS = await getExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Texnobazar';
      wb.created = new Date();
      const ws = wb.addWorksheet('Tovarlar');

      ws.columns = [
        // 1-15: Asosiy mahsulot (1-rang)
        { header: '№', key: 'no', width: 6 },
        { header: 'Kod', key: 'code', width: 14 },
        { header: 'Mahsulot nomi', key: 'name', width: 44 },
        { header: 'Kategoriya', key: 'category', width: 28 },
        { header: 'Brend', key: 'brand', width: 18 },
        { header: 'Tannarxi', key: 'cost_price', width: 14 },
        { header: 'sotish narxi', key: 'retail_price', width: 16 },
        { header: 'Eski narx', key: 'old_price', width: 16 },
        { header: 'ulgurji narxi', key: 'wholesale_price', width: 16 },
        { header: 'minimal sotuv narxi', key: 'min_price', width: 18 },
        { header: 'Youtube URL', key: 'video_url', width: 34 },
        { header: 'Ushbu tovar boshqa saytdagi url (rasmini olish uchun)', key: 'url', width: 34 },
        { header: 'Mahsulot tavsifi', key: 'description', width: 50 },
        { header: 'Asosiy rang', key: 'base_color', width: 16 },
        { header: 'Mahsulot rasmi', key: 'image', width: 22 },

        // 16-22: 2-rang variantlari
        { header: '2-rang nomi', key: 'v2_name', width: 16 },
        { header: '2-rang tannarxi', key: 'v2_cost', width: 16 },
        { header: '2-rang sotish narxi', key: 'v2_retail', width: 18 },
        { header: '2-rang eski narxi', key: 'v2_old_price', width: 16 },
        { header: '2-rang ulgurji narxi', key: 'v2_wholesale', width: 18 },
        { header: '2-rang minimal sotuv narxi', key: 'v2_min', width: 20 },
        { header: '2-rang rasmi', key: 'v2_image', width: 22 },

        // 23-29: 3-rang variantlari
        { header: '3-rang nomi', key: 'v3_name', width: 16 },
        { header: '3-rang tannarxi', key: 'v3_cost', width: 16 },
        { header: '3-rang sotish narxi', key: 'v3_retail', width: 18 },
        { header: '3-rang eski narxi', key: 'v3_old_price', width: 16 },
        { header: '3-rang ulgurji narxi', key: 'v3_wholesale', width: 18 },
        { header: '3-rang minimal sotuv narxi', key: 'v3_min', width: 20 },
        { header: '3-rang rasmi', key: 'v3_image', width: 22 },

        // 30-36: 4-rang variantlari
        { header: '4-rang nomi', key: 'v4_name', width: 16 },
        { header: '4-rang tannarxi', key: 'v4_cost', width: 16 },
        { header: '4-rang sotish narxi', key: 'v4_retail', width: 18 },
        { header: '4-rang eski narxi', key: 'v4_old_price', width: 16 },
        { header: '4-rang ulgurji narxi', key: 'v4_wholesale', width: 18 },
        { header: '4-rang minimal sotuv narxi', key: 'v4_min', width: 20 },
        { header: '4-rang rasmi', key: 'v4_image', width: 22 },

        // 37-43: 5-rang variantlari
        { header: '5-rang nomi', key: 'v5_name', width: 16 },
        { header: '5-rang tannarxi', key: 'v5_cost', width: 16 },
        { header: '5-rang sotish narxi', key: 'v5_retail', width: 18 },
        { header: '5-rang eski narxi', key: 'v5_old_price', width: 16 },
        { header: '5-rang ulgurji narxi', key: 'v5_wholesale', width: 18 },
        { header: '5-rang minimal sotuv narxi', key: 'v5_min', width: 20 },
        { header: '5-rang rasmi', key: 'v5_image', width: 22 },
      ];

      // Style header row with section colors
      const headerRow = ws.getRow(1);
      headerRow.height = 36;
      headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

      // Base cols (1-15): Texnobazar Orange
      for (let c = 1; c <= 15; c++) {
        const cell = headerRow.getCell(c);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
      }

      // 2-rang cols (16-22): Modern Indigo/Blue
      for (let c = 16; c <= 22; c++) {
        const cell = headerRow.getCell(c);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      }

      // 3-rang cols (23-29): Emerald Green
      for (let c = 23; c <= 29; c++) {
        const cell = headerRow.getCell(c);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
      }

      // 4-rang cols (30-36): Royal Purple
      for (let c = 30; c <= 36; c++) {
        const cell = headerRow.getCell(c);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
      }

      // 5-rang cols (37-43): Deep Teal
      for (let c = 37; c <= 43; c++) {
        const cell = headerRow.getCell(c);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D9488' } };
      }

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
          if (ctx.roundRect) ctx.roundRect(8, 8, 144, 144, 18);
          else ctx.rect(8, 8, 144, 144);
          ctx.fill();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
          ctx.lineWidth = 3;
          if (ctx.roundRect) ctx.roundRect(14, 14, 132, 132, 14);
          else ctx.rect(14, 14, 132, 132);
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(title, 80, 68);

          ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
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

      const img1Red = makeSampleImg('BELANCHAK', 'QIZIL', '#ef4444', '#b91c1c');
      const img1Blue = makeSampleImg('BELANCHAK', 'KO‘K', '#2563eb', '#1d4ed8');
      const img1Green = makeSampleImg('BELANCHAK', 'YASHIL', '#059669', '#047857');

      const img2Silver = makeSampleImg('HOFMANN', 'KUMUSH', '#64748b', '#475569');
      const img2White = makeSampleImg('HOFMANN', 'OQ', '#0284c7', '#0369a1');

      const img3White = makeSampleImg('ARTEL', 'OQ', '#0d9488', '#0f766e');
      const img3Black = makeSampleImg('ARTEL', 'QORA', '#18181b', '#09090b');
      const img3Grey = makeSampleImg('ARTEL', 'KULRANG', '#71717a', '#52525b');

      const sampleRows = [
        {
          no: 1,
          code: '10892',
          name: 'TEMIR BELANCHAK MODEL 450',
          category: 'BOLALAR UCHUN MAXSULOTLAR',
          brand: 'TexnoKids',
          cost_price: 36.73,
          retail_price: 45.00,
          old_price: 55.00,
          wholesale_price: 40.00,
          min_price: 38.00,
          video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          url: 'https://texnobazar.uz/samples/belanchak-450.jpg',
          description: "Temir Belanchak Model 450 bolalar uchun mo'ljallangan mustahkam va xavfsiz belanchak.",
          base_color: 'Qizil',
          image: '',
          imgId: img1Red,

          v2_name: 'Ko‘k',
          v2_cost: 37.00,
          v2_retail: 47.00,
          v2_old_price: 55.00,
          v2_wholesale: 41.00,
          v2_min: 39.00,
          v2_image: '',
          v2ImgId: img1Blue,

          v3_name: 'Yashil',
          v3_cost: '', // bo'sh = asosiy tannarx olinadi
          v3_retail: '', // bo'sh = asosiy sotish narxi olinadi
          v3_old_price: '',
          v3_wholesale: '',
          v3_min: '',
          v3_image: '',
          v3ImgId: img1Green,
        },
        {
          no: 2,
          code: '10891',
          name: 'HOFMANN WM814SDG/HF 8 KG AVTOMAT KIR MOSHINA',
          category: 'Avtomat Kir Yuvish moshinalar',
          brand: 'Hofmann',
          cost_price: 495.00,
          retail_price: '',
          old_price: '',
          wholesale_price: '',
          min_price: '',
          video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          url: 'https://texnobazar.uz/samples/hofmann-8kg.jpg',
          description: "Hofmann 8 kg sig'imli zamonaviy invertor motorli avtomat kir yuvish mashinasi.",
          base_color: 'Kumush',
          image: '',
          imgId: img2Silver,

          v2_name: 'Oq',
          v2_cost: 490.00,
          v2_retail: 550.00,
          v2_old_price: 600.00,
          v2_wholesale: 520.00,
          v2_min: 500.00,
          v2_image: '',
          v2ImgId: img2White,

          v3_name: '',
          v3_cost: '',
          v3_retail: '',
          v3_old_price: '',
          v3_wholesale: '',
          v3_min: '',
          v3_image: '',
          v3ImgId: null,
        },
        {
          no: 3,
          code: '10890',
          name: 'ARTEL 8 KG ART-WM8002 B PURE AVTOMAT KIR MOSHINA',
          category: 'Avtomat Kir Yuvish moshinalar',
          brand: 'Artel',
          cost_price: 391.00,
          retail_price: 460.00,
          old_price: 520.00,
          wholesale_price: 430.00,
          min_price: 400.00,
          video_url: '',
          url: 'https://texnobazar.uz/samples/artel-wm8002.jpg',
          description: "Artel Pure seriyasidagi 8 kg avtomat kir yuvish mashinasi.",
          base_color: 'Oq',
          image: '',
          imgId: img3White,

          v2_name: 'Qora',
          v2_cost: 395.00,
          v2_retail: 475.00,
          v2_old_price: 535.00,
          v2_wholesale: 440.00,
          v2_min: 410.00,
          v2_image: '',
          v2ImgId: img3Black,

          v3_name: 'Kulrang',
          v3_cost: '',
          v3_retail: '',
          v3_old_price: '',
          v3_wholesale: '',
          v3_min: '',
          v3_image: '',
          v3ImgId: img3Grey,
        },
      ];

      sampleRows.forEach((item, idx) => {
        const row = ws.addRow(item);
        row.height = 68;
        row.alignment = { vertical: 'middle' };

        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          };
        });

        const rIdx = idx + 1; // 0-based row index for images

        // 1. Asosiy Mahsulot rasmi (Col 15 = 0-indexed 14)
        if (item.imgId != null) {
          ws.addImage(item.imgId, {
            tl: { col: 14, row: rIdx },
            ext: { width: 55, height: 55 },
            editAs: 'oneCell',
          });
        }

        // 2. 2-rang rasmi (Col 22 = 0-indexed 21)
        if (item.v2ImgId != null) {
          ws.addImage(item.v2ImgId, {
            tl: { col: 21, row: rIdx },
            ext: { width: 55, height: 55 },
            editAs: 'oneCell',
          });
        }

        // 3. 3-rang rasmi (Col 29 = 0-indexed 28)
        if (item.v3ImgId != null) {
          ws.addImage(item.v3ImgId, {
            tl: { col: 28, row: rIdx },
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

      // 1. Direct image extraction via JSZip: support multiple images per row (cell-anchored)
      const zip = await JSZip.loadAsync(rawBuffer);
      const directCellImages = new Map(); // key: `${rowIdx}:${colIdx}`
      const directRowImages = new Map();  // key: rowIdx (fallback)

      try {
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

        for (const name of Object.keys(zip.files)) {
          if (/xl\/drawings\/.*\.xml$/i.test(name) && !name.includes('_rels')) {
            const xml = await zip.files[name].async('string');
            const anchorRegex = /<(?:[a-zA-Z0-9]+:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?(?:oneCellAnchor|twoCellAnchor)>/gi;
            const blocks = xml.match(anchorRegex) || [];

            for (const block of blocks) {
              const fromMatch = block.match(/<(?:[a-zA-Z0-9]+:)?from\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?from>/i);
              const targetXml = fromMatch ? fromMatch[0] : block;
              const rowMatch = targetXml.match(/<(?:[a-zA-Z0-9]+:)?row>(\d+)<\/(?:[a-zA-Z0-9]+:)?row>/i);
              const colMatch = targetXml.match(/<(?:[a-zA-Z0-9]+:)?col>(\d+)<\/(?:[a-zA-Z0-9]+:)?col>/i);
              const blipMatch = block.match(/<[a-zA-Z0-9:]*blip\b[^>]+(?:r:embed|embed)="([^"]+)"/i);

              if (rowMatch && blipMatch) {
                const rowIdx = parseInt(rowMatch[1], 10) + 1; // 1-based row
                const colIdx = colMatch ? parseInt(colMatch[1], 10) + 1 : null; // 1-based col
                const rId = blipMatch[1];
                const mediaPath = rIdMap[rId];
                if (mediaPath) {
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
                    if (colIdx) {
                      directCellImages.set(`${rowIdx}:${colIdx}`, { buffer: imgBuf, ext });
                    }
                    if (!directRowImages.has(rowIdx)) {
                      directRowImages.set(rowIdx, { buffer: imgBuf, ext });
                    }
                  }
                }
              }
            }
          }
        }
      } catch (zipExtractErr) {
        console.warn('Direct zip image extraction notice:', zipExtractErr);
      }

      // 2. Prepare clean zip for ExcelJS: strip drawings to prevent crashes
      let cleanBuffer = rawBuffer;
      try {
        const cleanZip = new JSZip();
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          const cleanName = name.replace(/\\/g, '/');

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

      // 3. Load with ExcelJS
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(cleanBuffer);

      const ws = workbook.worksheets[0];
      if (!ws || ws.rowCount < 2) {
        throw new Error('Excel faylida yetarli qatorlar mavjud emas.');
      }

      // Detect header row and column mapping
      let headerRowIndex = 1;
      const colMap = {
        name: null,
        code: null,
        category: null,
        brand: null,
        costPrice: null,
        retailPrice: null,
        oldPrice: null,
        wholesalePrice: null,
        minPrice: null,
        videoUrl: null,
        url: null,
        description: null,
        baseColor: null,
        image: null,
        variants: {}, // { 2: { name, costPrice, retailPrice, oldPrice, wholesalePrice, minPrice, image }, 3: ... }
      };

      for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
        const row = ws.getRow(r);
        let foundHeaders = 0;
        row.eachCell((cell, colNumber) => {
          const val = String(cell.value || '').trim().toLowerCase();
          if (!val) return;

          // Check if this column belongs to an additional color variant: e.g. "2-rang", "3-rang", "boshqa rang"
          const variantMatch = val.match(/(?:(\d+)|boshqa)[-_ ]?rang/i);
          if (variantMatch && (variantMatch[1] || val.includes('boshqa'))) {
            const vNum = variantMatch[1] ? parseInt(variantMatch[1], 10) : 2;
            if (vNum >= 2) {
              colMap.variants[vNum] = colMap.variants[vNum] || {};
              if (/nomi|nom|^(\d+)[-_ ]?rang$/i.test(val)) {
                colMap.variants[vNum].name = colNumber;
                foundHeaders++;
              } else if (/tannarx|tan\s*narx|kirim|cost/i.test(val)) {
                colMap.variants[vNum].costPrice = colNumber;
              } else if (/eski\s*narx|old\s*price|compare/i.test(val)) {
                colMap.variants[vNum].oldPrice = colNumber;
              } else if (/sotish|sotuv|chakana|retail|narx/i.test(val)) {
                colMap.variants[vNum].retailPrice = colNumber;
              } else if (/ulgurji|optom|wholesale/i.test(val)) {
                colMap.variants[vNum].wholesalePrice = colNumber;
              } else if (/minimal|min\s*narx|min\s*sotuv/i.test(val)) {
                colMap.variants[vNum].minPrice = colNumber;
              } else if (/rasm|image|foto|picture|link|url/i.test(val)) {
                colMap.variants[vNum].image = colNumber;
              }
              return;
            }
          }

          // Base product columns
          if (/mahsulot\s*nomi|tovar\s*nomi|^nomi$|^mahsulot$|^tovar$/i.test(val)) {
            colMap.name = colNumber;
            foundHeaders++;
          } else if (/^kod$|^artikul$|^sku$|^code$/i.test(val)) {
            colMap.code = colNumber;
            foundHeaders++;
          } else if (/kategoriya|category|bo['‘`]?lim/i.test(val)) {
            colMap.category = colNumber;
            foundHeaders++;
          } else if (/^brend$|^brand$|^ishlab\s*chiqaruvchi$/i.test(val)) {
            colMap.brand = colNumber;
            foundHeaders++;
          } else if (/^tannarx|^tan\s*narx|^kirim\s*narx|^cost/i.test(val)) {
            colMap.costPrice = colNumber;
            foundHeaders++;
          } else if (/^eski\s*narx|^old\s*price|^avvalgi\s*narx|^compare/i.test(val)) {
            colMap.oldPrice = colNumber;
            foundHeaders++;
          } else if (/sotish\s*narx|sotuv\s*narx|chakana|retail|^narx$/i.test(val)) {
            colMap.retailPrice = colNumber;
          } else if (/ulgurji|optom|wholesale/i.test(val)) {
            colMap.wholesalePrice = colNumber;
          } else if (/minimal|min\s*narx/i.test(val)) {
            colMap.minPrice = colNumber;
          } else if (/youtube|video|klip/i.test(val)) {
            colMap.videoUrl = colNumber;
          } else if (/boshqa\s*sayt|saytdagi\s*url|link|^url$/i.test(val)) {
            colMap.url = colNumber;
          } else if (/tavsif|description|izoh/i.test(val)) {
            colMap.description = colNumber;
          } else if (/^rang$|^asosiy\s*rang|^1[-_ ]?rang/i.test(val)) {
            colMap.baseColor = colNumber;
          } else if (/mahsulot\s*rasmi|^rasm$|^image$|^foto$/i.test(val)) {
            colMap.image = colNumber;
          }
        });

        if (foundHeaders >= 2) {
          headerRowIndex = r;
          break;
        }
      }

      // Default fallback column positions matching our 29-column standard
      if (!colMap.name) colMap.name = 3;
      if (!colMap.code) colMap.code = 2;
      if (!colMap.category) colMap.category = 4;
      if (!colMap.brand) colMap.brand = 5;
      if (!colMap.costPrice) colMap.costPrice = 6;
      if (!colMap.retailPrice) colMap.retailPrice = 7;
      if (!colMap.oldPrice) colMap.oldPrice = 8;
      if (!colMap.wholesalePrice) colMap.wholesalePrice = 9;
      if (!colMap.minPrice) colMap.minPrice = 10;
      if (!colMap.videoUrl) colMap.videoUrl = 11;
      if (!colMap.url) colMap.url = 12;
      if (!colMap.description) colMap.description = 13;
      if (!colMap.baseColor) colMap.baseColor = 14;
      if (!colMap.image) colMap.image = 15;

      if (!colMap.variants[2]) {
        colMap.variants[2] = {
          name: 16, costPrice: 17, retailPrice: 18, oldPrice: 19,
          wholesalePrice: 20, minPrice: 21, image: 22
        };
      }
      if (!colMap.variants[3]) {
        colMap.variants[3] = {
          name: 23, costPrice: 24, retailPrice: 25, oldPrice: 26,
          wholesalePrice: 27, minPrice: 28, image: 29
        };
      }
      if (!colMap.variants[4]) {
        colMap.variants[4] = {
          name: 30, costPrice: 31, retailPrice: 32, oldPrice: 33,
          wholesalePrice: 34, minPrice: 35, image: 36
        };
      }
      if (!colMap.variants[5]) {
        colMap.variants[5] = {
          name: 37, costPrice: 38, retailPrice: 39, oldPrice: 40,
          wholesalePrice: 41, minPrice: 42, image: 43
        };
      }

      // Helper to extract image from cell (embedded or URL)
      const extractImage = (rowIdx, colIdx, fallbackColIdx = null) => {
        let file = null;
        let url = null;
        let previewUrl = null;

        // 1. Direct embedded image at cell
        if (colIdx && directCellImages.has(`${rowIdx}:${colIdx}`)) {
          const imgObj = directCellImages.get(`${rowIdx}:${colIdx}`);
          const ext = imgObj.ext === 'jpg' ? 'jpeg' : (imgObj.ext || 'png');
          file = new File([imgObj.buffer], `product-r${rowIdx}-c${colIdx}.${imgObj.ext || 'png'}`, { type: `image/${ext}` });
          previewUrl = URL.createObjectURL(file);
          return { file, url, previewUrl };
        }

        // 2. Read URL text from cell
        const readCellUrl = (cIdx) => {
          if (!cIdx) return null;
          const c = ws.getRow(rowIdx).getCell(cIdx);
          if (!c || c.value == null) return null;
          let val = c.value;
          if (typeof val === 'object') {
            val = val.hyperlink || val.text || val.result || '';
          }
          val = String(val || '').trim();
          if (/^https?:\/\//i.test(val) || /^data:image\//i.test(val)) {
            return val;
          }
          return null;
        };

        const cellUrl = readCellUrl(colIdx) || (fallbackColIdx ? readCellUrl(fallbackColIdx) : null);
        if (cellUrl) {
          url = cellUrl;
          previewUrl = cellUrl;
          return { file, url, previewUrl };
        }

        // 3. Fallback to row image if this is the main image column
        if (colIdx === colMap.image && directRowImages.has(rowIdx)) {
          const imgObj = directRowImages.get(rowIdx);
          const ext = imgObj.ext === 'jpg' ? 'jpeg' : (imgObj.ext || 'png');
          file = new File([imgObj.buffer], `product-r${rowIdx}.${imgObj.ext || 'png'}`, { type: `image/${ext}` });
          previewUrl = URL.createObjectURL(file);
          return { file, url, previewUrl };
        }

        return { file: null, url: null, previewUrl: null };
      };

      const readNumericCell = (row, colIdx) => {
        if (!colIdx) return null;
        const raw = row.getCell(colIdx).value;
        if (raw == null || raw === '') return null;
        const val = typeof raw === 'object' ? raw?.result || 0 : raw;
        const num = Number(val);
        return isNaN(num) ? null : num;
      };

      const items = [];
      const skippedRowsList = [];
      const categorySet = new Set();
      const brandSet = new Set();
      let totalVariantsCount = 0;

      for (let r = headerRowIndex + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);

        // Check if this row has any non-empty cell at all
        let hasAnyData = false;
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.value != null && String(cell.value).trim() !== '') {
            hasAnyData = true;
          }
        });
        if (!hasAnyData) {
          // Row is completely empty in Excel (blank row), skip silently
          continue;
        }

        const nameVal = String(row.getCell(colMap.name).value || '').trim();
        const codeVal = colMap.code ? String(row.getCell(colMap.code).value || '').trim() : '';
        const catVal = colMap.category ? String(row.getCell(colMap.category).value || '').trim() : '';

        // If row has some data but product name is missing / empty:
        if (!nameVal) {
          skippedRowsList.push({
            row: r,
            code: codeVal || '—',
            category: catVal || '—',
            reason: 'Mahsulot nomi kiritilmagan (bo‘sh)',
          });
          continue; // Do NOT import this row!
        }

        categorySet.add(catVal || 'Umumiy');

        const brandCellVal = colMap.brand ? String(row.getCell(colMap.brand).value || '').trim() : '';
        const brandVal = brandCellVal || extractBrand(nameVal) || '';
        if (brandVal) brandSet.add(brandVal);

        const costNum = readNumericCell(row, colMap.costPrice) || 0;
        const retailNum = readNumericCell(row, colMap.retailPrice);
        const oldPriceNum = readNumericCell(row, colMap.oldPrice);
        const wholesaleNum = readNumericCell(row, colMap.wholesalePrice);
        const minNum = readNumericCell(row, colMap.minPrice);

        const videoUrlVal = colMap.videoUrl ? String(row.getCell(colMap.videoUrl).value || '').trim() : '';
        const descVal = colMap.description ? String(row.getCell(colMap.description).value || '').trim() : '';
        const baseColorVal = colMap.baseColor ? String(row.getCell(colMap.baseColor).value || '').trim() : '';

        // Extract base product image
        const mainImg = extractImage(r, colMap.image, colMap.url);

        // Parse additional color variants (2-rang, 3-rang, etc.)
        const additionalVariants = [];
        const variantKeys = Object.keys(colMap.variants).map(Number).sort((a, b) => a - b);

        for (const vNum of variantKeys) {
          const vCols = colMap.variants[vNum];
          const vName = vCols.name ? String(row.getCell(vCols.name).value || '').trim() : '';
          if (!vName) continue; // Skip if no color name specified

          const vCost = readNumericCell(row, vCols.costPrice);
          const vRetail = readNumericCell(row, vCols.retailPrice);
          const vOldPrice = readNumericCell(row, vCols.oldPrice);
          const vWholesale = readNumericCell(row, vCols.wholesalePrice);
          const vMin = readNumericCell(row, vCols.minPrice);
          const vImg = extractImage(r, vCols.image);

          additionalVariants.push({
            variantNum: vNum,
            colorName: vName,
            colorHex: getColorHex(vName),
            costPrice: vCost,
            retailPrice: vRetail,
            oldPrice: vOldPrice,
            wholesalePrice: vWholesale,
            minPrice: vMin,
            imageFile: vImg.file,
            imageUrl: vImg.url,
            imagePreviewUrl: vImg.previewUrl,
          });
        }

        // Build complete color variants array:
        // If product has additional variants OR base color name is specified,
        // we create Variant 1 as the default color!
        const allColorVariants = [];
        if (additionalVariants.length > 0 || baseColorVal) {
          allColorVariants.push({
            isBase: true,
            variantNum: 1,
            colorName: baseColorVal || 'Standart',
            colorHex: getColorHex(baseColorVal || 'Standart'),
            costPrice: costNum,
            retailPrice: retailNum,
            oldPrice: oldPriceNum,
            wholesalePrice: wholesaleNum,
            minPrice: minNum,
            imageFile: mainImg.file,
            imageUrl: mainImg.url,
            imagePreviewUrl: mainImg.previewUrl,
          });

          allColorVariants.push(...additionalVariants);
          totalVariantsCount += allColorVariants.length;
        }

        items.push({
          row: r,
          code: codeVal,
          name: nameVal,
          categoryName: catVal || 'Umumiy',
          brandName: brandVal,
          costPrice: costNum,
          retailPrice: retailNum,
          oldPrice: oldPriceNum,
          wholesalePrice: wholesaleNum,
          minPrice: minNum,
          videoUrl: videoUrlVal,
          description: descVal,
          baseColor: baseColorVal,
          imageFile: mainImg.file,
          imageUrl: mainImg.url,
          imagePreviewUrl: mainImg.previewUrl,
          allColorVariants,
        });
      }

      if (items.length === 0) {
        if (skippedRowsList.length > 0) {
          throw new Error(`Excel faylida bitta ham to‘g‘ri tovar topilmadi. ${skippedRowsList.length} ta qatorda mahsulot nomi ko‘rsatilmagan.`);
        }
        throw new Error("Excel faylidan bitta ham tovar aniqlanmadi. Ustun nomlari va qatorlarni tekshiring.");
      }

      // Count total images across main products and all variants
      let foundImages = 0;
      for (const it of items) {
        if (it.imageFile || it.imageUrl) foundImages++;
        for (const v of it.allColorVariants) {
          if (!v.isBase && (v.imageFile || v.imageUrl)) foundImages++;
        }
      }

      setTotalImagesFound(foundImages);
      setTotalVariantsFound(totalVariantsCount);
      setSkippedRows(skippedRowsList);
      setParsedItems(items);
      setDetectedCategories([...categorySet]);
      setDetectedBrands([...brandSet]);
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
    let brandsCreatedCount = 0;
    let variantsCreatedCount = 0;
    let imagesUploadedCount = 0;
    let skippedCount = skippedRows.length;
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

      // 2. Refresh & ensure brands map
      setCurrentAction('Brendlar tekshirilmoqda…');
      const { data: freshBrands } = await client.from('brands').select('id, name, slug');
      const brandMap = new Map();
      const brandSlugSet = new Set();
      (freshBrands || []).forEach(b => {
        brandMap.set(b.name.trim().toUpperCase(), b.id);
        brandSlugSet.add(b.slug);
      });

      // Auto-create missing brands if enabled
      if (autoCreateBrand) {
        for (const brandName of detectedBrands) {
          const norm = brandName.trim().toUpperCase();
          if (!brandMap.has(norm)) {
            setCurrentAction(`Yangi brend yaratilmoqda: “${brandName}”…`);
            let baseSlug = slugify(brandName, 'brand');
            let candidateSlug = baseSlug;
            let counter = 1;
            while (brandSlugSet.has(candidateSlug)) {
              candidateSlug = `${baseSlug}-${counter++}`;
            }

            const { data: createdBrand, error: brandErr } = await client.from('brands').insert({
              name: brandName.trim(),
              slug: candidateSlug,
              is_active: true,
            }).select('id, name, slug').single();

            if (!brandErr && createdBrand) {
              brandMap.set(norm, createdBrand.id);
              brandSlugSet.add(createdBrand.slug);
              brandsCreatedCount++;
            } else {
              console.warn('Brand creation notice:', brandErr);
            }
          }
        }
      }

      // 3. Fetch existing products SKU and slugs to prevent duplicates
      setCurrentAction('Mavjud tovarlar tekshirilmoqda…');
      const { data: existingProducts } = await client.from('products').select('id, sku, slug');
      const existingSkuSet = new Set((existingProducts || []).map(p => p.sku.toUpperCase()));
      const existingSlugSet = new Set((existingProducts || []).map(p => p.slug));

      // 4. Process products in chunks of 10
      const total = parsedItems.length;
      const chunkSize = 10;

      for (let i = 0; i < total; i += chunkSize) {
        if (abortRef.current) {
          errors.push('Foydalanuvchi tomonidan to‘xtatildi.');
          break;
        }

        const chunk = parsedItems.slice(i, i + chunkSize);
        const productsToInsert = [];
        const chunkMeta = [];

        for (const item of chunk) {
          // Determine unique SKU
          let sku = item.code ? `TB-${item.code.toUpperCase()}` : `TB-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
          if (existingSkuSet.has(sku)) {
            sku = `${sku}-${Math.floor(10 + Math.random() * 90)}`;
          }
          existingSkuSet.add(sku);

          // Determine unique slug
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
          const bCandidate = item.brandName || extractBrand(item.name);
          const brandId = bCandidate ? (brandMap.get(bCandidate.trim().toUpperCase()) || null) : null;

          // Helper to convert prices
          const toUzs = (val) => {
            if (val == null || val === '') return null;
            const n = Number(val);
            if (isNaN(n) || n <= 0) return null;
            return n < 5000 ? Math.round(n * rate) : Math.round(n);
          };

          const costUzs = toUzs(item.costPrice) || 0;

          let retailUzs = toUzs(item.retailPrice);
          if (retailUzs == null || retailUzs <= 0) {
            retailUzs = Math.round(costUzs * margin);
          }
          if (retailUzs < costUzs) {
            retailUzs = costUzs;
          }

          const oldPriceUzs = toUzs(item.oldPrice);
          const wholesaleUzs = toUzs(item.wholesalePrice);
          let minPriceUzs = toUzs(item.minPrice);
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
            compare_at_price: oldPriceUzs,
            wholesale_price: wholesaleUzs,
            minimum_sale_price: minPriceUzs,
            video_url: item.videoUrl || null,
            description: desc,
            status: isPublished ? 'active' : 'draft',
            is_published: Boolean(isPublished),
            track_individual_units: true,
            tax_rate: 0,
            seo_title: `${item.name} — narxlar va xususiyatlar`,
            seo_description: `${item.name} sotib olish. Tez yetkazib berish va rasmiy kafolat.`,
          });

          chunkMeta.push({
            sku,
            item,
            costUzs,
            retailUzs,
            oldPriceUzs,
            wholesaleUzs,
            minPriceUzs,
          });
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
          const insertedMap = new Map((inserted || []).map(p => [p.sku, p.id]));

          // 5. Handle variants and media for each inserted product
          for (const meta of chunkMeta) {
            const productId = insertedMap.get(meta.sku);
            if (!productId) continue;

            const { item, costUzs, retailUzs, oldPriceUzs, wholesaleUzs, minPriceUzs } = meta;

            // A. If product has color variants, save them via save_product_variants
            let savedVariantsList = [];
            if (item.allColorVariants && item.allColorVariants.length > 0) {
              const variantsPayload = item.allColorVariants.map((v, sIdx) => {
                const toUzsVal = (vNum) => {
                  if (vNum == null || vNum === '') return null;
                  const n = Number(vNum);
                  if (isNaN(n) || n <= 0) return null;
                  return n < 5000 ? Math.round(n * rate) : Math.round(n);
                };

                // Fallback rules: if price not provided for variant, use product's base price!
                const vRetail = toUzsVal(v.retailPrice) || retailUzs;
                const vCost = toUzsVal(v.costPrice) || costUzs;
                const vOld = toUzsVal(v.oldPrice) || oldPriceUzs;
                const vWholesale = toUzsVal(v.wholesalePrice) || wholesaleUzs;
                const vMin = toUzsVal(v.minPrice) || minPriceUzs;

                return {
                  color_name: v.colorName,
                  color_hex: v.colorHex || null,
                  retail_price: vRetail,
                  compare_at_price: vOld,
                  cost_price: vCost,
                  wholesale_price: vWholesale,
                  minimum_sale_price: vMin,
                  sort_order: sIdx,
                  is_active: true,
                };
              });

              try {
                const saved = await saveProductVariants(productId, variantsPayload);
                savedVariantsList = saved || [];
                variantsCreatedCount += savedVariantsList.length;
              } catch (varErr) {
                console.warn(`Variant saving error for ${meta.sku}:`, varErr);
              }
            }

            // B. Upload Images (Main image and variant images) if enabled
            if (uploadImages) {
              // 1. Upload main product image
              if (item.imageFile || item.imageUrl) {
                try {
                  setCurrentAction(`Rasm yuklanmoqda: ${item.name.slice(0, 26)}…`);
                  let fileToUpload = item.imageFile;
                  if (!fileToUpload && item.imageUrl) {
                    try {
                      const res = await fetch(item.imageUrl);
                      if (res.ok) {
                        const blob = await res.blob();
                        const ext = blob.type?.includes('png') ? 'png' : 'jpeg';
                        fileToUpload = new File([blob], `product-${meta.sku}.${ext}`, { type: blob.type || 'image/jpeg' });
                      }
                    } catch (fetchErr) {
                      console.warn('URL fetch notice:', fetchErr);
                    }
                  }

                  if (fileToUpload) {
                    await uploadProductMedia(productId, fileToUpload, item.name);
                    imagesUploadedCount++;
                  } else if (item.imageUrl) {
                    await client.from('products').update({ seo_image_url: item.imageUrl }).eq('id', productId);
                  }
                } catch (imgErr) {
                  console.warn('Main media upload error:', imgErr);
                }
              }

              // 2. Upload variant images linked to specific variant_id
              if (savedVariantsList.length > 0 && item.allColorVariants?.length > 0) {
                for (let vi = 0; vi < savedVariantsList.length && vi < item.allColorVariants.length; vi++) {
                  const vObj = item.allColorVariants[vi];
                  const sv = savedVariantsList[vi];

                  // If this variant has its own image file or URL
                  if (vObj.imageFile || vObj.imageUrl) {
                    try {
                      let vFile = vObj.imageFile;
                      if (!vFile && vObj.imageUrl) {
                        try {
                          const res = await fetch(vObj.imageUrl);
                          if (res.ok) {
                            const blob = await res.blob();
                            const ext = blob.type?.includes('png') ? 'png' : 'jpeg';
                            vFile = new File([blob], `variant-${meta.sku}-${vi}.${ext}`, { type: blob.type || 'image/jpeg' });
                          }
                        } catch (fErr) {
                          console.warn('Variant URL fetch notice:', fErr);
                        }
                      }

                      if (vFile) {
                        setCurrentAction(`Variant rasmi yuklanmoqda: ${vObj.colorName}…`);
                        await uploadProductMedia(productId, vFile, `${item.name} (${vObj.colorName})`, sv.id);
                        imagesUploadedCount++;
                      }
                    } catch (vMediaErr) {
                      console.warn(`Variant media upload error for ${vObj.colorName}:`, vMediaErr);
                    }
                  }
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
          brandsCreated: brandsCreatedCount,
          variantsCreated: variantsCreatedCount,
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
                Brendlar, eski narxlar, YouTube video havolasi va rang variantlarini avtomatik yuklash
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
                    <small>Tovarlar, brendlar, rang variantlari va rasmlar tahlil qilinmoqda</small>
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
                    <b>Qanday ustunlar mavjud?</b>
                    <p className="muted small" style={{ margin: '2px 0 0 0', lineHeight: 1.4 }}>
                      Asosiy ustunlar: <code>Kod</code>, <code>Mahsulot nomi</code>, <code>Kategoriya</code>, <b><code>Brend</code></b>, <code>Tannarxi</code>, <code>sotish narxi</code>, <b><code>Eski narx</code></b>, <code>ulgurji narxi</code>, <code>minimal sotuv narxi</code>, <b><code>Youtube URL</code></b>, <b><code>Asosiy rang</code></b>, <code>Mahsulot rasmi</code>.
                    </p>
                    <p className="muted small" style={{ margin: '3px 0 0 0', color: 'var(--orange)', fontWeight: 500 }}>
                      🎨 Rang variantlari: <b><code>2-rang nomi</code></b>, <b><code>2-rang sotish narxi</code></b>, <b><code>2-rang rasmi</code></b>, <b><code>3-rang ...</code></b> orqali bir nechta ranglarni narxlari va rasmlari bilan qo‘shish mumkin. Agar variant narxi bo‘sh qoldirilsa, asosiy narx avtomatik amal qiladi.
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
                  <Layers size={20} color="#8b5cf6" />
                  <div>
                    <b>{totalVariantsFound} ta</b>
                    <small>Rang variantlari</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <ImageIcon size={20} color="#16a34a" />
                  <div>
                    <b>{totalImagesFound} ta</b>
                    <small>Ichki rasm topildi</small>
                  </div>
                </div>
                {skippedRows.length > 0 && (
                  <div className="excel-kpi-card" style={{ borderColor: '#fde047', background: '#fefce8' }}>
                    <AlertTriangle size={20} color="#d97706" />
                    <div>
                      <b style={{ color: '#d97706' }}>{skippedRows.length} ta</b>
                      <small style={{ color: '#92400e' }}>Nomsiz (o‘tkaziladi)</small>
                    </div>
                  </div>
                )}
              </div>

              {/* Skipped Rows Notice Banner */}
              {skippedRows.length > 0 && (
                <div className="card pad" style={{ marginTop: 12, marginBottom: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
                  <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <AlertTriangle size={18} color="#d97706" />
                      <b style={{ color: '#b45309', fontSize: 13 }}>
                        {skippedRows.length} ta qatorda mahsulot nomi yo‘q — ular import qilinmaydi!
                      </b>
                    </div>
                    <span className="badge" style={{ background: '#fef3c7', color: '#b45309', fontSize: 11 }}>
                      Faqat nomi bor {parsedItems.length} ta tovar import qilinadi
                    </span>
                  </div>
                  <p style={{ margin: '6px 0 8px', fontSize: 12, color: '#78350f' }}>
                    Excel jadvalidagi quyidagi qatorlarda tovar nomi bo‘sh qoldirilgan. Tizim ularni tashlab ketadi va faqat nomi bor tovarlarni import qiladi:
                  </p>
                  <div style={{ maxHeight: 120, overflowY: 'auto', background: '#fff', borderRadius: 6, border: '1px solid #fef08a' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
                      <thead>
                        <tr style={{ background: '#fef9c3', borderBottom: '1px solid #fef08a', color: '#854d0e' }}>
                          <th style={{ padding: '4px 8px' }}>Excel qatori</th>
                          <th style={{ padding: '4px 8px' }}>Kodi (Artikul)</th>
                          <th style={{ padding: '4px 8px' }}>Kategoriya</th>
                          <th style={{ padding: '4px 8px' }}>Holat</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skippedRows.map((s, sIdx) => (
                          <tr key={sIdx} style={{ borderBottom: '1px solid #fef9c3' }}>
                            <td style={{ padding: '4px 8px' }}><b>{s.row}-qator</b></td>
                            <td style={{ padding: '4px 8px' }}><code>{s.code || '—'}</code></td>
                            <td style={{ padding: '4px 8px' }}>{s.category || '—'}</td>
                            <td style={{ padding: '4px 8px', color: '#b91c1c' }}>
                              <span className="badge red" style={{ fontSize: 10, padding: '1px 5px' }}>{s.reason}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

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
                        Belgilansa, tovarlar darhol online do‘konda faol holatda ko‘rinadi.
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
                      <b>Mavjud bo‘lmagan kategoriyalarni avtomatik ochish</b>
                      <small>
                        Agar Exceldagi kategoriya saytda bo‘lmasa, tizim avtomatik yangi kategoriya ochadi.
                      </small>
                    </div>
                  </label>

                  {/* CRITICAL CHECKBOX: Brendlarni avtomatik yaratish */}
                  <label className="excel-checkbox-label">
                    <input
                      type="checkbox"
                      checked={autoCreateBrand}
                      onChange={e => setAutoCreateBrand(e.target.checked)}
                    />
                    <div>
                      <b>Yangi brendlarni avtomatik ro‘yxatga olish</b>
                      <small>
                        Exceldagi brend saytda bo‘lmasa, yangi brend sifatida kiritiladi.
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
                        <small>Rasmlar avtomatik siqilib bulut xotirasiga joylanadi.</small>
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
                        <th>Mahsulot nomi va Brend</th>
                        <th>Kategoriya</th>
                        <th>Rang variantlari</th>
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

                        let oldPriceUzs = item.oldPrice != null
                          ? (item.oldPrice > 0 && item.oldPrice < 5000 ? Math.round(item.oldPrice * exchangeRate) : item.oldPrice)
                          : null;

                        return (
                          <tr key={idx}>
                            <td>
                              <div style={{ width: 38, height: 38, position: 'relative', borderRadius: 6, overflow: 'hidden', background: '#f8fafc', border: '1px solid var(--border)' }}>
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
                              <div>
                                <b style={{ display: 'block', maxWidth: 260, whiteSpace: 'normal', lineHeight: 1.3 }}>
                                  {item.name}
                                </b>
                                <div className="row" style={{ gap: 6, marginTop: 3 }}>
                                  {item.brandName && (
                                    <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: '#fef3c7', color: '#b45309' }}>
                                      {item.brandName}
                                    </span>
                                  )}
                                  {item.videoUrl && (
                                    <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: '#fee2e2', color: '#b91c1c', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                      <Video size={10} /> Video
                                    </span>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td>
                              <span className={`badge ${isCatExist ? 'blue' : 'green'}`} style={{ fontSize: 11 }}>
                                {item.categoryName} {!isCatExist && ' (yangi)'}
                              </span>
                            </td>
                            <td>
                              {item.allColorVariants && item.allColorVariants.length > 0 ? (
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 200 }}>
                                  {item.allColorVariants.map((v, vIdx) => {
                                    const vRetail = v.retailPrice != null
                                      ? (v.retailPrice > 0 && v.retailPrice < 5000 ? Math.round(v.retailPrice * exchangeRate) : v.retailPrice)
                                      : retailUzs;
                                    return (
                                      <span
                                        key={vIdx}
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 4,
                                          fontSize: 11,
                                          padding: '2px 6px',
                                          borderRadius: 12,
                                          background: '#f1f5f9',
                                          border: '1px solid var(--border)',
                                        }}
                                        title={`${v.colorName} (${formatMoney(vRetail)})`}
                                      >
                                        <span
                                          style={{
                                            width: 8,
                                            height: 8,
                                            borderRadius: '50%',
                                            background: v.colorHex || '#ccc',
                                            border: '1px solid rgba(0,0,0,0.2)',
                                          }}
                                        />
                                        <b>{v.colorName}</b>
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : (
                                <span className="muted" style={{ fontSize: 11 }}>Standart</span>
                              )}
                            </td>
                            <td>
                              <span>{formatMoney(costUzs)}</span>
                              {item.costPrice < 5000 && item.costPrice > 0 && <small className="muted" style={{ display: 'block' }}>${item.costPrice}</small>}
                            </td>
                            <td>
                              <b style={{ color: 'var(--orange-dark)' }}>{formatMoney(retailUzs)}</b>
                              {oldPriceUzs > retailUzs && (
                                <del style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>{formatMoney(oldPriceUzs)}</del>
                              )}
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
                <button type="button" className="btn btn-primary" onClick={startImport} style={{ minWidth: 240 }}>
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
                  <div><b>{stats.created}</b><span>Tovar yaratildi</span></div>
                  <div><b>{stats.variantsCreated}</b><span>Rang varianti</span></div>
                  <div><b>{stats.brandsCreated}</b><span>Yangi brend</span></div>
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
                  Barcha tovarlar, brendlar va rang variantlari ma’lumotlar bazasiga muvaffaqiyatli yuklandi.
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
                  <Layers size={20} color="#8b5cf6" />
                  <div>
                    <b>{stats.variantsCreated} ta</b>
                    <small>Rang variantlari</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <Tag size={20} color="#2563eb" />
                  <div>
                    <b>{stats.brandsCreated} ta</b>
                    <small>Yangi brendlar</small>
                  </div>
                </div>
                <div className="excel-kpi-card">
                  <ImageIcon size={20} color="var(--orange)" />
                  <div>
                    <b>{stats.imagesUploaded} ta</b>
                    <small>R2 ga yuklangan rasmlar</small>
                  </div>
                </div>
                {skippedRows.length > 0 && (
                  <div className="excel-kpi-card" style={{ borderColor: '#fde047', background: '#fefce8' }}>
                    <AlertTriangle size={20} color="#d97706" />
                    <div>
                      <b style={{ color: '#d97706' }}>{skippedRows.length} ta</b>
                      <small style={{ color: '#92400e' }}>Nomsiz (import qilinmadi)</small>
                    </div>
                  </div>
                )}
              </div>

              {/* Dedicated Report for Skipped Rows (No Name) */}
              {skippedRows.length > 0 && (
                <div className="card pad" style={{ marginTop: 18, background: '#fffbeb', border: '1px solid #fde68a' }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <AlertTriangle size={20} color="#d97706" />
                    <h4 style={{ margin: 0, fontSize: 15, color: '#92400e' }}>
                      Import qilinmagan tovarlar hisoboti ({skippedRows.length} ta tovar)
                    </h4>
                  </div>
                  <p style={{ margin: '0 0 10px 0', fontSize: 13, color: '#78350f' }}>
                    Excel faylida quyidagi qatorlarda <b>mahsulot nomi yozilmaganligi</b> sababli ular tizimga yuklanmadi. Qolgan barcha {stats.created} ta tovar muvaffaqiyatli import qilindi.
                  </p>
                  <div style={{ maxHeight: 200, overflowY: 'auto', background: '#ffffff', borderRadius: 6, border: '1px solid #fef08a' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
                      <thead>
                        <tr style={{ background: '#fef9c3', borderBottom: '1px solid #fef08a', color: '#854d0e' }}>
                          <th style={{ padding: '6px 10px' }}>Excel qatori</th>
                          <th style={{ padding: '6px 10px' }}>Kodi (Artikul)</th>
                          <th style={{ padding: '6px 10px' }}>Kategoriya</th>
                          <th style={{ padding: '6px 10px' }}>Sababi</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skippedRows.map((s, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid #fef9c3' }}>
                            <td style={{ padding: '6px 10px' }}><b>{s.row}-qator</b></td>
                            <td style={{ padding: '6px 10px' }}><code>{s.code || '—'}</code></td>
                            <td style={{ padding: '6px 10px' }}>{s.category || '—'}</td>
                            <td style={{ padding: '6px 10px', color: '#b91c1c' }}>
                              <span className="badge red" style={{ fontSize: 11, padding: '2px 6px' }}>{s.reason}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <small style={{ display: 'block', marginTop: 8, color: '#92400e', fontSize: 11 }}>
                    💡 Eslatma: Ushbu tovarlarni kiritish uchun Excel faylida ularga nom berib, faylni qayta import qilishingiz mumkin.
                  </small>
                </div>
              )}

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
