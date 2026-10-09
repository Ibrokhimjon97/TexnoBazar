import React, { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock3, FileText, Layers, Printer, ReceiptText, Search, WalletCards, X } from 'lucide-react';
import { DualPrice, Empty, Modal, Status, useExchangeRate, ThermalReceiptPreview, printThermalReceipt } from '@texnobazar/ui';
import {
  confirmPosSale,
  getPosPendingSale,
  getSaleReceipt,
  getPendingSaleReceipt,
  listBranchCourierCash,
  acceptCourierCash,
  listPosPendingSales,
  rejectPosPendingSale,
  releaseExpiredPosSales,
  getBrowserClient
} from '@texnobazar/data';

const rejectCourierDelivery = async (handoverId, reason = null) => {
  const { data, error } = await getBrowserClient().rpc('reject_courier_delivery', {
    p_handover_id: handoverId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data;
};

const msg = e => String(e?.message || 'Amalni bajarib bo\'lmadi.');
const date = x => x ? new Date(x).toLocaleString('uz-UZ') : '—';
const address = value => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.line1, value.line2, value.district, value.city, value.region, value.postal_code].filter(Boolean).join(', ');
};
const labels = { pending: 'Kutilmoqda', confirmed: 'Tasdiqlangan', rejected: 'Rad etilgan', expired: 'Muddati tugagan' };
const colors = { pending: 'orange', confirmed: 'green', rejected: 'red', expired: 'gray' };

export default function CashWorkspace({ branchId, toast, onSummary, focusPendingSaleId, clearFocus }) {
  const [tab, setTab] = useState('pos');
  useEffect(() => { if (focusPendingSaleId) setTab('pos'); }, [focusPendingSaleId]);
  if (!branchId) return <div className="cash-real-state"><AlertTriangle /><p>Filial tanlanmagan</p></div>;
  return (
    <section className="cash-real-workspace">
      <div className="m-page-head">
        <h2>Kassa</h2>
        <p>Sotuvchi rezervlari va kuryer pullari</p>
      </div>
      <div className="cash-real-tabs" style={{ marginBottom: 14 }}>
        <button className={tab === 'pos' ? 'active' : ''} onClick={() => setTab('pos')}>Sotuvchi kassa</button>
        <button className={tab === 'courier' ? 'active' : ''} onClick={() => setTab('courier')}>Kuryer pullari</button>
      </div>
      {tab === 'pos' ? <PosCashTab branchId={branchId} toast={toast} onSummary={onSummary} focusPendingSaleId={focusPendingSaleId} clearFocus={clearFocus} /> : <CourierCashTab branchId={branchId} toast={toast} />}
    </section>
  );
}

