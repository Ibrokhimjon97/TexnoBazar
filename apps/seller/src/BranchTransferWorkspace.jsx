import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  DollarSign,
  Edit3,
  Eye,
  FileText,
  Filter,
  Layers,
  MapPin,
  Minus,
  Package,
  Percent,
  Plus,
  Printer,
  QrCode,
  RotateCcw,
  Search,
  Send,
  Store,
  Tag,
  Trash2,
  Truck,
  User,
  Warehouse,
  X
} from 'lucide-react';
import {
  DualPrice,
  Empty,
  Modal,
  QrScanButton,
  Status,
  formatDualMoney,
  useExchangeRate
} from '@texnobazar/ui';
import {
  createExternalBranchTransfer,
  findExternalTransferProduct,
  getExternalTransferReferences,
  searchExternalTransferProducts,
  listExternalBranchTransfers,
  getExternalBranchTransfer,
  cancelExternalBranchTransfer,
  deleteExternalBranchTransfer,
  updateExternalBranchTransfer,
  getProductComponents
} from '@texnobazar/data';

const msg = e => String(e?.message || 'Amalni bajarib bo‘lmadi.');

// Clean numeric text allowing empty string, removing unwanted chars, retaining up to 2 decimal places
const numericText = value => {
  const raw = String(value ?? '').replace(/[^\d.]/g, '');
  const [whole, ...rest] = raw.split('.');
  const head = whole.replace(/^0+(?=\d)/, '');
  return rest.length ? `${head || '0'}.${rest.join('').slice(0, 2)}` : head;
};

// Integer text allowing empty string, removing non-digits
const integerText = value => {
  const raw = String(value ?? '').replace(/\D/g, '');
  return raw.replace(/^0+(?=\d)/, '');
};

// Price Calculation Helper
function calcItemTransferPrice(item, mode, mType, mVal, curRate) {
  const costUzs = Number(item.cost_price || 0);
  const costUsd = Number(
    item.cost_price_usd || (curRate > 0 && costUzs > 0 ? costUzs / curRate : 0)
  );

  if (mode === 'cost') {
    return {
      transferPriceUzs: Math.round(costUzs),
      transferPriceUsd: Number(costUsd.toFixed(2)),
      markupUsd: 0
    };
  }

  // Markup mode: add markup on top of cost
  const val = parseFloat(mVal) || 0;
  if (mType === 'usd') {
    const newUsd = Math.max(0, costUsd + val);
    const newUzs = curRate > 0 ? Math.round(newUsd * curRate) : Math.round(costUzs);
    return {
      transferPriceUzs: newUzs,
      transferPriceUsd: Number(newUsd.toFixed(2)),
      markupUsd: Number(val.toFixed(2))
    };
  } else if (mType === 'uzs') {
    const newUzs = Math.max(0, Math.round(costUzs + val));
    const newUsd = curRate > 0 ? Number((newUzs / curRate).toFixed(2)) : 0;
    const diffUsd = Math.max(0, Number((newUsd - costUsd).toFixed(2)));
    return {
      transferPriceUzs: newUzs,
      transferPriceUsd: newUsd,
      markupUsd: diffUsd
    };
  } else if (mType === 'percent') {
    const factor = 1 + (val / 100);
    const newUzs = Math.max(0, Math.round(costUzs * factor));
    const newUsd = Math.max(0, Number((costUsd * factor).toFixed(2)));
    const diffUsd = Math.max(0, Number((newUsd - costUsd).toFixed(2)));
    return {
      transferPriceUzs: newUzs,
      transferPriceUsd: newUsd,
      markupUsd: diffUsd
    };
  }

  return {
    transferPriceUzs: Math.round(costUzs),
    transferPriceUsd: Number(costUsd.toFixed(2)),
    markupUsd: 0
  };
}

