import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Home,
  MapPin,
  Navigation,
  Package,
  Phone,
  RefreshCw,
  Route,
  Truck,
  User,
  WalletCards,
  X,
  XCircle,
  QrCode,
  DollarSign,
  AlertTriangle,
  RotateCcw,
  Calendar,
  Filter
} from 'lucide-react';
import { AccountMenu, Status, ThemeToggle, Toast, formatMoney, useAuth } from '@texnobazar/ui';
import {
  formatUzDate,
  getUzMonthName,
  listCourierPosDeliveries,
  courierClaimPosDeliveries,
  courierUnclaimPosDelivery,
  courierCompletePosDelivery,
  recordCourierGpsLocation,
  listNotifications,
  markNotificationsRead,
  subscribeNotifications,
  listCourierPendingCash
} from '@texnobazar/data';
import { CourierQrModal } from './CourierQrModal.jsx';
import { CourierMapView } from './CourierMapView.jsx';

const errorText = (error, fallback) => String(error?.message || fallback);

function getProductStorefrontUrl(item) {
  const origin = window.location.origin.includes('localhost')
    ? 'http://localhost:5173'
    : 'https://texnobazar-storefront.netlify.app';
  const param = item.product_slug || item.slug || item.product_id;
  return `${origin}/product/${param}`;
}

// Calculate distance between two GPS coordinates in meters (Haversine formula)
function calculateGpsDistanceMeters(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371000 * c;
}

