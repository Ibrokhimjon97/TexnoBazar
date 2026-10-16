import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, FlipHorizontal, RefreshCw, X, Zap, ZapOff, ZoomIn, Focus } from 'lucide-react';

/**
 * Kamera turlarini aniqlash va ball berish.
 * Asosiy maqsad: ko'p kamerali telefonlarda hira 0.5x (keng burchak) o'rniga
 * tiniq 1x Asosiy (Primary) kamerani tanlash.
 */
function classifyAndScoreCameras(devices) {
  if (!devices || !devices.length) return [];

  const classified = devices.map((d, index) => {
    const rawLabel = (d.label || '').trim();
    const l = rawLabel.toLowerCase();

    // 1. Old (selfie) kamera aniqlash
    const isFront = (
      l.includes('front') ||
      l.includes('user') ||
      l.includes('selfie') ||
      l.includes('facing front') ||
      l.includes('vorne') ||
      l.includes('avant') ||
      l.includes('ön')
    );

    // 2. Keng burchakli (Ultra-wide / 0.5x / wideangle) kamera aniqlash
    // DIQQAT: Telefonlarda 0.5x kamera fokus qila olmagani uchun QRni o'qiy olmaydi!
    const isUltraWide = (
      l.includes('ultra') ||
      l.includes('uw') ||
      l.includes('0.5') ||
      l.includes('0.6') ||
      l.includes('super wide') ||
      l.includes('ultrawide') ||
      l.includes('wideangle') ||
      l.includes('wide-angle') ||
      l.includes('keng burchak')
    );

    // 3. Makro va chuqurlik (depth) kameralari
    const isMacro = l.includes('macro') || l.includes('depth') || l.includes('bokeh') || l.includes('tof');

    // 4. Telefoto kamera (2x, 3x va h.k.)
    const isTele = l.includes('tele') || l.includes('periscope') || l.includes('zoom');

    // 5. Android Camera2 nomlanishi:
    // camera2 0 odatda Asosiy (1x) orqa kamera bo'ladi
    // camera2 1 old kamera
    // camera2 2 va undan yuqori qo'shimcha (ko'pincha ultra-wide yoki makro) bo'ladi
    const isCamera2Main = l.includes('camera2 0') || l.includes('camera 0') || l.includes('back 0') || l.includes('rear 0');
    const isCamera2Aux = (l.includes('camera2 2') || l.includes('camera2 3') || l.includes('camera 2') || l.includes('camera 3')) && !isCamera2Main;

    // 6. Asosiy (1x / Primary / Standard / Main) kamera aniqlash
    const isMain = !isFront && !isUltraWide && !isMacro && !isTele && (
      l.includes('main') ||
      l.includes('primary') ||
      l.includes('standard') ||
      l.includes('1x') ||
      isCamera2Main ||
      (l.includes('wide') && !isUltraWide) || // Masalan iPhone'da: "Back Wide Camera" bu Asosiy 1x kamera!
      (l.includes('back') && !isCamera2Aux) ||
      (l.includes('rear') && !isCamera2Aux) ||
      index === 0
    );

    // Ball berish — Asosiy 1x kamerani birinchi o'ringa olib chiqish
    let score = 50;
    if (isFront) {
      score = -1000;
    } else if (isUltraWide) {
      score = -250; // Ultra-wide kamerani pastga tushirish!
    } else if (isMacro) {
      score = -150;
    } else if (isCamera2Aux) {
      score = -60;
    } else if (isTele) {
      score = 40;
    } else if (isMain) {
      score = 250;
      if (isCamera2Main) score += 60;
      if (l.includes('main') || l.includes('primary') || l.includes('standard')) score += 80;
      if (l.includes('1x')) score += 50;
    } else {
      if (l.includes('back') || l.includes('rear')) score += 30;
      if (index === 0) score += 10;
    }

    // Foydalanuvchiga tushunarli chiroyli nom
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
    } else if (rawLabel) {
      name = rawLabel.split('(')[0].trim() || `Kamera ${index + 1}`;
    } else {
      name = `Kamera ${index + 1}`;
    }

    return {
      id: d.id,
      label: rawLabel,
      name,
      isFront,
      isUltraWide,
      isMain,
      score,
      originalIndex: index
    };
  });

  // Eng yuqori ballga ega bo'lgan Asosiy kamera eng tepaga chiqadi
  return classified.sort((a, b) => b.score - a.score);
}

