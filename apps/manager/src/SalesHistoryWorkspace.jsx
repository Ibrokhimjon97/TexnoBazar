import React, { useEffect, useState } from 'react';
import { AlertTriangle, Calendar, ChevronLeft, ChevronRight, ExternalLink, Package, Search, ShoppingBag, User, X } from 'lucide-react';
import { DualPrice, Empty, Modal, Status, useExchangeRate } from '@texnobazar/ui';
import { listSalesHistory } from '@texnobazar/data';

const STOREFRONT = (import.meta.env?.VITE_STOREFRONT_URL) || 'https://texnobazar-storefront.netlify.app';
const today = () => { const d = new Date(); return d.toISOString().slice(0, 10); };
const PAGE_SIZE = 30;

export default function SalesHistoryWorkspace({ branchId }) {
  const rate = useExchangeRate();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const load = async (p = page) => {
    if (!branchId) { setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const result = await listSalesHistory({ branchId, from, to, query, page: p, pageSize: PAGE_SIZE });
      setItems(result.items || []);
      setTotal(result.total || 0);
    } catch (e) {
      setError(e?.message || 'Yuklanmadi');
    } finally { setLoading(false); }
  };

  useEffect(() => { setPage(1); load(1); }, [branchId, from, to]);
  useEffect(() => { load(); }, [page]);

  const search = e => { e.preventDefault(); setPage(1); load(1); };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="ops-workspace">
      <div className="m-page-head between">
        <div><h2>Sotuvlar tarixi</h2><p>Filialda sotilgan tovarlar arxivi</p></div>
      </div>

      <div className="admin-filterbar">
        <label>
          <Calendar size={16} />
          <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} max={to || today()} />
        </label>
        <label>
          <Calendar size={16} />
          <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} min={from} max={today()} />
        </label>
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
            {items.map(item => <SaleCard key={item.id} item={item} onClick={() => setSelected(item)} rate={rate} />)}
          </div>
          <div className="inventory-search-pagination">
            <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}</span>
            <div>
              <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button>
              <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button>
            </div>
          </div>
        </>}

      {selected && <SaleDetailModal item={selected} onClose={() => setSelected(null)} rate={rate} />}
    </div>
  );
}

function SaleCard({ item, onClick, rate }) {
  const profit = Number(item.line_total || 0) - Number(item.tax || 0) - Number(item.unit_cost || 0);
  return (
    <button className="ops-card" onClick={onClick}>
      <span className="ops-icon"><ShoppingBag size={19} /></span>
      <div>
        <b>{item.product_name || 'Nomsiz'}</b>
        <strong><DualPrice value={Number(item.line_total || 0)} rate={rate} /></strong>
        <small>{item.seller_name || 'Noaniq'} · {new Date(item.sold_at).toLocaleDateString('uz-UZ')}</small>
        <small>SKU: {item.sku || '—'}</small>
      </div>
      {item.primary_media_url
        ? <img src={item.primary_media_url} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
        : <span style={{ width: 48, height: 48, borderRadius: 10, background: '#f1f5f9', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Package size={20} /></span>}
    </button>
  );
}

function SaleDetailModal({ item, onClose, rate }) {
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

        <Status type={item.sale_status === 'completed' ? 'green' : item.sale_status === 'void' ? 'red' : 'orange'}>{item.sale_status || 'Noaniq'}</Status>
      </div>
    </Modal>
  );
}
