import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  DollarSign,
  MapPin,
  Package,
  Phone,
  Printer,
  FileText,
  Search,
  Truck,
  User,
  XCircle,
  Tag,
  Check,
  X,
  ArrowLeftRight,
  Navigation,
  Calendar
} from 'lucide-react';
import {
  DualPrice,
  Empty,
  Modal,
  Status,
  useExchangeRate,
  ProductDeliveryStickersModal
} from '@texnobazar/ui';
import {
  listPosDeliveries,
  markPosDeliveriesPrinted,
  managerAcceptDeliveryCash,
  managerUpdateDeliveryStatus,
  managerCancelDelivery,
  posDeliverySwapUnit
} from '@texnobazar/data';
import { CourierLiveTrackingModal } from './CourierLiveTrackingModal.jsx';
import { DeliveryA4PrintModal } from './DeliveryA4PrintModal.jsx';

const msg = e => String(e?.message || 'Amalni bajarib bo‘lmadi.');
const formatDateTime = val => val ? new Date(val).toLocaleString('uz-UZ') : '—';

const getTodayDate = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const deliveryStatusLabels = {
  pending: 'Kutilmoqda',
  in_transit: 'Yo‘lda',
  delivered: 'Yetkazildi',
  cancelled: 'Bekor qilindi'
};

const deliveryStatusColors = {
  pending: 'blue',
  in_transit: 'orange',
  delivered: 'green',
  cancelled: 'red'
};

