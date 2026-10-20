import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  X,
  Search,
  ArrowRight,
  Tag,
  DollarSign,
  Coins,
  Info,
  Check,
  FileCheck,
  HelpCircle,
} from 'lucide-react';
import { Modal, formatMoney } from '@texnobazar/ui';
import { bulkUpdateBatchPrices, getAllBatchPricesForExcel } from '@texnobazar/data';

async function getExcelJS() {
  const mod = await import('exceljs');
  return mod.default || mod;
}

/**
 * Parses numeric strings from Excel (handling 1 800 000, $56,00, 56.00, etc.)
 */
function cleanPriceNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : Math.max(0, val);
  
  let str = String(val).trim();
  // Strip common symbols
  str = str.replace(/[\$€\u00A0]/g, '').replace(/so['’`]?m|sum|uzs|usd/gi, '').trim();
  // Remove thousand-separating spaces
  str = str.replace(/\s+/g, '');
  
  // If has comma but no dot, e.g. "56,00" or "68,5" -> convert to dot
  if (str.includes(',') && !str.includes('.')) {
    str = str.replace(',', '.');
  } else if (str.includes(',') && str.includes('.')) {
    // E.g. "1,800.50" -> remove comma
    str = str.replace(/,/g, '');
  }
  
  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.max(0, num);
}

function normalizeHeader(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['‘’ʻʼ`]/g, '')
    .replace(/\$/g, 'usd')
    .replace(/so[m']?|sum/gi, 'uzs')
    .replace(/[^a-z0-9]/g, '');
}

export default function BatchPriceExcelModal({
  open,
  onClose,
  branchId,
  receipts = [],
  rate = 12000,
  toast,
  onUpdated,
}) {
  const [activeTab, setActiveTab] = useState('UZS'); // 'UZS' | 'USD'
  const [allBranchItems, setAllBranchItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [file, setFile] = useState(null);
  const [parsedRows, setParsedRows] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'changed' | 'unchanged'
  const fileInputRef = useRef(null);

  // Load all branch batch items across the entire store (not limited to calendar date)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingItems(true);

    getAllBatchPricesForExcel(branchId)
      .then((items) => {
        if (cancelled) return;
        const list = Array.isArray(items) ? items : [];
        setAllBranchItems(list);
        
        // Auto-detect which currency tab has items
        const usdCount = list.filter(x => String(x.currency || '').toUpperCase() === 'USD').length;
        const uzsCount = list.filter(x => String(x.currency || '').toUpperCase() === 'UZS').length;
        if (usdCount > 0 && uzsCount === 0) {
          setActiveTab('USD');
        } else if (uzsCount > 0 && usdCount === 0) {
          setActiveTab('UZS');
        }
      })
      .catch((err) => {
        console.error('getAllBatchPricesForExcel error:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, branchId]);

  // Combine loaded server items with fallback receipts
  const itemsList = useMemo(() => {
    if (allBranchItems.length > 0) return allBranchItems;
    const fallback = [];
    (receipts || []).forEach((r) => {
      const items = Array.isArray(r.items) ? r.items : [];
      items.forEach((it) => {
        fallback.push({
          batch_id: it.batch_id,
          receipt_no: r.receipt_no,
          product_id: it.product_id,
          product_name: it.variant_color ? `${it.product_name} (${it.variant_color})` : it.product_name,
          qr_code: it.qr_code,
          currency: String(r.currency || 'USD').trim().toUpperCase(),
          unit_cost: Number(it.unit_cost) || 0,
          unit_cost_usd: Number(it.unit_cost_usd) || 0,
          retail_price: Number(it.retail_price) || 0,
          retail_price_usd: Number(it.retail_price_usd) || 0,
          wholesale_price: Number(it.wholesale_price) || 0,
          wholesale_price_usd: Number(it.wholesale_price_usd) || 0,
          minimum_sale_price: Number(it.minimum_sale_price) || 0,
          minimum_sale_price_usd: Number(it.minimum_sale_price_usd) || 0,
        });
      });
    });
    return fallback;
  }, [allBranchItems, receipts]);

  const usdItemsCount = useMemo(() => itemsList.filter(x => String(x.currency || '').toUpperCase() === 'USD').length, [itemsList]);
  const uzsItemsCount = useMemo(() => itemsList.filter(x => String(x.currency || '').toUpperCase() === 'UZS').length, [itemsList]);

  // Flatten all batch items for quick in-memory matching and stats
  const existingItemsMap = useMemo(() => {
    const map = new Map();
    itemsList.forEach((it) => {
      const qr = String(it.qr_code || '').trim().toUpperCase();
      const receiptNo = String(it.receipt_no || '').trim().toUpperCase();
      const costUzs = Number(it.unit_cost) || 0;
      const costUsd = Number(it.unit_cost_usd) || 0;
      const retailUzs = Number(it.retail_price) || 0;
      const retailUsd = Number(it.retail_price_usd) || 0;
      const wholesaleUzs = Number(it.wholesale_price) || 0;
      const wholesaleUsd = Number(it.wholesale_price_usd) || 0;
      const minUzs = Number(it.minimum_sale_price) || 0;
      const minUsd = Number(it.minimum_sale_price_usd) || 0;
      const itemCurrency = String(it.currency || 'USD').trim().toUpperCase();

      const itemObj = {
        batch_id: it.batch_id,
        receipt_no: it.receipt_no,
        product_id: it.product_id,
        product_name: it.variant_color ? `${it.product_name} (${it.variant_color})` : it.product_name,
        qr_code: it.qr_code,
        cost_uzs: costUzs,
        cost_usd: costUsd,
        retail_uzs: retailUzs,
        retail_usd: retailUsd,
        wholesale_uzs: wholesaleUzs,
        wholesale_usd: wholesaleUsd,
        min_uzs: minUzs,
        min_usd: minUsd,
        currency: itemCurrency,
      };

      // Primary matching by QR code alone (Partiya umumiy kodi):
      if (qr) {
        map.set(`QR::${qr}`, itemObj);
        map.set(qr, itemObj);
      }
      if (qr && receiptNo) {
        map.set(`${receiptNo}::${qr}`, itemObj);
      }
      if (it.product_name) {
        const normName = it.product_name.trim().toLowerCase();
        if (!map.has(`NAME::${normName}`)) {
          map.set(`NAME::${normName}`, itemObj);
        }
      }
    });
    return map;
  }, [itemsList]);

  const handleClose = () => {
    if (saving) return;
    setFile(null);
    setParsedRows([]);
    setError('');
    setSearchFilter('');
    onClose?.();
  };

  /**
   * Generates and downloads the Excel template (blank or pre-filled with current items)
   */
  const handleDownloadTemplate = async (prefill = false) => {
    try {
      const ExcelJS = await getExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Texnobazar';
      wb.created = new Date();

      const isUzs = activeTab === 'UZS';
      const sheetName = isUzs ? 'UZS Narxlar' : 'USD Narxlar';
      const ws = wb.addWorksheet(sheetName, {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      // EXACT 7 columns matching user specifications (A..G):
      // A: Mahsulot nomi
      // B: Tan narxi (UZS) / Tan narxi (USD)
      // C: Sotish narxi (UZS) / Sotish narxi (USD)
      // D: Ulgurji narxi (UZS) / Ulgurji narxi (USD)
      // E: Minimal sotish narxi (UZS) / Minimal sotish narxi (USD)
      // F: Valyuta
      // G: Partiya umumiy kodi
      ws.columns = [
        { header: 'Mahsulot nomi', key: 'product_name', width: 34 },
        { header: isUzs ? 'Tan narxi (UZS)' : 'Tan narxi (USD)', key: 'unit_cost', width: 20 },
        { header: isUzs ? 'Sotish narxi (UZS)' : 'Sotish narxi (USD)', key: 'retail_price', width: 20 },
        { header: isUzs ? 'Ulgurji narxi (UZS)' : 'Ulgurji narxi (USD)', key: 'wholesale_price', width: 20 },
        { header: isUzs ? 'Minimal sotish narxi (UZS)' : 'Minimal sotish narxi (USD)', key: 'minimum_sale_price', width: 24 },
        { header: 'Valyuta', key: 'currency', width: 14 },
        { header: 'Partiya umumiy kodi', key: 'qr_code', width: 22 },
      ];

      // Style Header (matching screenshots with dark navy header #0F172A)
      const headerRow = ws.getRow(1);
      headerRow.height = 30;
      headerRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF0F172A' },
        };
        cell.font = {
          name: 'Calibri',
          size: 11,
          bold: true,
          color: { argb: 'FFFFFFFF' },
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF334155' } },
          bottom: { style: 'medium', color: { argb: 'FF334155' } },
          left: { style: 'thin', color: { argb: 'FF334155' } },
          right: { style: 'thin', color: { argb: 'FF334155' } },
        };
      });

      let rowsAdded = 0;

      if (prefill) {
        // Find items matching active currency
        const matchingItems = itemsList.filter((it) => String(it.currency || '').toUpperCase() === activeTab);
        // If no items match current tab (e.g. user selected UZS but all items were converted to USD base),
        // fallback to exporting all items using that tab's prices so the user never gets an empty template!
        const exportItems = matchingItems.length > 0 ? matchingItems : itemsList;

        exportItems.forEach((it) => {
          const name = it.variant_color ? `${it.product_name} (${it.variant_color})` : (it.product_name || 'Nomsiz tovar');
          const cost = isUzs ? (Number(it.unit_cost) || 0) : (Number(it.unit_cost_usd) || 0);
          const retail = isUzs ? (Number(it.retail_price) || 0) : (Number(it.retail_price_usd) || 0);
          const wholesale = isUzs ? (Number(it.wholesale_price) || 0) : (Number(it.wholesale_price_usd) || 0);
          const minPrice = isUzs ? (Number(it.minimum_sale_price) || 0) : (Number(it.minimum_sale_price_usd) || 0);

          const row = ws.addRow({
            product_name: name,
            unit_cost: cost,
            retail_price: retail,
            wholesale_price: wholesale,
            minimum_sale_price: minPrice,
            currency: activeTab,
            qr_code: it.qr_code || '',
          });
          rowsAdded++;

            // Style data row
            row.height = 22;
            row.eachCell((cell, colNumber) => {
              cell.font = { name: 'Calibri', size: 10 };
              cell.border = {
                top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              };
              // Alignments
              if (colNumber === 1) {
                cell.alignment = { horizontal: 'left', vertical: 'middle' };
              } else if (colNumber >= 2 && colNumber <= 5) {
                cell.alignment = { horizontal: 'right', vertical: 'middle' };
                cell.numFmt = isUzs ? '#,##0' : '$#,##0.00';
              } else if (colNumber === 6) {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: isUzs ? 'FF16A34A' : 'FF2563EB' } };
              } else if (colNumber === 7) {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.font = { name: 'Consolas', size: 10, bold: true, color: { argb: 'FF0F172A' } };
              }
            });
          });
        }

      // If blank or no items matched, add demo sample rows from user screenshot
      if (rowsAdded === 0) {
        const demoSamples = isUzs
          ? [
              {
                product_name: 'Brandu 43 TV',
                unit_cost: 1800000,
                retail_price: 2064000,
                wholesale_price: 0,
                minimum_sale_price: 1860000,
                currency: 'UZS',
                qr_code: 'GW6065',
              },
              {
                product_name: 'Panda divan kojalik',
                unit_cost: 980000,
                retail_price: 1200000,
                wholesale_price: 0,
                minimum_sale_price: 0,
                currency: 'UZS',
                qr_code: 'VQ3292',
              },
            ]
          : [
              {
                product_name: 'Velokolyaska 6200 Pro',
                unit_cost: 56.0,
                retail_price: 68.0,
                wholesale_price: 0.0,
                minimum_sale_price: 0.0,
                currency: 'USD',
                qr_code: 'WC0402',
              },
              {
                product_name: 'Egizak velokolyaska SZ877 adil',
                unit_cost: 36.0,
                retail_price: 48.0,
                wholesale_price: 0.0,
                minimum_sale_price: 0.0,
                currency: 'USD',
                qr_code: 'GG4684',
              },
            ];

        demoSamples.forEach((s) => {
          const row = ws.addRow(s);
          row.height = 22;
          row.eachCell((cell, colNumber) => {
            cell.font = { name: 'Calibri', size: 10 };
            cell.border = {
              top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            };
            if (colNumber === 1) {
              cell.alignment = { horizontal: 'left', vertical: 'middle' };
            } else if (colNumber >= 2 && colNumber <= 5) {
              cell.alignment = { horizontal: 'right', vertical: 'middle' };
              cell.numFmt = isUzs ? '#,##0' : '$#,##0.00';
            } else if (colNumber === 6) {
              cell.alignment = { horizontal: 'center', vertical: 'middle' };
              cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: isUzs ? 'FF16A34A' : 'FF2563EB' } };
            } else if (colNumber === 7) {
              cell.alignment = { horizontal: 'center', vertical: 'middle' };
              cell.font = { name: 'Consolas', size: 10, bold: true, color: { argb: 'FF0F172A' } };
            }
          });
        });
      }

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      const fileName = prefill
        ? `narxlar_shabloni_${activeTab}_mavjud_tovarlar.xlsx`
        : `narxlar_shabloni_${activeTab}.xlsx`;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => window.URL.revokeObjectURL(url), 20000);

      toast?.(
        prefill
          ? `${rowsAdded} ta tovar bilan "${fileName}" shabloni yuklab olindi`
          : `"${fileName}" bo'sh shabloni yuklab olindi`
      );
    } catch (err) {
      console.error(err);
      setError("Shablon yuklab olishda xatolik yuz berdi: " + (err.message || String(err)));
    }
  };

  /**
   * Handle file upload and parse Excel
   */
  const handleFileChange = async (e) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    setFile(selectedFile);
    setError('');
    setParsing(true);

    try {
      const ExcelJS = await getExcelJS();
      const wb = new ExcelJS.Workbook();
      const buffer = await selectedFile.arrayBuffer();
      await wb.xlsx.load(buffer);

      const ws = wb.worksheets[0];
      if (!ws) throw new Error("Excel faylda varaqlar (sheets) topilmadi");

      // Extract header row
      const headerRow = ws.getRow(1);
      const colMap = {};

      headerRow.eachCell((cell, colIdx) => {
        const raw = normalizeHeader(cell.value);
        if (!raw) return;

        if (raw.includes('nom') || raw.includes('mahsulot') || raw.includes('product') || raw.includes('tovar')) {
          if (!colMap.name) colMap.name = colIdx;
        } else if (raw.includes('tan') || raw.includes('cost') || raw.includes('xarid')) {
          if (!colMap.cost) colMap.cost = colIdx;
        } else if (raw.includes('sotish') || raw.includes('chakana') || raw.includes('retail') || raw.includes('narx')) {
          if (!colMap.retail) colMap.retail = colIdx;
        } else if (raw.includes('ulgur') || raw.includes('wholesale') || raw.includes('optom')) {
          if (!colMap.wholesale) colMap.wholesale = colIdx;
        } else if (raw.includes('min') || raw.includes('kam')) {
          if (!colMap.minPrice) colMap.minPrice = colIdx;
        } else if (raw.includes('valyut') || raw.includes('curr')) {
          if (!colMap.currency) colMap.currency = colIdx;
        } else if (raw.includes('umumiy') || raw.includes('qr') || raw.includes('kod')) {
          if (!colMap.qrCode) colMap.qrCode = colIdx;
        } else if (raw.includes('raqam') || (raw.includes('partiya') && !raw.includes('kod') && !raw.includes('umumiy'))) {
          if (!colMap.receiptNo) colMap.receiptNo = colIdx;
        }
      });

      // Positional fallbacks if exact headers not detected (matching A..G: 7 columns)
      if (!colMap.name) colMap.name = 1;
      if (!colMap.cost) colMap.cost = 2;
      if (!colMap.retail) colMap.retail = 3;
      if (!colMap.wholesale) colMap.wholesale = 4;
      if (!colMap.minPrice) colMap.minPrice = 5;
      if (!colMap.currency) colMap.currency = 6;
      if (!colMap.qrCode) colMap.qrCode = 7;
      // Note: colMap.receiptNo is NOT set as fallback because the template has 7 columns

      const rows = [];
      const totalRows = ws.rowCount;

      // Detect sheet currency: check row 1 or row 2
      let detectedCurrency = activeTab;
      const headerCostVal = String(headerRow.getCell(colMap.cost).value || '').toUpperCase();
      if (headerCostVal.includes('USD')) detectedCurrency = 'USD';
      else if (headerCostVal.includes('UZS')) detectedCurrency = 'UZS';

      for (let r = 2; r <= totalRows; r++) {
        const row = ws.getRow(r);
        const nameVal = row.getCell(colMap.name).value;
        const qrVal = colMap.qrCode ? row.getCell(colMap.qrCode).value : null;
        const receiptVal = colMap.receiptNo ? row.getCell(colMap.receiptNo).value : null;
        const costVal = row.getCell(colMap.cost).value;
        const retailVal = row.getCell(colMap.retail).value;
        const wholesaleVal = row.getCell(colMap.wholesale).value;
        const minVal = row.getCell(colMap.minPrice).value;
        const currVal = row.getCell(colMap.currency).value;

        // Skip completely blank rows
        if (!nameVal && !qrVal && !receiptVal && !costVal && !retailVal) continue;

        const productName = String(nameVal?.text || nameVal || '').trim();
        const qrCode = String(qrVal?.text || qrVal || '').trim().toUpperCase();
        const receiptNo = String(receiptVal?.text || receiptVal || '').trim().toUpperCase();
        const rowCurrency = String(currVal?.text || currVal || detectedCurrency).trim().toUpperCase() || detectedCurrency;

        const unitCost = cleanPriceNumber(costVal?.result ?? costVal);
        const retailPrice = cleanPriceNumber(retailVal?.result ?? retailVal);
        const wholesalePrice = cleanPriceNumber(wholesaleVal?.result ?? wholesaleVal);
        const minPrice = cleanPriceNumber(minVal?.result ?? minVal);

        // Find match in current memory:
        // Priority 1: Partiya umumiy kodi (qrCode)
        // Priority 2: Receipt + QR composite if available
        const existing =
          (qrCode ? (existingItemsMap.get(`QR::${qrCode}`) || existingItemsMap.get(qrCode)) : null) ||
          (receiptNo && qrCode ? existingItemsMap.get(`${receiptNo}::${qrCode}`) : null) ||
          null;

        let hasChange = true;
        let oldCost = null;
        let oldRetail = null;
        let oldWholesale = null;
        let oldMin = null;

        if (existing) {
          if (rowCurrency === 'UZS') {
            oldCost = existing.cost_uzs;
            oldRetail = existing.retail_uzs;
            oldWholesale = existing.wholesale_uzs;
            oldMin = existing.min_uzs;
          } else {
            oldCost = existing.cost_usd;
            oldRetail = existing.retail_usd;
            oldWholesale = existing.wholesale_usd;
            oldMin = existing.min_usd;
          }

          hasChange =
            unitCost !== oldCost ||
            retailPrice !== oldRetail ||
            wholesalePrice !== oldWholesale ||
            minPrice !== oldMin ||
            existing.currency !== rowCurrency;
        }

        rows.push({
          idx: r - 1,
          product_name: productName || existing?.product_name || 'Nomsiz tovar',
          receipt_no: existing?.receipt_no || receiptNo || '',
          qr_code: qrCode || existing?.qr_code || '',
          currency: rowCurrency === 'USD' ? 'USD' : 'UZS',
          unit_cost: unitCost,
          retail_price: retailPrice,
          wholesale_price: wholesalePrice,
          minimum_sale_price: minPrice,
          existing,
          old_cost: oldCost,
          old_retail: oldRetail,
          old_wholesale: oldWholesale,
          old_min: oldMin,
          has_change: hasChange,
          is_matched: Boolean(existing || qrCode),
        });
      }

      if (rows.length === 0) {
        throw new Error("Excel faylida hech qanday tovar yozuvi topilmadi");
      }

      // Auto switch tab if detected currency differs
      if (detectedCurrency && detectedCurrency !== activeTab) {
        setActiveTab(detectedCurrency);
      }

      setParsedRows(rows);
      toast?.(`${rows.length} ta qator o'qildi va tahlil qilindi`);
    } catch (err) {
      console.error(err);
      setError("Excel faylni o'qishda xatolik: " + (err.message || String(err)));
      setParsedRows([]);
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * Save and execute price update via RPC
   */
  const handleApplyPriceUpdate = async () => {
    if (!parsedRows.length) return;
    setSaving(true);
    setError('');

    try {
      const itemsPayload = parsedRows.map((r) => ({
        receipt_no: r.existing?.receipt_no || r.receipt_no || null,
        qr_code: r.qr_code,
        product_name: r.product_name,
        currency: r.currency || activeTab,
        unit_cost: r.unit_cost,
        retail_price: r.retail_price,
        wholesale_price: r.wholesale_price,
        minimum_sale_price: r.minimum_sale_price,
      }));

      const res = await bulkUpdateBatchPrices({
        branchId,
        currency: activeTab,
        items: itemsPayload,
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || "Narxlarni yangilashda noma'lum xatolik");
      }

      const updatedCount = res.updated_batches || 0;
      const notFoundCount = res.not_found_count || 0;

      let msg = `${updatedCount} ta partiya va mahsulot narxi muvaffaqiyatli yangilandi!`;
      if (notFoundCount > 0) {
        msg += ` (${notFoundCount} ta partiya topilmadi)`;
      }

      toast?.(msg);
      onUpdated?.();
      handleClose();
    } catch (err) {
      console.error('Narxlarni saqlashda xatolik:', err);
      setError("Narxlarni yangilashda xatolik yuz berdi: " + (err.message || String(err)));
    } finally {
      setSaving(false);
    }
  };

  // Filtered rows for preview
  const displayRows = useMemo(() => {
    return parsedRows.filter((r) => {
      if (statusFilter === 'changed' && !r.has_change) return false;
      if (statusFilter === 'unchanged' && r.has_change) return false;

      if (searchFilter.trim()) {
        const q = searchFilter.toLowerCase();
        const matchName = String(r.product_name || '').toLowerCase().includes(q);
        const matchQr = String(r.qr_code || '').toLowerCase().includes(q);
        const matchRec = String(r.receipt_no || '').toLowerCase().includes(q);
        if (!matchName && !matchQr && !matchRec) return false;
      }
      return true;
    });
  }, [parsedRows, statusFilter, searchFilter]);

  const stats = useMemo(() => {
    const total = parsedRows.length;
    const changed = parsedRows.filter((r) => r.has_change).length;
    const unchanged = total - changed;
    const missingQr = parsedRows.filter((r) => !r.qr_code).length;
    return { total, changed, unchanged, missingQr };
  }, [parsedRows]);

  const isUzs = activeTab === 'UZS';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Partiya va Tovar Narxlarini Exceldan Yangilash"
      maxWidth="1100px"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Currency Tabs */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#f8fafc',
            padding: '6px',
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`btn ${isUzs ? 'btn-primary' : 'btn-outline'}`}
              style={{
                borderRadius: 8,
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: isUzs ? '#16a34a' : '#fff',
                borderColor: isUzs ? '#16a34a' : '#cbd5e1',
                color: isUzs ? '#fff' : '#475569',
              }}
              onClick={() => {
                setActiveTab('UZS');
                setFile(null);
                setParsedRows([]);
              }}
            >
              <Coins size={16} />
              🇺🇿 UZS Shabloni (So'm narxlar){uzsItemsCount > 0 ? ` (${uzsItemsCount} ta)` : ''}
            </button>
            <button
              type="button"
              className={`btn ${!isUzs ? 'btn-primary' : 'btn-outline'}`}
              style={{
                borderRadius: 8,
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: !isUzs ? '#2563eb' : '#fff',
                borderColor: !isUzs ? '#2563eb' : '#cbd5e1',
                color: !isUzs ? '#fff' : '#475569',
              }}
              onClick={() => {
                setActiveTab('USD');
                setFile(null);
                setParsedRows([]);
              }}
            >
              <DollarSign size={16} />
              🇺🇸 USD Shabloni (Dollar narxlar){usdItemsCount > 0 ? ` (${usdItemsCount} ta)` : ''}
            </button>
          </div>

          <div style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>Joriy kurs:</span>
            <b style={{ color: '#0f172a' }}>1 $ = {new Intl.NumberFormat('uz-UZ').format(rate)} so'm</b>
          </div>
        </div>

        {/* Currency Rule Alert */}
        <div
          style={{
            background: isUzs ? '#f0fdf4' : '#eff6ff',
            border: `1px solid ${isUzs ? '#bbf7d0' : '#bfdbfe'}`,
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12.5,
            color: isUzs ? '#166534' : '#1e40af',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            lineHeight: 1.5,
          }}
        >
          <Info size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <b>Qat'iy Valyuta Qoidasi:</b>{' '}
            {isUzs ? (
              <span>
                Faylda kiritilgan tovarlarning narxi <b>UZS (so'm)</b> hisoblanadi. Dollar kursi o'zgarsa ham ularning
                so'mdagi tan narxi va sotish narxi <b>1 tiyinga ham o'zgarmasdan qoladi</b>! Dollardagi ekvivalenti
                yangi kurs bo'yicha avtomatik konvertatsiya qilinadi.
              </span>
            ) : (
              <span>
                Faylda kiritilgan tovarlarning narxi <b>USD (dollar)</b> hisoblanadi. Dollar kursi o'zgarganda ularning
                dollardagi narxi saqlanadi, so'mdagi narxi esa yangi kursga ko'paytirilib avtomatik yangilanadi.
              </span>
            )}
          </div>
        </div>

        {/* Template Downloads Section */}
        <div
          style={{
            background: '#ffffff',
            border: '1.5px dashed #cbd5e1',
            borderRadius: 12,
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FileSpreadsheet size={18} color={isUzs ? '#16a34a' : '#2563eb'} />
              {isUzs ? 'UZS Excel Shabloni' : 'USD Excel Shabloni'}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              Shablonni yuklab oling, narxlarni o'zgartiring va faylni qayta yuklang.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-outline"
              disabled={loadingItems}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: isUzs ? '#16a34a' : '#2563eb',
                borderColor: isUzs ? '#86efac' : '#93c5fd',
                background: isUzs ? '#f0fdf4' : '#eff6ff',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              onClick={() => handleDownloadTemplate(true)}
              title="Mavjud barcha tovarlarni shablonda to'ldirilgan holda yuklab olish"
            >
              {loadingItems ? <RefreshCw size={15} className="spin" /> : <Download size={15} />}
              Mavjud tovarlar bilan yuklab olish ({activeTab} - {isUzs ? (uzsItemsCount > 0 ? uzsItemsCount : itemsList.length) : (usdItemsCount > 0 ? usdItemsCount : itemsList.length)} ta)
            </button>
            <button
              type="button"
              className="btn btn-outline"
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: '#475569',
                borderColor: '#cbd5e1',
                background: '#f8fafc',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              onClick={() => handleDownloadTemplate(false)}
              title="Bo'sh namunaviy shablonni yuklab olish"
            >
              <Download size={15} />
              Bo'sh shablon
            </button>
          </div>
        </div>

        {/* Upload Zone */}
        {!parsedRows.length && (
          <div
            style={{
              border: '2px dashed #94a3b8',
              borderRadius: 12,
              padding: '32px 20px',
              textAlign: 'center',
              background: '#f8fafc',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: isUzs ? '#dcfce7' : '#dbeafe',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px',
                color: isUzs ? '#16a34a' : '#2563eb',
              }}
            >
              <Upload size={24} />
            </div>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a' }}>
              {parsing ? "Fayl tahlil qilinmoqda…" : "Excel faylni tanlang yoki bu yerga tashlang"}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              Faqat <b>.xlsx</b> yoki <b>.xls</b> formatdagi fayllar qabul qilinadi
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            style={{
              background: '#fef2f2',
              color: '#dc2626',
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 13,
              border: '1px solid #fecaca',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        {/* Parsed Rows Preview */}
        {parsedRows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Stats Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10,
                background: '#f1f5f9',
                padding: '10px 14px',
                borderRadius: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: '#475569' }}>
                  Fayl: <b>{file?.name}</b> ({stats.total} ta tovar)
                </span>
                <span
                  style={{
                    background: '#dcfce7',
                    color: '#15803d',
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  🟢 {stats.changed} ta narxi o'zgaradi
                </span>
                <span
                  style={{
                    background: '#e2e8f0',
                    color: '#475569',
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  ⚪ {stats.unchanged} ta o'zgarishsiz
                </span>
                {stats.missingQr > 0 && (
                  <span
                    style={{
                      background: '#fef3c7',
                      color: '#b45309',
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    ⚠️ {stats.missingQr} ta QR kodi yo'q
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn btn-outline"
                style={{ fontSize: 12, padding: '4px 8px', height: 28, color: '#dc2626', borderColor: '#fca5a5' }}
                onClick={() => {
                  setFile(null);
                  setParsedRows([]);
                }}
              >
                <X size={14} /> Faylni tozalash
              </button>
            </div>

            {/* Filter & Search Bar */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: '#94a3b8' }} />
                <input
                  type="text"
                  className="input"
                  style={{ paddingLeft: 32, width: '100%', fontSize: 13 }}
                  placeholder="Tovar nomi yoki partiya umumiy kodi bo'yicha qidirish…"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className={`btn ${statusFilter === 'all' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  onClick={() => setStatusFilter('all')}
                >
                  Barchasi ({stats.total})
                </button>
                <button
                  type="button"
                  className={`btn ${statusFilter === 'changed' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  onClick={() => setStatusFilter('changed')}
                >
                  Faqat o'zgaradiganlar ({stats.changed})
                </button>
                <button
                  type="button"
                  className={`btn ${statusFilter === 'unchanged' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  onClick={() => setStatusFilter('unchanged')}
                >
                  O'zgarishsiz ({stats.unchanged})
                </button>
              </div>
            </div>

            {/* Table Preview */}
            <div
              style={{
                maxHeight: 380,
                overflowY: 'auto',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                background: '#fff',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#0f172a', color: '#fff', zIndex: 2 }}>
                  <tr>
                    <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>№</th>
                    <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>Mahsulot nomi</th>
                    <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Partiya umumiy kodi</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                      Tan narxi ({activeTab})
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                      Sotish narxi ({activeTab})
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                      Ulgurji ({activeTab})
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                      Min. sotish ({activeTab})
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>Holati</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((r, i) => {
                    const isEven = i % 2 === 0;
                    return (
                      <tr
                        key={i}
                        style={{
                          background: r.has_change
                            ? isEven
                              ? '#f0fdf4'
                              : '#dcfce7'
                            : isEven
                            ? '#fff'
                            : '#f8fafc',
                          borderBottom: '1px solid #e2e8f0',
                        }}
                      >
                        <td style={{ padding: '8px 10px', color: '#64748b' }}>{r.idx}</td>
                        <td style={{ padding: '8px 10px', fontWeight: 600, color: '#0f172a' }}>
                          <div>{r.product_name}</div>
                          {r.receipt_no && (
                            <div style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 400 }}>
                              {r.receipt_no}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          <code
                            style={{
                              background: '#f1f5f9',
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontWeight: 700,
                              color: '#334155',
                            }}
                          >
                            {r.qr_code || '—'}
                          </code>
                        </td>

                        {/* Cost */}
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {r.old_cost !== null && r.old_cost !== r.unit_cost && (
                            <div style={{ fontSize: 10, color: '#94a3b8', textDecoration: 'line-through' }}>
                              {isUzs ? formatMoney(r.old_cost) : `$${r.old_cost.toFixed(2)}`}
                            </div>
                          )}
                          <b style={{ color: r.old_cost !== null && r.old_cost !== r.unit_cost ? '#16a34a' : '#0f172a' }}>
                            {isUzs ? formatMoney(r.unit_cost) : `$${r.unit_cost.toFixed(2)}`}
                          </b>
                        </td>

                        {/* Retail */}
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {r.old_retail !== null && r.old_retail !== r.retail_price && (
                            <div style={{ fontSize: 10, color: '#94a3b8', textDecoration: 'line-through' }}>
                              {isUzs ? formatMoney(r.old_retail) : `$${r.old_retail.toFixed(2)}`}
                            </div>
                          )}
                          <b style={{ color: r.old_retail !== null && r.old_retail !== r.retail_price ? '#16a34a' : '#0f172a' }}>
                            {isUzs ? formatMoney(r.retail_price) : `$${r.retail_price.toFixed(2)}`}
                          </b>
                        </td>

                        {/* Wholesale */}
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {isUzs ? formatMoney(r.wholesale_price) : `$${r.wholesale_price.toFixed(2)}`}
                        </td>

                        {/* Min Price */}
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {isUzs ? formatMoney(r.minimum_sale_price) : `$${r.minimum_sale_price.toFixed(2)}`}
                        </td>

                        {/* Status badge */}
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          {r.has_change ? (
                            <span
                              style={{
                                background: '#bbf7d0',
                                color: '#166534',
                                padding: '2px 8px',
                                borderRadius: 6,
                                fontSize: 11,
                                fontWeight: 700,
                              }}
                            >
                              O'zgaradi
                            </span>
                          ) : (
                            <span
                              style={{
                                background: '#e2e8f0',
                                color: '#64748b',
                                padding: '2px 6px',
                                borderRadius: 6,
                                fontSize: 11,
                              }}
                            >
                              Bir xil
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Modal Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 8,
            paddingTop: 12,
            borderTop: '1px solid #e2e8f0',
          }}
        >
          <button type="button" className="btn btn-outline" onClick={handleClose} disabled={saving}>
            Bekor qilish
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{
              background: isUzs ? '#16a34a' : '#2563eb',
              borderColor: isUzs ? '#16a34a' : '#2563eb',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontWeight: 700,
            }}
            onClick={handleApplyPriceUpdate}
            disabled={saving || !parsedRows.length}
          >
            {saving ? (
              <>
                <RefreshCw size={15} className="tw-animate-spin" />
                Narxlar yangilanmoqda…
              </>
            ) : (
              <>
                <Check size={16} />
                {parsedRows.length > 0
                  ? `${parsedRows.length} ta tovar narxini yangilash`
                  : "Narxlarni yangilash"}
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
