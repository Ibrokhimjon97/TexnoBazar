import React, { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

/**
 * QrScannerModal — shared kamera orqali QR/barcode skanerlash modali.
 * 
 * Props:
 *  - open: boolean
 *  - onClose: () => void
 *  - onScan: (decodedText: string) => void  — faqat birinchi natijada chaqiriladi
 *  - title?: string
 * 
 * Desktop: web-kamerani ishlatadi (getUserMedia).
 * Telefon/planshet: orqa kamerani avtomatik tanlaydi (facingMode: environment).
 */
export function QrScannerModal({ open, onClose, onScan, title = 'QR kodni skanerlang' }) {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);
  const scannedRef = useRef(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    if (!open) return;
    scannedRef.current = false;
    setError('');
    setStarting(true);

    let html5QrCode = null;
    let stopped = false;

    const start = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (stopped) return;

        const elementId = 'qr-scanner-region';
        html5QrCode = new Html5Qrcode(elementId);
        scannerRef.current = html5QrCode;

        const config = {
          fps: 12,
          qrbox: { width: 260, height: 260 },
          aspectRatio: 1.0,
        };

        await html5QrCode.start(
          { facingMode: 'environment' },
          config,
          (decodedText) => {
            if (scannedRef.current) return;
            scannedRef.current = true;
            onScan(decodedText);
            onClose();
          },
          () => {} // ignore non-critical errors
        );
        if (!stopped) setStarting(false);
      } catch (err) {
        if (!stopped) {
          setStarting(false);
          const msg = String(err?.message || err || '');
          if (msg.includes('NotAllowed') || msg.includes('Permission')) {
            setError('Kameraga ruxsat berilmadi. Brauzer sozlamalaridan kameraga ruxsat bering.');
          } else if (msg.includes('NotFound') || msg.includes('Requested device not found')) {
            setError('Kamera topilmadi. Qurilmangizda kamera mavjudligini tekshiring.');
          } else {
            setError('Kamerani ishga tushirib bo\u2019lmadi: ' + msg);
          }
        }
      }
    };

    start();

    return () => {
      stopped = true;
      if (html5QrCode) {
        const state = html5QrCode.getState?.();
        if (state === 2 || state === 3) { // SCANNING or PAUSED
          html5QrCode.stop().catch(() => {});
        }
        try { html5QrCode.clear(); } catch {}
        scannerRef.current = null;
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="overlay qr-scanner-overlay" onClick={onClose}>
      <div className="qr-scanner-modal" onClick={e => e.stopPropagation()}>
        <div className="qr-scanner-header">
          <Camera size={20} />
          <b>{title}</b>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Yopish"><X size={18} /></button>
        </div>
        <div className="qr-scanner-body">
          <div id="qr-scanner-region" ref={containerRef} />
          {starting && !error && <div className="qr-scanner-loading">Kamera ishga tushirilmoqda…</div>}
          {error && <div className="qr-scanner-error">{error}</div>}
        </div>
        <p className="qr-scanner-hint">Kamerani QR kod ustiga yo'naltiring. Avtomatik skanerlanadi.</p>
      </div>
    </div>
  );
}

/**
 * QrScanButton — oddiy tugma, bosilganda QrScannerModal ochadi.
 * Props:
 *  - onScan: (code: string) => void
 *  - className?: string
 *  - title?: string
 */
export function QrScanButton({ onScan, className = '', title = 'QR skanerlash' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`btn qr-scan-btn ${className}`.trim()}
        onClick={() => setOpen(true)}
        aria-label={title}
        title={title}
      >
        <Camera size={18} />
      </button>
      <QrScannerModal
        open={open}
        onClose={() => setOpen(false)}
        onScan={onScan}
        title={title}
      />
    </>
  );
}
