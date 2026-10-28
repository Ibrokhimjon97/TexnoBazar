import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Calendar, ChevronLeft, ChevronRight, Clock, Clock3, FileText, Layers, Printer, ReceiptText, RotateCcw, Search, Trash2, WalletCards, X, Truck, Tag, DollarSign, Check, CreditCard, Banknote, Edit3, Bluetooth, QrCode, Volume2, VolumeX, MinusCircle, TrendingUp, Eye, EyeOff } from 'lucide-react';
import { DualPrice, Empty, Modal, Status, useExchangeRate, ThermalReceiptPreview, printThermalReceipt, ProductDeliveryStickersModal, DetongerPrintModal, renderThermalReceiptCanvas } from '@texnobazar/ui';
import {
  confirmPosSale,
  createPosDelivery,
  deletePosPendingSale,
  deletePosPendingSaleLine,
  getPosPendingSale,
  getSaleReceipt,
  getPendingSaleReceipt,
  listBranchCourierCash,
  acceptCourierCash,
  listPosPendingSales,
  rejectPosPendingSale,
  releaseExpiredPosSales,
  releaseStalePosReservations,
  completePosCashRefund,
  listSaleReturns,
  cancelSaleReturn,
  updateConfirmedSalePayments,
  subscribePosPendingSales,
  getBrowserClient
} from '@texnobazar/data';
import { playCashierAlert, isAudioEnabled, setAudioEnabled } from './audioAlert.js';
import { CashExpenseModal } from './CashExpenseModal.jsx';
import { CashProfitDetailsModal } from './CashProfitDetailsModal.jsx';

function getTashkentDateString(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return `${y}-${m}-${day}`;
}

function computePresetDates(preset) {
  const now = new Date();
  const todayStr = getTashkentDateString(now);

  if (preset === 'today') {
    return { startDate: todayStr, endDate: todayStr };
  }
  if (preset === 'yesterday') {
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    const yestStr = getTashkentDateString(yest);
    return { startDate: yestStr, endDate: yestStr };
  }
  if (preset === 'week') {
    const d = new Date(now);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    return { startDate: getTashkentDateString(monday), endDate: todayStr };
  }
  if (preset === 'month') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    return { startDate: getTashkentDateString(firstDay), endDate: todayStr };
  }
  if (preset === 'all') {
    return { startDate: null, endDate: null };
  }
  return { startDate: todayStr, endDate: todayStr };
}

const rejectCourierDelivery = async (handoverId, reason = null) => {
  const { data, error } = await getBrowserClient().rpc('reject_courier_delivery', {
    p_handover_id: handoverId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data;
};

const msg = e => String(e?.message || 'Amalni bajarib bo\'lmadi.');
const date = x => x ? new Date(x).toLocaleString('uz-UZ') : '—';
const address = value => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.line1, value.line2, value.district, value.city, value.region, value.postal_code].filter(Boolean).join(', ');
};
const labels = { pending: 'Kutilmoqda', confirmed: 'Tasdiqlangan', rejected: 'Rad etilgan', cod: 'Kuryerga to‘laydi', nasiya: 'Nasiyalar' };
const colors = { pending: 'orange', confirmed: 'green', rejected: 'red', cod: 'amber', nasiya: 'purple' };

export default function CashWorkspace({ branchId, toast, onSummary, focusPendingSaleId, clearFocus }) {
  const [tab, setTab] = useState('pos');
  useEffect(() => { if (focusPendingSaleId) setTab('pos'); }, [focusPendingSaleId]);
  if (!branchId) return <div className="cash-real-state"><AlertTriangle /><p>Filial tanlanmagan</p></div>;
  return (
    <section className="cash-real-workspace">
      <div className="m-page-head">
        <h2>Kassa</h2>
        <p>Sotuvchi rezervlari, qaytarishlar va kuryer pullari</p>
      </div>
      <div className="cash-real-tabs" style={{ marginBottom: 14 }}>
        <button className={tab === 'pos' ? 'active' : ''} onClick={() => setTab('pos')}>Sotuvchi kassa</button>
        <button className={tab === 'returns' ? 'active' : ''} onClick={() => setTab('returns')}>Qaytarishlar (Naqd pul)</button>
        <button className={tab === 'courier' ? 'active' : ''} onClick={() => setTab('courier')}>Kuryer pullari</button>
      </div>
      {tab === 'pos' ? (
        <PosCashTab branchId={branchId} toast={toast} onSummary={onSummary} focusPendingSaleId={focusPendingSaleId} clearFocus={clearFocus} />
      ) : tab === 'returns' ? (
        <ReturnsCashTab branchId={branchId} toast={toast} />
      ) : (
        <CourierCashTab branchId={branchId} toast={toast} />
      )}
    </section>
  );
}