export default function DeliveryWorkspace({ branchId, branchName = 'TEXNOBAZAR', toast }) {
  const rate = useExchangeRate();
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [dateFilter, setDateFilter] = useState(getTodayDate());
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [result, setResult] = useState({ items: [], total: 0, summary: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  // Modals
  const [stickersPayload, setStickersPayload] = useState(null);
  const [a4PrintDeliveries, setA4PrintDeliveries] = useState(null);
  const [cancellingDelivery, setCancellingDelivery] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [trackingModalOpen, setTrackingModalOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const data = await listPosDeliveries({
        branchId,
        status: status === 'all' ? null : status,
        query: debounced,
        date: dateFilter || null,
        pageSize: 100
      });
      setResult(data || { items: [], total: 0, summary: {} });
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId, status, debounced, dateFilter]);

  // Smart Auto-refresh (faqat tab ko'rinib turganda har 25s va focusda darhol)
  useEffect(() => {
    if (!branchId) return;
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        listPosDeliveries({
          branchId,
          status: status === 'all' ? null : status,
          query: debounced,
          date: dateFilter || null,
          pageSize: 100
        }).then(data => setResult(data || { items: [], total: 0, summary: {} })).catch(() => {});
      }
    };
    const interval = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [branchId, status, debounced, dateFilter]);

  // Manager clicks "Pulni oldim" (accept courier COD cash)
  const handleAcceptCash = async (delivery) => {
    if (!window.confirm(`Kuryerdan ${new Intl.NumberFormat('uz-UZ').format(delivery.cod_amount)} so'm naqd pul qabul qilindi deb tasdiqlaysizmi? Bu summa kassa kirimiga yoziladi.`)) {
      return;
    }
    setBusyId(delivery.id);
    try {
      await managerAcceptDeliveryCash(delivery.id);
      toast?.('Pul qabul qilindi va kassa kirimiga yozildi. Dostavka bajarildi!');
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Mark delivered (for upfront paid items)
  const handleMarkDelivered = async (delivery) => {
    setBusyId(delivery.id);
    try {
      await managerUpdateDeliveryStatus({
        deliveryId: delivery.id,
        status: 'delivered'
      });
      toast?.('Dostavka muvaffaqiyatli yetkazildi deb belgilandi');
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Change status to in_transit
  const handleMarkInTransit = async (delivery) => {
    setBusyId(delivery.id);
    try {
      await managerUpdateDeliveryStatus({
        deliveryId: delivery.id,
        status: 'in_transit'
      });
      toast?.('Dostavka "Yo‘lda" holatiga o‘tkazildi');
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Cancel delivery
  const handleConfirmCancel = async () => {
    if (!cancellingDelivery || !cancelReason.trim()) return;
    setCancelBusy(true);
    try {
      await managerCancelDelivery({
        deliveryId: cancellingDelivery.id,
        reason: cancelReason.trim()
      });
      toast?.('Dostavka bekor qilindi');
      setCancellingDelivery(null);
      setCancelReason('');
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setCancelBusy(false);
    }
  };

  // Swap unit to warehouse or other unit
  const handleSwapUnit = async (delivery, item) => {
    const newQr = window.prompt(`"${item.product_name}" uchun ombordagi yangi tovar QR kodini kiriting yoki skanerlang:`);
    if (!newQr || !newQr.trim()) return;
    setBusyId(delivery.id);
    try {
      await posDeliverySwapUnit({
        deliveryId: delivery.id,
        oldQr: item.qr_code,
        newQr: newQr.trim()
      });
      toast?.('Tovar muvaffaqiyatli ombor birligiga almashtirildi!');
      await load();
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Open stickers reprint modal
  const openStickers = (delivery) => {
    const codAmt = Number(delivery.cod_amount || 0);
    const seller = delivery.seller_name || delivery.courier_display_name || '';
    setStickersPayload({
      items: (Array.isArray(delivery.items) ? delivery.items : []).map(item => ({
        ...item,
        seller_name: seller,
        sellerName: seller
      })),
      customer: {
        full_name: delivery.customer_name,
        phone: delivery.customer_phone,
        address: delivery.delivery_address,
        cod_amount: codAmt,
        seller_name: seller,
        sellerName: seller
      },
      sale: {
        sale_no: delivery.delivery_no || delivery.sale_no,
        total: delivery.total_amount,
        cod_amount: codAmt,
        payment_type: delivery.payment_type,
        payment_status: delivery.payment_status,
        created_at: delivery.created_at,
        seller_name: seller,
        sellerName: seller
      },
      seller_name: seller,
      sellerName: seller
    });
  };

  // Multi-select handlers
  const toggleSelectAll = () => {
    const allIds = (result.items || []).map(r => r.id);
    if (selectedIds.size === allIds.length && allIds.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  };

  const toggleSelect = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handlePrintA4Selected = () => {
    const list = (result.items || []).filter(r => selectedIds.has(r.id));
    if (!list.length) {
      toast?.('Chop etish uchun kamida bitta dostavka tanlang');
      return;
    }
    setA4PrintDeliveries(list);
  };

  const handlePrintA4Single = (delivery) => {
    setA4PrintDeliveries([delivery]);
  };

  const handlePrintedCallback = async (printedIds) => {
    try {
      await markPosDeliveriesPrinted(printedIds);
      toast?.(`${printedIds.length} ta dostavka muvaffaqiyatli chop etildi deb belgilandi`);
      await load();
    } catch (e) {
      console.error(e);
    }
  };

  const s = result.summary || {};

  return (
    <section className="cash-real-workspace">
      <div className="m-page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>Dostavka</h2>
          <p>Yetkazib beriladigan tovarlar, kuryer pullari va yetkazish holatlari</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setTrackingModalOpen(true)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 18px',
            fontSize: 13,
            fontWeight: 700,
            background: 'linear-gradient(135deg, #0284c7, #0369a1)',
            boxShadow: '0 4px 14px rgba(2, 132, 199, 0.3)'
          }}
        >
          <Navigation size={16} />
          Kuryerlarni kuzatish (Xarita)
        </button>
      </div>

      {/* KPI Cards */}
      <div className="cash-real-summary">
        <article>
          <Package style={{ color: '#0284c7' }} />
          <span>
            <small>Dostavkada kutilmoqda</small>
            <b>{s.pending_count || 0} ta</b>
          </span>
        </article>

        <article>
          <Truck style={{ color: '#f59e0b' }} />
          <span>
            <small>Yo‘lda</small>
            <b>{s.in_transit_count || 0} ta</b>
          </span>
        </article>

        <article style={{ borderLeft: '3px solid #ea580c' }}>
          <DollarSign style={{ color: '#ea580c' }} />
          <span>
            <small>Kuryerdan olinadigan pul</small>
            <b>{s.cod_pending_count || 0} ta buyurtma</b>
            <strong style={{ color: '#ea580c' }}>
              <DualPrice value={Number(s.cod_pending_amount || 0)} rate={rate} />
            </strong>
          </span>
        </article>

        <article>
          <CheckCircle2 style={{ color: '#16a34a' }} />
          <span>
            <small>Yetkazildi</small>
            <b>{s.delivered_count || 0} ta</b>
          </span>
        </article>
      </div>

      {/* Filter and Search Bar */}
      <div className="cash-real-toolbar" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, width: '100%' }}>
          <div className="cash-real-tabs">
            {[
              ['all', 'Barchasi'],
              ['pending', 'Kutilmoqda'],
              ['in_transit', 'Yo‘lda'],
              ['delivered', 'Yetkazildi'],
              ['cancelled', 'Bekor qilingan']
            ].map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={status === key ? 'active' : ''}
                onClick={() => setStatus(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Date Picker Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: '#f8fafc',
              padding: '5px 10px',
              borderRadius: 8,
              border: '1.5px solid var(--line, #e2e8f0)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.03)'
            }}>
              <Calendar size={15} style={{ color: '#0284c7' }} />
              <input
                type="date"
                value={dateFilter}
                onChange={e => {
                  setDateFilter(e.target.value);
                  setSelectedIds(new Set());
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--navy, #0f172a)',
                  cursor: 'pointer',
                  outline: 'none'
                }}
                title="Sana bo‘yicha ko‘rish"
              />
            </div>

            <button
              type="button"
              className={`btn btn-xs ${dateFilter === getTodayDate() ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => {
                setDateFilter(getTodayDate());
                setSelectedIds(new Set());
              }}
              style={{ fontSize: 12, padding: '6px 12px', fontWeight: 700 }}
              title="Bugungi dostavkalar"
            >
              Bugun
            </button>

            <button
              type="button"
              className={`btn btn-xs ${!dateFilter ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => {
                setDateFilter('');
                setSelectedIds(new Set());
              }}
              style={{ fontSize: 12, padding: '6px 12px', fontWeight: 700 }}
              title="Barcha kunlar bo‘yicha ko‘rish"
            >
              Barcha kunlar
            </button>
          </div>
        </div>

        {/* Deep Search Input */}
        <label style={{ width: '100%', margin: 0 }}>
          <Search />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Qidirish: Tovar raqami (QR/SKU), nomi, sotuvchi, mijoz ismi yoki telefon..."
          />
        </label>
      </div>

      {/* Multi-Select & Batch Actions Toolbar */}
      {result.items?.length > 0 && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '10px 16px',
          background: selectedIds.size > 0 ? '#f0f9ff' : '#ffffff',
          border: selectedIds.size > 0 ? '1.5px solid #7dd3fc' : '1px solid var(--line, #e2e8f0)',
          borderRadius: 10,
          boxShadow: '0 1px 4px rgba(0,0,0,0.03)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13, userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={result.items.length > 0 && selectedIds.size === result.items.length}
                onChange={toggleSelectAll}
                style={{ width: 18, height: 18, accentColor: '#0284c7', cursor: 'pointer' }}
              />
              <span>Barchasini tanlash ({result.items.length} ta)</span>
            </label>

            {selectedIds.size > 0 && (
              <span style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#0369a1',
                background: '#e0f2fe',
                padding: '2px 8px',
                borderRadius: 6
              }}>
                Tanlangan: {selectedIds.size} ta
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {selectedIds.size > 0 ? (
              <>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => setSelectedIds(new Set())}
                  style={{ fontSize: 12 }}
                >
                  Tanlovni bekor qilish
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handlePrintA4Selected}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12.5,
                    fontWeight: 700,
                    background: 'linear-gradient(135deg, #0284c7, #0369a1)',
                    boxShadow: '0 2px 8px rgba(2, 132, 199, 0.3)'
                  }}
                >
                  <Printer size={15} />
                  Tanlanganlarni A4 ga chop etish / PDF ({selectedIds.size} ta)
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setA4PrintDeliveries(result.items)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}
              >
                <Printer size={14} />
                Barcha {result.items.length} ta dostavkani A4 da chop etish
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Delivery List */}
      {loading ? (
        <div className="state-wrap"><p>Dostavkalar yuklanmoqda…</p></div>
      ) : error ? (
        <div className="state-wrap error"><p>{error}</p><button className="btn btn-outline" onClick={load}>Qayta urinish</button></div>
      ) : !result.items?.length ? (
        <Empty
          title="Dostavkalar mavjud emas"
          text="Tanlangan filtr bo‘yicha hozircha hech qanday dostavka arizasi topilmadi."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {result.items.map(row => {
            const isCod = row.payment_type === 'cod' || Number(row.cod_amount) > 0;
            const isCodPending = row.payment_status === 'pending_courier';
            const isDelivered = row.delivery_status === 'delivered';
            const isCancelled = row.delivery_status === 'cancelled';
            const items = Array.isArray(row.items) ? row.items : [];

            return (
              <div
                key={row.id}
                style={{
                  background: '#ffffff',
                  border: isCodPending ? '1.5px solid #fed7aa' : '1px solid var(--line, #e2e8f0)',
                  borderRadius: 14,
                  padding: '16px 20px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12
                }}
              >
                {/* Header row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.id)}
                      onChange={() => toggleSelect(row.id)}
                      style={{
                        width: 19,
                        height: 19,
                        accentColor: '#0284c7',
                        cursor: 'pointer',
                        borderRadius: 4
                      }}
                      title="Ushbu dostavkani tanlash"
                    />

                    <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--navy, #0f172a)' }}>
                      {row.delivery_no}
                    </span>
                    <Status type={deliveryStatusColors[row.delivery_status] || 'gray'}>
                      {deliveryStatusLabels[row.delivery_status] || row.delivery_status}
                    </Status>

                    {/* Printed Badge */}
                    {row.printed_at && (
                      <span style={{
                        background: '#f0fdf4',
                        color: '#15803d',
                        border: '1px solid #bbf7d0',
                        fontSize: 11.5,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 6,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4
                      }} title={`Chop etilgan vaqt: ${formatDateTime(row.printed_at)}`}>
                        🖨️ Chop etildi
                      </span>
                    )}

                    {isCodPending ? (
                      <span style={{
                        background: '#fff7ed',
                        color: '#c2410c',
                        border: '1px solid #ffedd5',
                        fontSize: 11.5,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 6
                      }}>
                        💵 Kuryer olishi kerak
                      </span>
                    ) : row.payment_status === 'collected' ? (
                      <span style={{
                        background: '#f0fdf4',
                        color: '#15803d',
                        border: '1px solid #dcfce7',
                        fontSize: 11.5,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 6
                      }}>
                        ✅ Pul kassaga topshirildi
                      </span>
                    ) : (
                      <span style={{
                        background: '#f0fdf4',
                        color: '#15803d',
                        border: '1px solid #dcfce7',
                        fontSize: 11.5,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 6
                      }}>
                        ✅ Kassada to‘langan
                      </span>
                    )}

                    <span style={{
                      background: row.fulfillment_source === 'store' ? '#fef3c7' : '#e0f2fe',
                      color: row.fulfillment_source === 'store' ? '#92400e' : '#0369a1',
                      border: row.fulfillment_source === 'store' ? '1px solid #fde68a' : '1px solid #bae6fd',
                      fontSize: 11.5,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 6
                    }}>
                      {row.fulfillment_source === 'store' ? '📍 Do‘kondan yetkazish' : '🏢 Ombordan yetkazish'}
                    </span>
                  </div>

                  <span style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>
                    {formatDateTime(row.created_at)}
                  </span>
                </div>

                {/* Customer & Address Info */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 12,
                  background: '#f8fafc',
                  border: '1px solid var(--line, #e2e8f0)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 13
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, fontWeight: 600 }}>MIJOZ</small>
                    <b style={{ color: 'var(--navy, #0f172a)', fontSize: 13.5 }}>{row.customer_name}</b>
                    <a
                      href={`tel:${row.customer_phone}`}
                      style={{
                        color: '#0284c7',
                        textDecoration: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 12.5,
                        fontWeight: 600
                      }}
                    >
                      <Phone size={13} /> {row.customer_phone}
                    </a>
                  </div>

                  {row.seller_name && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, fontWeight: 600 }}>SOTUVCHI</small>
                      <b style={{ color: 'var(--navy, #0f172a)', fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <User size={14} style={{ color: '#0284c7' }} />
                        {row.seller_name}
                      </b>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, fontWeight: 600 }}>YETKAZIB BERISH MANZILI</small>
                    <span style={{ color: 'var(--ink, #1e293b)', fontWeight: 600, display: 'inline-flex', alignItems: 'flex-start', gap: 4 }}>
                      <MapPin size={15} style={{ flexShrink: 0, marginTop: 2, color: '#ef4444' }} />
                      {row.delivery_address}
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, fontWeight: 600 }}>BUYURTMA SUMMASI</small>
                    <b style={{ fontSize: 15, color: isCodPending ? '#ea580c' : '#0f172a' }}>
                      <DualPrice value={Number(row.total_amount)} rate={rate} />
                    </b>
                    {isCod && (
                      <small style={{ color: isCodPending ? '#c2410c' : '#15803d', fontWeight: 600 }}>
                        {isCodPending ? `Kuryerdan kutilmoqda: ${new Intl.NumberFormat('uz-UZ').format(row.cod_amount)} so'm` : 'Pul to‘liq qabul qilingan'}
                      </small>
                    )}
                  </div>
                </div>

                {/* Items list */}
                <div>
                  <small style={{ color: 'var(--muted, #64748b)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
                    📦 Yetkaziladigan tovarlar ({items.length} ta xarid)
                  </small>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {items.map((item, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 10px',
                          background: '#ffffff',
                          border: '1px solid var(--line, #e2e8f0)',
                          borderRadius: 8,
                          fontSize: 12.5
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            width: 20,
                            height: 20,
                            borderRadius: 4,
                            background: '#f1f5f9',
                            display: 'grid',
                            placeItems: 'center',
                            fontSize: 11,
                            fontWeight: 700,
                            color: '#64748b'
                          }}>
                            {idx + 1}
                          </span>
                          <div>
                            <b>{item.product_name}</b>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#64748b', fontSize: 11, marginTop: 2, flexWrap: 'wrap' }}>
                              {item.location_name && (
                                <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: item.location_type === 'store' ? '#fef3c7' : '#dbeafe', color: item.location_type === 'store' ? '#92400e' : '#1e40af' }}>
                                  {item.location_type === 'store' ? 'Do‘kondan (namuna)' : `Ombor (${item.location_name})`}
                                </span>
                              )}
                              {item.batch_code && <span>Partiya: <b>{item.batch_code}</b></span>}
                              {item.qr_code && <span>QR: {item.qr_code}</span>}
                              {!isDelivered && !isCancelled && item.qr_code && (
                                <button
                                  type="button"
                                  className="btn btn-outline btn-xs"
                                  onClick={() => handleSwapUnit(row, item)}
                                  disabled={busyId === row.id}
                                  style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 3 }}
                                  title="Ombordagi boshqa tovar QR kodi bilan almashtirish"
                                >
                                  <ArrowLeftRight size={10} />
                                  Ombor QR ga almashtirish
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        <strong>
                          <DualPrice value={Number(item.unit_price || item.line_total)} rate={rate} />
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>

                {row.notes && (
                  <div style={{ fontSize: 12, color: 'var(--muted, #64748b)', fontStyle: 'italic', background: '#fafaf9', padding: '6px 10px', borderRadius: 6 }}>
                    Izoh: {row.notes}
                  </div>
                )}

                {/* Action Buttons */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  marginTop: 4,
                  paddingTop: 10,
                  borderTop: '1px solid var(--line, #e2e8f0)'
                }}>
                  {/* Left actions: A4 Print and Thermal Stickers */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => handlePrintA4Single(row)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        fontWeight: 700,
                        background: 'linear-gradient(135deg, #0284c7, #0369a1)',
                        boxShadow: '0 2px 6px rgba(2, 132, 199, 0.25)'
                      }}
                      title="A4 formatda 1/4 qismiga moslab chop etish yoki PDF yuklab olish"
                    >
                      <FileText size={14} />
                      A4 Chop etish / PDF
                    </button>

                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => openStickers(row)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        fontWeight: 600
                      }}
                    >
                      <Printer size={14} />
                      Stikerlar ({items.length} ta)
                    </button>
                  </div>

                  {/* Right actions: Status transitions and Cash collection */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {/* COD "Pulni oldim" button */}
                    {isCodPending && !isCancelled && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{
                          background: 'linear-gradient(135deg, #16a34a, #15803d)',
                          color: '#fff',
                          border: 'none',
                          padding: '8px 16px',
                          fontSize: 13,
                          fontWeight: 700,
                          boxShadow: '0 2px 8px rgba(22, 163, 74, 0.3)'
                        }}
                        disabled={busyId === row.id}
                        onClick={() => handleAcceptCash(row)}
                      >
                        <Check size={16} />
                        {busyId === row.id ? 'Qabul qilinmoqda…' : `Pulni oldim (${new Intl.NumberFormat('uz-UZ').format(row.cod_amount)} so‘m)`}
                      </button>
                    )}

                    {/* Upfront paid delivered button */}
                    {!isCodPending && !isDelivered && !isCancelled && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700 }}
                        disabled={busyId === row.id}
                        onClick={() => handleMarkDelivered(row)}
                      >
                        <CheckCircle2 size={16} />
                        {busyId === row.id ? 'Saqlanmoqda…' : 'Yetkazildi (Bajarildi)'}
                      </button>
                    )}

                    {/* Mark in transit if pending */}
                    {row.delivery_status === 'pending' && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={busyId === row.id}
                        onClick={() => handleMarkInTransit(row)}
                        style={{ fontSize: 12 }}
                      >
                        <Truck size={14} /> Yo‘lga chiqarish
                      </button>
                    )}

                    {/* Cancel button */}
                    {!isDelivered && !isCancelled && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{
                          background: '#fff1f2',
                          color: '#e11d48',
                          border: '1px solid #fecdd3',
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '6px 12px'
                        }}
                        disabled={busyId === row.id}
                        onClick={() => {
                          setCancellingDelivery(row);
                          setCancelReason('');
                        }}
                      >
                        <X size={14} /> Bekor qilish
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Stickers Modal */}
      {stickersPayload && (
        <ProductDeliveryStickersModal
          open={Boolean(stickersPayload)}
          onClose={() => setStickersPayload(null)}
          {...stickersPayload}
        />
      )}

      {/* Cancellation Modal */}
      <Modal
        open={Boolean(cancellingDelivery)}
        onClose={() => !cancelBusy && setCancellingDelivery(null)}
        title="Dostavkani bekor qilish"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--navy)' }}>
            Haqiqatan ham <b>{cancellingDelivery?.delivery_no}</b> raqamli dostavka arizasini bekor qilmoqchimisiz?
          </p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Bekor qilish sababi *
            <textarea
              rows="3"
              className="input"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="Masalan: Mijoz telefonni ko‘tarmadi yoki xariddan voz kechdi..."
              autoFocus
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-outline"
              disabled={cancelBusy}
              onClick={() => setCancellingDelivery(null)}
            >
              Ortga
            </button>

            <button
              type="button"
              className="btn cash-real-danger"
              disabled={cancelBusy || !cancelReason.trim()}
              onClick={handleConfirmCancel}
            >
              {cancelBusy ? 'Bekor qilinmoqda…' : 'Bekor qilish'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Courier Live Tracking Modal */}
      {trackingModalOpen && (
        <CourierLiveTrackingModal
          open={trackingModalOpen}
          onClose={() => setTrackingModalOpen(false)}
          branchId={branchId}
        />
      )}

      {/* A4 Delivery Vouchers Print / PDF Modal */}
      {a4PrintDeliveries && (
        <DeliveryA4PrintModal
          open={Boolean(a4PrintDeliveries)}
          onClose={() => setA4PrintDeliveries(null)}
          deliveries={a4PrintDeliveries}
          branchName={branchName}
          onPrinted={handlePrintedCallback}
        />
      )}
    </section>
  );
}
