import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bluetooth,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Layers,
  Loader2,
  PackagePlus,
  Printer,
  QrCode,
  RefreshCw,
  Trash2,
  Upload,
  UploadCloud,
  Warehouse,
  X,
} from 'lucide-react';
import { Modal, DualPrice, Status, useExchangeRate, formatMoney, DetongerPrintModal, formatSecretCostCode } from '@texnobazar/ui';
import { getBrowserClient, createStockReceipt, getStockReceipt, listReceiptQrLabels, getLatestExchangeRate } from '@texnobazar/data';
import QRCode from 'qrcode';

async function getExcelJS() {
  const mod = await import('exceljs');
  return mod.default || mod;
}

function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const str = String(val).replace(/[\s\u00A0$,]/g, '').replace(/[^\d.-]/g, '');
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
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
  if (!s) s = `${fallback}-${Date.now().toString(36)}`;
  return s;
}

/**
 * Excel ustunlarini sarlavha matni bo'yicha aniqlash
 */
function normalizeHeader(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['‘’ʻʼ`]/g, '')
    .replace(/\$/g, 'usd')
    .replace(/so[m']?|sum/g, 'uzs')
    .replace(/[^a-z0-9]/g, '');
}

function matchColumnKeys(headerRow) {
  const keys = {};
  headerRow.forEach((cellVal, colIdx) => {
    const raw = normalizeHeader(cellVal);
    if (!raw) return;

    const isUsd = raw.includes('usd') || raw.includes('dollar');
    const isUzs = raw.includes('uzs') || raw.includes('som') || raw.includes('sum');

    // Mahsulot nomi
    if (raw.includes('nom') || raw.includes('mahsulot') || raw.includes('product') || raw.includes('tovar') || raw.includes('name')) {
      if (!keys.name && !raw.includes('kat') && !raw.includes('brend') && !raw.includes('brand') && !raw.includes('izoh') && !raw.includes('desc') && !raw.includes('tavsif')) {
        keys.name = colIdx;
      }
    }
    // Kategoriya
    if (raw.includes('kategori') || raw.includes('category') || raw.includes('kat')) {
      if (!keys.category) keys.category = colIdx;
    }
    // Brend
    if (raw.includes('brend') || raw.includes('brand')) {
      if (!keys.brand) keys.brand = colIdx;
    }
    // Tovarlar izohi (ixtiyoriy)
    if (raw.includes('izoh') || raw.includes('tavsif') || raw.includes('desc') || raw.includes('description') || raw.includes('tovarlarizoh')) {
      if (keys.description === undefined) keys.description = colIdx;
    }

    // Valyuta ustuni (masalan, "Valyuta", "Valyuta (USD yoki UZS)")
    if (raw.includes('valyut') || raw.includes('curr') || raw.includes('pulbirligi')) {
      if (!keys.currency) keys.currency = colIdx;
    }

    // Tan narxi (UZS va USD alohida)
    const isCost = raw.includes('tannarx') || raw.includes('tannarh') || raw.includes('tan') || raw.includes('cost') || raw.includes('xarid');
    if (isCost) {
      if (isUsd && keys.costUsd === undefined) {
        keys.costUsd = colIdx;
      } else if (isUzs && keys.costUzs === undefined) {
        keys.costUzs = colIdx;
      } else if (keys.cost === undefined) {
        keys.cost = colIdx;
      }
    }

    // Sotish narxi (UZS va USD alohida)
    const isRetail = (raw.includes('sotish') || raw.includes('chakana') || raw.includes('retail') || raw.includes('narx') || raw.includes('price'))
      && !isCost && !raw.includes('ulgur') && !raw.includes('min') && !raw.includes('eski');
    if (isRetail) {
      if (isUsd && keys.retailUsd === undefined) {
        keys.retailUsd = colIdx;
      } else if (isUzs && keys.retailUzs === undefined) {
        keys.retailUzs = colIdx;
      } else if (keys.retail === undefined) {
        keys.retail = colIdx;
      }
    }

    // Ulgurji narxi (UZS va USD alohida)
    const isWholesale = raw.includes('ulgur') || raw.includes('wholesale') || raw.includes('optom');
    if (isWholesale) {
      if (isUsd && keys.wholesaleUsd === undefined) {
        keys.wholesaleUsd = colIdx;
      } else if (isUzs && keys.wholesaleUzs === undefined) {
        keys.wholesaleUzs = colIdx;
      } else if (keys.wholesale === undefined) {
        keys.wholesale = colIdx;
      }
    }

    // Minimal sotish narxi (UZS va USD alohida)
    const isMin = raw.includes('min') || raw.includes('engkam');
    if (isMin) {
      if (isUsd && keys.minPriceUsd === undefined) {
        keys.minPriceUsd = colIdx;
      } else if (isUzs && keys.minPriceUzs === undefined) {
        keys.minPriceUzs = colIdx;
      } else if (keys.minPrice === undefined) {
        keys.minPrice = colIdx;
      }
    }

    // Ranglar va ularning miqdorlari (1-rang, 1-rang soni, 2-rang, 2-rang soni, 3-rang, ...)
    for (let n = 1; n <= 10; n++) {
      const isColN = raw.includes(`${n}rang`) || raw.includes(`rang${n}`) || raw.includes(`${n}color`) || raw.includes(`color${n}`);
      if (isColN) {
        const isQty = raw.includes('son') || raw.includes('miqdor') || raw.includes('qty') || raw.includes('dona') || raw.includes('count');
        if (isQty) {
          if (keys[`color_qty_${n}`] === undefined) keys[`color_qty_${n}`] = colIdx;
        } else {
          if (keys[`color_${n}`] === undefined) keys[`color_${n}`] = colIdx;
        }
      }
    }

    // Agar raqamsiz umumiy "Rang" yoki "Color" ustuni bo'lsa
    if ((raw === 'rang' || raw === 'color' || raw.includes('rangi') || raw.includes('tovarrangi')) && !/[0-9]/.test(raw)) {
      if (keys.color_1 === undefined) keys.color_1 = colIdx;
    }

    // Miqdor (umumiy) - agar alohida rang soni bo'lmasa
    const isColorNumbered = /[0-9]rang|rang[0-9]|[0-9]color|color[0-9]/.test(raw);
    if (!isColorNumbered && (raw.includes('miqdor') || raw.includes('son') || raw.includes('dona') || raw.includes('qty') || raw.includes('count') || raw.includes('quantity'))) {
      if (!keys.quantity) keys.quantity = colIdx;
    }
    // Joylashuv
    if (raw.includes('joy') || raw.includes('ombor') || raw.includes('dokon') || raw.includes('location')) {
      if (!keys.location) keys.location = colIdx;
    }
    // Partiya raqami
    if (raw.includes('partiya') || raw.includes('hujjat') || raw.includes('receipt') || raw.includes('batch')) {
      if (!keys.receiptNo && !raw.includes('kod') && !raw.includes('qr')) keys.receiptNo = colIdx;
    }
    // QR kod
    if (raw.includes('qr') || raw.includes('kod')) {
      if (!keys.qrCode) keys.qrCode = colIdx;
    }
    // Sana
    if (raw.includes('sana') || raw.includes('date') || raw.includes('qabul')) {
      if (!keys.date) keys.date = colIdx;
    }
  });

  return keys;
}

export default function InventoryExcelImportModal({
  open,
  onClose,
  branchId,
  locations = [],
  rate: propRate,
  toast,
  onImported,
}) {
  const latestRate = useExchangeRate();
  const [exchangeRate, setExchangeRate] = useState(Number(propRate) || Number(latestRate) || 11900);

  // Modal ochilganda eng oxirgi kunlik dollar kursini bazadan yangilab olamiz
  useEffect(() => {
    if (open) {
      getLatestExchangeRate('USD', 'UZS').then(r => {
        const num = Number(r);
        if (num > 0) setExchangeRate(num);
      }).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (propRate && Number(propRate) > 0) setExchangeRate(Number(propRate));
    else if (latestRate && Number(latestRate) > 0) setExchangeRate(Number(latestRate));
  }, [propRate, latestRate]);

  const rate = exchangeRate || Number(propRate) || Number(latestRate) || 11900;
  const fileInputRef = useRef(null);

  // Steps: 'select_type' -> 'upload_file' -> 'preview' -> 'importing' -> 'success'
  const [step, setStep] = useState('select_type');
  const [importMode, setImportMode] = useState('inventory'); // 'inventory' | 'batch'
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [defaultLocationId, setDefaultLocationId] = useState('');
  const [suppliers, setSuppliers] = useState([]);

  // File & parsed data
  const [fileName, setFileName] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsedRows, setParsedRows] = useState([]);
  const [existingProducts, setExistingProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);

  // Import execution state
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, text: '' });
  const [importResult, setImportResult] = useState(null);

  // Bulk QR printing state for all imported items
  const [labels, setLabels] = useState([]);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [bluetoothModalOpen, setBluetoothModalOpen] = useState(false);
  const [preferredPrinter, setPreferredPrinter] = useState('detonger');
  const [printPending, setPrintPending] = useState(false);

  // Initialize defaults
  useEffect(() => {
    if (open && locations.length > 0 && !defaultLocationId) {
      const preferred = locations.find(l => l.type === 'store') || locations[0];
      setDefaultLocationId(preferred.id);
    }
  }, [open, locations, defaultLocationId]);

  // Load suppliers, products, categories, brands for matching
  useEffect(() => {
    if (!open) return;
    const client = getBrowserClient();
    Promise.all([
      client.from('suppliers').select('id, name').eq('is_active', true).order('name'),
      client.from('categories').select('id, name, slug').eq('is_active', true),
      client.from('brands').select('id, name, slug').eq('is_active', true),
      client.from('products').select('id, name, sku, category_id, brand_id, cost_price, retail_price, wholesale_price, minimum_sale_price').neq('status', 'archived'),
    ]).then(([{ data: supData }, { data: catData }, { data: brandData }, { data: prodData }]) => {
      setSuppliers(supData || []);
      setCategories(catData || []);
      setBrands(brandData || []);
      setExistingProducts(prodData || []);
    }).catch(() => {});
  }, [open]);

  // Reset modal on close/open
  useEffect(() => {
    if (open) {
      setStep('select_type');
      setFileName('');
      setParsedRows([]);
      setParseError('');
      setImporting(false);
      setImportResult(null);
      setLabels([]);
      setLoadingLabels(false);
      setBluetoothModalOpen(false);
      setPrintPending(false);
    }
  }, [open]);

  // Download pre-formatted sample Excel template
  const handleDownloadTemplate = async () => {
    try {
      const ExcelJS = await getExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Texnobazar';
      wb.created = new Date();

      const ws = wb.addWorksheet('Inventarizatsiya shabloni', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      ws.columns = [
        { header: '№', key: 'idx', width: 6 },
        { header: 'Mahsulot nomi', key: 'product_name', width: 38 },
        { header: 'Mahsulot kategoriyasi', key: 'category_name', width: 26 },
        { header: 'Mahsulot brendi', key: 'brand_name', width: 18 },
        { header: 'Tovarlar izohi (ixtiyoriy)', key: 'description', width: 30 },
        { header: 'Tan narxi (UZS)', key: 'unit_cost_uzs', width: 20 },
        { header: 'Tan narxi (USD)', key: 'unit_cost_usd', width: 18 },
        { header: 'Sotish narxi (UZS)', key: 'retail_price_uzs', width: 20 },
        { header: 'Sotish narxi (USD)', key: 'retail_price_usd', width: 18 },
        { header: 'Ulgurji narxi (UZS)', key: 'wholesale_price_uzs', width: 20 },
        { header: 'Ulgurji narxi (USD)', key: 'wholesale_price_usd', width: 18 },
        { header: 'Minimal sotish narxi (UZS)', key: 'minimum_sale_price_uzs', width: 24 },
        { header: 'Minimal sotish narxi (USD)', key: 'minimum_sale_price_usd', width: 22 },
        { header: 'Valyuta (USD yoki UZS)', key: 'currency', width: 22 },
        { header: '1-rang (nomi)', key: 'color_1', width: 16 },
        { header: '1-rang soni', key: 'color_qty_1', width: 14 },
        { header: '2-rang (nomi)', key: 'color_2', width: 16 },
        { header: '2-rang soni', key: 'color_qty_2', width: 14 },
        { header: '3-rang (nomi)', key: 'color_3', width: 16 },
        { header: '3-rang soni', key: 'color_qty_3', width: 14 },
        { header: '4-rang (nomi)', key: 'color_4', width: 16 },
        { header: '4-rang soni', key: 'color_qty_4', width: 14 },
        { header: '5-rang (nomi)', key: 'color_5', width: 16 },
        { header: '5-rang soni', key: 'color_qty_5', width: 14 },
        { header: 'Jami miqdori (soni)', key: 'quantity', width: 18 },
        { header: 'Joylashuv', key: 'location_name', width: 24 },
        { header: 'Partiya raqami (ixtiyoriy)', key: 'receipt_no', width: 26 },
        { header: 'Partiya umumiy kodi (ixtiyoriy)', key: 'qr_code', width: 26 },
      ];

      const headerRow = ws.getRow(1);
      headerRow.height = 32;
      headerRow.eachCell(cell => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF0F172A' },
        };
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      });

      // Sample rows
      const sampleStoreName = locations.find(l => l.type === 'store')?.name || 'Asosiy do‘kon';
      const sampleWhName = locations.find(l => l.type === 'warehouse')?.name || 'Asosiy ombor';

      const demoData = [
        {
          idx: 1,
          product_name: 'iPhone 15 Pro 128GB',
          category_name: 'Smartfonlar',
          brand_name: 'Apple',
          description: 'Original displey, 100% batareya holati, quti va aksessuarlari bilan',
          unit_cost_uzs: 10880000,
          unit_cost_usd: 850,
          retail_price_uzs: 13056000,
          retail_price_usd: 1020,
          wholesale_price_uzs: 11776000,
          wholesale_price_usd: 920,
          minimum_sale_price_uzs: 12288000,
          minimum_sale_price_usd: 960,
          currency: 'USD',
          color_1: 'Blue Titanium',
          color_qty_1: 2,
          color_2: 'Natural Titanium',
          color_qty_2: 1,
          color_3: '',
          color_qty_3: '',
          color_4: '',
          color_qty_4: '',
          color_5: '',
          color_qty_5: '',
          quantity: 3,
          location_name: `${sampleStoreName} (Do‘kon)`,
          receipt_no: '',
          qr_code: '',
        },
        {
          idx: 2,
          product_name: 'Artel changyutgich VCC 0220',
          category_name: 'Changyutgichlar',
          brand_name: 'Artel',
          description: 'Kuchli so‘rish quvvatiga ega tejamkor changyutgich',
          unit_cost_uzs: 640000,
          unit_cost_usd: 50,
          retail_price_uzs: 832000,
          retail_price_usd: 65,
          wholesale_price_uzs: 704000,
          wholesale_price_usd: 55,
          minimum_sale_price_uzs: 742400,
          minimum_sale_price_usd: 58,
          currency: 'UZS',
          color_1: 'Qizil',
          color_qty_1: 1,
          color_2: 'Qora',
          color_qty_2: 2,
          color_3: '',
          color_qty_3: '',
          color_4: '',
          color_qty_4: '',
          color_5: '',
          color_qty_5: '',
          quantity: 3,
          location_name: `${sampleStoreName} (Do‘kon)`,
          receipt_no: '',
          qr_code: '',
        },
        {
          idx: 3,
          product_name: 'Gaz plita Vesta E6311',
          category_name: 'Plitalar',
          brand_name: 'Vesta',
          description: 'Gaz-kontrol va elektr o‘t oldirgichli sifatli gaz plita',
          unit_cost_uzs: 1800000,
          unit_cost_usd: 140,
          retail_price_uzs: 2300000,
          retail_price_usd: 180,
          wholesale_price_uzs: 2000000,
          wholesale_price_usd: 156,
          minimum_sale_price_uzs: 2100000,
          minimum_sale_price_usd: 164,
          currency: 'USD',
          color_1: 'Oq',
          color_qty_1: 2,
          color_2: 'Qora',
          color_qty_2: 2,
          color_3: 'Jigarrang',
          color_qty_3: 1,
          color_4: '',
          color_qty_4: '',
          color_5: '',
          color_qty_5: '',
          quantity: 5,
          location_name: `${sampleWhName} (Ombor)`,
          receipt_no: '',
          qr_code: '',
        },
      ];

      demoData.forEach((row, rIdx) => {
        const added = ws.addRow(row);
        added.height = 22;
        added.eachCell((cell, colNum) => {
          cell.font = { name: 'Calibri', size: 10 };
          if (colNum === 5) {
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, italic: true };
          } else if (colNum === 6 || colNum === 8 || colNum === 10 || colNum === 12) {
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
          } else if (colNum === 7 || colNum === 9 || colNum === 11 || colNum === 13) {
            cell.numFmt = '$#,##0.00';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF0369A1' } };
          } else if (colNum === 14) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: row.currency === 'USD' ? 'FF0284C7' : 'FF16A34A' } };
          } else if (colNum === 15 || colNum === 17 || colNum === 19 || colNum === 21 || colNum === 23) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, bold: true };
          } else if (colNum === 16 || colNum === 18 || colNum === 20 || colNum === 22 || colNum === 24) {
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0369A1' } };
          } else if (colNum === 25 || colNum === 1) {
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF16A34A' } };
          }
        });
      });

      const buffer = await wb.xlsx.writeBuffer();
      const u8 = buffer instanceof Uint8Array
        ? new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
        : new Uint8Array(buffer);
      const blob = new Blob([u8], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const fileName = importMode === 'inventory' ? 'inventarizatsiya_shablon.xlsx' : 'partiya_kirim_shablon.xlsx';
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = fileName;
      a.setAttribute('download', fileName);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => {
        try {
          window.URL.revokeObjectURL(url);
        } catch {}
      }, 30000);
      toast?.('Namunaviy Excel shabloni (.xlsx) muvaffaqiyatli yuklab olindi');
    } catch (e) {
      alert('Shablonni yuklab bo‘lmadi: ' + (e?.message || e));
    }
  };

  // Parse uploaded Excel file
  const handleFileUpload = async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setFileLoading(true);
    setParseError('');

    try {
      let activeRate = exchangeRate || rate || 11900;
      try {
        const liveR = await getLatestExchangeRate('USD', 'UZS');
        if (Number(liveR) > 0) {
          activeRate = Number(liveR);
          setExchangeRate(activeRate);
        }
      } catch {}

      const ExcelJS = await getExcelJS();
      const buffer = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);

      const ws = wb.worksheets[0];
      if (!ws) throw new Error('Excel faylida varaq topilmadi');

      // Find header row (usually row 1, or check first 5 rows)
      let headerRowNumber = 1;
      let headerValues = [];
      for (let r = 1; r <= 5; r++) {
        const rowVals = [];
        const row = ws.getRow(r);
        row.eachCell((cell, colNumber) => {
          rowVals[colNumber] = String(cell.value || '').trim();
        });
        const matched = matchColumnKeys(rowVals);
        if (matched.name !== undefined) {
          headerRowNumber = r;
          headerValues = rowVals;
          break;
        }
      }

      const keys = matchColumnKeys(headerValues);
      if (keys.name === undefined) {
        throw new Error('Excel faylida "Mahsulot nomi" ustuni topilmadi. Iltimos shablondan foydalaning.');
      }

      const rows = [];
      const totalRowCount = ws.rowCount;

      for (let r = headerRowNumber + 1; r <= totalRowCount; r++) {
        const row = ws.getRow(r);
        const rawName = String(row.getCell(keys.name).value || '').trim();
        if (!rawName || rawName === 'JAMI' || rawName === 'ИТОГО' || rawName === 'TOTAL') continue;

        // Mahsulot nomidan qavs ichidagi rangni ajratish (agar bo'lsa)
        let name = rawName;
        let bracketColor = '';
        const colorMatch = rawName.match(/^(.*?)(?:\s*\(([^()]+)\)\s*)$/);
        if (colorMatch) {
          name = colorMatch[1].trim();
          bracketColor = colorMatch[2].trim();
        }

        // 1-rang, 2-rang, ..., 10-rang ustunlaridan ranglar va ularning miqdorlarini o'qish
        const itemColors = [];
        for (let n = 1; n <= 10; n++) {
          const colorKey = keys[`color_${n}`];
          if (colorKey !== undefined) {
            const cName = String(row.getCell(colorKey).value || '').trim();
            if (cName) {
              const qtyKey = keys[`color_qty_${n}`];
              const cQtyRaw = qtyKey !== undefined ? parseNumber(row.getCell(qtyKey).value) : 0;
              const cQty = Math.max(0, Math.round(cQtyRaw));
              itemColors.push({
                name: cName,
                quantity: cQty,
              });
            }
          }
        }

        // Agar qavs ichida rang bo'lsa va ustunlarda rang kiritilmagan bo'lsa: masalan "Artel (Qizil)"
        if (itemColors.length === 0 && bracketColor) {
          itemColors.push({
            name: bracketColor,
            quantity: 0,
          });
        }

        // Umumiy "Jami miqdori (soni)" ustunidagi qiymat
        const rawTotalQty = keys.quantity !== undefined ? Math.max(0, Math.round(parseNumber(row.getCell(keys.quantity).value))) : 0;

        // Har bir rang sonini tekshirish va to'ldirish
        let sumColorQty = 0;
        itemColors.forEach(c => {
          sumColorQty += (c.quantity || 0);
        });

        // Agar ranglar bor bo'lsa, lekin ularning soni yozilmagan bo'lsa (0 bo'lsa):
        if (itemColors.length > 0 && sumColorQty === 0) {
          if (rawTotalQty > 0) {
            if (itemColors.length === 1) {
              itemColors[0].quantity = rawTotalQty;
              sumColorQty = rawTotalQty;
            } else {
              itemColors.forEach(c => { c.quantity = 1; });
              sumColorQty = itemColors.length;
            }
          } else {
            itemColors.forEach(c => { c.quantity = 1; });
            sumColorQty = itemColors.length;
          }
        } else if (itemColors.length > 0) {
          // Ba'zi ranglarning soni 0 bo'lib qolgan bo'lsa, ularga 1 ta qo'yamiz
          itemColors.forEach(c => {
            if (!c.quantity || c.quantity <= 0) c.quantity = 1;
          });
          sumColorQty = itemColors.reduce((sum, c) => sum + (c.quantity || 0), 0);
        }

        // Jami tovar soni: agar ranglar mavjud bo'lsa, barcha ranglar sonining YIG'INDISI bo'ladi
        // Masalan: Artel changyutgich: qizil 1 ta, qora 2 ta => jami = 3 ta
        const finalQty = itemColors.length > 0 ? sumColorQty : Math.max(1, rawTotalQty || 1);
        const combinedColorName = itemColors.map(c => c.name).join(', ') || color || '';

        const categoryName = keys.category !== undefined ? String(row.getCell(keys.category).value || '').trim() : '';
        const brandName = keys.brand !== undefined ? String(row.getCell(keys.brand).value || '').trim() : '';
        const description = keys.description !== undefined ? String(row.getCell(keys.description).value || '').trim() : '';
        const locName = keys.location !== undefined ? String(row.getCell(keys.location).value || '').trim() : '';
        const receiptNo = keys.receiptNo !== undefined ? String(row.getCell(keys.receiptNo).value || '').trim() : '';
        const qrCode = keys.qrCode !== undefined ? String(row.getCell(keys.qrCode).value || '').trim() : '';

        // Match location
        let matchedLocationId = defaultLocationId;
        if (locName) {
          const lowerLoc = locName.toLowerCase();
          const found = locations.find(l => {
            const lName = l.name.toLowerCase();
            return lowerLoc.includes(lName) || lName.includes(lowerLoc);
          });
          if (found) {
            matchedLocationId = found.id;
          } else if (lowerLoc.includes('ombor') || lowerLoc.includes('warehouse')) {
            const wh = locations.find(l => l.type === 'warehouse');
            if (wh) matchedLocationId = wh.id;
          } else if (lowerLoc.includes('do‘kon') || lowerLoc.includes('dôkon') || lowerLoc.includes('do`kon') || lowerLoc.includes('dokon') || lowerLoc.includes('store')) {
            const st = locations.find(l => l.type === 'store');
            if (st) matchedLocationId = st.id;
          }
        }

        // Valyuta ustunini o'qish (agar Excelda alohida Valyuta katakchasi bo'lsa)
        let explicitCurrency = '';
        if (keys.currency !== undefined) {
          const rawCurr = String(row.getCell(keys.currency).value || '').trim().toUpperCase();
          if (rawCurr.includes('USD') || rawCurr.includes('$')) explicitCurrency = 'USD';
          else if (rawCurr.includes('UZS') || rawCurr.includes('SO') || rawCurr.includes('SUM')) explicitCurrency = 'UZS';
        }

        // Narx ustunlarini UZS va USD dan alohida o'qish
        const rawCostUzs = keys.costUzs !== undefined ? parseNumber(row.getCell(keys.costUzs).value) : 0;
        const rawCostUsd = keys.costUsd !== undefined ? parseNumber(row.getCell(keys.costUsd).value) : 0;
        const rawCostGeneric = keys.cost !== undefined ? parseNumber(row.getCell(keys.cost).value) : 0;

        const rawRetailUzs = keys.retailUzs !== undefined ? parseNumber(row.getCell(keys.retailUzs).value) : 0;
        const rawRetailUsd = keys.retailUsd !== undefined ? parseNumber(row.getCell(keys.retailUsd).value) : 0;
        const rawRetailGeneric = keys.retail !== undefined ? parseNumber(row.getCell(keys.retail).value) : 0;

        const rawWholesaleUzs = keys.wholesaleUzs !== undefined ? parseNumber(row.getCell(keys.wholesaleUzs).value) : 0;
        const rawWholesaleUsd = keys.wholesaleUsd !== undefined ? parseNumber(row.getCell(keys.wholesaleUsd).value) : 0;
        const rawWholesaleGeneric = keys.wholesale !== undefined ? parseNumber(row.getCell(keys.wholesale).value) : 0;

        const rawMinUzs = keys.minPriceUzs !== undefined ? parseNumber(row.getCell(keys.minPriceUzs).value) : 0;
        const rawMinUsd = keys.minPriceUsd !== undefined ? parseNumber(row.getCell(keys.minPriceUsd).value) : 0;
        const rawMinGeneric = keys.minPrice !== undefined ? parseNumber(row.getCell(keys.minPrice).value) : 0;

        // Tovar valyutasini aniqlash:
        // Agar tovar USD da kelgan bo'lsa (USD ustunlari to'ldirilgan yoki Valyuta=USD), valyuta USD bo'ladi.
        // Agar UZS da kelgan bo'lsa (UZS ustunlari to'ldirilgan yoki Valyuta=UZS), valyuta UZS bo'ladi.
        let rowCurrency = explicitCurrency;
        if (!rowCurrency) {
          if (rawCostUsd > 0 || rawRetailUsd > 0 || rawWholesaleUsd > 0 || rawMinUsd > 0) {
            rowCurrency = 'USD';
          } else if (rawCostUzs > 0 || rawRetailUzs > 0 || rawWholesaleUzs > 0 || rawMinUzs > 0) {
            rowCurrency = 'UZS';
          } else if (rawCostGeneric > 0) {
            rowCurrency = rawCostGeneric >= 20000 ? 'UZS' : 'USD';
          } else if (rawRetailGeneric > 0) {
            rowCurrency = rawRetailGeneric >= 20000 ? 'UZS' : 'USD';
          } else {
            rowCurrency = 'USD';
          }
        }

        // Tannarxni UZS va USD formatlarida hisoblash
        let costUzs = rawCostUzs;
        let costUsd = rawCostUsd;
        if (costUsd > 0 && costUzs <= 0) {
          costUzs = Math.round(costUsd * activeRate);
        } else if (costUzs > 0 && costUsd <= 0) {
          costUsd = Number((costUzs / activeRate).toFixed(2));
        } else if (costUzs <= 0 && costUsd <= 0 && rawCostGeneric > 0) {
          if (rawCostGeneric >= 20000) {
            costUzs = rawCostGeneric;
            costUsd = Number((rawCostGeneric / activeRate).toFixed(2));
          } else {
            costUsd = rawCostGeneric;
            costUzs = Math.round(rawCostGeneric * activeRate);
          }
        }

        // Sotish narxini UZS va USD formatlarida hisoblash
        let retailUzs = rawRetailUzs;
        let retailUsd = rawRetailUsd;
        if (retailUsd > 0 && retailUzs <= 0) {
          retailUzs = Math.round(retailUsd * activeRate);
        } else if (retailUzs > 0 && retailUsd <= 0) {
          retailUsd = Number((retailUzs / activeRate).toFixed(2));
        } else if (retailUzs <= 0 && retailUsd <= 0 && rawRetailGeneric > 0) {
          if (rawRetailGeneric >= 20000) {
            retailUzs = rawRetailGeneric;
            retailUsd = Number((rawRetailGeneric / activeRate).toFixed(2));
          } else {
            retailUsd = rawRetailGeneric;
            retailUzs = Math.round(rawRetailGeneric * activeRate);
          }
        } else if (retailUzs <= 0 && retailUsd <= 0) {
          if (costUzs > 0) {
            retailUzs = Math.round(costUzs * 1.25);
            retailUsd = Number((retailUzs / activeRate).toFixed(2));
          } else if (costUsd > 0) {
            retailUsd = Number((costUsd * 1.25).toFixed(2));
            retailUzs = Math.round(retailUsd * activeRate);
          }
        }

        // Ulgurji narxni UZS va USD formatlarida hisoblash
        let wholesaleUzs = rawWholesaleUzs;
        let wholesaleUsd = rawWholesaleUsd;
        if (wholesaleUsd > 0 && wholesaleUzs <= 0) {
          wholesaleUzs = Math.round(wholesaleUsd * activeRate);
        } else if (wholesaleUzs > 0 && wholesaleUsd <= 0) {
          wholesaleUsd = Number((wholesaleUzs / activeRate).toFixed(2));
        } else if (wholesaleUzs <= 0 && wholesaleUsd <= 0 && rawWholesaleGeneric > 0) {
          if (rawWholesaleGeneric >= 20000) {
            wholesaleUzs = rawWholesaleGeneric;
            wholesaleUsd = Number((rawWholesaleGeneric / activeRate).toFixed(2));
          } else {
            wholesaleUsd = rawWholesaleGeneric;
            wholesaleUzs = Math.round(rawWholesaleGeneric * activeRate);
          }
        } else if (wholesaleUzs <= 0 && wholesaleUsd <= 0) {
          if (costUzs > 0) {
            wholesaleUzs = Math.round(costUzs * 1.1);
            wholesaleUsd = Number((wholesaleUzs / activeRate).toFixed(2));
          } else if (costUsd > 0) {
            wholesaleUsd = Number((costUsd * 1.1).toFixed(2));
            wholesaleUzs = Math.round(wholesaleUsd * activeRate);
          }
        }

        // Minimal sotish narxini UZS va USD formatlarida hisoblash
        let minUzs = rawMinUzs;
        let minUsd = rawMinUsd;
        if (minUsd > 0 && minUzs <= 0) {
          minUzs = Math.round(minUsd * activeRate);
        } else if (minUzs > 0 && minUsd <= 0) {
          minUsd = Number((minUzs / activeRate).toFixed(2));
        } else if (minUzs <= 0 && minUsd <= 0 && rawMinGeneric > 0) {
          if (rawMinGeneric >= 20000) {
            minUzs = rawMinGeneric;
            minUsd = Number((rawMinGeneric / activeRate).toFixed(2));
          } else {
            minUsd = rawMinGeneric;
            minUzs = Math.round(rawMinGeneric * activeRate);
          }
        } else if (minUzs <= 0 && minUsd <= 0) {
          minUzs = costUzs;
          minUsd = costUsd;
        }

        rows.push({
          rowIdx: r,
          rawName,
          name,
          color: combinedColorName,
          colors: itemColors,
          categoryName,
          brandName,
          description,
          currency: rowCurrency,
          unitCost: rowCurrency === 'USD' ? costUsd : costUzs,
          unitCostUzs: costUzs,
          unitCostUsd: costUsd,
          retailPrice: rowCurrency === 'USD' ? retailUsd : retailUzs,
          retailPriceUzs: retailUzs,
          retailPriceUsd: retailUsd,
          wholesalePrice: rowCurrency === 'USD' ? wholesaleUsd : wholesaleUzs,
          wholesalePriceUzs: wholesaleUzs,
          wholesalePriceUsd: wholesaleUsd,
          minimumSalePrice: rowCurrency === 'USD' ? minUsd : minUzs,
          minimumSalePriceUzs: minUzs,
          minimumSalePriceUsd: minUsd,
          quantity: finalQty,
          locationId: matchedLocationId,
          locationName: locations.find(l => l.id === matchedLocationId)?.name || locName || 'Asosiy joylashuv',
          receiptNo,
          qrCode,
        });
      }

      if (!rows.length) {
        throw new Error('Faylda import qilish uchun tovar qatorlari topilmadi.');
      }

      setParsedRows(rows);
      setStep('preview');
    } catch (err) {
      setParseError(err.message || 'Excel faylni o‘qishda xatolik yuz berdi');
    } finally {
      setFileLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Group rows by target receipt & location & currency
  const receiptGroups = useMemo(() => {
    if (!parsedRows.length) return [];
    const groups = new Map();

    const timestampPrefix = () => {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    };

    const autoPrefix = importMode === 'inventory' ? 'INV' : 'PT';

    parsedRows.forEach(row => {
      const loc = locations.find(l => l.id === row.locationId);
      const locSuffix = loc?.type === 'warehouse' ? 'OMBOR' : 'DOKON';

      // Valyuta va joylashuv bo'yicha alohida guruhlash: USD tovarlar USD partiyasiga, UZS tovarlar UZS partiyasiga
      let groupKey = '';
      let groupReceiptNo = '';
      if (row.receiptNo) {
        groupKey = `${row.receiptNo}___${row.locationId}___${row.currency}`;
        groupReceiptNo = row.receiptNo;
      } else {
        groupKey = `${autoPrefix}-${timestampPrefix()}-${locSuffix}-${row.currency}`;
        groupReceiptNo = groupKey;
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          receiptNo: groupReceiptNo,
          locationId: row.locationId,
          locationName: row.locationName,
          currency: row.currency,
          items: [],
          totalUnits: 0,
          totalCostUzs: 0,
          totalCostUsd: 0,
          totalRetailUzs: 0,
          totalRetailUsd: 0,
        });
      }

      const g = groups.get(groupKey);
      g.items.push(row);
      g.totalUnits += row.quantity;
      g.totalCostUzs += row.unitCostUzs * row.quantity;
      g.totalCostUsd += row.unitCostUsd * row.quantity;
      g.totalRetailUzs += row.retailPriceUzs * row.quantity;
      g.totalRetailUsd += row.retailPriceUsd * row.quantity;
    });

    return Array.from(groups.values());
  }, [parsedRows, importMode, locations]);

  // Aggregate preview metrics
  const previewTotals = useMemo(() => {
    const totalLines = parsedRows.length;
    const totalUnits = parsedRows.reduce((sum, r) => sum + r.quantity, 0);
    const totalCostUzs = parsedRows.reduce((sum, r) => sum + r.unitCostUzs * r.quantity, 0);
    const totalCostUsd = parsedRows.reduce((sum, r) => sum + r.unitCostUsd * r.quantity, 0);
    const totalRetailUzs = parsedRows.reduce((sum, r) => sum + r.retailPriceUzs * r.quantity, 0);
    const totalRetailUsd = parsedRows.reduce((sum, r) => sum + r.retailPriceUsd * r.quantity, 0);
    const usdBatches = receiptGroups.filter(g => g.currency === 'USD').length;
    const uzsBatches = receiptGroups.filter(g => g.currency === 'UZS').length;
    return {
      totalLines,
      totalUnits,
      totalCostUzs,
      totalCostUsd,
      totalRetailUzs,
      totalRetailUsd,
      batchesCount: receiptGroups.length,
      usdBatches,
      uzsBatches,
    };
  }, [parsedRows, receiptGroups]);

  // Execute import process
  const handleExecuteImport = async () => {
    if (!receiptGroups.length || importing) return;
    setImporting(true);
    setStep('importing');
    setImportProgress({ current: 0, total: receiptGroups.length, text: 'Boshlanmoqda...' });

    const client = getBrowserClient();

    try {
      let activeRate = exchangeRate || rate || 11900;
      try {
        const liveR = await getLatestExchangeRate('USD', 'UZS');
        if (Number(liveR) > 0) activeRate = Number(liveR);
      } catch {}

      // 1. Resolve or create categories & brands in bulk/cache
      const catMap = new Map(categories.map(c => [c.name.trim().toLowerCase(), c.id]));
      const brandMap = new Map(brands.map(b => [b.name.trim().toLowerCase(), b.id]));

      // Har bir qator uchun katalogda alohida YANGI tovar kartasi yaratiladi
      // (Foydalanuvchi talabi: hatto ushbu nomdagi tovar mavjud bo'lsa ham, har bir import qilingan qatordan mustaqil yangi tovar yaratiladi)
      let prodIndex = 0;
      for (const row of parsedRows) {
        prodIndex++;
        setImportProgress({
          current: prodIndex,
          total: parsedRows.length,
          text: `Yangi tovar kartasi yaratilmoqda (${prodIndex}/${parsedRows.length}): "${row.name}"...`,
        });

        // Resolve category
        let categoryId = null;
        if (row.categoryName) {
          const cKey = row.categoryName.trim().toLowerCase();
          if (catMap.has(cKey)) {
            categoryId = catMap.get(cKey);
          } else {
            try {
              const { data: newCat } = await client
                .from('categories')
                .insert({ name: row.categoryName.trim(), slug: slugify(row.categoryName), is_active: true })
                .select('id, name')
                .single();
              if (newCat) {
                categoryId = newCat.id;
                catMap.set(cKey, newCat.id);
              }
            } catch {}
          }
        }

        // Resolve brand
        let brandId = null;
        if (row.brandName) {
          const bKey = row.brandName.trim().toLowerCase();
          if (brandMap.has(bKey)) {
            brandId = brandMap.get(bKey);
          } else {
            try {
              const { data: newBrand } = await client
                .from('brands')
                .insert({ name: row.brandName.trim(), slug: slugify(row.brandName), is_active: true })
                .select('id, name')
                .single();
              if (newBrand) {
                brandId = newBrand.id;
                brandMap.set(bKey, newBrand.id);
              }
            } catch {}
          }
        }

        // Create a brand new product card in catalog
        const uniqueTimestamp = Date.now().toString(36).toUpperCase();
        const uniqueRandom = Math.random().toString(36).slice(2, 6).toUpperCase();
        const sku = `TB-${uniqueTimestamp}-${uniqueRandom}`;
        const slug = `${slugify(row.name, 'prod')}-${uniqueTimestamp.toLowerCase()}-${uniqueRandom.toLowerCase()}`;

        const { data: createdProd, error: pErr } = await client
          .from('products')
          .insert({
            name: row.name.trim(),
            sku,
            slug,
            category_id: categoryId,
            brand_id: brandId,
            description: row.description ? String(row.description).trim() : null,
            cost_price: row.unitCostUzs,
            cost_price_usd: row.unitCostUsd,
            retail_price: row.retailPriceUzs,
            retail_price_usd: row.retailPriceUsd,
            wholesale_price: row.wholesalePriceUzs || null,
            wholesale_price_usd: row.wholesalePriceUsd || null,
            minimum_sale_price: row.minimumSalePriceUzs || null,
            minimum_sale_price_usd: row.minimumSalePriceUsd || null,
            currency: row.currency,
            status: 'active',
            is_published: true,
            track_individual_units: true,
            tax_rate: 0,
          })
          .select('id, name, sku')
          .single();

        if (pErr) throw pErr;
        row.productId = createdProd.id;

        // Agar tovar ranglari bo'lsa, har bir rang uchun alohida variant yaratiladi
        if (row.colors && row.colors.length > 0) {
          for (const c of row.colors) {
            try {
              const { data: newVar } = await client
                .from('product_variants')
                .insert({
                  product_id: createdProd.id,
                  color_name: c.name.trim(),
                  retail_price: row.retailPriceUzs,
                  retail_price_usd: row.retailPriceUsd,
                  wholesale_price: row.wholesalePriceUzs,
                  wholesale_price_usd: row.wholesalePriceUsd,
                  minimum_sale_price: row.minimumSalePriceUzs,
                  minimum_sale_price_usd: row.minimumSalePriceUsd,
                  cost_price: row.unitCostUzs,
                  cost_price_usd: row.unitCostUsd,
                  is_active: true,
                })
                .select('id')
                .single();
              c.variantId = newVar?.id || null;
            } catch (vErr) {
              console.warn('Variant yaratishda ogohlantirish:', vErr);
            }
          }
        } else if (row.color) {
          try {
            const { data: newVar } = await client
              .from('product_variants')
              .insert({
                product_id: createdProd.id,
                color_name: row.color.trim(),
                retail_price: row.retailPriceUzs,
                retail_price_usd: row.retailPriceUsd,
                wholesale_price: row.wholesalePriceUzs,
                wholesale_price_usd: row.wholesalePriceUsd,
                minimum_sale_price: row.minimumSalePriceUzs,
                minimum_sale_price_usd: row.minimumSalePriceUsd,
                cost_price: row.unitCostUzs,
                cost_price_usd: row.unitCostUsd,
                is_active: true,
              })
              .select('id')
              .single();
            row.variantId = newVar?.id || null;
          } catch (vErr) {
            console.warn('Variant yaratishda ogohlantirish:', vErr);
          }
        }
      }

      // 2. Process each receipt group via createStockReceipt RPC
      let groupIndex = 0;
      const createdReceipts = [];

      for (const group of receiptGroups) {
        groupIndex++;
        setImportProgress({
          current: groupIndex,
          total: receiptGroups.length,
          text: `Partiya saqlanmoqda (${groupIndex}/${receiptGroups.length}): "${group.receiptNo}" (${group.currency})...`,
        });

        // Har bir tovar va uning ranglari uchun alohida partiya qatorlari shakllantiriladi
        const payloadLines = [];
        for (const it of group.items) {
          if (it.colors && it.colors.length > 0) {
            for (const c of it.colors) {
              payloadLines.push({
                product_id: it.productId,
                variant_id: c.variantId || null,
                quantity: c.quantity || 1,
                unit_cost: it.currency === 'USD' ? it.unitCostUsd : it.unitCostUzs,
                unit_cost_usd: it.unitCostUsd,
                retail_price: it.currency === 'USD' ? it.retailPriceUsd : it.retailPriceUzs,
                retail_price_usd: it.retailPriceUsd,
                wholesale_price: it.currency === 'USD' ? it.wholesalePriceUsd : it.wholesalePriceUzs,
                wholesale_price_usd: it.wholesalePriceUsd || null,
                minimum_sale_price: it.currency === 'USD' ? it.minimumSalePriceUsd : it.minimumSalePriceUzs,
                minimum_sale_price_usd: it.minimumSalePriceUsd || null,
                serial_numbers: [],
              });
            }
          } else {
            payloadLines.push({
              product_id: it.productId,
              variant_id: it.variantId || null,
              quantity: it.quantity,
              unit_cost: it.currency === 'USD' ? it.unitCostUsd : it.unitCostUzs,
              unit_cost_usd: it.unitCostUsd,
              retail_price: it.currency === 'USD' ? it.retailPriceUsd : it.retailPriceUzs,
              retail_price_usd: it.retailPriceUsd,
              wholesale_price: it.currency === 'USD' ? it.wholesalePriceUsd : it.wholesalePriceUzs,
              wholesale_price_usd: it.wholesalePriceUsd || null,
              minimum_sale_price: it.currency === 'USD' ? it.minimumSalePriceUsd : it.minimumSalePriceUzs,
              minimum_sale_price_usd: it.minimumSalePriceUsd || null,
              serial_numbers: [],
            });
          }
        }

        const nowIso = new Date().toISOString();
        const header = {
          branch_id: branchId,
          receiving_location_id: group.locationId,
          supplier_id: importMode === 'inventory' ? null : (selectedSupplierId || null),
          receipt_no: group.receiptNo,
          received_at: nowIso,
          currency: group.currency,
          exchange_rate: activeRate,
          paid_amount: 0,
          payment_status: 'paid',
          notes: importMode === 'inventory'
            ? `Excel orqali import qilingan inventarizatsiya (${group.currency})`
            : `Excel orqali import qilingan partiya (${group.currency})`,
        };

        const res = await createStockReceipt(header, payloadLines, crypto.randomUUID());
        const newReceiptId = res?.receipt_id || res?.id;
        createdReceipts.push({
          receiptNo: group.receiptNo,
          locationName: group.locationName,
          currency: group.currency,
          itemsCount: group.items.length,
          unitsCount: group.totalUnits,
          receiptId: newReceiptId,
        });
      }

      setImportResult({
        createdReceipts,
        totalBatches: createdReceipts.length,
        totalUnits: previewTotals.totalUnits,
        totalLines: previewTotals.totalLines,
        productsCreatedCount: parsedRows.length,
      });

      setStep('success');
      toast?.(`${previewTotals.totalUnits} dona mahsulot muvaffaqiyatli qabul qilindi!`);
      onImported?.(createdReceipts);
    } catch (err) {
      alert('Import jarayonida xatolik yuz berdi:\n' + (err.message || err));
      setStep('preview');
    } finally {
      setImporting(false);
    }
  };

  // Barcha import qilingan tovarlar QR yorliqlarini shakllantirish
  const loadAllLabels = async () => {
    if (labels.length) return labels;
    setLoadingLabels(true);
    try {
      const allLabels = [];
      const receipts = importResult?.createdReceipts || [];

      for (const rec of receipts) {
        if (!rec.receiptId) continue;
        const [receiptData, qrLabelsRes] = await Promise.all([
          getStockReceipt(rec.receiptId).catch(() => null),
          listReceiptQrLabels(rec.receiptId, 1, 500).catch(() => ({ items: [] })),
        ]);

        const items = qrLabelsRes?.items || [];
        const groupQrMap = new Map();
        items.forEach(item => {
          const color = String(item.variant_color || item.price_label?.color || '').trim().toLowerCase();
          const lineKey = item.line_no || '0';
          const key = `${lineKey}___${item.product_name || ''}___${color}`;
          if (!groupQrMap.has(key) && item.qr_code) {
            groupQrMap.set(key, item.qr_code);
          }
        });

        const lines = receiptData?.lines || [];
        const receiptDate = receiptData?.received_at
          ? new Date(receiptData.received_at).toLocaleDateString('uz-UZ')
          : new Date().toLocaleDateString('uz-UZ');
        const receiptCurrency = rec.currency || receiptData?.currency || 'USD';

        const distinctLabels = lines.map(line => {
          const color = String(line.variant_color || '').trim().toLowerCase();
          const lineKey = line.line_no || line.id || '0';
          const key = `${lineKey}___${line.product_name || ''}___${color}`;
          const matchingItem = items.find(it =>
            (it.line_no && it.line_no === line.line_no) ||
            (it.product_id && it.product_id === line.product_id && (it.variant_id || null) === (line.variant_id || null)) ||
            (it.product_name === line.product_name && (it.variant_color || null) === (line.variant_color || null))
          );
          const canonicalQr = groupQrMap.get(key) || matchingItem?.qr_code || line.qr_code || '';
          const lineCostUsd = line.unit_cost_usd || matchingItem?.unit_cost_usd || matchingItem?.cost_usd || matchingItem?.price_label?.cost_usd || '';
          const lineCost = line.unit_cost || matchingItem?.unit_cost || '';
          const secretCost = formatSecretCostCode({
            cost: lineCost,
            costUsd: lineCostUsd,
            currency: receiptCurrency,
          });

          return {
            id: line.id,
            line_no: line.line_no,
            product_id: line.product_id,
            product_name: line.product_name,
            title: line.product_name || 'Mahsulot',
            variant_color: line.variant_color || '',
            color: line.variant_color || '',
            quantity: Number(line.quantity) || 1,
            code: canonicalQr,
            qr_code: canonicalQr,
            cost_usd: secretCost || lineCostUsd,
            costUsd: secretCost || lineCostUsd,
            cost: lineCost,
            currency: receiptCurrency,
            secret_cost: secretCost,
            date: receiptDate,
          };
        });

        const withQrImages = await Promise.all(
          distinctLabels.map(async item => {
            const costStr = item.secret_cost || formatSecretCostCode({
              cost: item.cost,
              costUsd: item.cost_usd,
              currency: item.currency || 'USD',
            });
            const costParam = costStr ? '?c=' + encodeURIComponent(costStr) : '';
            const url = (import.meta.env.VITE_STOREFRONT_URL || 'https://texnobazar-storefront.netlify.app') + '/qr/' + encodeURIComponent(item.qr_code) + costParam;
            return {
              ...item,
              cost_usd: costStr,
              costUsd: costStr,
              secret_cost: costStr,
              qrImage: await QRCode.toDataURL(url, { width: 480, margin: 2, errorCorrectionLevel: 'L' }),
            };
          })
        );

        allLabels.push(...withQrImages);
      }

      setLabels(allLabels);
      return allLabels;
    } catch (err) {
      console.error('Labels generation error:', err);
      alert('QR yorliqlarni yaratishda xatolik: ' + (err?.message || err));
      return [];
    } finally {
      setLoadingLabels(false);
    }
  };

  const openBluetoothPrint = async (printerType = 'detonger') => {
    setPreferredPrinter(printerType);
    try {
      localStorage.setItem('texnobazar_selected_thermal_printer', printerType);
    } catch {}
    let currentLabels = labels;
    if (!currentLabels.length) {
      currentLabels = await loadAllLabels();
    }
    if (currentLabels.length) {
      setBluetoothModalOpen(true);
    }
  };

  const handleClassicPrint = async () => {
    let currentLabels = labels;
    if (!currentLabels.length) {
      currentLabels = await loadAllLabels();
    }
    if (currentLabels.length) {
      setPrintPending(true);
    }
  };

  useEffect(() => {
    if (!printPending || !labels.length) return;
    const print = async () => {
      const escapeHtml = (str) => String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      const pagesHtml = labels.flatMap(x => {
        const count = Math.max(1, Number(x.quantity) || 1);
        const fullTitle = `${x.product_name || 'Mahsulot'}${x.variant_color ? ` (${x.variant_color})` : ''}`;
        const code = x.qr_code || '';
        const receiptDate = x.date || new Date().toLocaleDateString('uz-UZ');

        const singlePage = `
          <div class="qr-page">
            <div class="qr-img-wrap">
              <img class="qr-img" src="${x.qrImage}" alt="QR" />
            </div>
            <div class="qr-info">
              <div class="qr-title">${escapeHtml(fullTitle)}</div>
              <div class="qr-meta-clean">
                <span class="qr-meta-date-val">Sana: ${escapeHtml(receiptDate)}</span>
                <span class="qr-meta-code-val">${escapeHtml(code)}</span>
              </div>
            </div>
          </div>
        `;
        return Array(count).fill(singlePage);
      }).join('');

      try {
        const oldIframe = document.getElementById('qr-excel-import-print-iframe');
        if (oldIframe) oldIframe.remove();

        const iframe = document.createElement('iframe');
        iframe.id = 'qr-excel-import-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Barcha import qilingan QR yorliqlar</title>
  <style>
    @page { size: 40mm 30mm; margin: 0 !important; padding: 0 !important; }
    @media print {
      html, body { width: 40mm !important; margin: 0 !important; padding: 0 !important; background: #fff !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
    .qr-page { width: 40mm; height: 30mm; max-width: 40mm; max-height: 30mm; padding: 1.5mm 1.5mm 1mm 1.5mm; display: flex; flex-direction: row; align-items: center; justify-content: space-between; page-break-after: always; break-after: page; background: #fff; overflow: hidden; }
    .qr-img-wrap { width: 23mm; height: 23mm; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .qr-img { width: 23mm; height: 23mm; object-fit: contain; image-rendering: pixelated; }
    .qr-info { flex: 1; min-width: 0; height: 25mm; padding-left: 1.5mm; display: flex; flex-direction: column; justify-content: space-between; text-align: left; overflow: hidden; }
    .qr-title { font-size: 8pt; font-weight: 800; line-height: 1.15; color: #000; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; max-height: 11mm; }
    .qr-meta-clean { display: flex; flex-direction: column; gap: 0.8mm; margin-top: auto; padding-top: 1mm; border-top: 0.5pt dashed #666; }
    .qr-meta-date-val { font-size: 6.5pt; font-weight: 600; color: #222; }
    .qr-meta-code-val { font-size: 7pt; font-weight: 800; font-family: monospace; color: #000; }
  </style>
</head>
<body>
  ${pagesHtml}
</body>
</html>`);
        doc.close();

        iframe.contentWindow.focus();
        setTimeout(() => {
          iframe.contentWindow.print();
          setPrintPending(false);
        }, 500);
      } catch (err) {
        console.error('Print iframe error:', err);
        setPrintPending(false);
      }
    };
    print();
  }, [printPending, labels]);

  return (
    <>
    <Modal open={open} onClose={importing ? () => {} : onClose} wide title="Excel orqali import qilish">
      {step === 'select_type' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 0' }}>
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Qaysi turdagi kirimni import qilmoqchisiz?</h3>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
              Excel fayldagi tovarlar tizimga partiya yoki ichki inventarizatsiya sifatida kiritiladi.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
            {/* Inventarizatsiya Card */}
            <div
              onClick={() => setImportMode('inventory')}
              style={{
                border: importMode === 'inventory' ? '2px solid #7c3aed' : '1px solid var(--line)',
                background: importMode === 'inventory' ? '#f5f3ff' : '#fff',
                borderRadius: 14,
                padding: 18,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                gap: 14,
                alignItems: 'flex-start',
                position: 'relative',
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  background: importMode === 'inventory' ? '#7c3aed' : '#ede9fe',
                  color: importMode === 'inventory' ? '#fff' : '#7c3aed',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Boxes size={24} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <b style={{ fontSize: 16, color: importMode === 'inventory' ? '#5b21b6' : 'inherit' }}>
                    Inventarizatsiya
                  </b>
                  <Status type="purple">Ichki ro‘yxat</Status>
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: '#64748b', lineHeight: 1.4 }}>
                  Do‘kon yoki ombordagi mavjud tovarlar. Hujjat raqami avtomatik <b>INV-...</b> bo‘ladi, ta’minotchi talab qilinmaydi.
                </p>
              </div>
            </div>

            {/* Partiya Card */}
            <div
              onClick={() => setImportMode('batch')}
              style={{
                border: importMode === 'batch' ? '2px solid #0284c7' : '1px solid var(--line)',
                background: importMode === 'batch' ? '#f0f9ff' : '#fff',
                borderRadius: 14,
                padding: 18,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                gap: 14,
                alignItems: 'flex-start',
                position: 'relative',
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  background: importMode === 'batch' ? '#0284c7' : '#e0f2fe',
                  color: importMode === 'batch' ? '#fff' : '#0284c7',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <PackagePlus size={24} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <b style={{ fontSize: 16, color: importMode === 'batch' ? '#0369a1' : 'inherit' }}>
                    Yangi partiya (Kirim)
                  </b>
                  <Status type="blue">Yetkazib beruvchi</Status>
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: '#64748b', lineHeight: 1.4 }}>
                  Yetkazib beruvchidan yangi kelgan tovarlar. Hujjat raqami avtomatik <b>PT-...</b> bo‘ladi.
                </p>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            <label>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                Birlamchi qabul joylashuvi *
              </span>
              <select
                className="select"
                value={defaultLocationId}
                onChange={e => setDefaultLocationId(e.target.value)}
              >
                {locations.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name} {l.type === 'warehouse' ? '(Ombor)' : '(Do‘kon)'}
                  </option>
                ))}
              </select>
              <small style={{ color: 'var(--muted)', fontSize: 11, display: 'block', marginTop: 3 }}>
                Excelda joylashuv ko‘rsatilmagan tovarlar shu joyga kirim qilinadi.
              </small>
            </label>

            {importMode === 'batch' && (
              <label>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  Ta'minotchi (Ixtiyoriy)
                </span>
                <select
                  className="select"
                  value={selectedSupplierId}
                  onChange={e => setSelectedSupplierId(e.target.value)}
                >
                  <option value="">— Ta'minotchisiz / Noma'lum —</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div
            style={{
              padding: '12px 16px',
              background: '#f8fafc',
              border: '1px solid var(--line)',
              borderRadius: 12,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
            }}
          >
            <div>
              <b style={{ fontSize: 13, display: 'block' }}>Excel shablonidan foydalaning</b>
              <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                Ustunlar: №, Mahsulot nomi, Kategoriya, Brend, Tovarlar izohi (ixtiyoriy), Tan narx, Sotish narxi, Ulgurji, Minimal, Miqdori, Joylashuv
              </small>
            </div>
            <button
              type="button"
              className="btn btn-outline"
              style={{ fontSize: 12, padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={handleDownloadTemplate}
            >
              <Download size={14} /> Shablonni yuklab olish (.xlsx)
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
            <button type="button" className="btn" onClick={onClose}>
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => setStep('upload_file')}
            >
              Keyingi: Faylni tanlash <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {step === 'upload_file' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {importMode === 'inventory' ? 'Inventarizatsiya' : 'Partiya'} Excel faylini tanlang
              </h3>
              <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
                Kompyuter yoki mobil telefoningiz xotirasidan .xlsx faylni yuklang.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setStep('select_type')}
            >
              Ortga
            </button>
          </div>

          {parseError && (
            <div style={{ padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#b91c1c', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
              <AlertTriangle size={18} />
              <span>{parseError}</span>
            </div>
          )}

          {/* Upload Dropzone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: '2px dashed #0284c7',
              borderRadius: 16,
              padding: '40px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              background: '#f0f9ff',
              transition: 'background 0.2s',
            }}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".xlsx, .xls"
              style={{ display: 'none' }}
            />
            {fileLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <Loader2 size={36} color="#0284c7" className="btn-spinner" />
                <b style={{ color: '#0369a1' }}>Excel fayl o‘qilmoqda va tahlil qilinmoqda…</b>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#e0f2fe', color: '#0284c7', display: 'grid', placeItems: 'center' }}>
                  <UploadCloud size={34} />
                </div>
                <b style={{ fontSize: 16, color: '#0f172a' }}>Excel faylni tanlang yoki shu yerga tashlang</b>
                <span style={{ fontSize: 13, color: '#64748b' }}>Faqat .xlsx yoki .xls formatlari</span>
                <span style={{ marginTop: 6, fontSize: 12, color: '#0284c7', fontWeight: 600 }}>
                  📁 Qurilma xotirasidan tanlash
                </span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleDownloadTemplate}
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Download size={14} /> Shablon kerakmi? Yuklab olish
            </button>
            <button type="button" className="btn" onClick={() => setStep('select_type')}>
              Bekor qilish
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                Fayl tahlili: {fileName}
              </h3>
              <p style={{ margin: '3px 0 0', color: 'var(--muted)', fontSize: 12.5 }}>
                Tizimda <b>{previewTotals.batchesCount} ta</b> hujjat ochiladi ({previewTotals.usdBatches > 0 && <span style={{ color: '#0284c7' }}>{previewTotals.usdBatches} ta USD</span>}{previewTotals.usdBatches > 0 && previewTotals.uzsBatches > 0 && ', '}{previewTotals.uzsBatches > 0 && <span style={{ color: '#16a34a' }}>{previewTotals.uzsBatches} ta UZS</span>}), <b>{previewTotals.totalLines} ta</b> yangi tovar kartasi yaratiladi va <b>{previewTotals.totalUnits} dona</b> tovar qabul qilinadi.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setStep('upload_file')}
              >
                Boshqa fayl tanlash
              </button>
            </div>
          </div>

          {/* Metric cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
            <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
              <small style={{ color: 'var(--muted)', fontSize: 11, display: 'block' }}>Hujjatlar (Partiyalar)</small>
              <b style={{ fontSize: 18, color: '#0f172a' }}>{previewTotals.batchesCount} ta</b>
              <small style={{ display: 'block', fontSize: 10.5, color: '#64748b', marginTop: 2 }}>
                {previewTotals.usdBatches} USD · {previewTotals.uzsBatches} UZS
              </small>
            </div>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 12 }}>
              <small style={{ color: '#16a34a', fontSize: 11, display: 'block' }}>Yangi tovar kartalari</small>
              <b style={{ fontSize: 18, color: '#15803d' }}>{previewTotals.totalLines} ta</b>
              <small style={{ display: 'block', fontSize: 10.5, color: '#16a34a', marginTop: 2 }}>
                Avtomatik yaratiladi
              </small>
            </div>
            <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
              <small style={{ color: 'var(--muted)', fontSize: 11, display: 'block' }}>Jami tovar soni</small>
              <b style={{ fontSize: 18, color: '#16a34a' }}>{previewTotals.totalUnits} dona</b>
            </div>
            <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
              <small style={{ color: 'var(--muted)', fontSize: 11, display: 'block' }}>Jami tan narx</small>
              <b style={{ fontSize: 14, color: '#0f172a', display: 'block', whiteSpace: 'nowrap' }}>
                ${formatMoney(previewTotals.totalCostUsd)}
              </b>
              <small style={{ color: '#64748b', fontSize: 11 }}>
                {formatMoney(previewTotals.totalCostUzs)} so‘m
              </small>
            </div>
            <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
              <small style={{ color: 'var(--muted)', fontSize: 11, display: 'block' }}>Jami sotish qiymati</small>
              <b style={{ fontSize: 14, color: '#0284c7', display: 'block', whiteSpace: 'nowrap' }}>
                ${formatMoney(previewTotals.totalRetailUsd)}
              </b>
              <small style={{ color: '#64748b', fontSize: 11 }}>
                {formatMoney(previewTotals.totalRetailUzs)} so‘m
              </small>
            </div>
          </div>

          {/* Exchange rate conversion banner */}
          <div style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            fontSize: 12,
            color: '#1e40af',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>💱</span>
              <span>
                <b>Kunlik dollar kursi:</b> 1 USD = <b>{formatMoney(rate)}</b> so‘m. Excelda kiritilgan narxlar (UZS yoki USD) kunlik dollar kursiga mos holda ikkala valyutada avtomatik hisoblandi va bazaga to‘liq saqlanadi.
              </span>
            </div>
            <span style={{ padding: '3px 8px', borderRadius: 6, background: '#dbeafe', fontWeight: 700, fontSize: 11, color: '#1d4ed8', whiteSpace: 'nowrap' }}>
              Avtomatik konvertatsiya
            </span>
          </div>

          {/* QR code currency notification banner */}
          <div style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            color: '#166534',
          }}>
            <CheckCircle2 size={16} color="#16a34a" style={{ flexShrink: 0 }} />
            <span>
              <b>Valyutaga mos QR kodlar:</b> USD tovarlarining QR kodlarida yashirin tannarx <b>T...M</b> (masalan: $90 bo‘lsa <b>T90M</b>), UZS tovarlarida esa <b>M...T</b> (masalan: 478 000 so‘m bo‘lsa <b>M478T</b>) formatida avtomatik shakllanadi va chop etiladi.
            </span>
          </div>

          {/* Groups & Items Table */}
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table className="table" style={{ margin: 0, width: '100%', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#0f172a', color: '#fff', zIndex: 1 }}>
                  <tr>
                    <th style={{ width: 36, textAlign: 'center' }}>№</th>
                    <th>Mahsulot nomi</th>
                    <th>Kategoriya / Brend</th>
                    <th style={{ textAlign: 'center' }}>Valyuta</th>
                    <th style={{ textAlign: 'right' }}>Tan narxi (USD / UZS)</th>
                    <th style={{ textAlign: 'right' }}>Sotish narxi (USD / UZS)</th>
                    <th style={{ textAlign: 'right' }}>Ulgurji / Min</th>
                    <th style={{ textAlign: 'center' }}>Soni</th>
                    <th>Joylashuv</th>
                    <th>Partiya raqami</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((r, i) => {
                    const isUsd = r.currency === 'USD';
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{i + 1}</td>
                        <td>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{r.name}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
                            <span style={{ color: '#0284c7', background: '#e0f2fe', padding: '1px 6px', borderRadius: 4, fontSize: 10.5, fontWeight: 700 }}>
                              + Yangi karta
                            </span>
                            {r.colors && r.colors.length > 0 ? (
                              r.colors.map((c, cIdx) => (
                                <span
                                  key={cIdx}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    padding: '1px 6px',
                                    background: '#f1f5f9',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: 4,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: '#334155',
                                  }}
                                >
                                  <span style={{ color: '#0284c7', fontSize: 9 }}>●</span>
                                  <span>{c.name}:</span>
                                  <b style={{ color: '#16a34a' }}>{c.quantity} ta</b>
                                </span>
                              ))
                            ) : r.color ? (
                              <span style={{ padding: '1px 6px', background: '#e2e8f0', borderRadius: 4, fontSize: 10.5, fontWeight: 600 }}>
                                {r.color}
                              </span>
                            ) : null}
                          </div>
                          {r.description && (
                            <small style={{ display: 'block', color: 'var(--muted)', fontSize: 11, fontStyle: 'italic', marginTop: 3 }}>
                              Izoh: {r.description}
                            </small>
                          )}
                        </td>
                        <td>
                          <span>{r.categoryName || '—'}</span>
                          {r.brandName && <small style={{ display: 'block', color: 'var(--muted)' }}>{r.brandName}</small>}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <Status type={isUsd ? 'blue' : 'green'}>{r.currency}</Status>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <b style={{ color: isUsd ? '#0284c7' : '#16a34a' }}>
                            {isUsd ? `$${r.unitCostUsd}` : `${formatMoney(r.unitCostUzs)} so‘m`}
                          </b>
                          <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10.5 }}>
                            {isUsd ? `${formatMoney(r.unitCostUzs)} so‘m` : `$${r.unitCostUsd}`}
                          </small>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <b style={{ color: isUsd ? '#0284c7' : '#16a34a' }}>
                            {isUsd ? `$${r.retailPriceUsd}` : `${formatMoney(r.retailPriceUzs)} so‘m`}
                          </b>
                          <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10.5 }}>
                            {isUsd ? `${formatMoney(r.retailPriceUzs)} so‘m` : `$${r.retailPriceUsd}`}
                          </small>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontSize: 11 }}>
                          <span>
                            {isUsd
                              ? (r.wholesalePriceUsd ? `$${r.wholesalePriceUsd}` : '—')
                              : (r.wholesalePriceUzs ? `${formatMoney(r.wholesalePriceUzs)}` : '—')}
                          </span>
                          <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>
                            Min: {isUsd
                              ? (r.minimumSalePriceUsd ? `$${r.minimumSalePriceUsd}` : '—')
                              : (r.minimumSalePriceUzs ? `${formatMoney(r.minimumSalePriceUzs)}` : '—')}
                          </small>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <b style={{ fontSize: 13, color: '#16a34a' }}>{r.quantity} dona</b>
                          {r.colors && r.colors.length > 1 && (
                            <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10.5, marginTop: 1 }}>
                              ({r.colors.map(c => c.quantity).join(' + ')})
                            </small>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: 11, fontWeight: 600 }}>{r.locationName}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#0369a1' }}>
                            {r.receiptNo || 'Avtomatik'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <button type="button" className="btn btn-outline" onClick={() => setStep('upload_file')}>
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{
                background: importMode === 'inventory' ? '#7c3aed' : '#0284c7',
                borderColor: importMode === 'inventory' ? '#7c3aed' : '#0284c7',
                padding: '10px 24px',
                fontWeight: 700,
                fontSize: 14,
                boxShadow: '0 4px 12px rgba(2, 132, 199, 0.3)',
              }}
              onClick={handleExecuteImport}
            >
              Tasdiqlash va import qilish ({previewTotals.totalUnits} dona tovar)
            </button>
          </div>
        </div>
      )}

      {step === 'importing' && (
        <div style={{ textAlign: 'center', padding: '40px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 70, height: 70, borderRadius: '50%', background: '#e0f2fe', color: '#0284c7', display: 'grid', placeItems: 'center' }}>
            <Loader2 size={36} className="btn-spinner" />
          </div>
          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Import jarayoni amalga oshirilmoqda…</h3>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>{importProgress.text}</p>
          </div>

          {/* Progress bar */}
          <div style={{ width: '100%', maxWidth: 420, height: 10, background: '#e2e8f0', borderRadius: 6, overflow: 'hidden', marginTop: 10 }}>
            <div
              style={{
                width: `${importProgress.total ? Math.round((importProgress.current / importProgress.total) * 100) : 10}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #0284c7, #38bdf8)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <small style={{ color: '#64748b', fontSize: 12 }}>
            Iltimos oynani yopmang, tovarlar bazaga kiritilmoqda va QR kodlar shakllantirilmoqda...
          </small>
        </div>
      )}

      {step === 'success' && importResult && (
        <div style={{ textAlign: 'center', padding: '16px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#dcfce7', color: '#16a34a', display: 'grid', placeItems: 'center' }}>
            <CheckCircle2 size={36} />
          </div>
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 20, color: '#166534', fontWeight: 800 }}>
              Muvaffaqiyatli import qilindi!
            </h3>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
              Excel fayldagi barcha tovarlar tizimga qabul qilindi va partiyalar shakllantirildi.
            </p>
          </div>

          {/* 1. Xulosa / Statistika bloklari */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, width: '100%', maxWidth: 540 }}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
              <small style={{ color: '#64748b', fontSize: 11, display: 'block' }}>Partiyalar soni</small>
              <b style={{ fontSize: 18, color: '#0f172a' }}>{importResult.totalBatches} ta</b>
            </div>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
              <small style={{ color: '#16a34a', fontSize: 11, display: 'block' }}>Yangi tovar kartalari</small>
              <b style={{ fontSize: 18, color: '#15803d' }}>{importResult.productsCreatedCount || importResult.totalLines} ta</b>
            </div>
            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
              <small style={{ color: '#1d4ed8', fontSize: 11, display: 'block' }}>Jami birliklar</small>
              <b style={{ fontSize: 18, color: '#1e40af' }}>{importResult.totalUnits} dona</b>
            </div>
          </div>

          {/* 2. Yaratilgan partiyalar ro'yxati */}
          <div style={{ width: '100%', maxWidth: 540, background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 12, padding: 14, textAlign: 'left' }}>
            <b style={{ fontSize: 13, display: 'block', marginBottom: 8, color: '#0f172a' }}>Yaratilgan partiyalar / hujjatlar:</b>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 130, overflowY: 'auto' }}>
              {importResult.createdReceipts.map((r, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    background: '#fff',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  <div>
                    <b style={{ fontFamily: 'monospace', color: '#0369a1' }}>#{r.receiptNo}</b>
                    <small style={{ display: 'block', color: 'var(--muted)' }}>{r.locationName}</small>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Status type={r.currency === 'USD' ? 'blue' : 'green'}>{r.currency}</Status>
                    <Status type="purple">{r.unitsCount} dona</Status>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Barcha import bo'lgan tovarlar QR kodlarini chop etish bo'limi */}
          <div style={{
            width: '100%',
            maxWidth: 540,
            background: '#fff',
            border: '1.5px solid #fed7aa',
            borderRadius: 14,
            padding: 16,
            textAlign: 'left',
            boxShadow: '0 2px 10px rgba(234, 88, 12, 0.06)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Printer size={18} color="#ea580c" />
              <b style={{ fontSize: 14, color: '#9a3412' }}>
                Barcha import bo‘lgan tovarlar QR kodlarini chop etish:
              </b>
            </div>
            <p style={{ margin: '0 0 12px', color: '#64748b', fontSize: 12, lineHeight: 1.4 }}>
              Jami <b>{importResult.totalUnits} dona</b> tovar uchun maxfiy tannarx va umumiy QR kodli yorliqlarni telefon yoki kompyuter orqali birvarakayiga chop eting:
            </p>

            {loadingLabels && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px', background: '#fff7ed', borderRadius: 8, color: '#c2410c', fontSize: 13, marginBottom: 10 }}>
                <Loader2 size={16} className="btn-spinner" />
                <span>QR yorliqlar va maxfiy shifrlar tayyorlanmoqda…</span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    padding: '12px 8px',
                    fontSize: 12,
                    fontWeight: 700,
                    background: 'linear-gradient(135deg, #f97316, #ea580c)',
                    boxShadow: '0 4px 14px rgba(249,115,22,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6
                  }}
                  onClick={() => openBluetoothPrint('detonger')}
                  disabled={loadingLabels}
                  title="Detonger printerida chop etish"
                >
                  <Bluetooth size={15} />
                  <span>Detonger (40 mm)</span>
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    padding: '12px 8px',
                    fontSize: 12,
                    fontWeight: 700,
                    background: 'linear-gradient(135deg, #0284c7, #0369a1)',
                    boxShadow: '0 4px 14px rgba(2,132,199,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6
                  }}
                  onClick={() => openBluetoothPrint('mht')}
                  disabled={loadingLabels}
                  title="MHT-L80G printerida 58x40 mm o‘lchamda chop etish"
                >
                  <Bluetooth size={15} />
                  <span>MHT-L80G (58 mm)</span>
                </button>
              </div>

              <button
                type="button"
                className="btn btn-outline"
                style={{
                  padding: '10px',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  borderColor: '#cbd5e1',
                  background: '#f8fafc',
                  color: '#334155'
                }}
                onClick={handleClassicPrint}
                disabled={loadingLabels}
              >
                <QrCode size={15} />
                Kompyuter / Tizim orqali klassik chop etish
              </button>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-outline"
            style={{ padding: '10px 36px', fontSize: 14, fontWeight: 700, background: '#fff', minWidth: 160 }}
            onClick={onClose}
          >
            Tushundim, yopish
          </button>
        </div>
      )}
    </Modal>
    <DetongerPrintModal
      open={bluetoothModalOpen}
      onClose={() => setBluetoothModalOpen(false)}
      labels={labels}
      batchTitle={`Excel import (${importResult?.totalUnits || 0} dona tovar)`}
      receiptDate={new Date().toLocaleDateString('uz-UZ')}
      initialPrinter={preferredPrinter}
      onClassicPrint={() => {
        setBluetoothModalOpen(false);
        setPrintPending(true);
      }}
    />
    </>
  );
}
