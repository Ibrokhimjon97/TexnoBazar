import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MinusCircle, Trash2, Calendar, Tag, FileText, AlertCircle, X, Clock, User, Banknote, CreditCard, Edit3, Search, Check, RotateCcw } from 'lucide-react';
import { DualPrice } from '@texnobazar/ui';
import { addPosCashExpense, listPosCashExpenses, deletePosCashExpense, updatePosCashExpense } from '@texnobazar/data';

const EXPENSE_CATEGORIES = [
  { code: 'other', name: 'Boshqa xarajat' },
  { code: 'transport', name: 'Transport / Yoqilg‘i / Taxi' },
  { code: 'salary', name: 'Tushlik / Xodimlar ehtiyoji' },
  { code: 'electricity', name: 'Elektr energiyasi' },
  { code: 'water', name: 'Suv ta’minoti' },
  { code: 'gas', name: 'Gaz to‘lovi' },
  { code: 'rent', name: 'Bino / Joy ijarasi' },
  { code: 'tax', name: 'Soliq to‘lovi' }
];

function getTashkentToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
  } catch {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

export function CashExpenseModal({
  open,
  onClose,
  branchId,
  dateRange,
  periodTitle = 'Bugun',
  rate,
  toast,
  onSaved
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('other');
  const [paymentMethod, setPaymentMethod] = useState('cash'); // 'cash' | 'card'
  const [expenseDate, setExpenseDate] = useState(() => {
    return dateRange?.startDate || getTashkentToday();
  });
  const [submitting, setSubmitting] = useState(false);

  const [expenses, setExpenses] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  // Edit and Search state
  const [editingExpense, setEditingExpense] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [listFilter, setListFilter] = useState('all'); // 'all' | 'cash' | 'card'

  const scrollRef = useRef(null);

  const loadExpenses = async () => {
    if (!branchId) return;
    setLoadingList(true);
    try {
      const data = await listPosCashExpenses({
        branchId,
        startDate: dateRange?.startDate || null,
        endDate: dateRange?.endDate || null
      });
      setExpenses(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load cash expenses:', err);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    if (open) {
      setAmount('');
      setNote('');
      setCategory('other');
      setPaymentMethod('cash');
      setEditingExpense(null);
      setSearchTerm('');
      setListFilter('all');
      setExpenseDate(dateRange?.startDate || getTashkentToday());
      loadExpenses();
    }
  }, [open, branchId, dateRange?.startDate, dateRange?.endDate]);

  if (!open) return null;

  const totalExpenseSum = expenses.reduce((acc, it) => acc + Number(it.paid_amount || it.amount || 0), 0);
  const cashExpenseSum = expenses
    .filter(it => (it.payment_method || 'cash') === 'cash')
    .reduce((acc, it) => acc + Number(it.paid_amount || it.amount || 0), 0);
  const cardExpenseSum = expenses
    .filter(it => it.payment_method === 'card')
    .reduce((acc, it) => acc + Number(it.paid_amount || it.amount || 0), 0);

  const startEdit = (exp) => {
    setEditingExpense(exp);
    setAmount(String(exp.paid_amount || exp.amount || ''));
    setNote(exp.note || exp.title || '');
    setCategory(exp.category || 'other');
    setPaymentMethod(exp.payment_method === 'card' ? 'card' : 'cash');
    const rawDate = exp.paid_at || exp.created_at;
    if (rawDate) {
      try {
        setExpenseDate(new Date(rawDate).toISOString().slice(0, 10));
      } catch {
        setExpenseDate(dateRange?.startDate || getTashkentToday());
      }
    } else {
      setExpenseDate(dateRange?.startDate || getTashkentToday());
    }
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditingExpense(null);
    setAmount('');
    setNote('');
    setCategory('other');
    setPaymentMethod('cash');
    setExpenseDate(dateRange?.startDate || getTashkentToday());
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const cleanAmountStr = String(amount ?? '').trim().replace(/\s+/g, '').replace(/,/g, '.');
    const numAmount = Number(cleanAmountStr);
    if (!numAmount || numAmount <= 0 || isNaN(numAmount)) {
      toast?.('Iltimos, to‘g‘ri xarajat summasini kiriting');
      return;
    }
    if (!note.trim()) {
      toast?.('Iltimos, xarajat sababi yoki izohini yozing');
      return;
    }

    setSubmitting(true);
    try {
      if (editingExpense) {
        await updatePosCashExpense({
          expenseId: editingExpense.id,
          amount: numAmount,
          note: note.trim(),
          category,
          date: expenseDate || null,
          paymentMethod
        });
        toast?.('Xarajat muvaffaqiyatli tahrirlandi!');
        cancelEdit();
      } else {
        await addPosCashExpense({
          branchId,
          amount: numAmount,
          note: note.trim(),
          category,
          date: expenseDate || null,
          paymentMethod
        });
        toast?.(paymentMethod === 'card'
          ? 'Xarajat saqlandi va plastik kartadan ayirildi!'
          : 'Xarajat saqlandi va kassadagi naqd puldan ayirildi!');
        setAmount('');
        setNote('');
      }

      await loadExpenses();
      onSaved?.();
    } catch (err) {
      toast?.(err?.message || 'Xarajatni saqlab bo‘lmadi');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (exp) => {
    const title = exp.note || exp.title || 'Ushbu xarajat';
    const sumFormatted = new Intl.NumberFormat('uz-UZ').format(exp.amount);
    const sourceLabel = exp.payment_method === 'card' ? 'plastik karta hisobiga' : 'kassadagi naqd pulga';
    if (!window.confirm(`${sumFormatted} so‘mlik "${title}" ni o‘chirmoqchimisiz? Ushbu summa ${sourceLabel} qaytariladi.`)) {
      return;
    }

    setDeletingId(exp.id);
    try {
      await deletePosCashExpense(exp.id);
      toast?.(`Xarajat o‘chirildi va summa ${sourceLabel} tiklandi`);
      if (editingExpense?.id === exp.id) {
        cancelEdit();
      }
      await loadExpenses();
      onSaved?.();
    } catch (err) {
      toast?.(err?.message || 'O‘chirib bo‘lmadi');
    } finally {
      setDeletingId(null);
    }
  };

  const formatDateTime = (val) => {
    if (!val) return '—';
    const d = new Date(val);
    return d.toLocaleString('uz-UZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Filtered expenses based on search and method filter
  const filteredExpenses = useMemo(() => {
    return expenses.filter(exp => {
      // Method filter
      if (listFilter === 'cash' && exp.payment_method === 'card') return false;
      if (listFilter === 'card' && exp.payment_method !== 'card') return false;

      // Search term
      if (!searchTerm.trim()) return true;
      const q = searchTerm.trim().toLowerCase();
      const text = `${exp.note || ''} ${exp.title || ''} ${exp.created_by_name || ''} ${exp.category || ''} ${exp.amount || ''}`.toLowerCase();
      if (text.includes(q)) return true;
      if (q === 'naqd' && (exp.payment_method || 'cash') === 'cash') return true;
      if ((q === 'plastik' || q === 'karta') && exp.payment_method === 'card') return true;
      return false;
    });
  }, [expenses, listFilter, searchTerm]);

  return (
    <div
      className="overlay"
      style={{ zIndex: 1200 }}
      onMouseDown={e => e.target === e.currentTarget && onClose?.()}
    >
      <div
        className="modal"
        style={{
          maxWidth: 680,
          width: '95vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          borderRadius: 14,
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          background: 'linear-gradient(135deg, #881337, #be123c)',
          color: '#ffffff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
              <MinusCircle size={20} style={{ color: '#fecdd3' }} />
              Kassadan xarajat chiqarish
            </h3>
            <small style={{ color: '#ffe4e6', fontSize: 12 }}>
              Davr: <b>{periodTitle}</b> · Jami chiqim: <b>{new Intl.NumberFormat('uz-UZ').format(totalExpenseSum)} so‘m</b>
              {cardExpenseSum > 0 && (
                <span style={{ marginLeft: 6, opacity: 0.9 }}>
                  (Naqd: <b>{new Intl.NumberFormat('uz-UZ').format(cashExpenseSum)}</b> · Plastik: <b>{new Intl.NumberFormat('uz-UZ').format(cardExpenseSum)}</b>)
                </span>
              )}
            </small>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            style={{ color: '#ffe4e6' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
          {/* Form Card */}
          <form noValidate onSubmit={handleSubmit} style={{
            background: editingExpense ? '#f0fdf4' : '#fff1f2',
            border: `1.5px solid ${editingExpense ? '#86efac' : '#fecdd3'}`,
            borderRadius: 12,
            padding: '16px',
            marginBottom: 20,
            transition: 'all 0.2s ease'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: editingExpense ? '#166534' : '#9f1239' }}>
                {editingExpense ? <Edit3 size={17} /> : <AlertCircle size={16} />}
                <span style={{ fontSize: 13, fontWeight: 800 }}>
                  {editingExpense
                    ? 'Xarajatni tahrirlash'
                    : paymentMethod === 'card'
                    ? 'Plastik karta hisobidan olinadigan chiqimni kiriting'
                    : 'Kassadagi naqd puldan olinadigan chiqimni kiriting'}
                </span>
              </div>
              {editingExpense && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={cancelEdit}
                  style={{
                    fontSize: 11.5,
                    padding: '3px 9px',
                    borderRadius: 6,
                    background: '#ffffff',
                    border: '1px solid #cbd5e1',
                    color: '#475569',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  Bekor qilish
                </button>
              )}
            </div>

            {/* Payment Source Selector (Naqd vs Plastik) */}
            <div style={{ marginBottom: 14 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: editingExpense ? '#166534' : '#881337', marginBottom: 6 }}>
                Pul olinadigan manba (To‘lov turi) *
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('cash')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '9px 12px',
                    borderRadius: 8,
                    border: `2px solid ${paymentMethod === 'cash' ? '#e11d48' : '#fda4af'}`,
                    background: paymentMethod === 'cash' ? '#ffffff' : '#fff5f5',
                    color: paymentMethod === 'cash' ? '#be123c' : '#881337',
                    fontWeight: paymentMethod === 'cash' ? 800 : 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    boxShadow: paymentMethod === 'cash' ? '0 2px 6px rgba(225,29,72,0.15)' : 'none',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Banknote size={17} />
                  💵 Naqd puldan
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('card')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '9px 12px',
                    borderRadius: 8,
                    border: `2px solid ${paymentMethod === 'card' ? '#0284c7' : '#bae6fd'}`,
                    background: paymentMethod === 'card' ? '#ffffff' : '#f0f9ff',
                    color: paymentMethod === 'card' ? '#0369a1' : '#075985',
                    fontWeight: paymentMethod === 'card' ? 800 : 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    boxShadow: paymentMethod === 'card' ? '0 2px 6px rgba(2,132,199,0.15)' : 'none',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <CreditCard size={17} />
                  💳 Plastik kartadan
                </button>
              </div>
            </div>

            {/* Amount input */}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: editingExpense ? '#166534' : '#881337', marginBottom: 5 }}>
                Harajat summasi (so‘m) *
              </span>
              <div style={{ position: 'relative' }}>
                <input
                  type="number"
                  min="1"
                  step="any"
                  placeholder="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="input"
                  style={{
                    fontSize: 20,
                    fontWeight: 900,
                    color: editingExpense ? '#166534' : paymentMethod === 'card' ? '#0369a1' : '#be123c',
                    padding: '10px 14px',
                    borderRadius: 8,
                    width: '100%',
                    background: '#ffffff',
                    border: `1.5px solid ${editingExpense ? '#86efac' : paymentMethod === 'card' ? '#7dd3fc' : '#fda4af'}`,
                    outline: 'none'
                  }}
                  autoFocus
                />
              </div>
              {Number(amount) > 0 && (
                <div style={{ marginTop: 4, fontSize: 13, fontWeight: 700, color: editingExpense ? '#166534' : paymentMethod === 'card' ? '#0369a1' : '#991b1b' }}>
                  ≈ {new Intl.NumberFormat('uz-UZ').format(Number(amount))} so‘m
                </div>
              )}

              {/* Quick increment buttons */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {[10000, 20000, 50000, 100000, 200000, 500000].map(val => (
                  <button
                    type="button"
                    key={val}
                    className="btn btn-sm"
                    style={{
                      fontSize: 11.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      background: '#ffffff',
                      border: '1px solid #cbd5e1',
                      color: 'var(--navy, #0f172a)',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                    onClick={() => setAmount(String((Number(amount) || 0) + val))}
                  >
                    +{new Intl.NumberFormat('uz-UZ').format(val)}
                  </button>
                ))}
                {Number(amount) > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{
                      fontSize: 11.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      background: '#fee2e2',
                      border: '1px solid #f87171',
                      color: '#991b1b',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                    onClick={() => setAmount('')}
                  >
                    Nollash
                  </button>
                )}
              </div>
            </label>

            {/* Note / reason */}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: editingExpense ? '#166534' : '#881337', marginBottom: 5 }}>
                Xarajat sababi / Izoh *
              </span>
              <textarea
                rows={2}
                placeholder="Masalan: Tushlik, choyxona, transport, tozalash vositalari, ofis anjomlari..."
                value={note}
                onChange={e => setNote(e.target.value)}
                className="input"
                style={{
                  width: '100%',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 13,
                  background: '#ffffff',
                  border: `1.5px solid ${editingExpense ? '#86efac' : paymentMethod === 'card' ? '#7dd3fc' : '#fda4af'}`,
                  resize: 'vertical'
                }}
              />
            </label>

            {/* Category & Date */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <label>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: editingExpense ? '#166534' : '#881337', marginBottom: 4 }}>
                  Kategoriya
                </span>
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  className="input"
                  style={{
                    width: '100%',
                    borderRadius: 8,
                    padding: '7px 10px',
                    fontSize: 13,
                    background: '#ffffff',
                    border: '1.5px solid #cbd5e1'
                  }}
                >
                  {EXPENSE_CATEGORIES.map(c => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </label>

              <label>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: editingExpense ? '#166534' : '#881337', marginBottom: 4 }}>
                  Xarajat sanasi
                </span>
                <input
                  type="date"
                  value={expenseDate}
                  onChange={e => setExpenseDate(e.target.value)}
                  className="input"
                  style={{
                    width: '100%',
                    borderRadius: 8,
                    padding: '6px 10px',
                    fontSize: 13,
                    background: '#ffffff',
                    border: '1.5px solid #cbd5e1'
                  }}
                />
              </label>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={submitting || !Number(amount) || !note.trim()}
              className="btn"
              style={{
                width: '100%',
                padding: '11px',
                fontSize: 13.5,
                fontWeight: 800,
                background: editingExpense
                  ? 'linear-gradient(135deg, #16a34a, #15803d)'
                  : paymentMethod === 'card'
                  ? 'linear-gradient(135deg, #0284c7, #0369a1)'
                  : 'linear-gradient(135deg, #e11d48, #be123c)',
                color: '#ffffff',
                border: 'none',
                borderRadius: 8,
                boxShadow: editingExpense
                  ? '0 2px 8px rgba(22, 163, 74, 0.3)'
                  : paymentMethod === 'card'
                  ? '0 2px 8px rgba(2, 132, 199, 0.3)'
                  : '0 2px 8px rgba(225, 29, 72, 0.3)',
                cursor: 'pointer',
                opacity: (!Number(amount) || !note.trim()) ? 0.6 : 1
              }}
            >
              {submitting
                ? 'Saqlanmoqda…'
                : editingExpense
                ? `O‘zgarishlarni saqlash (${new Intl.NumberFormat('uz-UZ').format(amount)} so‘m)`
                : Number(amount) > 0
                ? `${paymentMethod === 'card' ? 'Plastikdan' : 'Naqd puldan'} ${new Intl.NumberFormat('uz-UZ').format(amount)} so‘m chiqim qilish`
                : 'Harajatni saqlash'}
            </button>
          </form>

          {/* Existing Expenses List Header */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
            paddingBottom: 8,
            borderBottom: '1.5px solid var(--line, #e2e8f0)',
            flexWrap: 'wrap',
            gap: 8
          }}>
            <div>
              <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--navy, #0f172a)' }}>
                Tanlangan davrdagi barcha xarajatlar ({expenses.length} ta)
              </h4>
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#be123c' }}>
              Jami: {new Intl.NumberFormat('uz-UZ').format(totalExpenseSum)} so‘m
            </span>
          </div>

          {/* Filter pills & Search input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  ['all', `Barchasi (${expenses.length})`],
                  ['cash', `💵 Naqd (${expenses.filter(e => (e.payment_method || 'cash') === 'cash').length})`],
                  ['card', `💳 Plastik (${expenses.filter(e => e.payment_method === 'card').length})`]
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setListFilter(key)}
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 20,
                      border: `1px solid ${listFilter === key ? '#be123c' : 'var(--line, #cbd5e1)'}`,
                      background: listFilter === key ? '#ffe4e6' : '#ffffff',
                      color: listFilter === key ? '#9f1239' : '#475569',
                      fontWeight: listFilter === key ? 700 : 500,
                      cursor: 'pointer'
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Search Bar */}
            <div style={{ position: 'relative' }}>
              <Search
                size={15}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#94a3b8'
                }}
              />
              <input
                type="text"
                placeholder="Xarajatlar orasidan qidirish (sababi, summasi, xodim)..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 32px 7px 34px',
                  fontSize: 12.5,
                  borderRadius: 8,
                  border: '1px solid var(--line, #cbd5e1)',
                  background: '#ffffff',
                  outline: 'none'
                }}
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: '#94a3b8',
                    display: 'flex',
                    alignItems: 'center'
                  }}
                  title="Tozalash"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Expenses List */}
          {loadingList ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--muted, #64748b)', fontSize: 13 }}>
              Xarajatlar ro‘yxati yuklanmoqda…
            </div>
          ) : !expenses.length ? (
            <div style={{
              textAlign: 'center',
              padding: '24px 16px',
              background: '#f8fafc',
              borderRadius: 10,
              border: '1px dashed var(--line, #cbd5e1)',
              color: 'var(--muted, #64748b)',
              fontSize: 13
            }}>
              Tanlangan davr uchun hali hech qanday kassa xarajati kiritilmagan.
            </div>
          ) : !filteredExpenses.length ? (
            <div style={{
              textAlign: 'center',
              padding: '20px 16px',
              background: '#f8fafc',
              borderRadius: 10,
              border: '1px dashed var(--line, #cbd5e1)',
              color: 'var(--muted, #64748b)',
              fontSize: 13
            }}>
              "{searchTerm}" so‘rovi bo‘yicha xarajat topilmadi.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredExpenses.map((exp) => {
                const categoryObj = EXPENSE_CATEGORIES.find(c => c.code === exp.category);
                const categoryLabel = categoryObj ? categoryObj.name : (exp.category || 'Boshqa');
                const isDeleting = deletingId === exp.id;
                const isCard = exp.payment_method === 'card';
                const isCurrentEditing = editingExpense?.id === exp.id;

                return (
                  <div
                    key={exp.id}
                    style={{
                      background: isCurrentEditing ? '#f0fdf4' : '#ffffff',
                      border: `1px solid ${isCurrentEditing ? '#86efac' : 'var(--line, #e2e8f0)'}`,
                      borderRadius: 10,
                      padding: '10px 14px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      boxShadow: isCurrentEditing ? '0 0 0 2px rgba(34,197,94,0.2)' : 'none',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                        {/* Payment Method Badge */}
                        <span style={{
                          background: isCard ? '#eff6ff' : '#f0fdf4',
                          color: isCard ? '#1d4ed8' : '#15803d',
                          border: `1px solid ${isCard ? '#bfdbfe' : '#bbf7d0'}`,
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3
                        }}>
                          {isCard ? <CreditCard size={11} /> : <Banknote size={11} />}
                          {isCard ? 'Plastik' : 'Naqd'}
                        </span>

                        <span style={{
                          background: '#ffe4e6',
                          color: '#9f1239',
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4
                        }}>
                          {categoryLabel}
                        </span>

                        <span style={{ fontSize: 11.5, color: 'var(--muted, #64748b)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Clock size={12} />
                          {formatDateTime(exp.paid_at || exp.created_at)}
                        </span>

                        {exp.created_by_name && (
                          <span style={{ fontSize: 11.5, color: 'var(--muted, #64748b)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <User size={12} />
                            {exp.created_by_name}
                          </span>
                        )}

                        {exp.updated_at && exp.created_at && exp.updated_at !== exp.created_at && (
                          <span style={{ fontSize: 9.5, color: '#b45309', background: '#fef3c7', padding: '0 4px', borderRadius: 3, fontWeight: 700 }}>
                            ✏️ Tahrirlangan
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--navy, #0f172a)', wordBreak: 'break-word' }}>
                        {exp.note || exp.title || 'Kassa chiqimi'}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      <div style={{ textAlign: 'right' }}>
                        <b style={{ display: 'block', fontSize: 15, fontWeight: 900, color: isCard ? '#0369a1' : '#be123c' }}>
                          -{new Intl.NumberFormat('uz-UZ').format(exp.amount)} so‘m
                        </b>
                        <small style={{ color: 'var(--muted, #64748b)', fontSize: 11 }}>
                          <DualPrice value={Number(exp.amount)} rate={rate} />
                        </small>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {/* Edit Button */}
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={isDeleting}
                          onClick={() => startEdit(exp)}
                          style={{
                            color: '#0284c7',
                            borderColor: '#bae6fd',
                            background: isCurrentEditing ? '#e0f2fe' : '#ffffff',
                            padding: '6px 8px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11.5,
                            fontWeight: 600
                          }}
                          title="Ushbu xarajatni tahrirlash"
                        >
                          <Edit3 size={14} />
                          <span>Tahrirlash</span>
                        </button>

                        {/* Delete Button */}
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={isDeleting}
                          onClick={() => handleDelete(exp)}
                          style={{
                            color: '#ef4444',
                            borderColor: '#fca5a5',
                            padding: '6px',
                            borderRadius: 6,
                            cursor: 'pointer'
                          }}
                          title="Ushbu xarajatni o‘chirish va kassaga qaytarish"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px',
          background: '#f8fafc',
          borderTop: '1px solid var(--line, #e2e8f0)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}>
          <div style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>
            Xarajatlar tanlangan manba (<b>Naqd pul</b> yoki <b>Plastik karta</b>) hisobidan avtomatik ayirib ko‘rsatiladi.
          </div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onClose}
            style={{ padding: '6px 16px', fontSize: 13 }}
          >
            Yopish
          </button>
        </div>
      </div>
    </div>
  );
}
