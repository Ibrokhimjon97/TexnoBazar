import React, { useState, useEffect } from 'react';
import { Printer, ChevronLeft, ChevronRight, Tag, X } from 'lucide-react';
import { formatReceiptMoney, formatReceiptDate, getReceiptShortNo, printProductDeliveryStickers } from './thermalReceipt';

export function ProductDeliveryStickersModal({
  open,
  onClose,
  items = [],
  customer = {},
  sale = {},
  branchName = 'TEXNOBAZAR'
}) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    const handler = e => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const rawItems = items && items.length ? items : [{
    product_name: 'Mahsulot',
    unit_price: sale.total || 0,
    line_total: sale.total || 0
  }];

  const currentItem = rawItems[Math.min(activeIndex, rawItems.length - 1)] || rawItems[0];
  const dateStr = formatReceiptDate(sale.sold_at || sale.created_at || new Date());
  const shortNo = getReceiptShortNo(sale.sale_no || sale.delivery_no || sale.pending_no);

  const handlePrintAll = () => {
    printProductDeliveryStickers({
      items: rawItems,
      customer,
      sale,
      branchName
    });
  };

  return (
    <div
      className="overlay"
      style={{ zIndex: 1200 }}
      onMouseDown={e => e.target === e.currentTarget && onClose?.()}
    >
      <div className="modal" style={{ maxWidth: 520, padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          background: 'linear-gradient(135deg, #0f172a, #1e293b)',
          color: '#fff',
          borderBottom: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #f97316, #ea580c)',
              display: 'grid',
              placeItems: 'center'
            }}>
              <Printer size={19} color="#fff" />
            </div>
            <div>
              <b style={{ fontSize: 15, display: 'block' }}>
                Mahsulot stikerlari ({rawItems.length} ta tovar)
              </b>
              <small style={{ color: '#94a3b8', fontSize: 11 }}>
                Termoprinter cheki (40 × 30 mm) · {shortNo}
              </small>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn modal-close-btn"
            onClick={onClose}
            aria-label="Yopish"
            style={{ color: '#fff', background: 'rgba(255,255,255,0.1)' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            padding: '10px 14px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 10,
            fontSize: 12.5,
            color: '#1e40af',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}>
            <Tag size={18} style={{ flexShrink: 0, color: '#3b82f6' }} />
            <span>
              Har bir xarid qilingan tovar uchun alohida stiker chiqariladi. Tovarlar adashib ketmasligi uchun ushbu cheklarni mahsulot ustiga yopishtiring.
            </span>
          </div>

          {/* Navigation header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy, #0f172a)' }}>
              Stiker ko‘rinishi:
            </span>
            {rawItems.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={activeIndex <= 0}
                  onClick={() => setActiveIndex(i => Math.max(0, i - 1))}
                  style={{ padding: '2px 8px' }}
                >
                  <ChevronLeft size={14} />
                </button>
                <span style={{ fontSize: 12, fontWeight: 800 }}>
                  {activeIndex + 1} / {rawItems.length}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={activeIndex >= rawItems.length - 1}
                  onClick={() => setActiveIndex(i => Math.min(rawItems.length - 1, i + 1))}
                  style={{ padding: '2px 8px' }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Card Preview of Sticker */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={{
              width: '280px',
              minHeight: '195px',
              background: '#ffffff',
              border: '2px dashed #94a3b8',
              borderRadius: '12px',
              padding: '12px',
              boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              fontFamily: 'system-ui, -apple-system, sans-serif'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '1px solid #000',
                paddingBottom: '4px'
              }}>
                <span style={{ fontWeight: 900, fontSize: '11px', color: '#000', display: 'flex', alignItems: 'center', gap: 4 }}>
                  🏷️ TOVAR SOTILDI
                </span>
                <span style={{ fontSize: '10px', fontWeight: 800, color: '#000' }}>
                  {shortNo}
                </span>
              </div>

              <div style={{ margin: '8px 0', flex: 1 }}>
                <div style={{ fontWeight: 900, fontSize: '12.5px', color: '#000', lineHeight: 1.25 }}>
                  {currentItem.product_name}
                </div>
                <div style={{ fontSize: '10.5px', fontWeight: 700, color: '#334155', marginTop: '4px' }}>
                  Partiya: <span style={{ color: '#000' }}>{currentItem.batch_code || (currentItem.qr_code ? `QR: ${currentItem.qr_code}` : '—')}</span>
                </div>
                {currentItem.qr_code && (!currentItem.batch_code || !currentItem.batch_code.includes(currentItem.qr_code)) && (
                  <div style={{ fontSize: '9.5px', color: '#64748b' }}>
                    QR: {currentItem.qr_code}
                  </div>
                )}
              </div>

              <div style={{
                borderTop: '1px dashed #64748b',
                paddingTop: '6px',
                fontSize: '10.5px',
                lineHeight: 1.35
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Mijoz: <b>{customer?.full_name || customer?.name || '—'}</b></span>
                  <span><b>{customer?.phone || ''}</b></span>
                </div>
                {(customer?.address || customer?.delivery_address) && (
                  <div style={{ color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Manzil: <b>{customer?.address || customer?.delivery_address}</b>
                  </div>
                )}
              </div>

              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderTop: '1px solid #000',
                paddingTop: '4px',
                marginTop: '4px',
                fontSize: '10px'
              }}>
                <span style={{ fontWeight: 900, fontSize: '12px', color: '#000' }}>
                  {formatReceiptMoney(currentItem.unit_price || currentItem.line_total)}
                </span>
                <span style={{ fontWeight: 700, color: '#475569' }}>
                  {dateStr} ({activeIndex + 1}/{rawItems.length})
                </span>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={handlePrintAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '12px 18px',
                fontSize: 14,
                fontWeight: 700
              }}
            >
              <Printer size={18} />
              Termoprinterda chop etish ({rawItems.length} ta stiker)
            </button>

            <button
              type="button"
              className="btn btn-outline btn-block"
              onClick={onClose}
              style={{ padding: '10px 16px' }}
            >
              Yopish
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
