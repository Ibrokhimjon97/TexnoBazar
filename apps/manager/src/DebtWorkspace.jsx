import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronRight, Landmark, PackagePlus, ReceiptText, Truck, Plus, CheckCircle2, XCircle, Edit3, Trash2 } from 'lucide-react';
import { DualPrice, Empty, Modal, Status, useExchangeRate } from '@texnobazar/ui';
import { formatUzDate, getBranchDebt, getBranchDebtSummary, listBranchDebts, listSupplierDebts, recordBranchDebtPayment, registerBranchDebt, registerSupplierDebt, confirmBranchDebt, confirmBranchDebtPayment, rejectBranchDebtPayment, updateBranchDebt, deleteBranchDebt, getBrowserClient } from '@texnobazar/data';
const message = e => String(e?.message || 'Amalni bajarib bo‘lmadi.');
const labels = { open: 'Ochiq', partially_paid: 'Qisman to‘langan', paid: 'To‘langan', void: 'Bekor qilingan' };
const badge = { open: 'orange', partially_paid: 'blue', paid: 'green', void: 'gray' };

const AmountView = ({ value, currency, rate }) => {
  const num = Number(value || 0);
  if (currency === 'USD') {
    const formattedUsd = `$${num.toLocaleString('en-US', { minimumFractionDigits: num % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}`;
    const uzsEquiv = rate ? Math.round(num * rate) : null;
    return (
      <span className="amount-view-usd" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'inherit', lineHeight: 1.25 }}>
        <b>{formattedUsd}</b>
        {uzsEquiv !== null && (
          <small style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 500 }}>
            ~{new Intl.NumberFormat('uz-UZ').format(uzsEquiv)} so'm
          </small>
        )}
      </span>
    );
  }
  const formattedUzs = `${new Intl.NumberFormat('uz-UZ').format(num)} so'm`;
  const usdEquiv = (rate && rate > 0) ? (num / rate) : null;
  return (
    <span className="amount-view-uzs" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'inherit', lineHeight: 1.25 }}>
      <b>{formattedUzs}</b>
      {usdEquiv !== null && (
        <small style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 500 }}>
          ~${usdEquiv.toFixed(2)}
        </small>
      )}
    </span>
  );
};

const date = value => value ? new Date(value).toLocaleString('uz-UZ') : '—';

export default function DebtWorkspace({ branchId, toast, pendingDebtCount = 0, onDebtConfirmed }) {
  const rate = useExchangeRate();
  const [section, setSection] = useState('supplier');
  return (
    <section className="dw-workspace">
      <div className="m-page-head">
        <h2>Qarzdorlik</h2>
        <p>Ta'minotchilar va filiallar bo'yicha hisob-kitoblar hamda filial aktivlari</p>
      </div>
      <div className="dw-tabs" style={{ marginBottom: 16 }}>
        <button className={section === 'supplier' ? 'active' : ''} onClick={() => setSection('supplier')}>
          <Truck size={15} /> Ta'minotchiga qarzimiz
        </button>
        <button className={section === 'branch' ? 'active' : ''} onClick={() => setSection('branch')}>
          <Landmark size={15} /> Filial qarzlari
          {pendingDebtCount > 0 && (
            <span style={{
              marginLeft: 6,
              background: 'var(--orange, #f97316)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 10,
              display: 'inline-flex',
              alignItems: 'center'
            }}>
              +{pendingDebtCount}
            </span>
          )}
        </button>
      </div>
      {section === 'supplier' ? (
        <SupplierDebtSection branchId={branchId} toast={toast} rate={rate} />
      ) : (
        <BranchDebtSection
          branchId={branchId}
          toast={toast}
          rate={rate}
          pendingDebtCount={pendingDebtCount}
          onDebtConfirmed={onDebtConfirmed}
        />
      )}
    </section>
  );
}

function SupplierDebtSection({ branchId, toast, rate }) {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const load = async () => {
    if (!branchId) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const data = await listSupplierDebts(branchId);
      setSuppliers(data || []);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [branchId]);
  const totalBalance = suppliers.reduce((s, x) => s + Number(x.total_balance || 0), 0);

  return (
    <>
      <div className="between m-page-head" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Ta'minotchilarga qarzimiz</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>Partiya kirimlari va qo‘lda kiritilgan qarzlar</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
          onClick={() => setRegisterOpen(true)}
        >
          <Plus size={16} />
          <span>Qarz qo‘shish</span>
        </button>
      </div>

      <div className="dw-summary">
        <article className="card">
          <div>
            <Landmark />
            <span>
              <small>Ta'minotchilarga jami qarzimiz</small>
              <b><AmountView value={totalBalance} currency="USD" rate={rate} /></b>
            </span>
          </div>
          <dl>
            <div><dt>Ta'minotchilar</dt><dd>{suppliers.length} ta</dd></div>
            <div><dt>Ochiq partiyalar</dt><dd>{suppliers.reduce((s, x) => s + Number(x.open_receipt_count || 0), 0)} ta</dd></div>
          </dl>
        </article>
      </div>
      {loading ? (
        <div className="dw-state">Yuklanmoqda...</div>
      ) : error ? (
        <div className="dw-state dw-error">
          <AlertTriangle />
          <b>Xatolik</b>
          <p>{error}</p>
          <button className="btn" onClick={load}>Qayta urinish</button>
        </div>
      ) : suppliers.length === 0 ? (
        <Empty title="Qarz mavjud emas" text="Hozirda ta'minotchilarga qarzimiz yo'q." />
      ) : (
        <div className="dw-list">
          {suppliers.map(s => (
            <button key={s.supplier_id} className="card dw-card" onClick={() => setDetail(s)}>
              <span className="dw-card-icon" style={{ background: '#fff1e7', color: 'var(--orange)' }}>
                <PackagePlus />
              </span>
              <div>
                <div className="between">
                  <b>{s.supplier_name}</b>
                  <Status type="orange">
                    {s.total_receipt_count || s.open_receipt_count ? `${s.total_receipt_count || s.open_receipt_count} partiya` : (s.manual_debt_count ? `${s.manual_debt_count} ta qarz` : 'Faol')}
                  </Status>
                </div>
                <strong>Qarzimiz: <AmountView value={Number(s.total_balance || 0)} currency={s.balance_currency || 'USD'} rate={rate} /></strong>
                <small>{s.supplier_code}</small>
              </div>
              <ChevronRight />
            </button>
          ))}
        </div>
      )}
      <SupplierDebtDetail supplier={detail} close={() => setDetail(null)} rate={rate} />
      <RegisterSupplierDebtModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        branchId={branchId}
        toast={toast}
        onSuccess={load}
        existingSuppliers={suppliers}
      />
    </>
  );
}

