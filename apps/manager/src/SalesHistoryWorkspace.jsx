import React, { useEffect, useState } from 'react';
import { AlertTriangle, Calendar, ChevronLeft, ChevronRight, ExternalLink, Package, Search, ShoppingBag, Trash2, User, X } from 'lucide-react';
import { DualPrice, Empty, Modal, Status, useExchangeRate } from '@texnobazar/ui';
import { deleteSale, listSalesHistory, listInventorySearchSellers } from '@texnobazar/data';

const STOREFRONT = (import.meta.env?.VITE_STOREFRONT_URL) || 'https://texnobazar-storefront.netlify.app';
const today = () => { const d = new Date(); return d.toISOString().slice(0, 10); };
const PAGE_SIZE = 30;

export default function SalesHistoryWorkspace({ branchId, toast }) {
  const rate = useExchangeRate();
  const [sellers, setSellers] = useState([]);
  const [sellerId, setSellerId] = useState('');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [deletingSale, setDeletingSale] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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
        from,
        to,
        query,
        page: p,
        pageSize: PAGE_SIZE
      });
      setItems(result.items || []);
      setTotal(result.total || 0);
    } catch (e) {
      setError(e?.message || 'Yuklanmadi');
    } finally { setLoading(false); }
  };

  useEffect(() => { setPage(1); load(1); }, [branchId, sellerId, from, to]);
  useEffect(() => { load(); }, [page]);

  const search = e => { e.preventDefault(); setPage(1); load(1); };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    <div className="ops-workspace">
      <div className="m-page-head between">
        <div><h2>Sotuvlar tarixi</h2><p>Filialda sotilgan tovarlar arxivi</p></div>
      </div>

      <div className="admin-filterbar">
        <label>
          <Calendar size={16} />
          <input
            className="input"
            type="date"
            value={from}
            onChange={e => {
              const v = e.target.value;
              setFrom(v);
              if (to && v && v > to) setTo(v);
            }}
            max={today()}
          />
        </label>
        <label>
          <Calendar size={16} />
          <input
            className="input"
            type="date"
            value={to}
            onChange={e => {
              const v = e.target.value;
              setTo(v);
              if (from && v && v < from) setFrom(v);
            }}
            max={today()}
          />
        </label>
        <select className="select" value={sellerId} onChange={e => setSellerId(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">Barcha xodimlar</option>
          {filteredSellers.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
        </select>
        <form onSubmit={search} style={{ display: 'flex', gap: 8, flex: 1, minWidth: 200 }}>
          <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px' }}>
            <Search size={16} />
            <input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Mahsulot nomi yoki SKU" style={{ border: 0, padding: '10px 0' }} />
          </label>
          <button className="btn btn-primary">Qidirish</button>
        </form>
      </div>

      {loading ? <div className="ops-state">Yuklanmoqda...</div>
        : error ? <div className="ops-state ops-error"><AlertTriangle /><b>Xatolik</b><p>{error}</p><button className="btn" onClick={() => load()}>Qayta urinish</button></div>
        : items.length === 0 ? <Empty title="Sotuvlar topilmadi" text="Tanlangan sanalar oralig'ida sotilgan tovar yo'q." />
        : <>
          <div className="ops-grid">
            {items.map(item => (
              <SaleCard
                key={item.line_id || item.id}
                item={item}
                onClick={() => setSelected(item)}
                onDelete={() => setDeletingSale(item)}
                rate={rate}
              />
            ))}
          </div>
          <div className="inventory-search-pagination">
            <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}</span>
            <div>
              <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button>
              <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button>
            </div>
          </div>
        </>}

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
            <b>1-usul:</b> Tovar omborga qaytariladi — oddiy o‘chirish. Tovar yana mavjud holatga o‘tadi.
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

function SaleCard({ item, onClick, onDelete, rate }) {
  return (
    <button className="ops-card" onClick={onClick}>
      <span className="ops-icon"><ShoppingBag size={19} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{item.product_name || 'Nomsiz'}</b>
        <strong><DualPrice value={Number(item.line_total || 0)} rate={rate} /></strong>
        <small>{item.seller_name || 'Noaniq'} · {new Date(item.sold_at).toLocaleDateString('uz-UZ')}</small>
        <small>SKU: {item.sku || '—'}</small>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--line)' }}>
          <span
            role="button"
            tabIndex={0}
            className="btn btn-sm"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 8px',
              background: '#fff1f2',
              color: '#e11d48',
              border: '1px solid #fecdd3',
              borderRadius: 6
            }}
            onClick={e => {
              e.stopPropagation();
              onDelete?.();
            }}
          >
            <Trash2 size={12} /> O‘chirish
          </span>
        </div>
      </div>
      {item.primary_media_url
        ? <img src={item.primary_media_url} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
        : <span style={{ width: 48, height: 48, borderRadius: 10, background: '#f1f5f9', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Package size={20} /></span>}
    </button>
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
          {item.primary_media_url
            ? <img src={item.primary_media_url} alt="" style={{ width: 72, height: 72, borderRadius: 14, objectFit: 'cover' }} />
            : <span style={{ width: 72, height: 72, borderRadius: 14, background: '#f1f5f9', display: 'grid', placeItems: 'center' }}><Package size={28} /></span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ fontSize: 16, display: 'block', overflowWrap: 'anywhere' }}>{item.product_name}</b>
            <small style={{ color: 'var(--muted)' }}>SKU: {item.sku || '—'}</small>
            {storefrontUrl && <a href={storefrontUrl} target="_blank" rel="noopener" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, color: 'var(--orange)', fontSize: 12, fontWeight: 700 }}><ExternalLink size={13} /> Saytda ko'rish</a>}
          </div>
        </div>

        {/* Price details */}
        <div className="ops-metrics">
          <span><small>Sotuv narxi</small><b><DualPrice value={Number(item.unit_price || 0)} rate={rate} /></b></span>
          <span><small>Tannarx</small><b><DualPrice value={Number(item.unit_cost || 0)} rate={rate} /></b></span>
          <span><small>Sof foyda</small><b style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}><DualPrice value={profit} rate={rate} /></b></span>
        </div>

        {/* Sale metadata */}
        <div className="ops-metrics">
          <span><small>Chegirma</small><b><DualPrice value={Number(item.discount || 0)} rate={rate} /></b></span>
          <span><small>Soliq</small><b><DualPrice value={Number(item.tax || 0)} rate={rate} /></b></span>
          <span><small>Jami</small><b><DualPrice value={Number(item.line_total || 0)} rate={rate} /></b></span>
        </div>

        {/* Seller & details */}
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <User size={16} style={{ color: 'var(--orange)' }} />
            <span><b>Sotuvchi:</b> {item.seller_name || 'Noaniq'}</span>
          </div>
          {item.manager_name && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <User size={16} style={{ color: 'var(--blue)' }} />
            <span><b>Menejer:</b> {item.manager_name}</span>
          </div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Sotilgan vaqt:</b> {new Date(item.sold_at).toLocaleString('uz-UZ')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShoppingBag size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Chek raqami:</b> {item.sale_no || '—'}</span>
          </div>
          {item.branch_name && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Package size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Filial:</b> {item.branch_name}</span>
          </div>}
          {item.qr_code && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Package size={16} style={{ color: 'var(--muted)' }} />
            <span><b>QR:</b> {item.qr_code} {item.serial_number ? `· S/N: ${item.serial_number}` : ''}</span>
          </div>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Status type={item.sale_status === 'completed' ? 'green' : item.sale_status === 'void' ? 'red' : 'orange'}>{item.sale_status || 'Noaniq'}</Status>
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
