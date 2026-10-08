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

  // Handle Clock In
  const handleClockInConfirm = async () => {
    setConfirmModal(null);
    setSubmitting(true);
    setError('');
    try {
      toast?.('GPS lokatsiya aniqlanmoqda…');
      const loc = await getBrowserLocation(10000);
      const res = await clockIn({
        branchId,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy,
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
    }
  };

  // Handle Clock Out
  const handleClockOutConfirm = async () => {
    setConfirmModal(null);
    setSubmitting(true);
    setError('');
    try {
      toast?.('GPS lokatsiya aniqlanmoqda…');
      const loc = await getBrowserLocation(10000);
      const res = await clockOut({
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy,
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
              onClick={() => setConfirmModal('in')}
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
                {hasClockedIn ? `Kelingan: ${formatTime(todayRecord.check_in_at)}` : 'Kuniga 1 marta'}
              </small>
            </button>

            {/* Clock Out Button */}
            <button
              type="button"
              disabled={!hasClockedIn || hasClockedOut || submitting || loading}
              onClick={() => setConfirmModal('out')}
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
                  : 'Kuniga 1 marta'}
              </small>
            </button>
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
                          : 'salary-status-approved'
                      }`}
                    >
                      {item.status === 'completed' ? 'Yakunlangan' : 'Ishda'}
                    </span>
                  </div>

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
        onClose={() => setConfirmModal(null)}
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
            <AlertTriangle size={28} />
          </div>

          <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Diqqat!</h3>
          <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Haqiqatan ham <b>ishga kelganingizni</b> tasdiqlaysizmi?
            <br />
            Qurilmangizdan <b>GPS lokatsiya</b> olinadi va menejer hamda adminga yuboriladi.
            <br />
            <span style={{ color: 'var(--orange)', fontWeight: 600, display: 'inline-block', marginTop: 6 }}>
              ⚠️ Bu amalni kunda faqat 1 marta bajarish mumkin!
            </span>
          </p>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: 1, padding: 11 }}
              onClick={() => setConfirmModal(null)}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn"
              style={{
                flex: 1,
                padding: 11,
                background: '#16a34a',
                borderColor: '#16a34a',
                color: '#fff',
              }}
              onClick={handleClockInConfirm}
            >
              Ha, tasdiqlayman
            </button>
          </div>
        </div>
      </Modal>

      {/* Confirmation Modal for Clock Out */}
      <Modal
        open={confirmModal === 'out'}
        onClose={() => setConfirmModal(null)}
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
            <AlertTriangle size={28} />
          </div>

          <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Diqqat!</h3>
          <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Bugungi <b>ishni yakunlashni</b> tasdiqlaysizmi?
            <br />
            GPS lokatsiyangiz olinadi, ishlagan umumiy soatingiz yakuniy hisoblanadi va menejerga yuboriladi.
            <br />
            <span style={{ color: '#ea580c', fontWeight: 600, display: 'inline-block', marginTop: 6 }}>
              ⚠️ Yakunlangach, bugun qayta ish boshlash mumkin emas!
            </span>
          </p>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: 1, padding: 11 }}
              onClick={() => setConfirmModal(null)}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn danger"
              style={{
                flex: 1,
                padding: 11,
                background: '#ea580c',
                borderColor: '#ea580c',
                color: '#fff',
              }}
              onClick={handleClockOutConfirm}
            >
              Ha, yakunlayman
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
