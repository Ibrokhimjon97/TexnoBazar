import React, { useState } from 'react';
import { Check, Plus, Trash2, Upload, X } from 'lucide-react';
import { DualPriceInput } from './DualPriceInput.jsx';

// 12 asosiy ranglar palitrasi — texnika uchun eng ko'p ishlatiladigan ranglar.
export const BASE_COLOR_PALETTE = [
  { name: 'Oq', hex: '#FFFFFF' },
  { name: 'Qora', hex: '#1A1A1A' },
  { name: 'Kulrang', hex: '#8C8C8C' },
  { name: 'Kumush', hex: '#C7CBD1' },
  { name: 'Qizil', hex: '#E53935' },
  { name: 'Ko\u2018k', hex: '#1E88E5' },
  { name: 'Yashil', hex: '#43A047' },
  { name: 'Sariq', hex: '#FDD835' },
  { name: 'Jigarrang', hex: '#6D4C41' },
  { name: 'Bej', hex: '#E8DCC8' },
  { name: 'Oltin', hex: '#C9A227' },
  { name: 'Pushti', hex: '#EC80A0' },
];

/**
 * Bitta rangdagi mahsulot variantining tahrirlash bloki: rang, narx override,
 * (ixtiyoriy) miqdor va shu rang uchun alohida rasmlar.
 *
 * Props:
 * - variant: {color_name, color_hex, retail_price, wholesale_price, promotion_price,
 *     minimum_sale_price, quantity, is_active, media:[{id,public_url,is_primary}], imageFiles:File[]}
 * - onChange(next), onRemove()
 * - showQuantity: manager oqimida miqdor inputi ko'rsatiladi
 * - showWholesale: ulgurji narx inputi ko'rsatiladi
 * - basePriceHint: umumiy (mahsulot darajasidagi) narx — bo'sh qoldirilsa shu amal qiladi
 * - rate: valyuta kursi (DualPriceInput uchun)
 * - onRemoveExistingImage(mediaId): mavjud (allaqachon serverга yuklangan) rasmni o'chirish
 */
function VariantRow({ variant, onChange, onRemove, showQuantity, showWholesale, basePriceHint, rate }) {
  const set = (key, value) => onChange({ ...variant, [key]: value });
  const pickPalette = (hex, name) => onChange({ ...variant, color_hex: hex, color_name: variant.color_name || name });
  const addImages = e => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    onChange({ ...variant, imageFiles: [...(variant.imageFiles || []), ...files] });
    e.target.value = '';
  };
  const removeNewImage = index => onChange({ ...variant, imageFiles: (variant.imageFiles || []).filter((_, i) => i !== index) });

  return (
    <article className="variant-row card pad">
      <div className="variant-row-head">
        <label className="variant-swatch-input">
          <input
            type="color"
            value={variant.color_hex || '#cccccc'}
            onChange={e => set('color_hex', e.target.value)}
            aria-label="Rang tanlash"
          />
          <span style={{ background: variant.color_hex || '#cccccc' }} />
        </label>
        <input
          className="input variant-name-input"
          value={variant.color_name || ''}
          onChange={e => set('color_name', e.target.value)}
          placeholder="Rang nomi (masalan: Oq)"
          required
        />
        <button type="button" className="icon-btn danger-icon" onClick={onRemove} title="Variantni o'chirish">
          <Trash2 size={16} />
        </button>
      </div>

      <div className="variant-palette">
        {BASE_COLOR_PALETTE.map(color => (
          <button
            type="button"
            key={color.hex}
            className={variant.color_hex === color.hex ? 'variant-swatch active' : 'variant-swatch'}
            style={{ background: color.hex }}
            title={color.name}
            onClick={() => pickPalette(color.hex, color.name)}
          >
            {variant.color_hex === color.hex && <Check size={13} />}
          </button>
        ))}
      </div>

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
        <div className="variant-field wide">
          <DualPriceInput
            label={`Sotish narxi ${basePriceHint ? `(bo'sh = ${basePriceHint})` : '(ixtiyoriy)'}`}
            valueUzs={variant.retail_price ?? ''}
            onChangeUzs={v => set('retail_price', v)}
            rate={rate}
          />
        </div>
        {showWholesale && (
          <div className="variant-field wide">
            <DualPriceInput
              label="Ulgurji narx (ixtiyoriy)"
              valueUzs={variant.wholesale_price ?? ''}
              onChangeUzs={v => set('wholesale_price', v)}
              rate={rate}
            />
          </div>
        )}
      </div>

      <div className="variant-media">
        <span className="label">Ushbu rang uchun rasmlar</span>
        <div className="variant-media-grid">
          {(variant.media || []).map(media => (
            <div className="variant-media-item" key={media.id}>
              <img src={media.public_url} alt="" />
              {media.is_primary && <b className="variant-media-primary">Asosiy</b>}
            </div>
          ))}
          {(variant.imageFiles || []).map((file, index) => (
            <div className="variant-media-item pending" key={`pending-${index}`}>
              <img src={URL.createObjectURL(file)} alt="" />
              <button type="button" onClick={() => removeNewImage(index)}><X size={12} /></button>
            </div>
          ))}
          <label className="variant-media-upload">
            <Upload size={16} />
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={addImages} />
          </label>
        </div>
      </div>
    </article>
  );
}

export function ColorVariantEditor({ variants = [], setVariants, showQuantity = false, showWholesale = true, basePriceHint, rate }) {
  const [showCustom, setShowCustom] = useState(false);
  const add = () => {
    setVariants([...variants, { color_name: '', color_hex: '#CCCCCC', retail_price: '', wholesale_price: '', promotion_price: '', minimum_sale_price: '', quantity: '', media: [], imageFiles: [] }]);
    setShowCustom(false);
  };
  const update = (index, next) => setVariants(variants.map((v, i) => (i === index ? next : v)));
  const remove = index => setVariants(variants.filter((_, i) => i !== index));

  return (
    <section className="attribute-editor color-variant-editor">
      <div className="between">
        <div>
          <h3>Rang variantlari</h3>
          <small>Bir xil mahsulotning turli rangdagi versiyalari — har biri o'z zaxirasi, narxi va rasmiga ega bo'lishi mumkin.</small>
        </div>
        <button type="button" className="btn btn-outline" onClick={add}><Plus size={15} /> Rang qo'shish</button>
      </div>
      {variants.length === 0 ? (
        <p className="variant-empty">Rang variantlari qo'shilmagan. Mahsulot yagona (rangsiz) sifatida saqlanadi.</p>
      ) : (
        <div className="variant-list">
          {variants.map((variant, index) => (
            <VariantRow
              key={variant.id || `new-${index}`}
              variant={variant}
              onChange={next => update(index, next)}
              onRemove={() => remove(index)}
              showQuantity={showQuantity}
              showWholesale={showWholesale}
              basePriceHint={basePriceHint}
              rate={rate}
            />
          ))}
        </div>
      )}
    </section>
  );
}
