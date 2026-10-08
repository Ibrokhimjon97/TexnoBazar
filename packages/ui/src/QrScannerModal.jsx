import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, FlipHorizontal, RefreshCw, X, Zap, ZapOff, ZoomIn, Focus } from 'lucide-react';

/**
 * Kamera turlarini aniqlash va ball berish.
 * Asosiy maqsad: ko'p kamerali telefonlarda hira 0.5x (keng burchak) o'rniga
 * tiniq 1x Asosiy (Primary) kamerani tanlash.
 */
function classifyAndScoreCameras(devices) {
  if (!devices || !devices.length) return [];

  return devices.map((d, index) => {
    const l = (d.label || '').toLowerCase();
    const isFront = l.includes('front') || l.includes('user') || l.includes('selfie') || l.includes('facing front');
    const isUltraWide = l.includes('ultra') || l.includes('0.5') || l.includes('0.6') || l.includes('super wide') || l.includes('camera2 2') || l.includes('wideangle');
    const isTele = l.includes('tele') || l.includes('periscope') || l.includes('zoom') || l.includes('camera2 3');
    const isMacro = l.includes('macro') || l.includes('depth');
    const isMain = !isFront && !isUltraWide && !isMacro && (
      l.includes('main') || l.includes('primary') || l.includes('standard') ||
      l.includes('camera2 0') || l.includes('camera 0') || l.includes('back 0') || l.includes('rear 0') ||
      l.includes('1x') || (l.includes('wide angle') && !l.includes('ultra')) ||
      (l.includes('back') && !isTele) || index === 0
    );

    // Ball berish
    let score = 50;
    if (isFront) {
      score = -999;
    } else {
      if (isUltraWide) score -= 100; // 0.5x ultra-wide kamerani pastga surish
      if (isMacro) score -= 80;
      if (isTele) score -= 20;
      if (isMain) score += 90; // 1x Asosiy kamerani eng yuqoriga chiqarish
      if (l.includes('camera2 0') || l.includes('camera 0') || l.includes('back 0')) score += 50;
      if (index === 0 && !isUltraWide) score += 20;
    }

    // Foydalanuvchiga tushunarli nom
    let name = 'Kamera';
    if (isFront) {
      name = 'Old kamera (Selfi)';
    } else if (isUltraWide) {
      name = 'Keng burchak (0.5x)';
    } else if (isTele) {
      name = 'Telefoto kamera';
    } else if (isMacro) {
      name = 'Makro kamera';
    } else if (isMain) {
      name = 'Asosiy kamera (1x)';
    } else {
      name = d.label ? d.label.split('(')[0].trim() : `Kamera ${index + 1}`;
    }

    return {
      id: d.id,
      label: d.label,
      name,
      isFront,
      isUltraWide,
      isMain,
      score
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * QrScannerModal — yuqori aniqlikdagi shared QR skaner modali.
 * 
 * Imkoniyatlar:
 *  - 1x Asosiy kamerani avtomatik aniqlash va faollashtirish (hira 0.5x kameradan qochish)
 *  - Ko'p kamerali telefonlarda kamera almashtirish (Asosiy, 0.5x, Telefoto, Selfi)
 *  - Doimiy avtofokus (continuous autofocus) va tap-to-focus
 *  - 1080p Full HD video oqimi (kichik 40x30mm QR kodlarni yaqindan tiniq ko'rish uchun)
 *  - Apparat va raqamli Zoom (1x, 1.5x, 2x, 3x)
 *  - Chiroq / Flashlight (agar qo'llab-quvvatlansa)
 */
export function QrScannerModal({ open, onClose, onScan, title = 'QR kodni skanerlang' }) {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);
  const scannedRef = useRef(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [cameras, setCameras] = useState([]);
  const [activeCameraId, setActiveCameraId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 4, step: 0.1 });
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [tapEffect, setTapEffect] = useState(false);

  // Zoom qo'llash
  const applyZoom = useCallback((newZoom) => {
    const clamped = Math.max(1, Math.min(zoomRange.max || 4, Number(newZoom) || 1));
    setZoom(clamped);

    try {
      const videoEl = containerRef.current?.querySelector('video');
      const track = videoEl?.srcObject?.getVideoTracks?.()?.[0];
      if (track) {
        const capabilities = track.getCapabilities?.();
        if (capabilities && 'zoom' in capabilities) {
          track.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(() => {});
        }
      }
      if (videoEl) {
        videoEl.style.transform = `scale(${clamped})`;
        videoEl.style.transformOrigin = 'center center';
        videoEl.style.transition = 'transform 0.15s ease';
      }
    } catch {
      // ignore
    }
  }, [zoomRange.max]);

  // Chiroqni yoqish / o'chirish
  const toggleTorch = async () => {
    try {
      const videoEl = containerRef.current?.querySelector('video');
      const track = videoEl?.srcObject?.getVideoTracks?.()?.[0];
      if (track) {
        const nextTorch = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: nextTorch }] });
        setTorchOn(nextTorch);
      }
    } catch (err) {
      console.warn('Torch xatosi:', err);
    }
  };

  // Ekranga bosilganda fokusni yangilash (Tap-to-focus)
  const handleTapToFocus = async () => {
    setTapEffect(true);
    setTimeout(() => setTapEffect(false), 600);
    try {
      const videoEl = containerRef.current?.querySelector('video');
      const track = videoEl?.srcObject?.getVideoTracks?.()?.[0];
      if (track) {
        const capabilities = track.getCapabilities?.() || {};
        if ('focusMode' in capabilities) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      }
    } catch {
      // ignore
    }
  };

  // Keyingi kameraga o'tish
  const switchNextCamera = () => {
    if (cameras.length <= 1) return;
    const currentIdx = cameras.findIndex(c => c.id === activeCameraId);
    const nextIdx = (currentIdx + 1) % cameras.length;
    setActiveCameraId(cameras[nextIdx].id);
    setZoom(1);
    setTorchOn(false);
  };

  // Kamera o'rnatish va skanerni ishga tushirish
  useEffect(() => {
    if (!open) return;
    scannedRef.current = false;
    setError('');
    setStarting(true);
    setTorchOn(false);

    let html5QrCode = null;
    let stopped = false;

    const start = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (stopped) return;

        // Qurilmadagi barcha kameralarni olish
        let availableCameras = cameras;
        if (!availableCameras.length) {
          try {
            const rawDevices = await Html5Qrcode.getCameras();
            availableCameras = classifyAndScoreCameras(rawDevices);
            setCameras(availableCameras);
          } catch (camErr) {
            console.warn('Kameralar ro‘yxatini olishda ogohlantirish:', camErr);
          }
        }

        // Qaysi kamerani tanlash: mavjud bo'lsa activeCameraId, aks holda Asosiy (1x) kamera
        const targetCamera = activeCameraId
          ? availableCameras.find(c => c.id === activeCameraId)
          : (availableCameras[0] || null);

        const targetId = targetCamera?.id || activeCameraId;
        if (targetId && targetId !== activeCameraId) {
          setActiveCameraId(targetId);
        }

        const elementId = 'qr-scanner-region';
        html5QrCode = new Html5Qrcode(elementId, {
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
          }
        });
        scannerRef.current = html5QrCode;

        // Yuqori aniqlikdagi va tezkor skaner sozlamalari
        const config = {
          fps: 25,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.max(200, Math.floor(minEdge * 0.82));
            return { width: size, height: size };
          },
          aspectRatio: 1.0,
          disableFlip: false,
          videoConstraints: targetId ? {
            deviceId: { exact: targetId },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          } : {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        };

        const cameraArg = targetId || { facingMode: 'environment' };

        await html5QrCode.start(
          cameraArg,
          config,
          (decodedText) => {
            if (scannedRef.current) return;
            scannedRef.current = true;
            onScan(decodedText);
            onClose();
          },
          () => {} // no-op for non-matching frames
        );

        if (!stopped) {
          setStarting(false);

          // Kamera imkoniyatlarini tekshirish va doimiy fokusni yoqish
          setTimeout(() => {
            try {
              const videoEl = containerRef.current?.querySelector('video');
              const track = videoEl?.srcObject?.getVideoTracks?.()?.[0];
              if (track) {
                const capabilities = track.getCapabilities?.() || {};
                const advanced = [];

                // Avtofokusni har doim faol (continuous) qilish
                if ('focusMode' in capabilities && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
                  advanced.push({ focusMode: 'continuous' });
                }
                if ('exposureMode' in capabilities && Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
                  advanced.push({ exposureMode: 'continuous' });
                }
                if (advanced.length) {
                  track.applyConstraints({ advanced }).catch(() => {});
                }

                // Chiroq borligini tekshirish
                setHasTorch(Boolean(capabilities.torch));

                // Zoom oralig'ini o'rnatish
                if (capabilities.zoom) {
                  setZoomRange({
                    min: capabilities.zoom.min || 1,
                    max: capabilities.zoom.max || 4,
                    step: capabilities.zoom.step || 0.1
                  });
                }
              }
            } catch {
              // ignore
            }
          }, 350);
        }
      } catch (err) {
        if (!stopped) {
          setStarting(false);
          const msg = String(err?.message || err || '');
          if (msg.includes('NotAllowed') || msg.includes('Permission')) {
            setError('Kameraga ruxsat berilmadi. Brauzer sozlamalaridan kameraga ruxsat bering.');
          } else if (msg.includes('NotFound') || msg.includes('Requested device not found') || msg.includes('Overconstrained')) {
            // Agar tanlangan kamera ochilmasa, umumiy orqa kameraga o'tish
            if (activeCameraId) {
              setActiveCameraId('');
              return;
            }
            setError('Kamera topilmadi. Qurilmangizda kamera mavjudligini tekshiring.');
          } else {
            setError('Kamerani ishga tushirib bo‘lmadi: ' + msg);
          }
        }
      }
    };

    start();

    return () => {
      stopped = true;
      if (html5QrCode) {
        const state = html5QrCode.getState?.();
        if (state === 2 || state === 3) {
          html5QrCode.stop().catch(() => {});
        }
        try { html5QrCode.clear(); } catch {}
        scannerRef.current = null;
      }
    };
  }, [open, activeCameraId]);

  if (!open) return null;

  const currentCam = cameras.find(c => c.id === activeCameraId) || cameras[0];
  const currentCamName = currentCam?.name || 'Asosiy kamera (1x)';

  return (
    <div className="overlay qr-scanner-overlay" onClick={onClose}>
      <div className="qr-scanner-modal" onClick={e => e.stopPropagation()}>
        <div className="qr-scanner-header">
          <Camera size={20} />
          <b>{title}</b>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Yopish"><X size={18} /></button>
        </div>

        <div className="qr-scanner-body" onClick={handleTapToFocus} title="Fokusni to‘g‘rilash uchun bosing">
          <div id="qr-scanner-region" ref={containerRef} />
          
          {/* Kamera nomi nishoni */}
          {!starting && !error && (
            <div className="qr-scanner-badge">
              <Camera size={13} /> {currentCamName}
            </div>
          )}

          {/* Fokuslash vizual effekti */}
          {tapEffect && (
            <div className="qr-scanner-focus-ring">
              <Focus size={32} />
            </div>
          )}

          <div className="qr-scanner-tap-hint">Fokus uchun ekranga bosing</div>

          {starting && !error && <div className="qr-scanner-loading">Kamera ishga tushirilmoqda…</div>}
          {error && <div className="qr-scanner-error">{error}</div>}
        </div>

        {/* Kamera va Zoom boshqaruvi */}
        {!starting && !error && (
          <div className="qr-scanner-controls">
            {/* Kameralar ro'yxati (agar 1 tadan ko'p bo'lsa) */}
            {cameras.length > 1 && (
              <div className="qr-cam-select-row">
                <span className="qr-ctrl-label"><Camera size={13}/> Kamera:</span>
                {cameras.map(cam => (
                  <button
                    key={cam.id}
                    type="button"
                    className={`qr-cam-pill ${cam.id === (activeCameraId || cameras[0]?.id) ? 'active' : ''}`}
                    onClick={() => {
                      setActiveCameraId(cam.id);
                      setZoom(1);
                      setTorchOn(false);
                    }}
                  >
                    {cam.name}
                  </button>
                ))}
              </div>
            )}

            {/* Zoom sozlamasi */}
            <div className="qr-scanner-zoom-row">
              <span className="qr-ctrl-label"><ZoomIn size={14}/> Zoom:</span>
              <div className="qr-zoom-pills">
                {[1, 1.5, 2, 3].map(val => (
                  <button
                    key={val}
                    type="button"
                    className={`qr-zoom-pill ${Math.abs(zoom - val) < 0.1 ? 'active' : ''}`}
                    onClick={() => applyZoom(val)}
                  >
                    {val}x
                  </button>
                ))}
              </div>
              <input
                type="range"
                className="qr-zoom-slider"
                min="1"
                max={zoomRange.max || 4}
                step="0.1"
                value={zoom}
                onChange={e => applyZoom(parseFloat(e.target.value))}
                title="Kamerani yaqinlashtirish"
              />
            </div>

            {/* Qo'shimcha tugmalar: Chiroq va Kamera almashtirish */}
            <div className="qr-scanner-bottom-actions">
              {cameras.length > 1 ? (
                <button
                  type="button"
                  className="qr-action-btn"
                  onClick={switchNextCamera}
                  title="Keyingi kameraga o‘tish"
                >
                  <RefreshCw size={14}/> Boshqa kamera
                </button>
              ) : (
                <span/>
              )}

              {hasTorch && (
                <button
                  type="button"
                  className={`qr-action-btn ${torchOn ? 'active' : ''}`}
                  onClick={toggleTorch}
                  title="Kamera chirog‘i"
                >
                  {torchOn ? <ZapOff size={14}/> : <Zap size={14}/>} {torchOn ? 'Chiroqni o‘chirish' : 'Chiroq'}
                </button>
              )}
            </div>
          </div>
        )}

        <p className="qr-scanner-hint">
          {currentCam?.isUltraWide
            ? 'Diqqat: Keng burchak (0.5x) kichik QR kodlarni hira ko‘rishi mumkin. Yuqoridan "Asosiy kamera (1x)"ni tanlang.'
            : 'Kamerani QR kodga yo‘naltiring. Kichik 40x30mm yorliqlar uchun 1.5x–2x zoomdan foydalaning.'}
        </p>
      </div>
    </div>
  );
}

/**
 * QrScanButton — oddiy tugma, bosilganda QrScannerModal ochadi.
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