function PosCashTab({ branchId, toast, onSummary, focusPendingSaleId, clearFocus }) {
  const rate = useExchangeRate();
  const [status, setStatus] = useState('pending');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [result, setResult] = useState({ items: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [stickersPayload, setStickersPayload] = useState(null);

  const PAGE_SIZE = 30;
  const [page, setPage] = useState(1);
  const [deletingSale, setDeletingSale] = useState(null);
  const [deletingLine, setDeletingLine] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [editingPaymentSale, setEditingPaymentSale] = useState(null);
  const [soundOn, setSoundOn] = useState(() => isAudioEnabled());
  const knownPendingIds = useRef(new Set());
  const isInitialLoad = useRef(true);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [profitDetailsOpen, setProfitDetailsOpen] = useState(false);

  // Calendar & Date Range Filter States
  const [datePreset, setDatePreset] = useState('today');
  const [dateRange, setDateRange] = useState(() => computePresetDates('today'));
  const [customStart, setCustomStart] = useState(() => getTashkentDateString());
  const [customEnd, setCustomEnd] = useState(() => getTashkentDateString());
  const [showCustomRange, setShowCustomRange] = useState(false);
  const [paymentFilter, setPaymentFilter] = useState('all'); // 'all' | 'cod' | 'cash' | 'card'
  const [sortBy, setSortBy] = useState('created_desc'); // 'created_desc' | 'cash_desc' | 'cash_asc' | 'total_desc' | 'total_asc'

  const handlePresetSelect = preset => {
    setDatePreset(preset);
    if (preset === 'custom') {
      setShowCustomRange(true);
      setDateRange({ startDate: customStart, endDate: customEnd });
    } else {
      setShowCustomRange(false);
      setDateRange(computePresetDates(preset));
    }
    setPage(1);
  };

  const handleCustomApply = () => {
    setDatePreset('custom');
    setDateRange({ startDate: customStart, endDate: customEnd });
    setPage(1);
  };

  const getPeriodTitle = () => {
    if (datePreset === 'today') return 'Bugun';
    if (datePreset === 'yesterday') return 'Kecha';
    if (datePreset === 'week') return 'Bu hafta';
    if (datePreset === 'month') return 'Bu oy';
    if (datePreset === 'all') return 'Barcha davr';
    if (dateRange.startDate && dateRange.endDate) {
      if (dateRange.startDate === dateRange.endDate) return dateRange.startDate;
      return `${dateRange.startDate} — ${dateRange.endDate}`;
    }
    return 'Tanlangan davr';
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setAudioEnabled(next);
    if (next) {
      playCashierAlert();
      toast?.('Kassa signali yoqildi (sinov ovozi chalindi)');
    } else {
      toast?.('Kassa signali o‘chirildi');
    }
  };

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = async (p = page, silent = false) => {
    if (!branchId) {
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = await listPosPendingSales({
        branchId,
        status: status === 'all' ? null : status,
        query: debounced,
        page: p,
        pageSize: PAGE_SIZE,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        paymentFilter: status === 'confirmed' && paymentFilter !== 'all' ? paymentFilter : null,
        sortBy: status === 'confirmed' ? sortBy : null
      });
      const items = data?.items || [];
      setResult(data || { items: [], summary: {} });
      onSummary?.(data?.summary);

      // Yangi tushgan 'pending' so'rovlarni aniqlash va signal chalish:
      const currentPending = items.filter(it => it.status === 'pending');
      if (!isInitialLoad.current) {
        const hasNewPending = currentPending.some(it => !knownPendingIds.current.has(it.id));
        if (hasNewPending) {
          playCashierAlert();
          toast?.('Kassaga yangi savdo so‘rovi keldi!');
        }
      }
      knownPendingIds.current = new Set(currentPending.map(it => it.id));
      isInitialLoad.current = false;
    } catch (e) {
      if (!silent) setError(msg(e));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
    load(1);
  }, [branchId, status, debounced, dateRange, paymentFilter, sortBy]);

  // 1. Supabase Realtime orqali pos_pending_sales o'zgarishlarini tinglash
  useEffect(() => {
    if (!branchId) return;
    const unsubscribe = subscribePosPendingSales(
      () => {
        load(page, true);
      },
      err => console.warn('Realtime pos_pending_sales ogohlantirish:', err),
      branchId
    );
    return () => unsubscribe?.();
  }, [branchId, page, status, debounced, dateRange, paymentFilter, sortBy]);

  // 2. Kassa sahifasida turganda xavfsiz avtomatik silent polling (har 60 soniyada faqat tab ko'rinib turganda)
  useEffect(() => {
    if (!branchId) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        load(page, true);
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [branchId, page, status, debounced, dateRange, paymentFilter, sortBy]);

  // 3. Brauzer tabiga qaytib kirilganda yoki tab ochilganda darhol tekshirish
  useEffect(() => {
    const onFocus = () => {
      if (branchId && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        load(page, true);
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [branchId, page, status, debounced, dateRange, paymentFilter, sortBy]);

  const handleDelete = async (restoreStock = true) => {
    if (!deletingSale) return;
    setDeleteBusy(true);
    try {
      const res = await deletePosPendingSale(deletingSale.id, restoreStock);
      toast?.(res?.message || (restoreStock ? 'Kassa kirimi o‘chirildi va tovar omborga qaytarildi.' : 'Kassa kirimi butunlay o‘chirildi.'));
      setDeletingSale(null);
      if (detail?.id === deletingSale.id) setDetail(null);
      await load(page);
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleDeleteLine = async (restoreStock = true) => {
    if (!deletingLine?.sale?.id || !deletingLine?.line?.id) return;
    setDeleteBusy(true);
    try {
      const res = await deletePosPendingSaleLine(deletingLine.sale.id, deletingLine.line.id, restoreStock);
      toast?.(res?.message || (restoreStock ? 'Tovar chekdan o‘chirildi va omborga qaytarildi.' : 'Tovar chekdan o‘chirildi.'));
      const saleId = deletingLine.sale.id;
      setDeletingLine(null);
      if (res?.deleted_entire_sale) {
        if (detail?.id === saleId) setDetail(null);
      } else {
        if (detail?.id === saleId) {
          try {
            const updated = await getPosPendingSale(saleId);
            setDetail(updated);
          } catch (err) {
            setDetail(null);
          }
        }
      }
      await load(page);
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  const [releasingStale, setReleasingStale] = useState(false);
  const handleReleaseStale = async () => {
    if (!window.confirm("24 soatdan ortiq vaqt davomida to‘lanmay qolib ketgan kassa so‘rovlari bekor qilinib, band qilingan tovarlar yana sotuvga qaytarilsinmi?")) {
      return;
    }
    setReleasingStale(true);
    try {
      const res = await releaseStalePosReservations({ branchId, hours: 24 });
      toast?.(res?.message || 'Eski kassa so‘rovlari tozalandi');
      await load(page);
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setReleasingStale(false);
    }
  };

  const open = async id => {
    setError('');
    try {
      setDetail(await getPosPendingSale(id));
    } catch (e) {
      setError(msg(e));
    }
  };

  useEffect(() => {
    if (!focusPendingSaleId) return;
    open(focusPendingSaleId).then(() => clearFocus?.()).catch(() => clearFocus?.());
    // Only re-run when the focus target itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPendingSaleId]);

  const confirmed = async (id, paymentsPayload, deliveryInfo, customerPayload = null, notes = null) => {
    const saleId = await confirmPosSale(id, paymentsPayload || null, customerPayload || null, notes || null);
    if (!saleId) {
      setDetail(await getPosPendingSale(id));
      toast?.('Savdoni tasdiqlab bo‘lmadi');
      await load();
      return;
    }

    if (deliveryInfo && deliveryInfo.needed) {
      try {
        await createPosDelivery({
          saleId,
          customerName: deliveryInfo.customerName,
          customerPhone: deliveryInfo.customerPhone,
          deliveryAddress: deliveryInfo.deliveryAddress,
          paymentType: deliveryInfo.paymentType,
          codAmount: deliveryInfo.isCod ? Number(deliveryInfo.codAmount ?? deliveryInfo.totalAmount) : 0,
          notes: deliveryInfo.notes,
          fulfillmentSource: deliveryInfo.fulfillmentSource || 'warehouse'
        });
      } catch (err) {
        console.error('Failed to create POS delivery:', err);
      }
    }

    const check = await getSaleReceipt(saleId);
    setDetail(null);

    if (deliveryInfo && deliveryInfo.needed) {
      const codAmt = deliveryInfo.isCod ? Number(deliveryInfo.codAmount || deliveryInfo.totalAmount || 0) : Number(check.cod_amount || 0);
      setStickersPayload({
        items: deliveryInfo.items && deliveryInfo.items.length ? deliveryInfo.items : (check.lines || []),
        customer: {
          full_name: deliveryInfo.customerName,
          phone: deliveryInfo.customerPhone,
          address: deliveryInfo.deliveryAddress,
          cod_amount: codAmt
        },
        sale: {
          sale_no: check.sale_no,
          total: check.total,
          cod_amount: codAmt,
          sold_at: check.sold_at
        }
      });
    } else {
      setReceipt(check);
    }

    const hasNasiya = paymentsPayload?.some(p => (p.method_code || p.code) === 'nasiya' && Number(p.amount) > 0);
    const nasiyaAmount = paymentsPayload?.find(p => (p.method_code || p.code) === 'nasiya')?.amount;

    toast?.(deliveryInfo?.isCod
      ? `Kuryerdan to‘lov (${Number(deliveryInfo.codAmount || deliveryInfo.totalAmount).toLocaleString('uz-UZ')} so‘m) zayavkasi shakllantirildi va Dostavka sahifasiga yuborildi`
      : hasNasiya
      ? `Nasiya savdo (${Number(nasiyaAmount).toLocaleString('uz-UZ')} so‘m qarz) tasdiqlandi va Nasiyalar ro‘yxatiga qo‘shildi`
      : 'Pul qabul qilindi, mahsulotlar SOLD holatiga o‘tdi');
    await load();
  };

  const rejected = async (id, reason) => {
    await rejectPosPendingSale(id, reason);
    setDetail(null);
    toast?.('So\'rov rad etildi va rezerv bo\'shatildi');
    await load();
  };

  const openReceipt = async id => {
    setError('');
    try {
      const check = await getPendingSaleReceipt(id);
      setDetail(null);
      setReceipt(check);
    } catch (e) {
      setError(msg(e));
      toast?.(msg(e));
    }
  };

  const s = result.summary || {};
  const cashGross = Number(s.confirmed_today_cash || 0);
  const cardGross = Number(s.confirmed_today_card || 0);
  const totalExpenseAmt = Number(s.confirmed_today_expense || 0);
  const expenseCount = Number(s.confirmed_today_expense_count || 0);
  const cashExpenseAmt = Number(s.confirmed_today_expense_cash ?? totalExpenseAmt);
  const cardExpenseAmt = Number(s.confirmed_today_expense_card || 0);
  const cashNet = cashGross - cashExpenseAmt;
  const cardNet = cardGross - cardExpenseAmt;
  const totalCost = Number(s.confirmed_today_cost || 0);
  const confirmedAmount = Number(s.confirmed_today_amount || 0);
  // Sof foyda: Foydalanuvchi talabiga ko'ra savdo foydasi (Savdo tushumi - Tannarx), chiqimlar (harajatlar) ayirilmagan holda
  const todayProfit = Number(s.confirmed_today_profit ?? s.confirmed_today_gross_profit ?? (confirmedAmount - totalCost));
  const profitMargin = confirmedAmount > 0 ? Math.round((todayProfit / confirmedAmount) * 100) : 0;

  return (
    <section className="cash-real-workspace">
      <div className="m-page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>Kassa kirimlari</h2>
          <p>Sotuvchi rezervlarini tasdiqlash va yakunlash</p>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${soundOn ? 'btn-success' : 'btn-outline'}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              borderRadius: 20,
              padding: '6px 14px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
            onClick={toggleSound}
            title="Yangi savdo so‘rovi tushganda brauzer signali"
          >
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
            {soundOn ? 'Signal: Yoqilgan (Sinash)' : 'Signal: O‘chiq'}
          </button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', boxShadow: '0 0 6px rgba(16,185,129,0.7)' }} />
            Realtime yangilanish faol (Refresh shart emas)
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
            onClick={() => load(page, false)}
            disabled={loading}
          >
            <RotateCcw size={14} className={loading ? 'spin' : ''} /> Yangilash
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, borderColor: '#f59e0b', color: '#b45309' }}
            onClick={handleReleaseStale}
            disabled={releasingStale || loading}
            title="24 soatdan ortiq vaqt davomida to‘lanmay qolib ketgan kassa so‘rovlarini bekor qilish va tovarlarni qoldiqqa qaytarish"
          >
            <Clock3 size={14} /> Eski bandliklarni bo‘shatish
          </button>
        </div>
      </div>

      {/* Calendar & Period Filter Bar */}
      <div className="cash-date-filter-bar card" style={{ padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, background: '#fff', borderRadius: 12, border: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)', display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 4 }}>
            <Calendar size={16} color="var(--primary)" /> Davr:
          </span>
          {[
            ['today', 'Bugun'],
            ['yesterday', 'Kecha'],
            ['week', 'Bu hafta'],
            ['month', 'Bu oy'],
            ['all', 'Barcha davr'],
            ['custom', 'Kalendar / Oraliq']
          ].map(([presetKey, label]) => (
            <button
              type="button"
              key={presetKey}
              className={`btn btn-sm ${datePreset === presetKey ? 'btn-primary' : 'btn-outline'}`}
              style={{
                borderRadius: 20,
                fontSize: 12.5,
                padding: '4px 12px',
                fontWeight: datePreset === presetKey ? 700 : 500,
                cursor: 'pointer'
              }}
              onClick={() => handlePresetSelect(presetKey)}
            >
              {label}
            </button>
          ))}
        </div>

        {showCustomRange && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#f8fafc', padding: '4px 10px', borderRadius: 10, border: '1px solid var(--line)' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              Dan:
              <input
                type="date"
                className="input input-sm"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                style={{ fontSize: 12.5, padding: '3px 8px', borderRadius: 6 }}
              />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              Gacha:
              <input
                type="date"
                className="input input-sm"
                value={customEnd}
                min={customStart}
                onChange={e => setCustomEnd(e.target.value)}
                style={{ fontSize: 12.5, padding: '3px 8px', borderRadius: 6 }}
              />
            </label>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6 }}
              onClick={handleCustomApply}
            >
              Filtrlash
            </button>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExpenseModalOpen(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 700,
              background: 'linear-gradient(135deg, #e11d48, #be123c)',
              color: '#ffffff',
              borderRadius: 8,
              padding: '6px 14px',
              border: 'none',
              boxShadow: '0 2px 8px rgba(225, 29, 72, 0.25)',
              cursor: 'pointer'
            }}
            title="Kassadagi naqd puldan xarajat chiqarish"
          >
            <MinusCircle size={15} />
            Harajat qo‘shish
          </button>
        </div>
      </div>

      <div className="cash-real-summary">
        <article className="is-pending">
          <div className="cash-real-summary-icon">
            <WalletCards size={19} />
          </div>
          <span>
            <small>Kutilmoqda</small>
            <b>{s.pending_count || 0} ta so‘rov</b>
            <strong><DualPrice value={Number(s.pending_amount || 0)} rate={rate} /></strong>
          </span>
        </article>

        <article className="is-confirmed">
          <div className="cash-real-summary-icon">
            <ReceiptText size={19} />
          </div>
          <span>
            <small>Jami tasdiqlandi ({getPeriodTitle()})</small>
            <b>{s.confirmed_today_count || 0} ta savdo</b>
            <strong><DualPrice value={Number(s.confirmed_today_amount || 0)} rate={rate} /></strong>
          </span>
        </article>

        <article
          className="is-profit"
          role="button"
          tabIndex={0}
          onClick={() => setProfitDetailsOpen(true)}
          style={{
            background: todayProfit >= 0 ? '#f0fdf4' : '#fef2f2',
            borderColor: todayProfit >= 0 ? '#bbf7d0' : '#fecaca',
            cursor: 'pointer',
            transition: 'transform 0.15s ease, box-shadow 0.15s ease',
            position: 'relative'
          }}
          title="Batafsil tovarlar ro‘yxati va sof foyda jadvalini ko‘rish uchun bosing"
        >
          <div className="cash-real-summary-icon" style={{ background: todayProfit >= 0 ? '#dcfce7' : '#fee2e2', color: todayProfit >= 0 ? '#15803d' : '#b91c1c' }}>
            <TrendingUp size={19} />
          </div>
          <span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
              <small style={{ color: todayProfit >= 0 ? '#166534' : '#991b1b', fontWeight: 700 }}>
                {datePreset === 'today' ? 'Bugungi sof foyda' : `Sof foyda (${getPeriodTitle()})`}
              </small>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: todayProfit >= 0 ? '#15803d' : '#b91c1c', background: todayProfit >= 0 ? '#dcfce7' : '#fee2e2', padding: '1px 5px', borderRadius: 4 }}>
                Jadval ↗
              </span>
            </div>
            <b style={{ color: todayProfit >= 0 ? '#15803d' : '#b91c1c' }}>
              {profitMargin}% marja
            </b>
            <strong style={{ color: todayProfit >= 0 ? '#15803d' : '#b91c1c' }}>
              <DualPrice value={todayProfit} rate={rate} />
            </strong>
            <div style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: `1px dashed ${todayProfit >= 0 ? '#bbf7d0' : '#fecaca'}`,
              fontSize: 10,
              color: '#475569',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 4
            }}>
              <span>Tannarx: {new Intl.NumberFormat('uz-UZ').format(totalCost)}</span>
              <span>Savdo: {new Intl.NumberFormat('uz-UZ').format(confirmedAmount)}</span>
            </div>
          </span>
        </article>

        <article className="is-cash">
          <div className="cash-real-summary-icon">
            <Banknote size={19} />
          </div>
          <span>
            <small>Shundan naqd pul</small>
            <b>
              {Number(s.confirmed_today_amount || 0) > 0
                ? `${Math.round((cashGross / Number(s.confirmed_today_amount)) * 100)}% ulush`
                : '0% ulush'}
            </b>
            <strong><DualPrice value={cashGross} rate={rate} /></strong>
            <div style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: '1px dashed #cbd5e1',
              fontSize: 10.5,
              color: cashNet >= 0 ? '#15803d' : '#b91c1c',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 4
            }}>
              <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>Sof naqd:</span>
              <span style={{ whiteSpace: 'nowrap', fontWeight: 800 }}>{new Intl.NumberFormat('uz-UZ').format(cashNet)} so‘m</span>
            </div>
          </span>
        </article>

        <article
          className="is-expense"
          style={{
            cursor: 'pointer',
            background: '#fff1f2',
            borderColor: '#fecdd3'
          }}
          onClick={() => setExpenseModalOpen(true)}
          title="Xarajatlar ro‘yxati va yangi harajat qo‘shish"
        >
          <div className="cash-real-summary-icon" style={{ background: '#ffe4e6', color: '#e11d48' }}>
            <MinusCircle size={19} />
          </div>
          <span>
            <small style={{ color: '#be123c', fontWeight: 700 }}>
              {datePreset === 'today' ? 'Bugungi harajat' : `Harajat (${getPeriodTitle()})`}
            </small>
            <b style={{ color: '#e11d48' }}>
              {expenseCount} ta chiqim
            </b>
            <strong style={{ color: '#e11d48' }}>
              <DualPrice value={totalExpenseAmt} rate={rate} />
            </strong>
            <div style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: '1px dashed #fecdd3',
              fontSize: 10.5,
              color: '#be123c',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 4
            }}>
              <span>{cardExpenseAmt > 0 ? `Naqd: ${new Intl.NumberFormat('uz-UZ').format(cashExpenseAmt)}` : 'Chiqimlar'}</span>
              <span>{cardExpenseAmt > 0 ? `Plastik: ${new Intl.NumberFormat('uz-UZ').format(cardExpenseAmt)}` : 'Ko‘rish →'}</span>
            </div>
          </span>
        </article>

        <article className="is-card">
          <div className="cash-real-summary-icon">
            <CreditCard size={19} />
          </div>
          <span>
            <small>Shundan plastik karta</small>
            <b>
              {Number(s.confirmed_today_amount || 0) > 0
                ? `${Math.round((Number(s.confirmed_today_card || 0) / Number(s.confirmed_today_amount)) * 100)}% ulush`
                : '0% ulush'}
            </b>
            <strong><DualPrice value={Number(s.confirmed_today_card || 0)} rate={rate} /></strong>
            <div style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: '1px dashed #cbd5e1',
              fontSize: 10.5,
              color: cardNet >= 0 ? '#0284c7' : '#b91c1c',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 4
            }}>
              <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>Sof plastik:</span>
              <span style={{ whiteSpace: 'nowrap', fontWeight: 800 }}>{new Intl.NumberFormat('uz-UZ').format(cardNet)} so‘m</span>
            </div>
          </span>
        </article>

        <article
          className={`is-cod ${status === 'cod' ? 'active-filter' : ''}`}
          style={{ cursor: 'pointer', outline: status === 'cod' ? '2px solid #f59e0b' : 'none' }}
          onClick={() => {
            setStatus('cod');
            setPaymentFilter('all');
            setSortBy('created_desc');
          }}
          title="Kuryerga to‘laydi bo‘limini ochish"
        >
          <div className="cash-real-summary-icon">
            <Truck size={19} />
          </div>
          <span>
            <small>Kuryer to‘laydi ({getPeriodTitle()})</small>
            <b>
              {Number(s.cod_count || 0) > 0
                ? `${s.cod_count} ta savdo`
                : (Number(s.confirmed_today_amount || 0) > 0
                    ? `${Math.round((Number(s.confirmed_today_cod || 0) / Number(s.confirmed_today_amount)) * 100)}% ulush`
                    : '0 ta savdo')}
            </b>
            <strong><DualPrice value={Number(s.cod_total_amount ?? s.confirmed_today_cod ?? 0)} rate={rate} /></strong>
          </span>
        </article>

        <article
          className={`is-nasiya ${status === 'nasiya' ? 'active-filter' : ''}`}
          style={{
            cursor: 'pointer',
            outline: status === 'nasiya' ? '2px solid #9333ea' : 'none',
            background: '#faf5ff',
            borderColor: '#e9d5ff'
          }}
          onClick={() => {
            setStatus('nasiya');
            setPaymentFilter('all');
            setSortBy('created_desc');
          }}
          title="Nasiyalar bo‘limini ochish"
        >
          <div className="cash-real-summary-icon" style={{ background: '#f3e8ff', color: '#9333ea' }}>
            <Clock size={19} />
          </div>
          <span>
            <small style={{ color: '#7e22ce' }}>Nasiya (Qarzlar — {getPeriodTitle()})</small>
            <b style={{ color: '#9333ea' }}>
              {Number(s.nasiya_count || 0) > 0
                ? `${s.nasiya_count} ta savdo`
                : (Number(s.confirmed_today_amount || 0) > 0
                    ? `${Math.round((Number(s.confirmed_today_nasiya || 0) / Number(s.confirmed_today_amount)) * 100)}% ulush`
                    : '0 ta savdo')}
            </b>
            <strong style={{ color: '#6b21a8' }}><DualPrice value={Number(s.nasiya_total_amount ?? s.confirmed_today_nasiya ?? 0)} rate={rate} /></strong>
          </span>
        </article>

        {Number(s.confirmed_today_other || 0) > 0 && (
          <article className="is-other">
            <div className="cash-real-summary-icon">
              <Layers size={19} />
            </div>
            <span>
              <small>Shundan boshqa to‘lov</small>
              <b>Click / boshqa</b>
              <strong><DualPrice value={Number(s.confirmed_today_other || 0)} rate={rate} /></strong>
            </span>
          </article>
        )}
      </div>
      <div className="cash-real-toolbar">
        <div className="cash-real-tabs">
          {[
            ['pending', 'Kutilmoqda', s.pending_count],
            ['confirmed', 'Tasdiqlangan', s.confirmed_today_count],
            ['cod', 'Kuryerga to‘laydi', s.cod_count],
            ['nasiya', 'Nasiyalar', s.nasiya_count],
            ['rejected', 'Rad etilgan', s.rejected_count],
            ['all', 'Barchasi', s.total_count]
          ].map(([key, text, badgeCount]) => (
            <button
              type="button"
              key={key}
              className={status === key ? 'active' : ''}
              onClick={() => {
                setStatus(key);
                setPaymentFilter('all');
                setSortBy('created_desc');
              }}
            >
              {text}
              {Number(badgeCount || 0) > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    borderRadius: 10,
                    fontSize: 10.5,
                    fontWeight: 800,
                    background: key === 'cod' ? '#fef3c7' : key === 'nasiya' ? '#f3e8ff' : '#e0f2fe',
                    color: key === 'cod' ? '#b45309' : key === 'nasiya' ? '#7e22ce' : '#0369a1',
                    border: `1px solid ${key === 'cod' ? '#fde68a' : key === 'nasiya' ? '#e9d5ff' : '#bae6fd'}`
                  }}
                >
                  {badgeCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <label>
          <Search />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Raqam, sotuvchi yoki mahsulot nomi"
          />
        </label>
      </div>

      {status === 'confirmed' && (
        <div
          className="confirmed-filter-bar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
            padding: '8px 14px',
            marginBottom: 12,
            background: '#ffffff',
            borderRadius: 10,
            border: '1px solid var(--line, #e2e8f0)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
          }}
        >
          {/* Payment method filter buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--navy, #0f172a)', marginRight: 2 }}>
              To‘lov filtri:
            </span>
            {[
              ['all', 'Barchasi'],
              ['cod', '🚚 Kuryerdan to‘lovlar'],
              ['cash', '💵 Naqd to‘lovlar'],
              ['card', '💳 Plastik to‘lovlar']
            ].map(([fKey, fLabel]) => {
              const active = paymentFilter === fKey;
              return (
                <button
                  key={fKey}
                  type="button"
                  style={{
                    fontSize: 12,
                    padding: '4px 11px',
                    borderRadius: 20,
                    border: `1.5px solid ${active ? '#0284c7' : 'var(--line, #cbd5e1)'}`,
                    background: active ? '#f0f9ff' : '#ffffff',
                    color: active ? '#0369a1' : 'var(--navy, #0f172a)',
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onClick={() => {
                    setPaymentFilter(fKey);
                    setPage(1);
                  }}
                >
                  {fLabel}
                </button>
              );
            })}
          </div>

          {/* Sort options */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--navy, #0f172a)' }}>
              Saralash:
            </span>
            <select
              value={sortBy}
              onChange={e => {
                setSortBy(e.target.value);
                setPage(1);
              }}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: '1.5px solid var(--line, #cbd5e1)',
                background: '#ffffff',
                color: 'var(--navy, #0f172a)',
                fontWeight: 600,
                cursor: 'pointer',
                outline: 'none'
              }}
            >
              <option value="created_desc">📅 Eng yangilari (Vaqt bo‘yicha)</option>
              <option value="cash_desc">💵 Naqd pul: Ko‘pdan kamga ↓</option>
              <option value="cash_asc">💵 Naqd pul: Kamdan ko‘pga ↑</option>
              <option value="total_desc">💰 Jami summa: Ko‘pdan kamga ↓</option>
              <option value="total_asc">💰 Jami summa: Kamdan ko‘pga ↑</option>
            </select>
          </div>
        </div>
      )}
      {loading ? (
        <State text="Kassa so'rovlari yuklanmoqda…" />
      ) : error ? (
        <State error text={error} retry={load} />
      ) : result.items?.length ? (
        <>
          <div className="cash-real-list">
            {result.items.map(row => (
              <button
                type="button"
                className="cash-real-card"
                key={row.id}
                onClick={() => open(row.id)}
              >
                <div className="between" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
                    <b style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, wordBreak: 'break-all' }}>{row.pending_no}</b>
                    {(row.is_edited || (row.updated_at && row.updated_at !== row.created_at)) && (
                      <span style={{ background: '#fef3c7', color: '#b45309', border: '1px solid #fde68a', fontSize: '9.5px', padding: '1px 5px', borderRadius: '4px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        ✏️ Tahrirlangan
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <Status type={colors[row.status]}>{labels[row.status] || row.status}</Status>
                    <ChevronRight size={16} style={{ color: 'var(--muted)' }} />
                  </div>
                </div>
                <span>Sotuvchi <strong>{row.seller_name}</strong></span>
                <span>{row.unit_count} dona · {row.location_name}</span>
                {(row.product_names || (row.lines?.length ? row.lines.map(l => l.product_name || l.name).filter(Boolean).join(', ') : '')) && (
                  <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--navy)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden' }}>
                    <span style={{ color: '#f97316' }}>📦</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.product_names || row.lines?.map(l => l.product_name || l.name).filter(Boolean).join(', ')}
                    </span>
                  </div>
                )}
                {row.customer && (row.customer.full_name || row.customer.phone) && (
                  <div style={{ fontSize: 11.5, color: '#334155', marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontWeight: 700 }}>👤 Mijoz:</span>
                    <span>{row.customer.full_name || 'Ismsiz'}</span>
                    {row.customer.phone && <span style={{ color: '#0284c7', fontWeight: 600 }}>({row.customer.phone})</span>}
                  </div>
                )}
                {row.notes && (
                  <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', marginTop: 2 }}>
                    📝 {row.notes}
                  </div>
                )}
                <div className="cash-real-card-total">
                  <b><DualPrice value={Number(row.total || 0)} rate={rate} /></b>
                  <small><Clock3 /> {date(row.created_at)}</small>
                </div>
                {row.payments && row.payments.length > 0 && (
                  <div className="cash-real-card-pmts" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {row.payments.map((p, idx) => {
                      const isCash = p.code === 'cash';
                      const isCard = p.code === 'card' || p.code === 'terminal' || p.code === 'click';
                      const isCod = p.code === 'cod';
                      const isNasiya = p.code === 'nasiya';
                      return (
                        <span
                          key={idx}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: '11px',
                            fontWeight: 600,
                            padding: '2px 7px',
                            borderRadius: '6px',
                            background: isCash ? '#f0fdf4' : isCard ? '#eff6ff' : isCod ? '#fffbeb' : isNasiya ? '#faf5ff' : '#f8fafc',
                            color: isCash ? '#15803d' : isCard ? '#1d4ed8' : isCod ? '#b45309' : isNasiya ? '#7e22ce' : '#475569',
                            border: `1px solid ${isCash ? '#bbf7d0' : isCard ? '#bfdbfe' : isCod ? '#fde68a' : isNasiya ? '#e9d5ff' : '#e2e8f0'}`
                          }}
                        >
                          {isCash ? '💵 Naqd:' : isCard ? '💳 Plastik:' : isCod ? '🚚 Kuryerdan:' : isNasiya ? '⏳ Nasiya:' : `⚡ ${p.name || p.code}:`}
                          <strong style={{ fontWeight: 700 }}>{Number(p.amount || 0).toLocaleString('uz-UZ')} so‘m</strong>
                        </span>
                      );
                    })}
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px dashed var(--line)'
                  }}
                >
                  {row.status === 'confirmed' && (
                    <>
                      {(() => {
                        const hasNasiya = row.payments?.some(p => p.code === 'nasiya' && Number(p.amount) > 0);
                        const hasCod = row.payments?.some(p => p.code === 'cod' && Number(p.amount) > 0);
                        return (
                          <span
                            role="button"
                            tabIndex={0}
                            className="btn btn-sm btn-outline"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                              fontSize: 11,
                              fontWeight: 700,
                              padding: '4px 9px',
                              background: hasNasiya ? '#faf5ff' : hasCod ? '#fffbeb' : '#eff6ff',
                              color: hasNasiya ? '#7e22ce' : hasCod ? '#b45309' : '#1d4ed8',
                              borderColor: hasNasiya ? '#e9d5ff' : hasCod ? '#fde68a' : '#bfdbfe'
                            }}
                            onClick={e => {
                              e.stopPropagation();
                              setEditingPaymentSale(row);
                            }}
                            title={hasNasiya ? 'Nasiya qarzini to‘lash yoki tahrirlash' : hasCod ? 'Kuryer to‘lovini qabul qilish yoki tahrirlash' : 'To‘lov usulini tahrirlash'}
                          >
                            <Edit3 size={12} /> {hasNasiya ? 'Nasiya to‘lash' : hasCod ? 'Kuryer to‘lash' : 'To‘lovni tahrirlash'}
                          </span>
                        );
                      })()}
                      <span
                        role="button"
                        tabIndex={0}
                        className="btn btn-sm btn-outline"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '4px 9px',
                          background: '#fff',
                          color: 'var(--navy)'
                        }}
                        onClick={e => {
                          e.stopPropagation();
                          openReceipt(row.id);
                        }}
                        title="Chekni chop etish"
                      >
                        <Printer size={12} /> Chek
                      </span>
                    </>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    className="btn btn-sm"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '4px 9px',
                      background: '#fff1f2',
                      color: '#e11d48',
                      border: '1px solid #fecdd3'
                    }}
                    onClick={e => {
                      e.stopPropagation();
                      setDeletingSale(row);
                    }}
                    title="Kassa so‘rovini o‘chirish"
                  >
                    <Trash2 size={12} /> O‘chirish
                  </span>
                </div>
              </button>
            ))}
          </div>

          {Math.ceil((result.total || 0) / PAGE_SIZE) > 1 && (
            <div
              className="inventory-search-pagination"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 16,
                padding: '12px 16px',
                background: '#fff',
                borderRadius: 12,
                border: '1px solid var(--line)'
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, result.total || 0)} / {result.total || 0} ta kassa kirimi
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={page <= 1}
                  onClick={() => {
                    const p = page - 1;
                    setPage(p);
                    load(p);
                  }}
                >
                  <ChevronLeft size={16} /> Oldingi
                </button>
                <span style={{ fontSize: 13, fontWeight: 700, padding: '0 8px' }}>
                  {page} / {Math.ceil((result.total || 0) / PAGE_SIZE)}
                </span>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={page >= Math.ceil((result.total || 0) / PAGE_SIZE)}
                  onClick={() => {
                    const p = page + 1;
                    setPage(p);
                    load(p);
                  }}
                >
                  Keyingi <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <Empty title="So'rovlar topilmadi" text="Tanlangan holatda kassa so'rovi mavjud emas." />
      )}
      <CashDetail
        sale={detail}
        close={() => setDetail(null)}
        confirm={confirmed}
        reject={rejected}
        onViewReceipt={openReceipt}
        onEditPayment={s => setEditingPaymentSale(s)}
        onOpenStickers={(s) => {
          const codAmt = Number(
            s.cod_amount ||
            (s.delivery_is_cod ? (s.delivery_cod_amount || s.total) : 0) ||
            s.delivery?.cod_amount ||
            (s.payments?.find(p => (p.method_code || p.code) === 'cod')?.amount) ||
            0
          );
          const seller = s.seller_name || s.seller?.full_name || s.created_by_profile?.full_name || s.seller_display_name || '';
          setStickersPayload({
            items: s.lines?.map(l => ({
              product_name: l.product_name,
              unit_price: l.unit_price,
              line_total: l.line_total,
              batch_code: l.batch_code || l.reference || (l.qr_code ? `QR: ${l.qr_code}` : ''),
              qr_code: l.qr_code,
              quantity: 1,
              cod_amount: codAmt,
              seller_name: seller,
              sellerName: seller
            })) || [],
            customer: {
              full_name: s.customer?.full_name || s.customer_name || '',
              phone: s.customer?.phone || s.customer_phone || '',
              address: s.customer?.address || s.delivery_address || s.address || '',
              cod_amount: codAmt,
              seller_name: seller,
              sellerName: seller
            },
            sale: {
              sale_no: s.pending_no || s.sale_no,
              total: s.total,
              cod_amount: codAmt,
              sold_at: s.updated_at || s.created_at,
              seller_name: seller,
              sellerName: seller
            },
            seller_name: seller,
            sellerName: seller
          });
        }}
        onDelete={setDeletingSale}
        onDeleteLine={(s, l) => setDeletingLine({ sale: s, line: l })}
        rate={rate}
      />
      <Receipt receipt={receipt} close={() => setReceipt(null)} rate={rate} />
      <ProductDeliveryStickersModal
        open={Boolean(stickersPayload)}
        onClose={() => setStickersPayload(null)}
        {...stickersPayload}
      />
      <EditSalePaymentModal
        open={Boolean(editingPaymentSale)}
        sale={editingPaymentSale}
        onClose={() => setEditingPaymentSale(null)}
        onSuccess={async (updatedSaleId) => {
          await load(page);
          if (detail && detail.id === updatedSaleId) {
            try {
              setDetail(await getPosPendingSale(updatedSaleId));
            } catch (err) {
              console.error(err);
            }
          }
        }}
        rate={rate}
        toast={toast}
      />


      <Modal
        open={Boolean(deletingSale)}
        onClose={() => !deleteBusy && setDeletingSale(null)}
        title="Kassa kirimini o‘chirish"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--navy)' }}>
            Haqiqatan ham <b>{deletingSale?.pending_no}</b> kassa yozuvini o‘chirmoqchimisiz?
          </p>
          <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
            <b>1-usul:</b> Tovar omborga qaytariladi — oddiy o‘chirish. Tovar yana mavjud holatga o‘tadi.
          </div>
          <div style={{ padding: '10px 14px', background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 8, fontSize: 13, color: '#be123c' }}>
            <b>2-usul:</b> Tovar omborga qaytarilmaydi — test yozuvlarni tozalash uchun. Faqat yozuv o‘chiriladi.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={deleteBusy}
              onClick={() => setDeletingSale(null)}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: '#ef4444', borderColor: '#ef4444', color: '#fff', fontWeight: 600 }}
              disabled={deleteBusy}
              onClick={() => handleDelete(false)}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Qaytarmasdan o‘chirish'}
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: '#16a34a', borderColor: '#16a34a', color: '#fff', fontWeight: 600 }}
              disabled={deleteBusy}
              onClick={() => handleDelete(true)}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Qaytarib o‘chirish'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(deletingLine)}
        onClose={() => !deleteBusy && setDeletingLine(null)}
        title="Tovarni chekdan o‘chirish"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--navy)' }}>
            Haqiqatan ham <b>{deletingLine?.sale?.pending_no}</b> chekidan «<b>{deletingLine?.line?.product_name}</b>» tovarini o‘chirmoqchimisiz?
          </p>
          <div style={{ padding: '8px 12px', background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13, color: '#334155' }}>
            <div>Narxi: <b><DualPrice value={Number(deletingLine?.line?.line_total || 0)} rate={rate} /></b></div>
            {deletingLine?.line?.qr_code && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                QR / Seriya: <b>{deletingLine.line.qr_code}</b> {deletingLine.line.sku ? `(${deletingLine.line.sku})` : ''}
              </div>
            )}
            {deletingLine?.sale?.lines?.length <= 1 && (
              <div style={{ marginTop: 6, color: '#b45309', fontWeight: 600, fontSize: 12 }}>
                ⚠️ Bu chekdagi so‘nggi tovar. Uni o‘chirsangiz, butun kassa kirimi bekor qilinadi.
              </div>
            )}
          </div>
          <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
            <b>1-usul:</b> Tovar omborga qaytariladi — mahsulot yana mavjud holatga o‘tadi va chek summasi qayta hisoblanadi.
          </div>
          <div style={{ padding: '10px 14px', background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 8, fontSize: 13, color: '#be123c' }}>
            <b>2-usul:</b> Tovar omborga qaytarilmaydi — test yoki xato yozuvlarni tozalash uchun.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={deleteBusy}
              onClick={() => setDeletingLine(null)}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: '#ef4444', borderColor: '#ef4444', color: '#fff', fontWeight: 600 }}
              disabled={deleteBusy}
              onClick={() => handleDeleteLine(false)}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Qaytarmasdan o‘chirish'}
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: '#16a34a', borderColor: '#16a34a', color: '#fff', fontWeight: 600 }}
              disabled={deleteBusy}
              onClick={() => handleDeleteLine(true)}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Qaytarib o‘chirish'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Cash Expense Modal */}
      {expenseModalOpen && (
        <CashExpenseModal
          open={expenseModalOpen}
          onClose={() => setExpenseModalOpen(false)}
          branchId={branchId}
          dateRange={dateRange}
          periodTitle={getPeriodTitle()}
          rate={rate}
          toast={toast}
          onSaved={() => load(page, true)}
        />
      )}

      {/* Cash Profit Details Modal */}
      {profitDetailsOpen && (
        <CashProfitDetailsModal
          open={profitDetailsOpen}
          onClose={() => setProfitDetailsOpen(false)}
          branchId={branchId}
          dateRange={dateRange}
          datePreset={datePreset}
          periodTitle={getPeriodTitle()}
          rate={rate}
        />
      )}
    </section>
  );
}

