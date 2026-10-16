import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, Package, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { Modal } from './index.jsx';
import { DualPriceInput, useExchangeRate } from './DualPriceInput.jsx';
import { ColorVariantEditor } from './ColorVariantEditor.jsx';
import { ProductComponentEditor } from './ProductComponentEditor.jsx';
import {
  SearchableCategoryPicker,
  SearchableBrandPicker,
  saveStoredRecent,
  RECENT_CATS_KEY,
  RECENT_BRANDS_KEY
} from './CategoryBrandPickers.jsx';
import {
  getBrowserClient,
  getCatalogProduct,
  saveCatalogProduct,
  saveProductVariants,
  saveProductComponents,
  uploadProductMedia,
  deleteProductMedia,
  setPrimaryProductMedia
} from '@texnobazar/data';

const slugify = v => (v || '').trim().toLowerCase().replace(/[‘’ʻʼ']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const errorText = e => {
  const m = String(e?.message || '');
  if (m.includes('duplicate key')) return 'SKU, shtrix-kod yoki slug avval mavjud.';
  if (m.includes('row-level')) return 'Bu amal uchun ruxsat yo‘q.';
  return m || 'Amal bajarilmadi.';
};

function coerceAttribute(def, value) {
  if (def.data_type === 'number') return Number(value);
  if (def.data_type === 'boolean') return Boolean(value);
  if (def.data_type === 'multiselect') return Array.isArray(value) ? value : String(value).split(',').map(x => x.trim()).filter(Boolean);
  return value;
}

function AttributeFields({ definitions, values, setValues }) {
  if (!definitions?.length) return null;
  return (
    <section className="attribute-editor wide" style={{ borderTop: '1px solid var(--line,#e2e8f0)', paddingTop: 14, marginTop: 10 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700 }}>Mahsulot xususiyatlari</h3>
      <div className="product-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {definitions.map(def => (
          <label key={def.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="label" style={{ fontSize: 12, fontWeight: 600 }}>{def.name}{def.is_required ? ' *' : ''}</span>
            {def.data_type === 'boolean' ? (
              <select className="select" value={String(values[def.id] ?? '')} onChange={e => setValues({ ...values, [def.id]: e.target.value === 'true' })} required={def.is_required}>
                <option value="">Tanlang</option>
                <option value="true">Ha</option>
                <option value="false">Yo‘q</option>
              </select>
            ) : def.data_type === 'select' ? (
              <select className="select" value={values[def.id] ?? ''} onChange={e => setValues({ ...values, [def.id]: e.target.value })} required={def.is_required}>
                <option value="">Tanlang</option>
                {def.options?.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            ) : def.data_type === 'multiselect' ? (
              <input className="input" value={Array.isArray(values[def.id]) ? values[def.id].join(', ') : values[def.id] ?? ''} onChange={e => setValues({ ...values, [def.id]: e.target.value })} required={def.is_required} placeholder={def.options?.join(', ')} />
            ) : (
              <input className="input" type={def.data_type === 'number' ? 'number' : def.data_type === 'date' ? 'date' : 'text'} value={values[def.id] ?? ''} onChange={e => setValues({ ...values, [def.id]: e.target.value })} required={def.is_required} />
            )}
          </label>
        ))}
      </div>
    </section>
  );
}

