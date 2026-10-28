import React, { useEffect, useState, useMemo } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Calendar,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  Flame,
  Layers,
  MapPin,
  Package,
  Search,
  Sparkles,
  Store,
  TrendingDown,
  TrendingUp,
  Warehouse,
  X
} from 'lucide-react';
import { DualPrice, Modal, Status, formatMoney, useExchangeRate } from '@texnobazar/ui';
import { getLowStockProducts, getProductSalesAnalytics } from '@texnobazar/data';

/**
 * LowStockModal: Do'konda 5 dona yoki undan kam qolgan tovarlar modali
 */
export function LowStockModal({ open, onClose, branchId, onGoTransfer, onGoBatch }) {
  const rate = useExchangeRate();
  const [items, setItems] = useState([]);
  const [threshold, setThreshold] = useState(5);
  const [locationId, setLocationId] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    if (!branchId || !open) return;
    setLoading(true);
    setError('');
    try {
      const res = await getLowStockProducts({
        branchId,
        threshold,
        locationId: locationId || null,
        limit: 250
      });
      setItems(res?.items || []);
    } catch (e) {
      setError(e?.message || 'Kam qolgan tovarlarni yuklab bo‘lmadi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId, open, threshold, locationId]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      i =>
        (i.product_name && i.product_name.toLowerCase().includes(q)) ||
        (i.sku && i.sku.toLowerCase().includes(q)) ||
        (i.category_name && i.category_name.toLowerCase().includes(q))
    );
  }, [items, query]);

  const totalValue = useMemo(() => {
    return filteredItems.reduce((acc, i) => acc + (Number(i.available || 0) * Number(i.retail_price || 0)), 0);
  }, [filteredItems]);

  const totalUnits = useMemo(() => {
    return filteredItems.reduce((acc, i) => acc + Number(i.available || 0), 0);
  }, [filteredItems]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Kam qolgan tovarlar (Qoldig'i ≤ 5 dona)"
      wide
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* KPI Mini Header */}
        <div className="admin-report-kpis" style={{ margin: 0 }}>
          <div>
            <AlertTriangle size={20} style={{ color: '#ea580c' }} />
            <div>
              <small>Kam qolgan turlar</small>
              <b>{filteredItems.length} ta tovar</b>
            </div>
          </div>
          <div>
            <Boxes size={20} style={{ color: '#0284c7' }} />
            <div>
              <small>Mavjud qoldiq soni</small>
              <b>{totalUnits} dona</b>
            </div>
          </div>
          <div>
            <Store size={20} style={{ color: '#16a34a' }} />
            <div>
              <small>Qoldiq umumiy qiymati</small>
              <DualPrice value={totalValue} rate={rate} bold />
            </div>
          </div>
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px', background: 'var(--surface, #fff)', height: 38 }}>
            <Search size={15} style={{ color: 'var(--muted)' }} />
            <input
              style={{ border: 0, outline: 0, width: '100%', background: 'transparent', fontSize: 13 }}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Mahsulot nomi yoki SKU bo'yicha tezkor qidiruv..."
            />
            {query && (
              <button
                type="button"
                className="icon-btn"
                style={{ border: 0, background: 'none', cursor: 'pointer', padding: 2, color: 'var(--muted)' }}
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <select
            className="select"
            style={{ height: 38, minWidth: 150 }}
            value={threshold}
            onChange={e => setThreshold(Number(e.target.value))}
          >
            <option value={5}>Chegara: ≤ 5 dona</option>
            <option value={3}>Chegara: ≤ 3 dona</option>
            <option value={2}>Chegara: ≤ 2 dona</option>
            <option value={1}>Chegara: ≤ 1 dona</option>
            <option value={0}>Faqat tugagan (0 dona)</option>
          </select>
        </div>

        {/* Main Content */}
        {loading ? (
          <div className="ops-state" style={{ padding: 30 }}>Yuklanmoqda…</div>
        ) : error ? (
          <div className="ops-state ops-error" style={{ padding: 20 }}>
            <AlertTriangle />
            <p>{error}</p>
            <button type="button" className="btn" onClick={load}>Qayta urinish</button>
          </div>
        ) : filteredItems.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
            <Check size={32} style={{ color: '#16a34a', margin: '0 auto 8px', display: 'block' }} />
            <b>Kam qolgan tovarlar topilmadi</b>
            <p style={{ margin: '4px 0 0', fontSize: 12 }}>Ushbu mezon bo‘yicha tovarlar yetarli miqdorda mavjud.</p>
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Mahsulot</th>
                  <th>Joylashuv</th>
                  <th style={{ textAlign: 'center' }}>Qoldiq</th>
                  <th>Sotish narxi</th>
                  <th>Tannarx</th>
                  <th style={{ textAlign: 'right' }}>Amal</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map(item => {
                  const qty = Number(item.available || 0);
                  const isZero = qty <= 0;
                  const isCrit = qty <= 2;
                  return (
                    <tr key={`${item.product_id}-${item.location_id}`}>
                      <td>
                        <div className="product-cell">
                          {item.image ? (
                            <img src={item.image} alt="" />
                          ) : (
                            <span className="product-placeholder">
                              <Package size={16} />
                            </span>
                          )}
                          <div>
                            <b>{item.product_name}</b>
                            <span>{item.sku} {item.category_name ? `· ${item.category_name}` : ''}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{item.location_name}</span>
                        <br />
                        <small style={{ color: 'var(--muted)', fontSize: 10 }}>{item.location_type === 'store' ? 'Do‘kon' : 'Ombor'}</small>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 10px',
                            borderRadius: 12,
                            fontWeight: 800,
                            fontSize: 12,
                            background: isZero ? '#fee2e2' : isCrit ? '#ffedd5' : '#fef9c3',
                            color: isZero ? '#b91c1c' : isCrit ? '#c2410c' : '#854d0e',
                            border: `1px solid ${isZero ? '#fca5a5' : isCrit ? '#fdba74' : '#fde047'}`
                          }}
                        >
                          {qty} dona
                        </span>
                      </td>
                      <td>
                        <DualPrice
                          value={Number(item.retail_price || 0)}
                          usdValue={item.retail_price_usd != null ? Number(item.retail_price_usd) : undefined}
                          rate={rate}
                          bold
                        />
                      </td>
                      <td>
                        <DualPrice
                          value={Number(item.cost_price || 0)}
                          usdValue={item.cost_price_usd != null ? Number(item.cost_price_usd) : undefined}
                          rate={rate}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {onGoTransfer && (
                            <button
                              type="button"
                              className="btn btn-sm btn-outline"
                              style={{ fontSize: 11, padding: '4px 8px' }}
                              title="Boshqa filialdan transfer so'rash"
                              onClick={() => {
                                onClose();
                                onGoTransfer(item);
                              }}
                            >
                              Transfer
                            </button>
                          )}
                          {onGoBatch && (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              style={{ fontSize: 11, padding: '4px 8px' }}
                              title="Kirim qilish (partiya)"
                              onClick={() => {
                                onClose();
                                onGoBatch(item);
                              }}
                            >
                              Kirim
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * ProductSalesAnalyticsModal: Eng ko'p va kam sotilayotgan, eng ko'p foyda keltirayotgan tovarlar (Top 50)
 */
export function ProductSalesAnalyticsModal({ open, onClose, branchId }) {
  const rate = useExchangeRate();
  const [tab, setTab] = useState('profit'); // 'profit' | 'sold' | 'least'
  const [data, setData] = useState({ top_profit: [], top_sold: [], least_sold: [] });
  const [days, setDays] = useState(90);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    if (!branchId || !open) return;
    setLoading(true);
    setError('');
    try {
      const now = new Date();
      const fromDate = new Date();
      fromDate.setDate(now.getDate() - days);
      const fromStr = fromDate.toISOString().slice(0, 10);
      const toStr = now.toISOString().slice(0, 10);

      const res = await getProductSalesAnalytics({
        branchId,
        from: fromStr,
        to: toStr,
        limit: 50
      });
      setData(res || { top_profit: [], top_sold: [], least_sold: [] });
    } catch (e) {
      setError(e?.message || 'Savdo tahlilini yuklab bo‘lmadi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId, open, days]);

  const rawList = tab === 'profit' ? data.top_profit : tab === 'sold' ? data.top_sold : data.least_sold;

  const currentList = useMemo(() => {
    const list = rawList || [];
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter(
      i =>
        (i.product_name && i.product_name.toLowerCase().includes(q)) ||
        (i.sku && i.sku.toLowerCase().includes(q)) ||
        (i.category_name && i.category_name.toLowerCase().includes(q))
    );
  }, [rawList, query]);

  // Overall totals for current tab
  const tabTotals = useMemo(() => {
    const list = currentList || [];
    const totalSold = list.reduce((s, i) => s + Number(i.sold_count || 0), 0);
    const totalRev = list.reduce((s, i) => s + Number(i.total_revenue || 0), 0);
    const totalProfit = list.reduce((s, i) => s + Number(i.gross_profit || 0), 0);
    return { totalSold, totalRev, totalProfit };
  }, [currentList]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Eng ko‘p va kam sotilayotgan tovarlar (Top 50 tahlil)"
      wide
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* KPI Top Cards */}
        <div className="admin-report-kpis" style={{ margin: 0 }}>
          <div>
            <Sparkles size={20} style={{ color: '#16a34a' }} />
            <div>
              <small>Ushbu ro‘yxatdagi sof foyda</small>
              <DualPrice value={tabTotals.totalProfit} rate={rate} bold />
            </div>
          </div>
          <div>
            <Store size={20} style={{ color: '#ea580c' }} />
            <div>
              <small>Jami savdo tushumi</small>
              <DualPrice value={tabTotals.totalRev} rate={rate} bold />
            </div>
          </div>
          <div>
            <Flame size={20} style={{ color: '#2563eb' }} />
            <div>
              <small>Jami sotilgan birliklar</small>
              <b>{tabTotals.totalSold} dona</b>
            </div>
          </div>
        </div>

        {/* Tab buttons + Date period selector */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="segmented" style={{ margin: 0 }}>
            <button
              type="button"
              className={tab === 'profit' ? 'active' : ''}
              onClick={() => setTab('profit')}
            >
              💎 Eng ko‘p foyda keltirgan
            </button>
            <button
              type="button"
              className={tab === 'sold' ? 'active' : ''}
              onClick={() => setTab('sold')}
            >
              🔥 Eng ko‘p sotilgan
            </button>
            <button
              type="button"
              className={tab === 'least' ? 'active' : ''}
              onClick={() => setTab('least')}
            >
              ⏳ Kam sotilayotganlar
            </button>
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Calendar size={15} style={{ color: 'var(--muted)' }} />
            <select
              className="select"
              style={{ height: 36, fontSize: 12, padding: '4px 8px' }}
              value={days}
              onChange={e => setDays(Number(e.target.value))}
            >
              <option value={7}>Oxirgi 7 kun</option>
              <option value={30}>Oxirgi 30 kun</option>
              <option value={90}>Oxirgi 3 oy (90 kun)</option>
              <option value={180}>Oxirgi 6 oy (180 kun)</option>
              <option value={365}>Oxirgi 1 yil (365 kun)</option>
            </select>
          </div>
        </div>

        {/* Search inside top 50 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px', background: 'var(--surface, #fff)', height: 38 }}>
          <Search size={15} style={{ color: 'var(--muted)' }} />
          <input
            style={{ border: 0, outline: 0, width: '100%', background: 'transparent', fontSize: 13 }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Top 50 ichidan tovar nomi yoki SKU bo'yicha filtrlash..."
          />
          {query && (
            <button
              type="button"
              className="icon-btn"
              style={{ border: 0, background: 'none', cursor: 'pointer', padding: 2, color: 'var(--muted)' }}
              onClick={() => setQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Content Table */}
        {loading ? (
          <div className="ops-state" style={{ padding: 30 }}>Tahlil hisoblanmoqda…</div>
        ) : error ? (
          <div className="ops-state ops-error" style={{ padding: 20 }}>
            <AlertTriangle />
            <p>{error}</p>
            <button type="button" className="btn" onClick={load}>Qayta urinish</button>
          </div>
        ) : currentList.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
            <Package size={32} style={{ margin: '0 auto 8px', display: 'block' }} />
            <b>Savdo ma’lumotlari topilmadi</b>
            <p style={{ margin: '4px 0 0', fontSize: 12 }}>Tanlangan davrda yakunlangan savdolar mavjud emas.</p>
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: 'center' }}>#</th>
                  <th>Mahsulot</th>
                  <th style={{ textAlign: 'center' }}>Sotildi</th>
                  <th>Jami tushum</th>
                  <th>Jami tannarx</th>
                  <th>Sof foyda</th>
                  <th style={{ textAlign: 'center' }}>Marja</th>
                </tr>
              </thead>
              <tbody>
                {currentList.map((item, idx) => {
                  const rev = Number(item.total_revenue || 0);
                  const profit = Number(item.gross_profit || 0);
                  const margin = rev > 0 ? ((profit / rev) * 100).toFixed(1) : '0';
                  const isTop3 = idx < 3;
                  const medalColor = idx === 0 ? '#eab308' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b45309' : null;

                  return (
                    <tr key={item.product_id || idx}>
                      <td style={{ textAlign: 'center' }}>
                        {isTop3 ? (
                          <span
                            style={{
                              display: 'inline-grid',
                              placeItems: 'center',
                              width: 24,
                              height: 24,
                              borderRadius: '50%',
                              background: medalColor,
                              color: '#fff',
                              fontWeight: 800,
                              fontSize: 11
                            }}
                          >
                            {idx + 1}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontWeight: 600, fontSize: 12 }}>
                            {idx + 1}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="product-cell">
                          {item.image ? (
                            <img src={item.image} alt="" />
                          ) : (
                            <span className="product-placeholder">
                              <Package size={16} />
                            </span>
                          )}
                          <div>
                            <b>{item.product_name}</b>
                            <span>{item.sku} {item.category_name ? `· ${item.category_name}` : ''}</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <b style={{ fontSize: 13, color: 'var(--navy)' }}>
                          {item.sold_count} dona
                        </b>
                      </td>
                      <td>
                        <DualPrice value={rev} rate={rate} bold />
                      </td>
                      <td>
                        <DualPrice value={Number(item.total_cost || 0)} rate={rate} />
                      </td>
                      <td>
                        <b style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 13 }}>
                          <DualPrice value={profit} rate={rate} bold />
                        </b>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 10,
                            fontSize: 11,
                            fontWeight: 700,
                            background: Number(margin) >= 20 ? '#dcfce7' : Number(margin) >= 10 ? '#fef9c3' : '#fee2e2',
                            color: Number(margin) >= 20 ? '#15803d' : Number(margin) >= 10 ? '#854d0e' : '#b91c1c'
                          }}
                        >
                          {margin}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
