import React, { useState } from 'react';
import {
  ShieldAlert,
  Percent,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  X,
  Sparkles,
  Info,
  DollarSign,
  Coins,
  ArrowRight,
  Sliders,
} from 'lucide-react';
import { Modal } from '@texnobazar/ui';
import { bulkUpdateMinimumSalePrices } from '@texnobazar/data';

export default function BulkMinimumPriceModal({
  open,
  onClose,
  branchId,
  selectedIds = [],
  totalReceiptsCount = 0,
  rate = 12000,
  toast,
  onUpdated,
}) {
  const [scope, setScope] = useState(selectedIds.length > 0 ? 'selected' : 'all'); // 'all' | 'selected'
  const [percent, setPercent] = useState(5);
  const [customPercent, setCustomPercent] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null); // { mode, percent, countDesc }

  if (!open) return null;

  const hasSelected = selectedIds.length > 0;
  const effectiveScope = hasSelected ? scope : 'all';
  const targetReceiptIds = effectiveScope === 'selected' ? selectedIds : null;
  const targetDesc = effectiveScope === 'selected'
    ? `tanlangan ${selectedIds.length} ta partiya`
    : `barcha tovarlar va partiyalar (filial bo‘yicha)`;

  const effectivePercent = customPercent !== '' ? Number(customPercent) : percent;

  const handleApplyZero = () => {
    setConfirmDialog({
      mode: 'zero',
      percent: 0,
      title: 'Minimal sotish narxini 0 ga keltirish (Cheklovsiz)',
      desc: `Siz ${targetDesc} uchun minimal sotish narxini 0 so‘m / 0 $ ga keltirmoqchisiz.\n\n` +
            `• Natija: Sotuvchi savdoda (kassada) tovar uchun hohlagan narxini kirita oladi, minimal narx cheklovi butunlay o‘chadi.\n` +
            `• Qat'iy kafolat: Tovarlarning tan narxi (xarid narxi) va asosiy chakana sotish narxiga UMUMAN TEGILMAYDI!`,
      actionLabel: 'Ha, minimal narxni 0 qilish',
      buttonBg: '#dc2626',
    });
  };

  const handleApplyPercent = (pct) => {
    const p = Number(pct);
    setConfirmDialog({
      mode: 'percent',
      percent: p,
      title: `Minimal narxni Tannarx + ${p}% qilib belgilash`,
      desc: `Siz ${targetDesc} uchun minimal sotish narxini har bir tovarning tannarxiga +${p}% qo‘shib belgilamoqchisiz.\n\n` +
            `• Misol: Agar tovar tan narxi 100 $ bo‘lsa, minimal sotish narxi ${100 * (1 + p / 100)} $ bo‘ladi.\n` +
            `• Natija: Sotuvchi ushbu minimal narxdan past narxga tovar sota olmaydi.\n` +
            `• Qat'iy kafolat: Tovarlarning tan narxi va asosiy chakana sotish narxi o‘zgarmaydi!`,
      actionLabel: `Ha, Tannarx + ${p}% qilib o‘rnatish`,
      buttonBg: '#ea580c',
    });
  };

  const executeUpdate = async () => {
    if (!confirmDialog) return;
    setSaving(true);
    try {
      const res = await bulkUpdateMinimumSalePrices({
        branchId,
        mode: confirmDialog.mode,
        percent: confirmDialog.percent,
        receiptIds: targetReceiptIds,
      });

      if (confirmDialog.mode === 'zero') {
        toast?.(`Barcha tovarlarning minimal sotish narxi muvaffaqiyatli 0 ga keltirildi (Cheklovsiz sotish faollashdi)!`);
      } else {
        toast?.(`Minimal sotish narxi tovarlar tannarxiga +${confirmDialog.percent}% qilib muvaffaqiyatli o‘rnatildi!`);
      }

      setConfirmDialog(null);
      onUpdated?.();
      onClose?.();
    } catch (err) {
      console.error('Minimal narxlarni yangilashda xatolik:', err);
      alert('Xatolik yuz berdi: ' + (err.message || String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose?.(); }}
      title="Minimal Sotish Narxlarini Boshqarish"
      maxWidth="720px"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        
        {/* Important Info Notice */}
        <div style={{
          background: '#fff7ed',
          border: '1.5px solid #fed7aa',
          borderRadius: 12,
          padding: '12px 16px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          color: '#9a3412',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          <ShieldAlert size={22} style={{ flexShrink: 0, marginTop: 1, color: '#ea580c' }} />
          <div>
            <b style={{ color: '#c2410c', fontSize: 13.5 }}>Qat'iy xavfsizlik kafolati:</b>
            <div style={{ marginTop: 2, color: '#7c2d12' }}>
              Ushbu operatsiya <b>faqat minimal sotish narxi</b> (sotuvchilar tushira oladigan eng pastki narx) ni belgilaydi.
              Tovarlarning <b>tan narxi</b> (xarid narxi) va <b>asosiy sotish narxi</b> (chakana narx) ga <b>mutlaqo tegilmaydi</b> va logikasi buzilmaydi!
            </div>
          </div>
        </div>

        {/* Scope selector (All vs Selected) */}
        {hasSelected && (
          <div style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: '12px 16px',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>
              Qo‘llash doirasi:
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                <input
                  type="radio"
                  name="scope"
                  value="selected"
                  checked={scope === 'selected'}
                  onChange={() => setScope('selected')}
                  style={{ width: 17, height: 17, accentColor: '#ea580c', cursor: 'pointer' }}
                />
                ☑️ Faqat tanlangan partiyalar ({selectedIds.length} ta)
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                <input
                  type="radio"
                  name="scope"
                  value="all"
                  checked={scope === 'all'}
                  onChange={() => setScope('all')}
                  style={{ width: 17, height: 17, accentColor: '#ea580c', cursor: 'pointer' }}
                />
                🌐 Barcha tovarlar va partiyalar (Filial bo‘yicha)
              </label>
            </div>
          </div>
        )}

        {/* OPTION 1: Set to 0 (No minimum restriction) */}
        <div style={{
          border: '1.5px solid #fecaca',
          background: '#fef2f2',
          borderRadius: 14,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                background: '#fee2e2',
                color: '#dc2626',
                width: 28,
                height: 28,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: 14
              }}>
                1
              </span>
              <b style={{ fontSize: 15, color: '#991b1b' }}>Minimal narxni 0 ga keltirish (Cheklovsiz sotish)</b>
            </div>
          </div>
          <p style={{ margin: 0, fontSize: 12.5, color: '#7f1d1d', lineHeight: 1.5 }}>
            Barcha tovarlarning minimal sotish narxi <b>0 so‘m / 0 $</b> bo‘ladi.
            Sotuvchi savdo oynasida mijozga hohlagan chegirmasini bera oladi va tizim minimal narx bo‘yicha to‘siq qo‘ymaydi.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 4 }}>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={handleApplyZero}
              style={{
                background: '#dc2626',
                color: '#fff',
                borderColor: '#dc2626',
                fontWeight: 700,
                fontSize: 13,
                padding: '8px 18px',
                borderRadius: 8,
                boxShadow: '0 2px 8px rgba(220,38,38,0.25)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <ShieldAlert size={16} />
              Minimal narxni 0 qilish (Cheklovsiz)
            </button>
          </div>
        </div>

        {/* OPTION 2: Set as percentage of cost price */}
        <div style={{
          border: '1.5px solid #fed7aa',
          background: '#fffaf5',
          borderRadius: 14,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              background: '#ffedd5',
              color: '#ea580c',
              width: 28,
              height: 28,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 14
            }}>
              2
            </span>
            <b style={{ fontSize: 15, color: '#9a3412' }}>Tannarxga nisbatan minimal ustama (%) belgilash</b>
          </div>
          <p style={{ margin: 0, fontSize: 12.5, color: '#7c2d12', lineHeight: 1.5 }}>
            Har bir tovarning minimal narxi uning o‘z tannarxiga belgilangan foiz qo‘shilgan holda o‘rnatiladi.
            <br />
            Formula: <b>Minimal narx = Tannarx + (Tannarx × {effectivePercent}% / 100)</b>
          </p>

          {/* Quick Preset Buttons */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
              Tayyor foizlar:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { label: '+0% (Faqat tannarx)', val: 0 },
                { label: '+3%', val: 3 },
                { label: '+5%', val: 5 },
                { label: '+10%', val: 10 },
                { label: '+15%', val: 15 },
                { label: '+20%', val: 20 },
              ].map(opt => {
                const isSelected = customPercent === '' && percent === opt.val;
                return (
                  <button
                    key={opt.val}
                    type="button"
                    className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                    style={{
                      borderRadius: 20,
                      fontWeight: 700,
                      fontSize: 12.5,
                      padding: '5px 14px',
                      background: isSelected ? '#ea580c' : '#fff',
                      borderColor: isSelected ? '#ea580c' : '#cbd5e1',
                      color: isSelected ? '#fff' : '#334155',
                    }}
                    onClick={() => {
                      setCustomPercent('');
                      setPercent(opt.val);
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Percentage Input & Live Preview */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            padding: '10px 14px',
            flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
              Yoki boshqa foiz kiriting:
            </span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number"
                min="0"
                max="500"
                step="0.5"
                placeholder="Masalan: 7"
                value={customPercent !== '' ? customPercent : percent}
                onChange={(e) => {
                  const val = e.target.value;
                  setCustomPercent(val);
                }}
                className="input"
                style={{ width: 90, height: 34, textAlign: 'center', fontWeight: 700, fontSize: 14 }}
              />
              <b style={{ color: '#0f172a' }}>%</b>
            </div>

            <div style={{ marginLeft: 'auto', fontSize: 12.5, color: '#059669', background: '#ecfdf5', padding: '4px 10px', borderRadius: 6, border: '1px solid #a7f3d0' }}>
              Misol: Tannarxi <b>100 $</b> bo‘lsa → Minimal narx: <b>{(100 * (1 + effectivePercent / 100)).toFixed(2)} $</b>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 4 }}>
            <button
              type="button"
              className="btn"
              disabled={saving || isNaN(effectivePercent) || effectivePercent < 0}
              onClick={() => handleApplyPercent(effectivePercent)}
              style={{
                background: '#ea580c',
                color: '#fff',
                borderColor: '#ea580c',
                fontWeight: 700,
                fontSize: 13,
                padding: '8px 18px',
                borderRadius: 8,
                boxShadow: '0 2px 8px rgba(234,88,12,0.25)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Percent size={16} />
              Tannarx + {effectivePercent}% qilib o‘rnatish
            </button>
          </div>
        </div>

        {/* Action Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onClose}
            disabled={saving}
          >
            Yopish
          </button>
        </div>

      </div>

      {/* Confirmation Sub-Modal */}
      {confirmDialog && (
        <Modal
          open={true}
          onClose={() => { if (!saving) setConfirmDialog(null); }}
          title={confirmDialog.title}
          maxWidth="500px"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: 10,
              padding: 14,
              fontSize: 13,
              lineHeight: 1.6,
              color: '#334155',
              whiteSpace: 'pre-line',
            }}>
              {confirmDialog.desc}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setConfirmDialog(null)}
                disabled={saving}
              >
                Bekor qilish
              </button>
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={executeUpdate}
                style={{
                  background: confirmDialog.buttonBg,
                  color: '#fff',
                  borderColor: confirmDialog.buttonBg,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {saving ? <RefreshCw size={15} className="spin" /> : <CheckCircle2 size={15} />}
                {saving ? 'O‘rnatilmoqda...' : confirmDialog.actionLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
