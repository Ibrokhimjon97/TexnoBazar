import React, { useRef, useState } from 'react';
import { Camera, Check, Loader2, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { DualPriceInput } from './DualPriceInput.jsx';

// 12 ta eng ko'p qo'llaniladigan asosiy ranglar — texnika va tovarlar uchun eng ommabop ranglar
export const BASE_COLOR_PALETTE = [
  { name: 'Oq', hex: '#FFFFFF', border: true },
  { name: 'Qora', hex: '#111827' },
  { name: 'Kulrang', hex: '#6B7280' },
  { name: 'Kumush', hex: '#D1D5DB', border: true },
  { name: 'Qizil', hex: '#DC2626' },
  { name: 'Ko‘k', hex: '#2563EB' },
  { name: 'To‘q ko‘k', hex: '#1E3A8A' },
  { name: 'Yashil', hex: '#16A34A' },
  { name: 'Sariq', hex: '#EAB308' },
  { name: 'Oltin', hex: '#D97706' },
  { name: 'Jigarrang', hex: '#78350F' },
  { name: 'Pushti', hex: '#DB2777' },
];

// Rangni avtomatik aniqlash uchun kengaytirilgan ranglar kutubxonasi
export const EXTENDED_COLOR_LIBRARY = [
  { name: 'Oq', hex: '#FFFFFF', r: 255, g: 255, b: 255 },
  { name: 'Qora', hex: '#111827', r: 17, g: 24, b: 39 },
  { name: 'Kulrang', hex: '#6B7280', r: 107, g: 114, b: 128 },
  { name: 'Kumush', hex: '#D1D5DB', r: 209, g: 213, b: 219 },
  { name: 'Qizil', hex: '#DC2626', r: 220, g: 38, b: 38 },
  { name: 'To‘q qizil', hex: '#991B1B', r: 153, g: 27, b: 27 },
  { name: 'Ko‘k', hex: '#2563EB', r: 37, g: 99, b: 235 },
  { name: 'To‘q ko‘k', hex: '#1E3A8A', r: 30, g: 58, b: 138 },
  { name: 'Havorang', hex: '#38BDF8', r: 56, g: 189, b: 248 },
  { name: 'Yashil', hex: '#16A34A', r: 22, g: 163, b: 74 },
  { name: 'To‘q yashil', hex: '#14532D', r: 20, g: 83, b: 45 },
  { name: 'Och yashil', hex: '#84CC16', r: 132, g: 204, b: 22 },
  { name: 'Sariq', hex: '#EAB308', r: 234, g: 179, b: 8 },
  { name: 'Zarg‘aldoq', hex: '#EA580C', r: 234, g: 88, b: 12 },
  { name: 'Oltin', hex: '#D97706', r: 217, g: 119, b: 6 },
  { name: 'Jigarrang', hex: '#78350F', r: 120, g: 53, b: 15 },
  { name: 'Bej', hex: '#E8DCC8', r: 232, g: 220, b: 200 },
  { name: 'Qaymoqrang', hex: '#FEF3C7', r: 254, g: 243, b: 199 },
  { name: 'Pushti', hex: '#DB2777', r: 219, g: 39, b: 119 },
  { name: 'Binafsha', hex: '#7C3AED', r: 124, g: 58, b: 237 },
];

function componentToHex(c) {
  const hex = Math.max(0, Math.min(255, Math.round(c))).toString(16);
  return hex.length === 1 ? '0' + hex : hex;
}

export function rgbToHex(r, g, b) {
  return '#' + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

export function hexToRgb(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^#/, '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16)
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16)
    };
  }
  return null;
}

/**
 * Berilgan RGB rang uchun eng yaqin o'zbekcha rang nomini topish
 */
export function findClosestColor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  // Agar rang kam to'yingan bo'lsa (monoxrom / oq-qora-kulrang spektr)
  if (delta < 24) {
    if (brightness > 225) return { name: 'Oq', hex: '#FFFFFF' };
    if (brightness < 45) return { name: 'Qora', hex: '#111827' };
    if (brightness > 175) return { name: 'Kumush', hex: '#D1D5DB' };
    return { name: 'Kulrang', hex: '#6B7280' };
  }

  let closest = EXTENDED_COLOR_LIBRARY[0];
  let minDistance = Infinity;

  for (const item of EXTENDED_COLOR_LIBRARY) {
    // Inson ko'zi idroki uchun og'irliklar: R (0.3), G (0.59), B (0.11)
    const dr = r - item.r;
    const dg = g - item.g;
    const db = b - item.b;
    const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (dist < minDistance) {
      minDistance = dist;
      closest = item;
    }
  }

  return closest;
}