// Thermal / A4 Printable Receipt
function printReceiptWindow(transfer) {
  if (!transfer) return;
  const printWindow = window.open('', '_blank', 'width=650,height=750');
  if (!printWindow) {
    alert('Chop etish oynasini ochib bo‘lmadi (pop-up blockerni tekshiring)');
    return;
  }

  const t = transfer;
  const isCancelled = t.status === 'cancelled';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>Transfer Cheki #${t.transfer_no}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; font-size: 13px; color: #111; }
        .header { text-align: center; border-bottom: 2px dashed #444; padding-bottom: 12px; margin-bottom: 14px; }
        .title { font-size: 18px; font-weight: 800; text-transform: uppercase; margin: 0; }
        .cancelled-badge { display: inline-block; background: #dc2626; color: #fff; padding: 4px 10px; border-radius: 4px; font-weight: 700; margin-top: 6px; }
        .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
        .meta-table td { padding: 4px 0; }
        .lines-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
        .lines-table th, .lines-table td { border-bottom: 1px solid #ddd; padding: 8px 4px; text-align: left; }
        .lines-table th:last-child, .lines-table td:last-child { text-align: right; }
        .total-box { border-top: 2px solid #111; padding-top: 10px; text-align: right; font-size: 16px; font-weight: 800; }
        .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #666; border-top: 1px dashed #aaa; padding-top: 10px; }
        @media print { body { padding: 0; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h2 class="title">FILIALGA TRANSFER HUJJATI</h2>
        <p style="margin: 4px 0;"><b>Hujjat:</b> #${t.transfer_no}</p>
        <p style="margin: 0; font-size: 11px;">Sana: ${new Date(t.created_at).toLocaleString('uz-UZ')}</p>
        ${isCancelled ? '<div class="cancelled-badge">BEKOR QILINGAN (TOVARLAR DO‘KONGA QAYTARILGAN)</div>' : ''}
      </div>
      <table class="meta-table">
        <tr><td><b>Jo‘natuvchi:</b></td><td>${t.branch_name || 'Asosiy filial'} (${t.from_location_name || 'Ombor/Do‘kon'})</td></tr>
        <tr><td><b>Mas’ul sotuvchi:</b></td><td>${t.seller_name || 'Sotuvchi'}</td></tr>
        <tr><td><b>Qabul qiluvchi filial:</b></td><td><b>${t.target_branch_name}</b></td></tr>
        <tr><td><b>Filial boshlig‘i:</b></td><td><b>${t.target_manager_name}</b></td></tr>
        <tr><td><b>Narx tartibi:</b></td><td>${t.price_mode === 'cost' ? 'O‘z tannarxi bo‘yicha' : t.price_mode === 'markup' ? 'Tannarxga ustama qo‘yilgan' : t.price_mode === 'wholesale' ? 'Ulgurji narxda' : 'Erkin narx'}</td></tr>
        ${t.notes ? `<tr><td><b>Izoh:</b></td><td>${t.notes}</td></tr>` : ''}
      </table>
      <table class="lines-table">
        <thead>
          <tr>
            <th>№</th>
            <th>Tovar nomi</th>
            <th style="text-align: center;">Soni</th>
            <th style="text-align: right;">Transfer narxi</th>
            <th>Jami</th>
          </tr>
        </thead>
        <tbody>
          ${t.lines?.map((line, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td>
                <b>${line.product_name}</b>
                ${line.selected_components?.length > 0 ? `
                  <div style="margin-top: 3px; font-size: 11px; color: #334155;">
                    <span style="font-weight: 600; color: #0284c7;">Tarkibiy qismlar:</span>
                    ${line.selected_components.map(c => `<b>${c.quantity > 1 ? `${c.quantity}x ` : ''}</b>${c.name}${c.color ? ` (${c.color})` : ''}`).join(', ')}
                  </div>
                ` : ''}
                <small style="color:#666">${line.sku || ''}</small>
              </td>
              <td style="text-align: center;">${line.quantity} ta</td>
              <td style="text-align: right;">
                ${new Intl.NumberFormat('uz-UZ').format(line.unit_price)} so‘m
                ${line.unit_price_usd > 0 ? `<br/><small style="color:#555;">($${line.unit_price_usd})</small>` : ''}
              </td>
              <td style="text-align: right;">
                ${new Intl.NumberFormat('uz-UZ').format(line.total_price)} so‘m
                ${line.total_price_usd > 0 ? `<br/><small style="color:#555;">($${line.total_price_usd})</small>` : ''}
              </td>
            </tr>
          `).join('') || ''}
        </tbody>
      </table>
      <div class="total-box">
        Jami: ${new Intl.NumberFormat('uz-UZ').format(t.total_amount)} so‘m
        ${t.total_amount_usd > 0 ? ` ≈ $${t.total_amount_usd} USD` : ''}
        <div style="font-size: 12px; font-weight: normal; color: #555; margin-top: 3px;">
          (${t.total_items_count} dona tovar)
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; margin-top: 40px; padding: 0 10px;">
        <div>Topshirdi: ____________ (${t.seller_name || 'Sotuvchi'})</div>
        <div>Qabul qildi: ____________ (${t.target_manager_name})</div>
      </div>
      <div class="footer">
        Texnobazar avtomatlashtirilgan savdo tizimi
      </div>
      <script>
        window.onload = function() { window.print(); }
      </script>
    </body>
    </html>
  `;
  printWindow.document.write(html);
  printWindow.document.close();
}

export default function BranchTransferWorkspace({ branchId, profile, toast, onBack }) {
  const rate = useExchangeRate();

  // Active View Tab: 'new' | 'history'
  const [activeTab, setActiveTab] = useState('new');

  // --- NEW TRANSFER FORM STATES ---
  const [refs, setRefs] = useState({ locations: [], exchange_rate: 11850 });
  const [loadingRefs, setLoadingRefs] = useState(true);
  const [fromLocationId, setFromLocationId] = useState('');

  // Target Branch Form
  const [targetBranchName, setTargetBranchName] = useState('');
  const [targetManagerName, setTargetManagerName] = useState('');
  const [notes, setNotes] = useState('');

  // Pricing Mode: 'cost' (Tannarxi bo‘yicha) or 'markup' (Tannarxga ustama qo‘yish)
  const [priceMode, setPriceMode] = useState('cost');
  const [markupType, setMarkupType] = useState('usd'); // 'usd' | 'uzs' | 'percent'
  const [markupValue, setMarkupValue] = useState('1'); // Default +1 $

  // Search & Scanner
  const [code, setCode] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [error, setError] = useState('');

  // Selected Transfer Items
  const [items, setItems] = useState([]);

  // Modular Component Configuration Modal State
  const [configuringProduct, setConfiguringProduct] = useState(null);

  // Open modular component configuration modal
  const openComponentConfig = async item => {
    let target = { ...item };
    if (!target.components || target.components.length === 0) {
      try {
        const comps = await getProductComponents(target.product_id);
        target.components = comps || [];
      } catch (err) {
        console.error('Failed to load components for product', err);
      }
    }
    setConfiguringProduct(target);
  };

  // Save configured modular item
  const handleSaveConfiguredComponents = configuredItem => {
    setItems(prev => {
      const idx = prev.findIndex(x => x.product_id === configuredItem.product_id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...configuredItem };
        return next;
      }
      return [...prev, configuredItem];
    });
    setConfiguringProduct(null);
    toast?.(`"${configuredItem.product_name}" tarkibiy qismlari saqlandi`);
  };

  // Submitting & Completed Receipt Modal
  const [submitting, setSubmitting] = useState(false);
  const [completedTransfer, setCompletedTransfer] = useState(null);

  // --- HISTORY STATES ---
  const [historyData, setHistoryData] = useState({
    items: [],
    total_count: 0,
    total_value_uzs: 0,
    total_value_usd: 0,
    total_items_count: 0
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyFromDate, setHistoryFromDate] = useState('');
  const [historyToDate, setHistoryToDate] = useState('');
  const [historyPriceMode, setHistoryPriceMode] = useState('all');
  const [historyPage, setHistoryPage] = useState(1);

  // Detail Modal State
  const [detailId, setDetailId] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Edit Modal State
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    id: '',
    transfer_no: '',
    targetBranchName: '',
    targetManagerName: '',
    notes: ''
  });
  const [actionBusy, setActionBusy] = useState(false);

  // Load branch locations and reference data
  useEffect(() => {
    if (!branchId) return;
    let active = true;
    setLoadingRefs(true);
    getExternalTransferReferences(branchId)
      .then(data => {
        if (!active) return;
        setRefs(data || { locations: [] });
        if (data?.locations?.length) {
          setFromLocationId(data.locations[0].id);
        }
      })
      .catch(e => {
        if (!active) return;
        setError(msg(e));
      })
      .finally(() => {
        if (active) setLoadingRefs(false);
      });
    return () => { active = false; };
  }, [branchId]);

  // Load history data
  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await listExternalBranchTransfers({
        branchId: branchId || null,
        query: historyQuery.trim() || null,
        fromDate: historyFromDate || null,
        toDate: historyToDate || null,
        priceMode: historyPriceMode === 'all' ? null : historyPriceMode,
        page: historyPage,
        pageSize: 30
      });
      setHistoryData(res || { items: [], total_count: 0, total_value_uzs: 0, total_value_usd: 0, total_items_count: 0 });
    } catch (err) {
      setHistoryError(msg(err));
    } finally {
      setHistoryLoading(false);
    }
  };

  // Initial history load (badge count) and auto-reload on filters change
  useEffect(() => {
    if (!branchId) return;
    const timer = setTimeout(loadHistory, historyQuery ? 350 : 0);
    return () => clearTimeout(timer);
  }, [branchId, activeTab, historyQuery, historyFromDate, historyToDate, historyPriceMode, historyPage]);

  // Live Catalog Search (Debounced)
  useEffect(() => {
    if (!fromLocationId || !code || code.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchExternalTransferProducts(branchId, fromLocationId, code.trim(), 20);
        setSearchResults(res || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [branchId, fromLocationId, code]);

  // Apply markup to all items
  const applyMarkupToAll = (overrideMode, overrideType, overrideVal) => {
    const mMode = overrideMode !== undefined ? overrideMode : priceMode;
    const mType = overrideType !== undefined ? overrideType : markupType;
    const mVal = overrideVal !== undefined ? overrideVal : markupValue;
    setItems(prev =>
      prev.map(item => {
        const calc = calcItemTransferPrice(item, mMode, mType, mVal, rate);
        return {
          ...item,
          markup_usd: calc.markupUsd || 0,
          transfer_price: calc.transferPriceUzs,
          transfer_price_usd: calc.transferPriceUsd
        };
      })
    );
  };

  // Bulk set USD markup on all items simultaneously
  const applyBulkMarkupUsd = valUsd => {
    setPriceMode(valUsd > 0 ? 'markup' : 'cost');
    setMarkupType('usd');
    setMarkupValue(String(valUsd));
    setItems(prev =>
      prev.map(item => {
        const costUsd = Number(item.cost_price_usd || (rate > 0 && item.cost_price ? item.cost_price / rate : 0));
        const newUsd = Math.max(0, costUsd + valUsd);
        const newUzs = rate > 0 ? Math.round(newUsd * rate) : Math.round(item.cost_price || 0);
        return {
          ...item,
          markup_usd: Number(valUsd.toFixed(2)),
          transfer_price: newUzs,
          transfer_price_usd: Number(newUsd.toFixed(2))
        };
      })
    );
    if (valUsd === 0) {
      toast?.('Barcha tovarlar 0$ ustama (o‘z tannarxi)ga belgilandi');
    } else {
      toast?.(`Barcha tovarlar tannarxiga +$${valUsd} ustama qo‘yildi`);
    }
  };

  // Add product to transfer list
  const addProduct = prod => {
    setError('');
    const existingIndex = items.findIndex(x => x.product_id === prod.product_id);
    if (existingIndex >= 0) {
      const existing = items[existingIndex];
      // If product has components, open configuration modal to let seller adjust main/component quantities
      if (
        (existing.components && existing.components.length > 0) ||
        (prod.components && prod.components.length > 0) ||
        existing.is_component_only ||
        (existing.selected_components && existing.selected_components.length > 0)
      ) {
        openComponentConfig({ ...prod, ...existing });
        setCode('');
        setSearchResults([]);
        return;
      }

      if (existing.quantity >= existing.available_count) {
        toast?.(`Omborda bu tovardan ko‘pi bilan ${existing.available_count} ta mavjud!`);
        return;
      }
      const updated = [...items];
      updated[existingIndex] = {
        ...existing,
        quantity: existing.quantity + 1,
        main_quantity: (existing.main_quantity || existing.quantity) + 1
      };
      setItems(updated);
      toast?.(`"${prod.product_name}" soni 1 taga oshirildi`);
    } else {
      // If product has modular components (e.g. Beshik), open configuration modal immediately
      if (prod.components && prod.components.length > 0) {
        openComponentConfig(prod);
        setCode('');
        setSearchResults([]);
        return;
      }

      const costUzs = Number(prod.cost_price || 0);
      const costUsd = Number(
        prod.cost_price_usd || (rate > 0 && costUzs > 0 ? costUzs / rate : 0)
      );
      const calc = calcItemTransferPrice(
        { cost_price: costUzs, cost_price_usd: costUsd },
        priceMode,
        markupType,
        markupValue,
        rate
      );

      setItems(prev => [
        ...prev,
        {
          product_id: prod.product_id,
          product_name: prod.product_name,
          sku: prod.sku,
          barcode: prod.barcode,
          image: prod.image,
          available_count: Number(prod.available_count || 1),
          quantity: 1,
          main_quantity: 1,
          is_component_only: false,
          has_components: false,
          components: prod.components || [],
          selected_components: [],
          cost_price: costUzs,
          cost_price_usd: costUsd,
          wholesale_price: Number(prod.wholesale_price || 0),
          wholesale_price_usd: Number(prod.wholesale_price_usd || 0),
          markup_usd: calc.markupUsd || 0,
          transfer_price: calc.transferPriceUzs,
          transfer_price_usd: calc.transferPriceUsd,
          qr_code: prod.qr_code || prod.sample_qr || null
        }
      ]);
      toast?.(`"${prod.product_name}" transferga qo‘shildi`);
    }
    setCode('');
    setSearchResults([]);
  };

  // Scan single QR code or exact search by code / name
  const handleScan = async e => {
    e?.preventDefault?.();
    let searchStr = code.trim();
    if (searchStr.includes('/qr/')) {
      searchStr = searchStr.substring(searchStr.indexOf('/qr/') + 4);
    }
    if (searchStr.includes('?')) {
      searchStr = searchStr.split('?')[0];
    }
    searchStr = searchStr.trim();
    if (!searchStr || !fromLocationId) return;
    setScanBusy(true);
    setError('');
    try {
      const found = await findExternalTransferProduct(branchId, fromLocationId, searchStr);
      if (found) {
        addProduct(found);
      }
    } catch (err) {
      if (searchResults && searchResults.length > 0) {
        addProduct(searchResults[0]);
      } else {
        setError(msg(err));
      }
    } finally {
      setScanBusy(false);
    }
  };

  // Update quantity for a product
  const handleQuantityChange = (productId, val) => {
    const item = items.find(x => x.product_id === productId);
    if (!item) return;

    if (item.is_component_only || (item.selected_components && item.selected_components.length > 0)) {
      openComponentConfig(item);
      return;
    }

    let qty = parseInt(val, 10);
    if (isNaN(qty) || qty < 1) qty = 1;
    if (qty > item.available_count) {
      qty = item.available_count;
      toast?.(`Mavjud miqdordan oshirib bo‘lmaydi (Maksimal: ${item.available_count} ta)`);
    }
    setItems(items.map(x => (x.product_id === productId ? { ...x, quantity: qty, main_quantity: qty } : x)));
  };

  // Update individual item markup in USD
  const handleItemMarkupChange = (productId, val) => {
    const formatted = numericText(val);
    setItems(prev =>
      prev.map(item => {
        if (item.product_id !== productId) return item;
        const costUsd = Number(item.cost_price_usd || (rate > 0 && item.cost_price ? item.cost_price / rate : 0));
        if (formatted === '') {
          const defaultUzs = rate > 0 ? Math.round(costUsd * rate) : Math.round(item.cost_price || 0);
          return {
            ...item,
            markup_usd: '',
            transfer_price: defaultUzs,
            transfer_price_usd: Number(costUsd.toFixed(2))
          };
        }
        const mVal = parseFloat(formatted);
        const validMVal = !isNaN(mVal) ? Math.max(0, mVal) : 0;
        const newUsd = Number((costUsd + validMVal).toFixed(2));
        const newUzs = rate > 0 ? Math.round(newUsd * rate) : Math.round(item.cost_price || 0);
        return {
          ...item,
          markup_usd: formatted,
          transfer_price: newUzs,
          transfer_price_usd: newUsd
        };
      })
    );
  };

  // Directly edit USD transfer price on an item (recalculates individual markup and UZS)
  const handleItemUsdPriceChange = (productId, val) => {
    const formatted = numericText(val);
    setItems(prev =>
      prev.map(x => {
        if (x.product_id !== productId) return x;
        if (formatted === '') {
          return {
            ...x,
            markup_usd: '',
            transfer_price: '',
            transfer_price_usd: ''
          };
        }
        const pUsd = parseFloat(formatted);
        const costUsd = Number(x.cost_price_usd || (rate > 0 && x.cost_price ? x.cost_price / rate : 0));
        const calcMarkup = !isNaN(pUsd) ? Math.max(0, Number((pUsd - costUsd).toFixed(2))) : '';
        const pUzs = !isNaN(pUsd) && pUsd >= 0 && rate > 0 ? Math.round(pUsd * rate) : '';
        return {
          ...x,
          markup_usd: calcMarkup,
          transfer_price: pUzs,
          transfer_price_usd: formatted
        };
      })
    );
  };

  // Directly edit UZS transfer price on an item (recalculates individual markup and USD)
  const handleItemUzsPriceChange = (productId, val) => {
    const formatted = integerText(val);
    setItems(prev =>
      prev.map(x => {
        if (x.product_id !== productId) return x;
        if (formatted === '') {
          return {
            ...x,
            markup_usd: '',
            transfer_price: '',
            transfer_price_usd: ''
          };
        }
        const pUzs = parseFloat(formatted);
        const costUsd = Number(x.cost_price_usd || (rate > 0 && x.cost_price ? x.cost_price / rate : 0));
        const pUsd = !isNaN(pUzs) && pUzs >= 0 && rate > 0 ? Number((pUzs / rate).toFixed(2)) : '';
        const calcMarkup = pUsd !== '' ? Math.max(0, Number((pUsd - costUsd).toFixed(2))) : '';
        return {
          ...x,
          markup_usd: calcMarkup,
          transfer_price: formatted,
          transfer_price_usd: pUsd
        };
      })
    );
  };

  // Switch pricing mode: 'cost' or 'markup'
  const switchPriceMode = newMode => {
    setPriceMode(newMode);
    applyMarkupToAll(newMode, markupType, markupValue);
    if (newMode === 'cost') {
      toast?.('Barcha tovarlarga o‘z tannarxi bo‘yicha narx belgilandi');
    } else {
      const unitStr = markupType === 'usd' ? '$' : markupType === 'uzs' ? 'so‘m' : '%';
      toast?.(`Tannarxga +${markupValue || 1} ${unitStr} ustama qo‘llandi`);
    }
  };

  // Change markup unit: usd, uzs, percent
  const changeMarkupType = newType => {
    setMarkupType(newType);
    let nextVal = markupValue;
    if (newType === 'usd' && (markupValue === '15000' || markupValue === '10')) nextVal = '1';
    if (newType === 'uzs' && (markupValue === '1' || markupValue === '10')) nextVal = '15000';
    if (newType === 'percent' && (markupValue === '1' || markupValue === '15000')) nextVal = '10';
    setMarkupValue(nextVal);
    applyMarkupToAll('markup', newType, nextVal);
  };

  // Apply markup button click
  const handleApplyMarkup = () => {
    const val = parseFloat(markupValue);
    if (isNaN(val) || val < 0) {
      toast?.('Iltimos, to‘g‘ri ustama qiymatini kiriting');
      return;
    }
    applyMarkupToAll(priceMode, markupType, markupValue);
    const unitStr = markupType === 'usd' ? '$' : markupType === 'uzs' ? 'so‘m' : '%';
    toast?.(`Barcha tovarlar tannarxiga +${markupValue} ${unitStr} ustama qo‘yildi`);
  };

  // Totals calculation
  const totalUnits = useMemo(() => items.reduce((sum, x) => sum + (parseInt(x.quantity, 10) || 1), 0), [items]);
  const totalValue = useMemo(() => {
    return items.reduce((sum, x) => sum + ((parseFloat(x.transfer_price) || 0) * (parseInt(x.quantity, 10) || 1)), 0);
  }, [items]);
  const totalValueUsd = useMemo(() => {
    return items.reduce((sum, x) => sum + ((parseFloat(x.transfer_price_usd) || 0) * (parseInt(x.quantity, 10) || 1)), 0);
  }, [items]);

  // Submit transfer
  const handleSubmit = async e => {
    e.preventDefault();
    if (!targetBranchName.trim()) {
      setError('Qabul qiluvchi filial yoki do‘kon nomini kiriting.');
      return;
    }
    if (!targetManagerName.trim()) {
      setError('Filial boshlig‘i ismini kiriting.');
      return;
    }
    if (items.length === 0) {
      setError('Transfer uchun kamida bitta tovar tanlang.');
      return;
    }

    for (const item of items) {
      if (item.quantity <= 0) {
        setError(`"${item.product_name}" soni noldan katta bo‘lishi kerak.`);
        return;
      }
      const isCompOnly = Boolean(item.is_component_only || item.main_quantity === 0);
      const mainQty = item.main_quantity !== undefined ? item.main_quantity : (isCompOnly ? 0 : item.quantity);

      if (!isCompOnly && mainQty > item.available_count) {
        setError(`"${item.product_name}" dan omborda yetarli emas (so‘raldi: ${mainQty}, mavjud: ${item.available_count}).`);
        return;
      }
      const itemUzs = parseFloat(item.transfer_price) || 0;
      const itemUsd = parseFloat(item.transfer_price_usd) || 0;
      if (itemUzs <= 0 && itemUsd <= 0) {
        setError(`"${item.product_name}" uchun narx belgilanmagan.`);
        return;
      }
    }

    setSubmitting(true);
    setError('');

    try {
      const payloadItems = items.map(x => {
        let linePriceUsd = parseFloat(x.transfer_price_usd) || 0;
        let linePriceUzs = parseFloat(x.transfer_price) || 0;
        if (linePriceUzs <= 0 && linePriceUsd > 0 && rate > 0) {
          linePriceUzs = Math.round(linePriceUsd * rate);
        } else if (linePriceUsd <= 0 && linePriceUzs > 0 && rate > 0) {
          linePriceUsd = Number((linePriceUzs / rate).toFixed(2));
        }
        const isCompOnly = Boolean(x.is_component_only || x.main_quantity === 0);
        const mainQty = x.main_quantity !== undefined ? parseInt(x.main_quantity, 10) : (isCompOnly ? 0 : parseInt(x.quantity, 10) || 1);

        return {
          product_id: x.product_id,
          quantity: parseInt(x.quantity, 10) || 1,
          main_quantity: mainQty,
          is_component_only: isCompOnly,
          selected_components: Array.isArray(x.selected_components) ? x.selected_components : [],
          unit_price: linePriceUzs,
          unit_price_usd: Number(linePriceUsd.toFixed(2)),
          qr_code: x.qr_code || null,
          product_name: x.product_name || null
        };
      });

      const res = await createExternalBranchTransfer({
        branchId,
        fromLocationId,
        targetBranchName: targetBranchName.trim(),
        targetManagerName: targetManagerName.trim(),
        priceMode: priceMode === 'cost' ? 'cost' : 'markup',
        notes: notes.trim(),
        items: payloadItems
      });

      setCompletedTransfer(res);
      toast?.(`Transfer muvaffaqiyatli amalga oshirildi! (#${res.transfer_no})`);
      // Reset form
      setItems([]);
      setTargetBranchName('');
      setTargetManagerName('');
      setNotes('');
      loadHistory();
    } catch (err) {
      setError(msg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- DETAIL MODAL LOADER ---
  const openDetail = async id => {
    setDetailId(id);
    setDetailLoading(true);
    try {
      const res = await getExternalBranchTransfer(id);
      setDetailData(res);
    } catch (err) {
      toast?.(msg(err));
      setDetailId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  // Transferni faqat yaratgan sotuvchi yoki admin/menejer tahrirlay oladi
  const canModifyTransfer = transfer => {
    if (!profile) return false;
    if (['superadmin', 'admin', 'manager'].includes(profile.role)) return true;
    if (transfer?.seller_id && profile?.id && transfer.seller_id === profile.id) return true;
    return false;
  };

  // --- EDIT MODAL HANDLERS ---
  const openEditModal = (transfer, e) => {
    e?.stopPropagation?.();
    if (!canModifyTransfer(transfer)) {
      toast?.('Xatolik: Ushbu transferni faqat uni yuborgan sotuvchi (' + (transfer.seller_name || 'yuboruvchi') + ') tahrirlashi mumkin!');
      return;
    }
    setEditForm({
      id: transfer.id,
      transfer_no: transfer.transfer_no,
      targetBranchName: transfer.target_branch_name || '',
      targetManagerName: transfer.target_manager_name || '',
      notes: transfer.notes || ''
    });
    setEditModalOpen(true);
  };

  const handleSaveEdit = async e => {
    e.preventDefault();
    if (!editForm.targetBranchName.trim()) {
      toast?.('Qabul qiluvchi filial nomini kiriting');
      return;
    }
    if (!editForm.targetManagerName.trim()) {
      toast?.('Filial boshlig‘i ismini kiriting');
      return;
    }

    setActionBusy(true);
    try {
      await updateExternalBranchTransfer({
        transferId: editForm.id,
        targetBranchName: editForm.targetBranchName.trim(),
        targetManagerName: editForm.targetManagerName.trim(),
        notes: editForm.notes.trim()
      });

      toast?.('Transfer ma’lumotlari muvaffaqiyatli yangilandi!');
      setEditModalOpen(false);

      if (detailId === editForm.id) {
        const updated = await getExternalBranchTransfer(editForm.id);
        setDetailData(updated);
      }
      loadHistory();
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // --- CANCEL TRANSFER HANDLER ---
  const handleCancelTransfer = async (transfer, e) => {
    e?.stopPropagation?.();
    if (!canModifyTransfer(transfer)) {
      toast?.('Xatolik: Ushbu transferni faqat uni yuborgan sotuvchi (' + (transfer.seller_name || 'yuboruvchi') + ') bekor qilishi mumkin!');
      return;
    }
    const confirmed = window.confirm(
      `Haqiqatan ham #${transfer.transfer_no} raqamli transferni bekor qilmoqchimisiz?\n\n` +
      `DIQQAT: Ushbu transferdagi ${transfer.total_items_count} dona tovar darhol ombor/do‘kon balansiga QAYTARILADI!`
    );
    if (!confirmed) return;

    setActionBusy(true);
    try {
      const res = await cancelExternalBranchTransfer(transfer.id, 'Sotuvchi tomonidan bekor qilindi');
      toast?.(`Transfer bekor qilindi! ${res?.returned_units_count || transfer.total_items_count} dona tovar ombor/do‘kon balansiga qaytarildi.`);

      if (detailId === transfer.id) {
        const updated = await getExternalBranchTransfer(transfer.id);
        setDetailData(updated);
      }
      loadHistory();
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // --- DELETE TRANSFER HANDLER ---
  const handleDeleteTransfer = async (transfer, e) => {
    e?.stopPropagation?.();
    if (!canModifyTransfer(transfer)) {
      toast?.('Xatolik: Ushbu transferni faqat uni yuborgan sotuvchi (' + (transfer.seller_name || 'yuboruvchi') + ') o‘chirishi mumkin!');
      return;
    }
    const confirmed = window.confirm(
      `Haqiqatan ham #${transfer.transfer_no} transferini butunlay o‘chirmoqchimisiz?\n\n` +
      `Eslatma: Agar tovarlar hali omborga qaytarilmagan bo‘lsa, ular avtomatik ravishda ombor/do‘konga qaytariladi.`
    );
    if (!confirmed) return;

    setActionBusy(true);
    try {
      await deleteExternalBranchTransfer(transfer.id);
      toast?.(`#${transfer.transfer_no} transferi butunlay o‘chirildi va tovarlar do‘konga qaytarildi.`);
      if (detailId === transfer.id) {
        setDetailId(null);
        setDetailData(null);
      }
      loadHistory();
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // --- EDIT GOODS (RELOAD INTO FORM) HANDLER ---
  const handleReloadToEdit = async (transfer, e) => {
    e?.stopPropagation?.();
    if (!canModifyTransfer(transfer)) {
      toast?.('Xatolik: Ushbu transferni faqat uni yuborgan sotuvchi (' + (transfer.seller_name || 'yuboruvchi') + ') tovarlarini tahrirlashi mumkin!');
      return;
    }
    const confirmed = window.confirm(
      `#${transfer.transfer_no} transferini tovarlari bilan tahrirlash:\n\n` +
      `Ushbu transfer bekor qilinadi (tovarlar hisobga qaytariladi) va barcha tovarlar yangi transfer oynasiga yuklanadi.\n` +
      `Siz tovarlarni qo‘shishingiz, o‘chirishingiz yoki soni/narxini o‘zgartirib qayta jo‘nata olasiz.\n\nDavom etasizmi?`
    );
    if (!confirmed) return;

    setActionBusy(true);
    try {
      const full = await getExternalBranchTransfer(transfer.id);
      if (full.status !== 'cancelled') {
        await cancelExternalBranchTransfer(transfer.id, 'Tovarlarni tahrirlash uchun bekor qilindi');
      }

      setTargetBranchName(full.target_branch_name || '');
      setTargetManagerName(full.target_manager_name || '');
      setNotes((full.notes || '').replace(/\[BEKOR QILINDI:[^\]]*\]/g, '').trim());
      if (full.from_location_id) {
        setFromLocationId(full.from_location_id);
      }
      setPriceMode(full.price_mode === 'markup' ? 'markup' : 'cost');

      const reloadedItems = (full.lines || []).map(line => {
        const lineCostUzs = Number(line.cost_price || 0);
        const lineCostUsd = rate > 0 && lineCostUzs ? Number((lineCostUzs / rate).toFixed(2)) : 0;
        const lineTransferUsd = Number(line.unit_price_usd || 0);
        const diffMarkup = Math.max(0, Number((lineTransferUsd - lineCostUsd).toFixed(2)));
        const selComps = Array.isArray(line.selected_components) ? line.selected_components : [];
        const isCompOnly = Boolean(line.is_component_only || (selComps.length > 0 && line.main_quantity === 0));

        return {
          product_id: line.product_id,
          product_name: line.product_name,
          sku: line.sku,
          barcode: line.barcode,
          image: line.image,
          available_count: Number(line.quantity || 1) + 50,
          quantity: Number(line.quantity || 1),
          main_quantity: line.main_quantity !== undefined ? Number(line.main_quantity) : (isCompOnly ? 0 : Number(line.quantity || 1)),
          is_component_only: isCompOnly,
          has_components: selComps.length > 0,
          selected_components: selComps,
          cost_price: lineCostUzs,
          cost_price_usd: lineCostUsd,
          wholesale_price: Number(line.wholesale_price || 0),
          wholesale_price_usd: 0,
          markup_usd: diffMarkup,
          transfer_price: Number(line.unit_price || 0),
          transfer_price_usd: lineTransferUsd,
          qr_code: line.qr_code || null
        };
      });

      setItems(reloadedItems);
      setDetailId(null);
      setActiveTab('new');
      toast?.(`#${transfer.transfer_no} tovarlari tahrirlash oynasiga yuklandi. O‘zgartirishlarni kiritib qayta tasdiqlang!`);
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // Date shortcuts
  const applyDatePreset = preset => {
    const today = new Date();
    const format = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (preset === 'today') {
      const f = format(today);
      setHistoryFromDate(f);
      setHistoryToDate(f);
    } else if (preset === 'week') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      setHistoryFromDate(format(d));
      setHistoryToDate(format(today));
    } else if (preset === 'month') {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      setHistoryFromDate(format(d));
      setHistoryToDate(format(today));
    } else {
      setHistoryFromDate('');
      setHistoryToDate('');
    }
    setHistoryPage(1);
  };

  return (
    <div className="branch-transfer-workspace">
      {/* Top Header with Segmented Navigation Tabs */}
      <div className="bt-header between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" className="btn btn-ghost bt-back-btn" onClick={onBack}>
            <ChevronLeft size={20} />
            <span>Orqaga</span>
          </button>
          <div className="bt-title-box">
            <h2>Filialga transfer</h2>
            <p>Tovarlarni filialga o‘tkazish, tahrirlash va o‘tkazmalar tarixi</p>
          </div>
        </div>

        {/* Tab Selector */}
        <div className="bt-tabs-bar">
          <button
            type="button"
            className={`bt-tab-btn ${activeTab === 'new' ? 'active' : ''}`}
            onClick={() => setActiveTab('new')}
          >
            <Plus size={16} />
            <span>Yangi transfer</span>
          </button>
          <button
            type="button"
            className={`bt-tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('history');
              loadHistory();
            }}
          >
            <Clock size={16} />
            <span>Transferlar tarixi</span>
            {historyData.total_count > 0 && (
              <span className="bt-tab-badge">{historyData.total_count}</span>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bt-error-banner">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}><X size={16} /></button>
        </div>
      )}

      {/* ============================================================ */}
      {/* VIEW 1: YANGI TRANSFER FORMASI                                */}
      {/* ============================================================ */}
      {activeTab === 'new' && (
        <form className="bt-form-container" onSubmit={handleSubmit}>
          <div className="bt-layout-grid">
            {/* Left Column: Transfer destination & Settings */}
            <div className="bt-sidebar card">
              <h3 className="bt-card-title"><Store size={18} /> Transfer manzili va shartlari</h3>

              <div className="bt-field">
                <label>Jo‘natish joyi (Do‘kon / Ombor) *</label>
                <select
                  className="select"
                  value={fromLocationId}
                  onChange={e => {
                    setFromLocationId(e.target.value);
                    setItems([]);
                  }}
                  disabled={loadingRefs || submitting}
                >
                  {refs.locations?.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.type === 'warehouse' ? '🏢 ' : '🏪 '} {l.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Target Destination & Manager Selection */}
              {(refs.branches?.length > 0 || refs.managers?.length > 0) && (
                <div className="bt-field">
                  <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Ro‘yxatdan tezkor tanlash:</span>
                    <span style={{ fontSize: 11, color: 'var(--orange)', fontWeight: 600 }}>
                      ⚡ Filial yoki Menejer
                    </span>
                  </label>
                  <select
                    className="select"
                    style={{ fontSize: 13, borderColor: 'var(--orange)', background: 'var(--surface-2)' }}
                    defaultValue=""
                    onChange={e => {
                      const val = e.target.value;
                      if (!val) return;
                      if (val.startsWith('b:')) {
                        const bId = val.replace('b:', '');
                        const b = refs.branches?.find(x => String(x.id) === bId);
                        if (b) {
                          setTargetBranchName(b.name);
                          if (b.manager_name) setTargetManagerName(b.manager_name);
                          toast?.(`Filial tanlandi: "${b.name}"`);
                        }
                      } else if (val.startsWith('m:')) {
                        const mId = val.replace('m:', '');
                        const m = refs.managers?.find(x => String(x.profile_id) === mId);
                        if (m) {
                          setTargetManagerName(m.full_name);
                          if (m.branch_name) setTargetBranchName(m.branch_name);
                          toast?.(`Menejer tanlandi: "${m.full_name}"`);
                        }
                      }
                      e.target.value = '';
                    }}
                    disabled={submitting}
                  >
                    <option value="">-- Mavjud filial yoki menejerlar ro‘yxati --</option>
                    {refs.branches?.length > 0 && (
                      <optgroup label="Tizimdagi filiallar">
                        {refs.branches.map(b => (
                          <option key={b.id} value={`b:${b.id}`}>
                            🏛 {b.name} {b.manager_name ? `(Menejer: ${b.manager_name})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {refs.managers?.length > 0 && (
                      <optgroup label="Superadmindagi menejerlar">
                        {refs.managers.map(m => (
                          <option key={m.profile_id} value={`m:${m.profile_id}`}>
                            👤 {m.full_name} {m.branch_name ? `(${m.branch_name})` : ''} {m.phone ? `· ${m.phone}` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              )}

              <div className="bt-field">
                <label>Qabul qiluvchi do‘kon/filial nomi *</label>
                <input
                  className="input"
                  type="text"
                  list="target-branch-suggestions"
                  placeholder="Masalan: Chilonzor filiali (yoki ro‘yxatdan tanlang)"
                  value={targetBranchName}
                  onChange={e => setTargetBranchName(e.target.value)}
                  required
                  disabled={submitting}
                />
                <datalist id="target-branch-suggestions">
                  {refs.branches?.map(b => (
                    <option key={`dl-b-${b.id}`} value={b.name}>
                      {b.manager_name ? `Menejer: ${b.manager_name}` : ''}
                    </option>
                  ))}
                  {refs.managers?.filter(m => m.branch_name).map((m, idx) => (
                    <option key={`dl-mb-${idx}`} value={m.branch_name}>
                      {m.full_name}
                    </option>
                  ))}
                </datalist>
              </div>

              <div className="bt-field">
                <label>Filial boshlig‘i (mas’ul shaxs) ismi *</label>
                <input
                  className="input"
                  type="text"
                  list="target-manager-suggestions"
                  placeholder="Masalan: Jamshid Aliyev (yoki ro‘yxatdan tanlang)"
                  value={targetManagerName}
                  onChange={e => setTargetManagerName(e.target.value)}
                  required
                  disabled={submitting}
                />
                <datalist id="target-manager-suggestions">
                  {refs.managers?.map(m => (
                    <option key={`dl-m-${m.profile_id}`} value={m.full_name}>
                      {m.branch_name ? `Filial: ${m.branch_name}` : ''} {m.phone ? `(${m.phone})` : ''}
                    </option>
                  ))}
                  {refs.branches?.filter(b => b.manager_name).map(b => (
                    <option key={`dl-bm-${b.id}`} value={b.manager_name}>
                      Filial: {b.name}
                    </option>
                  ))}
                </datalist>
              </div>

              {/* Price calculation mode */}
              <div className="bt-field">
                <label>Narx hisoblash tartibi *</label>
                <div className="bt-price-toggle-group">
                  <button
                    type="button"
                    className={`bt-toggle-btn ${priceMode === 'cost' ? 'active' : ''}`}
                    onClick={() => switchPriceMode('cost')}
                  >
                    <Tag size={15} />
                    <span>Tannarxi bo‘yicha</span>
                  </button>
                  <button
                    type="button"
                    className={`bt-toggle-btn ${priceMode === 'markup' ? 'active' : ''}`}
                    onClick={() => switchPriceMode('markup')}
                  >
                    <Percent size={15} />
                    <span>Ustama qo‘yish</span>
                  </button>
                </div>
              </div>

              {/* If markup mode active */}
              {priceMode === 'markup' && (
                <div className="bt-markup-box">
                  <div className="bt-markup-header">
                    <label>Tannarxga qo‘shiladigan ustama:</label>
                    <div className="bt-markup-unit-selector">
                      <button
                        type="button"
                        className={`bt-unit-btn ${markupType === 'usd' ? 'active' : ''}`}
                        onClick={() => changeMarkupType('usd')}
                      >
                        $ (USD)
                      </button>
                      <button
                        type="button"
                        className={`bt-unit-btn ${markupType === 'uzs' ? 'active' : ''}`}
                        onClick={() => changeMarkupType('uzs')}
                      >
                        so‘m (UZS)
                      </button>
                      <button
                        type="button"
                        className={`bt-unit-btn ${markupType === 'percent' ? 'active' : ''}`}
                        onClick={() => changeMarkupType('percent')}
                      >
                        % (Foiz)
                      </button>
                    </div>
                  </div>

                  <div className="bt-markup-input-row">
                    <div className="bt-markup-input-wrap">
                      <span className="bt-markup-prefix">+</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="input bt-markup-input"
                        value={markupValue}
                        onChange={e => setMarkupValue(numericText(e.target.value))}
                        placeholder="0"
                      />
                      <span className="bt-markup-suffix">
                        {markupType === 'usd' ? 'USD' : markupType === 'uzs' ? 'so‘m' : '%'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline bt-markup-apply-btn"
                      onClick={handleApplyMarkup}
                    >
                      Qo‘llash
                    </button>
                  </div>

                  <p className="bt-markup-example-text">
                    Har bir tovar tannarxiga <b>+{markupValue || 0} {markupType === 'usd' ? '$' : markupType === 'uzs' ? 'so‘m' : '%'}</b> qo‘shiladi. Quyida xohlasangiz har bir tovar narxini alohida ham o‘zgartirishingiz mumkin.
                  </p>
                </div>
              )}

              {priceMode === 'cost' && (
                <div className="bt-markup-notice-box">
                  <small>
                    ✅ <b>O‘z tannarxi tartibi:</b> Tovarlar ombordagi dastlabki kelgan tannarxi bo‘yicha filialga o‘tkaziladi.
                  </small>
                </div>
              )}

              <div className="bt-field">
                <label>Qo‘shimcha izoh yoki sabab</label>
                <textarea
                  className="input textarea"
                  rows={2}
                  placeholder="Transfer sababi, yuk xati raqami..."
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            {/* Right Column: Search Scanner & Products List */}
            <div className="bt-main-content">
              {/* Scan and Search Bar */}
              <div className="card bt-scan-card">
                <div className="bt-scan-header">
                  <b><Search size={16} /> Tovarlarni qidirish yoki skanerlash</b>
                  <span className="bt-badge-info">Nom, shtrix-kod yoki QR kod orqali</span>
                </div>

                <div className="bt-scan-row">
                  <div className="bt-input-icon-wrap">
                    <Search size={18} className="icon-search" />
                    <input
                      type="text"
                      className="input bt-scan-input"
                      placeholder="Tovar nomi, shtrix-kod yoki QR kodni kiriting..."
                      value={code}
                      onChange={e => setCode(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleScan();
                        }
                      }}
                      disabled={!fromLocationId || scanBusy}
                      autoFocus
                    />
                    {code && (
                      <button
                        type="button"
                        className="btn-clear"
                        onClick={() => { setCode(''); setSearchResults([]); }}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>

                  <div className="bt-scan-actions">
                    <QrScanButton
                      onScan={scannedText => {
                        let clean = (scannedText || '').trim();
                        if (clean.includes('/qr/')) {
                          clean = clean.substring(clean.indexOf('/qr/') + 4);
                        }
                        if (clean.includes('?')) {
                          clean = clean.split('?')[0];
                        }
                        clean = clean.trim();
                        setCode(clean);
                        findExternalTransferProduct(branchId, fromLocationId, clean)
                          .then(found => {
                            if (found) addProduct(found);
                            else toast?.('Tovar topilmadi');
                          })
                          .catch(e => setError(msg(e)));
                      }}
                      title="Kamera orqali skanerlash"
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleScan}
                      disabled={!code.trim() || scanBusy}
                    >
                      <Plus size={16} />
                      <span>{scanBusy ? 'Qidirilmoqda…' : 'Qo‘shish'}</span>
                    </button>
                  </div>
                </div>

                {/* Dropdown Suggestions */}
                {searchResults.length > 0 && (
                  <div className="bt-search-dropdown">
                    <div className="bt-dropdown-head">
                      <small>Topilgan tovarlar ({searchResults.length} ta)</small>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => setSearchResults([])}
                      >
                        Yopish
                      </button>
                    </div>
                    <div className="bt-dropdown-list">
                      {searchResults.map(prod => (
                        <div
                          key={prod.product_id}
                          className="bt-search-item"
                          onClick={() => addProduct(prod)}
                        >
                          <div className="bt-item-thumb">
                            {prod.image ? <img src={prod.image} alt="" /> : <Package size={20} />}
                          </div>
                          <div className="bt-item-info">
                            <b>{prod.product_name}</b>
                            <div className="bt-item-search-meta">
                              {prod.sku && <span>SKU: {prod.sku}</span>}
                              <span>Mavjud: <b>{prod.available_count} ta</b></span>
                              <span>Tannarx: <b>${prod.cost_price_usd > 0 ? prod.cost_price_usd.toFixed(2) : (rate > 0 ? (prod.cost_price / rate).toFixed(2) : '0')}</b></span>
                              {prod.components && prod.components.length > 0 && (
                                <span className="bt-sku-badge" style={{ background: '#e0e7ff', color: '#3730a3', border: '1px solid #c7d2fe', fontWeight: 600 }}>
                                  Qismlarga bo‘linadi ({prod.components.length})
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="bt-item-price-side">
                            <strong>{new Intl.NumberFormat('uz-UZ').format(prod.cost_price)} so‘m</strong>
                            <button type="button" className="btn btn-sm btn-primary bt-add-pill">
                              {prod.components && prod.components.length > 0 ? (
                                <>
                                  <Layers size={12} /> Qismlarini tanlash
                                </>
                              ) : (
                                <>
                                  <Plus size={12} /> Tanlash
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Selected Items Card */}
              <div className="card bt-items-card">
                <div className="bt-items-header between">
                  <div>
                    <h3 className="bt-card-title"><Boxes size={18} /> Transfer qilinayotgan tovarlar</h3>
                    <small>Har bir tovar miqdorini va transfer narxini tekshiring. <b>(Transfer narxi faqat ushbu hujjatda o‘zgaradi, asosiy tovar va ombordagi tannarx o‘zgarmaydi)</b></small>
                  </div>
                  {items.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Ommaviy ustama:</span>
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => applyBulkMarkupUsd(0)} title="Barcha tovarlarni 0$ (o‘z tannarxi)ga qaytarish">0$ (Tannarxi)</button>
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => applyBulkMarkupUsd(1)} title="Barchasiga +1$ ustama">+1$</button>
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => applyBulkMarkupUsd(2)} title="Barchasiga +2$ ustama">+2$</button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost text-danger"
                        onClick={() => {
                          if (window.confirm('Barcha tanlangan tovarlar transferdan o‘chirilsinmi?')) {
                            setItems([]);
                          }
                        }}
                      >
                        <Trash2 size={14} /> Tozalash
                      </button>
                    </div>
                  )}
                </div>

                {items.length === 0 ? (
                  <div className="bt-empty-state">
                    <Boxes size={40} className="empty-icon" />
                    <h4>Hali hech qanday tovar tanlanmagan</h4>
                    <p>Yuqoridagi maydondan tovar nomi yoki kodini yozib qidiring, yoki QR kodni skaner qiling.</p>
                  </div>
                ) : (
                  <div className="bt-items-list">
                    {items.map((item, idx) => {
                      const lineTotalUzs = (parseFloat(item.transfer_price) || 0) * (parseInt(item.quantity, 10) || 1);
                      const lineTotalUsd = (parseFloat(item.transfer_price_usd) || 0) * (parseInt(item.quantity, 10) || 1);

                      return (
                        <div key={item.product_id} className="bt-item-card">
                          <div className="bt-card-top">
                            <span className="bt-card-num">#{idx + 1}</span>

                            <div className="bt-card-pic">
                              {item.image ? <img src={item.image} alt="" /> : <Package size={22} />}
                            </div>

                            <div className="bt-card-title-box">
                              <b className="bt-card-name">{item.product_name}</b>
                              <div className="bt-card-badges">
                                {item.sku && <span className="bt-sku-badge">{item.sku}</span>}
                                {!item.is_component_only && (
                                  <span className="bt-stock-badge">
                                    Omborda: <b>{item.available_count} ta</b>
                                  </span>
                                )}
                                {item.qr_code && <span className="bt-qr-badge">QR: {item.qr_code}</span>}
                              </div>

                              {/* Modular Components Summary */}
                              {(item.has_components || (item.selected_components && item.selected_components.length > 0) || (item.components && item.components.length > 0)) && (
                                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <div className="bt-component-summary-tag">
                                    {item.is_component_only ? (
                                      <span className="bt-tag-comp-only">
                                        📦 Faqat qismlar ({item.selected_components?.reduce((s, c) => s + (Number(c.quantity) || 0), 0) || item.quantity} dona)
                                      </span>
                                    ) : (
                                      <span className="bt-tag-main-qty">
                                        Asosiy tovar: {item.main_quantity || item.quantity} dona
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      className="bt-edit-comps-btn"
                                      onClick={() => openComponentConfig(item)}
                                      title="Tarkibiy qismlarni qayta sozlash"
                                    >
                                      <Edit3 size={11} /> Qismlarni sozlash
                                    </button>
                                  </div>

                                  {Array.isArray(item.selected_components) && item.selected_components.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                      {item.selected_components.map((c, ci) => (
                                        <span
                                          key={ci}
                                          className="bt-tag-comp-chip"
                                          onClick={() => openComponentConfig(item)}
                                          style={{ cursor: 'pointer' }}
                                          title="Tahrirlash uchun bosing"
                                        >
                                          {c.name}: <b>{c.quantity} ta</b>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            <button
                              type="button"
                              className="bt-remove-btn"
                              title="O‘chirish"
                              onClick={() => setItems(items.filter(x => x.product_id !== item.product_id))}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>

                          <div className="bt-card-bottom">
                            {/* Quantity Counter */}
                            {item.is_component_only ? (
                              <div className="bt-card-qty">
                                <small className="bt-section-label">Qismlar soni:</small>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span className="bt-tag-comp-only" style={{ padding: '6px 12px', fontSize: 13, fontWeight: 700 }}>
                                    {item.quantity} ta
                                  </span>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline bt-edit-comps-btn"
                                    onClick={() => openComponentConfig(item)}
                                    title="Qismlar miqdorini o‘zgartirish"
                                  >
                                    <Edit3 size={12} /> Sozlash
                                  </button>
                                </div>
                                <span className="bt-max-hint" style={{ color: '#059669', fontWeight: 600 }}>
                                  (Asosiy tovardan 0 dona)
                                </span>
                              </div>
                            ) : (
                              <div className="bt-card-qty">
                                <small className="bt-section-label">Soni:</small>
                                <div className="bt-qty-controls">
                                  <button
                                    type="button"
                                    className="bt-qty-btn"
                                    onClick={() => handleQuantityChange(item.product_id, item.quantity - 1)}
                                    disabled={item.quantity <= 1}
                                  >
                                    <Minus size={14} />
                                  </button>
                                  <input
                                    type="number"
                                    className="bt-qty-input"
                                    min="1"
                                    max={item.available_count}
                                    value={item.quantity}
                                    onChange={e => handleQuantityChange(item.product_id, e.target.value)}
                                  />
                                  <button
                                    type="button"
                                    className="bt-qty-btn"
                                    onClick={() => handleQuantityChange(item.product_id, item.quantity + 1)}
                                    disabled={item.quantity >= item.available_count}
                                  >
                                    <Plus size={14} />
                                  </button>
                                </div>
                                <span className="bt-max-hint">Maks: {item.available_count} ta</span>
                                {(item.has_components || (item.components && item.components.length > 0)) && (
                                  <button
                                    type="button"
                                    className="bt-edit-comps-btn"
                                    style={{ marginTop: 4 }}
                                    onClick={() => openComponentConfig(item)}
                                  >
                                    <Layers size={11} /> Qismlar
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Pricing details v2: Individual Markup Controls */}
                            <div className="bt-card-pricing-v2">
                              {/* Col 1: Cost Info */}
                              <div className="bt-cost-col">
                                <small className="bt-section-label">Tannarxi:</small>
                                <div className="bt-cost-val">
                                  <b>${item.cost_price_usd > 0 ? item.cost_price_usd.toFixed(2) : (rate > 0 ? (item.cost_price / rate).toFixed(2) : '0')}</b>
                                </div>
                                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                                  ({new Intl.NumberFormat('uz-UZ').format(item.cost_price)} so‘m)
                                </small>
                                {(item.markup_usd || 0) > 0 ? (
                                  <span className="bt-markup-active-badge">
                                    +${item.markup_usd} ustama
                                  </span>
                                ) : (
                                  <span className="bt-markup-zero-badge">
                                    Tannarxida (0$)
                                  </span>
                                )}
                              </div>

                              {/* Col 2: Individual Markup Input & Presets */}
                              <div className="bt-markup-col">
                                <small className="bt-section-label">Ustama ($):</small>
                                <div className="bt-markup-input-wrap-mini">
                                  <span className="bt-plus-prefix">+</span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    className="bt-markup-input-mini"
                                    value={item.markup_usd !== undefined && item.markup_usd !== null ? item.markup_usd : ''}
                                    onChange={e => handleItemMarkupChange(item.product_id, e.target.value)}
                                    placeholder="0"
                                    title="Ushbu tovar tannarxiga qo‘shiladigan ustama ($)"
                                  />
                                  <span className="bt-dollar-suffix">$</span>
                                </div>
                                <div className="bt-mini-presets">
                                  <button
                                    type="button"
                                    className={`bt-mini-preset-btn ${item.markup_usd !== '' && Number(item.markup_usd) === 0 ? 'active' : ''}`}
                                    onClick={() => handleItemMarkupChange(item.product_id, '0')}
                                    title="0$ ustama (Faqat o‘z tannarxi)"
                                  >
                                    0$
                                  </button>
                                  <button
                                    type="button"
                                    className={`bt-mini-preset-btn ${item.markup_usd !== '' && Number(item.markup_usd) === 1 ? 'active' : ''}`}
                                    onClick={() => handleItemMarkupChange(item.product_id, '1')}
                                    title="+1$ ustama"
                                  >
                                    +1$
                                  </button>
                                  <button
                                    type="button"
                                    className={`bt-mini-preset-btn ${item.markup_usd !== '' && Number(item.markup_usd) === 2 ? 'active' : ''}`}
                                    onClick={() => handleItemMarkupChange(item.product_id, '2')}
                                    title="+2$ ustama"
                                  >
                                    +2$
                                  </button>
                                  <button
                                    type="button"
                                    className={`bt-mini-preset-btn ${item.markup_usd !== '' && Number(item.markup_usd) === 5 ? 'active' : ''}`}
                                    onClick={() => handleItemMarkupChange(item.product_id, '5')}
                                    title="+5$ ustama"
                                  >
                                    +5$
                                  </button>
                                </div>
                              </div>

                              {/* Col 3: Filial Transfer Price */}
                              <div className="bt-final-price-col">
                                <small className="bt-section-label">Filial narxi:</small>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <div className="bt-markup-input-wrap-mini" title="Filialga beriladigan narx ($)">
                                    <span className="bt-dollar-suffix" style={{ marginRight: 2 }}>$</span>
                                    <input
                                      type="text"
                                      inputMode="decimal"
                                      className="bt-markup-input-mini"
                                      value={item.transfer_price_usd !== undefined && item.transfer_price_usd !== null ? item.transfer_price_usd : ''}
                                      onChange={e => handleItemUsdPriceChange(item.product_id, e.target.value)}
                                      placeholder="0.00"
                                    />
                                    <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 3 }}>USD</span>
                                  </div>
                                  <div className="bt-markup-input-wrap-mini" title="Filialga beriladigan narx (so‘m)">
                                    <input
                                      type="text"
                                      inputMode="numeric"
                                      className="bt-markup-input-mini"
                                      style={{ paddingLeft: 6 }}
                                      value={item.transfer_price !== undefined && item.transfer_price !== null ? item.transfer_price : ''}
                                      onChange={e => handleItemUzsPriceChange(item.product_id, e.target.value)}
                                      placeholder="0"
                                    />
                                    <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 3 }}>so‘m</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Line Subtotal */}
                            <div className="bt-card-total">
                              <small className="bt-section-label">Jami qator:</small>
                              <b className="bt-line-total-uzs">
                                {new Intl.NumberFormat('uz-UZ').format(lineTotalUzs)} so‘m
                              </b>
                              <span className="bt-line-total-usd">
                                ≈ ${lineTotalUsd.toFixed(2)} USD
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Bottom Floating Bar / Summary */}
              {items.length > 0 && (
                <div className="card bt-footer-card">
                  <div className="bt-summary-stats">
                    <div className="bt-stat-item">
                      <small>Umumiy tovarlar:</small>
                      <b>{items.length} xil · {totalUnits} dona</b>
                    </div>
                    <div className="bt-stat-item bt-stat-total">
                      <small>Umumiy transfer qiymati:</small>
                      <b className="bt-grand-total">
                        {new Intl.NumberFormat('uz-UZ').format(totalValue)} so‘m
                      </b>
                      <span className="bt-usd-equiv">
                        ≈ ${totalValueUsd.toFixed(2)} USD
                      </span>
                    </div>
                  </div>

                  <div className="bt-footer-actions">
                    <button
                      type="submit"
                      className="btn btn-primary bt-submit-btn"
                      disabled={submitting || items.length === 0}
                    >
                      <Send size={18} />
                      <span>{submitting ? 'Transfer amalga oshirilmoqda…' : `Transferni tasdiqlash (${totalUnits} dona)`}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      )}

      {/* ============================================================ */}
      {/* VIEW 2: TRANSFERLAR TARIXI                                     */}
      {/* ============================================================ */}
      {activeTab === 'history' && (
        <div className="bt-history-container">
          {/* KPI Bar */}
          <div className="bt-history-kpi-bar">
            <div className="bt-history-kpi-card">
              <div className="bt-kpi-icon blue"><Truck size={22} /></div>
              <div>
                <small>Jami transferlar</small>
                <b>{historyData.total_count} ta transfer</b>
              </div>
            </div>

            <div className="bt-history-kpi-card">
              <div className="bt-kpi-icon orange"><Boxes size={22} /></div>
              <div>
                <small>O‘tkazilgan tovarlar</small>
                <b>{historyData.total_items_count} dona</b>
              </div>
            </div>

            <div className="bt-history-kpi-card">
              <div className="bt-kpi-icon green"><Layers size={22} /></div>
              <div>
                <small>Jami transfer qiymati</small>
                <b>{new Intl.NumberFormat('uz-UZ').format(historyData.total_value_uzs || 0)} so‘m</b>
                {rate > 0 && (
                  <span className="bt-kpi-usd">≈ ${(historyData.total_value_usd || 0).toFixed(2)} USD</span>
                )}
              </div>
            </div>
          </div>

          {/* Toolbar: Search and Filters */}
          <div className="bt-history-toolbar">
            <div className="bt-toolbar-search">
              <Search size={18} />
              <input
                type="text"
                className="input"
                placeholder="Hujjat raqami, filial nomi, rahbar yoki tovar nomi bo‘yicha qidiring..."
                value={historyQuery}
                onChange={e => {
                  setHistoryQuery(e.target.value);
                  setHistoryPage(1);
                }}
              />
              {historyQuery && (
                <button type="button" className="btn-clear" onClick={() => setHistoryQuery('')}>
                  <X size={16} />
                </button>
              )}
            </div>

            <div className="bt-toolbar-filters">
              {/* Presets */}
              <div className="bt-filter-presets">
                <button
                  type="button"
                  className={`bt-filter-preset-btn ${!historyFromDate && !historyToDate ? 'active' : ''}`}
                  onClick={() => applyDatePreset('all')}
                >
                  Hammasi
                </button>
                <button
                  type="button"
                  className="bt-filter-preset-btn"
                  onClick={() => applyDatePreset('today')}
                >
                  Bugun
                </button>
                <button
                  type="button"
                  className="bt-filter-preset-btn"
                  onClick={() => applyDatePreset('week')}
                >
                  7 kun
                </button>
                <button
                  type="button"
                  className="bt-filter-preset-btn"
                  onClick={() => applyDatePreset('month')}
                >
                  Bu oy
                </button>
              </div>

              {/* Date pickers & Price mode */}
              <div className="bt-filter-inputs">
                <input
                  type="date"
                  className="input"
                  value={historyFromDate}
                  onChange={e => { setHistoryFromDate(e.target.value); setHistoryPage(1); }}
                  title="Boshlanish sanasi"
                />
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                <input
                  type="date"
                  className="input"
                  value={historyToDate}
                  onChange={e => { setHistoryToDate(e.target.value); setHistoryPage(1); }}
                  title="Tugash sanasi"
                />

                <select
                  className="select"
                  value={historyPriceMode}
                  onChange={e => { setHistoryPriceMode(e.target.value); setHistoryPage(1); }}
                >
                  <option value="all">Barcha narxlar</option>
                  <option value="cost">Tannarx</option>
                  <option value="markup">Ustama</option>
                  <option value="wholesale">Ulgurji</option>
                </select>
              </div>
            </div>
          </div>

          {/* Transfers List */}
          {historyLoading ? (
            <div className="card" style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)' }}>
              Transferlar yuklanmoqda…
            </div>
          ) : historyError ? (
            <div className="bt-error-banner">
              <AlertTriangle size={18} />
              <span>{historyError}</span>
              <button type="button" className="btn btn-sm btn-outline" onClick={loadHistory}>Qayta urinish</button>
            </div>
          ) : historyData.items.length === 0 ? (
            <div className="card bt-empty-state">
              <FileText size={44} className="empty-icon" />
              <h4>Transferlar topilmadi</h4>
              <p>Belgilangan filtrlar bo‘yicha hech qanday transfer mavjud emas.</p>
              <button type="button" className="btn btn-primary" onClick={() => setActiveTab('new')} style={{ marginTop: 12 }}>
                <Plus size={16} /> Yangi transfer yaratish
              </button>
            </div>
          ) : (
            <div className="bt-history-list">
              {historyData.items.map(t => {
                const isCancelled = t.status === 'cancelled';
                return (
                  <div key={t.id} className="bt-hist-card">
                    {/* Header */}
                    <div className="bt-hist-card-head">
                      <div className="bt-hist-num-date">
                        <span className="bt-hist-num">#{t.transfer_no}</span>
                        <span className="bt-hist-date">
                          <Clock size={13} />
                          {new Date(t.created_at).toLocaleString('uz-UZ')}
                        </span>
                      </div>

                      <span className={`bt-hist-status-badge ${isCancelled ? 'cancelled' : 'active'}`}>
                        {isCancelled ? 'Bekor qilingan (Omborga qaytarilgan)' : 'Faol / Yuborilgan'}
                      </span>
                    </div>

                    {/* Route Box */}
                    <div className="bt-hist-route-box">
                      <div className="bt-hist-party">
                        <small>Jo‘natuvchi</small>
                        <b>{t.branch_name || 'Asosiy filial'} ({t.from_location_name || 'Do‘kon/Ombor'})</b>
                        <em>Mas’ul: {t.seller_name || 'Sotuvchi'}</em>
                      </div>

                      <div className="bt-hist-arrow">
                        <ArrowUpRight size={20} />
                      </div>

                      <div className="bt-hist-party">
                        <small>Qabul qiluvchi filial</small>
                        <b style={{ color: 'var(--orange)' }}>{t.target_branch_name}</b>
                        <em>Rahbar: {t.target_manager_name}</em>
                      </div>
                    </div>

                    {/* Meta Bar */}
                    <div className="bt-hist-meta-bar">
                      <div className="bt-hist-stats-group">
                        <div className="bt-hist-stat">
                          <small>Narx tartibi</small>
                          <b>{t.price_mode === 'cost' ? 'O‘z tannarxi' : t.price_mode === 'markup' ? 'Ustama bilan' : t.price_mode === 'wholesale' ? 'Ulgurji' : 'Erkin'}</b>
                        </div>
                        <div className="bt-hist-stat">
                          <small>Tovarlar soni</small>
                          <b>{t.total_items_count} dona tovar</b>
                        </div>
                        <div className="bt-hist-stat">
                          <small>Jami transfer summasi</small>
                          <b className="bt-hist-stat-amount">
                            {new Intl.NumberFormat('uz-UZ').format(t.total_amount)} so‘m
                            {t.total_amount_usd > 0 && (
                              <span style={{ fontSize: 11.5, color: '#0284c7', fontWeight: 600, marginLeft: 6 }}>
                                (≈ ${Number(t.total_amount_usd).toFixed(2)})
                              </span>
                            )}
                          </b>
                        </div>
                      </div>

                      {t.notes && (
                        <div className="bt-hist-note" title={t.notes}>
                          Izoh: {t.notes}
                        </div>
                      )}
                    </div>

                    {/* Actions Bar */}
                    <div className="bt-hist-actions">
                      <button
                        type="button"
                        className="bt-hist-act-btn primary"
                        onClick={() => openDetail(t.id)}
                      >
                        <Eye size={15} />
                        <span>Batafsil ko‘rish</span>
                      </button>

                      {canModifyTransfer(t) ? (
                        <>
                          <button
                            type="button"
                            className="bt-hist-act-btn edit"
                            onClick={e => openEditModal(t, e)}
                            title="Filial nomi, rahbari yoki izohini tahrirlash"
                          >
                            <Edit3 size={15} />
                            <span>Tahrirlash</span>
                          </button>

                          {!isCancelled && (
                            <button
                              type="button"
                              className="bt-hist-act-btn reload"
                              onClick={e => handleReloadToEdit(t, e)}
                              title="Transfer tovarlarini o‘zgartirish uchun yangi transfer oynasiga yuklash"
                            >
                              <RotateCcw size={15} />
                              <span>Tovarlarni tahrirlash</span>
                            </button>
                          )}

                          {!isCancelled && (
                            <button
                              type="button"
                              className="bt-hist-act-btn cancel"
                              onClick={e => handleCancelTransfer(t, e)}
                              disabled={actionBusy}
                              title="Transferni bekor qilish va tovarlarni zudlik bilan omborga qaytarish"
                            >
                              <X size={15} />
                              <span>Bekor qilish</span>
                            </button>
                          )}

                          <button
                            type="button"
                            className="bt-hist-act-btn delete"
                            onClick={e => handleDeleteTransfer(t, e)}
                            disabled={actionBusy}
                            title="Transferni butunlay o‘chirish"
                          >
                            <Trash2 size={15} />
                            <span>O‘chirish</span>
                          </button>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', background: 'var(--surface-2, #f1f5f9)', borderRadius: 8 }}>
                          🔒 Faqat yuborgan sotuvchi ({t.seller_name || 'yuboruvchi'}) tahrirlay oladi
                        </span>
                      )}

                      <button
                        type="button"
                        className="bt-hist-act-btn"
                        onClick={() => printReceiptWindow(t)}
                        title="Chekni chop etish"
                        style={{ marginLeft: 'auto' }}
                      >
                        <Printer size={15} />
                        <span>Chek</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* COMPLETED TRANSFER SUCCESS MODAL                              */}
      {/* ============================================================ */}
      <Modal
        open={Boolean(completedTransfer)}
        onClose={() => setCompletedTransfer(null)}
        title="Transfer muvaffaqiyatli amalga oshirildi!"
      >
        {completedTransfer && (
          <div className="bt-success-modal">
            <div className="bt-success-badge">
              <CheckCircle2 size={48} className="success-icon" />
              <h3>#{completedTransfer.transfer_no}</h3>
              <p>Tovarlar ombor/do‘kon balansidan muvaffaqiyatli chiqarildi</p>
            </div>

            <div className="bt-receipt-preview card">
              <div className="between">
                <span>Qabul qiluvchi:</span>
                <b>{completedTransfer.target_branch_name}</b>
              </div>
              <div className="between">
                <span>Mas’ul boshliq:</span>
                <b>{completedTransfer.target_manager_name}</b>
              </div>
              <div className="between">
                <span>Jo‘natuvchi:</span>
                <span>{completedTransfer.branch_name} ({completedTransfer.from_location_name})</span>
              </div>
              <div className="between">
                <span>Sana va vaqt:</span>
                <span>{new Date(completedTransfer.created_at).toLocaleString('uz-UZ')}</span>
              </div>
              <div className="between">
                <span>Narx turi:</span>
                <b>{completedTransfer.price_mode === 'cost' ? 'O‘z tannarxi bo‘yicha' : 'Tannarxga ustama qo‘yilgan'}</b>
              </div>
              <div className="bt-receipt-divider" />
              <div className="bt-receipt-lines">
                {completedTransfer.lines?.map((line, idx) => (
                  <div key={line.id || idx} className="bt-receipt-line">
                    <div>
                      <b>{idx + 1}. {line.product_name}</b>
                      {Array.isArray(line.selected_components) && line.selected_components.length > 0 && (
                        <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {line.selected_components.map((c, ci) => (
                            <span key={ci} className="bt-tag-comp-chip" style={{ fontSize: 10.5, padding: '1px 5px' }}>
                              {c.name}: <b>{c.quantity} ta</b>
                            </span>
                          ))}
                        </div>
                      )}
                      <small>
                        {line.quantity} dona × {new Intl.NumberFormat('uz-UZ').format(line.unit_price)} so‘m
                        {line.selected_components?.length > 0 && line.main_quantity === 0 ? ' (Faqat qismlar)' : ''}
                      </small>
                    </div>
                    <b>{new Intl.NumberFormat('uz-UZ').format(line.total_price)} so‘m</b>
                  </div>
                ))}
              </div>
              <div className="bt-receipt-divider" />
              <div className="between bt-receipt-total">
                <span>JAMI SUMMA:</span>
                <b>{new Intl.NumberFormat('uz-UZ').format(completedTransfer.total_amount)} so‘m</b>
              </div>
            </div>

            <div className="bt-modal-actions" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => printReceiptWindow(completedTransfer)}
              >
                <Printer size={18} /> Chekni chop etish
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  setCompletedTransfer(null);
                  setActiveTab('history');
                  loadHistory();
                }}
              >
                <Clock size={18} /> Tarixni ko‘rish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCompletedTransfer(null)}
              >
                Yangi transfer yaratish
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ============================================================ */}
      {/* DETAIL MODAL                                                  */}
      {/* ============================================================ */}
      <Modal
        open={Boolean(detailId)}
        onClose={() => { setDetailId(null); setDetailData(null); }}
        title={detailData ? `Transfer tafsilotlari (#${detailData.transfer_no})` : 'Yuklanmoqda…'}
      >
        {detailLoading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
            Tafsilotlar yuklanmoqda…
          </div>
        ) : detailData ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Top metadata */}
            <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <div className="between">
                <span>Hujjat raqami:</span>
                <b style={{ fontFamily: 'monospace', fontSize: 14 }}>#{detailData.transfer_no}</b>
              </div>
              <div className="between">
                <span>Holati:</span>
                <span className={`bt-hist-status-badge ${detailData.status === 'cancelled' ? 'cancelled' : 'active'}`}>
                  {detailData.status === 'cancelled' ? 'Bekor qilingan' : 'Faol'}
                </span>
              </div>
              <div className="between">
                <span>Jo‘natuvchi:</span>
                <b>{detailData.branch_name} ({detailData.from_location_name})</b>
              </div>
              <div className="between">
                <span>Mas’ul sotuvchi:</span>
                <b>{detailData.seller_name || 'Sotuvchi'}</b>
              </div>
              <div className="between">
                <span>Qabul qiluvchi filial:</span>
                <b style={{ color: 'var(--orange)' }}>{detailData.target_branch_name}</b>
              </div>
              <div className="between">
                <span>Filial boshlig‘i:</span>
                <b>{detailData.target_manager_name}</b>
              </div>
              <div className="between">
                <span>Sana:</span>
                <span>{new Date(detailData.created_at).toLocaleString('uz-UZ')}</span>
              </div>
              {detailData.notes && (
                <div style={{ background: 'var(--surface-2)', padding: '6px 10px', borderRadius: 6, fontSize: 12 }}>
                  <b>Izoh:</b> {detailData.notes}
                </div>
              )}
            </div>

            {/* Lines table */}
            <div style={{ overflowX: 'auto', maxHeight: 320 }}>
              <table className="bt-detail-table">
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Tovar</th>
                    <th style={{ textAlign: 'center' }}>Soni</th>
                    <th style={{ textAlign: 'right' }}>Transfer narxi</th>
                    <th style={{ textAlign: 'right' }}>Jami summa</th>
                  </tr>
                </thead>
                <tbody>
                  {detailData.lines?.map((line, idx) => (
                    <tr key={line.id || idx}>
                      <td>{idx + 1}</td>
                      <td>
                        <b>{line.product_name}</b>
                        {line.sku && <small style={{ display: 'block', color: 'var(--muted)' }}>SKU: {line.sku}</small>}
                        {Array.isArray(line.selected_components) && line.selected_components.length > 0 && (
                          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#4338ca' }}>
                              Tarkibiy qismlari:
                            </span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                              {line.selected_components.map((c, ci) => (
                                <span key={ci} className="bt-tag-comp-chip" style={{ fontSize: 10.5, padding: '1px 5px' }}>
                                  {c.name}: <b>{c.quantity} ta</b>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <b>{line.quantity} ta</b>
                        {Array.isArray(line.selected_components) && line.selected_components.length > 0 && line.main_quantity === 0 && (
                          <small style={{ display: 'block', color: '#059669', fontSize: 10, fontWeight: 600 }}>
                            (Faqat qismlar)
                          </small>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {new Intl.NumberFormat('uz-UZ').format(line.unit_price)} so‘m
                        {line.unit_price_usd > 0 && (
                          <small style={{ display: 'block', color: '#0284c7' }}>(${line.unit_price_usd})</small>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {new Intl.NumberFormat('uz-UZ').format(line.total_price)} so‘m
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Total Box */}
            <div className="between" style={{ padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 10, fontSize: 15 }}>
              <span>JAMI TRANSFER QIYMATI:</span>
              <div style={{ textAlign: 'right' }}>
                <b style={{ color: 'var(--orange)', fontSize: 17 }}>
                  {new Intl.NumberFormat('uz-UZ').format(detailData.total_amount)} so‘m
                </b>
                {detailData.total_amount_usd > 0 && (
                  <small style={{ display: 'block', color: '#0284c7', fontWeight: 600 }}>
                    ≈ ${detailData.total_amount_usd} USD
                  </small>
                )}
              </div>
            </div>

            {/* Modal Actions */}
            <div className="bt-modal-actions" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => printReceiptWindow(detailData)}
              >
                <Printer size={16} /> Chek chop etish
              </button>
              {canModifyTransfer(detailData) && (
                <>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => openEditModal(detailData)}
                  >
                    <Edit3 size={16} /> Tahrirlash
                  </button>
                  {detailData.status !== 'cancelled' && (
                    <button
                      type="button"
                      className="btn btn-outline text-warning"
                      onClick={() => handleReloadToEdit(detailData)}
                    >
                      <RotateCcw size={16} /> Tovarlarni tahrirlash
                    </button>
                  )}
                  {detailData.status !== 'cancelled' && (
                    <button
                      type="button"
                      className="btn btn-outline text-danger"
                      onClick={() => handleCancelTransfer(detailData)}
                    >
                      <X size={16} /> Bekor qilish
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-outline text-danger"
                    onClick={() => handleDeleteTransfer(detailData)}
                  >
                    <Trash2 size={16} /> O‘chirish
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { setDetailId(null); setDetailData(null); }}
              >
                Yopish
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ============================================================ */}
      {/* EDIT MODAL                                                    */}
      {/* ============================================================ */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={`Transferni tahrirlash (#${editForm.transfer_no})`}
      >
        <form onSubmit={handleSaveEdit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {(refs.branches?.length > 0 || refs.managers?.length > 0) && (
            <div className="bt-field">
              <label>Ro‘yxatdan tez tanlash:</label>
              <select
                className="select"
                defaultValue=""
                onChange={e => {
                  const val = e.target.value;
                  if (!val) return;
                  if (val.startsWith('b:')) {
                    const bId = val.replace('b:', '');
                    const b = refs.branches?.find(x => String(x.id) === bId);
                    if (b) {
                      setEditForm(prev => ({
                        ...prev,
                        targetBranchName: b.name,
                        targetManagerName: b.manager_name || prev.targetManagerName
                      }));
                    }
                  } else if (val.startsWith('m:')) {
                    const mId = val.replace('m:', '');
                    const m = refs.managers?.find(x => String(x.profile_id) === mId);
                    if (m) {
                      setEditForm(prev => ({
                        ...prev,
                        targetManagerName: m.full_name,
                        targetBranchName: m.branch_name || prev.targetBranchName
                      }));
                    }
                  }
                  e.target.value = '';
                }}
              >
                <option value="">-- Filial yoki menejerni tanlash --</option>
                {refs.branches?.length > 0 && (
                  <optgroup label="Tizimdagi filiallar">
                    {refs.branches.map(b => (
                      <option key={`edit-b-${b.id}`} value={`b:${b.id}`}>
                        🏛 {b.name} {b.manager_name ? `(${b.manager_name})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {refs.managers?.length > 0 && (
                  <optgroup label="Superadmindagi menejerlar">
                    {refs.managers.map(m => (
                      <option key={`edit-m-${m.profile_id}`} value={`m:${m.profile_id}`}>
                        👤 {m.full_name} {m.branch_name ? `(${m.branch_name})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          )}

          <div className="bt-field">
            <label>Qabul qiluvchi filial/do‘kon nomi *</label>
            <input
              type="text"
              className="input"
              list="edit-branch-suggestions"
              value={editForm.targetBranchName}
              onChange={e => setEditForm({ ...editForm, targetBranchName: e.target.value })}
              required
            />
            <datalist id="edit-branch-suggestions">
              {refs.branches?.map(b => (
                <option key={`eb-${b.id}`} value={b.name} />
              ))}
              {refs.managers?.filter(m => m.branch_name).map((m, idx) => (
                <option key={`emb-${idx}`} value={m.branch_name} />
              ))}
            </datalist>
          </div>

          <div className="bt-field">
            <label>Filial boshlig‘i (mas’ul shaxs) ismi *</label>
            <input
              type="text"
              className="input"
              list="edit-manager-suggestions"
              value={editForm.targetManagerName}
              onChange={e => setEditForm({ ...editForm, targetManagerName: e.target.value })}
              required
            />
            <datalist id="edit-manager-suggestions">
              {refs.managers?.map(m => (
                <option key={`em-${m.profile_id}`} value={m.full_name}>
                  {m.branch_name ? `Filial: ${m.branch_name}` : ''}
                </option>
              ))}
              {refs.branches?.filter(b => b.manager_name).map(b => (
                <option key={`ebm-${b.id}`} value={b.manager_name}>
                  Filial: {b.name}
                </option>
              ))}
            </datalist>
          </div>

          <div className="bt-field">
            <label>Izoh</label>
            <textarea
              className="input textarea"
              rows={3}
              value={editForm.notes}
              onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
              placeholder="Qo‘shimcha izoh..."
            />
          </div>

          <div className="bt-modal-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setEditModalOpen(false)}
              disabled={actionBusy}
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={actionBusy}
            >
              <CheckCircle2 size={16} />
              <span>{actionBusy ? 'Saqlanmoqda…' : 'O‘zgarishlarni saqlash'}</span>
            </button>
          </div>
        </form>
      </Modal>

      {/* ============================================================ */}
      {/* MODULAR PRODUCT COMPONENTS CONFIGURATION MODAL               */}
      {/* ============================================================ */}
      <TransferComponentModal
        open={Boolean(configuringProduct)}
        onClose={() => setConfiguringProduct(null)}
        product={configuringProduct}
        onSave={handleSaveConfiguredComponents}
        rate={rate}
      />
    </div>
  );
}

// ============================================================
// TRANSFER COMPONENT CONFIGURATION MODAL (MODULAR PRODUCTS)
// ============================================================
function TransferComponentModal({
  open,
  onClose,
  product,
  onSave,
  rate = 12000
}) {
  const [loading, setLoading] = useState(false);
  const [componentsList, setComponentsList] = useState([]);
  const [mainQty, setMainQty] = useState(1);
  const [compQuantities, setCompQuantities] = useState({});
  const [customMarkupUsd, setCustomMarkupUsd] = useState('');

  useEffect(() => {
    if (!open || !product) return;

    const initialMain = product.main_quantity !== undefined
      ? Number(product.main_quantity)
      : (product.is_component_only ? 0 : (Number(product.quantity) || 1));
    setMainQty(initialMain);
    setCustomMarkupUsd(product.markup_usd !== undefined && product.markup_usd !== null ? String(product.markup_usd) : '');

    const setupComponents = (comps) => {
      setComponentsList(comps);
      const qMap = {};
      const preselected = Array.isArray(product.selected_components) ? product.selected_components : [];

      comps.forEach(c => {
        const cId = c.id || c.component_id;
        const matched = preselected.find(x => (x.component_id && x.component_id === cId) || x.name === c.name);
        if (matched) {
          qMap[cId] = Number(matched.quantity) || 0;
        } else if (preselected.length > 0) {
          qMap[cId] = 0;
        } else {
          // If first time configuring, set standard kit quantity
          qMap[cId] = (Number(c.quantity) || 1) * Math.max(1, initialMain);
        }
      });
      setCompQuantities(qMap);
    };

    if (Array.isArray(product.components) && product.components.length > 0) {
      setupComponents(product.components);
      setLoading(false);
    } else if (product.product_id) {
      setLoading(true);
      getProductComponents(product.product_id)
        .then(res => {
          setupComponents(res || []);
        })
        .catch(() => {
          setupComponents([]);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, product]);

  if (!open || !product) return null;

  const handleCompQtyChange = (compId, val) => {
    const parsed = parseInt(val, 10);
    setCompQuantities(prev => ({
      ...prev,
      [compId]: isNaN(parsed) || parsed < 0 ? 0 : parsed
    }));
  };

  const handleSetAllStandard = () => {
    const qMap = {};
    const multiplier = Math.max(1, mainQty);
    componentsList.forEach(c => {
      const cId = c.id || c.component_id;
      qMap[cId] = (Number(c.quantity) || 1) * multiplier;
    });
    setCompQuantities(qMap);
  };

  const handleResetAllToZero = () => {
    const qMap = {};
    componentsList.forEach(c => {
      const cId = c.id || c.component_id;
      qMap[cId] = 0;
    });
    setCompQuantities(qMap);
  };

  const isComponentOnly = mainQty === 0;
  const availableMainStock = Number(product.available_count || 0);

  // Total components count and costs
  let totalCompsCount = 0;
  let totalCompsCostUsd = 0;
  let totalCompsCostUzs = 0;

  componentsList.forEach(c => {
    const cId = c.id || c.component_id;
    const q = Number(compQuantities[cId]) || 0;
    if (q > 0) {
      totalCompsCount += q;
      const cCostUsd = Number(c.cost_price_usd) || (rate > 0 && c.cost_price ? Number(c.cost_price) / rate : 0);
      const cCostUzs = Number(c.cost_price) || (rate > 0 ? Math.round(cCostUsd * rate) : 0);
      totalCompsCostUsd += cCostUsd * q;
      totalCompsCostUzs += cCostUzs * q;
    }
  });

  // Calculate base & line total
  let totalLineCostUsd = 0;
  let totalLineCostUzs = 0;

  if (isComponentOnly) {
    totalLineCostUsd = totalCompsCostUsd;
    totalLineCostUzs = totalCompsCostUzs;
  } else {
    const baseUnitCostUsd = Number(product.cost_price_usd) || (rate > 0 && product.cost_price ? Number(product.cost_price) / rate : 0);
    const baseUnitCostUzs = Number(product.cost_price) || Math.round(baseUnitCostUsd * rate);
    totalLineCostUsd = (baseUnitCostUsd * mainQty);
    totalLineCostUzs = (baseUnitCostUzs * mainQty);
  }

  const handleConfirm = () => {
    if (mainQty === 0 && totalCompsCount === 0) {
      alert('Iltimos, kamida 1 ta qism yoki asosiy tovar miqdorini belgilang!');
      return;
    }

    if (mainQty > availableMainStock) {
      alert(`Asosiy tovardan omborda ko‘pi bilan ${availableMainStock} ta mavjud!`);
      return;
    }

    const selectedComponents = componentsList
      .filter(c => {
        const cId = c.id || c.component_id;
        return (Number(compQuantities[cId]) || 0) > 0;
      })
      .map(c => {
        const cId = c.id || c.component_id;
        const q = Number(compQuantities[cId]) || 0;
        const cCostUsd = Number(c.cost_price_usd) || (rate > 0 && c.cost_price ? Number(c.cost_price) / rate : 0);
        const cCostUzs = Number(c.cost_price) || Math.round(cCostUsd * rate);
        return {
          component_id: cId,
          name: c.name,
          quantity: q,
          cost_price: cCostUzs,
          cost_price_usd: Number(cCostUsd.toFixed(2)),
          unit_price: cCostUzs,
          unit_price_usd: Number(cCostUsd.toFixed(2))
        };
      });

    // Determine line quantity and transfer price
    let finalQty = 1;
    let finalCostUzs = 0;
    let finalCostUsd = 0;

    if (isComponentOnly) {
      if (selectedComponents.length === 1) {
        finalQty = selectedComponents[0].quantity;
        finalCostUzs = selectedComponents[0].cost_price;
        finalCostUsd = selectedComponents[0].cost_price_usd;
      } else {
        finalQty = 1;
        finalCostUzs = totalCompsCostUzs;
        finalCostUsd = Number(totalCompsCostUsd.toFixed(2));
      }
    } else {
      finalQty = mainQty;
      finalCostUsd = Number((totalLineCostUsd / mainQty).toFixed(2));
      finalCostUzs = Math.round(totalLineCostUzs / mainQty);
    }

    const markupUsdNum = parseFloat(customMarkupUsd) || 0;
    const finalTransferUsd = Number((finalCostUsd + markupUsdNum).toFixed(2));
    const finalTransferUzs = rate > 0 ? Math.round(finalTransferUsd * rate) : finalCostUzs;

    onSave({
      ...product,
      quantity: finalQty,
      main_quantity: mainQty,
      is_component_only: isComponentOnly,
      has_components: true,
      components: componentsList,
      selected_components: selectedComponents,
      cost_price: finalCostUzs,
      cost_price_usd: finalCostUsd,
      markup_usd: customMarkupUsd !== '' ? customMarkupUsd : 0,
      transfer_price: finalTransferUzs,
      transfer_price_usd: finalTransferUsd
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Tarkibiy qismlarni sozlash: ${product.product_name}`}
    >
      <div className="bt-comp-modal-content">
        {/* Product Meta Card */}
        <div className="bt-comp-product-card">
          <div className="bt-card-pic" style={{ width: 44, height: 44 }}>
            {product.image ? <img src={product.image} alt="" /> : <Package size={22} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ fontSize: 14 }}>{product.product_name}</b>
            <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              {product.sku && <span>SKU: {product.sku}</span>}
              <span>Omborda to‘liq mavjud: <b>{availableMainStock} ta</b></span>
            </div>
          </div>
        </div>

        {/* Section 1: Main Product Body Quantity */}
        <div className="bt-comp-section">
          <div className="bt-comp-section-title">
            <span>1. Asosiy tovar soni (Beshik korpusi / to‘plami):</span>
          </div>

          <div className="bt-comp-main-qty-row">
            <div className="bt-comp-stepper">
              <button
                type="button"
                className="bt-comp-stepper-btn"
                onClick={() => setMainQty(prev => Math.max(0, prev - 1))}
                disabled={mainQty <= 0}
              >
                <Minus size={15} />
              </button>
              <input
                type="number"
                min="0"
                max={availableMainStock}
                className="bt-comp-stepper-input"
                value={mainQty}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  setMainQty(isNaN(v) || v < 0 ? 0 : Math.min(v, availableMainStock));
                }}
              />
              <button
                type="button"
                className="bt-comp-stepper-btn"
                onClick={() => setMainQty(prev => Math.min(availableMainStock, prev + 1))}
                disabled={mainQty >= availableMainStock}
              >
                <Plus size={15} />
              </button>
            </div>

            <div className="bt-comp-quick-chips">
              <button
                type="button"
                className={`bt-comp-chip ${mainQty === 0 ? 'active' : ''}`}
                onClick={() => setMainQty(0)}
              >
                0 dona (Faqat qismlar)
              </button>
              {availableMainStock >= 1 && (
                <button
                  type="button"
                  className={`bt-comp-chip ${mainQty === 1 ? 'active' : ''}`}
                  onClick={() => setMainQty(1)}
                >
                  1 komplekt
                </button>
              )}
              {availableMainStock >= 2 && (
                <button
                  type="button"
                  className={`bt-comp-chip ${mainQty === 2 ? 'active' : ''}`}
                  onClick={() => setMainQty(2)}
                >
                  2 komplekt
                </button>
              )}
            </div>
          </div>

          {mainQty === 0 ? (
            <div className="bt-comp-notice warning">
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <div>
                <b>Faqat tarkibiy qismlar yuborilmoqda (Asosiy tovardan 0 dona).</b>
                <div>Ombordagi to‘liq mahsulot soni kamaytirilmaydi, faqat filialga tanlangan qismlar o‘tkaziladi.</div>
              </div>
            </div>
          ) : (
            <div className="bt-comp-notice success">
              <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
              <div>
                <b>Asosiy tovardan {mainQty} dona yuboriladi.</b>
                <div>Ombordagi to‘liq mahsulot balansidan {mainQty} dona chiqariladi.</div>
              </div>
            </div>
          )}
        </div>

        {/* Section 2: Component Quantities */}
        <div className="bt-comp-section">
          <div className="bt-comp-section-title">
            <span>2. Tarkibiy qismlar miqdorlari:</span>
            <div className="bt-comp-presets">
              <button
                type="button"
                className="btn btn-xs btn-outline"
                onClick={handleSetAllStandard}
                title="Har bir qismni komplekt bo‘yicha standart miqdorda belgilash"
              >
                Standart ({Math.max(1, mainQty)}x)
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost text-danger"
                onClick={handleResetAllToZero}
                title="Barcha qismlarni 0 ga tushirish"
              >
                Hammasini 0 qilish
              </button>
            </div>
          </div>

          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Tarkibiy qismlar yuklanmoqda…
            </div>
          ) : componentsList.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Ushbu tovar uchun alohida tarkibiy qismlar kiritilmagan.
            </div>
          ) : (
            <div className="bt-comp-list-wrap">
              {componentsList.map(c => {
                const cId = c.id || c.component_id;
                const currentQty = Number(compQuantities[cId]) || 0;
                const cCostUsd = Number(c.cost_price_usd) || (rate > 0 && c.cost_price ? Number(c.cost_price) / rate : 0);
                const cCostUzs = Number(c.cost_price) || (rate > 0 ? Math.round(cCostUsd * rate) : 0);
                const lineUsd = cCostUsd * currentQty;
                const lineUzs = cCostUzs * currentQty;

                return (
                  <div
                    key={cId}
                    className={`bt-comp-item-row ${currentQty > 0 ? 'active' : ''}`}
                  >
                    <div className="bt-comp-item-info">
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <b style={{ fontSize: 13.5 }}>{c.name}</b>
                          {c.color_name && (
                            <span style={{ fontSize: 10, padding: '1px 5px', background: 'var(--surface-2)', borderRadius: 4 }}>
                              {c.color_name}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {c.stock_quantity !== undefined && (
                            <span>Omborda: <b>{c.stock_quantity} ta</b></span>
                          )}
                          <span>Tannarx: <b>${cCostUsd.toFixed(2)}</b> ({new Intl.NumberFormat('uz-UZ').format(cCostUzs)} so‘m)</span>
                        </div>
                      </div>
                    </div>

                    <div className="bt-comp-item-controls">
                      <div className="bt-comp-stepper">
                        <button
                          type="button"
                          className="bt-comp-stepper-btn"
                          onClick={() => handleCompQtyChange(cId, currentQty - 1)}
                          disabled={currentQty <= 0}
                        >
                          <Minus size={13} />
                        </button>
                        <input
                          type="number"
                          min="0"
                          className="bt-comp-stepper-input"
                          value={currentQty}
                          onChange={e => handleCompQtyChange(cId, e.target.value)}
                        />
                        <button
                          type="button"
                          className="bt-comp-stepper-btn"
                          onClick={() => handleCompQtyChange(cId, currentQty + 1)}
                        >
                          <Plus size={13} />
                        </button>
                      </div>

                      {/* Quick chips */}
                      <div style={{ display: 'flex', gap: 3 }}>
                        <button
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={() => handleCompQtyChange(cId, 0)}
                          style={{ padding: '2px 5px', fontSize: 10 }}
                        >
                          0
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={() => handleCompQtyChange(cId, currentQty + 5)}
                          style={{ padding: '2px 5px', fontSize: 10 }}
                        >
                          +5
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-outline"
                          onClick={() => handleCompQtyChange(cId, currentQty + 10)}
                          style={{ padding: '2px 5px', fontSize: 10 }}
                        >
                          +10
                        </button>
                      </div>

                      <div className="bt-comp-item-subtotal">
                        <b style={{ color: currentQty > 0 ? 'var(--orange)' : 'var(--muted)' }}>
                          ${lineUsd.toFixed(2)}
                        </b>
                        <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10.5 }}>
                          {new Intl.NumberFormat('uz-UZ').format(lineUzs)} so‘m
                        </small>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 3: Markup & Summary Footer */}
        <div className="bt-comp-total-footer">
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Tanlandi: <b>{mainQty} dona</b> asosiy · <b>{totalCompsCount} dona</b> qismlar
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
              Jami tannarx: ${totalLineCostUsd.toFixed(2)} ({new Intl.NumberFormat('uz-UZ').format(totalLineCostUzs)} so‘m)
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Ustama ($):</span>
              <input
                type="text"
                inputMode="decimal"
                className="input"
                style={{ width: 60, height: 32, padding: '2px 6px', textAlign: 'center', fontSize: 13 }}
                value={customMarkupUsd}
                onChange={e => setCustomMarkupUsd(e.target.value)}
                placeholder="0"
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirm}
            >
              <CheckCircle2 size={16} />
              <span>Transferga qo‘shish</span>
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
