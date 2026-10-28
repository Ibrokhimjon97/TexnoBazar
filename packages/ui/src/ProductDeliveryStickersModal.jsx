import React, { useState, useEffect } from 'react';
import { Printer, ChevronLeft, ChevronRight, Tag, X, Bluetooth, QrCode } from 'lucide-react';
import { formatReceiptMoney, formatReceiptDate, getReceiptShortNo, printProductDeliveryStickers, renderProductDeliveryStickerCanvas } from './thermalReceipt';
import { DetongerPrintModal } from './DetongerPrintModal';

export function ProductDeliveryStickersModal({
  open,
  onClose,
  items = [],
  customer = {},
  sale = {},
  branchName = 'TEXNOBAZAR',
  sellerName: propSellerName,
  seller_name: propSellerNameSnake
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [preferredPrinter, setPreferredPrinter] = useState(() => {
    try {
      return localStorage.getItem('texnobazar_selected_thermal_printer') || 'detonger';
    } catch {
      return 'detonger';
    }
  });
  const [bluetoothModalOpen, setBluetoothModalOpen] = useState(false);

  const openBluetoothPrint = (printerType) => {
    if (printerType) {
      setPreferredPrinter(printerType);
      try {
        localStorage.setItem('texnobazar_selected_thermal_printer', printerType);
      } catch {}
    }
    setBluetoothModalOpen(true);
  };

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
  const codAmount = Number(
    sale?.cod_amount ??
    customer?.cod_amount ??
    currentItem?.cod_amount ??
    0
  );
  const sellerName = (
    propSellerName ||
    propSellerNameSnake ||
    sale?.seller_name ||
    sale?.sellerName ||
    customer?.seller_name ||
    customer?.sellerName ||
    currentItem?.seller_name ||
    currentItem?.sellerName ||
    ''
  );

  const handlePrintAll = () => {
    printProductDeliveryStickers({
      items: rawItems,
      customer,
      sale: {
        ...sale,
        cod_amount: codAmount,
        seller_name: sellerName,
        sellerName: sellerName
      },
      seller_name: sellerName,
      sellerName: sellerName,
      branchName
    });
  };

  return (
    <div
      className="overlay"
      style={{ zIndex: 1200 }}
      onMouseDown={e => e.target === e.currentTarget && onClose?.()}
    >
      <div
        className="modal"
        style={{
          maxWidth: 520,
          width: '95vw',
          maxHeight: 'min(92dvh, 880px)',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          borderRadius: 16,
          boxShadow: '0 20px 45px rgba(0,0,0,0.25)'
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          background: 'linear-gradient(135deg, #0f172a, #1e293b)',
          color: '#fff',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          flexShrink: 0
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

        <div
          className="modal-body-scroll"
          style={{
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            flex: '1 1 auto',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch',
            minHeight: 0
          }}
        >
          <div style={{
            padding: '8px 12px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 10,
            fontSize: 12,
            color: '#1e40af',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}>
            <Tag size={16} style={{ flexShrink: 0, color: '#3b82f6' }} />
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
                  TEXNOBAZAR
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
                fontSize: '11px',
                lineHeight: 1.35
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px' }}>Mijoz: <b style={{ fontSize: '13px', fontWeight: 900, color: '#000' }}>{customer?.full_name || customer?.name || '—'}</b></span>
                  <span style={{ fontSize: '12.5px', fontWeight: 900, color: '#000' }}>{customer?.phone || ''}</span>
                </div>
                {(customer?.address || customer?.delivery_address) && (
                  <div style={{ color: '#334155', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px' }}>
                    Manzil: <b>{customer?.address || customer?.delivery_address}</b>
                  </div>
                )}
              </div>

              {/* SOTILDI stamp and Sotuvchi in the center */}
              <div style={{ textAlign: 'center', margin: '6px 0 4px' }}>
                <span style={{
                  display: 'inline-block',
                  border: '2px solid #000',
                  padding: '3px 18px',
                  fontSize: '18px',
                  fontWeight: 900,
                  letterSpacing: '1.5px',
                  color: '#000',
                  borderRadius: '3px',
                  lineHeight: 1
                }}>
                  SOTILDI
                </span>
                {sellerName && (
                  <div style={{
                    marginTop: 5,
                    fontSize: '13.5px',
                    fontWeight: 900,
                    color: '#000',
                    letterSpacing: '0.2px'
                  }}>
                    Sotuvchi: <b>{sellerName}</b>
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
                {codAmount > 0 ? (
                  <span style={{ fontWeight: 900, fontSize: '12px', color: '#000' }}>
                    Kuryerdan {Number(codAmount).toLocaleString('uz-UZ')} so‘m
                  </span>
                ) : (
                  <span style={{ fontWeight: 700, fontSize: '10.5px', color: '#16a34a' }}>
                    To‘langan
                  </span>
                )}
                <span style={{ fontWeight: 700, color: '#475569' }}>
                  {dateStr} ({activeIndex + 1}/{rawItems.length})
                </span>
              </div>
            </div>
          </div>

          {/* Bluetooth Termoprinterlar & Kompyuter chop etish bo'limi (huddi partiyalar sahifasi kabi) */}
          <div style={{
            fontSize: 11,
            color: 'var(--muted, #64748b)',
            background: '#f8fafc',
            border: '1.5px solid #e2e8f0',
            padding: '10px 14px',
            borderRadius: 12,
            marginTop: 4
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--navy, #0f172a)', marginBottom: 3 }}>
              <Printer size={15} color="#ea580c" />
              <span>Bluetooth Termoprinterlar (Detonger & MHT-L80G):</span>
            </div>
            <div style={{ lineHeight: 1.4 }}>
              Telefonda Bluetooth yoki kompyuterda ulanib, <b>Detonger (40 mm)</b> yoki yangi <b>MHT-L80G (58 mm)</b> termoprinterida chop eting:
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{
                  padding: '12px 8px',
                  fontSize: 12,
                  fontWeight: 700,
                  background: 'linear-gradient(135deg, #f97316, #ea580c)',
                  boxShadow: '0 4px 14px rgba(249,115,22,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6
                }}
                onClick={() => openBluetoothPrint('detonger')}
                title="Detonger printerida chop etish"
              >
                <Bluetooth size={15} />
                <span>Detonger (40 mm)</span>
              </button>

              <button
                type="button"
                className="btn btn-primary"
                style={{
                  padding: '12px 8px',
                  fontSize: 12,
                  fontWeight: 700,
                  background: 'linear-gradient(135deg, #0284c7, #0369a1)',
                  boxShadow: '0 4px 14px rgba(2,132,199,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6
                }}
                onClick={() => openBluetoothPrint('mht')}
                title="MHT-L80G printerida 58x40 mm o‘lchamda chop etish"
              >
                <Bluetooth size={15} />
                <span>MHT-L80G (58 mm)</span>
              </button>
            </div>

            <button
              type="button"
              className="btn btn-outline btn-block"
              style={{ padding: '9px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              onClick={handlePrintAll}
            >
              <QrCode size={14} />
              Kompyuter / Tizim orqali klassik chop etish
            </button>

            <button
              type="button"
              className="btn btn-outline btn-block"
              onClick={onClose}
              style={{ padding: '8px 16px', fontSize: 12, color: '#64748b' }}
            >
              Yopish
            </button>
          </div>
        </div>
      </div>

      <DetongerPrintModal
        open={bluetoothModalOpen}
        onClose={() => setBluetoothModalOpen(false)}
        labels={rawItems}
        modalTitle={`Mahsulot stikerlari (${rawItems.length} ta tovar)`}
        initialPrinter={preferredPrinter}
        initialLabelSize="40x30"
        onClassicPrint={() => {
          setBluetoothModalOpen(false);
          handlePrintAll();
        }}
        renderCustomCanvas={(item, opts) => renderProductDeliveryStickerCanvas({
          item,
          customer,
          sale: {
            ...sale,
            cod_amount: codAmount,
            seller_name: sellerName,
            sellerName: sellerName
          },
          seller_name: sellerName,
          sellerName: sellerName,
          branchName,
          ...opts
        })}
      />
    </div>
  );
}