/**
 * Rasmdan (File, Blob, yoki rasm URL) avtomatik asosiy rangni aniqlash (HTML5 Canvas yordamida)
 */
export async function detectColorFromImageSource(source) {
  return new Promise((resolve) => {
    if (!source) return resolve(null);
    let objectUrl = null;
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const cleanup = () => {
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
      }
    };

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 64;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          cleanup();
          return resolve(null);
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        let whitePixels = 0;
        let totalOpaquePixels = 0;
        const colorBuckets = {};

        // Rasmning markaziy 70% maydoniga ko'proq e'tibor (chunki mahsulot markazda bo'ladi)
        const minCoord = Math.floor(size * 0.15);
        const maxCoord = Math.floor(size * 0.85);

        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            const a = data[idx + 3];
            if (a < 128) continue; // Shaffof fonlarni tashlab ketamiz

            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            totalOpaquePixels++;

            const isWhiteLike = r > 240 && g > 240 && b > 240;
            if (isWhiteLike) {
              whitePixels++;
            }

            const isCenter = x >= minCoord && x <= maxCoord && y >= minCoord && y <= maxCoord;
            const weight = isCenter ? 2 : 1;

            // RGB ni 32 talik qadamlarga kvantlash (0..7)
            const qr = Math.floor(r / 32);
            const qg = Math.floor(g / 32);
            const qb = Math.floor(b / 32);
            const key = `${qr}-${qg}-${qb}`;

            if (!colorBuckets[key]) {
              colorBuckets[key] = {
                count: 0,
                rSum: 0,
                gSum: 0,
                bSum: 0,
                isWhite: isWhiteLike
              };
            }
            colorBuckets[key].count += weight;
            colorBuckets[key].rSum += r * weight;
            colorBuckets[key].gSum += g * weight;
            colorBuckets[key].bSum += b * weight;
          }
        }

        cleanup();

        if (totalOpaquePixels === 0) {
          return resolve(null);
        }

        // Agar rasmning 88% dan ko'prog'i oq bo'lsa, mahsulotning o'zi ham oq bo'lishi mumkin
        const isMostlyWhite = (whitePixels / totalOpaquePixels) > 0.88;

        let bestBucket = null;
        let maxCount = -1;

        for (const key in colorBuckets) {
          const b = colorBuckets[key];
          // E-commerce oq fonini chetga suramiz, agar tovar o'zi oq bo'lmasa
          if (b.isWhite && !isMostlyWhite) continue;

          if (b.count > maxCount) {
            maxCount = b.count;
            bestBucket = b;
          }
        }

        if (!bestBucket) {
          return resolve({ name: 'Oq', hex: '#FFFFFF', detectedHex: '#FFFFFF' });
        }

        const avgR = Math.round(bestBucket.rSum / bestBucket.count);
        const avgG = Math.round(bestBucket.gSum / bestBucket.count);
        const avgB = Math.round(bestBucket.bSum / bestBucket.count);

        const hex = rgbToHex(avgR, avgG, avgB);
        const match = findClosestColor(avgR, avgG, avgB);

        resolve({
          name: match.name,
          hex: match.hex,
          detectedHex: hex,
          r: avgR,
          g: avgG,
          b: avgB
        });
      } catch {
        cleanup();
        resolve(null);
      }
    };

    img.onerror = () => {
      cleanup();
      resolve(null);
    };

    if (source instanceof Blob) {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    } else if (typeof source === 'string') {
      img.src = source;
    } else {
      resolve(null);
    }
  });
}

/**
 * Bitta rangdagi mahsulot variantining tahrirlash bloki:
 * - Rang nomi va Color Picker
 * - 12 ta eng ko'p qo'llaniladigan ranglar tugmalari
 * - "Rasmdan rangni aniqlash" funksiyasi
 * - Narx override va variant rasmlari
 */
