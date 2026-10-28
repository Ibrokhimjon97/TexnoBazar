import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Award, Calendar, CheckCircle2, ChevronLeft, ChevronRight, Crown,
  Medal, Package, Receipt, RefreshCw, Sparkles, TrendingUp, Trophy, User, Users,
} from 'lucide-react';
import { getSellerLeaderboard } from '@texnobazar/data';
import { formatMoney } from '@texnobazar/ui';

function getLocalDateString(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateDisplay(dateStr, period) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);

  if (period === 'year') {
    return `${y}-yil`;
  }

  const monthsUz = [
    'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
    'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr',
  ];

  if (period === 'month') {
    return `${monthsUz[m - 1]} ${y}-yil`;
  }

  if (period === 'week') {
    const dayOfWeek = dt.getDay() || 7;
    const mon = new Date(dt);
    mon.setDate(dt.getDate() - (dayOfWeek - 1));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);

    const monD = mon.getDate();
    const monM = monthsUz[mon.getMonth()].toLowerCase();
    const sunD = sun.getDate();
    const sunM = monthsUz[sun.getMonth()].toLowerCase();
    const sunY = sun.getFullYear();

    if (mon.getMonth() === sun.getMonth()) {
      return `${monD} – ${sunD}-${sunM} ${sunY}-yil`;
    }
    return `${monD}-${monM} – ${sunD}-${sunM} ${sunY}-yil`;
  }

  const weekdaysUz = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
  return `${d}-${monthsUz[m - 1].toLowerCase()} ${y}-yil, ${weekdaysUz[dt.getDay()]}`;
}

function shiftDate(dateStr, period, delta) {
  const [y, m, d] = (dateStr || getLocalDateString()).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (period === 'year') {
    dt.setFullYear(dt.getFullYear() + delta);
  } else if (period === 'month') {
    dt.setMonth(dt.getMonth() + delta);
  } else if (period === 'week') {
    dt.setDate(dt.getDate() + delta * 7);
  } else {
    dt.setDate(dt.getDate() + delta);
  }
  return getLocalDateString(dt);
}