function PosCashTab({ branchId, toast, onSummary, focusPendingSaleId, clearFocus }) {
  const rate = useExchangeRate();
  const [status, setStatus] = useState('pending');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [result, setResult] = useState({ items: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = async () => {
    if (!branchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      await releaseExpiredPosSales(branchId);
      const data = await listPosPendingSales({
        branchId,
        status: status === 'all' ? null : status,
        query: debounced,
        pageSize: 50
      });
      setResult(data || { items: [], summary: {} });
      onSummary?.(data?.summary);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId, status, debounced]);

  const open = async id => {
    setError('');
    try {
      setDetail(await getPosPendingSale(id));
    } catch (e) {
      setError(msg(e));
    }
  };

  useEffect(() => {
    if (!focusPendingSaleId) return;
    open(focusPendingSaleId).then(() => clearFocus?.()).catch(() => clearFocus?.());
    // Only re-run when the focus target itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPendingSaleId]);

  const confirmed = async id => {
    const saleId = await confirmPosSale(id, null);
    if (!saleId) {
      setDetail(await getPosPendingSale(id));
      toast?.('Rezerv muddati tugagan va mahsulotlar bo\'shatildi');
      await load();
      return;
    }
    const check = await getSaleReceipt(saleId);
    setDetail(null);
    setReceipt(check);
    toast?.('Pul qabul qilindi, mahsulotlar SOLD holatiga o\'tdi');
    await load();
  };

  const rejected = async (id, reason) => {
    await rejectPosPendingSale(id, reason);
    setDetail(null);
    toast?.('So\'rov rad etildi va rezerv bo\'shatildi');
    await load();
  };

  const openReceipt = async id => {
    setError('');
    try {
      const check = await getPendingSaleReceipt(id);
      setDetail(null);
      setReceipt(check);
    } catch (e) {
      setError(msg(e));
      toast?.(msg(e));
    }
  };

  const s = result.summary || {};

  return (
    <section className="cash-real-workspace">
      <div className="m-page-head">
        <h2>Kassa kirimlari</h2>
        <p>Sotuvchi rezervlarini tasdiqlash va yakunlash</p>
      </div>
      <div className="cash-real-summary">
        <article>
          <WalletCards />
          <span>
            <small>Kutilmoqda</small>
            <b>{s.pending_count || 0} ta</b>
            <strong><DualPrice value={Number(s.pending_amount || 0)} rate={rate} /></strong>
          </span>
        </article>
        <article>
          <ReceiptText />
          <span>
            <small>Bugun tasdiqlandi</small>
            <b>{s.confirmed_today_count || 0} ta</b>
            <strong><DualPrice value={Number(s.confirmed_today_amount || 0)} rate={rate} /></strong>
          </span>
        </article>
      </div>
      <div className="cash-real-toolbar">
        <div className="cash-real-tabs">
          {[
            ['pending', 'Kutilmoqda'],
            ['confirmed', 'Tasdiqlangan'],
            ['rejected', 'Rad etilgan'],
            ['expired', 'Muddati tugagan'],
            ['all', 'Barchasi']
          ].map(([key, text]) => (
            <button
              type="button"
              key={key}
              className={status === key ? 'active' : ''}
              onClick={() => setStatus(key)}
            >
              {text}
            </button>
          ))}
        </div>
        <label>
          <Search />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Raqam yoki sotuvchi"
          />
        </label>
      </div>
      {loading ? (
        <State text="Kassa so'rovlari yuklanmoqda…" />
      ) : error ? (
        <State error text={error} retry={load} />
      ) : result.items?.length ? (
        <div className="cash-real-list">
          {result.items.map(row => (
            <button
              type="button"
              className="cash-real-card"
              key={row.id}
              onClick={() => open(row.id)}
            >
              <div className="between">
                <b>{row.pending_no}</b>
                <Status type={colors[row.status]}>{labels[row.status] || row.status}</Status>
              </div>
              <span>Sotuvchi <strong>{row.seller_name}</strong></span>
              <span>{row.unit_count} dona · {row.location_name}</span>
              <div className="cash-real-card-total">
                <b><DualPrice value={Number(row.total || 0)} rate={rate} /></b>
                <small><Clock3 /> {date(row.expires_at)}</small>
              </div>
              {row.status === 'confirmed' && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px dashed var(--line)'
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    className="btn btn-sm btn-outline"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '4px 10px',
                      background: '#fff',
                      color: 'var(--navy)'
                    }}
                    onClick={e => {
                      e.stopPropagation();
                      openReceipt(row.id);
                    }}
                  >
                    <Printer size={13} /> Chekni chop etish
                  </span>
                </div>
              )}
              <ChevronRight />
            </button>
          ))}
        </div>
      ) : (
        <Empty title="So'rovlar topilmadi" text="Tanlangan holatda kassa so'rovi mavjud emas." />
      )}
      <CashDetail
        sale={detail}
        close={() => setDetail(null)}
        confirm={confirmed}
        reject={rejected}
        onViewReceipt={openReceipt}
        rate={rate}
      />
      <Receipt receipt={receipt} close={() => setReceipt(null)} rate={rate} />
    </section>
  );
}

function State({ text, error, retry }) {
  return (
    <div className={'cash-real-state ' + (error ? 'error' : '')}>
      {error && <AlertTriangle />}
      <p>{text}</p>
      {retry && <button type="button" className="btn" onClick={retry}>Qayta urinish</button>}
    </div>
  );
}

function CashDetail({ sale, close, confirm, reject, onViewReceipt, rate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  useEffect(() => {
    setError('');
    setReason('');
    setRejecting(false);
  }, [sale?.id]);

  const act = async fn => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(sale)} onClose={close} title={sale?.pending_no || 'Kassa so\'rovi'}>
      {sale && (
        <div className="cash-real-detail">
          <div className="between">
            <Status type={colors[sale.status]}>{labels[sale.status] || sale.status}</Status>
            <small>{date(sale.created_at)}</small>
          </div>
          <div className="cash-real-parties">
            <span>
              <small>Sotuvchi</small>
              <b>{sale.seller_name}</b>
            </span>
            <span>
              <small>Do'kon</small>
              <b>{sale.location_name}</b>
            </span>
            <span>
              <small>Rezerv tugashi</small>
              <b>{date(sale.expires_at)}</b>
            </span>
          </div>
          <h3>Mahsulotlar</h3>
          <div className="cash-real-lines">
            {sale.lines?.map(line => (
              <article key={line.id}>
                <div>
                  <b>{line.product_name}</b>
                  <small>{line.sku} · {line.qr_code}</small>
                </div>
                <dl>
                  <span>Narx <b><DualPrice value={Number(line.unit_price || 0)} rate={rate} /></b></span>
                  <span>Chegirma <b><DualPrice value={Number(line.discount || 0)} rate={rate} /></b></span>
                  <span>Soliq <b><DualPrice value={Number(line.tax || 0)} rate={rate} /></b></span>
                  <span>Foyda <b><DualPrice value={Number(line.profit || 0)} rate={rate} /></b></span>
                </dl>
                <strong><DualPrice value={Number(line.line_total || 0)} rate={rate} /></strong>
              </article>
            ))}
          </div>
          <div className="cash-real-total">
            <span>Subtotal <b><DualPrice value={Number(sale.subtotal || 0)} rate={rate} /></b></span>
            <span>Chegirma <b><DualPrice value={Number(sale.discount || 0)} rate={rate} /></b></span>
            <span>Soliq <b><DualPrice value={Number(sale.tax || 0)} rate={rate} /></b></span>
            <strong>Jami <b><DualPrice value={Number(sale.total || 0)} rate={rate} /></b></strong>
          </div>
          <h3>Sotuvchi taklif qilgan to'lov</h3>
          <div className="cash-real-payments">
            {sale.payments?.map((p, i) => (
              <p key={i}>
                <span>
                  <b>{p.method_name}</b>
                  {p.external_reference && <small>{p.external_reference}</small>}
                </span>
                <strong><DualPrice value={Number(p.amount || 0)} rate={rate} /></strong>
              </p>
            ))}
          </div>
          {error && <div className="cash-real-inline-error">{error}</div>}
          {rejecting && (
            <div className="cash-real-reject">
              <label>
                Rad etish sababi
                <textarea rows="3" value={reason} onChange={e => setReason(e.target.value)} autoFocus />
              </label>
              <div>
                <button type="button" className="btn" onClick={() => setRejecting(false)}>Bekor qilish</button>
                <button
                  type="button"
                  className="btn cash-real-danger"
                  disabled={busy || !reason.trim()}
                  onClick={() => act(() => reject(sale.id, reason.trim()))}
                >
                  Rad etish
                </button>
              </div>
            </div>
          )}
          {sale.can_confirm && !rejecting && (
            <div className="cash-real-actions">
              <button
                type="button"
                className="btn cash-real-danger"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Rad etish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => act(() => confirm(sale.id))}
              >
                {busy ? 'Tasdiqlanmoqda…' : 'Pulni qabul qildim'}
              </button>
            </div>
          )}
          {sale.status === 'confirmed' && (
            <div className="cash-real-actions" style={{ marginTop: 18 }}>
              <button
                type="button"
                className="btn btn-primary btn-block"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 18px',
                  fontSize: 14,
                  fontWeight: 700
                }}
                disabled={busy}
                onClick={() => act(() => onViewReceipt?.(sale.id))}
              >
                <Printer size={18} />
                {busy ? 'Chek yuklanmoqda…' : 'Chekni ko‘rish va qayta chop etish (40 × 30 mm)'}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Receipt({ receipt, close, rate }) {
  const [printMode, setPrintMode] = useState('per_item');
  const [previewIndex, setPreviewIndex] = useState(0);

  if (!receipt) return null;
  const lines = receipt.lines || [];
  const multipleLines = lines.length > 1;

  const handlePrint = () => {
    printThermalReceipt(receipt, { mode: printMode });
  };

  return (
    <Modal open={Boolean(receipt)} onClose={close} title="Tasdiqlangan savdo cheki">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
          <div className="between" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
            <div>
              <b style={{ fontSize: 13, display: 'block', color: 'var(--navy)' }}>Termoprinter cheki (40 × 30 mm)</b>
              <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                P1 Label Printer va 40x30 mm o‘lchamdagi qog‘ozga moslangan
              </small>
            </div>
            {multipleLines && printMode === 'per_item' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '2px 6px' }}>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={previewIndex <= 0}
                  onClick={() => setPreviewIndex(i => Math.max(0, i - 1))}
                  style={{ width: 22, height: 22 }}
                  title="Oldingi tovar"
                >
                  <ChevronLeft size={14} />
                </button>
                <small style={{ fontWeight: 800, fontSize: 11 }}>
                  {previewIndex + 1} / {lines.length}
                </small>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={previewIndex >= lines.length - 1}
                  onClick={() => setPreviewIndex(i => Math.min(lines.length - 1, i + 1))}
                  style={{ width: 22, height: 22 }}
                  title="Keyingi tovar"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>

          {multipleLines && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                className={`btn btn-sm ${printMode === 'per_item' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => { setPrintMode('per_item'); setPreviewIndex(0); }}
                style={{ flex: 1, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                <Layers size={13} />
                Har bir tovar alohida ({lines.length} ta chek)
              </button>
              <button
                type="button"
                className={`btn btn-sm ${printMode === 'summary' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setPrintMode('summary')}
                style={{ flex: 1, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                <FileText size={13} />
                Jamlangan bitta chek (1 ta chek)
              </button>
            </div>
          )}

          <div style={{ background: '#e2e8f0', padding: '16px', borderRadius: '10px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <ThermalReceiptPreview receipt={receipt} mode={printMode} activeIndex={previewIndex} />
          </div>

          <button
            type="button"
            className="btn btn-primary btn-block cash-real-no-print"
            style={{ marginTop: 14, padding: '12px', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            onClick={handlePrint}
          >
            <Printer size={16} /> Chekni chop etish (40 × 30 mm)
          </button>
        </div>

        <details style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--muted)', userSelect: 'none' }}>
            Savdo to‘liq tafsilotlari (ekran ko‘rinishi)
          </summary>
          <div className="cash-real-receipt" style={{ marginTop: 10 }}>
            <header>
              <h2>{receipt.branch_name}</h2>
              <p>
                {address(receipt.branch_address)}
                {receipt.branch_phone ? ` · ${receipt.branch_phone}` : ''}
              </p>
              <b>{receipt.sale_no}</b>
              <small>{date(receipt.sold_at)}</small>
            </header>
            <div>
              <span>Sotuvchi <b>{receipt.seller_name}</b></span>
              <span>Menejer <b>{receipt.manager_name}</b></span>
            </div>
            {receipt.lines?.map((line, i) => (
              <article key={i}>
                <span>
                  <b>{line.product_name}</b>
                  <small>{line.qr_code}</small>
                </span>
                <strong><DualPrice value={Number(line.line_total || 0)} rate={rate} /></strong>
              </article>
            ))}
            <dl>
              <div>
                <dt>Subtotal</dt>
                <dd><DualPrice value={Number(receipt.subtotal || 0)} rate={rate} /></dd>
              </div>
              <div>
                <dt>Chegirma</dt>
                <dd><DualPrice value={Number(receipt.discount || 0)} rate={rate} /></dd>
              </div>
              <div>
                <dt>Soliq</dt>
                <dd><DualPrice value={Number(receipt.tax || 0)} rate={rate} /></dd>
              </div>
              <div>
                <dt>Jami</dt>
                <dd><DualPrice value={Number(receipt.total || 0)} rate={rate} /></dd>
              </div>
            </dl>
            <h3>To'lovlar</h3>
            {receipt.payments?.map((p, i) => (
              <p key={i}>
                {p.method_name}: <b><DualPrice value={Number(p.amount || 0)} rate={rate} /></b>
              </p>
            ))}
          </div>
        </details>
      </div>
    </Modal>
  );
}

function CourierCashTab({ branchId, toast }) {
  const rate = useExchangeRate();
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [rejectRow, setRejectRow] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState('');

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const result = await listBranchCourierCash(branchId);
      setData(result || { items: [], total: 0 });
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId]);

  const accept = async id => {
    setBusy(id);
    setError('');
    try {
      await acceptCourierCash(id);
      toast?.('Kuryer puli qabul qilindi');
      await load();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (!rejectRow) return;
    setRejectBusy(true);
    setRejectError('');
    try {
      await rejectCourierDelivery(rejectRow.id, rejectReason.trim() || null);
      toast?.('Tovar qaytarildi deb belgilandi. Tovar omborga qaytarildi va sotilmagan deb hisoblandi.');
      setRejectRow(null);
      setRejectReason('');
      await load();
    } catch (e) {
      setRejectError(msg(e));
    } finally {
      setRejectBusy(false);
    }
  };

  return (
    <>
      <div className="cash-real-summary">
        <article>
          <WalletCards />
          <span>
            <small>Kuryerlar berishi kerak</small>
            <b>{data.items?.length || 0} ta buyurtma</b>
            <strong><DualPrice value={Number(data.total || 0)} rate={rate} /></strong>
          </span>
        </article>
      </div>
      {loading ? (
        <State text="Kuryer pullari yuklanmoqda…" />
      ) : error ? (
        <State error text={error} retry={load} />
      ) : !data.items?.length ? (
        <Empty title="Kuryer pullari yo'q" text="Kuryerlardan topshirilmagan naqd pul mavjud emas." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Buyurtma</th>
                <th>Kuryer</th>
                <th>Mijoz</th>
                <th>Summa</th>
                <th>Sana</th>
                <th>Amal</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(row => (
                <tr key={row.id}>
                  <td><b>{row.order_no}</b></td>
                  <td>
                    <b>{row.courier_name}</b>
                    <small className="muted">{row.courier_phone}</small>
                  </td>
                  <td>
                    {row.customer_name}
                    <small className="muted">{row.customer_phone}</small>
                  </td>
                  <td>
                    <b><DualPrice value={Number(row.amount)} rate={rate} /></b>
                  </td>
                  <td>{new Date(row.created_at).toLocaleString('uz-UZ')}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '6px 14px', fontSize: 12 }}
                        disabled={busy === row.id || rejectBusy}
                        onClick={() => accept(row.id)}
                        title="Mijoz pulni kuryerdan bergan bo‘lsa, kassaga kirim qilish"
                      >
                        {busy === row.id ? 'Qabul…' : 'Pulni qabul qildim'}
                      </button>
                      <button
                        className="btn btn-outline"
                        style={{ padding: '6px 12px', fontSize: 12, borderColor: '#fca5a5', color: '#b91c1c' }}
                        disabled={busy === row.id || rejectBusy}
                        onClick={() => {
                          setRejectError('');
                          setRejectReason('');
                          setRejectRow(row);
                        }}
                        title="Mijoz tovardan voz kechgan bo‘lsa, bekor qilish va tovarni omborga qaytarish"
                      >
                        Dostavka qaytdi
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Rejection / Returned Goods Confirmation Modal */}
      {rejectRow && (
        <Modal
          open={Boolean(rejectRow)}
          onClose={() => !rejectBusy && setRejectRow(null)}
          title="Dostavka qaytdi / Tovarni bekor qilish"
        >
          <div style={{ padding: '4px 0' }}>
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 14 }}>
              <p style={{ margin: '0 0 6px 0', fontWeight: 700, color: '#92400e', fontSize: 14 }}>
                Diqqat: Ushbu amal tovar sotilishini bekor qiladi!
              </p>
              <p style={{ margin: 0, fontSize: 13, color: '#78350f' }}>
                Agar mijozga tovar yoqmagan yoki yetkazib berish boshqa sabab bilan qaytgan bo‘lsa, tovar qaytganini tasdiqlang.
              </p>
            </div>

            <div style={{ display: 'grid', gap: 8, fontSize: 13, marginBottom: 16, background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
              <div className="between">
                <span className="muted">Buyurtma:</span>
                <b>{rejectRow.order_no}</b>
              </div>
              <div className="between">
                <span className="muted">Kuryer:</span>
                <b>{rejectRow.courier_name} <span className="muted">({rejectRow.courier_phone})</span></b>
              </div>
              <div className="between">
                <span className="muted">Mijoz:</span>
                <b>{rejectRow.customer_name} <span className="muted">({rejectRow.customer_phone})</span></b>
              </div>
              <div className="between">
                <span className="muted">Summasi:</span>
                <strong style={{ color: 'var(--orange-dark)' }}>
                  <DualPrice value={Number(rejectRow.amount)} rate={rate} />
                </strong>
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14, background: '#f1f5f9', padding: '10px 14px', borderRadius: 6 }}>
              <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                <li>Tovar <b>sotilmagan</b> deb belgilanadi va uning soni ombor qoldig‘iga qaytariladi.</li>
                <li>Kassaga hech qanday savdo puli kirim qilinmaydi.</li>
                <li>Kuryerdan ushbu naqd pulni topshirish talabi bekor qilinadi.</li>
              </ul>
            </div>

            <label className="field" style={{ marginBottom: 16 }}>
              <span className="label">Qaytarilish sababi (ixtiyoriy)</span>
              <input
                className="input"
                placeholder="Masalan: Tovar yoqmadi, mijoz rad etdi"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                autoFocus
              />
            </label>

            {rejectError && <div className="cash-real-inline-error" style={{ marginBottom: 12 }}>{rejectError}</div>}

            <div className="between" style={{ gap: 10 }}>
              <button
                type="button"
                className="btn btn-outline"
                disabled={rejectBusy}
                onClick={() => setRejectRow(null)}
              >
                Orqaga
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: '#dc2626', borderColor: '#dc2626' }}
                disabled={rejectBusy}
                onClick={handleReject}
              >
                {rejectBusy ? 'Bekor qilinmoqda…' : 'Tovar qaytdi (Bekor qilish)'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