function NewCategoryInline({ categories, onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', parentId: '', imageUrl: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  const parents = (categories || []).filter(c => !c.parent_id);

  const submit = async e => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true); setError('');
    try {
      const client = getBrowserClient();
      const slug = slugify(form.name);
      const { data, error: insErr } = await client.from('categories').insert({
        name: form.name.trim(),
        slug,
        parent_id: form.parentId || null,
        image_url: form.imageUrl.trim() || null,
        is_active: true
      }).select('id,name,parent_id').single();
      if (insErr) throw insErr;
      onCreated(data);
      setOpen(false); setForm({ name: '', parentId: '', imageUrl: '' });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const uploadImage = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const client = getBrowserClient();
      const path = 'categories/' + Date.now() + '-' + file.name.replace(/[^a-z0-9._-]/gi, '_');
      const { error: ue } = await client.storage.from('logos').upload(path, file, { upsert: true });
      if (ue) throw ue;
      const { data: { publicUrl } } = client.storage.from('logos').getPublicUrl(path);
      setForm(f => ({ ...f, imageUrl: publicUrl }));
    } catch (er) { alert(er.message || 'Rasm yuklanmadi'); } finally { setUploading(false); e.target.value = ''; }
  };

  if (!open) return <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 4, width: 'fit-content' }} onClick={() => setOpen(true)}><Plus size={13} /> Yangi kategoriya</button>;
  return (
    <div style={{ gridColumn: '1/-1', border: '1px solid var(--border,#e2e8f0)', background: 'var(--surface,#fff)', borderRadius: 12, padding: 14, display: 'grid', gap: 10, marginTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b style={{ fontSize: 13 }}>Yangi kategoriya qo‘shish</b><button type="button" style={{ border: 0, background: 'none', cursor: 'pointer', fontSize: 16 }} onClick={() => setOpen(false)}>&times;</button></div>
      {error && <div className="employee-error">{error}</div>}
      <label><span className="label">Kategoriya nomi</span><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
      <label><span className="label">Ota kategoriya</span>
        <select className="select" value={form.parentId} onChange={e => setForm({ ...form, parentId: e.target.value })}>
          <option value="">— Asosiy (yuqori daraja) —</option>
          {parents.map(p => (
            <optgroup key={p.id} label={p.name}>
              <option value={p.id}>{p.name} (ota)</option>
              {categories.filter(c => c.parent_id === p.id).map(child => <option key={child.id} value={child.id}>&nbsp;&nbsp;↳ {child.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label><span className="label">Kategoriya rasmi</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" value={form.imageUrl} onChange={e => setForm({ ...form, imageUrl: e.target.value })} placeholder="URL yoki fayl yuklang" />
          <label className="btn btn-outline btn-sm" style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}>{uploading ? '...' : 'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadImage} /></label>
          {form.imageUrl && <img src={form.imageUrl} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }} />}
        </div>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>{busy ? 'Yaratilmoqda…' : 'Yaratish'}</button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Bekor</button>
      </div>
    </div>
  );
}

function NewBrandInline({ brands, onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', logo_url: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  const submit = async e => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true); setError('');
    try {
      const slug = form.slug.trim() || slugify(form.name);
      const { data, error: insErr } = await getBrowserClient().from('brands').insert({
        name: form.name.trim(), slug, logo_url: form.logo_url.trim() || null, description: form.description.trim() || null, is_active: true
      }).select('id,name').single();
      if (insErr) throw insErr;
      onCreated(data);
      setOpen(false); setForm({ name: '', slug: '', logo_url: '', description: '' });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const uploadLogo = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const client = getBrowserClient();
      const path = 'brands/' + Date.now() + '-' + file.name.replace(/[^a-z0-9._-]/gi, '_');
      const { error: ue } = await client.storage.from('logos').upload(path, file, { upsert: true });
      if (ue) throw ue;
      const { data: { publicUrl } } = client.storage.from('logos').getPublicUrl(path);
      setForm(f => ({ ...f, logo_url: publicUrl }));
    } catch (er) { alert(er.message || 'Logo yuklanmadi'); } finally { setUploading(false); e.target.value = ''; }
  };

  if (!open) return <button type="button" className="btn btn-outline" style={{ padding: '8px 12px', whiteSpace: 'nowrap' }} onClick={() => setOpen(true)} title="Yangi brend">+</button>;
  return (
    <div style={{ position: 'absolute', right: 0, top: '100%', zIndex: 30, background: 'var(--surface,#fff)', border: '1px solid var(--border,#e2e8f0)', borderRadius: 12, padding: 16, display: 'grid', gap: 10, width: 320, boxShadow: '0 8px 24px rgba(0,0,0,.15)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b style={{ fontSize: 13 }}>Yangi brend</b><button type="button" style={{ border: 0, background: 'none', fontSize: 16, cursor: 'pointer' }} onClick={() => setOpen(false)}>&times;</button></div>
      {error && <div className="employee-error">{error}</div>}
      <label><span className="label">Nomi</span><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
      <label><span className="label">Slug</span><input className="input" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} placeholder="avtomatik-yoki-qolda" /></label>
      <label><span className="label">Logo</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" value={form.logo_url} onChange={e => setForm({ ...form, logo_url: e.target.value })} placeholder="URL yoki yuklang" />
          <label className="btn btn-outline btn-sm" style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}>{uploading ? '...' : 'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadLogo} /></label>
        </div>
      </label>
      <label><span className="label">Tavsif</span><input className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Yaratilmoqda...' : 'Saqlash'}</button>
    </div>
  );
}

export function ProductEditor({ open, close, product, refs, saved, toast, RichTextEditor: CustomRichEditor }) {
  const rate = useExchangeRate();
  const [form, setForm] = useState({
    name: '', sku: '', barcode: '', category_id: '', brand_id: '',
    cost_price: '', retail_price: '', wholesale_price: '', promotion_price: '',
    minimum_sale_price: '0', compare_at_price: '', slug: '', video_url: '', description: ''
  });
  const [images, setImages] = useState([]);
  const [existingMedia, setExistingMedia] = useState([]);
  const [variants, setVariants] = useState([]);
  const [components, setComponents] = useState([]);
  const [categories, setCategories] = useState(refs?.categories || []);
  const [brands, setBrands] = useState(refs?.brands || []);
  const [attributes, setAttributes] = useState({});
  const [attributeDefs, setAttributeDefs] = useState(refs?.attributes || []);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (refs?.categories?.length) setCategories(refs.categories);
    if (refs?.brands?.length) setBrands(refs.brands);
    if (refs?.attributes?.length) setAttributeDefs(refs.attributes);
  }, [refs]);

  const targetProductId = product?.id || product?.product_id || null;

  useEffect(() => {
    if (!open) return;
    setError('');
    setImages([]);

    const client = getBrowserClient();
    const needCats = !refs?.categories?.length;
    const needBrands = !refs?.brands?.length;
    const needAttrs = !refs?.attributes?.length;

    if (needCats || needBrands || needAttrs) {
      Promise.all([
        needCats ? client.from('categories').select('id,name,parent_id,is_active').eq('is_active', true).order('sort_order') : Promise.resolve({ data: refs?.categories || [] }),
        needBrands ? client.from('brands').select('id,name,is_active').eq('is_active', true).order('name') : Promise.resolve({ data: refs?.brands || [] }),
        needAttrs ? client.from('attribute_definitions').select('id,name,data_type,options,category_id,is_required') : Promise.resolve({ data: refs?.attributes || [] })
      ]).then(([{ data: c }, { data: b }, { data: a }]) => {
        if (c?.length) setCategories(c);
        if (b?.length) setBrands(b);
        if (a?.length) setAttributeDefs(a);
      }).catch(() => {});
    }

    if (targetProductId) {
      setLoadingDetails(true);
      getCatalogProduct(targetProductId).then(full => {
        populateProduct(full);
      }).catch(err => {
        // Fallback to provided product object
        populateProduct(product);
      }).finally(() => {
        setLoadingDetails(false);
      });
    } else {
      setForm({
        name: '', sku: '', barcode: '', category_id: '', brand_id: '',
        cost_price: '', retail_price: '', wholesale_price: '', promotion_price: '',
        minimum_sale_price: '0', compare_at_price: '', slug: '', video_url: '', description: '',
        currency: 'UZS'
      });
      setExistingMedia([]);
      setVariants([]);
      setComponents([]);
      setAttributes({});
    }
  }, [open, targetProductId]);

  const populateProduct = prod => {
    if (!prod) return;
    setForm({
      name: prod.name || prod.product_name || '',
      sku: prod.sku || '',
      barcode: prod.barcode || '',
      category_id: prod.category_id || '',
      brand_id: prod.brand_id || '',
      cost_price: prod.cost_price != null ? String(prod.cost_price) : '',
      cost_price_usd: prod.cost_price_usd != null ? String(prod.cost_price_usd) : (prod.cost_price && rate ? String(Number((Number(prod.cost_price)/rate).toFixed(2))) : ''),
      retail_price: prod.retail_price != null ? String(prod.retail_price) : '',
      retail_price_usd: prod.retail_price_usd != null ? String(prod.retail_price_usd) : (prod.retail_price && rate ? String(Number((Number(prod.retail_price)/rate).toFixed(2))) : ''),
      wholesale_price: prod.wholesale_price != null ? String(prod.wholesale_price) : '',
      wholesale_price_usd: prod.wholesale_price_usd != null ? String(prod.wholesale_price_usd) : (prod.wholesale_price && rate ? String(Number((Number(prod.wholesale_price)/rate).toFixed(2))) : ''),
      promotion_price: prod.promotion_price != null ? String(prod.promotion_price) : '',
      minimum_sale_price: prod.minimum_sale_price != null ? String(prod.minimum_sale_price) : '0',
      minimum_sale_price_usd: prod.minimum_sale_price_usd != null ? String(prod.minimum_sale_price_usd) : (prod.minimum_sale_price && rate ? String(Number((Number(prod.minimum_sale_price)/rate).toFixed(2))) : '0'),
      compare_at_price: prod.compare_at_price != null ? String(prod.compare_at_price) : '',
      slug: prod.slug || '',
      video_url: prod.video_url || prod.seo_image_url || '',
      description: prod.description || '',
      currency: prod.currency || (prod.retail_price_usd && Number(prod.retail_price_usd) > 0 ? 'USD' : 'UZS')
    });
    setExistingMedia(prod.media || []);
    setVariants((prod.variants || []).map(v => ({ ...v, imageFiles: [] })));
    setComponents((prod.components || []).map(c => ({
      ...c,
      cost_price: c.cost_price != null ? String(c.cost_price) : (c.cost_price_uzs != null ? String(c.cost_price_uzs) : ''),
      cost_price_usd: c.cost_price_usd != null ? String(c.cost_price_usd) : '',
      retail_price: c.retail_price != null ? String(c.retail_price) : (c.retail_price_uzs != null ? String(c.retail_price_uzs) : ''),
      retail_price_usd: c.retail_price_usd != null ? String(c.retail_price_usd) : '',
      wholesale_price: c.wholesale_price != null ? String(c.wholesale_price) : (c.wholesale_price_uzs != null ? String(c.wholesale_price_uzs) : ''),
      wholesale_price_usd: c.wholesale_price_usd != null ? String(c.wholesale_price_usd) : '',
    })));
    setAttributes(Object.fromEntries((prod.attributes || []).map(x => [x.attribute_id, x.value])));
  };

  const applicable = useMemo(
    () => (attributeDefs || []).filter(a => !a.category_id || a.category_id === form.category_id),
    [attributeDefs, form.category_id]
  );

  const removeExistingMedia = async mediaId => {
    if (!window.confirm('Rasmni o‘chirasizmi?')) return;
    try {
      await deleteProductMedia(mediaId);
      setExistingMedia(prev => prev.filter(m => m.id !== mediaId));
      if (toast) toast('Rasm o‘chirildi');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const makePrimary = async mediaId => {
    if (!targetProductId) return;
    try {
      await setPrimaryProductMedia(targetProductId, mediaId);
      setExistingMedia(prev => prev.map(m => ({ ...m, is_primary: m.id === mediaId })));
      if (toast) toast('Asosiy rasm belgilandi');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const submit = async e => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Mahsulot nomini kiriting'); return; }
    setBusy(true); setError('');
    try {
      const client = getBrowserClient();
      const cleanName = form.name.trim();
      const slug = form.slug?.trim() || slugify(cleanName);
      const sku = form.sku.trim().toUpperCase() || ('TB-' + Date.now().toString(36).toUpperCase());

      let currentId = targetProductId;
      if (!currentId) {
        const { data: newProd, error: insErr } = await client.from('products').insert({
          name: cleanName,
          sku,
          barcode: form.barcode?.trim() || null,
          slug,
          category_id: form.category_id || null,
          brand_id: form.brand_id || null,
          cost_price: Number(form.cost_price) || 0,
          cost_price_usd: form.cost_price_usd !== '' && form.cost_price_usd != null && !isNaN(Number(form.cost_price_usd)) ? Number(form.cost_price_usd) : (rate && Number(form.cost_price) ? Number((Number(form.cost_price)/rate).toFixed(2)) : null),
          retail_price: Number(form.retail_price) || 0,
          retail_price_usd: form.retail_price_usd !== '' && form.retail_price_usd != null && !isNaN(Number(form.retail_price_usd)) ? Number(form.retail_price_usd) : (rate && Number(form.retail_price) ? Number((Number(form.retail_price)/rate).toFixed(2)) : null),
          wholesale_price: form.wholesale_price === '' ? null : Number(form.wholesale_price),
          wholesale_price_usd: form.wholesale_price_usd === '' ? null : (form.wholesale_price_usd != null && !isNaN(Number(form.wholesale_price_usd)) ? Number(form.wholesale_price_usd) : (rate && Number(form.wholesale_price) ? Number((Number(form.wholesale_price)/rate).toFixed(2)) : null)),
          promotion_price: form.promotion_price === '' ? null : Number(form.promotion_price),
          minimum_sale_price: Number(form.minimum_sale_price) || 0,
          minimum_sale_price_usd: form.minimum_sale_price_usd !== '' && form.minimum_sale_price_usd != null && !isNaN(Number(form.minimum_sale_price_usd)) ? Number(form.minimum_sale_price_usd) : (rate && Number(form.minimum_sale_price) ? Number((Number(form.minimum_sale_price)/rate).toFixed(2)) : null),
          compare_at_price: form.compare_at_price === '' ? null : Number(form.compare_at_price),
          description: form.description || null,
          video_url: form.video_url?.trim() || null,
          currency: form.currency || 'USD',
          status: 'active',
          is_published: false,
          track_individual_units: true,
          tax_rate: 0,
        }).select('id,name,sku').single();
        if (insErr) throw insErr;
        currentId = newProd.id;
      } else {
        const { error: updErr } = await client.from('products').update({
          name: cleanName,
          sku,
          barcode: form.barcode?.trim() || null,
          slug,
          category_id: form.category_id || null,
          brand_id: form.brand_id || null,
          cost_price: Number(form.cost_price) || 0,
          cost_price_usd: form.cost_price_usd !== '' && form.cost_price_usd != null && !isNaN(Number(form.cost_price_usd)) ? Number(form.cost_price_usd) : (rate && Number(form.cost_price) ? Number((Number(form.cost_price)/rate).toFixed(2)) : null),
          retail_price: Number(form.retail_price) || 0,
          retail_price_usd: form.retail_price_usd !== '' && form.retail_price_usd != null && !isNaN(Number(form.retail_price_usd)) ? Number(form.retail_price_usd) : (rate && Number(form.retail_price) ? Number((Number(form.retail_price)/rate).toFixed(2)) : null),
          wholesale_price: form.wholesale_price === '' ? null : Number(form.wholesale_price),
          wholesale_price_usd: form.wholesale_price_usd === '' ? null : (form.wholesale_price_usd != null && !isNaN(Number(form.wholesale_price_usd)) ? Number(form.wholesale_price_usd) : (rate && Number(form.wholesale_price) ? Number((Number(form.wholesale_price)/rate).toFixed(2)) : null)),
          promotion_price: form.promotion_price === '' ? null : Number(form.promotion_price),
          minimum_sale_price: Number(form.minimum_sale_price) || 0,
          minimum_sale_price_usd: form.minimum_sale_price_usd !== '' && form.minimum_sale_price_usd != null && !isNaN(Number(form.minimum_sale_price_usd)) ? Number(form.minimum_sale_price_usd) : (rate && Number(form.minimum_sale_price) ? Number((Number(form.minimum_sale_price)/rate).toFixed(2)) : null),
          currency: form.currency || 'USD',
          compare_at_price: form.compare_at_price === '' ? null : Number(form.compare_at_price),
          description: form.description || null,
          video_url: form.video_url?.trim() || null,
        }).eq('id', currentId);
        if (updErr) throw updErr;
      }

      const failed = [];
      for (const file of images) {
        try {
          await uploadProductMedia(currentId, file, cleanName);
        } catch (err) {
          failed.push(`${file.name}: ${err.message || 'Yuklanmadi'}`);
        }
      }

      const namedVariants = variants.filter(v => v.color_name?.trim());
      if (namedVariants.length) {
        const variantsPayload = namedVariants.map(v => ({
          id: v.id || null,
          color_name: v.color_name.trim(),
          color_hex: v.color_hex || null,
          cost_price: v.cost_price === '' || v.cost_price == null ? null : Number(v.cost_price),
          cost_price_usd: v.cost_price_usd === '' || v.cost_price_usd == null ? null : Number(v.cost_price_usd),
          retail_price: v.retail_price === '' || v.retail_price == null ? null : Number(v.retail_price),
          retail_price_usd: v.retail_price_usd === '' || v.retail_price_usd == null ? null : Number(v.retail_price_usd),
          wholesale_price: v.wholesale_price === '' || v.wholesale_price == null ? null : Number(v.wholesale_price),
          wholesale_price_usd: v.wholesale_price_usd === '' || v.wholesale_price_usd == null ? null : Number(v.wholesale_price_usd),
          promotion_price: v.promotion_price === '' || v.promotion_price == null ? null : Number(v.promotion_price),
          minimum_sale_price: v.minimum_sale_price === '' || v.minimum_sale_price == null ? null : Number(v.minimum_sale_price),
          is_active: v.is_active !== false,
        }));
        const savedVariants = await saveProductVariants(currentId, variantsPayload);
        for (let i = 0; i < savedVariants.length && i < namedVariants.length; i++) {
          for (const file of namedVariants[i].imageFiles || []) {
            try {
              await uploadProductMedia(currentId, file, cleanName, savedVariants[i].id);
            } catch (err) {
              failed.push(`${namedVariants[i].color_name}: ${err.message || 'Yuklanmadi'}`);
            }
          }
        }
      }

      const namedComponents = components.filter(c => c.name?.trim());
      if (namedComponents.length > 0 || (product?.components?.length > 0)) {
        // Yangi tanlangan qismlar rasmlarini R2 ga yuklash
        for (const c of namedComponents) {
          if (c.imageFile) {
            try {
              const uploaded = await uploadProductMedia(currentId, c.imageFile, `${cleanName} - ${c.name}`);
              c.image_url = uploaded?.publicUrl || uploaded?.url || c.image_url;
            } catch (imgErr) {
              failed.push(`${c.name} rasmi: ${imgErr.message || 'Yuklanmadi'}`);
            }
          }
        }

        const componentsPayload = namedComponents.map((c, idx) => ({
          id: c.id || null,
          name: c.name.trim(),
          color_name: c.color_name?.trim() || null,
          color_hex: c.color_hex || null,
          cost_price: (c.cost_price !== '' && c.cost_price != null) ? Number(c.cost_price) : ((c.cost_price_uzs !== '' && c.cost_price_uzs != null) ? Number(c.cost_price_uzs) : null),
          cost_price_usd: c.cost_price_usd === '' || c.cost_price_usd == null ? null : Number(c.cost_price_usd),
          retail_price: (c.retail_price !== '' && c.retail_price != null) ? Number(c.retail_price) : ((c.retail_price_uzs !== '' && c.retail_price_uzs != null) ? Number(c.retail_price_uzs) : null),
          retail_price_usd: c.retail_price_usd === '' || c.retail_price_usd == null ? null : Number(c.retail_price_usd),
          wholesale_price: (c.wholesale_price !== '' && c.wholesale_price != null) ? Number(c.wholesale_price) : ((c.wholesale_price_uzs !== '' && c.wholesale_price_uzs != null) ? Number(c.wholesale_price_uzs) : null),
          wholesale_price_usd: c.wholesale_price_usd === '' || c.wholesale_price_usd == null ? null : Number(c.wholesale_price_usd),
          is_default: Boolean(c.is_default),
          is_required: Boolean(c.is_required),
          can_buy_standalone: c.can_buy_standalone !== false,
          image_url: (c.image_url && !c.image_url.startsWith('blob:')) ? c.image_url : null,
          sort_order: idx,
          quantity: Math.max(1, Number(c.quantity) || 1),
          is_active: c.is_active !== false,
        }));
        try {
          await saveProductComponents(currentId, componentsPayload);
        } catch (compErr) {
          failed.push(`Tarkibiy qismlar: ${compErr.message || 'Saqlanmadi'}`);
        }
      }

      if (applicable.length > 0) {
        const attrs = applicable
          .filter(a => attributes[a.id] !== '' && attributes[a.id] != null)
          .map(a => ({ attribute_id: a.id, value: coerceAttribute(a, attributes[a.id]) }));
        if (attrs.length) {
          try {
            await saveCatalogProduct({ id: currentId, sku, name: cleanName, retail_price: Number(form.retail_price) || 0, category_id: form.category_id }, attrs);
          } catch {}
        }
      }

      if (failed.length) {
        if (toast) toast(`Mahsulot saqlandi, lekin ${failed.length} ta rasm yuklanmadi`);
      } else {
        if (toast) toast(targetProductId ? 'Mahsulot yangilandi' : 'Yangi mahsulot yaratildi');
      }

      if (saved) await saved();
      if (close) close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={close} wide title={targetProductId ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'}>
      {loadingDetails ? (
        <div className="employee-loading" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
          Mahsulot ma’lumotlari yuklanmoqda…
        </div>
      ) : (
        <form className="employee-form-grid" onSubmit={submit}>
          {error && <div className="employee-error wide">{error}</div>}
          <label className="wide">
            <span className="label">Mahsulot nomi *</span>
            <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required minLength="2" placeholder="Masalan: Samsung Galaxy S24 Ultra" />
          </label>
          <label>
            <span className="label">SKU (Unikal kod)</span>
            <input className="input" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} placeholder="Avtomatik (masalan: TB-10307)" />
          </label>
          <div>
            <span className="label">Kategoriya *</span>
            <SearchableCategoryPicker
              categories={categories}
              value={form.category_id}
              onChange={catId => setForm(f => ({ ...f, category_id: catId }))}
              required
            />
            <NewCategoryInline
              categories={categories}
              onCreated={cat => {
                setCategories(prev => [...prev, cat]);
                setForm(f => ({ ...f, category_id: cat.id }));
                saveStoredRecent(RECENT_CATS_KEY, cat.id);
              }}
            />
          </div>
          <div>
            <span className="label">Brend</span>
            <div style={{ display: 'flex', gap: 6, position: 'relative', alignItems: 'flex-start' }}>
              <SearchableBrandPicker
                brands={brands}
                value={form.brand_id}
                onChange={bId => setForm(f => ({ ...f, brand_id: bId }))}
              />
              <NewBrandInline
                brands={brands}
                onCreated={b => {
                  setBrands(prev => [...prev, b]);
                  setForm(f => ({ ...f, brand_id: b.id }));
                  saveStoredRecent(RECENT_BRANDS_KEY, b.id);
                }}
              />
            </div>
          </div>

          <DualPriceInput label="Tannarx" valueUzs={form.cost_price} onChangeUzs={v => setForm(f => ({ ...f, cost_price: v }))} valueUsd={form.cost_price_usd} onChangeUsd={v => setForm(f => ({ ...f, cost_price_usd: v }))} rate={rate} currency={form.currency} onCurrencyChange={c => setForm(f => ({ ...f, currency: c }))} />
          <DualPriceInput label="Sotish narxi" valueUzs={form.retail_price} onChangeUzs={v => setForm(f => ({ ...f, retail_price: v }))} valueUsd={form.retail_price_usd} onChangeUsd={v => setForm(f => ({ ...f, retail_price_usd: v }))} rate={rate} currency={form.currency} onCurrencyChange={c => setForm(f => ({ ...f, currency: c }))} />
          <DualPriceInput label="Ulgurji narx" valueUzs={form.wholesale_price} onChangeUzs={v => setForm(f => ({ ...f, wholesale_price: v }))} valueUsd={form.wholesale_price_usd} onChangeUsd={v => setForm(f => ({ ...f, wholesale_price_usd: v }))} rate={rate} currency={form.currency} onCurrencyChange={c => setForm(f => ({ ...f, currency: c }))} />
          <DualPriceInput label="Minimal sotuv narxi" valueUzs={form.minimum_sale_price} onChangeUzs={v => setForm(f => ({ ...f, minimum_sale_price: v }))} valueUsd={form.minimum_sale_price_usd} onChangeUsd={v => setForm(f => ({ ...f, minimum_sale_price_usd: v }))} rate={rate} currency={form.currency} onCurrencyChange={c => setForm(f => ({ ...f, currency: c }))} />

          <label>
            <span className="label">Aksiya narxi</span>
            <input className="input" type="number" min="0" value={form.promotion_price} onChange={e => setForm({ ...form, promotion_price: e.target.value })} placeholder="0" />
          </label>
          <label>
            <span className="label">Eski narx (chizilgan narx)</span>
            <input className="input" type="number" min="0" value={form.compare_at_price} onChange={e => setForm({ ...form, compare_at_price: e.target.value })} placeholder="0" />
          </label>
          <label>
            <span className="label">Shtrix-kod</span>
            <input className="input" value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })} placeholder="Shtrix-kod yoki skanerlang" />
          </label>
          <label className="wide">
            <span className="label">Slug (sayt uchun havola)</span>
            <input className="input" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} placeholder="Nomdan avtomatik yaratiladi" />
          </label>
          <label className="wide">
            <span className="label">YouTube video URL</span>
            <input className="input" value={form.video_url} onChange={e => setForm({ ...form, video_url: e.target.value })} placeholder="https://youtube.com/watch?v=..." />
          </label>

          <div className="wide">
            <span className="label">Tavsif</span>
            {CustomRichEditor ? (
              <CustomRichEditor value={form.description} onChange={v => setForm({ ...form, description: v })} />
            ) : (
              <textarea
                className="input"
                style={{ width: '100%', minHeight: 120, resize: 'vertical' }}
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Mahsulot haqida batafsil ma'lumot..."
              />
            )}
          </div>

          <div className="wide">
            <span className="label">Rasmlar ({images.length + (existingMedia?.length || 0)} ta)</span>
            {existingMedia && existingMedia.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <small style={{ display: 'block', marginBottom: 6, color: 'var(--muted)' }}>Mavjud yuklangan rasmlar:</small>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {existingMedia.map(m => (
                    <div key={m.id} style={{ width: 70, height: 70, borderRadius: 8, overflow: 'hidden', position: 'relative', border: m.is_primary ? '2px solid var(--orange)' : '1px solid var(--line)' }}>
                      <img src={m.public_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      {m.is_primary ? (
                        <span style={{ position: 'absolute', bottom: 2, left: 2, background: 'var(--orange)', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 4, fontWeight: 700 }}>Asosiy</span>
                      ) : (
                        <button type="button" title="Asosiy qilish" style={{ position: 'absolute', bottom: 2, left: 2, background: 'rgba(0,0,0,.6)', color: '#fdba74', fontSize: 10, border: 0, borderRadius: 4, padding: '1px 4px', cursor: 'pointer' }} onClick={() => makePrimary(m.id)}>★ Asosiy</button>
                      )}
                      <button type="button" title="O‘chirish" style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, border: 0, borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 10, cursor: 'pointer' }} onClick={() => removeExistingMedia(m.id)}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {images.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {images.map((file, i) => (
                  <div key={i} style={{ width: 70, height: 70, borderRadius: 8, overflow: 'hidden', position: 'relative', border: '1px solid var(--line)' }}>
                    <img src={URL.createObjectURL(file)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    {i === 0 && (!existingMedia || !existingMedia.length) && (
                      <span style={{ position: 'absolute', bottom: 2, left: 2, background: 'var(--orange)', color: '#fff', fontSize: 9, padding: '1px 4px', borderRadius: 4, fontWeight: 700 }}>Asosiy</span>
                    )}
                    <button type="button" style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, border: 0, borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 10, cursor: 'pointer' }} onClick={() => setImages(imgs => imgs.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, width: 'fit-content' }}>
              <Upload size={14} /> Rasm qo‘shish
              <input type="file" accept="image/*" multiple hidden onChange={e => {
                const files = [...e.target.files];
                const invalid = files.find(file => file.size > 10 * 1024 * 1024 || !file.type.startsWith('image/'));
                if (invalid) setError(`${invalid.name}: faqat rasm fayli, maksimal 10 MB.`);
                else if (files.length) { setError(''); setImages(prev => [...prev, ...files]); }
                e.target.value = '';
              }} />
            </label>
          </div>

          <div className="wide">
            <ColorVariantEditor
              variants={variants}
              setVariants={setVariants}
              showQuantity={false}
              showWholesale
              showCost
              rate={rate}
              basePriceHint={form.retail_price ? `${form.retail_price} so'm` : ''}
              baseCostHint={form.cost_price ? `${form.cost_price} so'm` : ''}
            />
          </div>

          <div className="wide">
            <ProductComponentEditor
              components={components}
              onChange={setComponents}
              rate={rate}
            />
          </div>

          {applicable.length > 0 && <AttributeFields definitions={applicable} values={attributes} setValues={setAttributes} />}

          <button className="btn btn-primary wide" disabled={busy} style={{ marginTop: 12 }}>
            {busy ? (targetProductId ? 'Saqlanmoqda…' : 'Yaratilmoqda…') : (targetProductId ? 'O‘zgarishlarni saqlash' : 'Mahsulotni saqlash')}
          </button>
        </form>
      )}
    </Modal>
  );
}

export default ProductEditor;

