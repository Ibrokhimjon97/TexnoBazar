import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Calendar,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  ExternalLink,
  Layers,
  MapPin,
  Package,
  QrCode,
  Receipt,
  RotateCcw,
  Search,
  ShieldAlert,
  ShoppingBag,
  Store,
  User,
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
  findSaleReturnUnit,
  listBranchSoldUnitsByDate,
  executePosSameProductExchange,
  createPosExchangeUpgrade,
  requestPosCashRefund,
  getPosUnitContext
} from '@texnobazar/data';

const msg = e => String(e?.message || 'Amalni bajarib bo‘lmadi.');
const stamp = v => v ? new Date(v).toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const todayDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const minReturnDate = () => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function ReturnsWorkspace({ branchId, toast, goPage }) {
  const rate = useExchangeRate();
  const [tab, setTab] = useState('qr'); // 'qr' or 'calendar'
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [found, setFound] = useState(null);

  // Calendar search state
  const [calendarDate, setCalendarDate] = useState(todayDate());
  const [calendarQuery, setCalendarQuery] = useState('');
  const [soldUnits, setSoldUnits] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState('');

  // Selected Option: 1 (same item), 2 (different item), 3 (cash refund)
  const [activeOption, setActiveOption] = useState(1);

  // Option 1 state
  const [sameReplacementQr, setSameReplacementQr] = useState('');
  const [option1Busy, setOption1Busy] = useState(false);

  // Option 2 state
  const [opt2NewQr, setOpt2NewQr] = useState('');
  const [opt2NewUnit, setOpt2NewUnit] = useState(null);
  const [opt2LookupBusy, setOpt2LookupBusy] = useState(false);
  const [opt2LookupError, setOpt2LookupError] = useState('');
  const [option2Busy, setOption2Busy] = useState(false);

  // Option 3 state
  const [opt3Reason, setOpt3Reason] = useState('Mijoz xaridini qaytarib pulini olishni so‘radi');
  const [option3Busy, setOption3Busy] = useState(false);

  // Result success modal
  const [successResult, setSuccessResult] = useState(null);

  const resetAll = () => {
    setFound(null);
    setLookupError('');
    setSameReplacementQr('');
    setOpt2NewQr('');
    setOpt2NewUnit(null);
    setOpt2LookupError('');
    setOpt3Reason('Mijoz xaridini qaytarib pulini olishni so‘radi');
    setActiveOption(1);
  };

  // Lookup by QR / Serial
  const lookupQr = async (valueToUse) => {
    const val = (valueToUse !== undefined ? valueToUse : code).trim();
    if (!val) return;
    setBusy(true);
    setLookupError('');
    resetAll();
    try {
      const res = await findSaleReturnUnit(branchId, val);
      setFound(res);
      setCode(val);
    } catch (e) {
      setLookupError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  // Load sold units for calendar date
  const loadSoldUnits = async () => {
    if (!branchId || !calendarDate) return;
    setCalendarLoading(true);
    setCalendarError('');
    try {
      const list = await listBranchSoldUnitsByDate(branchId, calendarDate, calendarQuery);
      setSoldUnits(Array.isArray(list) ? list : []);
    } catch (e) {
      setCalendarError(msg(e));
      setSoldUnits([]);
    } finally {
      setCalendarLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'calendar') {
      loadSoldUnits();
    }
  }, [tab, calendarDate, branchId]);

  const onCalendarSearchSubmit = (e) => {
    e?.preventDefault();
    loadSoldUnits();
  };

  const selectSoldUnit = (item) => {
    if (!item?.qr_code) return;
    setCode(item.qr_code);
    lookupQr(item.qr_code);
  };

  // Option 2: Lookup new replacement item
  const lookupOpt2NewItem = async (val) => {
    const codeToSearch = (val !== undefined ? val : opt2NewQr).trim();
    if (!codeToSearch) return;
    setOpt2LookupBusy(true);
    setOpt2LookupError('');
    setOpt2NewUnit(null);
    try {
      const ctx = await getPosUnitContext(branchId, codeToSearch);
      if (!ctx || !ctx.unit) {
        throw new Error('Yangi tovar birligi topilmadi');
      }
      if (ctx.unit.status !== 'available') {
        throw new Error(`Yangi tanlangan tovar erkin sotuvda emas (holati: ${ctx.unit.status_label || ctx.unit.status})`);
      }
      setOpt2NewUnit(ctx);
    } catch (e) {
      setOpt2LookupError(msg(e));
    } finally {
      setOpt2LookupBusy(false);
    }
  };

  // Submit Option 1 (Same Product Exchange)
  const handleOption1Submit = async () => {
    if (!found?.unit?.id) return;
    setOption1Busy(true);
    try {
      let replacementId = null;
      if (sameReplacementQr.trim()) {
        const repCtx = await getPosUnitContext(branchId, sameReplacementQr.trim());
        if (repCtx?.unit?.product_id !== found.product?.id) {
          throw new Error('1-opsiyada faqat aynan shu tovardan yangi dona berilishi shart!');
        }
        if (repCtx.unit.status !== 'available') {
          throw new Error('O‘rniga beriladigan birlik sotuvga tayyor emas!');
        }
        replacementId = repCtx.unit.id;
      }
      const res = await executePosSameProductExchange({
        branchId,
        returnedUnitId: found.unit.id,
        replacementUnitId: replacementId,
        reason: '1-opsiya: Aynan shu tovardan yangisiga almashtirildi'
      });
      setSuccessResult({
        title: '1-Opsiya: Tovar muvaffaqiyatli almashtirildi',
        message: res.message || 'Tovar qaytarildi va do‘kon balansiga o‘tkazildi. Kassada bugun uchun qo‘shimcha pul hisoblanmaydi.',
        details: [
          ['Qaytarilgan tovar', found.product?.name],
          ['QR kodi', found.unit?.qr_code],
          ['Asl xarid sanasi', stamp(found.sale?.sold_at)],
          ['Balans', 'Do‘kon zaxirasiga +1 dona qo‘shildi'],
          ['Kassa hisobi', 'O‘sha kungi holatida o‘zgarishsiz qoladi (0 so‘m farq)']
        ]
      });
      toast?.('1-opsiya bo‘yicha tovar almashtirildi!');
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setOption1Busy(false);
    }
  };

  // Submit Option 2 (Different / Upgrade Product Exchange)
  const handleOption2Submit = async () => {
    if (!found?.unit?.id || !opt2NewUnit?.unit?.id) return;
    const returnedPrice = Number(found.sale_line?.line_total || 0);
    const newPrice = Number(opt2NewUnit.product?.retail_price || 0);

    if (newPrice < returnedPrice) {
      toast?.('Almashtiriladigan tovar narxi qaytarilayotgan tovar narxidan kam bo‘lishi mumkin emas!');
      return;
    }

    setOption2Busy(true);
    try {
      const res = await createPosExchangeUpgrade({
        branchId,
        returnedUnitId: found.unit.id,
        newUnitId: opt2NewUnit.unit.id,
        reason: `2-opsiya: ${opt2NewUnit.product?.name} ga almashtirildi`
      });

      if (res.difference > 0) {
        setSuccessResult({
          title: '2-Opsiya: Kassa so‘rovi yaratildi',
          message: res.message,
          pendingNo: res.pending_no,
          details: [
            ['Qaytarilgan tovar', `${found.product?.name} (${formatDualMoney(returnedPrice, rate)})`],
            ['Yangi tanlangan tovar', `${opt2NewUnit.product?.name} (${formatDualMoney(newPrice, rate)})`],
            ['To‘lanadigan farq', formatDualMoney(res.difference, rate)],
            ['Kassa so‘rovi', res.pending_no],
            ['Mijoz', 'Chek kassaga yo‘naltirildi, mijoz kassaga to‘lov qiladi']
          ]
        });
      } else {
        setSuccessResult({
          title: '2-Opsiya: Tovar teng narxda almashtirildi',
          message: 'Tovar teng qiymatli tovar bilan muvaffaqiyatli almashtirildi (farq: 0 so‘m). Qoldiq avtomatik yangilandi.',
          details: [
            ['Qaytarilgan tovar', `${found.product?.name} (${formatDualMoney(returnedPrice, rate)})`],
            ['Yangi tovar', `${opt2NewUnit.product?.name} (${formatDualMoney(newPrice, rate)})`],
            ['Farq', '0 so‘m'],
            ['Kassa holati', 'To‘lov talab etilmaydi']
          ]
        });
      }
      toast?.('2-opsiya bo‘yicha almashtirish qayd qilindi!');
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setOption2Busy(false);
    }
  };

  // Submit Option 3 (Full Return with Cash Refund)
  const handleOption3Submit = async () => {
    if (!found?.unit?.id) return;
    setOption3Busy(true);
    try {
      const res = await requestPosCashRefund({
        branchId,
        unitId: found.unit.id,
        reason: opt3Reason.trim()
      });
      setSuccessResult({
        title: '3-Opsiya: Mijoz kassaga yo‘naltirildi',
        message: 'Qaytarish so‘rovi tasdiqlash uchun kassaga yuborildi. Kassa naqd pulni qaytargach jarayon to‘liq yakunlanadi.',
        details: [
          ['Qaytariladigan tovar', found.product?.name],
          ['QR kodi', found.unit?.qr_code],
          ['Qaytariladigan naqd pul', formatDualMoney(Number(found.sale_line?.line_total || 0), rate)],
          ['So‘rov raqami', res.return_no],
          ['Kassa hisoboti', 'Pul qaytarilgach, haridor xarid qilgan kunning savdo aylanmasidan shu pul chiqariladi']
        ]
      });
      toast?.('Qaytarish so‘rovi yaratildi va kassaga yuborildi!');
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setOption3Busy(false);
    }
  };

  const returnedPrice = Number(found?.sale_line?.line_total || 0);
  const opt2NewPrice = Number(opt2NewUnit?.product?.retail_price || 0);
  const opt2Diff = opt2NewPrice - returnedPrice;
  const isOpt2Invalid = opt2NewUnit && opt2NewPrice < returnedPrice;

  return (
    <div className="pos-returns-view">
      <div className="pos-real-title">
        <div>
          <small>1 oygacha kafolatlangan tovar qaytarish</small>
          <h2>Tovarni qaytarib olish</h2>
        </div>
        <Status type="blue">Kafolat: 30 kun</Status>
      </div>

      {/* Top search mode tabs: QR Scan vs Calendar Pick */}
      <div className="returns-mode-selector">
        <button
          type="button"
          className={tab === 'qr' ? 'active' : ''}
          onClick={() => { setTab('qr'); resetAll(); }}
        >
          <QrCode size={18} />
          <span>QR kod / seriyani skanerlash</span>
        </button>
        <button
          type="button"
          className={tab === 'calendar' ? 'active' : ''}
          onClick={() => { setTab('calendar'); resetAll(); }}
        >
          <Calendar size={18} />
          <span>QR kod yo‘qolganmi? (Sanani tanlash)</span>
        </button>
      </div>

      {/* Mode 1: QR scan form */}
      {tab === 'qr' && (
        <div className="card returns-scan-card">
          <label className="returns-input-label">Mijozga sotilgan tovar QR yoki seriya raqami</label>
          <form className="returns-scan-row" onSubmit={(e) => { e.preventDefault(); lookupQr(); }}>
            <div className="returns-input-wrap">
              <QrCode size={18} className="icon-muted" />
              <input
                className="input"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="TNB1-..."
                autoFocus
              />
            </div>
            <QrScanButton onScan={val => { setCode(val); lookupQr(val); }} />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !code.trim()}
            >
              {busy ? 'Tekshirilmoqda…' : 'Tekshirish'}
            </button>
            {code && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => { setCode(''); resetAll(); }}
              >
                Tozalash
              </button>
            )}
          </form>
          {lookupError && <div className="returns-error-banner"><AlertTriangle size={16} /><span>{lookupError}</span></div>}
          <p className="returns-hint-text">
            Tizim QR kod orqali tovar shu do‘konda va oxirgi 30 kun ichida sotilganini tekshiradi hamda 3 ta qaytarish opsiyasini taqdim etadi.
          </p>
        </div>
      )}

      {/* Mode 2: Calendar picker (Lost / forgotten QR) */}
      {tab === 'calendar' && (
        <div className="card returns-calendar-card">
          <div className="calendar-search-head">
            <div className="calendar-pick-field">
              <label>Xarid qilingan sana (Kalendar):</label>
              <input
                type="date"
                className="input"
                value={calendarDate}
                min={minReturnDate()}
                max={todayDate()}
                onChange={e => setCalendarDate(e.target.value)}
              />
            </div>
            <form className="calendar-filter-form" onSubmit={onCalendarSearchSubmit}>
              <div className="returns-input-wrap">
                <Search size={16} className="icon-muted" />
                <input
                  className="input"
                  value={calendarQuery}
                  onChange={e => setCalendarQuery(e.target.value)}
                  placeholder="Tovar nomi, SKU, mijoz yoki chek raqami"
                />
              </div>
              <button type="submit" className="btn btn-outline">Qidirish</button>
            </form>
          </div>

          <div className="calendar-results-list">
            {calendarLoading ? (
              <div className="pos-real-state"><p>Tanlangan kungi savdolar yuklanmoqda…</p></div>
            ) : calendarError ? (
              <div className="returns-error-banner"><AlertTriangle size={16} /><span>{calendarError}</span></div>
            ) : soldUnits.length === 0 ? (
              <Empty
                title="Sotuvlar topilmadi"
                text={`${calendarDate} sanasida ushbu filialda qaytarishga mos sotuvlar topilmadi.`}
              />
            ) : (
              <div className="sold-items-grid">
                {soldUnits.map(item => (
                  <div
                    key={item.sale_line_id || item.unit_id}
                    className={`sold-unit-item ${found?.unit?.id === item.unit_id ? 'active' : ''} ${!item.is_returnable ? 'disabled' : ''}`}
                    onClick={() => item.is_returnable && selectSoldUnit(item)}
                  >
                    <div className="sold-unit-thumb">
                      {item.image ? <img src={item.image} alt="" /> : <Package size={22} />}
                    </div>
                    <div className="sold-unit-info">
                      <b>{item.product_name}</b>
                      <small>SKU: {item.sku} · Partiya: <code>{item.batch_reference || '—'}</code></small>
                      <small>QR: <code>{item.qr_code}</code> {item.serial_number ? `· S/N: ${item.serial_number}` : ''}</small>
                      <small><Receipt size={12} /> Chek: {item.sale_no} · Vaqt: {stamp(item.sold_at)}</small>
                      <small><User size={12} /> {item.customer_name || 'Oddiy xaridor'} · Sotuvchi: {item.seller_name || '—'}</small>
                    </div>
                    <div className="sold-unit-price-action">
                      <strong><DualPrice value={Number(item.line_total)} rate={rate} /></strong>
                      {item.is_returnable ? (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => selectSoldUnit(item)}>
                          Tanlash
                        </button>
                      ) : (
                        <Status type="gray">Qaytarib bo‘lmaydi</Status>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Verified Unit Details Card */}
      {found && (
        <div className={`card returns-verified-card ${found.eligible ? 'eligible' : 'ineligible'}`}>
          <div className="verified-status-row">
            {found.eligible ? (
              <div className="status-badge ok">
                <CheckCircle2 size={18} />
                <span><b>Xarid tasdiqlandi</b> · 1 oylik muddat ichida ({found.days_passed || 0} kun o‘tgan)</span>
              </div>
            ) : (
              <div className="status-badge bad">
                <ShieldAlert size={18} />
                <span><b>Qaytarish mumkin emas:</b> {found.reason}</span>
              </div>
            )}
          </div>

          <div className="verified-unit-body">
            <div className="verified-unit-thumb">
              {found.product?.image ? <img src={found.product.image} alt="" /> : <Package size={32} />}
            </div>
            <div className="verified-unit-details">
              <h3>{found.product?.name}</h3>
              <p className="unit-meta-line">
                <span>SKU: <b>{found.product?.sku}</b></span>
                {found.batch?.reference && <span>Partiya kodi: <code>{found.batch.reference}</code></span>}
                <span>QR: <code>{found.unit?.qr_code}</code></span>
                {found.unit?.serial_number && <span>S/N: <code>{found.unit.serial_number}</code></span>}
              </p>
              <div className="verified-sale-receipt-box">
                <div><small>Xarid qilingan chek:</small> <b>{found.sale?.sale_no}</b></div>
                <div><small>Sotilgan sana:</small> <b>{stamp(found.sale?.sold_at)}</b></div>
                <div><small>Sotuvchi:</small> <b>{found.sale?.seller_name || '—'}</b></div>
                <div><small>Xaridor:</small> <b>{found.sale?.customer_name || 'Ko‘rsatilmagan'}</b></div>
              </div>
            </div>
            <div className="verified-unit-price-side">
              <small>Mijoz to‘lagan summa</small>
              <b className="verified-price-big"><DualPrice value={returnedPrice} rate={rate} /></b>
            </div>
          </div>

          {/* 3 OPTIONS SELECTION */}
          {found.eligible && (
            <div className="returns-three-options-container">
              <h4 className="options-head-title">Qaytarish turini tanlang (3 ta opsiya):</h4>
              <div className="options-tabs-row">
                <button
                  type="button"
                  className={`opt-tab ${activeOption === 1 ? 'active' : ''}`}
                  onClick={() => setActiveOption(1)}
                >
                  <span className="opt-number">1</span>
                  <div className="opt-meta">
                    <b>Aynan shu tovarga almashtirish</b>
                    <small>Boshqa yangi dona beriladi (0 so‘m farq)</small>
                  </div>
                </button>

                <button
                  type="button"
                  className={`opt-tab ${activeOption === 2 ? 'active' : ''}`}
                  onClick={() => setActiveOption(2)}
                >
                  <span className="opt-number">2</span>
                  <div className="opt-meta">
                    <b>Boshqa / analog tovarga almashtirish</b>
                    <small>Narxi teng yoki qimmatroq tovar tanlanadi</small>
                  </div>
                </button>

                <button
                  type="button"
                  className={`opt-tab ${activeOption === 3 ? 'active' : ''}`}
                  onClick={() => setActiveOption(3)}
                >
                  <span className="opt-number">3</span>
                  <div className="opt-meta">
                    <b>Tovarni qaytarib, pulini qaytarish</b>
                    <small>Mijoz kassaga naqd pul uchun yo‘naltiriladi</small>
                  </div>
                </button>
              </div>

              {/* OPTION 1 CONTENT */}
              {activeOption === 1 && (
                <div className="option-content-card">
                  <div className="option-info-box blue">
                    <CheckCircle2 size={20} />
                    <div>
                      <b>1-Opsiya qoidasi:</b>
                      <p>Mijoz sotilgan tovarni qaytaradi va huddi shu tovardan boshqa yangi dona beriladi. Puli ham bir, turi ham bir.
                      Tovar qaytarilganda avtomatik do‘kon balansiga (+1 dona) qo‘shiladi, lekin to‘langan pul xarid qilingan kunda qoladi va bugungi kassada hisoblanmaydi.</p>
                    </div>
                  </div>

                  <div className="option-form-group">
                    <label>O‘rniga beriladigan yangi birlik QR kodi (agar zaxiradan berilsa):</label>
                    <div className="returns-input-wrap">
                      <QrCode size={16} className="icon-muted" />
                      <input
                        className="input"
                        value={sameReplacementQr}
                        onChange={e => setSameReplacementQr(e.target.value)}
                        placeholder="Yangi berilayotgan dona QR kodi (ixtiyoriy)"
                      />
                      <QrScanButton onScan={val => setSameReplacementQr(val)} />
                    </div>
                    <small className="help-text">Agar hoziroq do‘kon zaxirasidan yangi dona berilsa, QR kodini kiriting. Tizim ikkala birlikni avtomatik sinxronlashtiradi.</small>
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary btn-block btn-lg"
                    disabled={option1Busy}
                    onClick={handleOption1Submit}
                  >
                    {option1Busy ? 'Bajarilmoqda…' : '1-Opsiya: Tovarni almashtirishni tasdiqlash'}
                  </button>
                </div>
              )}

              {/* OPTION 2 CONTENT */}
              {activeOption === 2 && (
                <div className="option-content-card">
                  <div className="option-info-box orange">
                    <ArrowLeftRight size={20} />
                    <div>
                      <b>2-Opsiya qoidasi:</b>
                      <p>Mijoz xohlagan boshqa tovar turi skaner qilinadi. Mijoz qaytargan tovariga avval to‘lagan pul bilan teng yoki undan ko‘proq qiymatli tovar olishi kerak!
                      <b>Arzonroq tovar olib qolgan pulni naqd so‘rashga haqli emas.</b> Agar yangi tovar qimmat bo‘lsa, dastur avtomatik farqni kassa chekiga yozadi va kassaga yo‘naltiradi.</p>
                    </div>
                  </div>

                  <div className="option-form-group">
                    <label>Almashtiriladigan yangi tovar QR kodini skanerlang / kiriting:</label>
                    <form className="returns-scan-row" onSubmit={(e) => { e.preventDefault(); lookupOpt2NewItem(); }}>
                      <div className="returns-input-wrap">
                        <QrCode size={16} className="icon-muted" />
                        <input
                          className="input"
                          value={opt2NewQr}
                          onChange={e => setOpt2NewQr(e.target.value)}
                          placeholder="Yangi tovar QR kodi (TNB1-...)"
                          autoFocus
                        />
                      </div>
                      <QrScanButton onScan={val => { setOpt2NewQr(val); lookupOpt2NewItem(val); }} />
                      <button
                        type="submit"
                        className="btn btn-outline"
                        disabled={opt2LookupBusy || !opt2NewQr.trim()}
                      >
                        {opt2LookupBusy ? 'Tekshirilmoqda…' : 'Tovarni topish'}
                      </button>
                    </form>
                    {opt2LookupError && <div className="returns-error-banner"><AlertTriangle size={16} /><span>{opt2LookupError}</span></div>}
                  </div>

                  {opt2NewUnit && (
                    <div className="opt2-comparison-box">
                      <div className="comparison-row">
                        <div className="comp-item old">
                          <small>Qaytarilayotgan tovar</small>
                          <b>{found.product?.name}</b>
                          <span>To‘langan: <strong><DualPrice value={returnedPrice} rate={rate} /></strong></span>
                        </div>
                        <div className="comp-divider">
                          <ChevronRight size={20} />
                        </div>
                        <div className="comp-item new">
                          <small>Almashtiriladigan yangi tovar</small>
                          <b>{opt2NewUnit.product?.name}</b>
                          <span>Chakana narxi: <strong><DualPrice value={opt2NewPrice} rate={rate} /></strong></span>
                        </div>
                      </div>

                      {isOpt2Invalid ? (
                        <div className="returns-error-banner big">
                          <AlertTriangle size={20} />
                          <div>
                            <b>Qat’iy qoida buzildi!</b>
                            <p>Yangi tovar narxi ({formatDualMoney(opt2NewPrice, rate)}) qaytarilayotgan tovar narxidan ({formatDualMoney(returnedPrice, rate)}) past! Mijoz arzonroq tovar olib, do‘kondan qolgan pulni naqd so‘rashga haqli emas. Iltimos, kamida {formatDualMoney(returnedPrice, rate)} qiymatli tovar tanlang.</p>
                          </div>
                        </div>
                      ) : (
                        <div className="opt2-diff-summary">
                          {opt2Diff === 0 ? (
                            <div className="diff-result ok">
                              <CheckCircle2 size={18} />
                              <span><b>Narxlar teng (0 so‘m farq):</b> To‘lov talab etilmaydi, tovarlar to‘g‘ridan-to‘g‘ri almashtiriladi.</span>
                            </div>
                          ) : (
                            <div className="diff-result upgrade">
                              <div>
                                <small>Kassaga to‘lanadigan farq summasi:</small>
                                <b>+{formatDualMoney(opt2Diff, rate)}</b>
                              </div>
                              <p>Dastur avtomatik mijoz hisobiga {formatDualMoney(opt2Diff, rate)} yozadi va chek kassaga yo‘naltiriladi.</p>
                            </div>
                          )}
                        </div>
                      )}

                      <button
                        type="button"
                        className="btn btn-primary btn-block btn-lg"
                        disabled={option2Busy || isOpt2Invalid}
                        onClick={handleOption2Submit}
                      >
                        {option2Busy ? 'Yo‘naltirilmoqda…' : opt2Diff > 0 ? `Kassaga yo‘naltirish (+${formatDualMoney(opt2Diff, rate)})` : 'Almashtirishni yakunlash (0 so‘m)'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* OPTION 3 CONTENT */}
              {activeOption === 3 && (
                <div className="option-content-card">
                  <div className="option-info-box red">
                    <RotateCcw size={20} />
                    <div>
                      <b>3-Opsiya qoidasi:</b>
                      <p>Mijoz tovarni qaytaradi va kassaga yo‘naltiriladi. Kassa unga naqd pulni qaytaradi ({formatDualMoney(returnedPrice, rate)}).
                      <b>Haridor tovarni olgan kuni to‘lagan puli kassa hisobotida sotilgan tovarlardan tushgan pul aylanmasi hisobotidan chiqariladi</b> (masalan, 100 mln so‘m bo‘lsa, 99 mln so‘m bo‘lib qoladi).</p>
                    </div>
                  </div>

                  <div className="option-form-group">
                    <label>Qaytarish sababi:</label>
                    <textarea
                      className="textarea"
                      rows={2}
                      value={opt3Reason}
                      onChange={e => setOpt3Reason(e.target.value)}
                      placeholder="Mijoz tovarini qaytarish sababi..."
                      required
                    />
                  </div>

                  <div className="refund-summary-banner">
                    <div>
                      <small>Kassadan mijozga qaytariladigan naqd pul:</small>
                      <b>{formatDualMoney(returnedPrice, rate)}</b>
                    </div>
                    <small>Asl xarid sanasi: {stamp(found.sale?.sold_at)}</small>
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary btn-block btn-lg"
                    style={{ background: '#e11d48', borderColor: '#e11d48' }}
                    disabled={option3Busy || !opt3Reason.trim()}
                    onClick={handleOption3Submit}
                  >
                    {option3Busy ? 'Yo‘naltirilmoqda…' : `Tovarni qaytarish va kassaga yo‘naltirish (${formatDualMoney(returnedPrice, rate)})`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Success Modal */}
      {successResult && (
        <Modal
          open={Boolean(successResult)}
          onClose={() => { setSuccessResult(null); resetAll(); }}
          title={successResult.title}
        >
          <div className="returns-success-modal">
            <div className="success-icon-wrap">
              <CheckCircle2 size={44} color="#16a34a" />
            </div>
            <p className="success-modal-msg">{successResult.message}</p>

            <div className="success-details-list">
              {successResult.details?.map(([k, v]) => (
                <div key={k} className="success-detail-row">
                  <span>{k}:</span>
                  <b>{v}</b>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => { setSuccessResult(null); resetAll(); }}
              >
                Tushunarli / Bajarildi
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