/**
 * QrScannerModal — yuqori aniqlikdagi shared QR skaner modali.
 * 
 * Imkoniyatlar:
 *  - 1x Asosiy kamerani avtomatik aniqlash va faollashtirish (hira 0.5x keng burchak kameradan qochish)
 *  - Ko'p kamerali telefonlarda kamera almashtirish (Asosiy, 0.5x, Telefoto, Selfi)
 *  - Doimiy avtofokus (continuous autofocus) va tap-to-focus
 *  - 1080p Full HD video oqimi (kichik 40x30mm QR kodlarni yaqindan tiniq ko'rish uchun)
 *  - Apparat va raqamli Zoom (1x, 1.5x, 2x, 2.5x, 3x)
 *  - Chiroq / Flashlight (agar qo'llab-quvvatlansa)
 */
export function QrScannerModal({ open, onClose, onScan, title = 'QR kodni skanerlang' }) {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);
  const scannedRef = useRef(false);
  const regionIdRef = useRef(`qr-scanner-${Math.random().toString(36).slice(2, 9)}`);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [cameras, setCameras] = useState([]);
  const [activeCameraId, setActiveCameraId] = useState('');
  const [facingMode, setFacingMode] = useState('environment'); // 'environment' | 'user'
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

  // Kamerani almashtirish (Asosiy -> Boshqa orqa kameralar -> Old kamera)
  const switchNextCamera = () => {
    if (cameras && cameras.length > 1) {
      const currentIdx = cameras.findIndex(c => c.id === activeCameraId);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % cameras.length : 1 % cameras.length;
      const nextCam = cameras[nextIdx];
      if (nextCam) {
        setActiveCameraId(nextCam.id);
        setZoom(1);
        setTorchOn(false);
      }
    } else {
      // Agar kameralar ro'yxati 1 ta bo'lsa yoki brauzer cheklagan bo'lsa, facingMode o'zgartiriladi
      const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
      setFacingMode(nextFacing);
      setActiveCameraId('');
      setZoom(1);
      setTorchOn(false);
    }
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
    const startedAt = Date.now();

    const stopTracks = () => {
      try {
        const videoEl = containerRef.current?.querySelector('video');
        if (videoEl?.srcObject) {
          const stream = videoEl.srcObject;
          if (stream.getTracks) {
            stream.getTracks().forEach(t => {
              try { t.stop(); } catch {}
            });
          }
          videoEl.srcObject = null;
        }
      } catch {}
    };

    const cleanupScanner = async (scanner) => {
      if (!scanner) {
        stopTracks();
        return;
      }
      try {
        const state = scanner.getState?.();
        if (state === 2 || state === 3) {
          await scanner.stop();
        }
      } catch (err) {
        console.warn('Scanner stop warn:', err);
      }
      try {
        scanner.clear();
      } catch {}
      stopTracks();
    };

    const start = async () => {
      try {
        if (!navigator?.mediaDevices?.getUserMedia) {
          setError('Kameradan foydalanish uchun sayt xavfsiz (HTTPS) ulanishda ochilishi kerak yoki brauzeringiz kamerani qo‘llab-quvvatlamaydi.');
          setStarting(false);
          return;
        }

        // Oldingi har qanday kamera oqimini to'xtatish
        stopTracks();
        if (scannerRef.current) {
          try {
            const st = scannerRef.current.getState?.();
            if (st === 2 || st === 3) {
              await scannerRef.current.stop();
            }
          } catch {}
          try { scannerRef.current.clear(); } catch {}
          scannerRef.current = null;
        }

        const { Html5Qrcode } = await import('html5-qrcode');
        if (stopped) return;

        const elementId = regionIdRef.current;
        const domEl = document.getElementById(elementId);
        if (!domEl || stopped) return;
        domEl.innerHTML = '';

        // Kamerasiz boshlashdan oldin ruxsatni tekshirish va barcha kameralar ro'yxatini olish
        let rawDevices = [];
        try {
          rawDevices = await Html5Qrcode.getCameras();
        } catch {}

        let hasLabels = rawDevices.some(d => Boolean(d.label));
        if (!hasLabels) {
          // Agar ruxsat hali olinmagan bo'lsa, tezkor ruxsat so'rab olamiz (labels olish uchun)
          try {
            const tempStream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: facingMode },
              audio: false
            });
            tempStream.getTracks().forEach(t => {
              try { t.stop(); } catch {}
            });
            await new Promise(r => setTimeout(r, 60)); // apparat kamerani bo'shatishi uchun kichik tanaffus
            rawDevices = await Html5Qrcode.getCameras();
          } catch (permErr) {
            console.warn('Kameraga ruxsat tekshirish ogohlantirish:', permErr);
          }
        }

        const classified = classifyAndScoreCameras(rawDevices);
        if (classified.length && !stopped) {
          setCameras(classified);
        }

        // Qaysi kamerani tanlash kerak:
        // 1. Agar foydalanuvchi ma'lum kamerani tanlagan bo'lsa (activeCameraId)
        // 2. Aks holda, ko'p kamerali telefonlarda eng yuqori ballli ASOSIY (1x) orqa kamerani tanlaymiz (keng burchak 0.5x emas!)
        let selectedId = activeCameraId;
        if (!selectedId && facingMode === 'environment') {
          const bestMainCam = classified.find(c => !c.isFront && !c.isUltraWide && !c.isMacro) || classified[0];
          if (bestMainCam) {
            selectedId = bestMainCam.id;
            setActiveCameraId(bestMainCam.id);
          }
        }

        html5QrCode = new Html5Qrcode(elementId, {
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
          }
        });
        scannerRef.current = html5QrCode;

        // Aniq va universal skaner sozlamalari
        const qrConfig = {
          fps: 25,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.max(180, Math.floor(minEdge * 0.8));
            return { width: size, height: size };
          },
          disableFlip: false
        };

        const onScanSuccess = (decodedText) => {
          if (stopped || scannedRef.current) return;
          // Dastlabki 350ms ichida eskirgan kadr / keshni qabul qilmaslik
          if (Date.now() - startedAt < 350) return;

          scannedRef.current = true;
          cleanupScanner(html5QrCode);
          onScan?.(decodedText);
          onClose?.();
        };

        const onScanFailure = () => {};

        let startedSuccessfully = false;

        // 1-urinish: Asosiy kameraning aniq ID si orqali ochish
        if (selectedId) {
          try {
            await html5QrCode.start(selectedId, qrConfig, onScanSuccess, onScanFailure);
            startedSuccessfully = true;
          } catch (errCam) {
            console.warn('Tanlangan kamera ID bo‘yicha ochilmadi, fallback qo‘llanadi:', errCam);
          }
        }

        // 2-urinish: facingMode orqali orqa kamera (environment)
        if (!startedSuccessfully && !stopped) {
          try {
            const mode = facingMode === 'user' ? { facingMode: 'user' } : { facingMode: 'environment' };
            await html5QrCode.start(mode, qrConfig, onScanSuccess, onScanFailure);
            startedSuccessfully = true;
          } catch (err2) {
            console.warn('facingMode bo‘yicha ochilmadi:', err2);
          }
        }

        // 3-urinish: Birinchi mavjud qurilma
        if (!startedSuccessfully && !stopped && rawDevices && rawDevices[0]) {
          try {
            await html5QrCode.start(rawDevices[0].id, qrConfig, onScanSuccess, onScanFailure);
            startedSuccessfully = true;
          } catch (err3) {
            console.warn('rawDevices[0] bo‘yicha ochilmadi:', err3);
          }
        }

        if (!startedSuccessfully) {
          throw new Error('Kamera oqimini ochib bo‘lmadi. Kameraga ruxsat berilganligini tekshiring.');
        }

        if (stopped) {
          cleanupScanner(html5QrCode);
          return;
        }

        setStarting(false);
        setError('');

        // Kamera ishga tushgach, apparat zoom va fokusni sozlash
        setTimeout(() => {
          if (stopped) return;
          try {
            const videoEl = containerRef.current?.querySelector('video');
            const track = videoEl?.srcObject?.getVideoTracks?.()?.[0];
            if (track) {
              const capabilities = track.getCapabilities?.() || {};
              const advanced = [];

              // Doimiy avtofokus
              if (capabilities.focusMode && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
                advanced.push({ focusMode: 'continuous' });
              }
              if (capabilities.exposureMode && Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
                advanced.push({ exposureMode: 'continuous' });
              }

              // Agar apparat zoom minimali 1 dan kichik bo'lsa (ya'ni 0.5x keng burchak bo'lsa),
              // kichik QR kodlar xira ko'rinmasligi uchun zoomni kamida 1.0x ga ko'taramiz!
              if (capabilities.zoom) {
                const minZ = capabilities.zoom.min || 1;
                const maxZ = capabilities.zoom.max || 4;
                setZoomRange({
                  min: minZ,
                  max: maxZ,
                  step: capabilities.zoom.step || 0.1
                });

                const targetZoom = Math.max(1, minZ);
                advanced.push({ zoom: targetZoom });
                setZoom(targetZoom);
              }

              if (advanced.length) {
                track.applyConstraints({ advanced }).catch(() => {});
              }

              setHasTorch(Boolean(capabilities.torch));
            }
          } catch {
            // ignore
          }
        }, 320);

      } catch (err) {
        if (!stopped) {
          setStarting(false);
          const msg = String(err?.message || err || '');
          if (msg.includes('NotAllowed') || msg.includes('Permission')) {
            setError('Kameraga ruxsat berilmadi. Brauzer sozlamalaridan kameraga ruxsat bering.');
          } else if (msg.includes('NotFound') || msg.includes('Requested device not found') || msg.includes('Overconstrained')) {
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
      cleanupScanner(html5QrCode);
      scannerRef.current = null;
    };
  }, [open, activeCameraId, facingMode]);

  if (!open) return null;

  const currentCam = (activeCameraId ? cameras.find(c => c.id === activeCameraId) : null) || cameras[0];
  const currentCamName = currentCam?.name || (facingMode === 'user' ? 'Old kamera (Selfi)' : 'Asosiy kamera (1x)');

  return (
    <div className="overlay qr-scanner-overlay" onClick={onClose}>
      <div className="qr-scanner-modal" onClick={e => e.stopPropagation()}>
        <div className="qr-scanner-header">
          <Camera size={20} />
          <b>{title}</b>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Yopish"><X size={18} /></button>
        </div>

        <div className="qr-scanner-body" onClick={handleTapToFocus} title="Fokusni to‘g‘rilash uchun bosing">
          <div id={regionIdRef.current} className="qr-scanner-region" ref={containerRef} />
          
          {/* Kamera nomi nishoni */}
          {!starting && !error && (
            <div className="qr-scanner-badge">
              <Camera size={13} /> {currentCamName}
            </div>
          )}

          {/* Ekranning tepa o'ng qismidagi tezkor kamera almashtirish tugmasi */}
          {!starting && !error && (
            <button
              type="button"
              className="qr-scanner-flip-cam-btn"
              onClick={(e) => {
                e.stopPropagation();
                switchNextCamera();
              }}
              title="Kamerani almashtirish (Asosiy / Old / Boshqa)"
              aria-label="Kamerani almashtirish"
            >
              <RefreshCw size={13} />
              <span>Almashtirish</span>
            </button>
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
            {/* Kamera tanlash bo'limi */}
            <div className="qr-cam-select-section">
              <div className="qr-cam-select-header">
                <span className="qr-ctrl-label"><Camera size={13}/> Kamera tanlash:</span>
                <button
                  type="button"
                  className="qr-cam-quick-switch-btn"
                  onClick={switchNextCamera}
                  title="Keyingi kameraga o‘tish"
                >
                  <RefreshCw size={12}/> Kamerani almashtirish
                </button>
              </div>

              <div className="qr-cam-pills-row">
                {cameras.length > 0 ? (
                  cameras.map(cam => {
                    const isActive = cam.id === (activeCameraId || cameras[0]?.id);
                    return (
                      <button
                        key={cam.id}
                        type="button"
                        className={`qr-cam-pill ${isActive ? 'active' : ''} ${cam.isMain ? 'is-main' : ''}`}
                        onClick={() => {
                          if (cam.id !== activeCameraId) {
                            setActiveCameraId(cam.id);
                            setZoom(1);
                            setTorchOn(false);
                          }
                        }}
                      >
                        {cam.isMain ? '⭐ ' : ''}{cam.name}
                      </button>
                    );
                  })
                ) : (
                  <button
                    type="button"
                    className="qr-cam-pill active"
                    onClick={switchNextCamera}
                  >
                    {facingMode === 'user' ? 'Old kamera' : 'Asosiy kamera'} (Almashtirish)
                  </button>
                )}
              </div>
            </div>

            {/* Zoom sozlamasi */}
            <div className="qr-scanner-zoom-row">
              <span className="qr-ctrl-label"><ZoomIn size={14}/> Zoom (Yaqinlashtirish):</span>
              <div className="qr-zoom-pills">
                {[1, 1.5, 2, 2.5, 3].map(val => (
                  <button
                    key={val}
                    type="button"
                    className={`qr-zoom-pill ${Math.abs(zoom - val) < 0.12 ? 'active' : ''}`}
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
              <button
                type="button"
                className="qr-action-btn"
                onClick={switchNextCamera}
                title="Keyingi kameraga o‘tish"
              >
                <RefreshCw size={14}/> Kamerani almashtirish
              </button>

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
            ? '⚠️ Diqqat: Keng burchak (0.5x) kichik QR kodlarni hira ko‘rishi mumkin. Yuqoridan "Asosiy kamera (1x)"ni tanlang.'
            : '💡 Asosiy 1x kamera faol. Kichik 40x30mm QR kodlar uchun 1.5x–2x zoomdan foydalanishingiz yoki boshqa kameraga o‘tishingiz mumkin.'}
        </p>
      </div>
    </div>
  );
}

/**
 * QrScanButton — oddiy tugma, bosilganda QrScannerModal ochadi.
 * Har bir ochilganda yangi key beriladi, bu avvalgi skaner xotirasi qolib ketishining oldini oladi.
 */
export function QrScanButton({ onScan, onOpen, className = '', title = 'QR skanerlash' }) {
  const [open, setOpen] = useState(false);
  const [scanKey, setScanKey] = useState(0);

  const handleOpen = () => {
    setScanKey(k => k + 1);
    setOpen(true);
    onOpen?.();
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleScan = (value) => {
    setOpen(false);
    onScan?.(value);
  };

  return (
    <>
      <button
        type="button"
        className={`btn qr-scan-btn ${className}`.trim()}
        onClick={handleOpen}
        aria-label={title}
        title={title}
      >
        <Camera size={18} />
      </button>
      {open && (
        <QrScannerModal
          key={scanKey}
          open={open}
          onClose={handleClose}
          onScan={handleScan}
          title={title}
        />
      )}
    </>
  );
}

