import React, { useState, useEffect, useMemo } from 'react';
import { TrendingUp, X, Search, RotateCcw, Download, Clock, User, Tag, ArrowUpDown, ChevronDown, CheckCircle2, AlertCircle } from 'lucide-react';
import { DualPrice } from '@texnobazar/ui';
import { getPosConfirmedProfitDetails } from '@texnobazar/data';

function formatTashkentDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch {
    return isoStr;
  }
}

function formatTashkentTimeOnly(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch {
    return isoStr;
  }
}

export function CashProfitDetailsModal({
  open,
  onClose,
  branchId,
  dateRange,
  datePreset = 'today',
  periodTitle = 'Bugun',
  rate
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({});
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('time_desc');

  const loadData = async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const res = await getPosConfirmedProfitDetails({
        branchId,
        startDate: dateRange?.startDate || null,
        endDate: dateRange?.endDate || null
      });
      setItems(res?.items || []);
      setSummary(res?.summary || {});
    } catch (err) {
      console.error('Failed to load profit details:', err);
      setError(err?.message || 'Foyda tafsilotlarini yuklashda xatolik yuz berdi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadData();
    }
  }, [open, branchId, dateRange?.startDate, dateRange?.endDate]);

  const filteredItems = useMemo(() => {
    let list = [...items];
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(it =>
        (it.product_name && it.product_name.toLowerCase().includes(q)) ||
        (it.sku && it.sku.toLowerCase().includes(q)) ||
        (it.qr_code && it.qr_code.toLowerCase().includes(q)) ||
        (it.seller_name && it.seller_name.toLowerCase().includes(q)) ||
        (it.sale_no && it.sale_no.toLowerCase().includes(q)) ||
        (it.payment_methods && it.payment_methods.toLowerCase().includes(q))
      );
    }

    if (sortBy === 'time_desc') {
      list.sort((a, b) => new Date(b.sold_at || 0) - new Date(a.sold_at || 0));
    } else if (sortBy === 'time_asc') {
      list.sort((a, b) => new Date(a.sold_at || 0) - new Date(b.sold_at || 0));
    } else if (sortBy === 'profit_desc') {
      list.sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0));
    } else if (sortBy === 'profit_asc') {
      list.sort((a, b) => Number(a.profit || 0) - Number(b.profit || 0));
    } else if (sortBy === 'revenue_desc') {
      list.sort((a, b) => Number(b.line_total || 0) - Number(a.line_total || 0));
    } else if (sortBy === 'cost_desc') {
      list.sort((a, b) => Number(b.unit_cost || 0) - Number(a.unit_cost || 0));
    }
    return list;
  }, [items, search, sortBy]);

  const exportCsv = () => {
    if (!filteredItems.length) return;
    const headers = [
      '#',
      'Tovar nomi',
      'SKU',
      'QR kod',
      'Sotuvchi',
      'Sotilgan sana va vaqt',
      'Tan narxi (so‘m)',
      'Aytish (sotish) narxi (so‘m)',
      'Sotilgan narx (so‘m)',
      'Chegirma (so‘m)',
      'Qolgan foyda (so‘m)',
      'To‘lov usuli',
      'Chek raqami'
    ];

    const rows = filteredItems.map((it, idx) => [
      idx + 1,
      `"${(it.product_name || '').replace(/"/g, '""')}"`,
      `"${(it.sku || '').replace(/"/g, '""')}"`,
      `"${(it.qr_code || '').replace(/"/g, '""')}"`,
      `"${(it.seller_name || '').replace(/"/g, '""')}"`,
      `"${formatTashkentDateTime(it.sold_at)}"`,
      it.unit_cost || 0,
      it.retail_price || 0,
      it.unit_price || 0,
      it.discount || 0,
      it.profit || 0,
      `"${(it.payment_methods || '').replace(/"/g, '""')}"`,
      `"${(it.sale_no || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sof_foyda_${dateRange?.startDate || 'bugun'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  const totalRev = Number(summary.total_revenue || 0);
  const totalCost = Number(summary.total_cost || 0);
  const totalProfit = Number(summary.total_profit || 0);
  const marginPct = totalRev > 0 ? Math.round((totalProfit / totalRev) * 100) : 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1050,
        background: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: '#ffffff',
          borderRadius: 16,
          width: '100%',
          maxWidth: 1200,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          overflow: 'hidden',
          animation: 'fadeSlideUp 0.2s ease-out'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'linear-gradient(to right, #f8fafc, #ffffff)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: totalProfit >= 0 ? '#dcfce7' : '#fee2e2',
                color: totalProfit >= 0 ? '#15803d' : '#b91c1c',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <TrendingUp size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0f172a' }}>
                {datePreset === 'today' ? 'Bugungi sof foyda tafsilotlari' : `Sof foyda tafsilotlari (${periodTitle})`}
              </h3>
              <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                Tasdiqlangan barcha tovarlar: tan narxi, aytish narxi, sotilgan narxi va sof foyda
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: 'none',
              borderRadius: 8,
              width: 34,
              height: 34,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#475569',
              cursor: 'pointer'
            }}
            title="Yopish"
          >
            <X size={18} />
          </button>
        </div>

        {/* Summary Stats Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 10,
            padding: '12px 20px',
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0'
          }}
        >
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px' }}>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block' }}>Sotilgan tovarlar</span>
            <b style={{ fontSize: 16, color: '#0f172a' }}>
              {summary.total_items || 0} <small style={{ fontSize: 11, fontWeight: 500, color: '#64748b' }}>ta pozitsiya</small>
            </b>
            <span style={{ fontSize: 11, color: '#0284c7', display: 'block', marginTop: 2 }}>
              Jami: {summary.total_quantity || 0} dona
            </span>
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px' }}>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block' }}>Jami savdo tushumi</span>
            <b style={{ fontSize: 16, color: '#0f172a' }}>
              <DualPrice value={totalRev} rate={rate} />
            </b>
            <span style={{ fontSize: 11, color: '#16a34a', display: 'block', marginTop: 2 }}>
              Tushum (100%)
            </span>
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px' }}>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, display: 'block' }}>Jami tannarx</span>
            <b style={{ fontSize: 16, color: '#475569' }}>
              <DualPrice value={totalCost} rate={rate} />
            </b>
            <span style={{ fontSize: 11, color: '#64748b', display: 'block', marginTop: 2 }}>
              Xarajat qiymati
            </span>
          </div>

          <div
            style={{
              background: totalProfit >= 0 ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${totalProfit >= 0 ? '#bbf7d0' : '#fecaca'}`,
              borderRadius: 10,
              padding: '10px 14px'
            }}
          >
            <span style={{ fontSize: 11, color: totalProfit >= 0 ? '#166534' : '#991b1b', fontWeight: 700, display: 'block' }}>
              Sof foyda ({marginPct}% marja)
            </span>
            <b style={{ fontSize: 16, color: totalProfit >= 0 ? '#15803d' : '#b91c1c' }}>
              <DualPrice value={totalProfit} rate={rate} />
            </b>
            <span style={{ fontSize: 11, color: totalProfit >= 0 ? '#15803d' : '#b91c1c', display: 'block', marginTop: 2 }}>
              Savdo - Tannarx
            </span>
          </div>
        </div>

        {/* Toolbar: Search, Sort, Export */}
        <div
          style={{
            padding: '10px 20px',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
            background: '#fff'
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: '4px 10px',
              flex: '1 1 280px',
              maxWidth: 420
            }}
          >
            <Search size={15} color="#94a3b8" />
            <input
              type="text"
              placeholder="Tovar nomi, SKU, QR yoki sotuvchi..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 13,
                width: '100%',
                color: '#0f172a'
              }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: '#94a3b8' }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: '#64748b' }}>Saralash:</span>
              <select
                className="select select-sm"
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                style={{ fontSize: 12.5, borderRadius: 8, padding: '4px 8px' }}
              >
                <option value="time_desc">🕒 Vaqt: Yangilari oldin</option>
                <option value="time_asc">🕒 Vaqt: Eskilari oldin</option>
                <option value="profit_desc">📈 Foyda: Ko‘pdan kamga ↓</option>
                <option value="profit_asc">📉 Foyda: Kamdan ko‘pga ↑</option>
                <option value="revenue_desc">💰 Sotilgan narx: Qimmatdan arzoniga ↓</option>
                <option value="cost_desc">🏷️ Tannarx: Qimmatdan arzoniga ↓</option>
              </select>
            </div>

            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={loadData}
              disabled={loading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, borderRadius: 8 }}
              title="Ma’lumotlarni yangilash"
            >
              <RotateCcw size={13} className={loading ? 'spin' : ''} />
              Yangilash
            </button>

            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={exportCsv}
              disabled={!filteredItems.length}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12.5,
                borderRadius: 8,
                color: '#15803d',
                borderColor: '#bbf7d0',
                background: '#f0fdf4'
              }}
              title="Jadvalni Excel (CSV) fayl sifatida yuklab olish"
            >
              <Download size={13} />
              Excel / CSV
            </button>
          </div>
        </div>

        {/* Table Content */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 280, position: 'relative' }}>
          {loading ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: '#64748b' }}>
              <RotateCcw size={24} className="spin" style={{ margin: '0 auto 10px', display: 'block', color: 'var(--primary, #0284c7)' }} />
              <span>Sotilgan tovarlar va foyda tafsilotlari yuklanmoqda…</span>
            </div>
          ) : error ? (
            <div style={{ padding: '30px 20px', textAlign: 'center', color: '#b91c1c' }}>
              <AlertCircle size={24} style={{ margin: '0 auto 8px', display: 'block' }} />
              <span>{error}</span>
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={loadData}>Qayta urinish</button>
              </div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: '50px 20px', textAlign: 'center', color: '#94a3b8' }}>
              <TrendingUp size={32} style={{ margin: '0 auto 10px', display: 'block', opacity: 0.5 }} />
              <b style={{ fontSize: 14, color: '#475569', display: 'block' }}>
                {search ? 'Qidiruv bo‘yicha tovarlar topilmadi' : 'Tanlangan davrda tasdiqlangan savdo mavjud emas'}
              </b>
              <small style={{ fontSize: 12 }}>{search ? 'Boshqa so‘z bilan qidirib ko‘ring' : 'Kassa kirimi tasdiqlangach bu yerda chiqadi'}</small>
            </div>
          ) : (
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12.5,
                textAlign: 'left'
              }}
            >
              <thead
                style={{
                  position: 'sticky',
                  top: 0,
                  background: '#f8fafc',
                  zIndex: 2,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                }}
              >
                <tr style={{ color: '#475569', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '10px 12px', fontWeight: 700, width: 40 }}>#</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700 }}>Tovar nomi va SKU</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700 }}>Sotuvchi</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700 }}>Vaqti</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700, textAlign: 'right' }}>Tan narxi</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700, textAlign: 'right' }}>Aytish narxi</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700, textAlign: 'right' }}>Sotilgan narx</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700, textAlign: 'right' }}>Qolgan foyda</th>
                  <th style={{ padding: '10px 12px', fontWeight: 700 }}>To‘lov usuli</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, index) => {
                  const unitCost = Number(item.unit_cost || 0);
                  const retailPrice = Number(item.retail_price || 0);
                  const unitPrice = Number(item.unit_price || 0);
                  const profit = Number(item.profit || 0);
                  const discount = Number(item.discount || 0);
                  const isProfitPos = profit >= 0;

                  return (
                    <tr
                      key={`${item.pending_id}_${item.product_id}_${index}`}
                      style={{
                        borderBottom: '1px solid #f1f5f9',
                        transition: 'background 0.15s ease'
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: 11 }}>
                        {index + 1}
                      </td>

                      <td style={{ padding: '10px 12px', minWidth: 200 }}>
                        <b style={{ color: '#0f172a', display: 'block', fontSize: 13 }}>
                          {item.product_name}
                        </b>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                          {item.sku && (
                            <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>
                              {item.sku}
                            </span>
                          )}
                          {item.qr_code && (
                            <span
                              style={{
                                fontSize: 10,
                                background: '#eff6ff',
                                color: '#1d4ed8',
                                border: '1px solid #bfdbfe',
                                padding: '0 5px',
                                borderRadius: 4,
                                fontFamily: 'monospace'
                              }}
                            >
                              QR: {item.qr_code}
                            </span>
                          )}
                          {Number(item.quantity || 1) > 1 && (
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#f97316' }}>
                              × {item.quantity} dona
                            </span>
                          )}
                        </div>
                      </td>

                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#334155', fontWeight: 600 }}>
                          <User size={12} color="#94a3b8" />
                          {item.seller_name}
                        </span>
                      </td>

                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <div style={{ fontSize: 12, color: '#334155', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Clock size={12} color="#94a3b8" />
                          <b>{formatTashkentTimeOnly(item.sold_at)}</b>
                        </div>
                        <small style={{ display: 'block', color: '#94a3b8', fontSize: 10 }}>
                          {formatTashkentDateTime(item.sold_at).split(' ')[0]}
                        </small>
                      </td>

                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span style={{ color: '#475569', fontWeight: 600 }}>
                          <DualPrice value={unitCost} rate={rate} />
                        </span>
                      </td>

                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span style={{ color: '#475569', fontWeight: 600 }}>
                          <DualPrice value={retailPrice} rate={rate} />
                        </span>
                      </td>

                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <b style={{ color: '#0284c7', fontSize: 13, fontWeight: 750 }}>
                          <DualPrice value={unitPrice} rate={rate} />
                        </b>
                        {discount > 0 && (
                          <small style={{ display: 'block', color: '#d97706', fontSize: 10 }}>
                            -{new Intl.NumberFormat('uz-UZ').format(discount)} chegirma
                          </small>
                        )}
                      </td>

                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 8px',
                            borderRadius: 6,
                            background: isProfitPos ? '#f0fdf4' : '#fef2f2',
                            color: isProfitPos ? '#15803d' : '#b91c1c',
                            border: `1px solid ${isProfitPos ? '#bbf7d0' : '#fecaca'}`,
                            fontWeight: 750,
                            fontSize: 12
                          }}
                        >
                          <DualPrice value={profit} rate={rate} />
                        </span>
                      </td>

                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <span
                          style={{
                            fontSize: 11,
                            padding: '2px 7px',
                            borderRadius: 6,
                            background: '#f8fafc',
                            color: '#475569',
                            border: '1px solid #e2e8f0',
                            fontWeight: 600
                          }}
                        >
                          {item.payment_methods || 'Naqd'}
                        </span>
                        {item.sale_no && (
                          <small style={{ display: 'block', color: '#94a3b8', fontSize: 9.5, fontFamily: 'monospace', marginTop: 2 }}>
                            {item.sale_no}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            background: '#f8fafc',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10
          }}
        >
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Ko‘rsatilyapti: <b>{filteredItems.length}</b> / {items.length} ta sotilgan tovar
            {search && <span style={{ marginLeft: 6, color: '#0284c7' }}>(Filtrlangan)</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={onClose}
              style={{ padding: '6px 18px', fontSize: 13, borderRadius: 8 }}
            >
              Yopish
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