function VariantRow({
  variant,
  index = 0,
  isPrimary = false,
  onChange,
  onRemove,
  onClearPrimary,
  showQuantity,
  showWholesale,
  showCost = true,
  basePriceHint,
  baseCostHint,
  rate,
  productImages = []
}) {
  const cameraInputRef = useRef(null);
  const [detecting, setDetecting] = useState(false);
  const [detectSuccess, setDetectSuccess] = useState('');

  const set = (key, value) => {
    onChange(prev => {
      const current = typeof prev === 'object' && prev !== null ? prev : variant;
      return { ...current, [key]: value };
    });
  };

  const pickPalette = (hex, name) => {
    onChange(prev => {
      const current = typeof prev === 'object' && prev !== null ? prev : variant;
      return { ...current, color_hex: hex, color_name: name };
    });
  };

  const handleColorPickerChange = (e) => {
    const hex = e.target.value;
    const rgb = hexToRgb(hex);
    let suggestedName = '';
    if (rgb) {
      const matched = findClosestColor(rgb.r, rgb.g, rgb.b);
      suggestedName = matched?.name || '';
    }
    onChange(prev => {
      const current = typeof prev === 'object' && prev !== null ? prev : variant;
      // Agar nom bo'sh bo'lsa yoki avvalgi nom palitradagi rang bo'lsa, mos nomni ham taklif qilamiz
      const shouldUpdateName = !current.color_name || BASE_COLOR_PALETTE.some(c => c.name.toLowerCase() === current.color_name.trim().toLowerCase());
      return {
        ...current,
        color_hex: hex,
        color_name: shouldUpdateName && suggestedName ? suggestedName : current.color_name
      };
    });
  };

  const runDetection = async (fileOrUrl) => {
    if (!fileOrUrl) return;
    setDetecting(true);
    setDetectSuccess('');
    try {
      const detected = await detectColorFromImageSource(fileOrUrl);
      if (detected) {
        onChange(prev => {
          const current = typeof prev === 'object' && prev !== null ? prev : variant;
          return {
            ...current,
            color_name: detected.name,
            color_hex: detected.hex
          };
        });
        setDetectSuccess(`Rang aniqlandi: ${detected.name}`);
        setTimeout(() => setDetectSuccess(''), 3000);
      }
    } catch (e) {
      console.warn('Rangni aniqlashda xatolik:', e);
    } finally {
      setDetecting(false);
    }
  };

  const triggerDetect = () => {
    // 1. Agar ushbu variant uchun yangi fayl tanlangan bo'lsa
    if (variant.imageFiles && variant.imageFiles.length > 0) {
      runDetection(variant.imageFiles[0]);
      return;
    }
    // 2. Agar ushbu variantda saqlangan rasm bo'lsa
    if (variant.media && variant.media.length > 0) {
      runDetection(variant.media[0].public_url || variant.media[0].url);
      return;
    }
    // 3. Agar mahsulot darajasidagi rasmlar bo'lsa (faqat 1-rang uchun)
    if (isPrimary && productImages && productImages.length > 0) {
      runDetection(productImages[0]);
      return;
    }
    // 4. Hech qanday rasm bo'lmasa, kamera / fayl ochiladi
    cameraInputRef.current?.click();
  };

  const onCameraFilePicked = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Rasm variantga ham biriktiriladi
    onChange(prev => {
      const current = typeof prev === 'object' && prev !== null ? prev : variant;
      return { ...current, imageFiles: [...(current.imageFiles || []), file] };
    });
    await runDetection(file);
    e.target.value = '';
  };

  const addImages = async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    onChange(prev => {
      const current = typeof prev === 'object' && prev !== null ? prev : variant;
      return { ...current, imageFiles: [...(current.imageFiles || []), ...files] };
    });
    // Agar rang nomi hali kiritilmagan bo'lsa, birinchi yuklangan rasmdan avtomatik aniqlash
    if (!variant.color_name && files[0]) {
      runDetection(files[0]);
    }
    e.target.value = '';
  };

  const removeNewImage = index => {
    onChange(prev => {
      const current = typeof prev === 'object' && prev !== null ? prev : variant;
      return { ...current, imageFiles: (current.imageFiles || []).filter((_, i) => i !== index) };
    });
  };

  const isCurrentColor = (c) => {
    if ((variant.color_name || '').trim().toLowerCase() === c.name.toLowerCase()) return true;
    if (variant.color_hex && variant.color_hex.toLowerCase() === c.hex.toLowerCase()) return true;
    return false;
  };

  return (
    <article className={`variant-row card pad ${isPrimary ? 'variant-row-primary' : ''}`}>
      {/* Yashirin fayl kiritish: Kamera / Rasm orqali rangni aniqlash */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        ref={cameraInputRef}
        onChange={onCameraFilePicked}
      />

      <div className="variant-row-title-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`variant-row-badge ${isPrimary ? 'primary' : 'secondary'}`}>
            {isPrimary ? 'Asosiy rang (1-rang)' : `${index + 1}-rang varianti`}
          </span>
          {isPrimary && (
            <span style={{ fontSize: 11, color: 'var(--muted, #64748b)' }}>
              (Baza tovar)
            </span>
          )}
        </div>
        <div>
          {isPrimary ? (
            (variant.color_name || variant.color_hex) && onClearPrimary && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={onClearPrimary}
                title="Tovar rangini tozalash (rangsiz tovar)"
                style={{ fontSize: 11, color: 'var(--muted, #64748b)' }}
              >
                Rangsiz qoldirish
              </button>
            )
          ) : (
            <button
              type="button"
              className="icon-btn danger-icon"
              onClick={onRemove}
              title="Variantni o‘chirish"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="variant-row-head">
        <label className="variant-swatch-input" title="Rang palitrasidan tanlash (Color picker)">
          <input
            type="color"
            value={variant.color_hex || '#111827'}
            onChange={handleColorPickerChange}
            aria-label="Rang tanlash"
          />
          <span style={{ background: variant.color_hex || '#111827' }} />
        </label>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input variant-name-input"
            value={variant.color_name || ''}
            onChange={e => set('color_name', e.target.value)}
            placeholder={isPrimary ? "1-rang nomi (masalan: Qora, Oq...)" : "Rang nomi (masalan: Qizil, Ko‘k...)"}
            required={!isPrimary}
          />
          <button
            type="button"
            className="btn btn-outline btn-sm variant-detect-btn"
            onClick={triggerDetect}
            disabled={detecting}
            title="Rasmdan rangni avtomatik aniqlash (kamera yoki mavjud rasmdan)"
          >
            {detecting ? <Loader2 size={14} className="spin" /> : <Camera size={14} />}
            <span className="hide-on-mobile">{detecting ? 'Aniqlanmoqda…' : 'Rasmdan aniqlash'}</span>
          </button>
        </div>
      </div>

      {detectSuccess && (
        <div className="variant-detect-toast">
          <Sparkles size={13} /> {detectSuccess}
        </div>
      )}

      {/* 12 ta eng ko'p qo'llaniladigan ranglar palitrasi */}
      <div className="variant-palette-box">
        <span className="variant-palette-label">Eng ko‘p ishlatiladigan 12 ta rang (1 marta bosishda tanlash):</span>
        <div className="variant-chips-grid">
          {BASE_COLOR_PALETTE.map(color => {
            const active = isCurrentColor(color);
            return (
              <button
                type="button"
                key={color.name}
                className={`variant-color-chip ${active ? 'active' : ''}`}
                onClick={() => pickPalette(color.hex, color.name)}
                title={`${color.name} (${color.hex})`}
              >
                <span
                  className="variant-chip-circle"
                  style={{
                    background: color.hex,
                    border: color.border ? '1px solid #cbd5e1' : 'none'
                  }}
                >
                  {active && (
                    <Check
                      size={11}
                      color={color.hex === '#FFFFFF' || color.hex === '#D1D5DB' ? '#0f172a' : '#ffffff'}
                      strokeWidth={3}
                    />
                  )}
                </span>
                <span className="variant-chip-name">{color.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Qo'shimcha narxlar */}
      <div className="variant-price-grid">
        {showQuantity && (
          <label className="variant-field">
            <span>Miqdor (dona)</span>
            <input
              className="input"
              type="number"
              min="0"
              max="1000"
              value={variant.quantity ?? ''}
              onChange={e => set('quantity', e.target.value)}
            />
          </label>
        )}
        {showCost && (
          <div className="variant-field wide">
            <DualPriceInput
              label={`Tan narxi ${baseCostHint ? `(bo'sh = ${baseCostHint})` : '(ixtiyoriy)'}`}
              valueUzs={variant.cost_price != null ? String(variant.cost_price) : ''}
              onChangeUzs={v => set('cost_price', v)}
              valueUsd={variant.cost_price_usd != null ? String(variant.cost_price_usd) : ''}
              onChangeUsd={v => set('cost_price_usd', v)}
              rate={rate}
            />
          </div>
        )}
        <div className="variant-field wide">
          <DualPriceInput
            label={`Sotish narxi ${basePriceHint ? `(bo'sh = ${basePriceHint})` : '(ixtiyoriy)'}`}
            valueUzs={variant.retail_price != null ? String(variant.retail_price) : ''}
            onChangeUzs={v => set('retail_price', v)}
            valueUsd={variant.retail_price_usd != null ? String(variant.retail_price_usd) : ''}
            onChangeUsd={v => set('retail_price_usd', v)}
            rate={rate}
          />
        </div>
        {showWholesale && (
          <div className="variant-field wide">
            <DualPriceInput
              label="Ulgurji narx (ixtiyoriy)"
              valueUzs={variant.wholesale_price != null ? String(variant.wholesale_price) : ''}
              onChangeUzs={v => set('wholesale_price', v)}
              valueUsd={variant.wholesale_price_usd != null ? String(variant.wholesale_price_usd) : ''}
              onChangeUsd={v => set('wholesale_price_usd', v)}
              rate={rate}
            />
          </div>
        )}
      </div>

      {/* Ushbu rang uchun rasmlar */}
      <div className="variant-media">
        <span className="label" style={{ fontSize: 12 }}>
          Ushbu rang uchun alohida rasmlar ({variant.color_name || 'Bu rang'}):
        </span>
        <div className="variant-media-grid">
          {(variant.media || []).map(media => (
            <div className="variant-media-item" key={media.id}>
              <img src={media.public_url || media.url} alt="" />
              {media.is_primary && <b className="variant-media-primary">Asosiy</b>}
            </div>
          ))}
          {(variant.imageFiles || []).map((file, i) => (
            <div className="variant-media-item pending" key={`pending-${i}`}>
              <img src={URL.createObjectURL(file)} alt="" />
              <button type="button" onClick={() => removeNewImage(i)}><X size={12} /></button>
            </div>
          ))}
          <label className="variant-media-upload" title="Ushbu rang uchun rasm yuklash">
            <Upload size={16} />
            <input type="file" accept="image/*" multiple hidden onChange={addImages} />
          </label>
        </div>
      </div>
    </article>
  );
}

/**
 * ColorVariantEditor: Mahsulot ranglari va variantlarini boshqarish komponenti.
 * 
 * Imkoniyatlari:
 * 1. 1-rang (Asosiy tovar): Mahsulot bir xil rangda bo'lsa ham uning rangini (masalan: Qora)
 *    kiritish va 12 ta rangdan oson tanlash imkoni.
 * 2. Color Picker palitra orqali istalgan rang soyasini tanlash.
 * 3. 12 ta eng ko'p ishlatiladigan ranglar (1 marta bosishda nom va hex kiritiladi).
 * 4. Rasmga olganda yoki rasmdan avtomatik rangni aniqlash (HTML5 Canvas bilan).
 * 5. Qo'shimcha rang variantlari (2-rang, 3-rang...) ni qulay qo'shish va o'chirish.
 */
export function ColorVariantEditor({
  variants = [],
  setVariants,
  showQuantity = false,
  showWholesale = true,
  showCost = true,
  basePriceHint,
  baseCostHint,
  rate,
  productImages = []
}) {
  // Agar variants bo'sh bo'lsa, 1-variant (asosiy tovar) uchun boshlang'ich obyekt ko'rsatiladi
  const primaryVariant = variants[0] || {
    color_name: '',
    color_hex: '#111827',
    cost_price: '',
    cost_price_usd: '',
    retail_price: '',
    retail_price_usd: '',
    wholesale_price: '',
    wholesale_price_usd: '',
    promotion_price: '',
    minimum_sale_price: '',
    quantity: '',
    media: [],
    imageFiles: []
  };

  const updatePrimary = (next) => {
    setVariants(prev => {
      const currentList = Array.isArray(prev) ? prev : [];
      const currentFirst = currentList[0] || primaryVariant;
      const updatedFirst = typeof next === 'function' ? next(currentFirst) : { ...currentFirst, ...next };

      if (currentList.length === 0) {
        return [updatedFirst];
      }
      return [updatedFirst, ...currentList.slice(1)];
    });
  };

  const clearPrimary = () => {
    setVariants(prev => {
      const currentList = Array.isArray(prev) ? prev : [];
      if (currentList.length <= 1) {
        return [];
      }
      // Agar qo'shimcha ranglar bo'lsa, birinchisini tozalaymiz
      const first = { ...currentList[0], color_name: '', color_hex: '#111827' };
      return [first, ...currentList.slice(1)];
    });
  };

  const addAdditionalVariant = () => {
    setVariants(prev => {
      const currentList = Array.isArray(prev) ? prev : [];
      const newVar = {
        color_name: '',
        color_hex: '#DC2626',
        cost_price: '',
        cost_price_usd: '',
        retail_price: '',
        retail_price_usd: '',
        wholesale_price: '',
        wholesale_price_usd: '',
        promotion_price: '',
        minimum_sale_price: '',
        quantity: '',
        media: [],
        imageFiles: []
      };

      if (currentList.length === 0) {
        // Agar birorta ham rang yo'q bo'lsa, 1-rang (baza) va 2-rang birga ochiladi
        return [
          {
            color_name: '',
            color_hex: '#111827',
            cost_price: '',
            cost_price_usd: '',
            retail_price: '',
            retail_price_usd: '',
            wholesale_price: '',
            wholesale_price_usd: '',
            promotion_price: '',
            minimum_sale_price: '',
            quantity: '',
            media: [],
            imageFiles: []
          },
          newVar
        ];
      }

      return [...currentList, newVar];
    });
  };

  const updateAdditional = (index, patch) => {
    setVariants(prev =>
      (prev || []).map((v, i) => (i === index ? (typeof patch === 'function' ? patch(v) : { ...v, ...patch }) : v))
    );
  };

  const removeAdditional = (index) => {
    setVariants(prev => (prev || []).filter((_, i) => i !== index));
  };

  const additionalVariants = (variants || []).slice(1);

  return (
    <section className="attribute-editor color-variant-editor">
      <div className="between" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Mahsulot rangi va rang variantlari</h3>
          <small style={{ color: 'var(--muted, #64748b)', fontSize: 12 }}>
            Agar tovar bir xil rangda bo‘lsa ham, rangini shu yerga kiriting (masalan: Qora, Oq).
            Boshqa ranglari bo‘lsa, «Boshqa rang qo‘shish» tugmasini bosing.
          </small>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={addAdditionalVariant}
          title="Mahsulotning boshqa ranglarini qo'shish (masalan: Qizil, Ko'k)"
        >
          <Plus size={15} /> Boshqa rang qo‘shish
        </button>
      </div>

      <div className="variant-list">
        {/* 1-rang (Asosiy tovar rangi) */}
        <VariantRow
          key={primaryVariant.id || 'primary-variant'}
          variant={primaryVariant}
          index={0}
          isPrimary={true}
          onChange={updatePrimary}
          onClearPrimary={clearPrimary}
          showQuantity={showQuantity}
          showWholesale={showWholesale}
          showCost={showCost}
          basePriceHint={basePriceHint}
          baseCostHint={baseCostHint}
          rate={rate}
          productImages={productImages}
        />

        {/* Qo'shimcha rang variantlari (2-rang, 3-rang...) */}
        {additionalVariants.map((variant, addIndex) => {
          const realIndex = addIndex + 1;
          return (
            <VariantRow
              key={variant.id || `additional-${realIndex}`}
              variant={variant}
              index={realIndex}
              isPrimary={false}
              onChange={next => updateAdditional(realIndex, next)}
              onRemove={() => removeAdditional(realIndex)}
              showQuantity={showQuantity}
              showWholesale={showWholesale}
              showCost={showCost}
              basePriceHint={basePriceHint}
              baseCostHint={baseCostHint}
              rate={rate}
              productImages={productImages}
            />
          );
        })}
      </div>
    </section>
  );
}