function SupplierDebtDetail({ supplier, close, rate }) {
  if (!supplier) return null;
  const receipts = supplier.receipts || [];
  const statusLabel = { unpaid: 'To`lanmagan', partial: 'Qisman', paid: 'To`langan' };
  const statusBadge = { unpaid: 'orange', partial: 'blue', paid: 'green' };

  return (
    <Modal open={Boolean(supplier)} onClose={close} wide title={`${supplier.supplier_name} — qarzdorlik`}>
      <div className="dw-detail">
        <div className="dw-detail-total">
          <span><small>Ta'minotchiga qarzimiz</small><b><AmountView value={Number(supplier.total_balance || 0)} currency="USD" rate={rate} /></b></span>
          <span><small>Jami partiyalar</small><b>{supplier.total_receipt_count || 0} ta</b></span>
          <span><small>To`lanmagan</small><b>{supplier.open_receipt_count || 0} ta</b></span>
        </div>
        {supplier.manual_debts && supplier.manual_debts.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Qo‘lda kiritilgan qarzdorliklar</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {supplier.manual_debts.map(md => (
                <div key={md.id} className="card" style={{ padding: 12, borderLeft: '4px solid var(--orange)' }}>
                  <div className="between">
                    <b><AmountView value={Number(md.amount)} currency={md.currency} rate={rate} /></b>
                    <small><CalendarDays size={11} /> {formatUzDate(md.created_at, { day: true, month: 'long', year: true })}</small>
                  </div>
                  {md.notes && <p style={{ margin: '6px 0 2px', fontSize: 12, color: 'var(--ink)' }}>{md.notes}</p>}
                  <small style={{ fontSize: 10, color: 'var(--muted)' }}>Kiritdi: {md.created_by_name || 'Menejer'}</small>
                </div>
              ))}
            </div>
          </div>
        )}
        <h3>Barcha partiyalar</h3>
        {receipts.length ? receipts.map(r => (
          <div key={r.id} className="supplier-receipt-card card" style={{ padding: 14, marginBottom: 10 }}>
            <div className="between" style={{ marginBottom: 8 }}>
              <div>
                <b>{r.receipt_no}</b><br />
                <small><CalendarDays size={11} /> {formatUzDate(r.received_at, { day: true, month: 'long', year: true })}</small>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Status type={statusBadge[r.payment_status] || 'gray'}>{statusLabel[r.payment_status] || r.payment_status}</Status><br />
                <b><AmountView value={Number(r.total_cost)} currency={r.currency} rate={rate} /></b>
              </div>
            </div>
            {r.products && r.products.length > 0 && (
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 'auto' }}>
                  <thead><tr><th>Tovar</th><th>SKU</th><th>Miqdor</th><th>Birlik narxi</th><th>Jami</th></tr></thead>
                  <tbody>
                    {r.products.map((p, i) => (
                      <tr key={i}>
                        <td><b>{p.product_name}</b></td>
                        <td>{p.sku}</td>
                        <td>{Number(p.quantity)} dona</td>
                        <td><AmountView value={Number(p.unit_cost)} currency={r.currency} rate={rate} /></td>
                        <td><b><AmountView value={Number(p.line_total)} currency={r.currency} rate={rate} /></b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
              <span>To`langan: <b style={{ color: 'var(--green)' }}><AmountView value={Number(r.paid_amount)} currency={r.currency} rate={rate} /></b></span>
              <span>Qoldiq: <b style={{ color: 'var(--red)' }}><AmountView value={Number(r.total_cost) - Number(r.paid_amount)} currency={r.currency} rate={rate} /></b></span>
            </div>
          </div>
        )) : <p className="dw-no-payments">Partiyalar topilmadi.</p>}
        <p style={{ marginTop: 16, padding: 12, background: '#fff7ed', borderRadius: 10, fontSize: 12, color: '#9a3412' }}>
          <AlertTriangle size={14} style={{ verticalAlign: 'middle' }} /> Qarz miqdorini faqat superadmin tahrirlashi mumkin.
        </p>
      </div>
    </Modal>
  );
}

