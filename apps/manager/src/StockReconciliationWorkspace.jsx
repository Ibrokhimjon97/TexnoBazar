import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Barcode,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  History,
  Info,
  Minus,
  Package,
  PackageCheck,
  PackagePlus,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Scan,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import {
  Modal,
  QrScanButton,
  DualPrice,
  Empty,
  Status,
  useExchangeRate,
  DetongerPrintModal,
  formatMoney,
  formatSecretCostCode
} from '@texnobazar/ui';
import {
  listInventoryBalances,
  resolveProductByCode,
  linkCodeToProduct,
  applyStockReconciliation,
  listStockReconciliations,
  getInventoryReferences,
  getBrowserClient,
  filterAndRankProducts
} from '@texnobazar/data';
import {
  playScanSuccessBeep,
  playScanErrorBeep,
  isAudioEnabled,
  setAudioEnabled
} from './audioAlert';

const extractQr = value => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const m = u.pathname.match(/^\/qr\/([^/]+)\/?$/i);
    return m ? decodeURIComponent(m[1]).trim() : raw;
  } catch {
    return raw;
  }
};

export default function StockReconciliationWorkspace({ branchId, toast }) {
  const rate = useExchangeRate();
  const [activeTab, setActiveTab] = useState('audit'); // 'audit' | 'history'
  const [locations, setLocations] = useState([]);
  const [selectedLocationId, setSelectedLocationId] = useState('');
  
  // Mahsulotlar katalogi va kutilgan qoldiqlar
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Sanalgan birliklar: { [productId]: number }
  const [countedMap, setCountedMap] = useState({});

  // Skanerlash holati
  const [scanCode, setScanCode] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [scanFlash, setScanFlash] = useState(null); // Oxirgi skanerlangan tovar
  const scanInputRef = useRef(null);

  // Tovush sozlamasi
  const [soundOn, setSoundOn] = useState(() => isAudioEnabled());

  // Noma'lum QR kod modal holati
  const [unknownModalOpen, setUnknownModalOpen] = useState(false);
  const [unknownCode, setUnknownCode] = useState('');
  const [unknownSearch, setUnknownSearch] = useState('');
  const [unknownCandidates, setUnknownCandidates] = useState([]);
  const [unknownLinking, setUnknownLinking] = useState(false);

  // Qo'lda tovar qidirib qo'shish
  const [manualSearch, setManualSearch] = useState('');
  const [manualCandidates, setManualCandidates] = useState([]);

  // Filtrlar va qidiruv
  const [filterType, setFilterType] = useState('all'); // 'all' | 'diff' | 'surplus' | 'shortage' | 'matched' | 'uncounted'
  const [tableSearch, setTableSearch] = useState('');

  // Tasdiqlash va tenglashtirish (Sync)
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [syncNotes, setSyncNotes] = useState('');
  const [syncing, setSyncing] = useState(false);

  // Yangi QR chop etish modali (Detonger/MHT)
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printLabels, setPrintLabels] = useState([]);

  // Tarix
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDetail, setHistoryDetail] = useState(null);

  // Excel eksport holati
  const [exportingExcel, setExportingExcel] = useState(false);

  // 1. Filial joylashuvlari va qoralamani yuklash
  useEffect(() => {
    if (!branchId) return;
    getInventoryReferences(branchId)
      .then(res => {
        const locs = res?.locations || [];
        setLocations(locs);
        if (locs.length > 0 && !selectedLocationId) {
          const storeLoc = locs.find(l => l.type === 'store') || locs[0];
          setSelectedLocationId(storeLoc.id);
        }
      })
      .catch(e => setError(e?.message || 'Joylashuvlarni yuklab bo‘lmadi'));

    // LocalStorage dagi qoralamani tiklash
    try {
      const saved = localStorage.getItem(`texnobazar:reconciliation-draft:${branchId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          setCountedMap(parsed);
        }
      }
    } catch {}
  }, [branchId]);

  // CountedMap o'zgarganda LocalStorage ga saqlash
  useEffect(() => {
    if (!branchId) return;
    try {
      localStorage.setItem(`texnobazar:reconciliation-draft:${branchId}`, JSON.stringify(countedMap));
    } catch {}
  }, [branchId, countedMap]);

  // 2. Filial qoldiqlarini yuklash
  const loadBalances = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const res = await listInventoryBalances({
        branchId,
        locationId: selectedLocationId || null,
        pageSize: 5000,
        page: 1
      });
      setProducts(res?.items || []);
    } catch (e) {
      setError(e?.message || 'Qoldiqlarni yuklab bo‘lmadi');
    } finally {
      setLoading(false);
    }
  }, [branchId, selectedLocationId]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  // 3. Tarixni yuklash
  const loadHistory = useCallback(async () => {
    if (!branchId) return;
    setHistoryLoading(true);
    try {
      const res = await listStockReconciliations({ branchId, pageSize: 50 });
      setHistoryList(res?.items || []);
    } catch (e) {
      console.warn('History load error:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab, loadHistory]);

  // 4. Mahsulotlar xaritasi (Lookup Map)
  const productMap = useMemo(() => {
    const map = new Map();
    products.forEach(p => map.set(p.product_id, p));
    return map;
  }, [products]);

  // 5. Matritsa va tafovut hisob-kitoblari
  const matrix = useMemo(() => {
    // Barcha katalog tovarlari + countedMap dagi yangi qo'shilganlar
    const allProductIds = new Set([
      ...products.map(p => p.product_id),
      ...Object.keys(countedMap)
    ]);

    const rows = [];
    let totalExpected = 0;
    let totalCounted = 0;
    let totalSurplus = 0;
    let totalShortage = 0;
    let totalMatched = 0;

    allProductIds.forEach(productId => {
      const p = productMap.get(productId);
      const expected = Number(p?.on_hand ?? 0);
      const counted = Number(countedMap[productId] ?? 0);
      const variance = counted - expected;

      totalExpected += expected;
      totalCounted += counted;

      let status = 'uncounted'; // 'matched' | 'surplus' | 'shortage' | 'uncounted'
      if (counted > 0 || expected === 0) {
        if (variance === 0) {
          status = counted > 0 ? 'matched' : 'uncounted';
          if (counted > 0) totalMatched++;
        } else if (variance > 0) {
          status = 'surplus';
          totalSurplus += variance;
        } else {
          status = 'shortage';
          totalShortage += Math.abs(variance);
        }
      } else {
        totalShortage += expected;
      }

      rows.push({
        productId,
        product: p,
        name: p?.product_name || 'Noma‘lum tovar',
        sku: p?.sku || '—',
        barcode: p?.barcode || '—',
        categoryName: p?.category_name || 'Toifasiz',
        retailPrice: Number(p?.retail_price || 0),
        retailPriceUsd: Number(p?.retail_price_usd || 0),
        costPrice: Number(p?.cost_price || 0),
        costPriceUsd: Number(p?.cost_price_usd || 0),
        expected,
        counted,
        variance,
        status
      });
    });

    return {
      rows,
      totalExpected,
      totalCounted,
      totalSurplus,
      totalShortage,
      totalMatched,
      diffCount: rows.filter(r => r.variance !== 0).length
    };
  }, [products, countedMap, productMap]);

  // Filtrlangan qatorlar
  const filteredRows = useMemo(() => {
    let list = matrix.rows;

    if (filterType === 'diff') {
      list = list.filter(r => r.variance !== 0);
    } else if (filterType === 'surplus') {
      list = list.filter(r => r.variance > 0);
    } else if (filterType === 'shortage') {
      list = list.filter(r => r.variance < 0);
    } else if (filterType === 'matched') {
      list = list.filter(r => r.status === 'matched');
    } else if (filterType === 'uncounted') {
      list = list.filter(r => r.counted === 0 && r.expected > 0);
    }

    if (tableSearch.trim()) {
      const res = filterAndRankProducts(list, tableSearch, {
        fields: ['name', 'sku', 'barcode', 'categoryName'],
        minScore: 50
      });
      return res.items;
    }

    return list.sort((a, b) => {
      // Birinchi navbatda farqi borlar
      if (Math.abs(b.variance) !== Math.abs(a.variance)) {
        return Math.abs(b.variance) - Math.abs(a.variance);
      }
      return a.name.localeCompare(b.name);
    });
  }, [matrix.rows, filterType, tableSearch]);

  // 6. QR Kodni tezkor skanerlash
  const handleScanSubmit = async e => {
    e?.preventDefault();
    const raw = scanCode;
    const clean = extractQr(raw);
    if (!clean) return;

    setScanBusy(true);
    try {
      const res = await resolveProductByCode(branchId, clean);
      if (res?.found && res.product) {
        const prod = res.product;
        // Tovush
        if (soundOn) playScanSuccessBeep();

        // Sanalganlar sonini oshiramiz
        setCountedMap(prev => {
          const current = Number(prev[prod.id] ?? 0);
          return { ...prev, [prod.id]: current + 1 };
        });

        const expected = Number(prod.branch_stock ?? 0);
        const newCounted = Number(countedMap[prod.id] ?? 0) + 1;

        setScanFlash({
          product: prod,
          counted: newCounted,
          expected,
          variance: newCounted - expected,
          timestamp: Date.now()
        });

        setScanCode('');
      } else {
        // Topilmadi! Noma'lum QR modalini ochamiz
        if (soundOn) playScanErrorBeep();
        setUnknownCode(clean);
        setUnknownSearch('');
        setUnknownCandidates(products.slice(0, 15));
        setUnknownModalOpen(true);
        setScanCode('');
      }
    } catch (err) {
      if (soundOn) playScanErrorBeep();
      setUnknownCode(clean);
      setUnknownSearch('');
      setUnknownCandidates(products.slice(0, 15));
      setUnknownModalOpen(true);
      setScanCode('');
    } finally {
      setScanBusy(false);
      scanInputRef.current?.focus();
    }
  };

  // Noma'lum QR kod bo'yicha tovar qidirish
  useEffect(() => {
    if (!unknownModalOpen || !unknownSearch.trim()) {
      setUnknownCandidates(products.slice(0, 20));
      return;
    }
    const res = filterAndRankProducts(products, unknownSearch, {
      fields: ['product_name', 'name', 'sku', 'barcode'],
      minScore: 50
    });
    setUnknownCandidates(res.items.slice(0, 25));
  }, [unknownSearch, unknownModalOpen, products]);

  // Noma'lum QR kodni tanlangan tovarga bog'lash va sanalganlarga qo'shish
  const handleLinkUnknownProduct = async (selectedProduct, linkPermanently = true) => {
    if (!selectedProduct) return;
    setUnknownLinking(true);
    try {
      if (linkPermanently && unknownCode) {
        await linkCodeToProduct(unknownCode, selectedProduct.product_id || selectedProduct.id, 'Reviziya paytida biriktirildi');
      }

      const prodId = selectedProduct.product_id || selectedProduct.id;
      setCountedMap(prev => ({
        ...prev,
        [prodId]: Number(prev[prodId] ?? 0) + 1
      }));

      if (soundOn) playScanSuccessBeep();
      toast?.(`"${selectedProduct.product_name || selectedProduct.name}" sanalganlarga qo‘shildi`);
      setUnknownModalOpen(false);
      setUnknownCode('');
      scanInputRef.current?.focus();
    } catch (e) {
      toast?.(e?.message || 'QR kodni biriktirib bo‘lmadi');
    } finally {
      setUnknownLinking(false);
    }
  };

  // 7. Qo'lda tovar qidirib qo'shish (Stikeri yo'q tovarlar)
  useEffect(() => {
    if (!manualSearch.trim()) {
      setManualCandidates([]);
      return;
    }
    const res = filterAndRankProducts(products, manualSearch, {
      fields: ['product_name', 'name', 'sku', 'barcode'],
      minScore: 50
    });
    setManualCandidates(res.items.slice(0, 8));
  }, [manualSearch, products]);

  const handleManualAddProduct = (p, qty = 1) => {
    const prodId = p.product_id || p.id;
    setCountedMap(prev => ({
      ...prev,
      [prodId]: Number(prev[prodId] ?? 0) + qty
    }));
    if (soundOn) playScanSuccessBeep();
    setManualSearch('');
    setManualCandidates([]);
    toast?.(`"${p.product_name || p.name}" (+${qty}) qo‘shildi`);
    scanInputRef.current?.focus();
  };

  // Sonni oshirish / kamaytirish
  const handleAdjustCount = (productId, delta) => {
    setCountedMap(prev => {
      const current = Number(prev[productId] ?? 0);
      const next = Math.max(0, current + delta);
      if (next === 0) {
        const copy = { ...prev };
        delete copy[productId];
        return copy;
      }
      return { ...prev, [productId]: next };
    });
  };

  // Barcha sanalganlarni tozalash (Reset)
  const handleResetCounts = () => {
    if (!window.confirm('Barcha sanalgan tovarlar sonini nollashtirib, qayta boshlaysizmi?')) return;
    setCountedMap({});
    setScanFlash(null);
    try {
      localStorage.removeItem(`texnobazar:reconciliation-draft:${branchId}`);
    } catch {}
    toast?.('Sanash nollashtirildi');
    scanInputRef.current?.focus();
  };

  // 8. Qoldiqlarni tenglashtirish (Apply Reconciliation)
  const handleApplyReconciliation = async () => {
    const items = matrix.rows.map(r => ({
      product_id: r.productId,
      expected: r.expected,
      counted: r.counted,
      variance: r.variance
    }));

    setSyncing(true);
    try {
      const res = await applyStockReconciliation({
        branchId,
        locationId: selectedLocationId || null,
        items,
        notes: syncNotes.trim() || null
      });

      if (res?.success) {
        toast?.(`Reviziya #${res.reconciliation_no} muvaffaqiyatli saqlandi va dastur qoldiqlari tenglashtirildi!`);
        setConfirmModalOpen(false);
        setSyncNotes('');

        // Agar yangi ortiqcha birliklar bo'lsa, chop etish modalini taklif qilamiz
        if (res.new_labels && res.new_labels.length > 0) {
          setPrintLabels(res.new_labels);
          setPrintModalOpen(true);
        }

        // Qayta yuklash
        await loadBalances();
        // Sanalganlarni yangilash
        setCountedMap({});
        try {
          localStorage.removeItem(`texnobazar:reconciliation-draft:${branchId}`);
        } catch {}
      }
    } catch (e) {
      toast?.(e?.message || 'Qoldiqlarni tenglashtirishda xatolik yuz berdi');
    } finally {
      setSyncing(false);
    }
  };

  // 9. Excel ga eksport qilish
  const handleExportExcel = async () => {
    setExportingExcel(true);
    try {
      const ExcelJS = (await import('exceljs')).default || (await import('exceljs'));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Reviziya Solishtirish');

      ws.columns = [
        { header: '№', key: 'idx', width: 6 },
        { header: 'Mahsulot nomi', key: 'name', width: 34 },
        { header: 'Toifa', key: 'category', width: 18 },
        { header: 'SKU / Kod', key: 'sku', width: 14 },
        { header: 'Shtrix-kod', key: 'barcode', width: 16 },
        { header: 'Dasturda (Kutilgan)', key: 'expected', width: 18 },
        { header: 'Do‘konda (Sanaldi)', key: 'counted', width: 18 },
        { header: 'Tafovut (Farq)', key: 'variance', width: 16 },
        { header: 'Chakana narx ($)', key: 'price_usd', width: 16 },
        { header: 'Chakana narx (UZS)', key: 'price_uzs', width: 18 },
        { header: 'Holat', key: 'status', width: 18 }
      ];

      // Sarlavha stil
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

      matrix.rows.forEach((r, idx) => {
        let statusText = 'Mos';
        if (r.variance > 0) statusText = `Ortiqcha (+${r.variance})`;
        else if (r.variance < 0) statusText = `Kamomad (${r.variance})`;
        else if (r.status === 'uncounted') statusText = 'Sanalmadi';

        const row = ws.addRow({
          idx: idx + 1,
          name: r.name,
          category: r.categoryName,
          sku: r.sku,
          barcode: r.barcode,
          expected: r.expected,
          counted: r.counted,
          variance: r.variance > 0 ? `+${r.variance}` : r.variance,
          price_usd: r.retailPriceUsd || 0,
          price_uzs: r.retailPrice || 0,
          status: statusText
        });

        // Ranglar bilan ajratish
        if (r.variance > 0) {
          row.getCell('variance').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }; // Ko'k
          row.getCell('status').font = { color: { argb: 'FF1D4ED8' }, bold: true };
        } else if (r.variance < 0) {
          row.getCell('variance').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }; // Qizil
          row.getCell('status').font = { color: { argb: 'FFB91C1C' }, bold: true };
        } else if (r.status === 'matched') {
          row.getCell('status').font = { color: { argb: 'FF15803D' } };
        }
      });

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateTag = new Date().toISOString().slice(0, 10);
      a.download = `Reviziya_Solishtirish_${dateTag}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast?.('Excel fayl muvaffaqiyatli yuklab olindi');
    } catch (e) {
      toast?.('Excel yuklashda xatolik yuz berdi');
    } finally {
      setExportingExcel(false);
    }
  };

  return (
    <section className="ops-workspace" style={{ maxWidth: 1200, margin: '0 auto', paddingBottom: 80 }}>
      {/* 1. Header */}
      <div className="m-page-head between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Scan size={26} color="#f97316" />
            Reviziya va Qoldiq Solishtirish
          </h2>
          <p style={{ margin: '4px 0 0', color: '#64748b' }}>
            Do‘kondagi tovarlarning real sonini dastur qoldig‘i bilan taqqoslash va 1 tugma bilan tenglashtirish
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Joylashuv tanlash */}
          {locations.length > 1 && (
            <select
              className="select"
              style={{ width: 'auto', minWidth: 160, height: 38 }}
              value={selectedLocationId}
              onChange={e => setSelectedLocationId(e.target.value)}
            >
              {locations.map(loc => (
                <option key={loc.id} value={loc.id}>
                  {loc.name} ({loc.type === 'store' ? 'Do‘kon' : 'Ombor'})
                </option>
              ))}
            </select>
          )}

          {/* Tovush switch */}
          <button
            type="button"
            className="btn btn-outline"
            style={{ padding: '0 10px', height: 38 }}
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              setAudioEnabled(next);
            }}
            title={soundOn ? 'Tovushli signal yoqilgan' : 'Tovush o‘chirilgan'}
          >
            {soundOn ? <Volume2 size={18} color="#16a34a" /> : <VolumeX size={18} color="#94a3b8" />}
          </button>

          {/* Tablar */}
          <div className="ops-tabs" style={{ margin: 0 }}>
            <button
              className={activeTab === 'audit' ? 'active' : ''}
              onClick={() => setActiveTab('audit')}
            >
              <Scan size={15} style={{ verticalAlign: 'middle', marginRight: 5 }} />
              Jonli Sanash
            </button>
            <button
              className={activeTab === 'history' ? 'active' : ''}
              onClick={() => setActiveTab('history')}
            >
              <History size={15} style={{ verticalAlign: 'middle', marginRight: 5 }} />
              Tarix
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'audit' ? (
        <>
          {/* 2. Statistik Kartalar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              marginBottom: 16
            }}
          >
            <div className="card" style={{ padding: '14px 16px', background: '#fff' }}>
              <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>Jami sanaldi</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
                <b style={{ fontSize: 24, color: '#0f172a' }}>{matrix.totalCounted}</b>
                <span style={{ fontSize: 13, color: '#64748b' }}>/ {matrix.totalExpected} dona</span>
              </div>
            </div>

            <div className="card" style={{ padding: '14px 16px', background: '#f0fdf4', borderColor: '#bbf7d0' }}>
              <span style={{ fontSize: 11, color: '#166534', fontWeight: 600 }}>🟢 Mos kelganlar</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
                <b style={{ fontSize: 24, color: '#15803d' }}>{matrix.totalMatched}</b>
                <span style={{ fontSize: 12, color: '#166534' }}>ta tovar</span>
              </div>
            </div>

            <div className="card" style={{ padding: '14px 16px', background: '#eff6ff', borderColor: '#bfdbfe' }}>
              <span style={{ fontSize: 11, color: '#1e40af', fontWeight: 600 }}>🔵 Ortiqcha chiqqanlar</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
                <b style={{ fontSize: 24, color: '#2563eb' }}>+{matrix.totalSurplus}</b>
                <span style={{ fontSize: 12, color: '#1e40af' }}>dona ortiqcha</span>
              </div>
            </div>

            <div className="card" style={{ padding: '14px 16px', background: '#fef2f2', borderColor: '#fecaca' }}>
              <span style={{ fontSize: 11, color: '#991b1b', fontWeight: 600 }}>🔴 Kamomadlar</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
                <b style={{ fontSize: 24, color: '#dc2626' }}>-{matrix.totalShortage}</b>
                <span style={{ fontSize: 12, color: '#991b1b' }}>dona kam</span>
              </div>
            </div>
          </div>

          {/* 3. Tezkor Skanerlash Paneli (High-Speed Continuous Scanner) */}
          <div
            className="card"
            style={{
              padding: 18,
              background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
              color: '#fff',
              marginBottom: 16,
              boxShadow: '0 8px 24px rgba(15,23,42,0.15)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <QrCode size={20} color="#fb923c" />
                <span style={{ fontWeight: 700, fontSize: 14 }}>To‘xtovsiz QR va Shtrix-kod Skaner</span>
                <span style={{ fontSize: 11, background: '#334155', color: '#cbd5e1', padding: '2px 8px', borderRadius: 12 }}>
                  Oqimli rejim
                </span>
              </div>
              <small style={{ color: '#94a3b8' }}>Har bir skanerlash +1 qo‘shadi</small>
            </div>

            <form onSubmit={handleScanSubmit} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input
                  ref={scanInputRef}
                  type="text"
                  className="input"
                  autoFocus
                  placeholder="QR kod yoki shtrix-kodni ketma-ket skanerlang…"
                  value={scanCode}
                  onChange={e => setScanCode(e.target.value)}
                  style={{
                    height: 48,
                    fontSize: 16,
                    paddingLeft: 14,
                    paddingRight: 40,
                    background: '#fff',
                    color: '#0f172a',
                    borderRadius: 12,
                    border: '2px solid #fb923c',
                    width: '100%',
                    fontWeight: 600
                  }}
                />
                {scanCode && (
                  <button
                    type="button"
                    onClick={() => setScanCode('')}
                    style={{
                      position: 'absolute',
                      right: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      border: 0,
                      background: 'none',
                      color: '#94a3b8',
                      cursor: 'pointer'
                    }}
                  >
                    <X size={18} />
                  </button>
                )}
              </div>

              <QrScanButton
                onScan={scanned => {
                  setScanCode(scanned);
                  setTimeout(() => {
                    handleScanSubmit();
                  }, 100);
                }}
              />

              <button
                type="submit"
                className="btn btn-primary"
                disabled={scanBusy || !scanCode.trim()}
                style={{ height: 48, padding: '0 20px', fontWeight: 700, borderRadius: 12 }}
              >
                {scanBusy ? 'Izlanmoqda…' : 'Sanash'}
              </button>
            </form>

            {/* Oxirgi skanerlangan tovar Flashi */}
            {scanFlash && (
              <div
                style={{
                  marginTop: 14,
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    background: '#334155',
                    overflow: 'hidden',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0
                  }}
                >
                  {scanFlash.product.image_url ? (
                    <img
                      src={scanFlash.product.image_url}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Package size={22} color="#94a3b8" />
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <b style={{ color: '#fff', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {scanFlash.product.name}
                    </b>
                    <span style={{ fontSize: 10, color: '#cbd5e1' }}>({scanFlash.product.sku})</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 3 }}>
                    <span style={{ fontSize: 12, color: '#fb923c', fontWeight: 700 }}>
                      Sanaldi: {scanFlash.counted} dona
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>
                      Dasturda: {scanFlash.expected} dona
                    </span>
                    {scanFlash.variance > 0 ? (
                      <span style={{ fontSize: 11, color: '#60a5fa', fontWeight: 700 }}>
                        (+{scanFlash.variance} ortiqcha)
                      </span>
                    ) : scanFlash.variance < 0 ? (
                      <span style={{ fontSize: 11, color: '#f87171', fontWeight: 700 }}>
                        ({scanFlash.variance} kamomad)
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>
                        (To‘liq mos)
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => handleAdjustCount(scanFlash.product.id, -1)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: 0,
                      background: 'rgba(255,255,255,0.15)',
                      color: '#fff',
                      cursor: 'pointer',
                      display: 'grid',
                      placeItems: 'center'
                    }}
                    title="1 ta kamaytirish"
                  >
                    <Minus size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustCount(scanFlash.product.id, 1)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: 0,
                      background: '#f97316',
                      color: '#fff',
                      cursor: 'pointer',
                      display: 'grid',
                      placeItems: 'center'
                    }}
                    title="1 ta oshirish"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 4. Qo'lda Tovar Qidirib Qo'shish (Stikeri yo'q tovarlar uchun) */}
          <div
            className="card"
            style={{
              padding: '12px 16px',
              marginBottom: 16,
              background: '#fff',
              position: 'relative'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Search size={18} color="#64748b" />
              <input
                type="text"
                placeholder="Stikeri yo‘q yoki o‘chgan tovarlarni nomi, modeli yoki SKU bo‘yicha qidirib qo‘shish…"
                value={manualSearch}
                onChange={e => setManualSearch(e.target.value)}
                style={{
                  border: 0,
                  outline: 0,
                  flex: 1,
                  fontSize: 13,
                  fontWeight: 500,
                  padding: '6px 0'
                }}
              />
              {manualSearch && (
                <button
                  type="button"
                  onClick={() => setManualSearch('')}
                  style={{ border: 0, background: 'none', color: '#94a3b8', cursor: 'pointer' }}
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {/* Qidiruv natijalari dropdowni */}
            {manualCandidates.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  zIndex: 200,
                  background: '#fff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 12,
                  boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                  marginTop: 6,
                  maxHeight: 280,
                  overflowY: 'auto'
                }}
              >
                {manualCandidates.map(p => (
                  <div
                    key={p.product_id}
                    onClick={() => handleManualAddProduct(p, 1)}
                    style={{
                      padding: '10px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid #f1f5f9',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    <div>
                      <b style={{ fontSize: 13, color: '#0f172a' }}>{p.product_name}</b>
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                        {p.sku} · {p.category_name || 'Toifasiz'} · Dasturdagi qoldiq: <b>{p.on_hand} dona</b>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600 }}
                    >
                      <Plus size={14} style={{ marginRight: 4 }} /> Sanashga qo‘shish (+1)
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 5. Jadval Filtrlar va Boshqaruv */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginBottom: 12
            }}
          >
            {/* Filtr Tablari */}
            <div className="ops-tabs" style={{ margin: 0 }}>
              <button
                className={filterType === 'all' ? 'active' : ''}
                onClick={() => setFilterType('all')}
              >
                Barchasi ({matrix.rows.length})
              </button>
              <button
                className={filterType === 'diff' ? 'active' : ''}
                onClick={() => setFilterType('diff')}
                style={{ fontWeight: matrix.diffCount > 0 ? 800 : 500 }}
              >
                ⚠️ Faqat farqi borlar ({matrix.diffCount})
              </button>
              <button
                className={filterType === 'surplus' ? 'active' : ''}
                onClick={() => setFilterType('surplus')}
                style={{ color: '#2563eb' }}
              >
                🔵 Ortiqcha ({matrix.rows.filter(r => r.variance > 0).length})
              </button>
              <button
                className={filterType === 'shortage' ? 'active' : ''}
                onClick={() => setFilterType('shortage')}
                style={{ color: '#dc2626' }}
              >
                🔴 Kamomad ({matrix.rows.filter(r => r.variance < 0).length})
              </button>
              <button
                className={filterType === 'matched' ? 'active' : ''}
                onClick={() => setFilterType('matched')}
                style={{ color: '#16a34a' }}
              >
                🟢 Mos kelganlar ({matrix.totalMatched})
              </button>
            </div>

            {/* Qidiruv va Eksport */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div
                style={{
                  background: '#fff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  height: 36,
                  width: 220
                }}
              >
                <Search size={15} color="#94a3b8" />
                <input
                  type="text"
                  placeholder="Jadvaldan izlash…"
                  value={tableSearch}
                  onChange={e => setTableSearch(e.target.value)}
                  style={{ border: 0, outline: 0, padding: '0 8px', fontSize: 12, flex: 1 }}
                />
              </div>

              <button
                type="button"
                className="btn btn-outline"
                style={{ height: 36, padding: '0 12px', fontSize: 12, fontWeight: 600, color: '#16a34a', borderColor: '#86efac' }}
                onClick={handleExportExcel}
                disabled={exportingExcel || matrix.rows.length === 0}
              >
                <FileSpreadsheet size={15} style={{ marginRight: 6 }} />
                {exportingExcel ? 'Eksport…' : 'Excel (.xlsx)'}
              </button>

              {Object.keys(countedMap).length > 0 && (
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ height: 36, padding: '0 10px', fontSize: 12, color: '#dc2626', borderColor: '#fca5a5' }}
                  onClick={handleResetCounts}
                  title="Sanashni nollashtirish"
                >
                  <RotateCcw size={15} style={{ marginRight: 4 }} /> Qayta boshlash
                </button>
              )}
            </div>
          </div>

          {/* 6. Jonli Solishtirish Jadvali */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', background: '#fff' }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>
                <RefreshCw size={28} className="spin" style={{ marginBottom: 12 }} />
                <p>Filial qoldiqlari yuklanmoqda…</p>
              </div>
            ) : filteredRows.length === 0 ? (
              <Empty
                title="Tovarlar topilmadi"
                text={filterType === 'diff' ? 'Barcha tovarlar dastur qoldig‘iga to‘liq mos kelmoqda!' : 'Ushbu filtr bo‘yicha tovarlar mavjud emas.'}
              />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontSize: 11, textTransform: 'uppercase' }}>
                      <th style={{ padding: '12px 16px' }}>Mahsulot</th>
                      <th style={{ padding: '12px 14px' }}>SKU / Kod</th>
                      <th style={{ padding: '12px 14px', textAlign: 'center' }}>Dasturda</th>
                      <th style={{ padding: '12px 14px', textAlign: 'center' }}>Do‘konda Sanaldi</th>
                      <th style={{ padding: '12px 14px', textAlign: 'center' }}>Tafovut</th>
                      <th style={{ padding: '12px 14px' }}>Holat</th>
                      <th style={{ padding: '12px 16px', textAlign: 'right' }}>Amal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(r => {
                      const isSurplus = r.variance > 0;
                      const isShortage = r.variance < 0;
                      const isMatched = r.status === 'matched';

                      return (
                        <tr
                          key={r.productId}
                          style={{
                            borderBottom: '1px solid #f1f5f9',
                            background: isSurplus
                              ? '#eff6ff'
                              : isShortage
                              ? '#fef2f2'
                              : isMatched
                              ? '#f0fdf4'
                              : 'transparent'
                          }}
                        >
                          {/* Mahsulot nomi va rasmi */}
                          <td style={{ padding: '12px 16px', minWidth: 240 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div
                                style={{
                                  width: 40,
                                  height: 40,
                                  borderRadius: 8,
                                  background: '#f1f5f9',
                                  overflow: 'hidden',
                                  display: 'grid',
                                  placeItems: 'center',
                                  flexShrink: 0
                                }}
                              >
                                {r.product?.image_url ? (
                                  <img src={r.product.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                ) : (
                                  <Package size={20} color="#94a3b8" />
                                )}
                              </div>
                              <div>
                                <b style={{ color: '#0f172a', display: 'block' }}>{r.name}</b>
                                <span style={{ fontSize: 11, color: '#64748b' }}>{r.categoryName}</span>
                              </div>
                            </div>
                          </td>

                          {/* SKU va Shtrix-kod */}
                          <td style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>
                            <div>{r.sku}</div>
                            {r.barcode && <small style={{ color: '#94a3b8' }}>{r.barcode}</small>}
                          </td>

                          {/* Dasturdagi son */}
                          <td style={{ padding: '12px 14px', textAlign: 'center', fontWeight: 600 }}>
                            <span style={{ fontSize: 14, color: '#334155' }}>{r.expected}</span>
                          </td>

                          {/* Do'konda sanalgan son */}
                          <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, padding: '2px 4px' }}>
                              <button
                                type="button"
                                onClick={() => handleAdjustCount(r.productId, -1)}
                                style={{ width: 24, height: 24, border: 0, background: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center', color: '#64748b' }}
                                title="1 ta kamaytirish"
                              >
                                <Minus size={12} />
                              </button>
                              <span style={{ minWidth: 26, textAlign: 'center', fontWeight: 800, fontSize: 14, color: r.counted > 0 ? '#0f172a' : '#94a3b8' }}>
                                {r.counted}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleAdjustCount(r.productId, 1)}
                                style={{ width: 24, height: 24, border: 0, background: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center', color: '#f97316' }}
                                title="1 ta oshirish"
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          </td>

                          {/* Tafovut */}
                          <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                            {isSurplus ? (
                              <span style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: '#dbeafe', color: '#1d4ed8', fontWeight: 800, fontSize: 13 }}>
                                +{r.variance} dona
                              </span>
                            ) : isShortage ? (
                              <span style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: '#fee2e2', color: '#b91c1c', fontWeight: 800, fontSize: 13 }}>
                                {r.variance} dona
                              </span>
                            ) : (
                              <span style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: '#dcfce7', color: '#15803d', fontWeight: 700, fontSize: 13 }}>
                                0 (Mos)
                              </span>
                            )}
                          </td>

                          {/* Holat */}
                          <td style={{ padding: '12px 14px' }}>
                            {isSurplus ? (
                              <span style={{ color: '#2563eb', fontWeight: 600, fontSize: 12 }}>
                                🔵 Ortiqcha (Dasturda kam)
                              </span>
                            ) : isShortage ? (
                              <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 12 }}>
                                🔴 Kamomad (Do‘konda kam)
                              </span>
                            ) : isMatched ? (
                              <span style={{ color: '#16a34a', fontWeight: 600, fontSize: 12 }}>
                                🟢 To‘liq mos keldi
                              </span>
                            ) : (
                              <span style={{ color: '#94a3b8', fontSize: 12 }}>
                                Sanalmagan
                              </span>
                            )}
                          </td>

                          {/* Amallar */}
                          <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              {r.counted === 0 && (
                                <button
                                  type="button"
                                  className="btn btn-outline"
                                  style={{ padding: '4px 8px', fontSize: 11 }}
                                  onClick={() => handleAdjustCount(r.productId, r.expected)}
                                  title="Dasturdagi soniga teng deb belgilash"
                                >
                                  To‘liq moslash
                                </button>
                              )}
                              {r.counted > 0 && (
                                <button
                                  type="button"
                                  className="btn btn-outline"
                                  style={{ padding: '4px 8px', fontSize: 11, color: '#dc2626' }}
                                  onClick={() => handleAdjustCount(r.productId, -r.counted)}
                                  title="Nollashtirish"
                                >
                                  <X size={13} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 7. Pastki Sticky Boshqaruv Paneli (Apply CTA) */}
          <div
            style={{
              position: 'fixed',
              bottom: 0,
              left: 0,
              right: 0,
              background: '#fff',
              borderTop: '1px solid #e2e8f0',
              padding: '12px 24px',
              zIndex: 100,
              boxShadow: '0 -4px 16px rgba(0,0,0,0.06)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div>
                <b style={{ fontSize: 15, color: '#0f172a' }}>
                  {matrix.diffCount > 0 ? `${matrix.diffCount} ta tovar bo‘yicha farq aniqlandi` : 'Barcha tovarlar mos'}
                </b>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  Ortiqcha: <b style={{ color: '#2563eb' }}>+{matrix.totalSurplus}</b> · Kamomad: <b style={{ color: '#dc2626' }}>-{matrix.totalShortage}</b>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{
                  height: 44,
                  padding: '0 24px',
                  fontWeight: 700,
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  borderRadius: 10
                }}
                onClick={() => setConfirmModalOpen(true)}
                disabled={matrix.diffCount === 0 || loading}
              >
                <CheckCircle2 size={18} />
                Qoldiqlarni real songa tenglashtirish
              </button>
            </div>
          </div>
        </>
      ) : (
        /* 8. Reviziyalar Tarixi Tab */
        <div className="card" style={{ padding: 20, background: '#fff' }}>
          <h3 style={{ margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <History size={18} color="#f97316" />
            O‘tkazilgan Reviziyalar Jurnali
          </h3>

          {historyLoading ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>
              <RefreshCw size={24} className="spin" style={{ marginBottom: 8 }} />
              <p>Tarix yuklanmoqda…</p>
            </div>
          ) : historyList.length === 0 ? (
            <Empty title="Tarix mavjud emas" text="Ushbu filialda hali reviziya o‘tkazilmagan." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {historyList.map(item => (
                <div
                  key={item.id}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    padding: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <b style={{ fontSize: 15, color: '#0f172a' }}>{item.reconciliation_no}</b>
                      <span style={{ fontSize: 11, background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 10, fontWeight: 700 }}>
                        Qo‘llandi
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                      Sana: <b>{new Date(item.created_at).toLocaleString('uz-UZ')}</b> · Joy: <b>{item.location_name || 'Asosiy do‘kon'}</b> · Menejer: <b>{item.author_name || 'Menejer'}</b>
                    </div>
                    {item.notes && <div style={{ fontSize: 12, color: '#f97316', marginTop: 4 }}>Izoh: {item.notes}</div>}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ textAlign: 'right', fontSize: 12 }}>
                      <div>Tekshirildi: <b>{item.total_items} ta tovar</b></div>
                      <div>
                        Ortiqcha: <b style={{ color: '#2563eb' }}>+{item.total_surplus}</b> · Kamomad: <b style={{ color: '#dc2626' }}>-{item.total_shortage}</b>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 9. NOMA'LUM / ESKI QR KOD MODALI */}
      <Modal
        open={unknownModalOpen}
        onClose={() => setUnknownModalOpen(false)}
        title="⚠️ Noma‘lum QR kod aniqlandi"
      >
        <div style={{ padding: 4 }}>
          <div
            style={{
              background: '#fff7ed',
              border: '1px solid #ffedd5',
              padding: 12,
              borderRadius: 10,
              marginBottom: 14,
              color: '#9a3412',
              fontSize: 13
            }}
          >
            <p style={{ margin: 0, fontWeight: 600 }}>
              Skanerlangan kod: <code style={{ background: '#ffedd5', padding: '2px 6px', borderRadius: 4 }}>{unknownCode}</code>
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12 }}>
              Ushbu QR kod partiyasi o‘chirilgan yoki yangi stiker bo‘lishi mumkin. Ushbu kod qaysi tovarga tegishli ekanini tanlang:
            </p>
          </div>

          <div style={{ position: 'relative', marginBottom: 12 }}>
            <Search size={16} color="#64748b" style={{ position: 'absolute', left: 12, top: 13 }} />
            <input
              type="text"
              className="input"
              autoFocus
              placeholder="Tovar nomi yoki modelini yozing…"
              value={unknownSearch}
              onChange={e => setUnknownSearch(e.target.value)}
              style={{ paddingLeft: 36, height: 42, width: '100%' }}
            />
          </div>

          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
            {unknownCandidates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8', fontSize: 13 }}>
                Mos tovar topilmadi
              </div>
            ) : (
              unknownCandidates.map(p => (
                <div
                  key={p.product_id}
                  onClick={() => handleLinkUnknownProduct(p, true)}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid #f1f5f9',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                >
                  <div>
                    <b style={{ fontSize: 13, color: '#0f172a' }}>{p.product_name}</b>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      {p.sku} · Qoldiq: {p.on_hand} dona
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700 }}
                    disabled={unknownLinking}
                  >
                    Biriktirish va Sanash (+1)
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#64748b' }}>
            <Info size={14} color="#f97316" />
            <span>Tanlangandan so‘ng ushbu QR kod keyingi safar avtomatik taniladigan bo‘ladi.</span>
          </div>
        </div>
      </Modal>

      {/* 10. QOLDIQLARNI TENGLASHTIRISHNI TASDIQLASH MODALI */}
      <Modal
        open={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title="⚡ Qoldiqlarni Dasturga Tatbiq Etish"
      >
        <div style={{ padding: 4 }}>
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              padding: 14,
              borderRadius: 12,
              marginBottom: 16
            }}
          >
            <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#0f172a' }}>Tafovutlar yakuni:</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: '#334155' }}>
              <li>
                <b>🔵 Ortiqcha chiqqan tovarlar:</b> +{matrix.totalSurplus} dona (Dasturga avtomatik kirim qilinadi va yangi QR beriladi)
              </li>
              <li>
                <b>🔴 Kamomad chiqqan tovarlar:</b> -{matrix.totalShortage} dona (Dasturdan akt bilan hisobdan chiqariladi)
              </li>
              <li>
                <b>🟢 To‘liq mos kelgan tovarlar:</b> {matrix.totalMatched} ta tovar
              </li>
            </ul>
          </div>

          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
            Ushbu amal dasturdagi filial qoldiqlarini <b>do‘konda haqiqatda sanalgan songa 100% tenglashtiradi</b>. Davom etasizmi?
          </p>

          <label style={{ display: 'block', marginBottom: 16 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#334155', display: 'block', marginBottom: 4 }}>
              Reviziya izohi (ixtiyoriy):
            </span>
            <input
              type="text"
              className="input"
              placeholder="Masalan: 22-oktabr do‘kon to‘liq reviziyasi"
              value={syncNotes}
              onChange={e => setSyncNotes(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setConfirmModalOpen(false)}
              disabled={syncing}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleApplyReconciliation}
              disabled={syncing}
              style={{ fontWeight: 700 }}
            >
              {syncing ? 'Tenglashtirilmoqda…' : 'Tasdiqlash va Tenglashtirish'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 11. ORTIQCHA TOVARLAR UCHUN QR CHOP ETISH MODALI */}
      {printModalOpen && (
        <DetongerPrintModal
          open={printModalOpen}
          onClose={() => setPrintModalOpen(false)}
          labels={printLabels}
          batchTitle="Reviziya Ortiqcha Tovarlari"
          receiptDate={new Date().toLocaleDateString('uz-UZ')}
        />
      )}
    </section>
  );
}