export default function SellerRatingWorkspace({ branchId, profile, toast, onBack }) {
  const [period, setPeriod] = useState('day');
  const [targetDate, setTargetDate] = useState(() => getLocalDateString());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const todayStr = useMemo(() => getLocalDateString(), []);
  const isToday = targetDate === todayStr && period === 'day';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getSellerLeaderboard({
        branchId,
        period,
        date: targetDate,
      });
      setData(res || { items: [] });
    } catch (e) {
      setError(String(e?.message || 'Reyting yuklanmadi.'));
    } finally {
      setLoading(false);
    }
  }, [branchId, period, targetDate]);

  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items || [];
  const mySellerId = profile?.id;
  const myRow = items.find(i => i.seller_id === mySellerId);

  const top1 = items.find(i => i.rank === 1);
  const top2 = items.find(i => i.rank === 2);
  const top3 = items.find(i => i.rank === 3);

  const branchTotalSales = Number(data?.branch_total_sales || 0);
  const branchTotalChecks = Number(data?.branch_total_checks || 0);
  const totalSellers = Number(data?.total_sellers || items.length || 0);

  return (
    <div className="seller-rating-page">
      {/* Top Bar with Back Button */}
      <div className="seller-rating-topbar">
        <button type="button" className="seller-rating-back-btn" onClick={onBack}>
          <ChevronLeft size={20} />
          <span>POS kassaga qaytish</span>
        </button>

        <button
          type="button"
          className="seller-rating-refresh-btn"
          onClick={load}
          disabled={loading}
          title="Yangilash"
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {/* Main Card Header */}
      <div className="seller-rating-header-card card">
        <div className="seller-rating-title-row">
          <div className="rating-trophy-badge">
            <Trophy size={18} />
          </div>
          <div>
            <h2>Sotuvchilar musobaqasi</h2>
            <p>Filialdagi barcha sheriklaringiz natijalari va o‘rinlari</p>
          </div>
        </div>

        {/* Period Selector Tabs */}
        <div className="seller-rating-tabs">
          {[
            { id: 'day', label: 'Kunlik' },
            { id: 'week', label: 'Haftalik' },
            { id: 'month', label: 'Oylik' },
            { id: 'year', label: 'Yillik' },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`seller-tab-btn ${period === tab.id ? 'active' : ''}`}
              onClick={() => setPeriod(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Date Navigator */}
        <div className="seller-date-nav">
          <div className="date-nav-arrows">
            <button
              type="button"
              className="btn-date-arrow"
              onClick={() => setTargetDate(curr => shiftDate(curr, period, -1))}
              title="Oldingi"
            >
              <ChevronLeft size={18} />
            </button>

            <button
              type="button"
              className={`btn-date-today ${isToday ? 'active' : ''}`}
              onClick={() => setTargetDate(todayStr)}
            >
              Bugun
            </button>

            <button
              type="button"
              className="btn-date-arrow"
              onClick={() => setTargetDate(curr => shiftDate(curr, period, 1))}
              title="Keyingi"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <label className="seller-date-picker-wrap">
            <Calendar size={15} />
            <input
              type="date"
              value={targetDate}
              onChange={e => e.target.value && setTargetDate(e.target.value)}
              className="seller-date-input"
            />
          </label>
        </div>

        <div className="seller-active-date-display">
          <span>{formatDateDisplay(targetDate, period)}</span>
        </div>
      </div>

      {/* States */}
      {loading ? (
        <div className="seller-rating-state">
          <RefreshCw size={26} className="spin" />
          <p>Reyting ma’lumotlari hisoblanmoqda…</p>
        </div>
      ) : error ? (
        <div className="seller-rating-state error">
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={load} style={{ marginTop: 10 }}>
            Qayta urinish
          </button>
        </div>
      ) : (
        <>
          {/* Current Seller's Own Position Banner (Hero Card) */}
          {myRow && (
            <div className={`seller-my-card ${myRow.rank === 1 ? 'gold-glow' : myRow.rank === 2 ? 'silver-glow' : myRow.rank === 3 ? 'bronze-glow' : ''}`}>
              <div className="my-card-header">
                <div className="my-rank-badge">
                  {myRow.rank === 1 ? (
                    <>
                      <Crown size={18} className="crown-icon" />
                      <b>1-o‘rin (Peshqadamsiz!)</b>
                    </>
                  ) : myRow.rank === 2 ? (
                    <>
                      <Medal size={18} />
                      <b>2-o‘rin (Ajoyib natija!)</b>
                    </>
                  ) : myRow.rank === 3 ? (
                    <>
                      <Award size={18} />
                      <b>3-o‘rin (Shoxsupadasiz!)</b>
                    </>
                  ) : (
                    <>
                      <User size={16} />
                      <b>{myRow.rank}-o‘rin ({totalSellers} ta sotuvchi ichida)</b>
                    </>
                  )}
                </div>

                <span className="my-share-pill">Ulushingiz: <b>{myRow.share_percent}%</b></span>
              </div>

              <div className="my-sales-row">
                <div>
                  <small>Sizning savdo natijangiz</small>
                  <h3>{formatMoney(myRow.total_sales)}</h3>
                </div>
                <div className="my-checks-box">
                  <span>Cheklar: <b>{myRow.checks_count} ta</b></span>
                  <span>Donalar: <b>{myRow.units_count} dona</b></span>
                </div>
              </div>

              {/* Progress bar */}
              <div className="my-progress-bar">
                <div
                  className="my-progress-fill"
                  style={{ width: `${Math.min(myRow.share_percent, 100)}%` }}
                />
              </div>

              {myRow.rank > 1 && top1 && (
                <div className="my-card-motivation">
                  1-o‘rindagi <b>{top1.seller_name}</b> bilan farq: <b>{formatMoney(Math.max(0, top1.total_sales - myRow.total_sales))}</b>
                </div>
              )}
            </div>
          )}

          {/* Top 3 Podium (Oliy 3 ta o'rin) */}
          <div className="seller-podium-block">
            <h3 className="seller-section-title">
              <Crown size={18} className="gold-icon" /> Eng oliy 3 ta o‘rin (Top 3)
            </h3>

            <div className="seller-podium-cards">
              {/* 2-o'rin */}
              <div className={`seller-podium-item rank-2 ${top2 ? '' : 'empty'}`}>
                <div className="seller-podium-badge silver">
                  <Medal size={15} /> 2-o‘rin
                </div>
                {top2 ? (
                  <>
                    <div className="seller-podium-avatar silver">
                      <span>{top2.seller_name?.charAt(0) || '2'}</span>
                    </div>
                    <b className="seller-podium-name">{top2.seller_name}</b>
                    <span className="seller-podium-sum">{formatMoney(top2.total_sales)}</span>
                    <small className="seller-podium-meta">{top2.checks_count} ta chek | {top2.share_percent}%</small>
                  </>
                ) : (
                  <span className="empty-text">—</span>
                )}
              </div>

              {/* 1-o'rin */}
              <div className={`seller-podium-item rank-1 ${top1 ? '' : 'empty'}`}>
                <div className="seller-crown-icon">
                  <Crown size={22} />
                </div>
                <div className="seller-podium-badge gold">
                  <Trophy size={16} /> 1-o‘rin
                </div>
                {top1 ? (
                  <>
                    <div className="seller-podium-avatar gold">
                      <span>{top1.seller_name?.charAt(0) || '1'}</span>
                    </div>
                    <b className="seller-podium-name">{top1.seller_name}</b>
                    <span className="seller-podium-sum">{formatMoney(top1.total_sales)}</span>
                    <small className="seller-podium-meta">{top1.checks_count} ta chek | {top1.share_percent}%</small>
                  </>
                ) : (
                  <span className="empty-text">—</span>
                )}
              </div>

              {/* 3-o'rin */}
              <div className={`seller-podium-item rank-3 ${top3 ? '' : 'empty'}`}>
                <div className="seller-podium-badge bronze">
                  <Award size={15} /> 3-o‘rin
                </div>
                {top3 ? (
                  <>
                    <div className="seller-podium-avatar bronze">
                      <span>{top3.seller_name?.charAt(0) || '3'}</span>
                    </div>
                    <b className="seller-podium-name">{top3.seller_name}</b>
                    <span className="seller-podium-sum">{formatMoney(top3.total_sales)}</span>
                    <small className="seller-podium-meta">{top3.checks_count} ta chek | {top3.share_percent}%</small>
                  </>
                ) : (
                  <span className="empty-text">—</span>
                )}
              </div>
            </div>
          </div>

          {/* Full List of Colleagues (1 dan N gacha barcha sheriklar) */}
          <div className="seller-list-block card">
            <div className="seller-list-head">
              <div>
                <h3>Barcha sheriklar natijasi</h3>
                <small>Jami {totalSellers} nafar sotuvchi | Filial savdosi: {formatMoney(branchTotalSales)}</small>
              </div>
            </div>

            <div className="seller-colleagues-list">
              {items.map(row => {
                const isMe = row.seller_id === mySellerId;
                const isGold = row.rank === 1;
                const isSilver = row.rank === 2;
                const isBronze = row.rank === 3;

                return (
                  <div
                    key={row.seller_id}
                    className={`seller-row-card ${isMe ? 'is-me' : ''} ${isGold ? 'is-gold' : isSilver ? 'is-silver' : isBronze ? 'is-bronze' : ''}`}
                  >
                    <div className="seller-row-left">
                      <div className={`seller-rank-number ${isGold ? 'gold' : isSilver ? 'silver' : isBronze ? 'bronze' : ''}`}>
                        {isGold ? <Crown size={14} /> : isSilver ? <Medal size={14} /> : isBronze ? <Award size={14} /> : null}
                        <span>{row.rank}</span>
                      </div>

                      <div className="seller-row-person">
                        <div className="seller-row-name-group">
                          <b>{row.seller_name}</b>
                          {isMe && <span className="seller-me-badge">Siz</span>}
                        </div>
                        <small>{row.seller_phone || 'Telefon yo‘q'}</small>
                      </div>
                    </div>

                    <div className="seller-row-right">
                      <b className="seller-row-sales">{formatMoney(row.total_sales)}</b>
                      <div className="seller-row-stats">
                        <span>{row.checks_count} chek</span>
                        <span>•</span>
                        <span>{row.share_percent}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {!items.length && (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>
                  Ushbu davrda sotuvlar mavjud emas.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