function State({ text, error, retry }) {
  return (
    <div className={'cash-real-state ' + (error ? 'error' : '')}>
      {error && <AlertTriangle />}
      <p>{text}</p>
      {retry && <button type="button" className="btn" onClick={retry}>Qayta urinish</button>}
    </div>
  );
}

function CashDetail({ sale, close, confirm, reject, onViewReceipt, onEditPayment, onOpenStickers, onDelete, onDeleteLine, rate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Cashier payment & delivery states
  const [paymentType, setPaymentType] = useState('cash'); // 'cash' | 'card' | 'nasiya' | 'split' | 'cod'
  const [cashAmount, setCashAmount] = useState('');
  const [cardAmount, setCardAmount] = useState('');
  const [codAmount, setCodAmount] = useState('');
  const [nasiyaAmount, setNasiyaAmount] = useState('');
  const [isDelivery, setIsDelivery] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [fulfillmentSource, setFulfillmentSource] = useState('warehouse'); // 'warehouse' | 'store'
  const [notes, setNotes] = useState('');
  const [showAllSecrets, setShowAllSecrets] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState({});

  useEffect(() => {
    setShowAllSecrets(false);
    setRevealedKeys({});
  }, [sale?.id]);

  const toggleSecret = key => {
    setRevealedKeys(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const isSecretRevealed = key => showAllSecrets || Boolean(revealedKeys[key]);

  useEffect(() => {
    setError('');
    setReason('');
    setRejecting(false);
    if (sale) {
      const pmt0 = sale.payments?.[0];
      const pCode = pmt0?.method_code || pmt0?.code;
      const initialType = pCode === 'nasiya' ? 'nasiya' : pCode === 'cod' ? 'cod' : (pCode === 'card' || pCode === 'terminal' || pCode === 'click') ? 'card' : 'cash';
      setPaymentType(initialType);
      setIsDelivery(initialType === 'cod');
      setFulfillmentSource('warehouse');
      const tot = Number(sale.total || 0);
      setCashAmount(initialType === 'cash' ? String(tot) : '0');
      setCardAmount(initialType === 'card' ? String(tot) : '0');
      setCodAmount(initialType === 'cod' ? String(tot) : '0');
      setNasiyaAmount(initialType === 'nasiya' ? String(tot) : '0');
      setNotes(sale.notes || '');
      setCustomerName(sale.customer?.full_name || '');
      setCustomerPhone(sale.customer?.phone || '');
      setCustomerAddress(sale.customer?.address || '');
    }
  }, [sale?.id]);

  const tot = Number(sale?.total || 0);
  const numCash = Math.round(Number(String(cashAmount).replace(/[^\d.]/g, '') || 0));
  const numCard = Math.round(Number(String(cardAmount).replace(/[^\d.]/g, '') || 0));
  const numCod = Math.round(Number(String(codAmount).replace(/[^\d.]/g, '') || 0));
  const numNasiya = Math.round(Number(String(nasiyaAmount).replace(/[^\d.]/g, '') || 0));
  const splitSum = numCash + numCard + numCod + numNasiya;
  const splitDiff = tot - splitSum;

  const fillRemainingTo = target => {
    if (target === 'cash') {
      const remainder = Math.max(0, tot - numCard - numCod - numNasiya);
      setCashAmount(String(remainder));
    } else if (target === 'card') {
      const remainder = Math.max(0, tot - numCash - numCod - numNasiya);
      setCardAmount(String(remainder));
    } else if (target === 'cod') {
      const remainder = Math.max(0, tot - numCash - numCard - numNasiya);
      setCodAmount(String(remainder));
    } else if (target === 'nasiya') {
      const remainder = Math.max(0, tot - numCash - numCard - numCod);
      setNasiyaAmount(String(remainder));
    }
  };

  const handleCashChange = val => {
    setCashAmount(String(val).replace(/[^\d.]/g, ''));
  };

  const handleCardChange = val => {
    setCardAmount(String(val).replace(/[^\d.]/g, ''));
  };

  const handleCodChange = val => {
    setCodAmount(String(val).replace(/[^\d.]/g, ''));
  };

  const handleNasiyaChange = val => {
    setNasiyaAmount(String(val).replace(/[^\d.]/g, ''));
  };

  const act = async fn => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = () => {
    let paymentsPayload = [];
    if (paymentType === 'cash') {
      paymentsPayload = [{ method_code: 'cash', amount: tot }];
    } else if (paymentType === 'card') {
      paymentsPayload = [{ method_code: 'card', amount: tot }];
    } else if (paymentType === 'nasiya') {
      paymentsPayload = [{ method_code: 'nasiya', amount: tot }];
    } else if (paymentType === 'cod') {
      paymentsPayload = [{ method_code: 'cod', amount: tot }];
    } else if (paymentType === 'split') {
      const c = numCash;
      const k = numCard;
      const cod = numCod;
      const nas = numNasiya;
      if (c < 0 || k < 0 || cod < 0 || nas < 0) {
        setError('To‘lov summalari manfiy bo‘lishi mumkin emas.');
        return;
      }
      if (Math.abs(c + k + cod + nas - tot) > 0.01) {
        setError(`Aralash to‘lovlar jami (${(c + k + cod + nas).toLocaleString('uz-UZ')} so'm) xarid summasiga (${tot.toLocaleString('uz-UZ')} so'm) teng bo‘lishi kerak. Farq: ${Math.abs(tot - (c + k + cod + nas)).toLocaleString('uz-UZ')} so'm.`);
        return;
      }
      paymentsPayload = [
        { method_code: 'cash', amount: c },
        { method_code: 'card', amount: k },
        { method_code: 'cod', amount: cod },
        { method_code: 'nasiya', amount: nas }
      ].filter(p => p.amount > 0);
    }

    const codToCollect = paymentType === 'cod' ? tot : (paymentType === 'split' ? numCod : 0);
    const isCod = codToCollect > 0;
    const isNasiya = paymentType === 'nasiya' || (paymentType === 'split' && numNasiya > 0);
    const deliveryNeeded = isDelivery || paymentType === 'cod' || codToCollect > 0;

    if (isNasiya) {
      if (!customerName.trim()) {
        setError('Nasiya savdo uchun mijozning F.I.O (ismi) kiritilishi shart.');
        return;
      }
      if (!customerPhone.trim()) {
        setError('Nasiya savdo uchun mijozning telefon raqami kiritilishi shart.');
        return;
      }
      if (!notes.trim()) {
        setError('Nasiya savdo uchun izoh (qarz sababi, qaytarish muddati va shartlari) kiritilishi shart.');
        return;
      }
    }

    if (deliveryNeeded) {
      if (!customerPhone.trim()) {
        setError('Dostavka / Kuryerdan to‘lov uchun mijoz telefon raqami kiritilishi shart.');
        return;
      }
      if (!customerAddress.trim()) {
        setError('Dostavka / Kuryerdan to‘lov uchun mijoz yetkazish manzili kiritilishi shart.');
        return;
      }
    }

    const customerPayload = customerPhone.trim() ? {
      full_name: customerName.trim() || 'Mijoz',
      phone: customerPhone.trim(),
      address: customerAddress.trim() || null
    } : null;

    const deliveryData = deliveryNeeded ? {
      needed: true,
      isCod: codToCollect > 0,
      codAmount: codToCollect,
      customerName: customerName.trim() || 'Mijoz',
      customerPhone: customerPhone.trim(),
      deliveryAddress: customerAddress.trim(),
      paymentType,
      totalAmount: tot,
      fulfillmentSource,
      notes: notes.trim(),
      items: sale.lines?.map(l => ({
        product_name: l.product_name,
        unit_price: l.unit_price,
        line_total: l.line_total,
        batch_code: l.batch_code || l.reference || (l.qr_code ? `QR: ${l.qr_code}` : ''),
        qr_code: l.qr_code,
        quantity: 1
      }))
    } : null;

    act(() => confirm(sale.id, paymentsPayload, deliveryData, customerPayload, notes.trim()));
  };

  return (
    <Modal open={Boolean(sale)} onClose={close} title={sale?.pending_no || 'Kassa so\'rovi'}>
      {sale && (
        <div className="cash-real-detail">
          <div className="between">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Status type={colors[sale.status]}>{labels[sale.status] || sale.status}</Status>
              {(sale.is_edited || (sale.updated_at && sale.updated_at !== sale.created_at)) && (
                <span style={{ background: '#fef3c7', color: '#b45309', border: '1px solid #fde68a', fontSize: '11px', padding: '2px 7px', borderRadius: '4px', fontWeight: 700 }}>
                  ✏️ Tahrirlangan
                </span>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <small style={{ display: 'block', color: 'var(--muted)' }}>Yaratildi: {date(sale.created_at)}</small>
              {(sale.is_edited || (sale.updated_at && sale.updated_at !== sale.created_at)) && (
                <small style={{ display: 'block', color: '#d97706', fontWeight: 600 }}>Tahrirlandi: {date(sale.updated_at)}</small>
              )}
            </div>
          </div>
          <div className="cash-real-parties">
            <span>
              <small>Sotuvchi</small>
              <b>{sale.seller_name}</b>
            </span>
            <span>
              <small>Do'kon</small>
              <b>{sale.location_name}</b>
            </span>
          </div>
          {sale.customer && (sale.customer.full_name || sale.customer.phone) && (
            <div style={{ margin: '8px 0', padding: '8px 12px', background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 8, fontSize: '12px' }}>
              <span>Mijoz (sotuvchidan): <b>{sale.customer.full_name || 'Ismsiz'}</b> {sale.customer.phone ? `(${sale.customer.phone})` : ''}</span>
              {sale.customer.address && <small style={{ display: 'block', color: 'var(--muted)', marginTop: 2 }}>Manzil: {sale.customer.address}</small>}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
            <h3 style={{ margin: 0 }}>Mahsulotlar ({sale.lines?.length || 0} ta)</h3>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowAllSecrets(prev => !prev)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                fontWeight: 650,
                padding: '3px 9px',
                borderRadius: 7,
                cursor: 'pointer',
                color: showAllSecrets ? '#15803d' : '#475569',
                borderColor: showAllSecrets ? '#bbf7d0' : '#cbd5e1',
                background: showAllSecrets ? '#f0fdf4' : '#f8fafc',
                border: '1px solid'
              }}
              title={showAllSecrets ? "Barcha tannarx va foydani yashirish (****)" : "Barcha tannarx va foydani ko‘rsatish"}
            >
              {showAllSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
              <span>{showAllSecrets ? "Yashirish (****)" : "Tannarx va foydani ochish"}</span>
            </button>
          </div>

          <div className="cash-real-lines">
            {sale.lines?.map(line => {
              const unitCost = Number(line.unit_cost ?? line.cost_price ?? 0);
              const retailPrice = Number(line.retail_price ?? 0);
              const unitPrice = Number(line.unit_price ?? 0);
              const discount = Number(line.discount || 0);
              const tax = Number(line.tax || 0);
              const profit = Number(line.profit ?? (unitPrice - unitCost - tax));
              const isProfitPos = profit >= 0;
              const costKey = `cost_${line.id}`;
              const profitKey = `profit_${line.id}`;
              const isCostShown = isSecretRevealed(costKey);
              const isProfitShown = isSecretRevealed(profitKey);

              return (
                <article key={line.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ display: 'block', fontSize: 13.5, color: 'var(--navy)' }}>{line.product_name}</b>
                      <small style={{ color: 'var(--muted)' }}>{line.sku} · {line.qr_code}</small>
                      {line.selected_components?.length > 0 && (
                        <small style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, color: 'var(--muted, #64748b)', marginTop: 2 }}>
                          Qismlar: {line.selected_components.map((c, i) => (
                            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {(c.image_url || c.imageUrl) && <img src={c.image_url || c.imageUrl} alt="" style={{ width: 14, height: 14, borderRadius: 2, objectFit: 'cover' }} />}
                              {c.name}{c.color ? ` (${c.color})` : ''}{i < line.selected_components.length - 1 ? ', ' : ''}
                            </span>
                          ))}
                        </small>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '4px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 6,
                        background: '#fff1f2',
                        color: '#e11d48',
                        border: '1px solid #fecdd3',
                        cursor: 'pointer',
                        flexShrink: 0
                      }}
                      disabled={busy}
                      title="Ushbu tovarni chekdan o‘chirish"
                      onClick={() => onDeleteLine?.(sale, line)}
                    >
                      <Trash2 size={12} /> Tovarni o‘chirish
                    </button>
                  </div>
                  <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))', gap: '6px', margin: '8px 0', padding: '8px 10px', background: '#f8fafc', borderRadius: '8px', border: '1px solid var(--line)' }}>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={e => {
                        e.stopPropagation();
                        toggleSecret(costKey);
                      }}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title={isCostShown ? "Yashirish uchun bosing" : "Tan narxini ko‘rish uchun ustiga bosing"}
                    >
                      <small style={{ color: '#64748b', fontSize: 10, display: 'block', fontWeight: 600 }}>Tan narxi</small>
                      {isCostShown ? (
                        <b style={{ color: '#334155', fontSize: 12 }}><DualPrice value={unitCost} rate={rate} /></b>
                      ) : (
                        <span style={{ fontFamily: 'monospace', fontWeight: 800, letterSpacing: 2, color: '#64748b', background: '#e2e8f0', padding: '1px 6px', borderRadius: 4, fontSize: 12, display: 'inline-block' }}>
                          ****
                        </span>
                      )}
                    </span>
                    <span>
                      <small style={{ color: '#64748b', fontSize: 10, display: 'block', fontWeight: 600 }}>Aytish (sotish) narxi</small>
                      <b style={{ color: '#334155', fontSize: 12 }}><DualPrice value={retailPrice} rate={rate} /></b>
                    </span>
                    <span>
                      <small style={{ color: '#0369a1', fontSize: 10, display: 'block', fontWeight: 700 }}>Sotilgan narx</small>
                      <b style={{ color: '#0284c7', fontSize: 12, fontWeight: 750 }}><DualPrice value={unitPrice} rate={rate} /></b>
                    </span>
                    {discount > 0 && (
                      <span>
                        <small style={{ color: '#b45309', fontSize: 10, display: 'block', fontWeight: 600 }}>Chegirma</small>
                        <b style={{ color: '#d97706', fontSize: 12 }}><DualPrice value={discount} rate={rate} /></b>
                      </span>
                    )}
                    {tax > 0 && (
                      <span>
                        <small style={{ color: '#64748b', fontSize: 10, display: 'block', fontWeight: 600 }}>Soliq</small>
                        <b style={{ color: '#334155', fontSize: 12 }}><DualPrice value={tax} rate={rate} /></b>
                      </span>
                    )}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={e => {
                        e.stopPropagation();
                        toggleSecret(profitKey);
                      }}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title={isProfitShown ? "Yashirish uchun bosing" : "Sof foydani ko‘rish uchun ustiga bosing"}
                    >
                      <small style={{ color: isProfitPos ? '#15803d' : '#b91c1c', fontSize: 10, display: 'block', fontWeight: 700 }}>Sof foyda</small>
                      {isProfitShown ? (
                        <b style={{ color: isProfitPos ? '#16a34a' : '#dc2626', fontSize: 12, fontWeight: 800 }}>
                          <DualPrice value={profit} rate={rate} />
                        </b>
                      ) : (
                        <span style={{ fontFamily: 'monospace', fontWeight: 800, letterSpacing: 2, color: isProfitPos ? '#15803d' : '#b91c1c', background: isProfitPos ? '#dcfce7' : '#fee2e2', padding: '1px 6px', borderRadius: 4, fontSize: 12, display: 'inline-block' }}>
                          ****
                        </span>
                      )}
                    </span>
                  </dl>
                  <strong><DualPrice value={Number(line.line_total || 0)} rate={rate} /></strong>
                </article>
              );
            })}
          </div>
          <div className="cash-real-total">
            <span>Subtotal <b><DualPrice value={Number(sale.subtotal || 0)} rate={rate} /></b></span>
            {Number(sale.discount || 0) > 0 && <span>Chegirma <b><DualPrice value={Number(sale.discount || 0)} rate={rate} /></b></span>}
            {Number(sale.tax || 0) > 0 && <span>Soliq <b><DualPrice value={Number(sale.tax || 0)} rate={rate} /></b></span>}
            {(() => {
              const saleTotalCost = sale.lines?.reduce((acc, l) => acc + Number(l.unit_cost ?? l.cost_price ?? 0), 0) || 0;
              const saleTotalProfit = sale.lines?.reduce((acc, l) => acc + Number(l.profit ?? (Number(l.unit_price || 0) - Number(l.unit_cost ?? l.cost_price ?? 0) - Number(l.tax || 0))), 0) || 0;
              const isTotCostShown = isSecretRevealed('totalCost');
              const isTotProfitShown = isSecretRevealed('totalProfit');

              return (
                <>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSecret('totalCost')}
                    style={{ borderTop: '1px dashed var(--line)', paddingTop: 4, marginTop: 4, cursor: 'pointer', userSelect: 'none' }}
                    title={isTotCostShown ? "Yashirish uchun bosing" : "Jami tannarxni ko‘rish uchun ustiga bosing"}
                  >
                    <small style={{ color: 'var(--muted)', fontWeight: 600 }}>Jami tannarx:</small>
                    {isTotCostShown ? (
                      <b style={{ color: '#475569' }}><DualPrice value={saleTotalCost} rate={rate} /></b>
                    ) : (
                      <span style={{ fontFamily: 'monospace', fontWeight: 800, letterSpacing: 2, color: '#64748b', background: '#e2e8f0', padding: '1px 6px', borderRadius: 4, fontSize: 12, display: 'inline-block' }}>
                        ****
                      </span>
                    )}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSecret('totalProfit')}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    title={isTotProfitShown ? "Yashirish uchun bosing" : "Jami sof foydani ko‘rish uchun ustiga bosing"}
                  >
                    <small style={{ color: saleTotalProfit >= 0 ? '#15803d' : '#b91c1c', fontWeight: 700 }}>Jami sof foyda:</small>
                    {isTotProfitShown ? (
                      <b style={{ color: saleTotalProfit >= 0 ? '#16a34a' : '#dc2626', fontWeight: 800 }}><DualPrice value={saleTotalProfit} rate={rate} /></b>
                    ) : (
                      <span style={{ fontFamily: 'monospace', fontWeight: 800, letterSpacing: 2, color: saleTotalProfit >= 0 ? '#15803d' : '#b91c1c', background: saleTotalProfit >= 0 ? '#dcfce7' : '#fee2e2', padding: '1px 6px', borderRadius: 4, fontSize: 12, display: 'inline-block' }}>
                        ****
                      </span>
                    )}
                  </span>
                </>
              );
            })()}
            <strong>Jami <b><DualPrice value={Number(sale.total || 0)} rate={rate} /></b></strong>
          </div>

          {sale.payments && sale.payments.length > 0 && (
            <div style={{ marginTop: 12, padding: '12px 14px', background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <b style={{ fontSize: 13, color: 'var(--navy)' }}>To‘lov tafsilotlari:</b>
                {sale.status === 'confirmed' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11.5,
                      fontWeight: 700,
                      padding: '3px 9px',
                      background: '#eff6ff',
                      color: '#1d4ed8',
                      border: '1px solid #bfdbfe'
                    }}
                    onClick={() => onEditPayment?.(sale)}
                  >
                    <Edit3 size={12} /> To‘lovni tahrirlash
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sale.payments.map((p, idx) => {
                  const code = p.method_code || p.code;
                  const name = p.method_name || p.name;
                  const isCash = code === 'cash';
                  const isCard = code === 'card' || code === 'terminal';
                  const isCod = code === 'cod';
                  return (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                        {isCash ? '💵 Naqd pul' : isCard ? '💳 Plastik karta / terminal' : isCod ? '🚚 Kuryerdan beriladi (Kuryer olib keladi)' : `⚡ ${name || code}`}
                      </span>
                      <b><DualPrice value={Number(p.amount || 0)} rate={rate} /></b>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cashier Payment Selection (Only active when pending confirmation) */}
          {sale.can_confirm && !rejecting && (
            <div style={{ marginTop: 16, padding: '14px 16px', background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <b style={{ fontSize: 13.5, color: 'var(--navy, #0f172a)' }}>To‘lov shaklini tanlang:</b>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#0284c7' }}>
                  Summa: {new Intl.NumberFormat('uz-UZ').format(tot)} so'm
                </span>
              </div>

              {/* Payment buttons grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
                {[
                  ['cash', '💵 Naqd pul'],
                  ['card', '💳 Plastik / Click'],
                  ['split', '⚖️ Aralash to‘lov'],
                  ['cod', '🚚 Kuryerdan beraman'],
                  ['nasiya', '⏳ Nasiya (Qarz)']
                ].map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setPaymentType(code);
                      if (code === 'cod') setIsDelivery(true);
                      if (code === 'nasiya') {
                        setNasiyaAmount(String(tot));
                        setCashAmount('0');
                        setCardAmount('0');
                        setCodAmount('0');
                      } else if (code === 'cash') {
                        setCashAmount(String(tot));
                        setCardAmount('0');
                        setCodAmount('0');
                        setNasiyaAmount('0');
                      } else if (code === 'card') {
                        setCashAmount('0');
                        setCardAmount(String(tot));
                        setCodAmount('0');
                        setNasiyaAmount('0');
                      } else if (code === 'cod') {
                        setCashAmount('0');
                        setCardAmount('0');
                        setCodAmount(String(tot));
                        setNasiyaAmount('0');
                      } else if (code === 'split') {
                        if (!cashAmount && !cardAmount && !codAmount && !nasiyaAmount) {
                          setCashAmount(String(tot));
                          setCardAmount('0');
                          setCodAmount('0');
                          setNasiyaAmount('0');
                        }
                      }
                    }}
                    style={{
                      padding: '10px 8px',
                      borderRadius: 9,
                      border: paymentType === code
                        ? (code === 'nasiya' ? '2px solid #9333ea' : code === 'cod' ? '2px solid #ea580c' : '2px solid #0284c7')
                        : '1px solid var(--line, #cbd5e1)',
                      background: paymentType === code
                        ? (code === 'nasiya' ? '#faf5ff' : code === 'cod' ? '#fff7ed' : '#eff6ff')
                        : '#ffffff',
                      color: paymentType === code
                        ? (code === 'nasiya' ? '#7e22ce' : code === 'cod' ? '#c2410c' : '#0369a1')
                        : '#334155',
                      fontWeight: paymentType === code ? 800 : 600,
                      fontSize: 12.5,
                      cursor: 'pointer',
                      textAlign: 'center',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Split inputs */}
              {paymentType === 'split' && (
                <div style={{ marginTop: 12, padding: '12px 14px', background: '#ffffff', border: '1.5px solid #bfdbfe', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#15803d' }}>
                        💵 Naqd summa:
                      </span>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={cashAmount}
                        onChange={e => handleCashChange(e.target.value)}
                        placeholder="0"
                        style={{ fontWeight: 700, fontSize: 13 }}
                      />
                    </label>
                    <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#1d4ed8' }}>
                        💳 Plastik summa:
                      </span>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={cardAmount}
                        onChange={e => handleCardChange(e.target.value)}
                        placeholder="0"
                        style={{ fontWeight: 700, fontSize: 13 }}
                      />
                    </label>
                    <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#b45309' }}>
                        🚚 Kuryerdan beradi:
                      </span>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={codAmount}
                        onChange={e => handleCodChange(e.target.value)}
                        placeholder="0"
                        style={{ fontWeight: 700, fontSize: 13, borderColor: numCod > 0 ? '#f59e0b' : undefined }}
                      />
                    </label>
                    <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#7e22ce' }}>
                        ⏳ Nasiya summa:
                      </span>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={nasiyaAmount}
                        onChange={e => handleNasiyaChange(e.target.value)}
                        placeholder="0"
                        style={{ fontWeight: 700, fontSize: 13, borderColor: numNasiya > 0 ? '#9333ea' : undefined }}
                      />
                    </label>
                  </div>

                  {/* Split balance helper & calculation */}
                  <div style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: splitDiff === 0 ? '#f0fdf4' : splitDiff > 0 ? '#fffbeb' : '#fef2f2',
                    border: `1px solid ${splitDiff === 0 ? '#bbf7d0' : splitDiff > 0 ? '#fde68a' : '#fecaca'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                    fontSize: 12
                  }}>
                    <div>
                      <span>Kiritildi: <b>{splitSum.toLocaleString('uz-UZ')} so‘m</b> / Jami: <b>{tot.toLocaleString('uz-UZ')} so‘m</b></span>
                      {splitDiff === 0 && (
                        <span style={{ color: '#15803d', fontWeight: 700, marginLeft: 8 }}>✅ To‘liq taqsimlandi</span>
                      )}
                      {splitDiff > 0 && (
                        <span style={{ color: '#b45309', fontWeight: 700, marginLeft: 8 }}>⚠️ Qoldiq: {splitDiff.toLocaleString('uz-UZ')} so‘m</span>
                      )}
                      {splitDiff < 0 && (
                        <span style={{ color: '#b91c1c', fontWeight: 700, marginLeft: 8 }}>❌ Ortig‘i: {Math.abs(splitDiff).toLocaleString('uz-UZ')} so‘m ko‘p!</span>
                      )}
                    </div>

                    {splitDiff > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Qoldiqni qo‘shish:</span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => fillRemainingTo('cash')}
                          style={{ padding: '2px 7px', fontSize: 11, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}
                        >
                          + Naqdga
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => fillRemainingTo('card')}
                          style={{ padding: '2px 7px', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}
                        >
                          + Plastikka
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => fillRemainingTo('cod')}
                          style={{ padding: '2px 7px', fontSize: 11, background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}
                        >
                          + Kuryerga
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => fillRemainingTo('nasiya')}
                          style={{ padding: '2px 7px', fontSize: 11, background: '#faf5ff', color: '#7e22ce', border: '1px solid #e9d5ff' }}
                        >
                          + Nasiyaga
                        </button>
                      </div>
                    )}
                  </div>

                  {numCod > 0 && (
                    <div style={{ padding: '8px 10px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 11.5, color: '#c2410c' }}>
                      🚚 <b>Kuryer olib keladigan summa: {numCod.toLocaleString('uz-UZ')} so‘m.</b> Mijoz tovar yetkazilganda to‘laydi. Bepul dostavka zayavkasi shakllantiriladi va Dostavka bo‘limida ro‘yxatga olinadi.
                    </div>
                  )}

                  {numNasiya > 0 && (
                    <div style={{ padding: '8px 10px', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, fontSize: 11.5, color: '#7e22ce' }}>
                      ⏳ <b>Nasiyaga qoladigan summa: {numNasiya.toLocaleString('uz-UZ')} so‘m.</b> Mijoz keyinroq to‘laydi. Kassa bo‘limida Nasiyalar ro‘yxatida turadi. Mijozning F.I.O, telefon raqami va izoh kiritilishi shart.
                    </div>
                  )}
                </div>
              )}

              {/* COD banner */}
              {paymentType === 'cod' && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 12.5, color: '#c2410c' }}>
                  🚚 <b>Kuryerdan berib yuboraman:</b> Mijoz tovar yetkazilganda to‘laydi. Bepul dostavka zayavkasi shakllantiriladi va <b>Dostavka</b> bo‘limida ro‘yxatga olinadi. Kuryer pulni olib kelgach <b>"Pulni oldim"</b> tugmasini bosasiz.
                </div>
              )}

              {/* Nasiya banner */}
              {paymentType === 'nasiya' && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, fontSize: 12.5, color: '#7e22ce' }}>
                  ⏳ <b>To‘liq nasiya (qarzga) sotish:</b> Barcha summa ({tot.toLocaleString('uz-UZ')} so‘m) mijoz qarziga yoziladi. Kassa bo‘limida <b>Nasiyalar</b> ro‘yxatida turadi. Mijozning F.I.O, telefon raqami va izoh (qarz sababi, qaytarish muddati) kiritilishi shart.
                </div>
              )}

              {/* Nasiya customer & notes details */}
              {(paymentType === 'nasiya' || (paymentType === 'split' && numNasiya > 0)) && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #d8b4fe' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: '#faf5ff', border: '1.5px solid #d8b4fe', borderRadius: 10 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#6b21a8', display: 'flex', alignItems: 'center', gap: 6 }}>
                      ⏳ Nasiya (Qarz) uchun mijoz ma’lumotlari va izoh (Majburiy):
                    </div>
                    <label style={{ fontSize: 12, fontWeight: 600 }}>
                      Mijozning to‘liq ismi (F.I.O) *:
                      <input
                        className="input"
                        value={customerName}
                        onChange={e => setCustomerName(e.target.value)}
                        placeholder="Masalan: Abdullayev Olim"
                        style={{ borderColor: !customerName.trim() ? '#f87171' : undefined }}
                      />
                    </label>
                    <label style={{ fontSize: 12, fontWeight: 600 }}>
                      Telefon raqami *:
                      <input
                        className="input"
                        type="tel"
                        value={customerPhone}
                        onChange={e => setCustomerPhone(e.target.value)}
                        placeholder="+998 90 123 45 67"
                        style={{ borderColor: !customerPhone.trim() ? '#f87171' : undefined }}
                      />
                    </label>
                    <label style={{ fontSize: 12, fontWeight: 600 }}>
                      Nasiya izohi (qarz sababi, qaytarish muddati, kelishuv) *:
                      <textarea
                        className="input"
                        rows={2}
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        placeholder="Masalan: 10-noyabrgacha to‘lashga va’da berdi..."
                        style={{ borderColor: !notes.trim() ? '#f87171' : undefined }}
                      />
                    </label>
                  </div>
                </div>
              )}

              {/* Delivery section */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #cbd5e1' }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: (paymentType === 'cod' || (paymentType === 'split' && numCod > 0)) ? 'default' : 'pointer',
                  fontWeight: 700,
                  fontSize: 13
                }}>
                  <input
                    type="checkbox"
                    checked={isDelivery || paymentType === 'cod' || (paymentType === 'split' && numCod > 0)}
                    disabled={paymentType === 'cod' || (paymentType === 'split' && numCod > 0)}
                    onChange={e => setIsDelivery(e.target.checked)}
                    style={{ width: 17, height: 17 }}
                  />
                  <span>📦 Bepul yetkazib berish (Dostavka) zayavkasi shakllantirish</span>
                  {(paymentType === 'cod' || (paymentType === 'split' && numCod > 0)) && (
                    <small style={{ color: '#ea580c', fontWeight: 600 }}>(Kuryer to‘lovi uchun majburiy)</small>
                  )}
                </label>

                {(isDelivery || paymentType === 'cod' || (paymentType === 'split' && numCod > 0)) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, padding: '10px 12px', background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 8 }}>
                    <div style={{ fontSize: 11.5, color: 'var(--muted, #64748b)' }}>
                      Mijoz ma’lumotlarini tasdiqlang yoki mijoz aytganiga qarab tahrirlang:
                    </div>

                    <label style={{ fontSize: 12, fontWeight: 600 }}>
                      Mijoz ismi:
                      <input
                        className="input"
                        value={customerName}
                        onChange={e => setCustomerName(e.target.value)}
                        placeholder="Mijoz to‘liq ismi"
                      />
                    </label>

                    <label style={{ fontSize: 12, fontWeight: 600 }}>
                      Telefon raqami *:
                      <input
                        className="input"
                        type="tel"
                        value={customerPhone}
                        onChange={e => setCustomerPhone(e.target.value)}
                        placeholder="+998 90 123 45 67"
                      />
                    </label>

                    <label style={{ fontSize: 12, fontWeight: 600 }}>
                      Yetkazib berish manzili *:
                      <input
                        className="input"
                        value={customerAddress}
                        onChange={e => setCustomerAddress(e.target.value)}
                        placeholder="Shahar, tuman, ko‘cha, uy raqami, mo‘ljal..."
                      />
                    </label>

                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>
                        Yuklash / yetkazib berish joyi:
                      </span>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => setFulfillmentSource('warehouse')}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            fontSize: 12,
                            fontWeight: 700,
                            border: fulfillmentSource === 'warehouse' ? '2px solid #0284c7' : '1px solid #cbd5e1',
                            background: fulfillmentSource === 'warehouse' ? '#eff6ff' : '#fff',
                            color: fulfillmentSource === 'warehouse' ? '#0369a1' : '#475569',
                            cursor: 'pointer',
                            textAlign: 'left'
                          }}
                        >
                          🏢 Ombordan yuklash
                          <small style={{ display: 'block', fontSize: 10, fontWeight: 500, color: '#64748b', marginTop: 2 }}>
                            Do‘kondagi vitrina tovari saqlanadi
                          </small>
                        </button>
                        <button
                          type="button"
                          onClick={() => setFulfillmentSource('store')}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            fontSize: 12,
                            fontWeight: 700,
                            border: fulfillmentSource === 'store' ? '2px solid #16a34a' : '1px solid #cbd5e1',
                            background: fulfillmentSource === 'store' ? '#f0fdf4' : '#fff',
                            color: fulfillmentSource === 'store' ? '#15803d' : '#475569',
                            cursor: 'pointer',
                            textAlign: 'left'
                          }}
                        >
                          📍 Do‘kondan yuklash
                          <small style={{ display: 'block', fontSize: 10, fontWeight: 500, color: '#64748b', marginTop: 2 }}>
                            Do‘konda turgan haqiqiy tovar beriladi
                          </small>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="cash-real-inline-error">{error}</div>}

          {rejecting && (
            <div className="cash-real-reject">
              <label>
                Rad etish sababi
                <textarea rows="3" value={reason} onChange={e => setReason(e.target.value)} autoFocus />
              </label>
              <div>
                <button type="button" className="btn" onClick={() => setRejecting(false)}>Bekor qilish</button>
                <button
                  type="button"
                  className="btn cash-real-danger"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => reject(sale.id, reason.trim()))}
                >
                  Rad etish
                </button>
              </div>
            </div>
          )}

          {sale.can_confirm && !rejecting && (
            <div className="cash-real-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn cash-real-danger"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Rad etish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={handleConfirm}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 800,
                  fontSize: 13.5,
                  padding: '10px 18px',
                  background: (paymentType === 'cod' || (paymentType === 'split' && numCod > 0))
                    ? 'linear-gradient(135deg, #ea580c, #c2410c)'
                    : (paymentType === 'nasiya' || (paymentType === 'split' && numNasiya > 0))
                      ? 'linear-gradient(135deg, #9333ea, #7e22ce)'
                      : undefined
                }}
              >
                {busy
                  ? 'Tasdiqlanmoqda…'
                  : paymentType === 'cod'
                    ? '🚚 Kuryerdan olish zayavkasi va stikerlar'
                    : (paymentType === 'split' && numCod > 0)
                      ? `🚚 Tasdiqlash (Kuryerdan: ${numCod.toLocaleString('uz-UZ')} so‘m)`
                      : paymentType === 'nasiya'
                        ? '⏳ Nasiyaga tasdiqlash'
                        : (paymentType === 'split' && numNasiya > 0)
                          ? `⏳ Nasiya bilan tasdiqlash (Qarz: ${numNasiya.toLocaleString('uz-UZ')} so‘m)`
                          : (isDelivery ? '✅ Pulni oldim va dostavka stikerlari' : '✅ Pulni qabul qildim')}
              </button>
            </div>
          )}

          {sale.status === 'confirmed' && (
            <div className="cash-real-actions" style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-outline"
                style={{
                  flex: '1 1 200px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 18px',
                  fontSize: 13,
                  fontWeight: 700,
                  borderColor: '#3b82f6',
                  color: '#1d4ed8',
                  background: '#eff6ff'
                }}
                disabled={busy}
                onClick={() => onEditPayment?.(sale)}
              >
                <Edit3 size={16} />
                To‘lov shaklini tahrirlash
              </button>

              <button
                type="button"
                className="btn btn-primary"
                style={{
                  flex: '1 1 200px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 18px',
                  fontSize: 13,
                  fontWeight: 700
                }}
                disabled={busy}
                onClick={() => act(() => onViewReceipt?.(sale.id))}
              >
                <Printer size={16} />
                {busy ? 'Chek yuklanmoqda…' : 'Kassa chekini ko‘rish (40 × 30 mm)'}
              </button>

              <button
                type="button"
                className="btn btn-outline"
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 18px',
                  fontSize: 13,
                  fontWeight: 700,
                  borderColor: '#f97316',
                  color: '#ea580c'
                }}
                disabled={busy}
                onClick={() => onOpenStickers?.(sale)}
              >
                <Tag size={16} />
                Tovar stikerlarini chiqarish ({sale.lines?.length || 1} ta)
              </button>
            </div>
          )}

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-sm"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#fff1f2',
                color: '#e11d48',
                border: '1px solid #fecdd3',
                padding: '8px 14px',
                fontSize: 12,
                fontWeight: 600
              }}
              disabled={busy}
              onClick={() => {
                close();
                onDelete?.(sale);
              }}
            >
              <Trash2 size={14} /> Kassa kirimini o‘chirish
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditSalePaymentModal({ open, sale, onClose, onSuccess, rate, toast }) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fullSale, setFullSale] = useState(null);

  const [paymentType, setPaymentType] = useState('cash'); // 'cash' | 'card' | 'split' | 'cod' | 'nasiya'
  const [cashAmount, setCashAmount] = useState('');
  const [cardAmount, setCardAmount] = useState('');
  const [codAmount, setCodAmount] = useState('');
  const [nasiyaAmount, setNasiyaAmount] = useState('');
  const [initialCod, setInitialCod] = useState(0);
  const [initialNasiya, setInitialNasiya] = useState(0);
  const [isDelivery, setIsDelivery] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [fulfillmentSource, setFulfillmentSource] = useState('warehouse'); // 'warehouse' | 'store'
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open || !sale?.id) {
      setFullSale(null);
      setInitialCod(0);
      setInitialNasiya(0);
      setError('');
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError('');

    getPosPendingSale(sale.id)
      .then(data => {
        if (!isMounted) return;
        setFullSale(data);
        const tot = Number(data.total || 0);

        const payments = data.payments || [];
        let curCash = 0;
        let curCard = 0;
        let curCod = 0;
        let curNasiya = 0;

        payments.forEach(p => {
          const code = p.method_code || p.code;
          const amt = Number(p.amount || 0);
          if (code === 'cash') curCash += amt;
          else if (code === 'card' || code === 'terminal' || code === 'click') curCard += amt;
          else if (code === 'cod') curCod += amt;
          else if (code === 'nasiya') curNasiya += amt;
        });

        setInitialCod(curCod);
        setInitialNasiya(curNasiya);

        if (payments.length === 1 && curCash === tot) {
          setPaymentType('cash');
        } else if (payments.length === 1 && curCard === tot) {
          setPaymentType('card');
        } else if (payments.length === 1 && curCod === tot) {
          setPaymentType('cod');
        } else if (payments.length === 1 && curNasiya === tot) {
          setPaymentType('nasiya');
        } else if (payments.length > 0) {
          setPaymentType('split');
        } else {
          setPaymentType('cash');
          curCash = tot;
        }

        setCashAmount(curCash > 0 ? String(curCash) : (payments.length === 0 ? String(tot) : '0'));
        setCardAmount(curCard > 0 ? String(curCard) : '0');
        setCodAmount(curCod > 0 ? String(curCod) : '0');
        setNasiyaAmount(curNasiya > 0 ? String(curNasiya) : '0');

        const del = data.delivery || null;
        const cust = data.customer || null;
        const hasDel = Boolean(del) || curCod > 0;
        setIsDelivery(hasDel);
        setCustomerName(del?.customer_name || cust?.full_name || '');
        setCustomerPhone(del?.customer_phone || cust?.phone || '');
        setCustomerAddress(del?.delivery_address || cust?.address || '');
        setFulfillmentSource(del?.fulfillment_source || 'warehouse');
        setDeliveryNotes(del?.notes || '');
        setNotes(data.notes || '');
      })
      .catch(err => {
        if (!isMounted) return;
        setError(msg(err));
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [open, sale?.id]);

  if (!open) return null;

  const currentTotal = Number(fullSale?.total ?? sale?.total ?? 0);
  const numCash = Math.round(Number(String(cashAmount).replace(/[^\d.]/g, '') || 0));
  const numCard = Math.round(Number(String(cardAmount).replace(/[^\d.]/g, '') || 0));
  const numCod = Math.round(Number(String(codAmount).replace(/[^\d.]/g, '') || 0));
  const numNasiya = Math.round(Number(String(nasiyaAmount).replace(/[^\d.]/g, '') || 0));
  const splitSum = numCash + numCard + numCod + numNasiya;
  const splitDiff = currentTotal - splitSum;

  const fillRemainingTo = target => {
    if (target === 'cash') {
      const remainder = Math.max(0, currentTotal - numCard - numCod - numNasiya);
      setCashAmount(String(numCash + remainder));
    } else if (target === 'card') {
      const remainder = Math.max(0, currentTotal - numCash - numCod - numNasiya);
      setCardAmount(String(numCard + remainder));
    } else if (target === 'cod') {
      const remainder = Math.max(0, currentTotal - numCash - numCard - numNasiya);
      setCodAmount(String(numCod + remainder));
    } else if (target === 'nasiya') {
      const remainder = Math.max(0, currentTotal - numCash - numCard - numCod);
      setNasiyaAmount(String(numNasiya + remainder));
    }
  };

  const handleCashChange = val => {
    const rawVal = String(val).replace(/[^\d.]/g, '');
    const newCash = Math.round(Number(rawVal || 0));
    setCashAmount(rawVal);
    // If sale had Nasiya debt or in split mode, auto-recalculate remaining debt
    if (initialNasiya > 0 || numNasiya > 0 || paymentType === 'split' || paymentType === 'nasiya') {
      const remDebt = Math.max(0, currentTotal - newCash - numCard - numCod);
      setNasiyaAmount(String(remDebt));
    }
  };

  const handleCardChange = val => {
    const rawVal = String(val).replace(/[^\d.]/g, '');
    const newCard = Math.round(Number(rawVal || 0));
    setCardAmount(rawVal);
    // Auto-recalculate remaining debt
    if (initialNasiya > 0 || numNasiya > 0 || paymentType === 'split' || paymentType === 'nasiya') {
      const remDebt = Math.max(0, currentTotal - numCash - newCard - numCod);
      setNasiyaAmount(String(remDebt));
    }
  };

  const handleCodChange = val => {
    const rawVal = String(val).replace(/[^\d.]/g, '');
    const newCod = Math.round(Number(rawVal || 0));
    setCodAmount(rawVal);
    if (initialNasiya > 0 || numNasiya > 0 || paymentType === 'split' || paymentType === 'nasiya') {
      const remDebt = Math.max(0, currentTotal - numCash - numCard - newCod);
      setNasiyaAmount(String(remDebt));
    }
  };

  const handleNasiyaChange = val => {
    const rawVal = String(val).replace(/[^\d.]/g, '');
    setNasiyaAmount(rawVal);
  };

  const handleSave = async () => {
    if (!fullSale && !sale) return;
    const saleId = fullSale?.id || sale?.id;
    setError('');

    let paymentsPayload = [];
    if (paymentType === 'cash') {
      paymentsPayload = [{ method_code: 'cash', amount: currentTotal }];
    } else if (paymentType === 'card') {
      paymentsPayload = [{ method_code: 'card', amount: currentTotal }];
    } else if (paymentType === 'cod') {
      paymentsPayload = [{ method_code: 'cod', amount: currentTotal }];
    } else if (paymentType === 'nasiya') {
      paymentsPayload = [{ method_code: 'nasiya', amount: currentTotal }];
    } else if (paymentType === 'split') {
      if (numCash < 0 || numCard < 0 || numCod < 0 || numNasiya < 0) {
        setError('To‘lov summalari manfiy bo‘lishi mumkin emas.');
        return;
      }
      if (Math.abs(splitSum - currentTotal) > 0.01) {
        setError(
          `Aralash to‘lovlar jami (${splitSum.toLocaleString('uz-UZ')} so'm) xarid summasiga (${currentTotal.toLocaleString('uz-UZ')} so'm) teng bo‘lishi kerak. Farq: ${Math.abs(splitDiff).toLocaleString('uz-UZ')} so'm.`
        );
        return;
      }
      paymentsPayload = [
        { method_code: 'cash', amount: numCash },
        { method_code: 'card', amount: numCard },
        { method_code: 'cod', amount: numCod },
        { method_code: 'nasiya', amount: numNasiya }
      ].filter(p => p.amount > 0);
    }

    if (paymentsPayload.length === 0) {
      setError('Kamida bitta to‘lov usuli kiritilishi shart.');
      return;
    }

    const isNasiya = paymentType === 'nasiya' || (paymentType === 'split' && numNasiya > 0);
    if (isNasiya) {
      if (!customerName.trim()) {
        setError('Nasiya savdo uchun mijozning F.I.O (ismi) kiritilishi shart.');
        return;
      }
      if (!customerPhone.trim()) {
        setError('Nasiya savdo uchun mijozning telefon raqami kiritilishi shart.');
        return;
      }
      if (!notes.trim()) {
        setError('Nasiya savdo uchun izoh (qarz sababi, qaytarish muddati va kelishuv) kiritilishi shart.');
        return;
      }
    }

    const codToCollect = paymentType === 'cod' ? currentTotal : (paymentType === 'split' ? numCod : 0);
    const isCodPayment = codToCollect > 0;
    const deliveryNeeded = isCodPayment || (isDelivery && Boolean(customerPhone.trim() || customerAddress.trim()));

    if (isCodPayment) {
      if (!customerPhone.trim()) {
        setError('Dostavka / Kuryerdan to‘lov uchun mijoz telefon raqami kiritilishi shart.');
        return;
      }
      if (!customerAddress.trim()) {
        setError('Dostavka / Kuryerdan to‘lov uchun mijoz yetkazish manzili kiritilishi shart.');
        return;
      }
    }

    const deliveryPayload = {
      needed: Boolean(deliveryNeeded || fullSale?.delivery),
      isCod: codToCollect > 0,
      cod_amount: codToCollect,
      customer_name: customerName.trim() || fullSale?.delivery?.customer_name || 'Mijoz',
      customer_phone: customerPhone.trim() || fullSale?.delivery?.customer_phone || '',
      customer_address: customerAddress.trim() || fullSale?.delivery?.delivery_address || '',
      fulfillment_source: fulfillmentSource || fullSale?.delivery?.fulfillment_source || 'warehouse',
      notes: notes.trim() || deliveryNotes.trim() || fullSale?.delivery?.notes || ''
    };

    setBusy(true);
    try {
      await updateConfirmedSalePayments({
        pendingSaleId: saleId,
        payments: paymentsPayload,
        delivery: deliveryPayload
      });
      toast?.('To‘lov shakli muvaffaqiyatli yangilandi!');
      await onSuccess?.(saleId);
      onClose();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={`To‘lov shaklini tahrirlash — ${sale?.pending_no || 'Savdo'}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted)' }}>
            Yuklanmoqda…
          </div>
        ) : (
          <>
            {/* Sale summary box */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 14px',
              background: '#f8fafc',
              border: '1px solid var(--line)',
              borderRadius: 10
            }}>
              <div>
                <span style={{ fontSize: 12, color: 'var(--muted)', display: 'block' }}>Kassa yozuvi</span>
                <b style={{ fontSize: 14, color: 'var(--navy)' }}>{fullSale?.pending_no || sale?.pending_no}</b>
                <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, marginLeft: 8 }}>● Tasdiqlangan</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', display: 'block' }}>Xarid summasi:</span>
                <b style={{ fontSize: 16, color: '#0284c7' }}>
                  {currentTotal.toLocaleString('uz-UZ')} so‘m
                </b>
              </div>
            </div>

            {/* Quick Nasiya debt repayment banner */}
            {initialNasiya > 0 && (
              <div style={{
                padding: '12px 14px',
                background: '#faf5ff',
                border: '1.5px solid #d8b4fe',
                borderRadius: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 10
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#6b21a8', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Clock size={17} /> Nasiya (Qarz) to‘lovi:
                    </div>
                    <div style={{ fontSize: 12, color: '#7e22ce', marginTop: 2 }}>
                      Mavjud qarz: <b>{Number(initialNasiya).toLocaleString('uz-UZ')} so‘m</b>.
                      {numNasiya > 0 ? (
                        <span> Qoladigan qarz: <b style={{ color: '#b91c1c' }}>{numNasiya.toLocaleString('uz-UZ')} so‘m</b></span>
                      ) : (
                        <span style={{ color: '#15803d', fontWeight: 700 }}> ✅ Qarz to‘liq yopiladi!</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        background: '#15803d',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: 11.5,
                        padding: '6px 12px',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer'
                      }}
                      onClick={() => {
                        setPaymentType('split');
                        setCashAmount(String(numCash + numNasiya));
                        setNasiyaAmount('0');
                      }}
                    >
                      ⚡ To‘liq naqd to‘lash ({numNasiya.toLocaleString('uz-UZ')} so‘m)
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        background: '#1d4ed8',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: 11.5,
                        padding: '6px 12px',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer'
                      }}
                      onClick={() => {
                        setPaymentType('split');
                        setCardAmount(String(numCard + numNasiya));
                        setNasiyaAmount('0');
                      }}
                    >
                      ⚡ To‘liq plastik/click to‘lash ({numNasiya.toLocaleString('uz-UZ')} so‘m)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Quick courier-to-cash converter if sale has courier balance */}
            {initialCod > 0 && numCod > 0 && (
              <div style={{
                padding: '12px 14px',
                background: '#fffbeb',
                border: '1.5px solid #fde68a',
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap'
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Truck size={17} /> Kuryer pul topshirdimi?
                  </div>
                  <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 2 }}>
                    Kuryerdan topshirilishi kerak bo‘lgan summa: <b>{Number(numCod).toLocaleString('uz-UZ')} so‘m</b>.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{
                    background: '#15803d',
                    color: '#ffffff',
                    fontWeight: 800,
                    fontSize: 12,
                    padding: '7px 14px',
                    border: 'none',
                    borderRadius: 7,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: '0 2px 4px rgba(21, 128, 61, 0.2)'
                  }}
                  onClick={() => {
                    if (paymentType === 'cod' || numCard === 0) {
                      setPaymentType('cash');
                      setCashAmount(String(currentTotal));
                      setCardAmount('0');
                      setCodAmount('0');
                    } else {
                      setPaymentType('split');
                      setCashAmount(String(numCash + numCod));
                      setCodAmount('0');
                    }
                  }}
                >
                  ⚡ Naqdga o‘tkazish ({Number(numCod).toLocaleString('uz-UZ')} so‘m)
                </button>
              </div>
            )}

            {/* Payment Method selector buttons */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <b style={{ fontSize: 13, color: 'var(--navy)' }}>Yangi to‘lov shaklini tanlang:</b>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Tanlang yoki aralashtiring</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
                {[
                  ['cash', '💵 Naqd pul'],
                  ['card', '💳 Plastik / Click'],
                  ['split', '⚖️ Aralash to‘lov'],
                  ['cod', '🚚 Kuryerdan beradi'],
                  ['nasiya', '⏳ Nasiya (Qarz)']
                ].map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setPaymentType(code);
                      if (code === 'cash') {
                        setCashAmount(String(currentTotal));
                        setCardAmount('0');
                        setCodAmount('0');
                        setNasiyaAmount('0');
                      } else if (code === 'card') {
                        setCashAmount('0');
                        setCardAmount(String(currentTotal));
                        setCodAmount('0');
                        setNasiyaAmount('0');
                      } else if (code === 'cod') {
                        setCashAmount('0');
                        setCardAmount('0');
                        setCodAmount(String(currentTotal));
                        setNasiyaAmount('0');
                        setIsDelivery(true);
                      } else if (code === 'nasiya') {
                        setCashAmount('0');
                        setCardAmount('0');
                        setCodAmount('0');
                        setNasiyaAmount(String(currentTotal));
                      } else if (code === 'split') {
                        if (!numCash && !numCard && !numCod && !numNasiya) {
                          setCashAmount(String(currentTotal));
                          setCardAmount('0');
                          setCodAmount('0');
                          setNasiyaAmount('0');
                        }
                      }
                    }}
                    style={{
                      padding: '10px 8px',
                      borderRadius: 9,
                      border: paymentType === code
                        ? (code === 'nasiya' ? '2px solid #9333ea' : code === 'cod' ? '2px solid #ea580c' : '2px solid #0284c7')
                        : '1px solid var(--line, #cbd5e1)',
                      background: paymentType === code
                        ? (code === 'nasiya' ? '#faf5ff' : code === 'cod' ? '#fff7ed' : '#eff6ff')
                        : '#ffffff',
                      color: paymentType === code
                        ? (code === 'nasiya' ? '#7e22ce' : code === 'cod' ? '#c2410c' : '#0369a1')
                        : '#334155',
                      fontWeight: paymentType === code ? 800 : 600,
                      fontSize: 12.5,
                      cursor: 'pointer',
                      textAlign: 'center',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Split inputs if split mode */}
            {paymentType === 'split' && (
              <div style={{ padding: '12px 14px', background: '#ffffff', border: '1.5px solid #bfdbfe', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#15803d' }}>
                      💵 Naqd summa:
                    </span>
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={cashAmount}
                      onChange={e => handleCashChange(e.target.value)}
                      placeholder="0"
                      style={{ fontWeight: 700, fontSize: 13 }}
                    />
                  </label>
                  <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#1d4ed8' }}>
                      💳 Plastik summa:
                    </span>
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={cardAmount}
                      onChange={e => handleCardChange(e.target.value)}
                      placeholder="0"
                      style={{ fontWeight: 700, fontSize: 13 }}
                    />
                  </label>
                  <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#b45309' }}>
                      🚚 Kuryerdan beradi:
                    </span>
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={codAmount}
                      onChange={e => handleCodChange(e.target.value)}
                      placeholder="0"
                      style={{ fontWeight: 700, fontSize: 13, borderColor: numCod > 0 ? '#f59e0b' : undefined }}
                    />
                  </label>
                  <label style={{ fontSize: 12, fontWeight: 700, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#7e22ce' }}>
                      ⏳ Nasiya (Qolgan qarz):
                    </span>
                    <input
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={nasiyaAmount}
                      onChange={e => handleNasiyaChange(e.target.value)}
                      placeholder="0"
                      style={{ fontWeight: 700, fontSize: 13, borderColor: numNasiya > 0 ? '#9333ea' : undefined }}
                    />
                  </label>
                </div>

                {/* Balance validation bar */}
                <div style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: splitDiff === 0 ? '#f0fdf4' : splitDiff > 0 ? '#fffbeb' : '#fef2f2',
                  border: `1px solid ${splitDiff === 0 ? '#bbf7d0' : splitDiff > 0 ? '#fde68a' : '#fecaca'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                  fontSize: 12
                }}>
                  <div>
                    <span>Kiritildi: <b>{splitSum.toLocaleString('uz-UZ')} so‘m</b> / Jami: <b>{currentTotal.toLocaleString('uz-UZ')} so‘m</b></span>
                    {splitDiff === 0 && (
                      <span style={{ color: '#15803d', fontWeight: 700, marginLeft: 8 }}>✅ To‘liq taqsimlandi</span>
                    )}
                    {splitDiff > 0 && (
                      <span style={{ color: '#b45309', fontWeight: 700, marginLeft: 8 }}>⚠️ Qoldiq: {splitDiff.toLocaleString('uz-UZ')} so‘m</span>
                    )}
                    {splitDiff < 0 && (
                      <span style={{ color: '#b91c1c', fontWeight: 700, marginLeft: 8 }}>❌ Ortig‘i: {Math.abs(splitDiff).toLocaleString('uz-UZ')} so‘m ko‘p!</span>
                    )}
                  </div>

                  {splitDiff > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>Qoldiqni qo‘shish:</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => fillRemainingTo('cash')}
                        style={{ padding: '2px 7px', fontSize: 11, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}
                      >
                        + Naqdga
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => fillRemainingTo('card')}
                        style={{ padding: '2px 7px', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}
                      >
                        + Plastikka
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => fillRemainingTo('cod')}
                        style={{ padding: '2px 7px', fontSize: 11, background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}
                      >
                        + Kuryerga
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => fillRemainingTo('nasiya')}
                        style={{ padding: '2px 7px', fontSize: 11, background: '#faf5ff', color: '#7e22ce', border: '1px solid #e9d5ff' }}
                      >
                        + Nasiyaga
                      </button>
                    </div>
                  )}
                </div>

                {numCod > 0 && (
                  <div style={{ padding: '8px 10px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 11.5, color: '#c2410c' }}>
                    🚚 <b>Kuryer olib keladigan summa: {numCod.toLocaleString('uz-UZ')} so‘m.</b> Mijoz tovar yetkazilganda to‘laydi. Kassa kirimlarida "Shundan kuryer beradi" blokiga o‘tadi va Dostavka bo‘limida yangilanadi.
                  </div>
                )}

                {numNasiya > 0 && (
                  <div style={{ padding: '8px 10px', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, fontSize: 11.5, color: '#7e22ce' }}>
                    ⏳ <b>Nasiyaga qoladigan summa: {numNasiya.toLocaleString('uz-UZ')} so‘m.</b> Mijoz keyinroq to‘laydi. Kassa bo‘limida Nasiyalar ro‘yxatida turadi. Mijozning F.I.O, telefon raqami va izoh kiritilishi shart.
                  </div>
                )}
              </div>
            )}

            {/* COD single mode notice */}
            {paymentType === 'cod' && (
              <div style={{ padding: '10px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 12.5, color: '#c2410c' }}>
                🚚 <b>To‘liq kuryerdan beriladi:</b> Mijoz tovar yetkazilganda to‘laydi ({currentTotal.toLocaleString('uz-UZ')} so‘m). Kassa kirimlarida "Shundan kuryer beradi" blokida ko‘rinadi. Kuryer pulni olib kelgach "Pulni oldim" orqali qabul qilasiz.
              </div>
            )}

            {/* Nasiya single mode notice */}
            {paymentType === 'nasiya' && (
              <div style={{ padding: '10px 12px', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, fontSize: 12.5, color: '#7e22ce' }}>
                ⏳ <b>To‘liq nasiya (qarzga) o‘tkazish:</b> Barcha summa ({currentTotal.toLocaleString('uz-UZ')} so‘m) mijoz qarziga yoziladi. Kassa bo‘limida <b>Nasiyalar</b> ro‘yxatida turadi. Mijozning F.I.O, telefon raqami va izoh (qarz sababi, qaytarish muddati) kiritilishi shart.
              </div>
            )}

            {/* Nasiya details section */}
            {(paymentType === 'nasiya' || (paymentType === 'split' && numNasiya > 0)) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: '#faf5ff', border: '1.5px solid #d8b4fe', borderRadius: 10 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#6b21a8', display: 'flex', alignItems: 'center', gap: 6 }}>
                  ⏳ Nasiya (Qarz) uchun mijoz ma’lumotlari va izoh (Majburiy):
                </div>
                <label style={{ fontSize: 12, fontWeight: 600 }}>
                  Mijozning to‘liq ismi (F.I.O) *:
                  <input
                    className="input"
                    value={customerName}
                    onChange={e => setCustomerName(e.target.value)}
                    placeholder="Masalan: Abdullayev Olim"
                    style={{ borderColor: !customerName.trim() ? '#f87171' : undefined }}
                  />
                </label>
                <label style={{ fontSize: 12, fontWeight: 600 }}>
                  Telefon raqami *:
                  <input
                    className="input"
                    type="tel"
                    value={customerPhone}
                    onChange={e => setCustomerPhone(e.target.value)}
                    placeholder="+998 90 123 45 67"
                    style={{ borderColor: !customerPhone.trim() ? '#f87171' : undefined }}
                  />
                </label>
                <label style={{ fontSize: 12, fontWeight: 600 }}>
                  Nasiya izohi (qarz sababi, qaytarish muddati, kelishuv) *:
                  <textarea
                    className="input"
                    rows={2}
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Masalan: 10-noyabrgacha to‘lashga va’da berdi..."
                    style={{ borderColor: !notes.trim() ? '#f87171' : undefined }}
                  />
                </label>
              </div>
            )}

            {/* Delivery details if COD or delivery was requested */}
            <div style={{ paddingTop: 8, borderTop: '1px dashed #cbd5e1' }}>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: (paymentType === 'cod' || (paymentType === 'split' && numCod > 0)) ? 'default' : 'pointer',
                fontWeight: 700,
                fontSize: 13
              }}>
                <input
                  type="checkbox"
                  checked={isDelivery || paymentType === 'cod' || (paymentType === 'split' && numCod > 0)}
                  disabled={paymentType === 'cod' || (paymentType === 'split' && numCod > 0)}
                  onChange={e => setIsDelivery(e.target.checked)}
                  style={{ width: 17, height: 17 }}
                />
                <span>📦 Bepul yetkazib berish (Dostavka) ma’lumotlari</span>
                {(paymentType === 'cod' || (paymentType === 'split' && numCod > 0)) && (
                  <small style={{ color: '#ea580c', fontWeight: 600 }}>(Kuryer to‘lovi uchun majburiy)</small>
                )}
              </label>

              {(isDelivery || paymentType === 'cod' || (paymentType === 'split' && numCod > 0)) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, padding: '10px 12px', background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 8 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--muted, #64748b)' }}>
                    Kuryerga yetkazish va to‘lovni yig‘ish uchun mijoz kontakt ma’lumotlari:
                  </div>

                  <label style={{ fontSize: 12, fontWeight: 600 }}>
                    Mijoz ismi:
                    <input
                      className="input"
                      value={customerName}
                      onChange={e => setCustomerName(e.target.value)}
                      placeholder="Mijoz to‘liq ismi"
                    />
                  </label>

                  <label style={{ fontSize: 12, fontWeight: 600 }}>
                    Telefon raqami *:
                    <input
                      className="input"
                      type="tel"
                      value={customerPhone}
                      onChange={e => setCustomerPhone(e.target.value)}
                      placeholder="+998 90 123 45 67"
                    />
                  </label>

                  <label style={{ fontSize: 12, fontWeight: 600 }}>
                    Yetkazib berish manzili *:
                    <input
                      className="input"
                      value={customerAddress}
                      onChange={e => setCustomerAddress(e.target.value)}
                      placeholder="Shahar, tuman, ko‘cha, uy raqami, mo‘ljal..."
                    />
                  </label>

                  <label style={{ fontSize: 12, fontWeight: 600 }}>
                    Kuryer uchun izoh (ixtiyoriy):
                    <input
                      className="input"
                      value={deliveryNotes}
                      onChange={e => setDeliveryNotes(e.target.value)}
                      placeholder="Masalan: Soat 15:00 dan keyin yetkazing..."
                    />
                  </label>

                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>
                      Yuklash / yetkazib berish joyi:
                    </span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => setFulfillmentSource('warehouse')}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 700,
                          border: fulfillmentSource === 'warehouse' ? '2px solid #0284c7' : '1px solid #cbd5e1',
                          background: fulfillmentSource === 'warehouse' ? '#eff6ff' : '#fff',
                          color: fulfillmentSource === 'warehouse' ? '#0369a1' : '#475569',
                          cursor: 'pointer',
                          textAlign: 'left'
                        }}
                      >
                        🏢 Ombordan yuklash
                        <small style={{ display: 'block', fontSize: 10, fontWeight: 500, color: '#64748b', marginTop: 2 }}>
                          Do‘kondagi vitrina tovari saqlanadi
                        </small>
                      </button>
                      <button
                        type="button"
                        onClick={() => setFulfillmentSource('store')}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 700,
                          border: fulfillmentSource === 'store' ? '2px solid #16a34a' : '1px solid #cbd5e1',
                          background: fulfillmentSource === 'store' ? '#f0fdf4' : '#fff',
                          color: fulfillmentSource === 'store' ? '#15803d' : '#475569',
                          cursor: 'pointer',
                          textAlign: 'left'
                        }}
                      >
                        📍 Do‘kondan yuklash
                        <small style={{ display: 'block', fontSize: 10, fontWeight: 500, color: '#64748b', marginTop: 2 }}>
                          Do‘konda turgan haqiqiy tovar beriladi
                        </small>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {error && <div className="cash-real-inline-error">{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={onClose}
              >
                Bekor qilish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || loading}
                onClick={handleSave}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 700,
                  fontSize: 13,
                  padding: '10px 18px',
                  background: (paymentType === 'cod' || (paymentType === 'split' && numCod > 0))
                    ? 'linear-gradient(135deg, #ea580c, #c2410c)'
                    : (paymentType === 'nasiya' || (paymentType === 'split' && numNasiya > 0))
                      ? 'linear-gradient(135deg, #9333ea, #7e22ce)'
                      : undefined
                }}
              >
                {busy ? 'Saqlanmoqda…' : '💾 Saqlash va to‘lovni yangilash'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Receipt({ receipt, close, rate }) {
  const [printMode, setPrintMode] = useState('per_item');
  const [previewIndex, setPreviewIndex] = useState(0);
  const [preferredPrinter, setPreferredPrinter] = useState(() => {
    try {
      return localStorage.getItem('texnobazar_selected_thermal_printer') || 'detonger';
    } catch {
      return 'detonger';
    }
  });
  const [bluetoothModalOpen, setBluetoothModalOpen] = useState(false);

  const openBluetoothPrint = (printerType) => {
    if (printerType) {
      setPreferredPrinter(printerType);
      try {
        localStorage.setItem('texnobazar_selected_thermal_printer', printerType);
      } catch {}
    }
    setBluetoothModalOpen(true);
  };

  if (!receipt) return null;
  const lines = receipt.lines || [];
  const multipleLines = lines.length > 1;

  const handlePrint = () => {
    printThermalReceipt(receipt, { mode: printMode });
  };

  return (
    <Modal open={Boolean(receipt)} onClose={close} title="Tasdiqlangan savdo cheki">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
          <div className="between" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
            <div>
              <b style={{ fontSize: 13, display: 'block', color: 'var(--navy)' }}>Termoprinter cheki (40 × 30 mm)</b>
              <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                P1 Label Printer va 40x30 mm o‘lchamdagi qog‘ozga moslangan
              </small>
            </div>
            {multipleLines && printMode === 'per_item' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '2px 6px' }}>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={previewIndex <= 0}
                  onClick={() => setPreviewIndex(i => Math.max(0, i - 1))}
                  style={{ width: 22, height: 22 }}
                  title="Oldingi tovar"
                >
                  <ChevronLeft size={14} />
                </button>
                <small style={{ fontWeight: 800, fontSize: 11 }}>
                  {previewIndex + 1} / {lines.length}
                </small>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={previewIndex >= lines.length - 1}
                  onClick={() => setPreviewIndex(i => Math.min(lines.length - 1, i + 1))}
                  style={{ width: 22, height: 22 }}
                  title="Keyingi tovar"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>

          {multipleLines && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                className={`btn btn-sm ${printMode === 'per_item' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => { setPrintMode('per_item'); setPreviewIndex(0); }}
                style={{ flex: 1, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                <Layers size={13} />
                Har bir tovar alohida ({lines.length} ta chek)
              </button>
              <button
                type="button"
                className={`btn btn-sm ${printMode === 'summary' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setPrintMode('summary')}
                style={{ flex: 1, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                <FileText size={13} />
                Jamlangan bitta chek (1 ta chek)
              </button>
            </div>
          )}

          <div style={{ background: '#e2e8f0', padding: '16px', borderRadius: '10px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <ThermalReceiptPreview receipt={receipt} mode={printMode} activeIndex={previewIndex} />
          </div>

          {/* Bluetooth Termoprinterlar & Kompyuter chop etish bo'limi (huddi partiyalar sahifasi kabi) */}
          <div style={{
            fontSize: 11,
            color: 'var(--muted, #64748b)',
            background: '#f8fafc',
            border: '1.5px solid #e2e8f0',
            padding: '10px 14px',
            borderRadius: 12,
            marginTop: 14,
            marginBottom: 8
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--navy, #0f172a)', marginBottom: 3 }}>
              <Printer size={15} color="#ea580c" />
              <span>Bluetooth Termoprinterlar (Detonger & MHT-L80G):</span>
            </div>
            <div style={{ lineHeight: 1.4 }}>
              Telefonda Bluetooth yoki kompyuterda ulanib, <b>Detonger (40 mm)</b> yoki yangi <b>MHT-L80G (58 mm)</b> termoprinterida chekni chop eting:
            </div>
          </div>

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
                title="Detonger printerida chekni chop etish"
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
                title="MHT-L80G printerida 58 mm o‘lchamda chekni chop etish"
              >
                <Bluetooth size={15} />
                <span>MHT-L80G (58 mm)</span>
              </button>
            </div>

            <button
              type="button"
              className="btn btn-outline btn-block cash-real-no-print"
              style={{ padding: '9px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              onClick={handlePrint}
            >
              <QrCode size={14} />
              Kompyuter / Tizim orqali klassik chop etish
            </button>
          </div>
        </div>

        <DetongerPrintModal
          open={bluetoothModalOpen}
          onClose={() => setBluetoothModalOpen(false)}
          labels={printMode === 'summary' || lines.length <= 1 ? [receipt] : lines.map((l, idx) => ({ ...receipt, lineIndex: idx, activeLine: l }))}
          modalTitle="Tasdiqlangan savdo cheki"
          initialPrinter={preferredPrinter}
          initialLabelSize="40x30"
          onClassicPrint={() => {
            setBluetoothModalOpen(false);
            handlePrint();
          }}
          renderCustomCanvas={(item, opts) => renderThermalReceiptCanvas({
            receipt,
            mode: printMode,
            activeIndex: item.lineIndex !== undefined ? item.lineIndex : previewIndex,
            ...opts
          })}
        />

        <details style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--muted)', userSelect: 'none' }}>
            Savdo to‘liq tafsilotlari (ekran ko‘rinishi)
          </summary>
          <div className="cash-real-receipt" style={{ marginTop: 10 }}>
            <header>
              <h2>{receipt.branch_name}</h2>
              <p>
                {address(receipt.branch_address)}
                {receipt.branch_phone ? ` · ${receipt.branch_phone}` : ''}
              </p>
              <b>{receipt.sale_no}</b>
              <small>{date(receipt.sold_at)}</small>
            </header>
            <div>
              <span>Sotuvchi <b>{receipt.seller_name}</b></span>
              <span>Menejer <b>{receipt.manager_name}</b></span>
            </div>
            {receipt.lines?.map((line, i) => (
              <article key={i}>
                <span>
                  <b>{line.product_name}</b>
                  <small>{line.qr_code}</small>
                  {line.selected_components?.length > 0 && (
                    <small style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, color: 'var(--muted, #64748b)', marginTop: 2 }}>
                      Qismlar: {line.selected_components.map((c, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          {(c.image_url || c.imageUrl) && <img src={c.image_url || c.imageUrl} alt="" style={{ width: 14, height: 14, borderRadius: 2, objectFit: 'cover' }} />}
                          {c.name}{c.color ? ` (${c.color})` : ''}{i < line.selected_components.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                    </small>
                  )}
                </span>
                <strong><DualPrice value={Number(line.line_total || 0)} rate={rate} /></strong>
              </article>
            ))}
            <dl>
              <div>
                <dt>Subtotal</dt>
                <dd><DualPrice value={Number(receipt.subtotal || 0)} rate={rate} /></dd>
              </div>
              <div>
                <dt>Chegirma</dt>
                <dd><DualPrice value={Number(receipt.discount || 0)} rate={rate} /></dd>
              </div>
              <div>
                <dt>Soliq</dt>
                <dd><DualPrice value={Number(receipt.tax || 0)} rate={rate} /></dd>
              </div>
              <div>
                <dt>Jami</dt>
                <dd><DualPrice value={Number(receipt.total || 0)} rate={rate} /></dd>
              </div>
            </dl>
            <h3>To'lovlar</h3>
            {receipt.payments?.map((p, i) => (
              <p key={i}>
                {p.method_name}: <b><DualPrice value={Number(p.amount || 0)} rate={rate} /></b>
              </p>
            ))}
          </div>
        </details>
      </div>
    </Modal>
  );
}

function CourierCashTab({ branchId, toast }) {
  const rate = useExchangeRate();
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [rejectRow, setRejectRow] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState('');

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const result = await listBranchCourierCash(branchId);
      setData(result || { items: [], total: 0 });
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId]);

  const accept = async id => {
    setBusy(id);
    setError('');
    try {
      await acceptCourierCash(id);
      toast?.('Kuryer puli qabul qilindi');
      await load();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (!rejectRow) return;
    setRejectBusy(true);
    setRejectError('');
    try {
      await rejectCourierDelivery(rejectRow.id, rejectReason.trim() || null);
      toast?.('Tovar qaytarildi deb belgilandi. Tovar omborga qaytarildi va sotilmagan deb hisoblandi.');
      setRejectRow(null);
      setRejectReason('');
      await load();
    } catch (e) {
      setRejectError(msg(e));
    } finally {
      setRejectBusy(false);
    }
  };

  return (
    <>
      <div className="cash-real-summary">
        <article>
          <WalletCards />
          <span>
            <small>Kuryerlar berishi kerak</small>
            <b>{data.items?.length || 0} ta buyurtma</b>
            <strong><DualPrice value={Number(data.total || 0)} rate={rate} /></strong>
          </span>
        </article>
      </div>
      {loading ? (
        <State text="Kuryer pullari yuklanmoqda…" />
      ) : error ? (
        <State error text={error} retry={load} />
      ) : !data.items?.length ? (
        <Empty title="Kuryer pullari yo'q" text="Kuryerlardan topshirilmagan naqd pul mavjud emas." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Buyurtma</th>
                <th>Kuryer</th>
                <th>Mijoz</th>
                <th>Summa</th>
                <th>Sana</th>
                <th>Amal</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(row => (
                <tr key={row.id}>
                  <td><b>{row.order_no}</b></td>
                  <td>
                    <b>{row.courier_name}</b>
                    <small className="muted">{row.courier_phone}</small>
                  </td>
                  <td>
                    {row.customer_name}
                    <small className="muted">{row.customer_phone}</small>
                  </td>
                  <td>
                    <b><DualPrice value={Number(row.amount)} rate={rate} /></b>
                  </td>
                  <td>{new Date(row.created_at).toLocaleString('uz-UZ')}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '6px 14px', fontSize: 12 }}
                        disabled={busy === row.id || rejectBusy}
                        onClick={() => accept(row.id)}
                        title="Mijoz pulni kuryerdan bergan bo‘lsa, kassaga kirim qilish"
                      >
                        {busy === row.id ? 'Qabul…' : 'Pulni qabul qildim'}
                      </button>
                      <button
                        className="btn btn-outline"
                        style={{ padding: '6px 12px', fontSize: 12, borderColor: '#fca5a5', color: '#b91c1c' }}
                        disabled={busy === row.id || rejectBusy}
                        onClick={() => {
                          setRejectError('');
                          setRejectReason('');
                          setRejectRow(row);
                        }}
                        title="Mijoz tovardan voz kechgan bo‘lsa, bekor qilish va tovarni omborga qaytarish"
                      >
                        Dostavka qaytdi
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Rejection / Returned Goods Confirmation Modal */}
      {rejectRow && (
        <Modal
          open={Boolean(rejectRow)}
          onClose={() => !rejectBusy && setRejectRow(null)}
          title="Dostavka qaytdi / Tovarni bekor qilish"
        >
          <div style={{ padding: '4px 0' }}>
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 14 }}>
              <p style={{ margin: '0 0 6px 0', fontWeight: 700, color: '#92400e', fontSize: 14 }}>
                Diqqat: Ushbu amal tovar sotilishini bekor qiladi!
              </p>
              <p style={{ margin: 0, fontSize: 13, color: '#78350f' }}>
                Agar mijozga tovar yoqmagan yoki yetkazib berish boshqa sabab bilan qaytgan bo‘lsa, tovar qaytganini tasdiqlang.
              </p>
            </div>

            <div style={{ display: 'grid', gap: 8, fontSize: 13, marginBottom: 16, background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
              <div className="between">
                <span className="muted">Buyurtma:</span>
                <b>{rejectRow.order_no}</b>
              </div>
              <div className="between">
                <span className="muted">Kuryer:</span>
                <b>{rejectRow.courier_name} <span className="muted">({rejectRow.courier_phone})</span></b>
              </div>
              <div className="between">
                <span className="muted">Mijoz:</span>
                <b>{rejectRow.customer_name} <span className="muted">({rejectRow.customer_phone})</span></b>
              </div>
              <div className="between">
                <span className="muted">Summasi:</span>
                <strong style={{ color: 'var(--orange-dark)' }}>
                  <DualPrice value={Number(rejectRow.amount)} rate={rate} />
                </strong>
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14, background: '#f1f5f9', padding: '10px 14px', borderRadius: 6 }}>
              <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                <li>Tovar <b>sotilmagan</b> deb belgilanadi va uning soni ombor qoldig‘iga qaytariladi.</li>
                <li>Kassaga hech qanday savdo puli kirim qilinmaydi.</li>
                <li>Kuryerdan ushbu naqd pulni topshirish talabi bekor qilinadi.</li>
              </ul>
            </div>

            <label className="field" style={{ marginBottom: 16 }}>
              <span className="label">Qaytarilish sababi (ixtiyoriy)</span>
              <input
                className="input"
                placeholder="Masalan: Tovar yoqmadi, mijoz rad etdi"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                autoFocus
              />
            </label>

            {rejectError && <div className="cash-real-inline-error" style={{ marginBottom: 12 }}>{rejectError}</div>}

            <div className="between" style={{ gap: 10 }}>
              <button
                type="button"
                className="btn btn-outline"
                disabled={rejectBusy}
                onClick={() => setRejectRow(null)}
              >
                Orqaga
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: '#dc2626', borderColor: '#dc2626' }}
                disabled={rejectBusy}
                onClick={handleReject}
              >
                {rejectBusy ? 'Bekor qilinmoqda…' : 'Tovar qaytdi (Bekor qilish)'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ReturnsCashTab({ branchId, toast }) {
  const rate = useExchangeRate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(null);
  const [rejectReturn, setRejectReturn] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const all = await listSaleReturns({ branchId });
      setRows(all || []);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [branchId]);

  const requestedRows = rows.filter(r => r.status === 'requested');
  const otherRows = rows.filter(r => r.status !== 'requested').slice(0, 10);

  const handleCompleteRefund = async () => {
    if (!confirmReturn) return;
    setActionBusy(true);
    try {
      const res = await completePosCashRefund({ returnId: confirmReturn.id });
      toast?.(res.message || 'Naqd pul qaytarildi va tovar qoldiqqa olindi!');
      setConfirmReturn(null);
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRejectReturn = async () => {
    if (!rejectReturn) return;
    if (!rejectReason.trim()) {
      toast?.('Rad etish sababini kiriting!');
      return;
    }
    setActionBusy(true);
    try {
      await cancelSaleReturn(rejectReturn.id, rejectReason.trim());
      toast?.('Qaytarish so‘rovi rad etildi');
      setRejectReturn(null);
      setRejectReason('');
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="returns-cash-tab" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="between" style={{ background: '#f8fafc', padding: '14px 18px', borderRadius: 12, border: '1px solid var(--line)' }}>
        <div>
          <b style={{ fontSize: 15, color: 'var(--navy)' }}>Kassada naqd pul qaytarish so‘rovlari</b>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
            Sotuvchilar tomonidan mijozga naqd pul qaytarish uchun yuborilgan so‘rovlar.
            Kassa pulni qaytargach, tovar do‘kon balansiga qaytadi va asl xarid kunidagi savdo aylanmasidan shu pul chiqariladi.
          </p>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
          <RotateCcw size={14} /> Yangilash
        </button>
      </div>

      {loading ? (
        <div className="cash-real-state"><p>Qaytarish so‘rovlari yuklanmoqda…</p></div>
      ) : error ? (
        <div className="cash-real-state"><AlertTriangle /><p>{error}</p></div>
      ) : (
        <>
          {requestedRows.length === 0 ? (
            <Empty
              title="Kutilayotgan qaytarishlar yo‘q"
              text="Hozirda sotuvchilardan kassaga naqd pul qaytarish bo‘yicha yangi so‘rov yo‘q."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {requestedRows.map(row => {
                const line = (row.sale_return_lines || [])[0];
                return (
                  <div
                    key={row.id}
                    className="card"
                    style={{
                      padding: 18,
                      border: '2px solid #fecdd3',
                      background: '#fff',
                      borderRadius: 14,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12
                    }}
                  >
                    <div className="between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ background: '#fee2e2', color: '#dc2626', padding: '4px 8px', borderRadius: 6, fontWeight: 700, fontSize: 12 }}>
                          {row.return_no}
                        </span>
                        <Status type="orange">Kassadan naqd pul kutilmoqda</Status>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{date(row.created_at)}</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Qaytarish sababi:</span>
                        <b style={{ fontSize: 14, color: 'var(--navy)' }}>{row.reason || 'Sabab ko‘rsatilmagan'}</b>
                        {line && (
                          <small style={{ color: 'var(--muted)', marginTop: 2 }}>
                            QR kod / dona: <code>{line.unit_id}</code>
                          </small>
                        )}
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <small style={{ fontSize: 12, color: 'var(--muted)', display: 'block' }}>Mijozga qaytariladigan naqd pul:</small>
                        <b style={{ fontSize: 22, color: '#dc2626', fontWeight: 800 }}>
                          <DualPrice value={Number(row.refund_amount || 0)} rate={rate} />
                        </b>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
                      <button
                        type="button"
                        className="btn btn-outline"
                        disabled={actionBusy}
                        onClick={() => { setRejectReturn(row); setRejectReason(''); }}
                      >
                        Rad etish
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ background: '#16a34a', borderColor: '#16a34a', fontWeight: 700 }}
                        disabled={actionBusy}
                        onClick={() => setConfirmReturn(row)}
                      >
                        <Check size={16} /> Naqd pulni qaytarish va yakunlash
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {otherRows.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h4 style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 10 }}>Yaqinda yakunlangan qaytarishlar</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {otherRows.map(row => (
                  <div
                    key={row.id}
                    style={{
                      padding: '10px 14px',
                      background: 'var(--surface-2, #f8fafc)',
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 13
                    }}
                  >
                    <div>
                      <b>{row.return_no}</b> · <Status type={row.status === 'completed' ? 'green' : 'gray'}>{row.status}</Status>
                      <small style={{ display: 'block', color: 'var(--muted)' }}>{row.reason}</small>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <b><DualPrice value={Number(row.refund_amount || 0)} rate={rate} /></b>
                      <small style={{ display: 'block', color: 'var(--muted)' }}>{date(row.completed_at || row.created_at)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Confirm Refund Modal */}
      {confirmReturn && (
        <Modal
          open={Boolean(confirmReturn)}
          onClose={() => !actionBusy && setConfirmReturn(null)}
          title="Naqd pulni qaytarishni tasdiqlash"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--navy)' }}>
              Haqiqatan ham mijozga <b>#{confirmReturn.return_no}</b> so‘rovi bo‘yicha quyidagi summani naqd qaytarmoqchimisiz?
            </p>

            <div style={{ padding: '14px 18px', background: '#fef2f2', border: '1px solid #fecdd3', borderRadius: 10, textAlign: 'center' }}>
              <small style={{ color: '#991b1b', fontSize: 12 }}>Kassadan beriladigan naqd pul:</small>
              <h2 style={{ margin: '4px 0 0', color: '#b91c1c', fontSize: 26, fontWeight: 800 }}>
                {formatDualMoney(Number(confirmReturn.refund_amount || 0), rate)}
              </h2>
            </div>

            <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12.5, color: '#166534' }}>
              <b>Diqqat:</b> Pul qaytarilishi bilan tovar avtomatik do‘kon balansiga (+1 dona) qaytadi va <b>xaridor tovarni olgan kunning savdo aylanmasidan shu pul chiqariladi</b> (aylanma kamayadi).
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-outline"
                disabled={actionBusy}
                onClick={() => setConfirmReturn(null)}
              >
                Bekor qilish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: '#16a34a', borderColor: '#16a34a', fontWeight: 700 }}
                disabled={actionBusy}
                onClick={handleCompleteRefund}
              >
                {actionBusy ? 'Yakunlanmoqda…' : 'Ha, pulni qaytarish'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reject Refund Modal */}
      {rejectReturn && (
        <Modal
          open={Boolean(rejectReturn)}
          onClose={() => !actionBusy && setRejectReturn(null)}
          title="Qaytarishni rad etish"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--navy)' }}>
              <b>#{rejectReturn.return_no}</b> so‘rovini rad etish sababini ko‘rsating:
            </p>

            <textarea
              className="textarea"
              rows={3}
              placeholder="Masalan: Tovar shikastlangan, chek taqdim etilmadi va h.k."
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              autoFocus
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="btn btn-outline"
                disabled={actionBusy}
                onClick={() => setRejectReturn(null)}
              >
                Orqaga
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: '#dc2626', borderColor: '#dc2626' }}
                disabled={actionBusy || !rejectReason.trim()}
                onClick={handleRejectReturn}
              >
                {actionBusy ? 'Rad etilmoqda…' : 'Rad etish'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

