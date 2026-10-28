import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Award, Calendar, CheckCircle2, ChevronLeft, ChevronRight, Crown,
  Medal, Package, Receipt, RefreshCw, Sparkles, TrendingUp, Trophy, Users,
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
    // Start of week (Monday)
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

  // 'day'
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

export default function RatingWorkspace({ branchId, toast }) {
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
  const top1 = items.find(i => i.rank === 1);
  const top2 = items.find(i => i.rank === 2);
  const top3 = items.find(i => i.rank === 3);

  const branchTotalSales = Number(data?.branch_total_sales || 0);
  const branchTotalChecks = Number(data?.branch_total_checks || 0);
  const branchTotalUnits = Number(data?.branch_total_units || 0);
  const totalSellers = Number(data?.total_sellers || items.length || 0);

  return (
    <div className="rating-workspace ops-workspace">
      {/* Header */}
      <header className="rating-header card">
        <div className="rating-header-main">
          <div className="rating-title-group">
            <span className="rating-badge">
              <Trophy size={16} /> Sotuvchilar musobaqasi
            </span>
            <h2>Reyting va peshqadamlar</h2>
            <p>
              Filial sotuvchilarining kunlik, haftalik, oylik va yillik savdo natijalari va o‘rinlari.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-secondary rating-refresh-btn"
            onClick={load}
            disabled={loading}
            title="Yangilash"
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            <span>Yangilash</span>
          </button>
        </div>

        {/* Toolbar: Period selector & Date Picker */}
        <div className="rating-toolbar">
          <div className="rating-period-tabs">
            {[
              { id: 'day', label: 'Kunlik' },
              { id: 'week', label: 'Haftalik' },
              { id: 'month', label: 'Oylik' },
              { id: 'year', label: 'Yillik' },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                className={`rating-tab-btn ${period === tab.id ? 'active' : ''}`}
                onClick={() => setPeriod(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="rating-date-controls">
            <div className="rating-nav-buttons">
              <button
                type="button"
                className="btn-icon-subtle"
                onClick={() => setTargetDate(curr => shiftDate(curr, period, -1))}
                title="Oldingi"
              >
                <ChevronLeft size={18} />
              </button>

              <button
                type="button"
                className={`rating-today-btn ${isToday ? 'active' : ''}`}
                onClick={() => setTargetDate(todayStr)}
              >
                Bugun
              </button>

              <button
                type="button"
                className="btn-icon-subtle"
                onClick={() => setTargetDate(curr => shiftDate(curr, period, 1))}
                title="Keyingi"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <label className="rating-date-picker-label">
              <Calendar size={16} />
              <input
                type="date"
                value={targetDate}
                max="2099-12-31"
                onChange={e => e.target.value && setTargetDate(e.target.value)}
                className="rating-date-input"
              />
            </label>

            <span className="rating-current-period-text">
              {formatDateDisplay(targetDate, period)}
            </span>
          </div>
        </div>
      </header>

      {/* States */}
      {loading ? (
        <div className="ops-state">
          <RefreshCw size={28} className="spin" />
          <p>Reyting ma’lumotlari hisoblanmoqda…</p>
        </div>
      ) : error ? (
        <div className="ops-state ops-error">
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={load} style={{ marginTop: 12 }}>
            Qayta urinish
          </button>
        </div>
      ) : (
        <>
          {/* Branch Summary Stat Cards */}
          <div className="rating-summary-grid">
            <div className="rating-stat-card primary">
              <div className="stat-icon-wrap">
                <TrendingUp size={24} />
              </div>
              <div className="stat-info">
                <span>Filial jami savdosi</span>
                <b>{formatMoney(branchTotalSales)}</b>
                <small>{formatDateDisplay(targetDate, period)}</small>
              </div>
            </div>

            <div className="rating-stat-card">
              <div className="stat-icon-wrap checks">
                <Receipt size={22} />
              </div>
              <div className="stat-info">
                <span>Jami cheklar soni</span>
                <b>{branchTotalChecks.toLocaleString('uz-UZ')} ta</b>
                <small>Barcha sotuvchilar bo‘yicha</small>
              </div>
            </div>

            <div className="rating-stat-card">
              <div className="stat-icon-wrap units">
                <Package size={22} />
              </div>
              <div className="stat-info">
                <span>Sotilgan tovarlar</span>
                <b>{branchTotalUnits.toLocaleString('uz-UZ')} dona</b>
                <small>Real sotilgan birliklar</small>
              </div>
            </div>

            <div className="rating-stat-card">
              <div className="stat-icon-wrap sellers">
                <Users size={22} />
              </div>
              <div className="stat-info">
                <span>Jami sotuvchilar</span>
                <b>{totalSellers} nafar</b>
                <small>Barchasi reytingda qatnashmoqda</small>
              </div>
            </div>
          </div>

          {/* Top 3 Podium Cards */}
          {items.length > 0 && (
            <section className="rating-podium-section">
              <h3 className="rating-section-title">
                <Crown size={20} className="gold-icon" /> Eng oliy 3 ta o‘rin (Top 3)
              </h3>

              <div className="rating-podium-grid">
                {/* 2-o'rin (Silver) */}
                <div className={`podium-card rank-2 ${top2 ? '' : 'empty'}`}>
                  <div className="podium-badge silver">
                    <Medal size={20} />
                    <span>2-o‘rin</span>
                  </div>
                  {top2 ? (
                    <>
                      <div className="podium-avatar silver">
                        <span>{top2.seller_name?.charAt(0) || '2'}</span>
                      </div>
                      <h4 className="podium-name">{top2.seller_name}</h4>
                      <p className="podium-phone">{top2.seller_phone || 'Telefon yo‘q'}</p>
                      <div className="podium-amount">{formatMoney(top2.total_sales)}</div>
                      <div className="podium-meta">
                        <span>Ulush: <b>{top2.share_percent}%</b></span>
                        <span>Cheklar: <b>{top2.checks_count} ta</b></span>
                        <span>Donalar: <b>{top2.units_count} ta</b></span>
                      </div>
                    </>
                  ) : (
                    <div className="podium-empty">Sotuvchi yo‘q</div>
                  )}
                </div>

                {/* 1-o'rin (Gold) */}
                <div className={`podium-card rank-1 ${top1 ? '' : 'empty'}`}>
                  <div className="podium-crown">
                    <Crown size={28} />
                  </div>
                  <div className="podium-badge gold">
                    <Trophy size={20} />
                    <span>1-o‘rin (Peshqadam)</span>
                  </div>
                  {top1 ? (
                    <>
                      <div className="podium-avatar gold">
                        <span>{top1.seller_name?.charAt(0) || '1'}</span>
                      </div>
                      <h4 className="podium-name">{top1.seller_name}</h4>
                      <p className="podium-phone">{top1.seller_phone || 'Telefon yo‘q'}</p>
                      <div className="podium-amount">{formatMoney(top1.total_sales)}</div>
                      <div className="podium-meta">
                        <span>Ulush: <b>{top1.share_percent}%</b></span>
                        <span>Cheklar: <b>{top1.checks_count} ta</b></span>
                        <span>Donalar: <b>{top1.units_count} ta</b></span>
                      </div>
                      {top1.average_check > 0 && (
                        <div className="podium-aov">
                          O‘rtacha chek: <b>{formatMoney(top1.average_check)}</b>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="podium-empty">Sotuvchi yo‘q</div>
                  )}
                </div>

                {/* 3-o'rin (Bronze) */}
                <div className={`podium-card rank-3 ${top3 ? '' : 'empty'}`}>
                  <div className="podium-badge bronze">
                    <Award size={20} />
                    <span>3-o‘rin</span>
                  </div>
                  {top3 ? (
                    <>
                      <div className="podium-avatar bronze">
                        <span>{top3.seller_name?.charAt(0) || '3'}</span>
                      </div>
                      <h4 className="podium-name">{top3.seller_name}</h4>
                      <p className="podium-phone">{top3.seller_phone || 'Telefon yo‘q'}</p>
                      <div className="podium-amount">{formatMoney(top3.total_sales)}</div>
                      <div className="podium-meta">
                        <span>Ulush: <b>{top3.share_percent}%</b></span>
                        <span>Cheklar: <b>{top3.checks_count} ta</b></span>
                        <span>Donalar: <b>{top3.units_count} ta</b></span>
                      </div>
                    </>
                  ) : (
                    <div className="podium-empty">Sotuvchi yo‘q</div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Full Leaderboard Table (1 dan N gacha) */}
          <section className="rating-table-card card">
            <div className="rating-table-header">
              <div>
                <h3>To‘liq sotuvchilar reytingi</h3>
                <small>Barcha {totalSellers} ta sotuvchining egallagan o‘rni va savdo ko‘rsatkichlari</small>
              </div>
              <span className="rating-count-pill">{items.length} nafar sotuvchi</span>
            </div>

            <div className="table-wrap">
              <table className="table rating-table">
                <thead>
                  <tr>
                    <th style={{ width: 75 }}>O‘rni</th>
                    <th>Sotuvchi</th>
                    <th style={{ textAlign: 'right' }}>Jami savdo</th>
                    <th style={{ width: 170 }}>Filial ulushi (%)</th>
                    <th style={{ textAlign: 'center' }}>Cheklar</th>
                    <th style={{ textAlign: 'center' }}>Donalar</th>
                    <th style={{ textAlign: 'right' }}>O‘rtacha chek</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(row => {
                    const isGold = row.rank === 1;
                    const isSilver = row.rank === 2;
                    const isBronze = row.rank === 3;
                    const isTop3 = isGold || isSilver || isBronze;

                    return (
                      <tr
                        key={row.seller_id}
                        className={`rating-row ${isGold ? 'row-gold' : isSilver ? 'row-silver' : isBronze ? 'row-bronze' : ''}`}
                      >
                        {/* Rank */}
                        <td>
                          <div className={`rank-pill ${isGold ? 'gold' : isSilver ? 'silver' : isBronze ? 'bronze' : 'normal'}`}>
                            {isGold ? (
                              <Crown size={15} />
                            ) : isSilver ? (
                              <Medal size={15} />
                            ) : isBronze ? (
                              <Award size={15} />
                            ) : null}
                            <span>{row.rank}-o‘rin</span>
                          </div>
                        </td>

                        {/* Seller */}
                        <td>
                          <div className="rating-seller-cell">
                            <div className={`seller-avatar-mini ${isTop3 ? 'top' : ''}`}>
                              {row.seller_name?.charAt(0) || 'S'}
                            </div>
                            <div>
                              <b>{row.seller_name}</b>
                              <small>{row.seller_phone || 'Telefon kiritilmagan'}</small>
                            </div>
                          </div>
                        </td>

                        {/* Total Sales */}
                        <td style={{ textAlign: 'right' }}>
                          <span className="rating-sales-sum">
                            {formatMoney(row.total_sales)}
                          </span>
                        </td>

                        {/* Share & Progress Bar */}
                        <td>
                          <div className="rating-share-cell">
                            <div className="rating-share-text">
                              <b>{row.share_percent}%</b>
                            </div>
                            <div className="rating-progress-bar">
                              <div
                                className={`rating-progress-fill ${isGold ? 'gold' : isSilver ? 'silver' : isBronze ? 'bronze' : ''}`}
                                style={{ width: `${Math.min(row.share_percent, 100)}%` }}
                              />
                            </div>
                          </div>
                        </td>

                        {/* Checks */}
                        <td style={{ textAlign: 'center' }}>
                          <span className="count-pill">{row.checks_count} ta</span>
                        </td>

                        {/* Units */}
                        <td style={{ textAlign: 'center' }}>
                          <span className="count-pill units">{row.units_count} ta</span>
                        </td>

                        {/* Average check */}
                        <td style={{ textAlign: 'right' }}>
                          <span className="rating-aov-text">
                            {row.average_check > 0 ? formatMoney(row.average_check) : '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}

                  {!items.length && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 36, color: 'var(--muted)' }}>
                        Tanlangan davrda sotuvlar mavjud emas.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