function getLocalDateString(d = new Date()) {
  if (!d) return '';
  const dateObj = d instanceof Date ? d : new Date(d);
  if (isNaN(dateObj.getTime())) return '';
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDeliveryDateString(del) {
  if (!del) return '';
  if (del.created_at) {
    const s = getLocalDateString(del.created_at);
    if (s) return s;
  }
  if (typeof del.delivery_no === 'string') {
    const match = del.delivery_no.match(/DOS-(\d{4})(\d{2})(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }
  return '';
}

export default function App() {
  const { profile } = useAuth();
  const [navPage, setNavPage] = useState('home'); // 'home', 'map', 'stats', 'profile'
  const [currentTab, setCurrentTab] = useState('available'); // 'available', 'my_active', 'delivered'
  const [availableDateFilter, setAvailableDateFilter] = useState('today'); // 'today', 'yesterday', 'all', 'custom'
  const [customDate, setCustomDate] = useState(() => getLocalDateString(new Date()));
  const [deliveries, setDeliveries] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busyId, setBusyId] = useState(null);

  // Selection for bulk claiming
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Date constants & filter counters
  const todayStr = useMemo(() => getLocalDateString(new Date()), []);
  const yesterdayStr = useMemo(() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return getLocalDateString(y);
  }, []);

  const countsByFilter = useMemo(() => {
    let today = 0;
    let yesterday = 0;
    let custom = 0;

    for (const del of deliveries) {
      const dStr = getDeliveryDateString(del);
      if (dStr === todayStr) today++;
      if (dStr === yesterdayStr) yesterday++;
      if (customDate && dStr === customDate) custom++;
    }

    return {
      today,
      yesterday,
      custom,
      all: deliveries.length
    };
  }, [deliveries, todayStr, yesterdayStr, customDate]);

  // Filtered deliveries for current tab
  const displayedDeliveries = useMemo(() => {
    if (currentTab !== 'available') {
      return deliveries;
    }
    if (availableDateFilter === 'today') {
      return deliveries.filter(d => getDeliveryDateString(d) === todayStr);
    }
    if (availableDateFilter === 'yesterday') {
      return deliveries.filter(d => getDeliveryDateString(d) === yesterdayStr);
    }
    if (availableDateFilter === 'custom') {
      if (!customDate) return deliveries;
      return deliveries.filter(d => getDeliveryDateString(d) === customDate);
    }
    return deliveries; // 'all'
  }, [deliveries, currentTab, availableDateFilter, todayStr, yesterdayStr, customDate]);

  // Item checkboxes for delivery checklist: { [deliveryId_itemIndex]: boolean }
  const [checkedItems, setCheckedItems] = useState({});

  // QR Modal State
  const [qrModalDelivery, setQrModalDelivery] = useState(null);

  // GPS State
  const [gpsStatus, setGpsStatus] = useState({
    available: true,
    enabled: false,
    coords: null,
    error: null
  });

  // Watch GPS Geolocation
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsStatus({
        available: false,
        enabled: false,
        coords: null,
        error: 'Qurilma geolokatsiyani qo‘llamaydi.'
      });
      return;
    }

    let lastSentCoords = null;
    let lastSentTime = 0;

    const MIN_DISTANCE_METERS = 25; // Faqat kamida 25 metr siljiganda yuborish
    const MIN_INTERVAL_MS = 15000;  // Harakatlanayotganda kamida 15 soniya interval
    const STATIONARY_HEARTBEAT_MS = 5 * 60 * 1000; // Joyida turganda faqat 5 daqiqada 1 marta

    const sendGps = (pos) => {
      const coords = pos.coords;

      // Xaritada ravon va joriy aks etishi uchun lokal UI holatini darhol yangilash
      setGpsStatus({
        available: true,
        enabled: true,
        coords: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          speed: coords.speed,
          heading: coords.heading
        },
        error: null
      });

      const now = Date.now();
      let distanceMoved = 0;

      if (lastSentCoords) {
        distanceMoved = calculateGpsDistanceMeters(
          lastSentCoords.latitude,
          lastSentCoords.longitude,
          coords.latitude,
          coords.longitude
        );
      }

      const isFirstSend = !lastSentCoords;
      const isMovedSignificant = distanceMoved >= MIN_DISTANCE_METERS && (now - lastSentTime >= MIN_INTERVAL_MS);
      const isStationaryHeartbeat = (now - lastSentTime >= STATIONARY_HEARTBEAT_MS);

      // Kuryer joyida to‘xtab turganda (< 25m) va 5 daqiqa o‘tmagan bo‘lsa bazaga ortiqcha yuborilmaydi!
      if (isFirstSend || isMovedSignificant || isStationaryHeartbeat) {
        lastSentTime = now;
        lastSentCoords = { latitude: coords.latitude, longitude: coords.longitude };
        recordCourierGpsLocation({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          speed: coords.speed,
          heading: coords.heading
        }).catch(() => {});
      }
    };

    const handleError = (err) => {
      console.warn('Geolocation warning:', err.message);
      setGpsStatus(prev => ({
        ...prev,
        enabled: false,
        error: 'GPS o‘chiq yoki ruxsat berilmadi. Buyurtmalarni yetkazish uchun iltimos geolokatsiyani yoqing.'
      }));
    };

    // Initial check
    navigator.geolocation.getCurrentPosition(sendGps, handleError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 10000
    });

    // Continuous watch
    const watchId = navigator.geolocation.watchPosition(sendGps, handleError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 15000
    });

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Request GPS Permissions
  const requestGps = () => {
    if (!navigator.geolocation) {
      alert('Brauzer geolokatsiyani qo‘llamaydi');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsStatus({
          available: true,
          enabled: true,
          coords: pos.coords,
          error: null
        });
        recordCourierGpsLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }).catch(() => {});
        setToast('GPS muvaffaqiyatli yoqildi!');
      },
      (err) => {
        alert('Geolokatsiyaga ruxsat berilmadi yoki telefoningizda GPS o‘chiq. Iltimos, sozlamalarda GPS ni yoqing.');
      },
      { enableHighAccuracy: true }
    );
  };

  // Load POS Deliveries for Current Tab
  const loadDeliveries = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await listCourierPosDeliveries({ tab: currentTab });
      setDeliveries(res?.items || []);
      setSummary(res?.summary || {});
    } catch (e) {
      setError(errorText(e, 'Dostavkalar yuklanmadi.'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentTab]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  // Smart Auto-refresh (faqat tab ko'rinib turganda har 20s va focusda darhol)
  useEffect(() => {
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        loadDeliveries(true);
      }
    };
    const timer = setInterval(tick, 20000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadDeliveries]);

  // Clear bulk selection on tab or date filter switch
  useEffect(() => {
    setSelectedIds(new Set());
  }, [currentTab, availableDateFilter, customDate]);

  // Claim single or bulk deliveries
  const handleClaimDeliveries = async (idsToClaim) => {
    if (!idsToClaim.length) return;
    setLoading(true);
    try {
      await courierClaimPosDeliveries(idsToClaim);
      setToast(`${idsToClaim.length} ta buyurtma yetkazishga qabul qilindi!`);
      setSelectedIds(new Set());
      setCurrentTab('my_active');
    } catch (e) {
      setError(errorText(e, 'Buyurtmalarni qabul qilib bo‘lmadi.'));
    } finally {
      setLoading(false);
    }
  };

  // Unclaim a delivery (release back to available)
  const handleUnclaim = async (delivery) => {
    if (!window.confirm(`${delivery.delivery_no} raqamli buyurtmani boshqa kuryer olishi uchun ro‘yxatdan qaytarmoqchimisiz?`)) {
      return;
    }
    setBusyId(delivery.id);
    try {
      await courierUnclaimPosDelivery(delivery.id);
      setToast('Buyurtma ro‘yxatdan chiqarildi va mavjud buyurtmalarga qaytarildi.');
      await loadDeliveries(true);
    } catch (e) {
      setError(errorText(e, 'Buyurtmani qaytarib bo‘lmadi.'));
    } finally {
      setBusyId(null);
    }
  };

  // Complete a delivery ("Yetkazdim")
  const handleCompleteDelivery = async (delivery) => {
    const isCod = delivery.payment_type === 'cod' || Number(delivery.cod_amount) > 0;
    const msgConfirm = isCod
      ? `Buyurtma muvaffaqiyatli yetkazildi deb belgilansinmi?\n\n💵 Mijozdan olingan summa: ${new Intl.NumberFormat('uz-UZ').format(delivery.cod_amount)} so'm. Bu pulni do'konga topshirishni unutmang!`
      : 'Buyurtma muvaffaqiyatli yetkazildi deb tasdiqlaysizmi?';

    if (!window.confirm(msgConfirm)) return;

    setBusyId(delivery.id);
    try {
      await courierCompletePosDelivery({ deliveryId: delivery.id });
      setToast('Buyurtma yetkazildi deb belgilandi!');
      await loadDeliveries(true);
    } catch (e) {
      setError(errorText(e, 'Holat yangilanmadi.'));
    } finally {
      setBusyId(null);
    }
  };

  // Toggle item checkbox
  const toggleItemCheck = (deliveryId, itemIdx) => {
    const key = `${deliveryId}_${itemIdx}`;
    setCheckedItems(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  // Callback from QR scanner modal when verified
  const handleItemVerified = (matchedCode, matchedProductId) => {
    if (!qrModalDelivery) return;
    const items = qrModalDelivery.items || [];
    let checkedOne = false;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const key = `${qrModalDelivery.id}_${idx}`;
      if (!checkedItems[key]) {
        if (
          (matchedProductId && it.product_id === matchedProductId) ||
          it.sku === matchedCode ||
          it.product_name === matchedCode ||
          it.qr_code === matchedCode ||
          it.batch_code === matchedCode
        ) {
          setCheckedItems(prev => ({ ...prev, [key]: true }));
          checkedOne = true;
          break;
        }
      }
    }
    if (!checkedOne) {
      items.forEach((it, idx) => {
        if (
          (matchedProductId && it.product_id === matchedProductId) ||
          it.sku === matchedCode ||
          it.product_name === matchedCode ||
          it.qr_code === matchedCode ||
          it.batch_code === matchedCode
        ) {
          setCheckedItems(prev => ({ ...prev, [`${qrModalDelivery.id}_${idx}`]: true }));
        }
      });
    }
    setToast('Tovar muvaffaqiyatli tasdiqlandi!');
  };

  const toggleSelectCard = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const currentList = currentTab === 'available' ? displayedDeliveries : deliveries;
    const allSelected = currentList.length > 0 && currentList.every(d => selectedIds.has(d.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(currentList.map(d => d.id)));
    }
  };

  return (
    <div className="courier-shell">
      <div className="courier">
        {/* Header */}
        <header>
          <div>
            <span>{formatUzDate(new Date(), { weekday: 'long', day: true, month: 'long', year: true })}</span>
            <b>Salom, {profile?.full_name?.split(' ')[0] || 'Kuryer'}!</b>
          </div>

          {gpsStatus.enabled ? (
            <div className="gps-active-badge">
              <span className="gps-active-dot" />
              GPS faol
            </div>
          ) : (
            <button
              type="button"
              onClick={requestGps}
              className="gps-enable-btn"
              style={{ fontSize: 10.5, padding: '3px 8px' }}
            >
              GPS ni yoqish
            </button>
          )}

          <div className="courier-brand">
            <i>T</i>
          </div>
          <ThemeToggle />
          <NotificationCenter profileId={profile?.id} />
          <AccountMenu compact />
        </header>

        {/* Main Content */}
        <main>
          {/* GPS Warning Banner if disabled */}
          {!gpsStatus.enabled && (
            <div className="gps-alert-bar">
              <AlertCircle size={22} className="gps-alert-icon" />
              <div className="gps-alert-text">
                <b>GPS yoqilmagan yoki ruxsat berilmagan!</b>
                <span>
                  {gpsStatus.error || 'Buyurtmalarni yetkazish, yo‘l masofasini hisoblash va xaritada ko‘rish uchun GPS ni yoqing.'}
                </span>
              </div>
              <button type="button" onClick={requestGps} className="gps-enable-btn">
                Yoqish
              </button>
            </div>
          )}

          {error && (
            <div className="courier-error">
              <AlertCircle />
              <span>{error}</span>
              <button onClick={() => loadDeliveries()}>Qayta urinish</button>
            </div>
          )}

          {/* PAGE: HOME / DELIVERIES */}
          {navPage === 'home' && (
            <>
              {/* Total Cash to Collect Hero Banner */}
              <section className="courier-cod-hero">
                <div>
                  <small>Mijozlardan yig‘ilishi kerak bo‘lgan jami naqd pul</small>
                  <b>{formatMoney(Number(summary.total_cash_to_collect || 0))}</b>
                  <span style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginTop: 4 }}>
                    Mening {summary.my_active_count || 0} ta faol yetkazishlarim bo‘yicha
                  </span>
                </div>
                <div className="courier-cod-hero-icon">
                  <DollarSign size={24} />
                </div>
              </section>

              {/* Courier Delivery Section Tabs */}
              <div className="courier-tabs">
                <button
                  type="button"
                  className={`courier-tab-btn ${currentTab === 'available' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('available')}
                >
                  <Package size={15} />
                  Mavjud buyurtmalar
                  <span
                    className="courier-tab-count"
                    title={`Bugun: ${countsByFilter.today} ta, Jami: ${deliveries.length} ta`}
                  >
                    {availableDateFilter === 'today' ? countsByFilter.today : (countsByFilter[availableDateFilter] ?? deliveries.length)}
                  </span>
                </button>

                <button
                  type="button"
                  className={`courier-tab-btn ${currentTab === 'my_active' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('my_active')}
                >
                  <Truck size={15} />
                  Mening buyurtmalarim
                  <span className="courier-tab-count">{summary.my_active_count || 0}</span>
                </button>

                <button
                  type="button"
                  className={`courier-tab-btn ${currentTab === 'delivered' ? 'active' : ''}`}
                  onClick={() => setCurrentTab('delivered')}
                >
                  <CheckCircle2 size={15} />
                  Yetkazilganlar
                  <span className="courier-tab-count">{summary.delivered_count || 0}</span>
                </button>
              </div>

              {/* Date Filter Bar for Available Deliveries */}
              {currentTab === 'available' && (
                <div className="courier-filter-wrapper">
                  <div className="courier-filter-header">
                    <div className="courier-filter-title">
                      <Filter size={13} />
                      <span>Sana bo‘yicha ko‘rish:</span>
                    </div>
                    {availableDateFilter !== 'all' && (
                      <button
                        type="button"
                        className="courier-filter-reset-btn"
                        onClick={() => setAvailableDateFilter('all')}
                      >
                        Barchasini ko‘rish ({deliveries.length})
                      </button>
                    )}
                  </div>

                  <div className="courier-filter-pills">
                    {/* Bugun (Default) */}
                    <button
                      type="button"
                      className={`courier-filter-pill ${availableDateFilter === 'today' ? 'active' : ''}`}
                      onClick={() => setAvailableDateFilter('today')}
                    >
                      <span className="pill-dot" />
                      <span>Bugun</span>
                      <span className="pill-badge">{countsByFilter.today}</span>
                    </button>

                    {/* Kecha */}
                    <button
                      type="button"
                      className={`courier-filter-pill ${availableDateFilter === 'yesterday' ? 'active' : ''}`}
                      onClick={() => setAvailableDateFilter('yesterday')}
                    >
                      <span>Kecha</span>
                      <span className="pill-badge">{countsByFilter.yesterday}</span>
                    </button>

                    {/* Barchasi */}
                    <button
                      type="button"
                      className={`courier-filter-pill ${availableDateFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setAvailableDateFilter('all')}
                    >
                      <span>Barchasi</span>
                      <span className="pill-badge">{deliveries.length}</span>
                    </button>

                    {/* Boshqa sana (Custom date picker) */}
                    <label className={`courier-filter-pill date-picker-pill ${availableDateFilter === 'custom' ? 'active' : ''}`}>
                      <Calendar size={13} />
                      <span>{availableDateFilter === 'custom' && customDate ? customDate : 'Boshqa sana'}</span>
                      {availableDateFilter === 'custom' && (
                        <span className="pill-badge">{countsByFilter.custom}</span>
                      )}
                      <input
                        type="date"
                        className="courier-hidden-date-input"
                        value={customDate}
                        max={todayStr}
                        onChange={(e) => {
                          if (e.target.value) {
                            setCustomDate(e.target.value);
                            setAvailableDateFilter('custom');
                          }
                        }}
                      />
                    </label>
                  </div>

                  {/* Context Hint */}
                  {availableDateFilter === 'today' && countsByFilter.today > 0 && (
                    <div className="courier-filter-hint">
                      ℹ️ <b>Bugun yaratilgan faol buyurtmalar</b> ({countsByFilter.today} ta).
                      {deliveries.length > countsByFilter.today && (
                        <span> Avvalgi kunlardan qolgan yana {deliveries.length - countsByFilter.today} ta olinmagan buyurtma bor.</span>
                      )}
                    </div>
                  )}
                  {availableDateFilter === 'yesterday' && (
                    <div className="courier-filter-hint warning">
                      📅 <b>Kechagi ({yesterdayStr}) kundan qolgan buyurtmalar</b> ({countsByFilter.yesterday} ta hali kuryerlar tomonidan olinmagan).
                    </div>
                  )}
                  {availableDateFilter === 'custom' && (
                    <div className="courier-filter-hint">
                      📅 <b>{customDate} sanasidagi buyurtmalar</b> ({countsByFilter.custom} ta hali kuryerlar tomonidan olinmagan).
                    </div>
                  )}
                  {availableDateFilter === 'all' && (
                    <div className="courier-filter-hint">
                      📋 <b>Barcha mavjud olinmagan buyurtmalar ko‘rsatilmoqda</b> (Jami {deliveries.length} ta).
                    </div>
                  )}
                </div>
              )}

              {/* Bulk Selection Action Bar for Available Tab */}
              {currentTab === 'available' && displayedDeliveries.length > 0 && (
                <div className="courier-batch-bar">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>
                    <input
                      type="checkbox"
                      checked={
                        displayedDeliveries.length > 0 &&
                        displayedDeliveries.every(d => selectedIds.has(d.id))
                      }
                      onChange={selectAll}
                      style={{ width: 17, height: 17, accentColor: '#ea580c' }}
                    />
                    Barchasini belgilash ({selectedIds.size}/{displayedDeliveries.length})
                  </label>

                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      className="courier-batch-claim-btn"
                      onClick={() => handleClaimDeliveries(Array.from(selectedIds))}
                    >
                      <Truck size={15} />
                      Tanlanganlarni olish ({selectedIds.size} ta)
                    </button>
                  )}
                </div>
              )}

              {/* Delivery Cards List */}
              {loading ? (
                <CourierState text="Buyurtmalar yuklanmoqda…" />
              ) : !displayedDeliveries.length ? (
                <div className="courier-empty-state-card">
                  <div className="courier-empty-state-icon">
                    <Package size={32} />
                  </div>
                  <h3>
                    {currentTab === 'available' ? (
                      availableDateFilter === 'today'
                        ? 'Bugun yaratilgan olinmagan buyurtmalar yo‘q'
                        : availableDateFilter === 'yesterday'
                        ? 'Kechagi kunda qolgan olinmagan buyurtmalar yo‘q'
                        : availableDateFilter === 'custom'
                        ? `${customDate} sanasida olinmagan buyurtmalar yo‘q`
                        : 'Hozircha olinishi mumkin bo‘lgan bo‘sh dostavkalar yo‘q'
                    ) : currentTab === 'my_active' ? (
                      'Sizda faol dostavkalar yo‘q'
                    ) : (
                      'Hozircha yetkazilgan buyurtmalar tarixi yo‘q'
                    )}
                  </h3>
                  <p>
                    {currentTab === 'available' ? (
                      availableDateFilter === 'today' ? (
                        deliveries.length > 0 ? (
                          <>Avvalgi kunlardan qolgan <b>{deliveries.length} ta</b> hali olinmagan buyurtma mavjud. Ularni ko‘rish uchun quyidagi tugmalardan birini tanlashingiz mumkin:</>
                        ) : (
                          'Kassir yoki menejer yangi yetkazib berish buyurtmasi kiritganda u avtomatik tarzda bu yerda paydo bo‘ladi.'
                        )
                      ) : (
                        'Boshqa sana yoki barcha mavjud buyurtmalarni tanlab ko‘rishingiz mumkin.'
                      )
                    ) : currentTab === 'my_active' ? (
                      '"Mavjud buyurtmalar" bo‘limidan o‘zingizga mos yo‘nalishdagi buyurtmalarni tanlab oling.'
                    ) : (
                      'Yetkazib berilgan buyurtmalar tarixi shu yerda aks etadi.'
                    )}
                  </p>

                  {currentTab === 'available' && deliveries.length > 0 && (
                    <div className="courier-empty-actions">
                      {availableDateFilter !== 'all' && (
                        <button
                          type="button"
                          className="courier-empty-btn primary"
                          onClick={() => setAvailableDateFilter('all')}
                        >
                          Barcha mavjud buyurtmalarni ko‘rish ({deliveries.length} ta)
                        </button>
                      )}
                      {availableDateFilter !== 'yesterday' && countsByFilter.yesterday > 0 && (
                        <button
                          type="button"
                          className="courier-empty-btn"
                          onClick={() => setAvailableDateFilter('yesterday')}
                        >
                          Kechagi buyurtmalarni ko‘rish ({countsByFilter.yesterday} ta)
                        </button>
                      )}
                      {availableDateFilter !== 'today' && (
                        <button
                          type="button"
                          className="courier-empty-btn"
                          onClick={() => setAvailableDateFilter('today')}
                        >
                          Bugungi kunga qaytish
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {displayedDeliveries.map(del => {
                    const isCod = del.payment_type === 'cod' || Number(del.cod_amount) > 0;
                    const items = Array.isArray(del.items) ? del.items : [];
                    const isSelected = selectedIds.has(del.id);

                    return (
                      <article
                        key={del.id}
                        className={`pos-delivery-card ${isSelected ? 'selected' : ''}`}
                      >
                        {/* Header: Delivery No & Status */}
                        <div className="pos-card-header">
                          <div className="pos-card-no">
                            {currentTab === 'available' && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelectCard(del.id)}
                                style={{ width: 18, height: 18, accentColor: '#ea580c', cursor: 'pointer' }}
                              />
                            )}
                            <span>{del.delivery_no}</span>
                            <Status
                              type={
                                del.delivery_status === 'delivered'
                                  ? 'green'
                                  : del.delivery_status === 'in_transit'
                                  ? 'orange'
                                  : 'blue'
                              }
                            >
                              {del.delivery_status === 'delivered'
                                ? 'Yetkazildi'
                                : del.delivery_status === 'in_transit'
                                ? 'Yo‘lda'
                                : 'Kutilmoqda'}
                            </Status>
                          </div>

                          <div className="pos-card-timestamp">
                            {(() => {
                              const dStr = getDeliveryDateString(del);
                              const isToday = dStr === todayStr;
                              const isYesterday = dStr === yesterdayStr;
                              if (!isToday && dStr) {
                                return (
                                  <span className={`pos-date-tag ${isYesterday ? 'yesterday' : 'older'}`}>
                                    {isYesterday ? 'Kecha' : formatUzDate(del.created_at, { day: true, month: 'short', year: false })}
                                  </span>
                                );
                              }
                              return null;
                            })()}
                            <span style={{ fontSize: 11, color: 'var(--muted, #64748b)' }}>
                              <Clock3 size={12} style={{ display: 'inline', marginRight: 3 }} />
                              {new Date(del.created_at).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>

                        {/* Prominent Cash Highlight Banner */}
                        <div className={`cash-highlight-banner ${isCod ? 'cod' : 'paid'}`}>
                          <div className="cash-highlight-label">
                            <DollarSign size={17} />
                            {isCod ? 'Mijozdan olinadigan naqd pul:' : 'To‘lov holati:'}
                          </div>
                          <div className="cash-highlight-amount">
                            {isCod ? formatMoney(Number(del.cod_amount)) : '✅ Oldindan to‘langan'}
                          </div>
                        </div>

                        {/* Customer & Seller Contacts */}
                        <div className="pos-card-contacts">
                          {/* Customer */}
                          <div className="contact-block">
                            <small>Mijoz</small>
                            <b>{del.customer_name}</b>
                            {del.customer_phone ? (
                              <a href={`tel:${del.customer_phone}`} className="call-btn">
                                <Phone size={12} /> {del.customer_phone}
                              </a>
                            ) : (
                              <span style={{ color: '#94a3b8' }}>Tel ko‘rsatilmagan</span>
                            )}
                          </div>

                          {/* Seller who sold the item */}
                          <div className="contact-block">
                            <small>Sotuvchi (Seller)</small>
                            <b>{del.seller_name || 'Sotuvchi'}</b>
                            {del.seller_phone ? (
                              <a href={`tel:${del.seller_phone}`} className="call-btn seller">
                                <Phone size={12} /> {del.seller_phone}
                              </a>
                            ) : (
                              <span style={{ color: '#94a3b8' }}>Tel ko‘rsatilmagan</span>
                            )}
                          </div>
                        </div>

                        {/* Address */}
                        <div className="pos-card-address">
                          <MapPin size={16} />
                          <div>
                            <span style={{ fontWeight: 700 }}>{del.delivery_address}</span>
                            {del.notes && (
                              <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', marginTop: 2 }}>
                                Izoh: {del.notes}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Items List with Storefront Links and QR Check */}
                        <div className="pos-card-items-wrap">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <small style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
                              📦 Tovarlar ({items.length} ta xarid)
                            </small>

                            {currentTab === 'my_active' && (
                              <button
                                type="button"
                                className="qr-verify-inline-btn"
                                onClick={() => setQrModalDelivery(del)}
                                title="Tovarlarni QR orqali tekshirish"
                              >
                                <QrCode size={13} color="#f97316" />
                                QR tekshirish
                              </button>
                            )}
                          </div>

                          {items.map((it, idx) => {
                            const itemKey = `${del.id}_${idx}`;
                            const isChecked = Boolean(checkedItems[itemKey]);

                            return (
                              <div key={idx} className="pos-item-row">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                                  {currentTab === 'my_active' && (
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => toggleItemCheck(del.id, idx)}
                                      className="pos-item-checkbox"
                                      title="Yetkazildi deb belgilash"
                                    />
                                  )}
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <b style={{ color: isChecked ? '#16a34a' : 'inherit', textDecoration: isChecked ? 'line-through' : 'none' }}>
                                        {it.product_name}
                                      </b>
                                      <a
                                        href={getProductStorefrontUrl(it)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="storefront-link"
                                        title="Saytda tovar kartasini ochish"
                                      >
                                        <ExternalLink size={10} />
                                        Saytda ko‘rish
                                      </a>
                                    </div>
                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                      <span>{it.quantity} dona</span>
                                      {it.batch_code && <span>Partiya: {it.batch_code}</span>}
                                      {it.qr_code && <span>QR: {it.qr_code}</span>}
                                      {it.location_type && (
                                        <span style={{
                                          fontSize: 9.5,
                                          padding: '1px 5px',
                                          borderRadius: 4,
                                          background: it.location_type === 'store' ? '#fef3c7' : '#e0f2fe',
                                          color: it.location_type === 'store' ? '#92400e' : '#0369a1',
                                          fontWeight: 700
                                        }}>
                                          {it.location_type === 'store' ? 'Do‘kondan' : 'Ombordan'}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                <strong style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                                  {formatMoney(Number(it.line_total || it.unit_price || 0))}
                                </strong>
                              </div>
                            );
                          })}
                        </div>

                        {/* Action Buttons */}
                        <div className="pos-card-actions">
                          {currentTab === 'available' && (
                            <button
                              type="button"
                              className="pos-action-btn claim"
                              onClick={() => handleClaimDeliveries([del.id])}
                              disabled={busyId === del.id}
                            >
                              <Truck size={14} />
                              Dostavkaga olish
                            </button>
                          )}

                          {currentTab === 'my_active' && (
                            <>
                              <button
                                type="button"
                                className="pos-action-btn unclaim"
                                onClick={() => handleUnclaim(del)}
                                disabled={busyId === del.id}
                                title="Boshqa kuryer olishi uchun qaytarish"
                              >
                                <RotateCcw size={13} />
                                Qaytarish
                              </button>

                              <button
                                type="button"
                                className="pos-action-btn deliver"
                                onClick={() => handleCompleteDelivery(del)}
                                disabled={busyId === del.id}
                              >
                                <CheckCircle2 size={14} />
                                {busyId === del.id ? 'Saqlanmoqda…' : 'Yetkazdim (Bajarildi)'}
                              </button>
                            </>
                          )}

                          {currentTab === 'delivered' && (
                            <span style={{ fontSize: 11.5, color: '#16a34a', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <CheckCircle2 size={14} />
                              Yetkazib berilgan
                            </span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* PAGE: MAP */}
          {navPage === 'map' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--navy,#0f172a)' }}>
                  🗺️ Yetkazish xaritasi va GPS
                </h3>
                <span style={{ fontSize: 11, color: 'var(--muted,#64748b)' }}>
                  {deliveries.filter(d => d.delivery_status !== 'delivered').length} ta faol manzil
                </span>
              </div>

              <CourierMapView
                myCoords={gpsStatus.coords}
                deliveries={deliveries}
                onGoToOrders={() => setNavPage('home')}
              />
            </div>
          )}

          {/* PAGE: STATS */}
          {navPage === 'stats' && <CourierStatsPage deliveries={deliveries} />}

          {/* PAGE: PROFILE */}
          {navPage === 'profile' && <Profile profile={profile} />}
        </main>

        {/* Bottom Navigation */}
        <nav>
          {[
            ['home', Home, 'Buyurtmalar'],
            ['map', MapPin, 'Xarita'],
            ['stats', BarChart3, 'Natijalar'],
            ['profile', User, 'Profil']
          ].map(([key, Icon, title]) => (
            <button
              key={key}
              className={navPage === key ? 'active' : ''}
              onClick={() => {
                setNavPage(key);
                if (key === 'map' && currentTab !== 'my_active') {
                  setCurrentTab('my_active');
                }
              }}
            >
              <Icon />
              <span>{title}</span>
            </button>
          ))}
        </nav>

        {/* QR Verification Modal */}
        {qrModalDelivery && (
          <CourierQrModal
            open={Boolean(qrModalDelivery)}
            onClose={() => setQrModalDelivery(null)}
            delivery={qrModalDelivery}
            onItemVerified={handleItemVerified}
          />
        )}

        <Toast message={toast} onClose={() => setToast('')} />
      </div>
    </div>
  );
}

function CourierStatsPage({ deliveries }) {
  const activeCount = deliveries.filter(d => d.delivery_status !== 'delivered').length;
  const deliveredCount = deliveries.filter(d => d.delivery_status === 'delivered').length;

  return (
    <>
      <div className="page-heading">
        <h2>Mening natijalarim</h2>
        <span>{getUzMonthName(new Date(), { withYear: true })}</span>
      </div>

      <section className="stats-hero">
        <span>Faol yetkazishlar</span>
        <b>{activeCount} ta</b>
        <small>{deliveredCount} tasi muvaffaqiyatli yetkazildi</small>
      </section>

      <div className="stats-grid">
        <div>
          <Package />
          <span>
            <b>{deliveries.length} ta</b>
            Jami buyurtmalar
          </span>
        </div>
        <div>
          <CheckCircle2 />
          <span>
            <b>{deliveredCount} ta</b>
            Yetkazildi
          </span>
        </div>
        <div>
          <Truck />
          <span>
            <b>{activeCount} ta</b>
            Yo‘lda
          </span>
        </div>
        <div>
          <Navigation />
          <span>
            <b>GPS</b>
            Real-time faol
          </span>
        </div>
      </div>
    </>
  );
}

function NotificationCenter({ profileId }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      const result = await listNotifications({ pageSize: 30 });
      setItems(result?.items || []);
      setUnread(Number(result?.unread_count || 0));
    } catch {}
    finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!profileId) return;
    return subscribeNotifications(load, () => {}, profileId);
  }, [profileId, load]);

  const markAll = async () => {
    try {
      await markNotificationsRead();
      await load();
      setTimeout(() => setOpen(false), 500);
    } catch {}
  };

  return (
    <div className="courier-notifications" ref={wrapRef} style={{ position: 'relative' }}>
      <button className="icon-btn" onClick={() => setOpen(v => !v)} aria-label="Bildirishnomalar">
        <Bell />
        {unread > 0 && <i />}
      </button>

      {open && (
        <div className="courier-notification-panel" style={{ position: 'absolute', right: -48, top: 45, zIndex: 300 }}>
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
            <div>
              <b>Bildirishnomalar</b>
              <small>{unread} ta o‘qilmagan</small>
            </div>
            {unread > 0 && (
              <button type="button" onClick={markAll} style={{ border: 0, background: 'none', color: 'var(--orange)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                Barchasini o‘qish
              </button>
            )}
          </header>
          {loading ? (
            <CourierState text="Yuklanmoqda…" compact />
          ) : !items.length ? (
            <div style={{ padding: '20px 14px', textAlign: 'center' }}>
              <Check size={20} style={{ color: '#16a34a', margin: '0 auto 6px', display: 'block' }} />
              <b>Bildirishnoma yo‘q</b>
            </div>
          ) : (
            <div>
              {items.map(it => (
                <button key={it.id} className={it.read_at ? '' : 'unread'} style={{ width: '100%', border: 0, borderBottom: '1px solid var(--line)', background: '#fff', padding: 10, textAlign: 'left', display: 'flex' }}>
                  <span style={{ flex: 1 }}>
                    <b>{it.title}</b>
                    <small style={{ color: 'var(--muted)', display: 'block' }}>{it.body}</small>
                  </span>
                  {!it.read_at && <i style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)' }} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Profile({ profile }) {
  const [cash, setCash] = useState(null);
  const [cashLoading, setCashLoading] = useState(true);

  useEffect(() => {
    setCashLoading(true);
    listCourierPendingCash()
      .then(data => setCash(data))
      .catch(() => {})
      .finally(() => setCashLoading(false));
  }, []);

  return (
    <>
      <div className="profile-hero">
        <div className="avatar">
          {(profile?.full_name || 'K').split(/\s+/).map(part => part[0]).join('').slice(0, 2)}
        </div>
        <h2>{profile?.full_name || profile?.email}</h2>
        <span>Kuryer</span>
        <Status type="green">Faol akkaunt</Status>
      </div>

      <div className="courier-cash-section card">
        <h3>
          <WalletCards /> Do‘konga topshirishim kerak bo‘lgan pullar
        </h3>
        {cashLoading ? (
          <CourierState text="Yuklanmoqda…" compact />
        ) : !cash?.items?.length ? (
          <CourierState text="Topshirish kerak bo‘lgan pul yo‘q." compact />
        ) : (
          <>
            <div className="courier-cash-total">
              <span>Jami topshirilmagan</span>
              <b>{Number(cash.total || 0).toLocaleString('uz-UZ')} so‘m</b>
            </div>
            <div className="courier-cash-list">
              {cash.items.map(item => (
                <div key={item.id} className="courier-cash-item">
                  <div>
                    <b>{item.order_no}</b>
                    <small>{item.customer_name}</small>
                  </div>
                  <strong>{Number(item.amount).toLocaleString('uz-UZ')} so‘m</strong>
                  <Status type="orange">Kutilmoqda</Status>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="profile-server card">
        <User />
        <div>
          <b>Server profili</b>
          <span>{profile?.email || 'Email ko‘rsatilmagan'}</span>
          <small>ID: {profile?.id}</small>
        </div>
      </div>
      <AccountMenu />
    </>
  );
}

function CourierState({ text, compact = false }) {
  return (
    <div className={`courier-state ${compact ? 'compact' : ''}`}>
      <Package />
      <span>{text}</span>
    </div>
  );
}
