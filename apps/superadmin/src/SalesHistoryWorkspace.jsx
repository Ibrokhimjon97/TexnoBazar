import React, { useEffect, useState } from 'react';
import { AlertTriangle, Calendar, ChevronLeft, ChevronRight, ExternalLink, Package, Search, ShoppingBag, Store, User } from 'lucide-react';
import { DualPrice, Empty, Modal, Status, formatMoney } from '@texnobazar/ui';
import { getLatestExchangeRate, listSalesHistory, listMasterRecords, listInventorySearchSellers } from '@texnobazar/data';

const STOREFRONT = (import.meta.env?.VITE_STOREFRONT_URL) || 'https://texnobazar-storefront.netlify.app';
const today = () => new Date().toISOString().slice(0, 10);
const PAGE_SIZE = 50;

export default function SalesHistoryWorkspace() {
  const [branches, setBranches] = useState([]);
  const [sellers, setSellers] = useState([]);
  const [branchId, setBranchId] = useState('');
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
  const [rate, setRate] = useState(null);

  useEffect(() => {
    listMasterRecords('branches').then(setBranches).catch(() => {});
    listInventorySearchSellers().then(setSellers).catch(() => {});
    getLatestExchangeRate().then(r => setRate(Number(r) || null)).catch(() => {});
  }, []);

  const load = async (p = page) => {
    setLoading(true); setError('');
    try {
      const result = await listSalesHistory({ branchId: branchId || null, sellerId: sellerId || null, from, to, query, page: p, pageSize: PAGE_SIZE });
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

  const filteredSellers = sellerId || !branchId ? sellers : sellers.filter(s => !branchId || (s.branch_ids || []).includes(branchId));

  return (
    <>
      <div className="page-head between">
        <div><h2>Sotuvlar tarixi</h2><p>Barcha filiallar bo'yicha sotilgan tovarlar arxivi</p></div>
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
        <select className="select" value={branchId} onChange={e => setBranchId(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">Barcha filiallar</option>
          {branches.filter(b => b.is_active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select className="select" value={sellerId} onChange={e => setSellerId(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">Barcha xodimlar</option>
          {filteredSellers.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
        </select>
        <form onSubmit={search} style={{ display: 'flex', gap: 8, flex: 1, minWidth: 180 }}>
          <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px' }}>
            <Search size={16} />
            <input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Mahsulot nomi yoki SKU" style={{ border: 0, padding: '10px 0' }} />
          </label>
          <button className="btn btn-primary">Qidirish</button>
        </form>
      </div>

      {/* Summary */}
      {!loading && !error && items.length > 0 && <SummaryBar items={items} total={total} rate={rate} />}

      {loading ? <div className="employee-loading">Yuklanmoqda...</div>
        : error ? <div className="empty"><AlertTriangle /><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={() => load()}>Qayta urinish</button></div>
        : items.length === 0 ? <Empty title="Sotuvlar topilmadi" text="Tanlangan sanalar oralig'ida sotilgan tovar yo'q." />
        : <>
          <div className="card data-card" style={{ marginTop: 14 }}>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>Mahsulot</th><th>Filial</th><th>Sotuvchi</th><th>Sotuv narxi</th><th>Tannarx</th><th>Foyda</th><th>Sana</th><th>Status</th>
            </tr></thead><tbody>
              {items.map(item => {
                const profit = Number(item.line_total || 0) - Number(item.tax || 0) - Number(item.unit_cost || 0);
                return <tr key={item.line_id} className="clickable-row" onClick={() => setSelected(item)}>
                  <td><div className="product-cell">
                    {item.primary_media_url ? <img src={item.primary_media_url} alt="" /> : <span className="product-placeholder"><Package size={16} /></span>}
                    <div><b>{item.product_name || 'Nomsiz'}</b><span>{item.sku || ''}</span></div>
                  </div></td>
                  <td>{item.branch_name || '—'}</td>
                  <td>{item.seller_name || '—'}</td>
                  <td><DualPrice value={item.unit_price} rate={rate} bold /></td>
                  <td><DualPrice value={item.unit_cost} rate={rate} /></td>
                  <td><b style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}><DualPrice value={profit} rate={rate} /></b></td>
                  <td>{new Date(item.sold_at).toLocaleDateString('uz-UZ')}</td>
                  <td><Status type={item.sale_status === 'completed' ? 'green' : item.sale_status === 'void' ? 'red' : 'orange'}>{item.sale_status || '—'}</Status></td>
                </tr>;
              })}
            </tbody></table></div>
          </div>
          <div className="inventory-search-pagination" style={{ marginTop: 10 }}>
            <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}</span>
            <div>
              <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /> Oldingi</button>
              <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Keyingi <ChevronRight size={16} /></button>
            </div>
          </div>
        </>}

      {selected && <SaleDetailModal item={selected} onClose={() => setSelected(null)} rate={rate} />}
    </>
  );
}

function SummaryBar({ items, total, rate }) {
  const revenue = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
  const profit = items.reduce((s, i) => s + (Number(i.line_total || 0) - Number(i.tax || 0) - Number(i.unit_cost || 0)), 0);
  return (
    <div className="admin-report-kpis" style={{ marginTop: 14 }}>
      <div><ShoppingBag size={20} /><div><small>Sahifadagi birliklar</small><b>{items.length} / {total}</b></div></div>
      <div><Store size={20} /><div><small>Tushum</small><DualPrice value={revenue} rate={rate} bold /></div></div>
      <div><Package size={20} /><div><small>Sof foyda</small><span style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}><DualPrice value={profit} rate={rate} bold /></span></div></div>
    </div>
  );
}

function SaleDetailModal({ item, onClose, rate }) {
  const profit = Number(item.line_total || 0) - Number(item.tax || 0) - Number(item.unit_cost || 0);
  const storefrontUrl = item.product_slug && item.is_published ? `${STOREFRONT}/product/${item.product_slug}` : null;

  return (
    <Modal open onClose={onClose} title="Sotuv tafsilotlari">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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

        <div className="admin-report-kpis">
          <div><div><small>Sotuv narxi</small><DualPrice value={item.unit_price} rate={rate} bold /></div></div>
          <div><div><small>Tannarx</small><DualPrice value={item.unit_cost} rate={rate} /></div></div>
          <div><div><small>Sof foyda</small><span style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}><DualPrice value={profit} rate={rate} bold /></span></div></div>
        </div>

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
            <Store size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Filial:</b> {item.branch_name} ({item.branch_code})</span>
          </div>}
          {item.qr_code && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Package size={16} style={{ color: 'var(--muted)' }} />
            <span><b>QR:</b> {item.qr_code} {item.serial_number ? `· S/N: ${item.serial_number}` : ''}</span>
          </div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShoppingBag size={16} style={{ color: 'var(--muted)' }} />
            <span><b>Chegirma:</b> <DualPrice value={item.discount} rate={rate} /> · <b>Soliq:</b> <DualPrice value={item.tax} rate={rate} /> · <b>Jami:</b> <DualPrice value={item.line_total} rate={rate} bold /></span>
          </div>
        </div>

        <Status type={item.sale_status === 'completed' ? 'green' : item.sale_status === 'void' ? 'red' : 'orange'}>{item.sale_status || 'Noaniq'}</Status>
      </div>
    </Modal>
  );
}
