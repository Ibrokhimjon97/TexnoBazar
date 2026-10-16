import React from 'react';
import { Plus, Trash2, Check, Layers, Info } from 'lucide-react';
import { DualPriceInput } from './DualPriceInput.jsx';
import { BASE_COLOR_PALETTE } from './ColorVariantEditor.jsx';

/**
 * ProductComponentEditor:
 * Modular product component / add-on editor for admin and manager workflows.
 * Enables modular products like Beshik (with taxtasi, sumak, yostiqcha, etc.).
 *
 * Props:
 * - components: Array of component objects
 * - onChange: (updatedComponents) => void
 * - rate: exchange rate for UZS/USD conversion
 */
export function ProductComponentEditor({ components = [], onChange, rate }) {
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
      currency: 'UZS',
    };
    onChange([...components, newComponent]);
  };

  const updateComponent = (index, key, value) => {
    const next = [...components];
    next[index] = { ...next[index], [key]: value };
    onChange(next);
  };

  const updateMultiple = (index, updates) => {
    const next = [...components];
    next[index] = { ...next[index], ...updates };
    onChange(next);
  };

  const removeComponent = index => {
    onChange(components.filter((_, i) => i !== index));
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
            Masalan: Beshik (karkas, sumak, yostiqcha, to‘shak). Mijoz saytda yoki seller POS-da kerakli qismlarni tanlab sotishi yoki alohida qismini xarid qilishi mumkin.
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
              onUpdate={(key, val) => updateComponent(idx, key, val)}
              onUpdateMultiple={updates => updateMultiple(idx, updates)}
              onRemove={() => removeComponent(idx)}
              rate={rate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ComponentCard({ index, component, onUpdate, onUpdateMultiple, onRemove, rate }) {
  const pickPalette = (hex, name) => {
    onUpdateMultiple({
      color_hex: hex,
      color_name: component.color_name || name,
    });
  };

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
      {/* Head row: Name, color picker, delete button */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted, #64748b)', minWidth: 20 }}>
          #{index + 1}
        </span>

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
            onChange={e => onUpdate('color_hex', e.target.value)}
            style={{ position: 'absolute', top: -10, left: -10, width: 60, height: 60, opacity: 0, cursor: 'pointer' }}
          />
          <span style={{ display: 'block', width: '100%', height: '100%', background: component.color_hex || '#8B5A2B' }} />
        </label>

        {/* Component Name */}
        <input
          className="input"
          value={component.name || ''}
          onChange={e => onUpdate('name', e.target.value)}
          placeholder="Qism nomi (masalan: Beshik taxtasi, Sumak, Yostiq...)"
          required
          style={{ flex: '1 1 200px', fontWeight: 600 }}
        />

        {/* Color Name */}
        <input
          className="input"
          value={component.color_name || ''}
          onChange={e => onUpdate('color_name', e.target.value)}
          placeholder="Rangi (masalan: Yong‘oq, Oq, Qizil)"
          style={{ flex: '1 1 140px' }}
        />

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
          valueUzs={component.cost_price}
          onChangeUzs={val => onUpdate('cost_price', val)}
          valueUsd={component.cost_price_usd}
          onChangeUsd={val => onUpdate('cost_price_usd', val)}
          rate={rate}
          currency={component.currency || 'UZS'}
          onCurrencyChange={curr => onUpdate('currency', curr)}
        />
        <DualPriceInput
          label="Sotish narxi *"
          valueUzs={component.retail_price}
          onChangeUzs={val => onUpdate('retail_price', val)}
          valueUsd={component.retail_price_usd}
          onChangeUsd={val => onUpdate('retail_price_usd', val)}
          rate={rate}
          currency={component.currency || 'UZS'}
          onCurrencyChange={curr => onUpdate('currency', curr)}
        />
        <DualPriceInput
          label="Ulgurji narxi"
          valueUzs={component.wholesale_price}
          onChangeUzs={val => onUpdate('wholesale_price', val)}
          valueUsd={component.wholesale_price_usd}
          onChangeUsd={val => onUpdate('wholesale_price_usd', val)}
          rate={rate}
          currency={component.currency || 'UZS'}
          onCurrencyChange={curr => onUpdate('currency', curr)}
        />
      </div>

      {/* Rules and flags */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', background: 'var(--surface-subtle, #f8fafc)', padding: '10px 14px', borderRadius: 8, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(component.is_default)}
            onChange={e => onUpdate('is_default', e.target.checked)}
          />
          <span>To‘plamga kiritilgan (Default tanlangan)</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(component.is_required)}
            onChange={e => onUpdate('is_required', e.target.checked)}
          />
          <span>Majburiy qism (Mijoz to‘plamdan o‘chira olmaydi)</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={component.can_buy_standalone !== false}
            onChange={e => onUpdate('can_buy_standalone', e.target.checked)}
          />
          <span>Alohida (faqat o‘zi) xarid qilinishi mumkin</span>
        </label>
      </div>
    </article>
  );
}
