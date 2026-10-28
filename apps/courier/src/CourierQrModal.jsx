import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  QrCode,
  Camera,
  CheckCircle2,
  AlertTriangle,
  Package,
  Check,
  RefreshCw
} from 'lucide-react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { courierVerifyProductUnitQr } from '@texnobazar/data';

export function CourierQrModal({ open, onClose, delivery, onItemVerified }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const scannerRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setCode('');
      setResult(null);
      setError('');
      setCameraActive(false);
      return;
    }
  }, [open]);

  // Handle Camera Scanner with html5-qrcode
  useEffect(() => {
    if (!open || !cameraActive) {
      if (scannerRef.current) {
        try {
          scannerRef.current.clear();
        } catch {}
        scannerRef.current = null;
      }
      return;
    }

    const timer = setTimeout(() => {
      try {
        const scanner = new Html5QrcodeScanner(
          'courier-qr-reader-elem',
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            rememberLastUsedCamera: true
          },
          false
        );
        scannerRef.current = scanner;

        scanner.render(
          (decodedText) => {
            handleVerifyCode(decodedText);
            // Optionally close camera after successful read
            setCameraActive(false);
          },
          (scanErr) => {
            // Ignore scan frame error
          }
        );
      } catch (e) {
        console.error('Camera QR scanner init error:', e);
      }
    }, 150);

    return () => {
      clearTimeout(timer);
      if (scannerRef.current) {
        try {
          scannerRef.current.clear();
        } catch {}
        scannerRef.current = null;
      }
    };
  }, [cameraActive, open]);

  const handleVerifyCode = async (scanInput) => {
    const clean = String(scanInput || '').trim();
    if (!clean || !delivery?.id) return;
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const data = await courierVerifyProductUnitQr({
        deliveryId: delivery.id,
        scannedCode: clean
      });
      setResult(data);
      if (data?.matched) {
        onItemVerified?.(data.sku || data.product_name || clean, data.product_id);
      }
    } catch (e) {
      setError(e.message || 'QR kodni tekshirib bo‘lmadi.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (code.trim()) {
      handleVerifyCode(code.trim());
    }
  };

  if (!open) return null;

  const items = Array.isArray(delivery?.items) ? delivery.items : [];

  return (
    <div
      className="overlay"
      style={{ zIndex: 1300 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        className="modal"
        style={{
          maxWidth: 480,
          width: '95vw',
          padding: 0,
          borderRadius: 16,
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          background: 'linear-gradient(135deg, #0f172a, #1e293b)',
          color: '#fff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
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
              <QrCode size={19} color="#fff" />
            </div>
            <div>
              <b style={{ fontSize: 14.5, display: 'block' }}>Tovarni QR orqali tekshirish</b>
              <small style={{ color: '#94a3b8', fontSize: 11 }}>
                Buyurtma: {delivery?.delivery_no}
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

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Instructions */}
          <div style={{
            padding: '10px 12px',
            background: '#f0f9ff',
            border: '1px solid #bae6fd',
            borderRadius: 10,
            fontSize: 12,
            color: '#0369a1',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8
          }}>
            <Package size={17} style={{ flexShrink: 0, marginTop: 1, color: '#0284c7' }} />
            <span>
              Omborda yoki do‘konda tovarning QR kodi yoki seriya raqamini skanerlang. Tizim to‘g‘ri tovar olinayotganini darhol tekshirib beradi.
            </span>
          </div>

          {/* Expected Items List */}
          <div>
            <small style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted, #64748b)', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Olinishi kerak bo‘lgan tovarlar ({items.length} ta):
            </small>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map((it, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                >
                  <div>
                    <b>{it.product_name}</b>
                    <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>
                      SKU: {it.sku} · Partiya: {it.batch_code || '—'} {it.qr_code ? `· QR: ${it.qr_code}` : ''}
                    </div>
                  </div>
                  <span style={{ fontWeight: 800, fontSize: 12, color: '#0f172a', whiteSpace: 'nowrap' }}>
                    {it.quantity} dona
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Camera Scanner Toggle & Container */}
          <div>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setCameraActive(v => !v)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '9px 12px',
                fontSize: 12.5,
                fontWeight: 700
              }}
            >
              <Camera size={16} />
              {cameraActive ? 'Kamerani yopish' : 'Kamera bilan skanerlash'}
            </button>

            {cameraActive && (
              <div
                id="courier-qr-reader-elem"
                style={{
                  width: '100%',
                  marginTop: 10,
                  borderRadius: 12,
                  overflow: 'hidden',
                  border: '2px solid #f97316'
                }}
              />
            )}
          </div>

          {/* Manual Input / Barcode reader input */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="input"
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="Tovar QR kodi yoki seriya raqami..."
              style={{ flex: 1, padding: '9px 12px', fontSize: 13 }}
              autoFocus
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !code.trim()}
              style={{
                padding: '9px 16px',
                fontSize: 12.5,
                fontWeight: 700,
                background: 'linear-gradient(135deg, #f97316, #ea580c)'
              }}
            >
              {loading ? <RefreshCw size={14} className="animate-spin" /> : 'Tekshirish'}
            </button>
          </form>

          {/* Feedback Result */}
          {result && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                fontSize: 13,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                border: result.matched ? '1.5px solid #86efac' : '1.5px solid #fca5a5',
                background: result.matched ? '#f0fdf4' : '#fef2f2',
                color: result.matched ? '#166534' : '#991b1b'
              }}
            >
              {result.matched ? (
                <CheckCircle2 size={20} style={{ flexShrink: 0, marginTop: 1, color: '#16a34a' }} />
              ) : (
                <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: 1, color: '#dc2626' }} />
              )}
              <div>
                <b style={{ display: 'block', fontSize: 13.5, marginBottom: 2 }}>
                  {result.matched ? '✅ TOVAR TO‘G‘RI TANLANDI!' : '❌ DIQQAT: XATO TOVAR!'}
                </b>
                <span>{result.message}</span>
                {result.product_name && (
                  <div style={{ marginTop: 4, fontWeight: 700, fontSize: 12 }}>
                    Mahsulot: {result.product_name}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#b91c1c',
              fontSize: 12
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              style={{ padding: '8px 18px', fontSize: 12.5 }}
            >
              Yopish
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