function RegisterSupplierDebtModal({ open, onClose, branchId, toast, onSuccess, existingSuppliers }) {
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [customSupplierName, setCustomSupplierName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [allSuppliers, setAllSuppliers] = useState([]);

  useEffect(() => {
    if (open) {
      setSelectedSupplierId('');
      setCustomSupplierName('');
      setAmount('');
      setCurrency('USD');
      setNotes('');
      setFormError('');
      // Fetch active suppliers list for selection
      getBrowserClient()
        .from('suppliers')
        .select('id, name, code')
        .eq('is_active', true)
        .order('name')
        .then(({ data, error }) => {
          if (!error && data?.length) {
            setAllSuppliers(data);
          } else if (existingSuppliers?.length) {
            setAllSuppliers(existingSuppliers.map(s => ({ id: s.supplier_id, name: s.supplier_name, code: s.supplier_code })));
          }
        })
        .catch(() => {
          if (existingSuppliers?.length) {
            setAllSuppliers(existingSuppliers.map(s => ({ id: s.supplier_id, name: s.supplier_name, code: s.supplier_code })));
          }
        });
    }
  }, [open, existingSuppliers]);

  const handleSubmit = async e => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) {
      setFormError('Iltimos, noldan katta qarz summasini kiriting.');
      return;
    }

    const finalSupplierId = (selectedSupplierId && selectedSupplierId !== '__custom__') ? selectedSupplierId : null;
    let finalName = customSupplierName.trim();

    if (!finalName && finalSupplierId) {
      finalName = allSuppliers.find(s => s.id === finalSupplierId)?.name || '';
    }

    if (!finalSupplierId && finalName) {
      const matched = allSuppliers.find(s => s.name?.toLowerCase().trim() === finalName.toLowerCase().trim());
      if (matched) {
        finalName = matched.name;
      }
    }

    if (!finalName) {
      setFormError('Iltimos, ta‘minotchi nomini kiriting yoki ro‘yxatdan tanlang.');
      return;
    }

    setBusy(true);
    setFormError('');
    try {
      await registerSupplierDebt({
        supplierId: finalSupplierId,
        supplierName: finalName,
        amount: val,
        currency,
        notes: notes.trim() || null,
        branchId: branchId || null,
      });

      toast?.(`"${finalName}" ta'minotchisiga ${val} ${currency} qarz muvaffaqiyatli saqlandi!`);
      onSuccess?.();
      onClose();
    } catch (err) {
      setFormError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Ta'minotchiga qarz kiritish">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {formError && (
          <div className="tw-inline-error">
            {formError}
          </div>
        )}

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Ta'minotchi (Ro‘yxatdan tanlang)
          </label>
          <select
            className="select"
            value={selectedSupplierId}
            onChange={e => {
              const val = e.target.value;
              setSelectedSupplierId(val);
              if (val === '__custom__') {
                setCustomSupplierName('');
              } else if (val) {
                const s = allSuppliers.find(x => x.id === val);
                if (s) setCustomSupplierName(s.name);
              } else {
                setCustomSupplierName('');
              }
            }}
          >
            <option value="">-- Mavjud ta'minotchilar ro‘yxatidan tanlang --</option>
            {allSuppliers.map(s => (
              <option key={s.id} value={s.id}>
                📦 {s.name} {s.code ? `(${s.code})` : ''}
              </option>
            ))}
            <option value="__custom__">➕ Yangi ta'minotchi nomini yozish...</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Ta'minotchi nomi (qo‘lda yozish ham mumkin) *
          </label>
          <input
            type="text"
            className="input"
            placeholder="Masalan: Artel zavod, Akfa diler..."
            value={customSupplierName}
            onChange={e => setCustomSupplierName(e.target.value)}
            required
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 10 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
              Qarz summasi *
            </label>
            <input
              type="number"
              className="input"
              step="0.01"
              min="0.01"
              placeholder="Masalan: 1000"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
              Valyuta *
            </label>
            <select
              className="select"
              value={currency}
              onChange={e => setCurrency(e.target.value)}
            >
              <option value="USD">USD ($)</option>
              <option value="UZS">UZS (so‘m)</option>
            </select>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Izoh yoki sabab
          </label>
          <textarea
            className="input textarea"
            rows={3}
            placeholder="Qarz sababi, shartnoma yoki tovarlar haqida ma'lumot..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Bekor qilish
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saqlanmoqda…' : 'Saqlash'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BranchDebtSection({ branchId, toast, rate, pendingDebtCount = 0, onDebtConfirmed }) {
  const [direction, setDirection] = useState('debtor'); // 'debtor' | 'creditor' | 'all'
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ debtor: [], creditor: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [editDebt, setEditDebt] = useState(null);
  const [branches, setBranches] = useState([]);

  // Load available system branches for registration
  useEffect(() => {
    if (!branchId) return;
    getBrowserClient()
      .from('branches')
      .select('id, name, code, phone')
      .eq('is_active', true)
      .neq('id', branchId)
      .order('name')
      .then(({ data, error }) => {
        if (error) console.error('Error fetching branches:', error);
        setBranches(data || []);
      })
      .catch(err => console.error('Failed to load branches:', err));
  }, [branchId]);

  const load = async () => {
    if (!branchId) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const [list, totals] = await Promise.all([
        listBranchDebts({ branchId, direction, pageSize: 50 }),
        getBranchDebtSummary(branchId)
      ]);
      setRows(list?.items || []);
      setSummary(totals || { debtor: [], creditor: [] });
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [branchId, direction]);

  const open = async id => {
    setError('');
    try {
      setDetail(await getBranchDebt(id));
    } catch (e) {
      setError(message(e));
    }
  };

  const refreshed = async debt => {
    setDetail(debt);
    await load();
  };

  const handleEdit = debtToEdit => {
    setEditDebt(debtToEdit);
  };

  const handleDelete = async debtToDelete => {
    const debtNo = debtToDelete.transfer_no || debtToDelete.debt_no || 'Ushbu qarz';
    const confirmed = window.confirm(
      `Haqiqatan ham "${debtNo}" qarzdorligini o‘chirmoqchimisiz?\n\nBu qarz qarzdor filial hisobidan ham butunlay o‘chiriladi!`
    );
    if (!confirmed) return;
    try {
      await deleteBranchDebt(debtToDelete.id);
      toast?.('Filial qarzdorligi muvaffaqiyatli o‘chirildi');
      if (detail?.id === debtToDelete.id) {
        setDetail(null);
      }
      onDebtConfirmed?.();
      await load();
    } catch (e) {
      toast?.(message(e));
    }
  };

  const displayedSummary = direction === 'all'
    ? [...(summary.debtor || []).map(x => ({ ...x, side: 'Bizning qarzimiz' })), ...(summary.creditor || []).map(x => ({ ...x, side: 'Bizga qarz' }))]
    : summary[direction] || [];

  return (
    <section className="dw-workspace">
      <div className="between m-page-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>Filial qarzdorligi</h2>
          <p>Filiallararo hisob-kitoblar, mavjud aktivlar va transferlar qoldig‘i</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
          onClick={() => setRegisterOpen(true)}
        >
          <Plus size={16} />
          <span>Qarzdorni qayd etish</span>
        </button>
      </div>

      <div className="dw-tabs">
        {[
          ['debtor', 'Bizning qarzlarimiz'],
          ['creditor', 'Bizga qarzlar'],
          ['all', 'Barchasi']
        ].map(([key, text]) => {
          const showBadge = key === 'debtor' && pendingDebtCount > 0;
          return (
            <button
              key={key}
              className={direction === key ? 'active' : ''}
              onClick={() => setDirection(key)}
            >
              {text}
              {showBadge && (
                <span style={{
                  marginLeft: 6,
                  background: 'var(--orange, #f97316)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: 10,
                  display: 'inline-flex',
                  alignItems: 'center'
                }}>
                  +{pendingDebtCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="dw-summary">
        {displayedSummary.map((item, index) => (
          <article className="card" key={`${item.currency}-${item.side || direction}-${index}`}>
            <div>
              <Landmark />
              <span>
                <small>{item.side || 'Valyuta'}</small>
                <b>{item.currency}</b>
              </span>
            </div>
            <dl>
              <div><dt>Jami</dt><dd><AmountView value={Number(item.amount)} currency={item.currency} rate={rate} /></dd></div>
              <div><dt>To‘langan</dt><dd><AmountView value={Number(item.paid_amount)} currency={item.currency} rate={rate} /></dd></div>
              <div><dt>Qoldiq</dt><dd><AmountView value={Number(item.remaining_amount)} currency={item.currency} rate={rate} /></dd></div>
            </dl>
          </article>
        ))}
      </div>

      {loading ? (
        <div className="dw-state">Qarzlar yuklanmoqda…</div>
      ) : error ? (
        <div className="dw-state dw-error">
          <AlertTriangle />
          <b>Xatolik yuz berdi</b>
          <p>{error}</p>
          <button className="btn" onClick={load}>Qayta urinish</button>
        </div>
      ) : rows.length === 0 ? (
        <Empty title="Qarzlar topilmadi" text="Bu yo‘nalishda filial qarzi mavjud emas." />
      ) : (
        <div className="dw-list">
          {rows.map(row => (
            <DebtCard
              key={row.id}
              debt={row}
              branchId={branchId}
              open={() => open(row.id)}
              rate={rate}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Register Debt Modal */}
      <RegisterBranchDebtModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        branchId={branchId}
        branches={branches}
        toast={toast}
        onSuccess={() => {
          if (direction !== 'creditor' && direction !== 'all') {
            setDirection('creditor');
          }
          load();
        }}
      />

      {/* Edit Debt Modal */}
      <EditBranchDebtModal
        open={Boolean(editDebt)}
        onClose={() => setEditDebt(null)}
        debt={editDebt}
        branches={branches}
        toast={toast}
        onSuccess={async updated => {
          setEditDebt(null);
          if (detail?.id === updated?.id) {
            setDetail(updated);
          }
          onDebtConfirmed?.();
          await load();
        }}
      />

      <DebtDetail
        debt={detail}
        close={() => setDetail(null)}
        toast={toast}
        refreshed={refreshed}
        rate={rate}
        branchId={branchId}
        onDebtConfirmed={onDebtConfirmed}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </section>
  );
}

function RegisterBranchDebtModal({ open, onClose, branchId, branches, toast, onSuccess }) {
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [customBranchName, setCustomBranchName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (open) {
      setSelectedBranchId('');
      setCustomBranchName('');
      setAmount('');
      setCurrency('USD');
      setNotes('');
      setFormError('');
    }
  }, [open]);

  const handleSubmit = async e => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) {
      setFormError('Iltimos, noldan katta qarz summasini kiriting.');
      return;
    }

    const finalBranchId = (selectedBranchId && selectedBranchId !== '__custom__') ? selectedBranchId : null;
    let finalName = customBranchName.trim();

    if (!finalName && finalBranchId) {
      finalName = branches.find(b => b.id === finalBranchId)?.name || '';
    }

    if (!finalBranchId && finalName) {
      const matched = branches.find(b =>
        b.name?.toLowerCase().trim() === finalName.toLowerCase().trim() ||
        b.code?.toLowerCase().trim() === finalName.toLowerCase().trim()
      );
      if (matched) {
        finalName = matched.name;
      }
    }

    if (!finalName) {
      setFormError('Iltimos, qarzdor filialni tanlang yoki nomini yozing.');
      return;
    }

    setBusy(true);
    setFormError('');
    try {
      await registerBranchDebt({
        creditorBranchId: branchId,
        debtorBranchId: finalBranchId,
        targetBranchName: finalName,
        amount: val,
        currency,
        notes: notes.trim() || null,
      });

      toast?.(`"${finalName}" filialiga ${val} ${currency} qarzdorlik muvaffaqiyatli qayd etildi!`);
      onSuccess?.();
      onClose();
    } catch (err) {
      setFormError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Yangi filial qarzdorligini qayd etish">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {formError && (
          <div className="tw-inline-error">
            {formError}
          </div>
        )}

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Qarzdor filial (Tizimdagi filiallar ro‘yxati) *
          </label>
          <select
            className="select"
            value={selectedBranchId}
            onChange={e => {
              const val = e.target.value;
              setSelectedBranchId(val);
              if (val === '__custom__') {
                setCustomBranchName('');
              } else if (val) {
                const b = branches.find(x => x.id === val);
                if (b) setCustomBranchName(b.name);
              } else {
                setCustomBranchName('');
              }
            }}
          >
            <option value="">-- Mavjud filiallar ro‘yxatidan tanlang --</option>
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                🏛 {b.name} ({b.code})
              </option>
            ))}
            <option value="__custom__">➕ Boshqa / ro‘yxatda yo‘q filial nomini yozish...</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Qarzdor filial nomi (qo‘lda yozish ham mumkin) *
          </label>
          <input
            type="text"
            className="input"
            placeholder="Masalan: 1-filial, Chilonzor filiali..."
            value={customBranchName}
            onChange={e => setCustomBranchName(e.target.value)}
            required
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 10 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
              Hozirgi qarz miqdori *
            </label>
            <input
              type="number"
              className="input"
              step="0.01"
              min="0.01"
              placeholder="Masalan: 50000"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
              Valyuta *
            </label>
            <select
              className="select"
              value={currency}
              onChange={e => setCurrency(e.target.value)}
            >
              <option value="USD">USD ($)</option>
              <option value="UZS">UZS (so‘m)</option>
            </select>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Qo‘shimcha izoh yoki sabab
          </label>
          <textarea
            className="input textarea"
            rows={3}
            placeholder="Masalan: Filialdagi mavjud tovarlar aktivlari, boshlang‘ich hisob-kitob balansi..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div style={{ background: '#f8fafc', padding: 10, borderRadius: 9, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
          💡 <b>Avtomatlashtirilgan hisob:</b> Ushbu filialga qarz qayd etilgach, undan keyingi barcha tovar transferlari avtomatik tarzda uning qarzdorlik balansiga qo‘shib boriladi.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Bekor qilish
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Yuborilmoqda…' : 'Qayd etish va yuborish'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditBranchDebtModal({ open, onClose, debt, branches = [], toast, onSuccess }) {
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [customBranchName, setCustomBranchName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (open && debt) {
      setSelectedBranchId(debt.debtor_branch_id || (debt.target_branch_name ? '__custom__' : ''));
      setCustomBranchName(debt.debtor_branch_name || debt.target_branch_name || '');
      setAmount(String(debt.amount ?? ''));
      setCurrency(debt.currency || 'USD');
      setNotes(debt.notes || '');
      setFormError('');
    }
  }, [open, debt]);

  if (!debt) return null;

  const paidAmount = Number(debt.paid_amount || 0);

  const handleSubmit = async e => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) {
      setFormError('Iltimos, noldan katta qarz summasini kiriting.');
      return;
    }

    if (paidAmount > 0 && val < paidAmount) {
      setFormError(`Yangi qarz summasi allaqachon to‘langan summadan (${paidAmount} ${currency}) kam bo‘lishi mumkin emas.`);
      return;
    }

    const finalBranchId = (selectedBranchId && selectedBranchId !== '__custom__') ? selectedBranchId : null;
    let finalName = customBranchName.trim();

    if (!finalName && finalBranchId) {
      finalName = branches.find(b => b.id === finalBranchId)?.name || '';
    }

    if (!finalBranchId && finalName) {
      const matched = branches.find(b =>
        b.name?.toLowerCase().trim() === finalName.toLowerCase().trim() ||
        b.code?.toLowerCase().trim() === finalName.toLowerCase().trim()
      );
      if (matched) {
        finalName = matched.name;
      }
    }

    if (!finalName) {
      setFormError('Iltimos, qarzdor filialni tanlang yoki nomini yozing.');
      return;
    }

    setBusy(true);
    setFormError('');
    try {
      const updated = await updateBranchDebt({
        debtId: debt.id,
        debtorBranchId: finalBranchId,
        targetBranchName: finalName,
        amount: val,
        currency,
        notes: notes.trim() || null,
      });

      toast?.(`"${finalName}" filialiga qarz muvaffaqiyatli tahrirlandi!`);
      onSuccess?.(updated);
      onClose();
    } catch (err) {
      setFormError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Filial qarzini tahrirlash (${debt.transfer_no || debt.debt_no || ''})`}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {formError && (
          <div className="tw-inline-error">
            {formError}
          </div>
        )}

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Qarzdor filial (Tizimdagi filiallar ro‘yxati) *
          </label>
          <select
            className="select"
            value={selectedBranchId}
            onChange={e => {
              const val = e.target.value;
              setSelectedBranchId(val);
              if (val === '__custom__') {
                setCustomBranchName('');
              } else if (val) {
                const b = branches.find(x => x.id === val);
                if (b) setCustomBranchName(b.name);
              } else {
                setCustomBranchName('');
              }
            }}
          >
            <option value="">-- Mavjud filiallar ro‘yxatidan tanlang --</option>
            {branches.map(b => (
              <option key={b.id} value={b.id}>
                🏛 {b.name} ({b.code})
              </option>
            ))}
            <option value="__custom__">➕ Boshqa / ro‘yxatda yo‘q filial nomini yozish...</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Qarzdor filial nomi (qo‘lda yozish ham mumkin) *
          </label>
          <input
            type="text"
            className="input"
            placeholder="Masalan: 1-filial, Chilonzor filiali..."
            value={customBranchName}
            onChange={e => setCustomBranchName(e.target.value)}
            required
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 10 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
              Qarz miqdori * {paidAmount > 0 && <span style={{ color: 'var(--muted)', fontWeight: 'normal' }}>(To‘langan: {paidAmount})</span>}
            </label>
            <input
              type="number"
              className="input"
              step="0.01"
              min={paidAmount > 0 ? paidAmount : 0.01}
              placeholder="Masalan: 50000"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
              Valyuta *
            </label>
            <select
              className="select"
              value={currency}
              onChange={e => setCurrency(e.target.value)}
            >
              <option value="USD">USD ($)</option>
              <option value="UZS">UZS (so‘m)</option>
            </select>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5 }}>
            Qo‘shimcha izoh yoki sabab
          </label>
          <textarea
            className="input textarea"
            rows={3}
            placeholder="Qarz sababi yoki izoh..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div style={{ background: '#f8fafc', padding: 10, borderRadius: 9, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
          💡 <b>Sinxronizatsiya:</b> Ushbu qarzni tahrirlaganingizda o‘zgarishlar qarzdor filial sahifasida ham avtomatik aks etadi.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Bekor qilish
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saqlanmoqda…' : 'O‘zgarishlarni saqlash'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DebtCard({ debt, branchId, open, rate, onEdit, onDelete }) {
  const debtor = debt.debtor_branch_id === branchId;
  const isPendingDebt = debt.is_confirmed === false;
  const pendingPaymentsCount = Number(debt.pending_payments_count || 0);
  const pendingPaymentsTotal = Number(debt.pending_payments_total || 0);

  return (
    <div
      className="card dw-card"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      <span className="dw-card-icon" style={isPendingDebt || pendingPaymentsCount > 0 ? { background: '#fff7ed', color: '#f97316' } : {}}>
        <ReceiptText />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="between" style={{ alignItems: 'center' }}>
          <b>{debt.transfer_no || debt.debt_no}</b>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {isPendingDebt && (
              <Status type="orange">
                {debtor ? 'Qarz tasdiqlash kutilmoqda' : 'Qarz tasdiqlanishi kutilmoqda'}
              </Status>
            )}
            {pendingPaymentsCount > 0 && (
              <Status type="orange">
                {debtor ? 'To‘lov tasdiqlanishi kutilmoqda' : `${pendingPaymentsCount} to‘lov kutilmoqda`}
              </Status>
            )}
            <Status type={badge[debt.status]}>{labels[debt.status] || debt.status}</Status>
          </div>
        </div>

        <strong>{debtor ? debt.creditor_branch_name : debt.debtor_branch_name}</strong>
        <small>{debtor ? 'Kreditor filial (Biz qarzmiz)' : 'Qarzdor filial'}</small>

        <div className="dw-amounts">
          <span>Jami <b><AmountView value={Number(debt.amount)} currency={debt.currency} rate={rate} /></b></span>
          <span>To‘langan <b><AmountView value={Number(debt.paid_amount)} currency={debt.currency} rate={rate} /></b></span>
          {pendingPaymentsTotal > 0 && (
            <span style={{ color: '#ea580c' }}>
              Kutilmoqda <b><AmountView value={pendingPaymentsTotal} currency={debt.currency} rate={rate} /></b>
            </span>
          )}
          <span>Qoldiq <b><AmountView value={Number(debt.remaining_amount)} currency={debt.currency} rate={rate} /></b></span>
        </div>

        <div className="between" style={{ alignItems: 'center', marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
          <span className="dw-date" style={{ margin: 0 }}><CalendarDays />{date(debt.created_at)}</span>

          {!debtor && (
            <div
              style={{ display: 'flex', gap: 6, alignItems: 'center' }}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                className="btn btn-ghost"
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  height: 'auto',
                  lineHeight: 1.2,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: '#f1f5f9',
                  borderRadius: 6
                }}
                onClick={() => onEdit?.(debt)}
                title="Tahrirlash"
              >
                <Edit3 size={12} />
                <span>Tahrirlash</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  height: 'auto',
                  lineHeight: 1.2,
                  color: '#dc2626',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: '#fef2f2',
                  borderRadius: 6
                }}
                onClick={() => onDelete?.(debt)}
                title="O‘chirish"
              >
                <Trash2 size={12} />
                <span>O‘chirish</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <ChevronRight />
    </div>
  );
}

function DebtDetail({ debt, close, toast, refreshed, rate, branchId, onDebtConfirmed, onEdit, onDelete }) {
  const [form, setForm] = useState({ amount: '', method: 'Naqd', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmPaymentBusyId, setConfirmPaymentBusyId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm({ amount: '', method: 'Naqd', reference: '', notes: '' });
    setError('');
  }, [debt?.id]);

  if (!debt) return null;

  const remaining = Number(debt.remaining_amount || 0);
  const transfer = debt.transfer;
  const debtor = debt.debtor_branch_id === branchId;
  const isPendingDebt = debt.is_confirmed === false;
  const pendingPaymentsCount = Number(debt.pending_payments_count || 0);
  const pendingPaymentsTotal = Number(debt.pending_payments_total || 0);

  const handleConfirmDebt = async () => {
    setConfirmBusy(true);
    try {
      const updated = await confirmBranchDebt(debt.id);
      toast?.('Filial qarzdorligi muvaffaqiyatli tasdiqlandi!');
      onDebtConfirmed?.();
      await refreshed(updated);
    } catch (e) {
      setError(message(e));
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleConfirmPayment = async (paymentId) => {
    setConfirmPaymentBusyId(paymentId);
    setError('');
    try {
      const updated = await confirmBranchDebtPayment(paymentId);
      toast?.('Pul qabul qilinganligi tasdiqlandi va qarz kamaytirildi!');
      onDebtConfirmed?.();
      await refreshed(updated);
    } catch (e) {
      setError(message(e));
    } finally {
      setConfirmPaymentBusyId(null);
    }
  };

  const handleRejectPayment = async (paymentId) => {
    const reason = window.prompt('To‘lovni rad etish sababi (ixtiyoriy):', 'Pul yetib kelmadi');
    if (reason === null) return;
    setConfirmPaymentBusyId(paymentId);
    setError('');
    try {
      const updated = await rejectBranchDebtPayment(paymentId, reason);
      toast?.('To‘lov rad etildi');
      onDebtConfirmed?.();
      await refreshed(updated);
    } catch (e) {
      setError(message(e));
    } finally {
      setConfirmPaymentBusyId(null);
    }
  };

  const pay = async e => {
    e.preventDefault();
    const value = Number(form.amount);
    if (!Number.isFinite(value) || value <= 0) return setError('To‘lov summasi noldan katta bo‘lishi kerak.');
    if (value > remaining) return setError('To‘lov qoldiq qarzdan oshmasligi kerak.');
    setBusy(true);
    setError('');
    try {
      const updated = await recordBranchDebtPayment({
        debtId: debt.id,
        amount: value,
        currency: debt.currency,
        method: form.method,
        reference: form.reference,
        notes: form.notes,
        payerBranchId: debtor ? debt.debtor_branch_id : debt.creditor_branch_id
      });
      if (debtor) {
        toast?.('To‘lov yuborildi. Haqdor filial menejeri pulni olganini tasdiqlashi kutilmoqda.');
      } else {
        toast?.('Qarz to‘lovi muvaffaqiyatli qayd etildi');
      }
      onDebtConfirmed?.();
      await refreshed(updated);
      setForm({ amount: '', method: 'Naqd', reference: '', notes: '' });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(debt)} onClose={close} wide title={debt.transfer_no || debt.debt_no || 'Qarz'}>
      <div className="dw-detail">
        {/* Actions for creditor branch (Bizga qarz) */}
        {!debtor && (
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            alignItems: 'center',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            padding: '8px 12px',
            borderRadius: 10
          }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                background: '#fff',
                border: '1px solid #cbd5e1'
              }}
              onClick={() => onEdit?.(debt)}
            >
              <Edit3 size={14} />
              <span>Qarzni tahrirlash</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{
                color: '#dc2626',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                background: '#fef2f2',
                border: '1px solid #fecaca'
              }}
              onClick={() => onDelete?.(debt)}
            >
              <Trash2 size={14} />
              <span>Qarzni butunlay o‘chirish</span>
            </button>
          </div>
        )}

        {/* If pending initial debt confirmation by this debtor branch */}
        {isPendingDebt && debtor && (
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', padding: 14, borderRadius: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <b style={{ color: '#c2410c', fontSize: 13 }}>⚡ Yangi filial qarzdorligi so‘rovi</b>
              <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                {debt.creditor_branch_name} filiali tomonidan hisobingizga ushbu qarzdorlik kiritildi.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmDebt}
              disabled={confirmBusy}
              style={{ fontWeight: 700 }}
            >
              <CheckCircle2 size={16} />
              <span>{confirmBusy ? 'Tasdiqlanmoqda…' : 'Qabul qilish va tasdiqlash'}</span>
            </button>
          </div>
        )}

        {/* If pending initial debt confirmation, and viewer is creditor branch */}
        {isPendingDebt && !debtor && (
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', padding: 12, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>⏳</span>
            <div>
              <b style={{ color: '#c2410c', fontSize: 13 }}>Qarz tasdiqlanishi kutilmoqda</b>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                {debt.debtor_branch_name} filiali ushbu qarzdorlikni qabul qilib tasdiqlashi kutilmoqda.
              </p>
            </div>
          </div>
        )}

        {/* If debtor made payments and creditor manager needs to confirm receipt */}
        {pendingPaymentsCount > 0 && !debtor && (
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 24 }}>⚡</span>
            <div style={{ flex: 1 }}>
              <b style={{ color: '#c2410c', fontSize: 14 }}>
                Qarzdor filial to‘lov kiritgan ({pendingPaymentsCount} ta to‘lov tasdiqlash kutilmoqda)
              </b>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: '#7c2d12', lineHeight: 1.4 }}>
                Qarzdor filial joriy qarz uchun pul to‘laganini yozdi. Haqiqatdan ham naqd yoki bank orqali pulni olgan bo‘lsangiz, quyidagi to‘lovlar ro‘yxatidan <b>"Qabul qildim (Tasdiqlash)"</b> tugmasini bosing. Shunda qarz balansi kamayadi.
              </p>
            </div>
          </div>
        )}

        {/* If debtor made payments and is awaiting creditor confirmation */}
        {pendingPaymentsCount > 0 && debtor && (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', padding: 12, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>ℹ️</span>
            <div>
              <b style={{ color: '#1d4ed8', fontSize: 13 }}>To‘lovingiz tasdiqlanishi kutilmoqda</b>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#1e40af' }}>
                Siz kiritgan to‘lov haqdor filial ({debt.creditor_branch_name}) menejeri pulni qabul qilganini tasdiqlaganidan so‘ng qarz hisobidan yechiladi.
              </p>
            </div>
          </div>
        )}

        <div className="dw-detail-status">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Status type={badge[debt.status]}>{labels[debt.status] || debt.status}</Status>
            {isPendingDebt ? (
              <Status type="orange">{debtor ? 'Qarz tasdiqlash kutilmoqda' : 'Qarz tasdiqlanishi kutilmoqda'}</Status>
            ) : (
              <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>✓ Qarz tasdiqlangan</span>
            )}
            {pendingPaymentsCount > 0 && (
              <Status type="orange">{pendingPaymentsCount} ta to‘lov kutilmoqda</Status>
            )}
          </div>
          <small>Qarz yaratildi: {date(debt.created_at)}</small>
        </div>

        <div className="dw-parties">
          <span><small>Qarzdor filial</small><b>{debt.debtor_branch_name}</b></span>
          <i>→</i>
          <span><small>Kreditor filial</small><b>{debt.creditor_branch_name}</b></span>
        </div>

        <div className="dw-detail-total">
          <span><small>Jami qarz miqdori</small><b><AmountView value={Number(debt.amount)} currency={debt.currency} rate={rate} /></b></span>
          <span><small>Qaytarilgan summa</small><b><AmountView value={Number(debt.paid_amount)} currency={debt.currency} rate={rate} /></b></span>
          {pendingPaymentsTotal > 0 && (
            <span style={{ color: '#ea580c' }}>
              <small style={{ color: '#ea580c', fontWeight: 600 }}>Kutilayotgan to‘lovlar</small>
              <b><AmountView value={pendingPaymentsTotal} currency={debt.currency} rate={rate} /></b>
            </span>
          )}
          <span><small>Qoldiq qarz</small><b style={{ color: 'var(--orange)' }}><AmountView value={Number(debt.remaining_amount)} currency={debt.currency} rate={rate} /></b></span>
        </div>

        {debt.notes && (
          <div style={{ background: '#f8fafc', padding: 10, borderRadius: 9, fontSize: 12 }}>
            <b>Izoh va harakatlar:</b>
            <div style={{ whiteSpace: 'pre-line', marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>{debt.notes}</div>
          </div>
        )}

        {/* Accumulated Transfers History */}
        {debt.transfers_history?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Qo‘shilgan transferlar tarixi ({debt.transfers_history.length} ta)</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
              {debt.transfers_history.map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: '8px 12px', borderRadius: 8, fontSize: 12 }}>
                  <div>
                    <b>#{t.transfer_no}</b>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 10 }}>
                      {new Date(t.created_at).toLocaleString('uz-UZ')}
                    </small>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <b style={{ color: t.status === 'cancelled' ? 'var(--red)' : '#16a34a', fontSize: 13 }}>
                      {t.status === 'cancelled' ? '- ' : '+ '}
                      {t.currency === 'USD' ? `$${Number(t.amount).toFixed(2)}` : `${Number(t.amount)} so‘m`}
                    </b>
                    {t.status === 'cancelled' && (
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--red)' }}>Bekor qilingan</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Single Transfer details if from direct transfer */}
        {transfer && (
          <section className="dw-transfer-detail">
            <h3>Transfer va qabul tafsilotlari</h3>
            <div className="dw-transfer-dates">
              <span><small>So‘rov sanasi</small><b>{date(transfer.requested_at)}</b></span>
              <span><small>Jo‘natilgan sana</small><b>{date(transfer.shipped_at)}</b></span>
              <span><small>Qabul qilingan sana</small><b>{date(transfer.received_at)}</b></span>
            </div>
            <div className="dw-transfer-route">
              <span>{transfer.from_location_name}</span><i>→</i><span>{transfer.to_location_name}</span>
            </div>
            {transfer.notes && <p className="tw-notes">{transfer.notes}</p>}
            <h3>Qabul qilingan mahsulotlar ({transfer.lines?.length || 0})</h3>
            <div className="tw-detail-lines">
              {transfer.lines?.map(line => (
                <div key={line.id}>
                  {line.image ? <img src={line.image} alt="" /> : <span className="tw-image-fallback"><PackagePlus /></span>}
                  <span><b>{line.product_name}</b><small>{line.sku} · QR: {line.qr_code}{line.serial_number ? ` · S/N: ${line.serial_number}` : ''}</small></span>
                  <strong><AmountView value={Number(line.line_amount)} currency={debt.currency} rate={rate} /></strong>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Payments History */}
        <div className="between" style={{ alignItems: 'center', margin: '14px 0 8px' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>To‘lovlar tarixi</h3>
          {pendingPaymentsCount > 0 && (
            <span style={{ background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12 }}>
              {pendingPaymentsCount} ta to‘lov tasdiqlash kutilmoqda
            </span>
          )}
        </div>

        {debt.payments?.length ? (
          <div className="dw-payments" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {debt.payments.map(payment => {
              const isPaymentPending = payment.status === 'pending' || payment.is_confirmed === false;
              const isPaymentRejected = payment.status === 'rejected';
              return (
                <div key={payment.id} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  padding: '12px 14px',
                  background: isPaymentPending ? '#fff7ed' : isPaymentRejected ? '#fef2f2' : '#f8fafc',
                  border: isPaymentPending ? '1.5px solid #fed7aa' : isPaymentRejected ? '1px solid #fecaca' : '1px solid #e2e8f0',
                  borderRadius: 10,
                  gap: 12,
                  flexWrap: 'wrap'
                }}>
                  <div style={{ flex: '1 1 240px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <b><AmountView value={Number(payment.amount)} currency={payment.currency} rate={rate} /></b>
                      {isPaymentPending && (
                        <span style={{ background: '#ea580c', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>
                          ⏳ Tasdiqlash kutilmoqda
                        </span>
                      )}
                      {isPaymentRejected && (
                        <span style={{ background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>
                          ✕ Rad etilgan
                        </span>
                      )}
                      {!isPaymentPending && !isPaymentRejected && (
                        <span style={{ color: '#16a34a', fontSize: 11, fontWeight: 700 }}>
                          ✓ Tasdiqlangan
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      <span>Usul: <b>{payment.method}</b></span>
                      {payment.reference && <span> · Hujjat: {payment.reference}</span>}
                      {payment.payer_branch_name && <span> · To‘lovchi: <b>{payment.payer_branch_name}</b></span>}
                    </div>
                    {payment.notes && (
                      <div style={{ fontSize: 11, marginTop: 4, color: isPaymentRejected ? '#b91c1c' : '#475569', background: '#ffffff80', padding: '3px 6px', borderRadius: 4 }}>
                        {payment.notes}
                      </div>
                    )}
                    <time style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      {date(payment.paid_at)}
                      {payment.confirmed_by_name && ` · Tasdiqladi: ${payment.confirmed_by_name}`}
                    </time>
                  </div>

                  {/* Actions for Creditor */}
                  {isPaymentPending && !debtor && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ background: '#16a34a', borderColor: '#16a34a', padding: '6px 12px', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                        onClick={() => handleConfirmPayment(payment.id)}
                        disabled={confirmPaymentBusyId === payment.id}
                      >
                        <CheckCircle2 size={15} />
                        <span>{confirmPaymentBusyId === payment.id ? 'Tasdiqlanmoqda…' : 'Qabul qildim (Tasdiqlash)'}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ color: '#dc2626', padding: '6px 10px', fontSize: 12 }}
                        onClick={() => handleRejectPayment(payment.id)}
                        disabled={confirmPaymentBusyId === payment.id}
                      >
                        <XCircle size={15} />
                        <span>Rad etish</span>
                      </button>
                    </div>
                  )}

                  {/* Notice for Debtor */}
                  {isPaymentPending && debtor && (
                    <div style={{ fontSize: 11, color: '#c2410c', background: '#ffedd5', padding: '5px 10px', borderRadius: 6, fontWeight: 500 }}>
                      ⏳ Haqdor filial menejeri pulni qabul qilib tasdiqlashi kutilmoqda
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="dw-no-payments">Hozircha to‘lov kiritilmagan.</p>
        )}

        {/* Record Payment Form */}
        {remaining > 0 && (
          <form className="dw-payment-form" onSubmit={pay}>
            <h3>Qarzni to‘lash / kamaytirish</h3>
            {error && <div className="tw-inline-error">{error}</div>}
            <div className="dw-form-grid">
              <label>
                <span>Summa ({debt.currency})</span>
                <input
                  className="input"
                  type="number"
                  min="0.01"
                  max={remaining}
                  step="0.01"
                  value={form.amount}
                  onChange={e => setForm({ ...form, amount: e.target.value })}
                  required
                />
              </label>
              <label>
                <span>To‘lov usuli</span>
                <select className="select" value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>
                  <option>Naqd</option>
                  <option>Bank o‘tkazmasi</option>
                  <option>Terminal</option>
                  <option>Boshqa</option>
                </select>
              </label>
              <label>
                <span>Havola yoki hujjat raqami</span>
                <input className="input" value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} />
              </label>
              <label>
                <span>Izoh</span>
                <input className="input" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
              </label>
            </div>

            <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 8, fontSize: 12, color: 'var(--muted)', marginTop: 8, marginBottom: 10 }}>
              {debtor ? (
                <>💡 <b>Eslatma:</b> Siz kiritgan to‘lov haqdor filial menejeri tomonidan pul qabul qilingani tasdiqlangandan so‘ng qarz hisobidan yechiladi.</>
              ) : (
                <>💡 <b>Eslatma:</b> Siz haqdor filial sifatida kiritgan to‘lov darhol tasdiqlanadi va qarz balansidan yechiladi.</>
              )}
            </div>

            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Saqlanmoqda…' : debtor ? 'To‘lovni yuborish (Tasdiqlash uchun)' : 'To‘lovni kiritish'}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}

