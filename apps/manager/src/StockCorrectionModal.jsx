import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  SlidersHorizontal,
  Search,
  Download,
  RefreshCw,
  Save,
  X,
  Check,
  AlertTriangle,
  Filter,
  CheckCircle2,
  RotateCcw,
  Store,
  Warehouse,
  Boxes,
  ArrowRight,
  TrendingUp,
  FileSpreadsheet,
  Sparkles,
  LayoutGrid,
  Table as TableIcon,
  Plus,
  Minus
} from 'lucide-react';
import {
  getBrowserClient,
  listInventoryBalances,
  getInventoryReferences,
  applyStockReconciliation,
  syncAllBatchPricesToLatest,
  filterAndRankProducts
} from '@texnobazar/data';

const downloadExcelWorkbook = async (wb, fileName) => {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    window.URL.revokeObjectURL(url);
  }, 20000);
};

export default function StockCorrectionModal({
  open,
  onClose,
  branchId,
  locations: initialLocations = [],
  categories: initialCategories = [],
  rate: initialRate,
  toast,
  onUpdated
}) {
  const rate = Number(initialRate) || 12800;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingRowId, setSavingRowId] = useState(null);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [error, setError] = useState('');
  const [products, setProducts] = useState([]);
  const [locations, setLocations] = useState(initialLocations);
  const [categories, setCategories] = useState(initialCategories);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'uninspected' | 'inspected' | 'modified' | 'store' | 'warehouse' | 'zero'

  // Persistent inspected/checked products tracking: { [productId]: { checkedAt: number, mode: 'saved' | 'manual' } }
  const storageKey = useMemo(() => {
    return `texnobazar:stock_correction_checked_${branchId || 'default'}`;
  }, [branchId]);

  const [inspectedMap, setInspectedMap] = useState(() => {
    if (typeof window === 'undefined') return {};
    try {
      const saved = localStorage.getItem(`texnobazar:stock_correction_checked_${branchId || 'default'}`);
      return saved ? JSON.parse(saved) : {};
    } catch (_) {
      return {};
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem(storageKey);
      setInspectedMap(saved ? JSON.parse(saved) : {});
    } catch (_) {}
  }, [storageKey]);

  const persistInspectedMap = useCallback((nextMap) => {
    setInspectedMap(nextMap);
    try {
      localStorage.setItem(storageKey, JSON.stringify(nextMap));
    } catch (e) {
      console.error('Failed to save inspectedMap:', e);
    }
  }, [storageKey]);

  const toggleInspected = useCallback((productId, forceValue) => {
    setInspectedMap(prev => {
      const next = { ...prev };
      const isChecked = !!next[productId];
      const target = forceValue !== undefined ? forceValue : !isChecked;
      if (target) {
        next[productId] = {
          checkedAt: Date.now(),
          mode: 'manual'
        };
      } else {
        delete next[productId];
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch (_) {}
      return next;
    });
  }, [storageKey]);

  const clearAllInspected = useCallback(() => {
    const count = Object.keys(inspectedMap).length;
    if (!count) return;
    if (window.confirm(`Barcha ${count} ta tovarning tekshirilganlik belgisini tozalab, yangi tekshiruv boshlansinmi?`)) {
      persistInspectedMap({});
      toast?.('Barcha tekshiruv belgilari tozalandi');
    }
  }, [inspectedMap, persistInspectedMap, toast]);

  // Responsive mobile detection & view mode ('cards' vs 'table')
  const checkIsMobile = () => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768 || (window.innerWidth <= 1024 && window.innerHeight <= 520);
  };

  const [isMobile, setIsMobile] = useState(checkIsMobile);
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) return 'cards';
    return 'table';
  });

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const stepQty = (productId, field, delta) => {
    setProducts(prev => prev.map(p => {
      if (p.product_id !== productId) return p;
      const cur = parseInt(p[field], 10) || 0;
      const nextVal = Math.max(0, cur + delta);
      return {
        ...p,
        [field]: nextVal
      };
    }));
  };

  // Locations resolution
  const storeLocation = useMemo(() => {
    return locations.find(l => l.type === 'store') || locations[0] || null;
  }, [locations]);

  const warehouseLocation = useMemo(() => {
    return locations.find(l => l.type === 'warehouse') || locations.find(l => l.id !== storeLocation?.id) || null;
  }, [locations, storeLocation]);

  // Load live data from database
  const loadData = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      // Fetch references (locations & categories) if needed
      let refsRes = {};
      try {
        refsRes = await getInventoryReferences(branchId);
      } catch (_) {}
      let catRes = { data: [] };
      try {
        catRes = await getBrowserClient().from('categories').select('id,name,parent_id').eq('is_active', true);
      } catch (_) {}

      if (refsRes?.locations?.length) setLocations(refsRes.locations);
      if (catRes?.data?.length) setCategories(catRes.data);

      // Fetch all inventory balances (up to 5000 items)
      let allItems = [];
      let currentPage = 1;
      let hasMore = true;
      while (hasMore) {
        const r = await listInventoryBalances({
          branchId,
          page: currentPage,
          pageSize: 5000
        });
        const items = r?.items || [];
        allItems = allItems.concat(items);
        if (items.length < 5000 || allItems.length >= (r?.total || 0)) {
          hasMore = false;
        } else {
          currentPage++;
        }
      }

      // Group balances by product_id
      const pMap = new Map();
      allItems.forEach(it => {
        const pid = it.product_id;
        if (!pMap.has(pid)) {
          let retailUzs = Number(it.retail_price) || 0;
          let retailUsd = Number(it.retail_price_usd) || 0;
          if (retailUsd > 0 && retailUzs <= 0 && rate > 0) {
            retailUzs = Math.round(retailUsd * rate);
          } else if (retailUzs > 0 && retailUsd <= 0 && rate > 0) {
            retailUsd = Number((retailUzs / rate).toFixed(2));
          }

          let costUzs = Number(it.cost_price) || 0;
          let costUsd = Number(it.cost_price_usd) || 0;
          if (costUsd > 0 && costUzs <= 0 && rate > 0) {
            costUzs = Math.round(costUsd * rate);
          } else if (costUzs > 0 && costUsd <= 0 && rate > 0) {
            costUsd = Number((costUzs / rate).toFixed(2));
          }

          const diffUzs = retailUzs - costUzs;
          const diffUsd = Number((retailUsd - costUsd).toFixed(2));

          pMap.set(pid, {
            product_id: pid,
            name: it.product_name || 'Nomsiz tovar',
            orig_name: it.product_name || 'Nomsiz tovar',
            sku: it.sku || '',
            barcode: it.barcode || '',
            category_id: it.category_id || '',
            category_name: it.category_name || 'Kategoriyasiz',
            // Prices
            cost_price: costUzs,
            orig_cost_price: costUzs,
            cost_price_usd: costUsd,
            orig_cost_price_usd: costUsd,
            retail_price: retailUzs,
            orig_retail_price: retailUzs,
            retail_price_usd: retailUsd,
            orig_retail_price_usd: retailUsd,
            diff_uzs: diffUzs,
            orig_diff_uzs: diffUzs,
            diff_usd: diffUsd,
            orig_diff_usd: diffUsd,
            // Stock counts
            store_qty: 0,
            orig_store_qty: 0,
            warehouse_qty: 0,
            orig_warehouse_qty: 0,
            currency: it.currency || 'USD'
          });
        }

        const p = pMap.get(pid);
        const qty = Number(it.on_hand) || 0;
        if (it.location_type === 'warehouse') {
          p.warehouse_qty += qty;
          p.orig_warehouse_qty += qty;
        } else {
          // 'store' or default
          p.store_qty += qty;
          p.orig_store_qty += qty;
        }
      });

      const list = Array.from(pMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'uz'));
      setProducts(list);
    } catch (err) {
      console.error('StockCorrectionModal loadData error:', err);
      setError(err?.message || 'Ma’lumotlarni yuklab bo‘lmadi');
    } finally {
      setLoading(false);
    }
  }, [branchId, rate]);

  useEffect(() => {
    if (open) {
      loadData();
    }
  }, [open, loadData]);

  // Check if a row has pending changes
  const isRowModified = useCallback((p) => {
    return (
      p.name.trim() !== p.orig_name.trim() ||
      Number(p.cost_price) !== Number(p.orig_cost_price) ||
      Number(p.cost_price_usd) !== Number(p.orig_cost_price_usd) ||
      Number(p.retail_price) !== Number(p.orig_retail_price) ||
      Number(p.retail_price_usd) !== Number(p.orig_retail_price_usd) ||
      Number(p.store_qty) !== Number(p.orig_store_qty) ||
      Number(p.warehouse_qty) !== Number(p.orig_warehouse_qty)
    );
  }, []);

  const modifiedList = useMemo(() => {
    return products.filter(isRowModified);
  }, [products, isRowModified]);

  // Two-way interactive field updates
  const handleFieldChange = (productId, field, value) => {
    setProducts(prev => prev.map(p => {
      if (p.product_id !== productId) return p;
      const next = { ...p };
      const curRate = rate > 0 ? rate : 12800;

      if (field === 'name') {
        next.name = value;
      } else if (field === 'store_qty') {
        next.store_qty = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
      } else if (field === 'warehouse_qty') {
        next.warehouse_qty = value === '' ? '' : Math.max(0, parseInt(value, 10) || 0);
      } else if (field === 'diff_usd') {
        // User entered Tafovut in USD
        // Sotish USD = Tannarx USD + Tafovut USD
        const diffUsdNum = value === '' ? 0 : Number(value);
        const costUsd = Number(next.cost_price_usd) || 0;
        const newRetailUsd = Number((costUsd + diffUsdNum).toFixed(2));
        const newRetailUzs = Math.round(newRetailUsd * curRate);
        const costUzs = Number(next.cost_price) || 0;
        const newDiffUzs = newRetailUzs - costUzs;

        next.diff_usd = value;
        next.retail_price_usd = newRetailUsd;
        next.retail_price = newRetailUzs;
        next.diff_uzs = newDiffUzs;
      } else if (field === 'diff_uzs') {
        // User entered Tafovut in UZS
        // Sotish UZS = Tannarx UZS + Tafovut UZS
        const diffUzsNum = value === '' ? 0 : Number(value);
        const costUzs = Number(next.cost_price) || 0;
        const newRetailUzs = costUzs + diffUzsNum;
        const newRetailUsd = Number((newRetailUzs / curRate).toFixed(2));
        const costUsd = Number(next.cost_price_usd) || 0;
        const newDiffUsd = Number((newRetailUsd - costUsd).toFixed(2));

        next.diff_uzs = value;
        next.retail_price = newRetailUzs;
        next.retail_price_usd = newRetailUsd;
        next.diff_usd = newDiffUsd;
      } else if (field === 'retail_price_usd') {
        // User entered Sotish narxi in USD
        const retailUsdNum = value === '' ? 0 : Number(value);
        const costUsd = Number(next.cost_price_usd) || 0;
        const newDiffUsd = Number((retailUsdNum - costUsd).toFixed(2));
        const newRetailUzs = Math.round(retailUsdNum * curRate);
        const costUzs = Number(next.cost_price) || 0;
        const newDiffUzs = newRetailUzs - costUzs;

        next.retail_price_usd = value;
        next.retail_price = newRetailUzs;
        next.diff_usd = newDiffUsd;
        next.diff_uzs = newDiffUzs;
      } else if (field === 'retail_price') {
        // User entered Sotish narxi in UZS
        const retailUzsNum = value === '' ? 0 : Number(value);
        const costUzs = Number(next.cost_price) || 0;
        const newDiffUzs = retailUzsNum - costUzs;
        const newRetailUsd = Number((retailUzsNum / curRate).toFixed(2));
        const costUsd = Number(next.cost_price_usd) || 0;
        const newDiffUsd = Number((newRetailUsd - costUsd).toFixed(2));

        next.retail_price = value;
        next.retail_price_usd = newRetailUsd;
        next.diff_uzs = newDiffUzs;
        next.diff_usd = newDiffUsd;
      } else if (field === 'cost_price_usd') {
        // User entered Tannarx in USD
        const costUsdNum = value === '' ? 0 : Number(value);
        const retailUsd = Number(next.retail_price_usd) || 0;
        const newDiffUsd = Number((retailUsd - costUsdNum).toFixed(2));
        const newCostUzs = Math.round(costUsdNum * curRate);
        const retailUzs = Number(next.retail_price) || 0;
        const newDiffUzs = retailUzs - newCostUzs;

        next.cost_price_usd = value;
        next.cost_price = newCostUzs;
        next.diff_usd = newDiffUsd;
        next.diff_uzs = newDiffUzs;
      } else if (field === 'cost_price') {
        // User entered Tannarx in UZS
        const costUzsNum = value === '' ? 0 : Number(value);
        const retailUzs = Number(next.retail_price) || 0;
        const newDiffUzs = retailUzs - costUzsNum;
        const newCostUsd = Number((costUzsNum / curRate).toFixed(2));
        const retailUsd = Number(next.retail_price_usd) || 0;
        const newDiffUsd = Number((retailUsd - newCostUsd).toFixed(2));

        next.cost_price = value;
        next.cost_price_usd = newCostUsd;
        next.diff_uzs = newDiffUzs;
        next.diff_usd = newDiffUsd;
      }
      return next;
    }));
  };

  // Revert a single product's changes
  const revertRow = (productId) => {
    setProducts(prev => prev.map(p => {
      if (p.product_id !== productId) return p;
      return {
        ...p,
        name: p.orig_name,
        cost_price: p.orig_cost_price,
        cost_price_usd: p.orig_cost_price_usd,
        retail_price: p.orig_retail_price,
        retail_price_usd: p.orig_retail_price_usd,
        diff_uzs: p.orig_diff_uzs,
        diff_usd: p.orig_diff_usd,
        store_qty: p.orig_store_qty,
        warehouse_qty: p.orig_warehouse_qty
      };
    }));
  };

  // Save changes (either all or specific products)
  const saveChanges = async (itemsToSave) => {
    if (!itemsToSave.length) return;
    setSaving(true);
    setError('');
    try {
      const client = getBrowserClient();

      // 1. Update product table for changed prices or names
      for (const p of itemsToSave) {
        const nameChanged = p.name.trim() !== p.orig_name.trim();
        const priceChanged = (
          Number(p.cost_price) !== Number(p.orig_cost_price) ||
          Number(p.cost_price_usd) !== Number(p.orig_cost_price_usd) ||
          Number(p.retail_price) !== Number(p.orig_retail_price) ||
          Number(p.retail_price_usd) !== Number(p.orig_retail_price_usd)
        );

        if (nameChanged || priceChanged) {
          const updatePayload = {
            updated_at: new Date().toISOString()
          };
          if (nameChanged) updatePayload.name = p.name.trim();
          if (priceChanged) {
            updatePayload.cost_price = Number(p.cost_price) || 0;
            updatePayload.cost_price_usd = Number(p.cost_price_usd) || 0;
            updatePayload.retail_price = Number(p.retail_price) || 0;
            updatePayload.retail_price_usd = Number(p.retail_price_usd) || 0;
          }

          const { error: updErr } = await client
            .from('products')
            .update(updatePayload)
            .eq('id', p.product_id);

          if (updErr) throw updErr;
        }
      }

      // 2. Adjust Store stock quantity if changed
      const storeItems = itemsToSave
        .filter(p => Number(p.store_qty) !== Number(p.orig_store_qty))
        .map(p => ({
          product_id: p.product_id,
          expected: Number(p.orig_store_qty) || 0,
          counted: Number(p.store_qty) || 0
        }));

      if (storeItems.length > 0 && storeLocation?.id) {
        await applyStockReconciliation({
          branchId,
          locationId: storeLocation.id,
          items: storeItems,
          notes: 'Do‘kondagi tovarlar sonini to‘g‘rilash (Onlayn reviziya)'
        });
      }

      // 3. Adjust Warehouse stock quantity if changed
      const warehouseItems = itemsToSave
        .filter(p => Number(p.warehouse_qty) !== Number(p.orig_warehouse_qty))
        .map(p => ({
          product_id: p.product_id,
          expected: Number(p.orig_warehouse_qty) || 0,
          counted: Number(p.warehouse_qty) || 0
        }));

      if (warehouseItems.length > 0 && warehouseLocation?.id) {
        await applyStockReconciliation({
          branchId,
          locationId: warehouseLocation.id,
          items: warehouseItems,
          notes: 'Ombordagi tovarlar sonini to‘g‘rilash (Onlayn reviziya)'
        });
      }

      // 4. Trigger system-wide batch price sync helper
      await syncAllBatchPricesToLatest().catch(() => {});

      // 5. Saqlangan tovarlarni avtomatik tekshirilgan (sverka qilingan) deb belgilash
      setInspectedMap(prev => {
        const next = { ...prev };
        itemsToSave.forEach(p => {
          next[p.product_id] = {
            checkedAt: Date.now(),
            mode: 'saved'
          };
        });
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch (_) {}
        return next;
      });

      toast?.(`${itemsToSave.length} ta tovar ma’lumotlari muvaffaqiyatli saqlandi!`);
      onUpdated?.();
      await loadData();
    } catch (err) {
      console.error('StockCorrectionModal save error:', err);
      setError(err?.message || 'O‘zgarishlarni saqlashda xatolik yuz berdi');
      toast?.('Xatolik: ' + (err?.message || 'Saqlab bo‘lmadi'));
    } finally {
      setSaving(false);
      setSavingRowId(null);
    }
  };

  const saveSingleRow = async (p) => {
    setSavingRowId(p.product_id);
    await saveChanges([p]);
  };

  const saveAllModified = async () => {
    if (!modifiedList.length) return;
    if (!window.confirm(`${modifiedList.length} ta tovardagi barcha o‘zgarishlar (soni, narxi, tafovuti) bazaga saqlansinmi?`)) return;
    await saveChanges(modifiedList);
  };

  // Excel Export
  const handleExportExcel = async () => {
    if (!filteredProducts.length) {
      toast?.('Eksport qilish uchun tovarlar topilmadi');
      return;
    }
    setExportingExcel(true);
    try {
      const ExcelJS = (await import('exceljs')).default || (await import('exceljs'));
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Texnobazar';
      wb.created = new Date();

      const ws = wb.addWorksheet('Tovarlar reviziyasi', {
        views: [{ state: 'frozen', ySplit: 1 }]
      });

      ws.columns = [
        { header: '№', key: 'idx', width: 7 },
        { header: 'Kategoriya', key: 'category_name', width: 28 },
        { header: 'Mahsulot nomi', key: 'product_name', width: 42 },
        { header: 'Do‘konda (dona)', key: 'store_qty', width: 18 },
        { header: 'Omborda (dona)', key: 'warehouse_qty', width: 18 },
        { header: 'Jami qoldiq (dona)', key: 'total_qty', width: 20 },
        { header: 'Sotish narxi (UZS)', key: 'retail_price_uzs', width: 20 },
        { header: 'Sotish narxi (USD)', key: 'retail_price_usd', width: 18 },
        { header: 'Tannarxi (UZS)', key: 'cost_price_uzs', width: 20 },
        { header: 'Tannarxi (USD)', key: 'cost_price_usd', width: 18 },
        { header: 'Tafovut (UZS)', key: 'diff_price_uzs', width: 20 },
        { header: 'Tafovut (USD)', key: 'diff_price_usd', width: 18 },
        { header: 'Tekshiruv', key: 'audit_status', width: 18 },
        { header: 'Holati', key: 'status', width: 16 }
      ];

      const headerRow = ws.getRow(1);
      headerRow.height = 34;
      headerRow.eachCell((cell, colNumber) => {
        if (colNumber === 4 || colNumber === 5) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } };
        } else if (colNumber === 11 || colNumber === 12) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
        }
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF334155' } },
          bottom: { style: 'medium', color: { argb: 'FF334155' } },
          left: { style: 'thin', color: { argb: 'FF334155' } },
          right: { style: 'thin', color: { argb: 'FF334155' } }
        };
      });

      let rowIdx = 1;
      let totalStoreSum = 0;
      let totalWarehouseSum = 0;
      let totalQtySum = 0;
      let totalValueUzsSum = 0;
      let totalCostUzsSum = 0;

      filteredProducts.forEach(item => {
        rowIdx++;
        const sQty = Number(item.store_qty) || 0;
        const wQty = Number(item.warehouse_qty) || 0;
        const totQty = sQty + wQty;
        const retUzs = Number(item.retail_price) || 0;
        const retUsd = Number(item.retail_price_usd) || 0;
        const cstUzs = Number(item.cost_price) || 0;
        const cstUsd = Number(item.cost_price_usd) || 0;
        const dfUzs = retUzs - cstUzs;
        const dfUsd = Number((retUsd - cstUsd).toFixed(2));

        totalStoreSum += sQty;
        totalWarehouseSum += wQty;
        totalQtySum += totQty;
        totalValueUzsSum += totQty * retUzs;
        totalCostUzsSum += totQty * cstUzs;

        const isInspected = !!inspectedMap[item.product_id];
        const isMod = isRowModified(item);
        const auditStatus = isMod ? 'O‘zgartirildi' : isInspected ? 'Tekshirildi' : 'Tekshirilmagan';

        const addedRow = ws.addRow({
          idx: rowIdx - 1,
          category_name: item.category_name || 'Kategoriyasiz',
          product_name: item.name || 'Nomsiz tovar',
          store_qty: sQty,
          warehouse_qty: wQty,
          total_qty: totQty,
          retail_price_uzs: retUzs,
          retail_price_usd: retUsd,
          cost_price_uzs: cstUzs,
          cost_price_usd: cstUsd,
          diff_price_uzs: { formula: `G${rowIdx}-I${rowIdx}`, result: dfUzs },
          diff_price_usd: { formula: `H${rowIdx}-J${rowIdx}`, result: dfUsd },
          audit_status: auditStatus,
          status: totQty > 0 ? 'Mavjud' : 'Tugagan (0)'
        });

        addedRow.height = 22;
        const isEven = (rowIdx - 1) % 2 === 0;

        addedRow.eachCell((cell, colNumber) => {
          cell.font = { name: 'Calibri', size: 10 };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };

          if (isEven) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF8FAFC' }
            };
          }

          if (colNumber === 1) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          } else if (colNumber === 2 || colNumber === 3) {
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
            if (colNumber === 2) cell.font = { name: 'Calibri', size: 10, bold: true };
          } else if (colNumber === 4 || colNumber === 5 || colNumber === 6) {
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
            if (colNumber === 6) cell.font = { name: 'Calibri', size: 10, bold: true };
          } else if (colNumber === 7 || colNumber === 9) {
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
          } else if (colNumber === 8 || colNumber === 10) {
            cell.numFmt = '$#,##0.00';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
            cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF0369A1' } };
          } else if (colNumber === 11) {
            cell.numFmt = '#,##0;[Red]-#,##0;"0"';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
            cell.font = {
              name: 'Calibri',
              size: 10,
              bold: true,
              color: { argb: dfUzs >= 0 ? 'FF15803D' : 'FFDC2626' }
            };
          } else if (colNumber === 12) {
            cell.numFmt = '$#,##0.00;[Red]-$#,##0.00;"$0.00"';
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
            cell.font = {
              name: 'Calibri',
              size: 10,
              bold: true,
              color: { argb: dfUsd >= 0 ? 'FF15803D' : 'FFDC2626' }
            };
          } else if (colNumber === 13) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = {
              name: 'Calibri',
              size: 10,
              bold: true,
              color: { argb: totQty > 0 ? 'FF16A34A' : 'FFDC2626' }
            };
          }
        });
      });

      // Total summary row
      const totalDiffUzs = totalValueUzsSum - totalCostUzsSum;
      const totalDiffUsd = rate > 0 ? Number((totalDiffUzs / rate).toFixed(2)) : 0;

      const summaryRow = ws.addRow({
        idx: 'JAMI',
        category_name: `${filteredProducts.length} ta tovar`,
        product_name: '',
        store_qty: totalStoreSum,
        warehouse_qty: totalWarehouseSum,
        total_qty: totalQtySum,
        retail_price_uzs: totalValueUzsSum,
        retail_price_usd: rate > 0 ? Number((totalValueUzsSum / rate).toFixed(2)) : 0,
        cost_price_uzs: totalCostUzsSum,
        cost_price_usd: rate > 0 ? Number((totalCostUzsSum / rate).toFixed(2)) : 0,
        diff_price_uzs: totalDiffUzs,
        diff_price_usd: totalDiffUsd,
        status: ''
      });
      summaryRow.height = 26;
      summaryRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
        cell.border = {
          top: { style: 'medium', color: { argb: 'FF0F172A' } },
          bottom: { style: 'double', color: { argb: 'FF0F172A' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
        if (colNumber === 1 || colNumber === 2) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (colNumber >= 4 && colNumber <= 6) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if (colNumber === 7 || colNumber === 9) {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if (colNumber === 8 || colNumber === 10) {
          cell.numFmt = '$#,##0.00';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if (colNumber === 11) {
          cell.numFmt = '#,##0;[Red]-#,##0;"0"';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
          cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: totalDiffUzs >= 0 ? 'FF15803D' : 'FFDC2626' } };
        } else if (colNumber === 12) {
          cell.numFmt = '$#,##0.00;[Red]-$#,##0.00;"$0.00"';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
          cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: totalDiffUsd >= 0 ? 'FF15803D' : 'FFDC2626' } };
        }
      });

      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: rowIdx, column: ws.columns.length }
      };

      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `Tovarlar_Reviziya_Sverka_${dateStr}.xlsx`;
      await downloadExcelWorkbook(wb, fileName);
      toast?.('Excel fayl muvaffaqiyatli yuklab olindi!');
    } catch (e) {
      console.error('Excel export error:', e);
      toast?.('Excel yuklashda xatolik: ' + (e?.message || 'Xatolik'));
    } finally {
      setExportingExcel(false);
    }
  };

  // Smart search, category & status filtering
  const searchResult = useMemo(() => {
    let list = products;

    if (selectedCategory) {
      list = list.filter(p => p.category_id === selectedCategory);
    }

    if (filterMode === 'modified') {
      list = list.filter(isRowModified);
    } else if (filterMode === 'uninspected') {
      list = list.filter(p => !inspectedMap[p.product_id]);
    } else if (filterMode === 'inspected') {
      list = list.filter(p => !!inspectedMap[p.product_id]);
    } else if (filterMode === 'store') {
      list = list.filter(p => Number(p.store_qty) > 0);
    } else if (filterMode === 'warehouse') {
      list = list.filter(p => Number(p.warehouse_qty) > 0);
    } else if (filterMode === 'zero') {
      list = list.filter(p => (Number(p.store_qty) + Number(p.warehouse_qty)) === 0);
    }

    if (!searchQuery.trim()) {
      return {
        products: list,
        hasExactMatch: true,
        hasFuzzyOnly: false,
        suggestedProducts: [],
        suggestedQuery: ''
      };
    }

    const res = filterAndRankProducts(list, searchQuery, {
      fields: ['name', 'sku', 'barcode', 'category_name'],
      minScore: 50
    });

    return {
      products: res.items,
      hasExactMatch: res.hasExactMatch,
      hasFuzzyOnly: res.hasFuzzyOnly,
      suggestedProducts: res.suggestedProducts,
      suggestedQuery: res.suggestedQuery
    };
  }, [products, searchQuery, selectedCategory, filterMode, isRowModified, inspectedMap]);

  const filteredProducts = searchResult.products;
  const hasFuzzyOnly = searchResult.hasFuzzyOnly;
  const suggestedProducts = searchResult.suggestedProducts;

  // Aggregate stats
  const stats = useMemo(() => {
    let totStore = 0;
    let totWarehouse = 0;
    let totValueUzs = 0;
    let totCostUzs = 0;
    let inspectedCount = 0;

    products.forEach(p => {
      const sq = Number(p.store_qty) || 0;
      const wq = Number(p.warehouse_qty) || 0;
      const tq = sq + wq;
      totStore += sq;
      totWarehouse += wq;
      totValueUzs += tq * (Number(p.retail_price) || 0);
      totCostUzs += tq * (Number(p.cost_price) || 0);
      if (inspectedMap[p.product_id]) {
        inspectedCount++;
      }
    });

    const totDiffUzs = totValueUzs - totCostUzs;
    const totDiffUsd = rate > 0 ? Number((totDiffUzs / rate).toFixed(2)) : 0;
    const uninspectedCount = products.length - inspectedCount;

    return {
      totalProducts: products.length,
      modifiedCount: modifiedList.length,
      inspectedCount,
      uninspectedCount,
      totStore,
      totWarehouse,
      totQty: totStore + totWarehouse,
      totValueUzs,
      totCostUzs,
      totDiffUzs,
      totDiffUsd
    };
  }, [products, modifiedList, rate, inspectedMap]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : '12px'
      }}
    >
      <div
        style={{
          width: isMobile ? '100%' : '98vw',
          maxWidth: isMobile ? '100%' : '1600px',
          height: isMobile ? '100dvh' : '96vh',
          maxHeight: isMobile ? '100dvh' : '96vh',
          background: '#fff',
          borderRadius: isMobile ? 0 : 16,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxSizing: 'border-box',
          border: isMobile ? 'none' : '1px solid #cbd5e1'
        }}
      >
        {/* Top Header */}
        <div
          style={{
            padding: isMobile ? '10px 12px' : '14px 20px',
            borderBottom: '1px solid #e2e8f0',
            background: 'linear-gradient(to right, #0f172a, #1e293b)',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            flexShrink: 0
          }}
        >
          {/* Row 1: Title, Jonli badge, and Close Button (X) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, minWidth: 0 }}>
              <div
                style={{
                  width: isMobile ? 32 : 42,
                  height: isMobile ? 32 : 42,
                  borderRadius: isMobile ? 8 : 10,
                  background: '#2563eb',
                  display: 'grid',
                  placeItems: 'center',
                  color: '#fff',
                  flexShrink: 0
                }}
              >
                <SlidersHorizontal size={isMobile ? 17 : 22} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: isMobile ? 14 : 18, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {isMobile ? 'Tovarlar reviziyasi' : 'Tovarlar sonini to‘g‘rilash va onlayn reviziya'}
                  </h2>
                  <span
                    style={{
                      background: '#16a34a',
                      color: '#fff',
                      padding: '1px 6px',
                      borderRadius: 5,
                      fontSize: 10,
                      fontWeight: 700
                    }}
                  >
                    Jonli
                  </span>
                </div>
                {!isMobile && (
                  <p style={{ margin: '3px 0 0', fontSize: 12, color: '#94a3b8' }}>
                    Do‘kon va ombordagi mavjud soni, mahsulot nomi, tannarxi, sotish narxi va tafovutlarni tezkor tahrirlang
                  </p>
                )}
              </div>
            </div>

            {/* Pinned Close Button */}
            <button
              type="button"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: 'none',
                color: '#fff',
                width: isMobile ? 32 : 36,
                height: isMobile ? 32 : 36,
                borderRadius: 8,
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
                flexShrink: 0
              }}
              onClick={onClose}
              title="Yopish"
            >
              <X size={isMobile ? 18 : 20} />
            </button>
          </div>

          {/* Row 2: Badges and Header Actions */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  background: 'rgba(255,255,255,0.15)',
                  color: '#e2e8f0',
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600
                }}
              >
                1 USD = {rate.toLocaleString('uz-UZ')} UZS
              </span>
              <span
                style={{
                  background: stats.inspectedCount > 0 ? '#dcfce7' : 'rgba(255,255,255,0.12)',
                  color: stats.inspectedCount > 0 ? '#15803d' : '#94a3b8',
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4
                }}
                title="Ko‘zdan kechirilgan / tekshirilgan tovarlar soni"
              >
                <CheckCircle2 size={12} />
                {stats.inspectedCount} / {products.length} tekshirildi
              </span>
              {modifiedList.length > 0 && (
                <span
                  style={{
                    background: '#fef3c7',
                    color: '#b45309',
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 800
                  }}
                >
                  {modifiedList.length} ta o‘zgardi
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {stats.inspectedCount > 0 && (
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{
                    background: 'rgba(239,68,68,0.15)',
                    borderColor: 'rgba(239,68,68,0.3)',
                    color: '#fca5a5',
                    fontSize: 11,
                    height: 30,
                    padding: '0 8px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    borderRadius: 6,
                    cursor: 'pointer'
                  }}
                  onClick={clearAllInspected}
                  title="Barcha tekshirilganlik belgilarini tozalash (yangi sverka boshlash uchun)"
                >
                  <RotateCcw size={12} />
                  {isMobile ? 'Tozalash' : 'Belgilarni tozalash'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-outline"
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  borderColor: 'rgba(255,255,255,0.2)',
                  color: '#fff',
                  fontSize: 11,
                  height: 30,
                  padding: '0 8px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  borderRadius: 6
                }}
                onClick={loadData}
                disabled={loading}
                title="Bazadagi eng so‘nggi tovarlarni qayta yuklash"
              >
                <RefreshCw size={12} className={loading ? 'spin' : ''} />
                {loading ? '…' : 'Yangilash'}
              </button>

              <button
                type="button"
                className="btn btn-outline"
                style={{
                  background: '#16a34a',
                  borderColor: '#16a34a',
                  color: '#fff',
                  fontSize: 11,
                  height: 30,
                  padding: '0 10px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  borderRadius: 6,
                  fontWeight: 700
                }}
                onClick={handleExportExcel}
                disabled={exportingExcel || loading}
                title="Ushbu jadvalni Excel (.xlsx) formatida yuklab olish"
              >
                <FileSpreadsheet size={13} />
                {exportingExcel ? '…' : 'Excel'}
              </button>

              {modifiedList.length > 0 && !isMobile && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    background: '#2563eb',
                    borderColor: '#2563eb',
                    color: '#fff',
                    fontSize: 12,
                    height: 30,
                    padding: '0 12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    borderRadius: 6,
                    fontWeight: 800,
                    boxShadow: '0 0 15px rgba(37,99,235,0.5)'
                  }}
                  onClick={saveAllModified}
                  disabled={saving}
                >
                  <Save size={13} />
                  {saving ? 'Saqlanmoqda…' : `Saqlash (${modifiedList.length})`}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Stats Strip - Smooth horizontal scroll on mobile, no multi-line wrapping */}
        <div
          className="stock-modal-hide-scrollbar"
          style={{
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
            padding: isMobile ? '6px 10px' : '8px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            whiteSpace: 'nowrap',
            fontSize: isMobile ? 11 : 11.5,
            flexShrink: 0,
            boxSizing: 'border-box',
            width: '100%'
          }}
        >
          <span style={{ color: '#475569', background: '#fff', padding: '3px 8px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            Jami: <b style={{ color: '#0f172a' }}>{stats.totalProducts} ta</b>
          </span>
          <span style={{ color: '#166534', background: '#f0fdf4', padding: '3px 8px', borderRadius: 6, border: '1px solid #bbf7d0', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Store size={12} />
            Do‘konda: <b>{stats.totStore.toLocaleString('uz-UZ')} dona</b>
          </span>
          <span style={{ color: '#1e40af', background: '#eff6ff', padding: '3px 8px', borderRadius: 6, border: '1px solid #bfdbfe', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Warehouse size={12} />
            Omborda: <b>{stats.totWarehouse.toLocaleString('uz-UZ')} dona</b>
          </span>
          <span style={{ color: '#0f172a', background: '#fff', padding: '3px 8px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            Jami qoldiq: <b>{stats.totQty.toLocaleString('uz-UZ')} dona</b>
          </span>
          <span style={{ color: stats.totDiffUzs >= 0 ? '#15803d' : '#dc2626', background: stats.totDiffUzs >= 0 ? '#f0fdf4' : '#fef2f2', padding: '3px 8px', borderRadius: 6, border: stats.totDiffUzs >= 0 ? '1px solid #bbf7d0' : '1px solid #fecaca', fontWeight: 700 }}>
            Tafovut (foyda): {stats.totDiffUzs >= 0 ? '+' : ''}{stats.totDiffUzs.toLocaleString('uz-UZ')} so‘m (${stats.totDiffUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })})
          </span>
        </div>

        {/* Toolbar: Search, View Mode Toggle, Category & Filter Tabs */}
        <div
          style={{
            padding: isMobile ? '8px 10px' : '10px 20px',
            borderBottom: '1px solid #e2e8f0',
            background: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            flexShrink: 0
          }}
        >
          {/* Row 1: Search input + View Mode Toggle */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search
                size={15}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#94a3b8'
                }}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Mahsulot nomi, SKU, shtrix-kod..."
                style={{
                  width: '100%',
                  height: 36,
                  padding: '0 30px 0 32px',
                  borderRadius: 8,
                  border: '1px solid #cbd5e1',
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    padding: 4
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* View Mode Toggle: [ 📱 Karta ] [ 📊 Jadval ] */}
            <div
              style={{
                display: 'inline-flex',
                background: '#f1f5f9',
                padding: 2,
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                flexShrink: 0
              }}
            >
              <button
                type="button"
                onClick={() => setViewMode('cards')}
                style={{
                  border: 'none',
                  background: viewMode === 'cards' ? '#2563eb' : 'transparent',
                  color: viewMode === 'cards' ? '#fff' : '#475569',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4
                }}
                title="Karta ko‘rinishi (Mobil uchun juda qulay)"
              >
                <LayoutGrid size={13} />
                {isMobile ? 'Karta' : 'Kartalar'}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                style={{
                  border: 'none',
                  background: viewMode === 'table' ? '#2563eb' : 'transparent',
                  color: viewMode === 'table' ? '#fff' : '#475569',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4
                }}
                title="Jadval ko‘rinishi (Barcha ustunlar)"
              >
                <TableIcon size={13} />
                {isMobile ? 'Jadval' : 'Jadval'}
              </button>
            </div>
          </div>

          {/* Row 2: Category Filter & Quick Filter Tabs (Scrollable on mobile without ugly bar) */}
          <div
            className="stock-modal-hide-scrollbar"
            style={{ display: 'flex', gap: 8, alignItems: 'center', overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 2, boxSizing: 'border-box', width: '100%' }}
          >
            <select
              value={selectedCategory}
              onChange={e => setSelectedCategory(e.target.value)}
              style={{
                height: 32,
                padding: '0 8px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                fontSize: 12,
                outline: 'none',
                background: '#fff',
                maxWidth: isMobile ? 160 : 220,
                flexShrink: 0
              }}
            >
              <option value="">Barcha kategoriyalar ({categories.length})</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div
              style={{
                display: 'flex',
                background: '#f1f5f9',
                padding: 2,
                borderRadius: 6,
                gap: 2,
                flexShrink: 0,
                whiteSpace: 'nowrap'
              }}
            >
              {[
                { id: 'all', label: `Barchasi (${products.length})` },
                { id: 'uninspected', label: `Tekshirilmagan (${stats.uninspectedCount})`, badgeColor: stats.uninspectedCount > 0 ? '#b91c1c' : undefined },
                { id: 'inspected', label: `Tekshirilgan (${stats.inspectedCount})`, badgeColor: stats.inspectedCount > 0 ? '#15803d' : undefined },
                { id: 'modified', label: `O‘zgarganlar (${stats.modifiedCount})` },
                { id: 'store', label: 'Faqat do‘konda' },
                { id: 'warehouse', label: 'Faqat omborda' },
                { id: 'zero', label: 'Tugaganlar (0)' }
              ].map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterMode(tab.id)}
                  style={{
                    border: 'none',
                    background: filterMode === tab.id ? '#fff' : 'transparent',
                    color: filterMode === tab.id ? '#0f172a' : (tab.badgeColor || '#64748b'),
                    fontWeight: filterMode === tab.id ? 800 : 600,
                    padding: '4px 10px',
                    borderRadius: 5,
                    fontSize: 11.5,
                    cursor: 'pointer',
                    boxShadow: filterMode === tab.id ? '0 1px 2px rgba(0,0,0,0.08)' : 'none'
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error banner if any */}
        {error && (
          <div
            style={{
              background: '#fef2f2',
              borderBottom: '1px solid #fecaca',
              color: '#b91c1c',
              padding: '10px 20px',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* Suggestion banner if typo/normalized match: "Balki buni nazarda tutgandirsiz" */}
        {searchQuery.trim() && hasFuzzyOnly && suggestedProducts.length > 0 && (
          <div
            style={{
              margin: isMobile ? '6px 8px 0' : '8px 20px 0',
              padding: isMobile ? '8px 10px' : '10px 16px',
              background: 'linear-gradient(to right, #fefce8, #fffbeb)',
              border: '1.5px solid #fde047',
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              boxShadow: '0 2px 4px rgba(234, 179, 8, 0.08)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: '#fef08a',
                  display: 'grid',
                  placeItems: 'center',
                  color: '#ca8a04',
                  flexShrink: 0
                }}
              >
                <Sparkles size={16} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#854d0e' }}>
                «{searchQuery}» bo‘yicha to‘g‘ridan-to‘g‘ri tovar topilmadi. Balki buni nazarda tutgandirsiz:
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {suggestedProducts.map(sp => (
                  <button
                    key={sp.product_id}
                    type="button"
                    onClick={() => setSearchQuery(sp.name)}
                    style={{
                      background: '#fff',
                      border: '1px solid #facc15',
                      borderRadius: 6,
                      padding: '3px 10px',
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#0f172a',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      boxShadow: '0 1px 2px rgba(0,0,0,0.06)'
                    }}
                    title="Qidiruv maydoniga qo‘yish"
                  >
                    <span>{sp.name}</span>
                    <ArrowRight size={12} style={{ color: '#ca8a04' }} />
                  </button>
                ))}
              </div>
            </div>
            <span
              style={{
                fontSize: 12,
                color: '#a16207',
                fontWeight: 700,
                background: '#fef9c3',
                padding: '3px 10px',
                borderRadius: 6,
                border: '1px solid #fef08a'
              }}
            >
              {filteredProducts.length} ta yaqin tovar topildi
            </span>
          </div>
        )}

        {/* Scrollable Content View (Cards or Table) */}
        <div
          style={{
            flex: '1 1 0%',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
            background: viewMode === 'cards' ? '#f8fafc' : '#fff',
            padding: viewMode === 'cards' ? (isMobile ? '8px 8px 24px' : '16px 20px 24px') : 0,
            width: '100%',
            boxSizing: 'border-box'
          }}
        >
          {loading ? (
            <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>
              <RefreshCw size={36} className="spin" style={{ margin: '0 auto 12px', color: '#2563eb' }} />
              <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Filialdagi tovarlar ma’lumotlari yuklanmoqda…</p>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>
              <Boxes size={42} style={{ margin: '0 auto 12px', color: '#94a3b8' }} />
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
                {searchQuery.trim() ? `«${searchQuery}» bo‘yicha tovar topilmadi` : 'Tovar topilmadi'}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 13 }}>
                Qidiruv yoki filtr parametrlarini o‘zgartirib ko‘ring.
              </p>
              {searchQuery.trim() && (
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setSearchQuery('')}
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    padding: '6px 14px',
                    borderRadius: 8,
                    background: '#fff',
                    borderColor: '#cbd5e1',
                    cursor: 'pointer'
                  }}
                >
                  Qidiruvni tozalash
                </button>
              )}
            </div>
          ) : viewMode === 'cards' ? (
            /* Cards View - Highly Touch-Friendly & Guaranteed No-Overflow for Mobile */
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(360px, 1fr))',
                gap: isMobile ? 8 : 12,
                width: '100%',
                boxSizing: 'border-box'
              }}
            >
              {filteredProducts.map((p, idx) => {
                const modified = isRowModified(p);
                const isInspected = !!inspectedMap[p.product_id];
                const storeQty = Number(p.store_qty) || 0;
                const warehouseQty = Number(p.warehouse_qty) || 0;
                const totalQty = storeQty + warehouseQty;
                const diffUsd = Number(p.diff_usd) || 0;
                const diffUzs = Number(p.diff_uzs) || 0;
                const storeChanged = storeQty !== Number(p.orig_store_qty);
                const warehouseChanged = warehouseQty !== Number(p.orig_warehouse_qty);
                const isRowSaving = savingRowId === p.product_id;

                return (
                  <div
                    key={p.product_id}
                    style={{
                      background: modified ? '#fffdf5' : isInspected ? '#f0fdf4' : '#ffffff',
                      border: modified ? '1.5px solid #f59e0b' : isInspected ? '1.5px solid #86efac' : '1px solid #e2e8f0',
                      borderRadius: 12,
                      padding: isMobile ? '10px 10px' : '12px 14px',
                      boxShadow: modified ? '0 4px 12px rgba(245, 158, 11, 0.12)' : isInspected ? '0 2px 6px rgba(22, 163, 74, 0.08)' : '0 1px 3px rgba(0,0,0,0.04)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      width: '100%',
                      boxSizing: 'border-box',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Card Top: №, Category, Status & Modified / Inspected Badge */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>#{idx + 1}</span>
                        <span
                          style={{
                            background: '#f1f5f9',
                            color: '#334155',
                            fontSize: 11,
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: 6,
                            whiteSpace: 'nowrap',
                            maxWidth: isMobile ? 130 : 180,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          {p.category_name}
                        </span>
                        {(p.sku || p.barcode) && (
                          <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                            {p.barcode || p.sku}
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 6,
                            background: totalQty > 0 ? '#dcfce7' : '#fee2e2',
                            color: totalQty > 0 ? '#15803d' : '#b91c1c'
                          }}
                        >
                          {totalQty > 0 ? `${totalQty} dona` : 'Tugagan'}
                        </span>
                        {modified && (
                          <span
                            style={{
                              background: '#fef3c7',
                              color: '#b45309',
                              border: '1px solid #fcd34d',
                              fontSize: 10,
                              fontWeight: 800,
                              padding: '2px 5px',
                              borderRadius: 5
                            }}
                          >
                            O‘zgardi
                          </span>
                        )}
                        {!modified && isInspected && (
                          <span
                            style={{
                              background: '#dcfce7',
                              color: '#15803d',
                              border: '1px solid #86efac',
                              fontSize: 10,
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: 5,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3
                            }}
                            title="Ushbu tovar ko‘zdan kechirilgan"
                          >
                            <CheckCircle2 size={11} />
                            Tekshirildi
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Product Name (Editable) */}
                    <div>
                      <input
                        type="text"
                        value={p.name}
                        onChange={e => handleFieldChange(p.product_id, 'name', e.target.value)}
                        placeholder="Mahsulot nomi"
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          borderRadius: 7,
                          border: p.name !== p.orig_name ? '1.5px solid #f59e0b' : '1px solid #cbd5e1',
                          fontWeight: 700,
                          fontSize: 13,
                          outline: 'none',
                          background: p.name !== p.orig_name ? '#fef3c7' : '#fff',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>

                    {/* Quantities: Do'konda & Omborda Steppers */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {/* Do'konda */}
                      <div
                        style={{
                          background: storeChanged ? '#f0f9ff' : '#f8fafc',
                          border: storeChanged ? '1.5px solid #0284c7' : '1px solid #e2e8f0',
                          borderRadius: 8,
                          padding: '6px 6px',
                          minWidth: 0
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: '#0369a1', display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Store size={11} /> Do‘konda
                          </span>
                          {storeChanged && (
                            <span style={{ fontSize: 9.5, color: '#0284c7', fontWeight: 800 }}>
                              {storeQty > p.orig_store_qty ? `+${storeQty - p.orig_store_qty}` : storeQty - p.orig_store_qty}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <button
                            type="button"
                            onClick={() => stepQty(p.product_id, 'store_qty', -1)}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 5,
                              border: '1px solid #cbd5e1',
                              background: '#fff',
                              fontSize: 14,
                              fontWeight: 800,
                              cursor: 'pointer',
                              display: 'grid',
                              placeItems: 'center',
                              color: '#334155',
                              flexShrink: 0
                            }}
                          >
                            <Minus size={11} />
                          </button>
                          <input
                            type="number"
                            min="0"
                            value={p.store_qty}
                            onChange={e => handleFieldChange(p.product_id, 'store_qty', e.target.value)}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              width: '100%',
                              height: 28,
                              textAlign: 'center',
                              fontSize: 13,
                              fontWeight: 800,
                              borderRadius: 5,
                              border: '1px solid #cbd5e1',
                              background: storeChanged ? '#e0f2fe' : '#fff',
                              color: '#0f172a',
                              outline: 'none',
                              padding: 0,
                              boxSizing: 'border-box'
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => stepQty(p.product_id, 'store_qty', 1)}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 5,
                              border: '1px solid #cbd5e1',
                              background: '#fff',
                              fontSize: 14,
                              fontWeight: 800,
                              cursor: 'pointer',
                              display: 'grid',
                              placeItems: 'center',
                              color: '#334155',
                              flexShrink: 0
                            }}
                          >
                            <Plus size={11} />
                          </button>
                        </div>
                      </div>

                      {/* Omborda */}
                      <div
                        style={{
                          background: warehouseChanged ? '#f0f9ff' : '#f8fafc',
                          border: warehouseChanged ? '1.5px solid #0284c7' : '1px solid #e2e8f0',
                          borderRadius: 8,
                          padding: '6px 6px',
                          minWidth: 0
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: '#334155', display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Warehouse size={11} /> Omborda
                          </span>
                          {warehouseChanged && (
                            <span style={{ fontSize: 9.5, color: '#0284c7', fontWeight: 800 }}>
                              {warehouseQty > p.orig_warehouse_qty ? `+${warehouseQty - p.orig_warehouse_qty}` : warehouseQty - p.orig_warehouse_qty}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <button
                            type="button"
                            onClick={() => stepQty(p.product_id, 'warehouse_qty', -1)}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 5,
                              border: '1px solid #cbd5e1',
                              background: '#fff',
                              fontSize: 14,
                              fontWeight: 800,
                              cursor: 'pointer',
                              display: 'grid',
                              placeItems: 'center',
                              color: '#334155',
                              flexShrink: 0
                            }}
                          >
                            <Minus size={11} />
                          </button>
                          <input
                            type="number"
                            min="0"
                            value={p.warehouse_qty}
                            onChange={e => handleFieldChange(p.product_id, 'warehouse_qty', e.target.value)}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              width: '100%',
                              height: 28,
                              textAlign: 'center',
                              fontSize: 13,
                              fontWeight: 800,
                              borderRadius: 5,
                              border: '1px solid #cbd5e1',
                              background: warehouseChanged ? '#e0f2fe' : '#fff',
                              color: '#0f172a',
                              outline: 'none',
                              padding: 0,
                              boxSizing: 'border-box'
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => stepQty(p.product_id, 'warehouse_qty', 1)}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 5,
                              border: '1px solid #cbd5e1',
                              background: '#fff',
                              fontSize: 14,
                              fontWeight: 800,
                              cursor: 'pointer',
                              display: 'grid',
                              placeItems: 'center',
                              color: '#334155',
                              flexShrink: 0
                            }}
                          >
                            <Plus size={11} />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Prices: Tannarx, Sotish narxi, Tafovut (Guaranteed 3 equal columns with minWidth: 0) */}
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: isMobile ? '6px 8px' : '8px 10px', border: '1px solid #e2e8f0', width: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4, width: '100%' }}>
                        {/* Tannarx */}
                        <div style={{ minWidth: 0, overflow: 'hidden' }}>
                          <span style={{ display: 'block', fontSize: 9.5, color: '#64748b', fontWeight: 700, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            Tannarx
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
                            <span style={{ fontSize: 10, color: '#64748b', flexShrink: 0 }}>$</span>
                            <input
                              type="number"
                              step="0.01"
                              value={p.cost_price_usd}
                              onChange={e => handleFieldChange(p.product_id, 'cost_price_usd', e.target.value)}
                              style={{
                                width: '100%',
                                minWidth: 0,
                                height: 26,
                                fontSize: 11,
                                fontWeight: 700,
                                padding: '0 3px',
                                borderRadius: 5,
                                border: '1px solid #cbd5e1',
                                background: '#fff',
                                outline: 'none',
                                boxSizing: 'border-box'
                              }}
                            />
                          </div>
                          <span style={{ display: 'block', fontSize: 9, color: '#94a3b8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {Number(p.cost_price || 0).toLocaleString()} so‘m
                          </span>
                        </div>

                        {/* Sotish narxi */}
                        <div style={{ minWidth: 0, overflow: 'hidden' }}>
                          <span style={{ display: 'block', fontSize: 9.5, color: '#0369a1', fontWeight: 700, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            Sotish
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
                            <span style={{ fontSize: 10, color: '#0369a1', flexShrink: 0 }}>$</span>
                            <input
                              type="number"
                              step="0.01"
                              value={p.retail_price_usd}
                              onChange={e => handleFieldChange(p.product_id, 'retail_price_usd', e.target.value)}
                              style={{
                                width: '100%',
                                minWidth: 0,
                                height: 26,
                                fontSize: 11,
                                fontWeight: 700,
                                padding: '0 3px',
                                borderRadius: 5,
                                border: '1.5px solid #38bdf8',
                                background: '#f0f9ff',
                                outline: 'none',
                                boxSizing: 'border-box'
                              }}
                            />
                          </div>
                          <span style={{ display: 'block', fontSize: 9, color: '#0369a1', fontWeight: 600, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {Number(p.retail_price || 0).toLocaleString()} so‘m
                          </span>
                        </div>

                        {/* Tafovut */}
                        <div style={{ minWidth: 0, overflow: 'hidden' }}>
                          <span style={{ display: 'block', fontSize: 9.5, color: diffUsd >= 0 ? '#15803d' : '#dc2626', fontWeight: 700, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            Tafovut
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
                            <span style={{ fontSize: 10, color: diffUsd >= 0 ? '#15803d' : '#dc2626', flexShrink: 0 }}>$</span>
                            <input
                              type="number"
                              step="0.01"
                              value={p.diff_usd}
                              onChange={e => handleFieldChange(p.product_id, 'diff_usd', e.target.value)}
                              title="Tafovutni o‘zgartirganda sotish narxi avtomatik hisoblanadi"
                              style={{
                                width: '100%',
                                minWidth: 0,
                                height: 26,
                                fontSize: 11,
                                fontWeight: 800,
                                padding: '0 3px',
                                borderRadius: 5,
                                border: '1.5px solid #86efac',
                                background: diffUsd >= 0 ? '#f0fdf4' : '#fee2e2',
                                color: diffUsd >= 0 ? '#15803d' : '#dc2626',
                                outline: 'none',
                                boxSizing: 'border-box'
                              }}
                            />
                          </div>
                          <span style={{ display: 'block', fontSize: 9, color: diffUzs >= 0 ? '#15803d' : '#dc2626', fontWeight: 700, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {diffUzs >= 0 ? '+' : ''}{diffUzs.toLocaleString()} so‘m
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Card Actions (if modified save/revert, else toggle inspected) */}
                    {modified ? (
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        <button
                          type="button"
                          onClick={() => saveSingleRow(p)}
                          disabled={saving || isRowSaving}
                          style={{
                            flex: 1,
                            height: 32,
                            background: '#16a34a',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            fontWeight: 700,
                            fontSize: 11.5,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            cursor: 'pointer'
                          }}
                        >
                          {isRowSaving ? <RefreshCw size={12} className="spin" /> : <Save size={12} />}
                          {isRowSaving ? 'Saqlanmoqda…' : 'O‘zgarishni saqlash'}
                        </button>
                        <button
                          type="button"
                          onClick={() => revertRow(p.product_id)}
                          disabled={saving || isRowSaving}
                          style={{
                            height: 32,
                            padding: '0 10px',
                            background: '#f1f5f9',
                            border: '1px solid #cbd5e1',
                            color: '#475569',
                            borderRadius: 6,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer'
                          }}
                          title="Bekor qilish"
                        >
                          <RotateCcw size={12} />
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        <button
                          type="button"
                          onClick={() => toggleInspected(p.product_id)}
                          style={{
                            flex: 1,
                            height: 32,
                            background: isInspected ? '#f0fdf4' : '#fff',
                            color: isInspected ? '#15803d' : '#334155',
                            border: isInspected ? '1.5px solid #16a34a' : '1px solid #cbd5e1',
                            borderRadius: 6,
                            fontWeight: 700,
                            fontSize: 11.5,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 5,
                            cursor: 'pointer',
                            boxShadow: isInspected ? '0 1px 3px rgba(22,163,74,0.15)' : 'none'
                          }}
                          title={isInspected ? 'Tekshirilganlik belgisini bekor qilish' : 'Do‘kondagi soni to‘g‘ri, ko‘zdan kechirildi deb belgilash'}
                        >
                          {isInspected ? <CheckCircle2 size={13} color="#16a34a" /> : <Check size={13} color="#64748b" />}
                          {isInspected ? '✓ Ko‘zdan kechirildi' : 'Ko‘zdan kechirildi deb belgilash'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* Table View - Highly Optimized for Landscape Mobile & Large Screens */
            <div style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              {isMobile && (
                <div style={{ padding: '6px 10px', background: '#eff6ff', color: '#1e40af', fontSize: 11, fontWeight: 600, borderBottom: '1px solid #bfdbfe' }}>
                  📱 Telefonni albom (gorizontal) rejimga aylantirganingizda barcha tahririy ustunlar ekranga to‘liq sig‘adi.
                </div>
              )}
              <table
                style={{
                  minWidth: isMobile ? 660 : 860,
                  width: '100%',
                  borderCollapse: 'separate',
                  borderSpacing: 0,
                  fontSize: 12,
                  textAlign: 'left'
                }}
              >
                <thead>
                  <tr style={{ background: '#0f172a', color: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
                    <th style={thStyle({ width: 32, textAlign: 'center', padding: '8px 4px' })}>№</th>
                    <th style={thStyle({ minWidth: 150, padding: '8px 8px' })}>Mahsulot</th>
                    <th style={thStyle({ width: 80, textAlign: 'center', background: '#0284c7', padding: '8px 4px' })}>
                      <Store size={12} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }} />
                      Do‘konda
                    </th>
                    <th style={thStyle({ width: 80, textAlign: 'center', background: '#0284c7', padding: '8px 4px' })}>
                      <Warehouse size={12} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }} />
                      Omborda
                    </th>
                    <th style={thStyle({ width: 46, textAlign: 'center', padding: '8px 4px' })}>Jami</th>
                    <th style={thStyle({ width: 78, textAlign: 'right', padding: '8px 6px' })}>Tannarx ($)</th>
                    <th style={thStyle({ width: 78, textAlign: 'right', padding: '8px 6px' })}>Sotish ($)</th>
                    <th style={thStyle({ width: 78, textAlign: 'right', background: '#059669', padding: '8px 6px' })}>Tafovut ($)</th>
                    <th style={thStyle({ width: 96, textAlign: 'center', padding: '8px 4px' })}>Holat / Amal</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((p, idx) => {
                    const modified = isRowModified(p);
                    const isInspected = !!inspectedMap[p.product_id];
                    const storeQty = Number(p.store_qty) || 0;
                    const warehouseQty = Number(p.warehouse_qty) || 0;
                    const totalQty = storeQty + warehouseQty;
                    const diffUsd = Number(p.diff_usd) || 0;
                    const diffUzs = Number(p.diff_uzs) || 0;

                    const storeChanged = storeQty !== Number(p.orig_store_qty);
                    const warehouseChanged = warehouseQty !== Number(p.orig_warehouse_qty);
                    const isRowSaving = savingRowId === p.product_id;

                    return (
                      <tr
                        key={p.product_id}
                        style={{
                          background: modified ? '#fffbeb' : isInspected ? '#f0fdf4' : idx % 2 === 0 ? '#fff' : '#f8fafc',
                          borderBottom: '1px solid #e2e8f0',
                          borderLeft: isInspected ? '3px solid #16a34a' : modified ? '3px solid #f59e0b' : '3px solid transparent',
                          transition: 'background 0.15s ease'
                        }}
                      >
                        {/* № */}
                        <td style={tdStyle({ textAlign: 'center', color: '#64748b', padding: '6px 4px', fontSize: 11 })}>
                          {idx + 1}
                        </td>

                        {/* Mahsulot nomi (Editable) + Category & SKU badges underneath */}
                        <td style={tdStyle({ padding: '6px 8px', minWidth: 150 })}>
                          <input
                            type="text"
                            value={p.name}
                            onChange={e => handleFieldChange(p.product_id, 'name', e.target.value)}
                            placeholder="Nomi"
                            style={{
                              width: '100%',
                              padding: '4px 6px',
                              borderRadius: 5,
                              border: p.name !== p.orig_name ? '1.5px solid #f59e0b' : '1px solid #cbd5e1',
                              fontWeight: 600,
                              fontSize: 12,
                              outline: 'none',
                              background: p.name !== p.orig_name ? '#fef3c7' : '#fff',
                              boxSizing: 'border-box'
                            }}
                          />
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                            <span
                              style={{
                                background: '#f1f5f9',
                                color: '#475569',
                                fontSize: 9.5,
                                fontWeight: 700,
                                padding: '1px 5px',
                                borderRadius: 4,
                                whiteSpace: 'nowrap',
                                maxWidth: 120,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              }}
                            >
                              {p.category_name}
                            </span>
                            {isInspected && (
                              <span
                                style={{
                                  background: '#dcfce7',
                                  color: '#15803d',
                                  border: '1px solid #86efac',
                                  fontSize: 9.5,
                                  fontWeight: 800,
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 2
                                }}
                                title="Ushbu tovar ko‘zdan kechirilgan"
                              >
                                <CheckCircle2 size={10} />
                                Tekshirildi
                              </span>
                            )}
                            {(p.sku || p.barcode) && (
                              <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>
                                {p.sku || p.barcode}
                              </span>
                            )}
                            {!p._searchExact && searchQuery.trim() && (
                              <span
                                style={{
                                  fontSize: 9,
                                  background: '#fef3c7',
                                  color: '#92400e',
                                  border: '1px solid #fde68a',
                                  padding: '1px 4px',
                                  borderRadius: 4,
                                  fontWeight: 700
                                }}
                                title="Yaqin qidiruv mosligi"
                              >
                                Yaqin
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Do'konda qoldiq (Editable Stepper) */}
                        <td style={tdStyle({ textAlign: 'center', padding: '6px 4px', width: 80 })}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                            <button
                              type="button"
                              onClick={() => stepQty(p.product_id, 'store_qty', -1)}
                              style={{
                                width: 22,
                                height: 24,
                                borderRadius: 4,
                                border: '1px solid #cbd5e1',
                                background: '#fff',
                                fontSize: 13,
                                fontWeight: 800,
                                cursor: 'pointer',
                                display: 'grid',
                                placeItems: 'center',
                                color: '#334155',
                                flexShrink: 0
                              }}
                            >
                              <Minus size={11} />
                            </button>
                            <input
                              type="number"
                              min="0"
                              value={p.store_qty}
                              onChange={e => handleFieldChange(p.product_id, 'store_qty', e.target.value)}
                              style={{
                                width: 34,
                                height: 24,
                                textAlign: 'center',
                                borderRadius: 4,
                                border: storeChanged ? '1.5px solid #0284c7' : '1px solid #86efac',
                                background: storeChanged ? '#e0f2fe' : '#f0fdf4',
                                fontWeight: 800,
                                fontSize: 12,
                                color: '#0f172a',
                                outline: 'none',
                                padding: 0,
                                boxSizing: 'border-box'
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => stepQty(p.product_id, 'store_qty', 1)}
                              style={{
                                width: 22,
                                height: 24,
                                borderRadius: 4,
                                border: '1px solid #cbd5e1',
                                background: '#fff',
                                fontSize: 13,
                                fontWeight: 800,
                                cursor: 'pointer',
                                display: 'grid',
                                placeItems: 'center',
                                color: '#334155',
                                flexShrink: 0
                              }}
                            >
                              <Plus size={11} />
                            </button>
                          </div>
                          {storeChanged && (
                            <div style={{ fontSize: 9.5, color: '#0284c7', fontWeight: 800, textAlign: 'center', marginTop: 1 }}>
                              {storeQty > p.orig_store_qty ? `+${storeQty - p.orig_store_qty}` : storeQty - p.orig_store_qty}
                            </div>
                          )}
                        </td>

                        {/* Omborda qoldiq (Editable Stepper) */}
                        <td style={tdStyle({ textAlign: 'center', padding: '6px 4px', width: 80 })}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                            <button
                              type="button"
                              onClick={() => stepQty(p.product_id, 'warehouse_qty', -1)}
                              style={{
                                width: 22,
                                height: 24,
                                borderRadius: 4,
                                border: '1px solid #cbd5e1',
                                background: '#fff',
                                fontSize: 13,
                                fontWeight: 800,
                                cursor: 'pointer',
                                display: 'grid',
                                placeItems: 'center',
                                color: '#334155',
                                flexShrink: 0
                              }}
                            >
                              <Minus size={11} />
                            </button>
                            <input
                              type="number"
                              min="0"
                              value={p.warehouse_qty}
                              onChange={e => handleFieldChange(p.product_id, 'warehouse_qty', e.target.value)}
                              style={{
                                width: 34,
                                height: 24,
                                textAlign: 'center',
                                borderRadius: 4,
                                border: warehouseChanged ? '1.5px solid #0284c7' : '1px solid #93c5fd',
                                background: warehouseChanged ? '#e0f2fe' : '#eff6ff',
                                fontWeight: 800,
                                fontSize: 12,
                                color: '#0f172a',
                                outline: 'none',
                                padding: 0,
                                boxSizing: 'border-box'
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => stepQty(p.product_id, 'warehouse_qty', 1)}
                              style={{
                                width: 22,
                                height: 24,
                                borderRadius: 4,
                                border: '1px solid #cbd5e1',
                                background: '#fff',
                                fontSize: 13,
                                fontWeight: 800,
                                cursor: 'pointer',
                                display: 'grid',
                                placeItems: 'center',
                                color: '#334155',
                                flexShrink: 0
                              }}
                            >
                              <Plus size={11} />
                            </button>
                          </div>
                          {warehouseChanged && (
                            <div style={{ fontSize: 9.5, color: '#0284c7', fontWeight: 800, textAlign: 'center', marginTop: 1 }}>
                              {warehouseQty > p.orig_warehouse_qty ? `+${warehouseQty - p.orig_warehouse_qty}` : warehouseQty - p.orig_warehouse_qty}
                            </div>
                          )}
                        </td>

                        {/* Jami qoldiq */}
                        <td style={tdStyle({ textAlign: 'center', padding: '6px 4px', width: 46 })}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 5px',
                              borderRadius: 5,
                              fontWeight: 700,
                              fontSize: 11,
                              background: totalQty > 0 ? '#e2e8f0' : '#fee2e2',
                              color: totalQty > 0 ? '#0f172a' : '#b91c1c'
                            }}
                          >
                            {totalQty}
                          </span>
                        </td>

                        {/* Tannarxi USD (Editable) with live UZS amount underneath */}
                        <td style={tdStyle({ textAlign: 'right', padding: '6px 6px', width: 78 })}>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={p.cost_price_usd}
                            onChange={e => handleFieldChange(p.product_id, 'cost_price_usd', e.target.value)}
                            style={{
                              width: '100%',
                              height: 24,
                              padding: '2px 4px',
                              textAlign: 'right',
                              borderRadius: 5,
                              border: p.cost_price_usd !== p.orig_cost_price_usd ? '1.5px solid #f59e0b' : '1px solid #cbd5e1',
                              background: p.cost_price_usd !== p.orig_cost_price_usd ? '#fef3c7' : '#fff',
                              fontWeight: 700,
                              fontSize: 11.5,
                              color: '#0f172a',
                              outline: 'none',
                              boxSizing: 'border-box'
                            }}
                          />
                          <div style={{ fontSize: 9.5, color: '#64748b', textAlign: 'right', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {Number(p.cost_price || 0).toLocaleString()} so‘m
                          </div>
                        </td>

                        {/* Sotish narxi USD (Editable) with live UZS amount underneath */}
                        <td style={tdStyle({ textAlign: 'right', padding: '6px 6px', width: 78 })}>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={p.retail_price_usd}
                            onChange={e => handleFieldChange(p.product_id, 'retail_price_usd', e.target.value)}
                            style={{
                              width: '100%',
                              height: 24,
                              padding: '2px 4px',
                              textAlign: 'right',
                              borderRadius: 5,
                              border: p.retail_price_usd !== p.orig_retail_price_usd ? '1.5px solid #2563eb' : '1px solid #38bdf8',
                              background: p.retail_price_usd !== p.orig_retail_price_usd ? '#eff6ff' : '#f0f9ff',
                              fontWeight: 700,
                              fontSize: 11.5,
                              color: '#0369a1',
                              outline: 'none',
                              boxSizing: 'border-box'
                            }}
                          />
                          <div style={{ fontSize: 9.5, color: '#0284c7', fontWeight: 600, textAlign: 'right', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {Number(p.retail_price || 0).toLocaleString()} so‘m
                          </div>
                        </td>

                        {/* Tafovut USD (Editable) with live UZS amount underneath */}
                        <td style={tdStyle({ textAlign: 'right', padding: '6px 6px', width: 78 })}>
                          <input
                            type="number"
                            step="0.01"
                            value={p.diff_usd}
                            onChange={e => handleFieldChange(p.product_id, 'diff_usd', e.target.value)}
                            title="Tafovutni o‘zgartirganda sotish narxi avtomatik hisoblanadi (Sotish = Tannarx + Tafovut)"
                            style={{
                              width: '100%',
                              height: 24,
                              padding: '2px 4px',
                              textAlign: 'right',
                              borderRadius: 5,
                              border: '1.5px solid #86efac',
                              background: diffUsd >= 0 ? '#f0fdf4' : '#fee2e2',
                              fontWeight: 800,
                              fontSize: 11.5,
                              color: diffUsd >= 0 ? '#15803d' : '#dc2626',
                              outline: 'none',
                              boxSizing: 'border-box'
                            }}
                          />
                          <div style={{ fontSize: 9.5, color: diffUzs >= 0 ? '#15803d' : '#dc2626', fontWeight: 700, textAlign: 'right', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {diffUzs >= 0 ? '+' : ''}{diffUzs.toLocaleString()} so‘m
                          </div>
                        </td>

                        {/* Amal: Row Save / Revert or Mark as Inspected */}
                        <td style={tdStyle({ textAlign: 'center', padding: '6px 4px', width: 96 })}>
                          {modified ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                              <button
                                type="button"
                                onClick={() => saveSingleRow(p)}
                                disabled={saving || isRowSaving}
                                title="Faqat ushbu tovardagi o‘zgarishlarni saqlash (tekshirilgan deb belgilanadi)"
                                style={{
                                  background: '#16a34a',
                                  border: 'none',
                                  color: '#fff',
                                  width: 24,
                                  height: 24,
                                  borderRadius: 5,
                                  display: 'grid',
                                  placeItems: 'center',
                                  cursor: 'pointer'
                                }}
                              >
                                {isRowSaving ? <RefreshCw size={11} className="spin" /> : <Save size={12} />}
                              </button>
                              <button
                                type="button"
                                onClick={() => revertRow(p.product_id)}
                                disabled={saving || isRowSaving}
                                title="O‘zgarishlarni bekor qilish"
                                style={{
                                  background: '#f1f5f9',
                                  border: '1px solid #cbd5e1',
                                  color: '#475569',
                                  width: 24,
                                  height: 24,
                                  borderRadius: 5,
                                  display: 'grid',
                                  placeItems: 'center',
                                  cursor: 'pointer'
                                }}
                              >
                                <RotateCcw size={11} />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleInspected(p.product_id)}
                              style={{
                                background: isInspected ? '#16a34a' : '#fff',
                                color: isInspected ? '#fff' : '#475569',
                                border: isInspected ? '1px solid #15803d' : '1px solid #cbd5e1',
                                padding: '3px 7px',
                                borderRadius: 5,
                                fontSize: 10.5,
                                fontWeight: 700,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                                cursor: 'pointer',
                                boxShadow: isInspected ? '0 1px 2px rgba(22, 163, 74, 0.2)' : 'none',
                                whiteSpace: 'nowrap'
                              }}
                              title={isInspected ? 'Tekshirilgan deb belgilangan. Bekor qilish uchun bosing' : 'Soni va narxi to‘g‘ri bo‘lsa, ko‘zdan kechirilgan deb belgilash'}
                            >
                              {isInspected ? <Check size={11} strokeWidth={3} /> : <Check size={11} />}
                              {isInspected ? 'Tekshirildi' : 'Belgilash'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Bottom Footer */}
        <div
          style={{
            padding: isMobile ? '8px 12px' : '12px 20px',
            borderTop: '1px solid #e2e8f0',
            background: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexShrink: 0
          }}
        >
          <div style={{ fontSize: isMobile ? 11 : 12, color: '#64748b' }}>
            Ko‘rsatilmoqda: <b>{filteredProducts.length}</b> / <b>{products.length}</b>
            {stats.inspectedCount > 0 && (
              <span style={{ marginLeft: 6, color: '#16a34a', fontWeight: 700 }}>
                • {stats.inspectedCount} ta tekshirildi
              </span>
            )}
            {modifiedList.length > 0 && (
              <span style={{ marginLeft: 6, color: '#2563eb', fontWeight: 700 }}>
                • ({modifiedList.length} ta o‘zgargan)
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn btn-outline"
              style={{
                fontSize: isMobile ? 12 : 13,
                height: isMobile ? 34 : 38,
                padding: isMobile ? '0 12px' : '0 16px',
                borderRadius: 8,
                color: '#475569',
                borderColor: '#cbd5e1',
                background: '#fff'
              }}
              onClick={onClose}
            >
              Yopish
            </button>

            {modifiedList.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                style={{
                  fontSize: isMobile ? 12 : 13,
                  height: isMobile ? 34 : 38,
                  padding: isMobile ? '0 14px' : '0 20px',
                  borderRadius: 8,
                  fontWeight: 800,
                  background: '#2563eb',
                  borderColor: '#2563eb',
                  color: '#fff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: '0 4px 6px -1px rgba(37,99,235,0.3)'
                }}
                onClick={saveAllModified}
                disabled={saving}
              >
                <Save size={isMobile ? 14 : 16} />
                {saving ? 'Saqlanmoqda…' : `Saqlash (${modifiedList.length})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function thStyle(overrides = {}) {
  return {
    padding: '10px 10px',
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: '0.02em',
    borderBottom: '2px solid #334155',
    borderRight: '1px solid rgba(255,255,255,0.08)',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    ...overrides
  };
}

function tdStyle(overrides = {}) {
  return {
    padding: '8px 10px',
    borderRight: '1px solid #f1f5f9',
    verticalAlign: 'middle',
    boxSizing: 'border-box',
    ...overrides
  };
}
