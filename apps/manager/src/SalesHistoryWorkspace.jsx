import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Package,
  RotateCcw,
  Search,
  ShoppingBag,
  Store,
  Trash2,
  User,
  X
} from 'lucide-react';
import { DualPrice, Empty, Modal, Status, useExchangeRate } from '@texnobazar/ui';
import { deleteSale, listSalesHistory, listInventorySearchSellers } from '@texnobazar/data';

const STOREFRONT = (import.meta.env?.VITE_STOREFRONT_URL) || 'https://texnobazar-storefront.netlify.app';
const PAGE_SIZE = 50;

const formatDateStr = (d) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getTodayStr = () => formatDateStr(new Date());

const getYesterdayStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDateStr(d);
};

const getDaysAgoStr = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return formatDateStr(d);
};

const getMonthStartStr = () => {
  const d = new Date();
  d.setDate(1);
  return formatDateStr(d);
};

export default function SalesHistoryWorkspace({ branchId, toast }) {
  const rate = useExchangeRate();
  const [sellers, setSellers] = useState([]);
  const [sellerId, setSellerId] = useState('');
  const [from, setFrom] = useState(getTodayStr());
  const [to, setTo] = useState(getTodayStr());
  const [activePreset, setActivePreset] = useState('today'); // 'today' | 'yesterday' | '7days' | 'month' | 'all' | 'custom'
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [deletingSale, setDeletingSale] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Load sellers once
  useEffect(() => {
    listInventorySearchSellers()
      .then(res => setSellers(Array.isArray(res) ? res : []))
      .catch(() => {});
  }, []);

  const filteredSellers = sellerId || !branchId
    ? sellers
    : sellers.filter(s => !branchId || (s.branch_ids || []).includes(branchId));

  const load = async (p = page) => {
    if (!branchId) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await listSalesHistory({
        branchId,
        sellerId: sellerId || null,
        from: from || null,
        to: to || null,
        query: query || '',
        page: p,
        pageSize: PAGE_SIZE
      });
      setItems(result.items || []);
      setTotal(result.total || 0);
    } catch (e) {
      setError(e?.message || 'Yuklanmadi');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    setPage(1);
    load(1);
  }, [branchId, sellerId, from, to, query]);

  useEffect(() => {
    load(page);
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handlePreset = (type) => {
    setActivePreset(type);
    if (type === 'today') {
      const t = getTodayStr();
      setFrom(t);
      setTo(t);
    } else if (type === 'yesterday') {
      const y = getYesterdayStr();
      setFrom(y);
      setTo(y);
    } else if (type === '7days') {
      setFrom(getDaysAgoStr(7));
      setTo(getTodayStr());
    } else if (type === 'month') {
      setFrom(getMonthStartStr());
      setTo(getTodayStr());
    } else if (type === 'all') {
      setFrom('');
      setTo('');
    }
  };

  const handleSellerChange = (newSellerId) => {
    setSellerId(newSellerId);
    // If user explicitly picks an employee and date is locked to today with no sales yet,
    // switch to 'all' so all sales made by this employee are immediately visible!
    if (newSellerId && (activePreset === 'today' || (from === getTodayStr() && to === getTodayStr()))) {
      setActivePreset('all');
      setFrom('');
      setTo('');
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setQuery(searchInput.trim());
    setPage(1);
  };

  const handleResetFilters = () => {
    setSellerId('');
    setSearchInput('');
    setQuery('');
    setActivePreset('today');
    const t = getTodayStr();
    setFrom(t);
    setTo(t);
  };

  const hasActiveFilters = Boolean(sellerId || query || from !== getTodayStr() || to !== getTodayStr() || activePreset !== 'today');

  const handleDeleteSale = async (restoreStock = true) => {
    if (!deletingSale) return;
    setDeleteBusy(true);
    try {
      const saleId = deletingSale.sale_id || deletingSale.id;
      const res = await deleteSale(saleId, restoreStock);
      toast?.(res?.message || (restoreStock ? 'Sotuv o‘chirildi va tovar omborga qaytarildi.' : 'Sotuv butunlay o‘chirildi.'));
      setDeletingSale(null);
      if (selected && (selected.sale_id === saleId || selected.id === saleId)) {
        setSelected(null);
      }
      await load(page);
    } catch (e) {
      toast?.(e?.message || 'Sotuvni o‘chirishda xatolik yuz berdi.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="ops-workspace" style={{ maxWidth: 1200 }}>
      <div className="page-head between">
        <div>
          <h2>Sotuvlar tarixi</h2>
          <p>Filialda sotilgan tovarlar arxivi va xodimlar hisoboti</p>
        </div>
      </div>

      {/* Date preset pills */}
      <div className="date-preset-pills">
        <button
          type="button"
          className={`date-pill-btn ${activePreset === 'today' ? 'active' : ''}`}
          onClick={() => handlePreset('today')}
        >
          Bugun
        </button>
        <button
          type="button"
          className={`date-pill-btn ${activePreset === 'yesterday' ? 'active' : ''}`}
          onClick={() => handlePreset('yesterday')}
        >
          Kecha
        </button>
        <button
          type="button"
          className={`date-pill-btn ${activePreset === '7days' ? 'active' : ''}`}
          onClick={() => handlePreset('7days')}
        >
          Oxirgi 7 kun
        </button>
        <button
          type="button"
          className={`date-pill-btn ${activePreset === 'month' ? 'active' : ''}`}
          onClick={() => handlePreset('month')}
        >
          Shu oy
        </button>
        <button
          type="button"
          className={`date-pill-btn ${activePreset === 'all' ? 'active' : ''}`}
          onClick={() => handlePreset('all')}
        >
          Barchasi (Arxiv)
        </button>
      </div>

      {/* Filterbar */}
      <div className="admin-filterbar">
        <label title="Boshlanish sanasi">
          <Calendar size={16} />
          <input
            className="input"
            type="date"
            value={from}
            onChange={e => {
              const v = e.target.value;
              setFrom(v);
              setActivePreset('custom');
              if (to && v && v > to) setTo(v);
            }}
            max={getTodayStr()}
          />
          {from && (
            <button
              type="button"
              className="icon-btn"
              style={{ border: 0, background: 'none', padding: 2, color: 'var(--muted)', cursor: 'pointer' }}
              onClick={() => { setFrom(''); setActivePreset('custom'); }}
            >
              <X size={14} />
            </button>
          )}
        </label>

        <label title="Tugash sanasi">
          <Calendar size={16} />
          <input
            className="input"
            type="date"
            value={to}
            onChange={e => {
              const v = e.target.value;
              setTo(v);
              setActivePreset('custom');
              if (from && v && v < from) setFrom(v);
            }}
            max={getTodayStr()}
          />
          {to && (
            <button
              type="button"
              className="icon-btn"
              style={{ border: 0, background: 'none', padding: 2, color: 'var(--muted)', cursor: 'pointer' }}
              onClick={() => { setTo(''); setActivePreset('custom'); }}
            >
              <X size={14} />
            </button>
          )}
        </label>

        <select
          className="select"
          value={sellerId}
          onChange={e => handleSellerChange(e.target.value)}
          style={{ minWidth: 180 }}
        >
          <option value="">Barcha xodimlar ({filteredSellers.length})</option>
          {filteredSellers.map(s => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </select>

        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: 8, flex: 1, minWidth: 200 }}>
          <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px', background: 'var(--surface, #fff)' }}>
            <Search size={16} style={{ color: 'var(--muted)' }} />
            <input
              className="input"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Mahsulot nomi, SKU, chek yoki xodim..."
              style={{ border: 0, padding: '10px 0', background: 'transparent' }}
            />
            {searchInput && (
              <button
                type="button"
                className="icon-btn"
                style={{ border: 0, background: 'none', padding: 2, color: 'var(--muted)', cursor: 'pointer' }}
                onClick={() => { setSearchInput(''); setQuery(''); }}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <button type="submit" className="btn btn-primary">Qidirish</button>
        </form>

        {hasActiveFilters && (
          <button
            type="button"
            className="btn btn-outline"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={handleResetFilters}
            title="Barcha filtrlarni tozalash"
          >
            <RotateCcw size={14} /> Tozalash
          </button>
        )}
      </div>

      {/* Summary KPI Bar */}
      {!loading && !error && items.length > 0 && (
        <SummaryBar items={items} total={total} rate={rate} />
      )}

      {/* Main Content: Table or States */}
      {loading ? (
        <div className="ops-state">Yuklanmoqda...</div>
      ) : error ? (
        <div className="ops-state ops-error">
          <AlertTriangle size={32} />
          <b>Xatolik yuz berdi</b>
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => load()}>Qayta urinish</button>
        </div>
      ) : items.length === 0 ? (
        <div style={{ marginTop: 14 }}>
          <Empty
            title="Sotuvlar topilmadi"
            text={
              sellerId
                ? `Tanlangan xodim bo'yicha bu oraliqda sotuv topilmadi. "Kecha" yoki "Barchasi" tugmasini bosib ko'ring.`
                : `Tanlangan sanalar oralig'ida sotilgan tovar yo'q. Boshqa oraliqni tanlang.`
            }
          />
        </div>
      ) : (
        <>
          <div className="card data-card" style={{ marginTop: 14 }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Mahsulot</th>
                    <th>Sotuvchi</th>
                    <th>Sotuv narxi</th>
                    <th>Tannarx</th>
                    <th>Sof foyda</th>
                    <th>Sana</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Amallar</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const profit = Number(item.line_total || 0) - Number(item.tax || 0) - Number(item.unit_cost || 0);
                    return (
                      <tr
                        key={item.line_id || item.id}
                        className="clickable-row"
                        onClick={() => setSelected(item)}
                      >
                        <td>
                          <div className="product-cell">
                            {item.primary_media_url ? (
                              <img src={item.primary_media_url} alt="" />
                            ) : (
                              <span className="product-placeholder">
                                <Package size={16} />
                              </span>
                            )}
                            <div>
                              <b>{item.product_name || 'Nomsiz'}</b>
                              <span>{item.sku || 'SKU mavjud emas'}</span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span style={{ fontWeight: 600, color: 'var(--navy)' }}>
                            {item.seller_name || '—'}
                          </span>
                        </td>
                        <td>
                          <DualPrice value={Number(item.unit_price || 0)} rate={rate} bold />
                        </td>
                        <td>
                          <DualPrice value={Number(item.unit_cost || 0)} rate={rate} />
                        </td>
                        <td>
                          <b style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            <DualPrice value={profit} rate={rate} bold />
                          </b>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {new Date(item.sold_at).toLocaleDateString('uz-UZ')}
                          </span>
                        </td>
                        <td>
                          <Status type={item.sale_status === 'completed' ? 'green' : item.sale_status === 'void' ? 'red' : 'orange'}>
                            {item.sale_status === 'completed' ? 'Yakunlangan' : item.sale_status === 'void' ? 'Bekor qilingan' : (item.sale_status || '—')}
                          </Status>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{
                              padding: '5px 10px',
                              background: '#fff1f2',
                              borderColor: '#fecdd3',
                              color: '#e11d48',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              borderRadius: 8
                            }}
                            onClick={e => {
                              e.stopPropagation();
                              setDeletingSale(item);
                            }}
                          >
                            <Trash2 size={12} /> O‘chirish
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="inventory-search-pagination">
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total} ta sotuv
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <ChevronLeft size={16} /> Oldingi
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  Keyingi <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Sale Detail Modal */}
      {selected && (
        <SaleDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          onDelete={setDeletingSale}
          rate={rate}
        />
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        open={Boolean(deletingSale)}
        onClose={() => !deleteBusy && setDeletingSale(null)}
        title="Sotuvni o‘chirish"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--navy)' }}>
            Haqiqatan ham <b>{deletingSale?.product_name}</b> (Chek: <b>{deletingSale?.sale_no}</b>) sotuvini tizimdan o‘chirmoqchimisiz?
          </p>
          <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
            <b>1-usul:</b> Tovar omborga qaytariladi — oddiy o‘chirish. Tovar yana mavjud (available) holatga o‘tadi.
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
              disabled={deleteBusy}
              style={{ background: '#ef4444', borderColor: '#ef4444', color: '#fff', fontWeight: 600 }}
              onClick={() => handleDeleteSale(false)}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Qaytarmasdan o‘chirish'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={deleteBusy}
              style={{ background: '#16a34a', borderColor: '#16a34a', color: '#fff', fontWeight: 600 }}
              onClick={() => handleDeleteSale(true)}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Qaytarib o‘chirish'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function SummaryBar({ items, total, rate }) {
  const revenue = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
  const profit = items.reduce((s, i) => s + (Number(i.line_total || 0) - Number(i.tax || 0) - Number(i.unit_cost || 0)), 0);
  return (
    <div className="admin-report-kpis" style={{ marginTop: 14 }}>
      <div>
        <ShoppingBag size={22} />
        <div>
          <small>Sahifadagi birliklar</small>
          <b>{items.length} / {total}</b>
        </div>
      </div>
      <div>
        <Store size={22} />
        <div>
          <small>Jami tushum</small>
          <DualPrice value={revenue} rate={rate} bold />
        </div>
      </div>
      <div>
        <Package size={22} />
        <div>
          <small>Sof foyda</small>
          <span style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
            <DualPrice value={profit} rate={rate} bold />
          </span>
        </div>
      </div>
    </div>
  );
}

function SaleDetailModal({ item, onClose, onDelete, rate }) {
  const profit = Number(item.line_total || 0) - Number(item.tax || 0) - Number(item.unit_cost || 0);
  const storefrontUrl = item.product_slug && item.is_published ? `${STOREFRONT}/product/${item.product_slug}` : null;

  return (
    <Modal open onClose={onClose} title="Sotuv tafsilotlari">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Product image + name */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          {item.primary_media_url ? (
            <img src={item.primary_media_url} alt="" style={{ width: 72, height: 72, borderRadius: 14, objectFit: 'cover' }} />
          ) : (
            <span style={{ width: 72, height: 72, borderRadius: 14, background: '#f1f5f9', display: 'grid', placeItems: 'center' }}>
              <Package size={28} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ fontSize: 16, display: 'block', overflowWrap: 'anywhere' }}>{item.product_name}</b>
            <small style={{ color: 'var(--muted)' }}>SKU: {item.sku || '—'}</small>
            {storefrontUrl && (
              <a
                href={storefrontUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, color: 'var(--orange)', fontSize: 12, fontWeight: 700 }}
              >
                <ExternalLink size={13} /> Saytda ko'rish
              </a>
            )}
          </div>
        </div>

        {/* Price KPIs */}
        <div className="admin-report-kpis" style={{ marginBottom: 0 }}>
          <div>
            <div>
              <small>Sotuv narxi</small>
              <DualPrice value={Number(item.unit_price || 0)} rate={rate} bold />
            </div>
          </div>
          <div>
            <div>
              <small>Tannarx</small>
              <DualPrice value={Number(item.unit_cost || 0)} rate={rate} />
            </div>
          </div>
          <div>
            <div>
              <small>Sof foyda</small>
              <span style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                <DualPrice value={profit} rate={rate} bold />
              </span>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <User size={16} style={{ color: 'var(--orange)' }} />
            <span><b>Sotuvchi:</b> {item.seller_name || 'Noaniq'}</span>
          </div>
          {item.manager_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <User size={16} style={{ color: 'var(--blue)' }} />
              <span><b>Menejer:</b> {item.manager_name}</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Sotilgan vaqt:</b> {new Date(item.sold_at).toLocaleString('uz-UZ')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShoppingBag size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Chek raqami:</b> {item.sale_no || '—'}</span>
          </div>
          {item.branch_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Store size={16} style={{ color: 'var(--muted)' }} />
              <span><b>Filial:</b> {item.branch_name} {item.branch_code ? `(${item.branch_code})` : ''}</span>
            </div>
          )}
          {item.qr_code && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Package size={16} style={{ color: 'var(--muted)' }} />
              <span><b>QR:</b> {item.qr_code} {item.serial_number ? `· S/N: ${item.serial_number}` : ''}</span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShoppingBag size={16} style={{ color: 'var(--muted)' }} />
            <span>
              <b>Chegirma:</b> <DualPrice value={Number(item.discount || 0)} rate={rate} /> · <b>Soliq:</b> <DualPrice value={Number(item.tax || 0)} rate={rate} /> · <b>Jami:</b> <DualPrice value={Number(item.line_total || 0)} rate={rate} bold />
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Status type={item.sale_status === 'completed' ? 'green' : item.sale_status === 'void' ? 'red' : 'orange'}>
            {item.sale_status === 'completed' ? 'Yakunlangan' : item.sale_status === 'void' ? 'Bekor qilingan' : (item.sale_status || 'Noaniq')}
          </Status>
        </div>

        <div style={{ marginTop: 10, paddingTop: 14, borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
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
              fontWeight: 600,
              borderRadius: 8
            }}
            onClick={() => {
              onClose();
              onDelete?.(item);
            }}
          >
            <Trash2 size={14} /> Ushbu sotuvni o‘chirish
          </button>
        </div>
      </div>
    </Modal>
  );
}
