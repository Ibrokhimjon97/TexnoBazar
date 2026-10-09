import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  LogIn,
  LogOut,
  MapPin,
  RefreshCw,
  Timer,
} from 'lucide-react';
import { Modal, Status } from '@texnobazar/ui';
import {
  clockIn,
  clockOut,
  formatUzDate,
  formatUzTime,
  formatWorkedDuration,
  getBrowserLocation,
  getGoogleMapsUrl,
  getMyAttendanceHistory,
  getMyTodayAttendance,
} from '@texnobazar/data';

export default function AttendanceWorkspace({ branchId, profile, toast }) {
  const [todayRecord, setTodayRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());

  // Attention modals
  const [confirmModal, setConfirmModal] = useState(null); // 'in' | 'out' | null

  // History tab
  const [tab, setTab] = useState('today'); // 'today' | 'history'
  const [historyItems, setHistoryItems] = useState([]);
  const [historySummary, setHistorySummary] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Live timer tick
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const loadToday = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rec = await getMyTodayAttendance();
      setTodayRecord(rec);
    } catch (e) {
      setError(e?.message || 'Bugungi davomat ma’lumotini yuklab bo‘lmadi.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await getMyAttendanceHistory();
      setHistoryItems(res?.items || []);
      setHistorySummary(res?.summary || null);
    } catch (e) {
      toast?.(e?.message || 'Davomat tarixini yuklab bo‘lmadi.');
    } finally {
      setHistoryLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadToday();
  }, [loadToday]);

  useEffect(() => {
    if (tab === 'history') {
      loadHistory();
    }
  }, [tab, loadHistory]);

  // GPS state
  const [gpsState, setGpsState] = useState({
    status: 'idle', // 'idle' | 'checking' | 'ready' | 'error'
    loc: null,
    error: null,
    code: null,
  });

  // Verify and obtain high-accuracy GPS location
  const checkLocation = useCallback(async () => {
    setGpsState(prev => ({ ...prev, status: 'checking', error: null }));
    try {
      const loc = await getBrowserLocation(12000);
      if (!loc || loc.lat == null || loc.lng == null) {
        setGpsState({
          status: 'error',
          loc: null,
          error: loc?.error || 'GPS signali topilmadi yoki qurilmada GPS o‘chiq.',
          code: loc?.code || 'POSITION_UNAVAILABLE',
        });
        return null;
      }
      setGpsState({
        status: 'ready',
        loc,
        error: null,
        code: null,
      });
      return loc;
    } catch (err) {
      setGpsState({
        status: 'error',
        loc: null,
        error: err?.message || 'GPS lokatsiyani aniqlab bo‘lmadi.',
        code: 'UNKNOWN',
      });
      return null;
    }
  }, []);

  const openClockInModal = () => {
    setConfirmModal('in');
    checkLocation();
  };

  const openClockOutModal = () => {
    setConfirmModal('out');
    checkLocation();
  };

  const closeModal = () => {
    setConfirmModal(null);
    setGpsState({ status: 'idle', loc: null, error: null, code: null });
  };

  // Handle Clock In (GPS is strictly mandatory)
  const handleClockInConfirm = async () => {
    let currentLoc = gpsState.loc;
    if (!currentLoc || currentLoc.lat == null || currentLoc.lng == null) {
      currentLoc = await checkLocation();
      if (!currentLoc || currentLoc.lat == null || currentLoc.lng == null) {
        toast?.('GPS o‘chiq! Davomatni qayd etish uchun GPS yoqilishi shart.');
        return;
      }
    }

    setConfirmModal(null);
    setSubmitting(true);
    setError('');
    try {
      const res = await clockIn({
        branchId,
        lat: currentLoc.lat,
        lng: currentLoc.lng,
        accuracy: currentLoc.accuracy,
      });
      setTodayRecord(res);
      toast?.('Ishga kelganingiz muvaffaqiyatli qayd etildi! Menejerga xabar yuborildi.');
      loadToday();
    } catch (e) {
      const msg = e?.message || 'Ishga kelishni qayd etib bo‘lmadi.';
      setError(msg);
      toast?.(msg);
    } finally {
      setSubmitting(false);
      setGpsState({ status: 'idle', loc: null, error: null, code: null });
    }
  };

  // Handle Clock Out (GPS is strictly mandatory)
  const handleClockOutConfirm = async () => {
    let currentLoc = gpsState.loc;
    if (!currentLoc || currentLoc.lat == null || currentLoc.lng == null) {
      currentLoc = await checkLocation();
      if (!currentLoc || currentLoc.lat == null || currentLoc.lng == null) {
        toast?.('GPS o‘chiq! Ishni yakunlash uchun GPS yoqilishi shart.');
        return;
      }
    }

    setConfirmModal(null);
    setSubmitting(true);
    setError('');
    try {
      const res = await clockOut({
        lat: currentLoc.lat,
        lng: currentLoc.lng,
        accuracy: currentLoc.accuracy,
      });
      setTodayRecord(res);
      toast?.('Ish kuni yakunlandi! Ishlagan soatingiz hisoblandi va saqlandi.');
      loadToday();
    } catch (e) {
      const msg = e?.message || 'Ishni yakunlashni qayd etib bo‘lmadi.';
      setError(msg);
      toast?.(msg);
    } finally {
      setSubmitting(false);
      setGpsState({ status: 'idle', loc: null, error: null, code: null });
    }
  };

  // Live elapsed minutes if checked_in
  const liveWorkedMinutes = useMemo(() => {
    if (!todayRecord?.check_in_at) return 0;
    if (todayRecord?.check_out_at) {
      return todayRecord.worked_minutes || 0;
    }
    const checkInTime = new Date(todayRecord.check_in_at).getTime();
    const elapsedMs = Math.max(0, now.getTime() - checkInTime);
    return Math.floor(elapsedMs / 60000);
  }, [todayRecord, now]);

  const hasClockedIn = Boolean(todayRecord?.check_in_at);
  const hasClockedOut = Boolean(todayRecord?.check_out_at);

  const formatTime = iso => {
    if (!iso) return '—';
    return formatUzTime(iso);
  };

  const formatDate = d => {
    if (!d) return '—';
    return formatUzDate(d, {
      weekday: 'long',
      day: true,
      month: 'long',
      year: true,
    });
  };

  return (
    <div className="attendance-workspace" style={{ padding: '4px 0' }}>
      {/* Top Tabs */}
      <div className="profile-tabs" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={tab === 'today' ? 'active' : ''}
          onClick={() => setTab('today')}
        >
          <Clock size={16} /> Bugungi davomat
        </button>
        <button
          type="button"
          className={tab === 'history' ? 'active' : ''}
          onClick={() => setTab('history')}
        >
          <History size={16} /> Mening tarixim
        </button>
      </div>

      {error && <div className="profile-error">{error}</div>}

      {tab === 'today' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Real-time Clock Card */}
          <div
            className="salary-card"
            style={{
              background: 'linear-gradient(135deg, var(--navy, #0f172a), #1e293b)',
              color: '#fff',
              padding: '20px 18px',
              borderRadius: 16,
              boxShadow: '0 10px 25px rgba(15, 23, 42, 0.15)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: 11, color: '#94a3b8', textTransform: 'capitalize', display: 'block' }}>
                  {formatDate(now)}
                </span>
                <b style={{ fontSize: 32, letterSpacing: '1px', color: '#fff', display: 'block', margin: '4px 0' }}>
                  {now.toLocaleTimeString('uz-UZ')}
                </b>
                <small style={{ color: '#cbd5e1' }}>
                  {profile?.full_name || profile?.email}
                </small>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 10, color: '#94a3b8', display: 'block' }}>Holat:</span>
                {!hasClockedIn ? (
                  <span
                    style={{
                      display: 'inline-block',
                      marginTop: 4,
                      padding: '4px 10px',
                      background: 'rgba(234, 179, 8, 0.2)',
                      color: '#facc15',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Kelmagan
                  </span>
                ) : !hasClockedOut ? (
                  <span
                    style={{
                      display: 'inline-block',
                      marginTop: 4,
                      padding: '4px 10px',
                      background: 'rgba(34, 197, 94, 0.2)',
                      color: '#4ade80',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      animation: 'pulse 2s infinite',
                    }}
                  >
                    ● Ishda
                  </span>
                ) : (
                  <span
                    style={{
                      display: 'inline-block',
                      marginTop: 4,
                      padding: '4px 10px',
                      background: 'rgba(59, 130, 246, 0.2)',
                      color: '#93c5fd',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    ✓ Yakunlangan
                  </span>
                )}
              </div>
            </div>

            {hasClockedIn && (
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Timer size={16} color="#fb923c" />
                <span style={{ fontSize: 12, color: '#e2e8f0' }}>
                  {!hasClockedOut ? 'Hozirgacha ishlangan vaqt:' : 'Bugun jami ishlangan vaqt:'}{' '}
                  <strong style={{ color: '#fb923c' }}>{formatWorkedDuration(liveWorkedMinutes)}</strong>
                </span>
              </div>
            )}
          </div>

          {/* Action Buttons: Ishga keldim / Ishni yakunladim */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Clock In Button */}
            <button
              type="button"
              disabled={hasClockedIn || submitting || loading}
              onClick={openClockInModal}
              style={{
                border: 0,
                borderRadius: 14,
                padding: '18px 12px',
                background: hasClockedIn
                  ? '#e2e8f0'
                  : 'linear-gradient(135deg, #16a34a, #22c55e)',
                color: hasClockedIn ? '#94a3b8' : '#fff',
                cursor: hasClockedIn || submitting ? 'not-allowed' : 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                boxShadow: hasClockedIn ? 'none' : '0 8px 20px rgba(34, 197, 94, 0.3)',
                transition: 'all 0.2s ease',
              }}
            >
              <LogIn size={26} />
              <b style={{ fontSize: 14 }}>Ishga keldim</b>
              <small style={{ fontSize: 10, opacity: 0.9 }}>
                {hasClockedIn ? `Kelingan: ${formatTime(todayRecord.check_in_at)}` : 'Kuniga 1 marta (GPS shart)'}
              </small>
            </button>

            {/* Clock Out Button */}
            <button
              type="button"
              disabled={!hasClockedIn || hasClockedOut || submitting || loading}
              onClick={openClockOutModal}
              style={{
                border: 0,
                borderRadius: 14,
                padding: '18px 12px',
                background: !hasClockedIn || hasClockedOut
                  ? '#e2e8f0'
                  : 'linear-gradient(135deg, #ea580c, #f97316)',
                color: !hasClockedIn || hasClockedOut ? '#94a3b8' : '#fff',
                cursor: !hasClockedIn || hasClockedOut || submitting ? 'not-allowed' : 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                boxShadow: !hasClockedIn || hasClockedOut ? 'none' : '0 8px 20px rgba(249, 115, 22, 0.3)',
                transition: 'all 0.2s ease',
              }}
            >
              <LogOut size={26} />
              <b style={{ fontSize: 14 }}>Ishni yakunladim</b>
              <small style={{ fontSize: 10, opacity: 0.9 }}>
                {hasClockedOut
                  ? `Yakunlangan: ${formatTime(todayRecord.check_out_at)}`
                  : !hasClockedIn
                  ? 'Avval kelishni bosing'
                  : 'Kuniga 1 marta (GPS shart)'}
              </small>
            </button>
          </div>

          {/* GPS Requirement Notice */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 12,
              color: '#475569',
            }}
          >
            <MapPin size={18} style={{ color: '#0284c7', flexShrink: 0 }} />
            <span>
              Davomatni qayd etish uchun <b>GPS (geolokatsiya)</b> yoqilgan bo‘lishi majburiy. Agar GPS o‘chiq bo‘lsa, tizim amalni bajarmaydi.
            </span>
          </div>

          {/* Today Details Card */}
          <div className="profile-details">
            <h3 style={{ margin: '0 0 12px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={16} color="var(--orange)" /> Bugungi qaydlar tafsiloti
            </h3>

            <div className="profile-row">
              <span>Kelgan vaqti:</span>
              <b>{hasClockedIn ? formatTime(todayRecord.check_in_at) : 'Kutilmoqda'}</b>
            </div>

            {hasClockedIn && todayRecord.check_in_lat && (
              <div className="profile-row" style={{ alignItems: 'center' }}>
                <span>Kelgandagi GPS lokatsiya:</span>
                <a
                  href={getGoogleMapsUrl(todayRecord.check_in_lat, todayRecord.check_in_lng)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: '#2563eb',
                    fontSize: 12,
                    textDecoration: 'none',
                    background: '#eff6ff',
                    padding: '4px 8px',
                    borderRadius: 6,
                    fontWeight: 600,
                  }}
                >
                  <MapPin size={13} /> Xaritada ko‘rish <ExternalLink size={11} />
                </a>
              </div>
            )}

            <div className="profile-row">
              <span>Ketgan vaqti:</span>
              <b>{hasClockedOut ? formatTime(todayRecord.check_out_at) : hasClockedIn ? 'Hali yakunlanmagan' : '—'}</b>
            </div>

            {hasClockedOut && todayRecord.check_out_lat && (
              <div className="profile-row" style={{ alignItems: 'center' }}>
                <span>Ketgandagi GPS lokatsiya:</span>
                <a
                  href={getGoogleMapsUrl(todayRecord.check_out_lat, todayRecord.check_out_lng)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    color: '#2563eb',
                    fontSize: 12,
                    textDecoration: 'none',
                    background: '#eff6ff',
                    padding: '4px 8px',
                    borderRadius: 6,
                    fontWeight: 600,
                  }}
                >
                  <MapPin size={13} /> Xaritada ko‘rish <ExternalLink size={11} />
                </a>
              </div>
            )}

            <div className="profile-row">
              <span>Jami ishlangan vaqt:</span>
              <b style={{ color: 'var(--orange)' }}>
                {hasClockedIn ? formatWorkedDuration(liveWorkedMinutes) : '—'}
              </b>
            </div>
          </div>
        </div>
      ) : (
        /* History Tab */
        <div className="salary-history">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Calendar size={16} color="var(--orange)" /> Oxirgi 30 kunlik davomat
            </h3>
            <button
              type="button"
              className="icon-btn"
              onClick={loadHistory}
              disabled={historyLoading}
              title="Yangilash"
            >
              <RefreshCw size={15} className={historyLoading ? 'spin' : ''} />
            </button>
          </div>

          {/* KPI Summary */}
          {historySummary && (
            <div className="salary-summary" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <div className="salary-card">
                <small>Ishga kelingan kunlar</small>
                <b>{historySummary.total_days || 0} kun</b>
              </div>
              <div className="salary-card">
                <small>To‘liq smenalar</small>
                <b>{historySummary.completed_days || 0} ta</b>
              </div>
              <div className="salary-card highlight">
                <small>Jami ishlangan vaqt</small>
                <b>{formatWorkedDuration(historySummary.total_worked_minutes)}</b>
              </div>
            </div>
          )}

          {historyLoading ? (
            <div className="salary-loading">Tarix yuklanmoqda…</div>
          ) : historyItems.length === 0 ? (
            <div className="salary-empty">Davomat yozuvlari topilmadi.</div>
          ) : (
            <div className="salary-items">
              {historyItems.map(item => (
                <div key={item.id} className="salary-item">
                  <div className="salary-item-header">
                    <b>{formatUzDate(item.work_date, { day: true, month: 'long', weekday: 'long', year: false })}</b>
                    <span
                      className={`salary-status ${
                        item.status === 'completed'
                          ? 'salary-status-paid'
                          : item.status === 'missed_checkout'
                          ? 'salary-status-pending'
                          : 'salary-status-approved'
                      }`}
                      style={item.status === 'missed_checkout' ? { background: '#fee2e2', color: '#b91c1c' } : {}}
                    >
                      {item.status === 'completed'
                        ? 'Yakunlangan'
                        : item.status === 'missed_checkout'
                        ? '⚠️ Ketish belgilanmagan'
                        : 'Ishda'}
                    </span>
                  </div>

                  {item.status === 'missed_checkout' && (
                    <div style={{ margin: '4px 0 8px', fontSize: 11, color: '#b91c1c', background: '#fef2f2', padding: '6px 10px', borderRadius: 6, border: '1px solid #fee2e2' }}>
                      ⚠️ Ishni yakunlash belgilanmagan (00:00 da smena yopilgan). Menejer yoki admin tomonidan kiritilmaguncha bu kun ishlanmagan hisobida turadi.
                    </div>
                  )}

                  <div className="salary-item-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div>
                      <span>Kelgan vaqti:</span>
                      <b>{formatTime(item.check_in_at)}</b>
                    </div>
                    <div>
                      <span>Ketgan vaqti:</span>
                      <b>{formatTime(item.check_out_at)}</b>
                    </div>
                    <div>
                      <span>Ishlangan soat:</span>
                      <b style={{ color: 'var(--orange)' }}>
                        {formatWorkedDuration(item.worked_minutes)}
                      </b>
                    </div>
                    <div>
                      <span>Filial:</span>
                      <b>{item.branch_name || '—'}</b>
                    </div>
                  </div>

                  {/* Geolocation links */}
                  {(item.check_in_lat || item.check_out_lat) && (
                    <div
                      style={{
                        marginTop: 8,
                        paddingTop: 8,
                        borderTop: '1px solid #f1f5f9',
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      {item.check_in_lat && (
                        <a
                          href={getGoogleMapsUrl(item.check_in_lat, item.check_in_lng)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            color: '#2563eb',
                            fontSize: 11,
                            textDecoration: 'none',
                          }}
                        >
                          <MapPin size={11} /> Kelish lokatsiyasi <ExternalLink size={10} />
                        </a>
                      )}
                      {item.check_out_lat && (
                        <a
                          href={getGoogleMapsUrl(item.check_out_lat, item.check_out_lng)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            color: '#2563eb',
                            fontSize: 11,
                            textDecoration: 'none',
                          }}
                        >
                          <MapPin size={11} /> Ketish lokatsiyasi <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modal for Clock In */}
      <Modal
        open={confirmModal === 'in'}
        onClose={closeModal}
        title="Ishga kelishni tasdiqlash"
      >
        <div style={{ padding: '6px 0', textAlign: 'center' }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              background: '#dcfce7',
              color: '#16a34a',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 12px',
            }}
          >
            <MapPin size={28} />
          </div>

          <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Ishga kelishni qayd etish</h3>
          <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Haqiqatan ham <b>ishga kelganingizni</b> tasdiqlaysizmi?
            <br />
            Qurilmangizdan <b>GPS lokatsiya</b> olinadi va menejer hamda adminga yuboriladi.
          </p>

          {/* GPS Status / Prompt Box */}
          {gpsState.status === 'checking' && (
            <div
              style={{
                padding: '16px',
                borderRadius: 12,
                background: '#f8fafc',
                border: '1.5px solid #cbd5e1',
                margin: '12px 0 16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <RefreshCw size={24} className="spin" style={{ color: 'var(--orange, #f97316)' }} />
              <b style={{ fontSize: 13, color: '#1e293b' }}>GPS lokatsiya aniqlanmoqda…</b>
              <small style={{ color: '#64748b', fontSize: 11 }}>
                Qurilmangizdan joriy koordinatalar olinmoqda, iltimos kuting.
              </small>
            </div>
          )}

          {gpsState.status === 'ready' && gpsState.loc && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                background: '#f0fdf4',
                border: '1.5px solid #86efac',
                margin: '12px 0 16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  background: '#dcfce7',
                  color: '#16a34a',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <CheckCircle2 size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ color: '#15803d', fontSize: 13, display: 'block', marginBottom: 2 }}>
                  ✓ GPS lokatsiya muvaffaqiyatli aniqlandi
                </b>
                <span style={{ fontSize: 12, color: '#334155', display: 'block' }}>
                  Koordinatalar: <strong>{gpsState.loc.lat}, {gpsState.loc.lng}</strong>
                </span>
                {gpsState.loc.accuracy && (
                  <small style={{ fontSize: 11, color: '#16a34a', display: 'block', marginTop: 2 }}>
                    Aniqlik: ±{gpsState.loc.accuracy} metr
                  </small>
                )}
              </div>
            </div>
          )}

          {gpsState.status === 'error' && (
            <div
              style={{
                padding: '14px',
                borderRadius: 12,
                background: '#fef2f2',
                border: '1.5px solid #fca5a5',
                margin: '12px 0 16px',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b91c1c', marginBottom: 6 }}>
                <AlertTriangle size={20} />
                <b style={{ fontSize: 13 }}>GPS o‘chiq yoki lokatsiyaga ruxsat berilmagan!</b>
              </div>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
                {gpsState.error || 'Qurilmangizda GPS yoqilmagan. Davomatni qayd etish uchun joriy lokatsiyangiz olinishi shart!'}
              </p>
              <div
                style={{
                  background: '#fff',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: '#334155',
                  border: '1px solid #fee2e2',
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ display: 'block', marginBottom: 4, color: '#991b1b' }}>Davomat uchun majburiy:</strong>
                <ol style={{ margin: '0 0 0 16px', padding: 0 }}>
                  <li>Qurilmangiz (telefon/kompyuter) sozlamalaridan <b>GPS / Joylashuv</b>ni yoqing.</li>
                  <li>Brauzer manzil qatoridagi <b>qulf (🔒) yoki sozlamalar</b> tugmasini bosib, saytga <b>Joylashuv</b>ga ruxsat bering.</li>
                </ol>
              </div>
              <button
                type="button"
                className="btn"
                onClick={checkLocation}
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#ef4444',
                  borderColor: '#ef4444',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                <RefreshCw size={16} /> GPSni yoqdim, qayta tekshirish
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: 1, padding: 11 }}
              onClick={closeModal}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn"
              disabled={gpsState.status !== 'ready' || submitting}
              style={{
                flex: 1,
                padding: 11,
                background: gpsState.status === 'ready' ? '#16a34a' : '#94a3b8',
                borderColor: gpsState.status === 'ready' ? '#16a34a' : '#94a3b8',
                color: '#fff',
                cursor: gpsState.status === 'ready' && !submitting ? 'pointer' : 'not-allowed',
                opacity: gpsState.status === 'ready' ? 1 : 0.65,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
              onClick={handleClockInConfirm}
            >
              {gpsState.status === 'checking'
                ? 'GPS kutilmoqda…'
                : gpsState.status === 'error'
                ? 'GPS yoqilmagan'
                : submitting
                ? 'Saqlanmoqda…'
                : 'Ha, tasdiqlayman'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Confirmation Modal for Clock Out */}
      <Modal
        open={confirmModal === 'out'}
        onClose={closeModal}
        title="Ishni yakunlashni tasdiqlash"
      >
        <div style={{ padding: '6px 0', textAlign: 'center' }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              background: '#ffedd5',
              color: '#ea580c',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 12px',
            }}
          >
            <MapPin size={28} />
          </div>

          <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Ishni yakunlash</h3>
          <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Bugungi <b>ishni yakunlashni</b> tasdiqlaysizmi?
            <br />
            GPS lokatsiyangiz olinadi, ishlagan umumiy soatingiz yakuniy hisoblanadi va menejerga yuboriladi.
            <br />
            <span style={{ color: '#ea580c', fontWeight: 600, display: 'inline-block', marginTop: 4 }}>
              ⚠️ Yakunlangach, bugun qayta ish boshlash mumkin emas!
            </span>
          </p>

          {/* GPS Status / Prompt Box */}
          {gpsState.status === 'checking' && (
            <div
              style={{
                padding: '16px',
                borderRadius: 12,
                background: '#f8fafc',
                border: '1.5px solid #cbd5e1',
                margin: '12px 0 16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <RefreshCw size={24} className="spin" style={{ color: 'var(--orange, #f97316)' }} />
              <b style={{ fontSize: 13, color: '#1e293b' }}>GPS lokatsiya aniqlanmoqda…</b>
              <small style={{ color: '#64748b', fontSize: 11 }}>
                Qurilmangizdan joriy koordinatalar olinmoqda, iltimos kuting.
              </small>
            </div>
          )}

          {gpsState.status === 'ready' && gpsState.loc && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                background: '#f0fdf4',
                border: '1.5px solid #86efac',
                margin: '12px 0 16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  background: '#dcfce7',
                  color: '#16a34a',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <CheckCircle2 size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ color: '#15803d', fontSize: 13, display: 'block', marginBottom: 2 }}>
                  ✓ GPS lokatsiya muvaffaqiyatli aniqlandi
                </b>
                <span style={{ fontSize: 12, color: '#334155', display: 'block' }}>
                  Koordinatalar: <strong>{gpsState.loc.lat}, {gpsState.loc.lng}</strong>
                </span>
                {gpsState.loc.accuracy && (
                  <small style={{ fontSize: 11, color: '#16a34a', display: 'block', marginTop: 2 }}>
                    Aniqlik: ±{gpsState.loc.accuracy} metr
                  </small>
                )}
              </div>
            </div>
          )}

          {gpsState.status === 'error' && (
            <div
              style={{
                padding: '14px',
                borderRadius: 12,
                background: '#fef2f2',
                border: '1.5px solid #fca5a5',
                margin: '12px 0 16px',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b91c1c', marginBottom: 6 }}>
                <AlertTriangle size={20} />
                <b style={{ fontSize: 13 }}>GPS o‘chiq yoki lokatsiyaga ruxsat berilmagan!</b>
              </div>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
                {gpsState.error || 'Qurilmangizda GPS yoqilmagan. Ishni yakunlash uchun joriy lokatsiyangiz olinishi shart!'}
              </p>
              <div
                style={{
                  background: '#fff',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: '#334155',
                  border: '1px solid #fee2e2',
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ display: 'block', marginBottom: 4, color: '#991b1b' }}>Yakunlash uchun majburiy:</strong>
                <ol style={{ margin: '0 0 0 16px', padding: 0 }}>
                  <li>Qurilmangiz (telefon/kompyuter) sozlamalaridan <b>GPS / Joylashuv</b>ni yoqing.</li>
                  <li>Brauzer manzil qatoridagi <b>qulf (🔒) yoki sozlamalar</b> tugmasini bosib, saytga <b>Joylashuv</b>ga ruxsat bering.</li>
                </ol>
              </div>
              <button
                type="button"
                className="btn"
                onClick={checkLocation}
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#ef4444',
                  borderColor: '#ef4444',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                <RefreshCw size={16} /> GPSni yoqdim, qayta tekshirish
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: 1, padding: 11 }}
              onClick={closeModal}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={gpsState.status !== 'ready' || submitting}
              style={{
                flex: 1,
                padding: 11,
                background: gpsState.status === 'ready' ? '#ea580c' : '#94a3b8',
                borderColor: gpsState.status === 'ready' ? '#ea580c' : '#94a3b8',
                color: '#fff',
                cursor: gpsState.status === 'ready' && !submitting ? 'pointer' : 'not-allowed',
                opacity: gpsState.status === 'ready' ? 1 : 0.65,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
              onClick={handleClockOutConfirm}
            >
              {gpsState.status === 'checking'
                ? 'GPS kutilmoqda…'
                : gpsState.status === 'error'
                ? 'GPS yoqilmagan'
                : submitting
                ? 'Saqlanmoqda…'
                : 'Ha, yakunlayman'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
