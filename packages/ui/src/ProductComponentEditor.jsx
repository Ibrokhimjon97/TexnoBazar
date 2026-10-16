import React, { useState } from 'react';
import { Plus, Trash2, Check, Layers, Upload, Image as ImageIcon, X, Link as LinkIcon } from 'lucide-react';
import { DualPriceInput, useExchangeRate } from './DualPriceInput.jsx';
import { BASE_COLOR_PALETTE } from './ColorVariantEditor.jsx';

/**
 * ProductComponentEditor:
 * Modular product component / add-on editor for admin and manager workflows.
 * Enables modular products like Beshik (with taxtasi, sumak, yostiqcha, etc.).
 *
 * Props:
 * - components: Array of component objects
 * - onChange: (updatedComponents | functional updater) => void
 * - rate: exchange rate for UZS/USD conversion
 */
export function ProductComponentEditor({ components = [], onChange, rate }) {
  const fallbackRate = useExchangeRate();
  const activeRate = rate || fallbackRate;

  const addComponent = () => {
    const newComponent = {
      id: null,
      name: '',
      color_name: '',
      color_hex: '#8B5A2B',
      cost_price: '',
      cost_price_usd: '',
      retail_price: '',
      retail_price_usd: '',
      wholesale_price: '',
      wholesale_price_usd: '',
      is_default: true,
      is_required: false,
      can_buy_standalone: true,
      image_url: null,
      imageFile: null,
      previewUrl: null,
      currency: 'UZS',
    };
    if (typeof onChange === 'function') {
      onChange(prev => {
        const list = Array.isArray(prev) ? prev : (components || []);
        return [...list, newComponent];
      });
    }
  };

  const updateComponent = (index, patch) => {
    if (typeof onChange === 'function') {
      onChange(prev => {
        const list = Array.isArray(prev) ? prev : (components || []);
        return list.map((c, i) => {
          if (i !== index) return c;
          const updates = typeof patch === 'function' ? patch(c) : patch;
          return { ...c, ...updates };
        });
      });
    }
  };

  const removeComponent = index => {
    if (typeof onChange === 'function') {
      onChange(prev => {
        const list = Array.isArray(prev) ? prev : (components || []);
        return list.filter((_, i) => i !== index);
      });
    }
  };

  return (
    <div className="product-components-section" style={{ marginTop: 24, marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Layers size={18} style={{ color: 'var(--orange, #f97316)' }} />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Tarkibiy va qo‘shimcha qismlar (Modulli tovar)</h3>
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted, #64748b)' }}>
            Masalan: Beshik (karkas, sumak, yostiqcha, to‘shak). Har bir qismga rasm, rang va narx biriktiriladi.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={addComponent}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={14} /> Yangi qism qo‘shish
        </button>
      </div>

      {components.length === 0 ? (
        <div style={{ padding: '20px', border: '1px dashed var(--border, #cbd5e1)', borderRadius: 12, textAlign: 'center', background: 'var(--surface-subtle, #f8fafc)' }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted, #64748b)' }}>
            Hozircha hech qanday tarkibiy qism biriktirilmagan. Agar ushbu tovar bir necha qismlardan iborat bo‘lsa, yuqoridagi <b>«Yangi qism qo‘shish»</b> tugmasini bosing.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {components.map((comp, idx) => (
            <ComponentCard
              key={comp.id || `comp-${idx}`}
              index={idx}
              component={comp}
              onUpdate={patch => updateComponent(idx, patch)}
              onRemove={() => removeComponent(idx)}
              rate={activeRate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ComponentCard({ index, component, onUpdate, onRemove, rate }) {
  const [showUrlInput, setShowUrlInput] = useState(false);

  const set = (key, value) => {
    onUpdate({ [key]: value });
  };

  const pickPalette = (hex, name) => {
    onUpdate({
      color_hex: hex,
      color_name: component.color_name || name,
    });
  };

  const handleImageFile = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        alert('Rasm hajmi 10 MB dan oshmasligi kerak');
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      onUpdate({
        imageFile: file,
        previewUrl,
        image_url: previewUrl,
      });
    }
    e.target.value = '';
  };

  const removeImage = (e) => {
    e?.stopPropagation?.();
    onUpdate({
      imageFile: null,
      previewUrl: null,
      image_url: null,
    });
  };

  const currentImg = component.previewUrl || component.image_url;

  return (
    <article
      className="card pad"
      style={{
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 12,
        background: 'var(--surface, #ffffff)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        display: 'grid',
        gap: 12,
        padding: 16
      }}
    >
      {/* Head row: Index, Image upload, Color picker, Name, Color Name, Delete */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted, #64748b)', minWidth: 20 }}>
          #{index + 1}
        </span>

        {/* Component Image Picker */}
        {currentImg ? (
          <div
            style={{
              position: 'relative',
              width: 42,
              height: 42,
              borderRadius: 8,
              overflow: 'hidden',
              border: '2px solid var(--orange, #f97316)',
              boxShadow: '0 2px 4px rgba(0,0,0,0.06)',
              flexShrink: 0,
              background: '#f1f5f9'
            }}
            title="Qism rasmi (o‘zgartirish uchun bosing yoki ✕ bilan o‘chiring)"
          >
            <img
              src={currentImg}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <button
              type="button"
              onClick={removeImage}
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                width: 16,
                height: 16,
                background: 'rgba(0,0,0,0.7)',
                color: '#fff',
                border: 0,
                borderRadius: 4,
                fontSize: 10,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0
              }}
              title="Rasmni o‘chirish"
            >
              ✕
            </button>
          </div>
        ) : (
          <label
            style={{
              width: 42,
              height: 42,
              borderRadius: 8,
              border: '1px dashed #cbd5e1',
              background: '#f8fafc',
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
              color: '#64748b',
              transition: 'all 0.15s ease'
            }}
            title="Qism uchun rasm yuklash"
          >
            <Upload size={14} style={{ color: 'var(--orange, #f97316)' }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text, #1e293b)' }}>Rasm</span>
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={handleImageFile}
            />
          </label>
        )}

        {/* Color swatch picker */}
        <label
          style={{
            position: 'relative',
            width: 34,
            height: 34,
            borderRadius: '50%',
            overflow: 'hidden',
            cursor: 'pointer',
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px #cbd5e1',
            display: 'inline-block',
            flexShrink: 0
          }}
          title="Rang tanlash"
        >
          <input
            type="color"
            value={component.color_hex || '#8B5A2B'}
            onChange={e => set('color_hex', e.target.value)}
            style={{ position: 'absolute', top: -10, left: -10, width: 60, height: 60, opacity: 0, cursor: 'pointer' }}
          />
          <span style={{ display: 'block', width: '100%', height: '100%', background: component.color_hex || '#8B5A2B' }} />
        </label>

        {/* Component Name */}
        <input
          className="input"
          value={component.name || ''}
          onChange={e => set('name', e.target.value)}
          placeholder="Qism nomi (masalan: Beshik taxtasi, Sumak, Yostiq...)"
          required
          style={{ flex: '1 1 200px', fontWeight: 600 }}
        />

        {/* Color Name */}
        <input
          className="input"
          value={component.color_name || ''}
          onChange={e => set('color_name', e.target.value)}
          placeholder="Rangi (masalan: Yong‘oq, Oq, Qizil)"
          style={{ flex: '1 1 140px' }}
        />

        {/* Toggle URL input */}
        <button
          type="button"
          className="btn btn-outline btn-xs"
          onClick={() => setShowUrlInput(v => !v)}
          title="Rasm URL havolasini kiritish"
          style={{ padding: '5px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <LinkIcon size={12} /> {showUrlInput ? 'URL yopish' : 'Rasm URL'}
        </button>

        {/* Delete button */}
        <button
          type="button"
          className="icon-btn danger-icon"
          onClick={onRemove}
          title="Qismni o‘chirish"
          style={{ marginLeft: 'auto' }}
        >
          <Trash2 size={16} />
        </button>
      </div>

      {/* Optional Direct Image URL Input */}
      {showUrlInput && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <LinkIcon size={14} style={{ color: 'var(--muted)' }} />
          <input
            className="input"
            type="url"
            value={component.image_url || ''}
            onChange={e => {
              const url = e.target.value;
              onUpdate({ image_url: url, previewUrl: url, imageFile: null });
            }}
            placeholder="Rasm URL havolasi (https://...)"
            style={{ fontSize: 12, flex: 1 }}
          />
        </div>
      )}

      {/* Quick Color Palette */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', paddingLeft: 30 }}>
        <span style={{ fontSize: 11, color: 'var(--muted, #64748b)' }}>Tezkor rang:</span>
        {BASE_COLOR_PALETTE.slice(0, 8).map(color => (
          <button
            type="button"
            key={color.hex}
            onClick={() => pickPalette(color.hex, color.name)}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: color.hex,
              border: component.color_hex === color.hex ? '2px solid var(--orange, #f97316)' : '1px solid #cbd5e1',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title={color.name}
          >
            {component.color_hex === color.hex && <Check size={10} color={color.hex === '#FFFFFF' ? '#000' : '#fff'} />}
          </button>
        ))}
      </div>

      {/* Pricing Row: Cost Price, Retail Price, Wholesale Price */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 4 }}>
        <DualPriceInput
          label="Tannarxi"
          valueUzs={component.cost_price != null ? String(component.cost_price) : (component.cost_price_uzs != null ? String(component.cost_price_uzs) : '')}
          onChangeUzs={val => onUpdate({ cost_price: val, cost_price_uzs: val, cost_price_currency: 'UZS' })}
          valueUsd={component.cost_price_usd != null ? String(component.cost_price_usd) : ''}
          onChangeUsd={val => onUpdate({ cost_price_usd: val, cost_price_currency: 'USD' })}
          rate={rate}
          currency={component.cost_price_currency || component.currency || 'UZS'}
          onCurrencyChange={curr => onUpdate({ cost_price_currency: curr })}
        />
        <DualPriceInput
          label="Sotish narxi *"
          valueUzs={component.retail_price != null ? String(component.retail_price) : (component.retail_price_uzs != null ? String(component.retail_price_uzs) : '')}
          onChangeUzs={val => onUpdate({ retail_price: val, retail_price_uzs: val, retail_price_currency: 'UZS' })}
          valueUsd={component.retail_price_usd != null ? String(component.retail_price_usd) : ''}
          onChangeUsd={val => onUpdate({ retail_price_usd: val, retail_price_currency: 'USD' })}
          rate={rate}
          currency={component.retail_price_currency || component.currency || 'UZS'}
          onCurrencyChange={curr => onUpdate({ retail_price_currency: curr })}
        />
        <DualPriceInput
          label="Ulgurji narxi"
          valueUzs={component.wholesale_price != null ? String(component.wholesale_price) : (component.wholesale_price_uzs != null ? String(component.wholesale_price_uzs) : '')}
          onChangeUzs={val => onUpdate({ wholesale_price: val, wholesale_price_uzs: val, wholesale_price_currency: 'UZS' })}
          valueUsd={component.wholesale_price_usd != null ? String(component.wholesale_price_usd) : ''}
          onChangeUsd={val => onUpdate({ wholesale_price_usd: val, wholesale_price_currency: 'USD' })}
          rate={rate}
          currency={component.wholesale_price_currency || component.currency || 'UZS'}
          onCurrencyChange={curr => onUpdate({ wholesale_price_currency: curr })}
        />
      </div>

      {/* Rules and flags */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', background: 'var(--surface-subtle, #f8fafc)', padding: '10px 14px', borderRadius: 8, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(component.is_default)}
            onChange={e => set('is_default', e.target.checked)}
          />
          <span>To‘plamga kiritilgan (Default tanlangan)</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(component.is_required)}
            onChange={e => set('is_required', e.target.checked)}
          />
          <span>Majburiy qism (Mijoz to‘plamdan o‘chira olmaydi)</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={component.can_buy_standalone !== false}
            onChange={e => set('can_buy_standalone', e.target.checked)}
          />
          <span>Alohida (faqat o‘zi) xarid qilinishi mumkin</span>
        </label>
      </div>
    </article>
  );
}
