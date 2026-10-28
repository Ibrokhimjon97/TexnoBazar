import React, { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Layers,
  MapPin,
  MessageSquare,
  Package,
  Search,
  ShoppingCart,
  Star,
  Store,
  Tag,
  Warehouse,
  X,
  Play,
  Info
} from 'lucide-react';
import {
  DualPrice,
  Empty,
  Modal,
  Status,
  formatDualMoney,
  formatMoney,
  useExchangeRate
} from '@texnobazar/ui';
import {
  getBrowserClient,
  getProductStockDistribution,
  listInventoryBalances,
  loadProductReviews
} from '@texnobazar/data';
import CustomerTabsBar from './CustomerTabsBar';

const STOREFRONT_URL = (import.meta.env?.VITE_STOREFRONT_URL || 'https://texnobazar-storefront.netlify.app').replace(/\/$/, '');

export default function ProductCatalogWorkspace({ branchId, onAddToCart, toast, customerTabsProps }) {
  const rate = useExchangeRate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [availability, setAvailability] = useState('all'); // all | available
  const [categories, setCategories] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasFuzzyOnly, setHasFuzzyOnly] = useState(false);
  const [suggestedName, setSuggestedName] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Selected product modal
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Load categories
  useEffect(() => {
    let active = true;
    getBrowserClient()
      .from('categories')
      .select('id, name, parent_id')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .then(({ data }) => {
        if (active && data) setCategories(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Load products list
  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const res = await listInventoryBalances({
        branchId,
        query: debounced || null,
        categoryId: category || null,
        availability: availability === 'available' ? 'in_stock' : null,
        page,
        pageSize
      });
      setRows(res?.items || []);
      setTotal(Number(res?.total || 0));
      setHasFuzzyOnly(Boolean(res?.has_fuzzy_only));
      setSuggestedName(res?.suggested_name || '');
    } catch (e) {
      setError(String(e?.message || 'Tovarlarni yuklab bo‘lmadi.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId, debounced, category, availability, page, pageSize]);

  return (
    <div className="seller-catalog">
      {/* Top Search & Filter Bar */}
      <div className="seller-catalog-header card">
        <div className="seller-catalog-title">
          <div>
            <h2>Tovarlar katalogi</h2>
            <small>Jami {total} ta mahsulot ro‘yxati</small>
          </div>
          <div className="seller-catalog-chips">
            <button
              type="button"
              className={`chip ${availability === 'all' ? 'active' : ''}`}
              onClick={() => { setAvailability('all'); setPage(1); }}
            >
              Barchasi
            </button>
            <button
              type="button"
              className={`chip ${availability === 'available' ? 'active' : ''}`}
              onClick={() => { setAvailability('available'); setPage(1); }}
            >
              Faqat sotuvda borlar
            </button>
          </div>
        </div>

        {/* Multi-Customer Tabs Bar */}
        {customerTabsProps && (
          <div style={{ marginTop: 10, marginBottom: 8 }}>
            <CustomerTabsBar
              tabs={customerTabsProps.tabs}
              activeTabId={customerTabsProps.activeTabId}
              onSelectTab={customerTabsProps.onSelectTab}
              onAddTab={customerTabsProps.onAddTab}
              onCloseTab={customerTabsProps.onCloseTab}
              compact
            />
            <div className="pos-active-customer-indicator" style={{ marginBottom: 4 }}>
              <span>Hozirgi savdo tabi:</span>
              <b>👤 {customerTabsProps.activeTab?.customer?.full_name?.trim() || customerTabsProps.activeTab?.label || 'Mijoz'}</b>
              <span className="count-pill">{customerTabsProps.activeTab?.cart?.length || 0} ta tovar</span>
            </div>
          </div>
        )}

        {/* Search input */}
        <div className="seller-catalog-search">
          <Search size={18} />
          <input
            type="text"
            className="input"
            placeholder="Tovar nomi, artikul (SKU) yoki kod bo‘yicha qidirish…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="clear-btn" onClick={() => setQuery('')}>
              <X size={16} />
            </button>
          )}
        </div>

        {/* Categories Bar */}
        {categories.length > 0 && (
          <div className="seller-categories-bar">
            <button
              type="button"
              className={`cat-pill ${!category ? 'active' : ''}`}
              onClick={() => { setCategory(''); setPage(1); }}
            >
              Barcha kategoriyalar
            </button>
            {categories.map(cat => (
              <button
                type="button"
                key={cat.id}
                className={`cat-pill ${category === cat.id ? 'active' : ''}`}
                onClick={() => { setCategory(cat.id); setPage(1); }}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Products Grid */}
      {loading ? (
        <div className="pos-real-state">
          <p>Tovarlar yuklanmoqda…</p>
        </div>
      ) : error ? (
        <div className="pos-real-state error">
          <p>{error}</p>
          <button type="button" className="btn" onClick={load}>Qayta urinish</button>
        </div>
      ) : rows.length === 0 ? (
        <Empty
          title="Tovar topilmadi"
          text={debounced ? `«${debounced}» bo‘yicha hech qanday tovar yoki yaqin o‘xshashlik topilmadi.` : 'Qidiruv so‘rovi yoki kategoriyani o‘zgartirib ko‘ring.'}
        />
      ) : (
        <>
          {debounced && hasFuzzyOnly && (
            <div
              style={{
                background: 'linear-gradient(135deg, #fffbeb, #fef3c7)',
                border: '1.5px solid #fde68a',
                borderRadius: 12,
                padding: '12px 16px',
                marginBottom: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 22 }}>💡</span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#92400e' }}>
                    «{debounced}» bo‘yicha to‘liq mos tovar topilmadi
                  </div>
                  <div style={{ fontSize: 12, color: '#78350f', marginTop: 2 }}>
                    Tizim qidiruvingizga eng yaqin tovarlarni aniqladi. Balki quyidagilarni izlayotgandirsiz:
                  </div>
                </div>
              </div>
              {suggestedName && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setQuery(suggestedName)}
                  style={{
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: 700,
                    background: '#ffffff',
                    border: '1px solid #d97706',
                    color: '#b45309',
                    cursor: 'pointer',
                    padding: '5px 14px'
                  }}
                  title="Ushbu tovar nomi bilan aniq qidirish"
                >
                  🔍 {suggestedName}
                </button>
              )}
            </div>
          )}

          <div className="seller-products-grid">
            {rows.map(item => {
              const hasStock = Number(item.available || 0) > 0;
              return (
                <div
                  key={`${item.product_id}-${item.location_id}`}
                  className="seller-product-card card"
                  onClick={() => setSelectedProduct(item)}
                >
                  <div className="product-card-thumb">
                    {item.image ? (
                      <img src={item.image} alt={item.product_name} loading="lazy" />
                    ) : (
                      <div className="product-thumb-placeholder">
                        <Boxes size={32} />
                      </div>
                    )}
                    <span className={`stock-badge ${hasStock ? 'in-stock' : 'out-of-stock'}`}>
                      {hasStock ? `${Number(item.available)} dona mavjud` : 'Qolmagan'}
                    </span>
                    {item.is_fuzzy && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 8,
                          left: 8,
                          background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: 6,
                          boxShadow: '0 2px 6px rgba(217, 119, 6, 0.3)',
                          zIndex: 2,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3
                        }}
                      >
                        ✨ Yaqin moslik
                      </span>
                    )}
                  </div>

                  <div className="product-card-body">
                    <div className="product-card-sku">
                      SKU: {item.sku || '—'}
                      {item.is_fuzzy && item.match_similarity != null && (
                        <span style={{ marginLeft: 6, color: '#d97706', fontSize: 10.5, fontWeight: 700 }}>
                          ({Math.round(item.match_similarity * 100)}% o‘xshash)
                        </span>
                      )}
                    </div>
                    <h4 className="product-card-name">{item.product_name}</h4>

                  <div className="product-card-prices">
                    <span className="price-label">Sotish narxi:</span>
                    <DualPrice
                      value={Number(item.retail_price || 0)}
                      usdValue={item.retail_price_usd != null ? Number(item.retail_price_usd) : undefined}
                      rate={rate}
                    />
                  </div>

                  <div className="product-card-location">
                    <Store size={13} />
                    <span>{item.branch_name} ({item.location_name})</span>
                  </div>
                </div>

                <div className="product-card-footer">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedProduct(item);
                    }}
                  >
                    Batafsil ma’lumot
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* Pagination */}
      {total > pageSize && (
        <div className="seller-catalog-pagination">
          <span>
            {total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} / ${total} ta` : '0 ta'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              ‹ Oldingi
            </button>
            <button
              type="button"
              className="btn btn-sm active"
              style={{ fontWeight: 700 }}
            >
              {page} / {Math.ceil(total / pageSize)}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= Math.ceil(total / pageSize)}
              onClick={() => setPage(p => p + 1)}
            >
              Keyingi ›
            </button>
          </div>
        </div>
      )}

      {/* Product Detail Modal */}
      {selectedProduct && (
        <ProductDetailModal
          productSummary={selectedProduct}
          branchId={branchId}
          rate={rate}
          onAddToCart={onAddToCart}
          toast={toast}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

function ProductDetailModal({ productSummary, branchId, rate, onAddToCart, toast, onClose }) {
  const productId = productSummary?.product_id;
  const [detail, setDetail] = useState(null);
  const [media, setMedia] = useState([]);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [stockLocations, setStockLocations] = useState([]);
  const [availableUnits, setAvailableUnits] = useState([]);
  const [reviewsData, setReviewsData] = useState({ items: [], total: 0, average_rating: 0 });
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState('info'); // info | stock | reviews

  useEffect(() => {
    let active = true;
    const fetchFullData = async () => {
      setLoading(true);
      try {
        const client = getBrowserClient();

        // 1. Fetch full product row with category & brand
        const { data: p } = await client
          .from('products')
          .select('*, categories(id, name), brands(id, name)')
          .eq('id', productId)
          .single();

        // 2. Fetch media gallery
        const { data: m } = await client
          .from('product_media')
          .select('*')
          .eq('product_id', productId)
          .order('is_primary', { ascending: false })
          .order('sort_order', { ascending: true });

        // 3. Fetch stock distribution across all branches and locations
        const stock = await getProductStockDistribution(productId).catch(() => []);

        // 4. Fetch available units in the CURRENT seller's branch
        const { data: units } = await client
          .from('inventory_units')
          .select('id, qr_code, serial_number, status, location_id, locations!inner(id, name, type, branch_id)')
          .eq('product_id', productId)
          .eq('locations.branch_id', branchId)
          .eq('status', 'available')
          .order('created_at', { ascending: false })
          .limit(50);

        // 5. Fetch reviews
        const rev = await loadProductReviews(productId, { page: 1, pageSize: 20 }).catch(() => ({ items: [], total: 0 }));

        if (active) {
          setDetail(p || productSummary);
          setMedia(m || []);
          setStockLocations(stock || []);
          setAvailableUnits(units || []);
          setReviewsData(rev || { items: [], total: 0, average_rating: 0 });
        }
      } catch (err) {
        console.error('Failed to load product detail:', err);
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchFullData();
    return () => {
      active = false;
    };
  }, [productId, branchId]);

  const p = detail || productSummary;
  const storefrontProductUrl = `${STOREFRONT_URL}/product/${p?.slug || p?.id}`;

  const copyStorefrontLink = () => {
    navigator.clipboard?.writeText(storefrontProductUrl);
    setCopied(true);
    toast?.('Sayt havolasi nusxalandi!');
    setTimeout(() => setCopied(false), 2500);
  };

  // Calculate totals across all branches
  const totalStockAll = stockLocations.reduce((acc, loc) => acc + Number(loc.available || 0), 0);
  const totalInCurrentBranch = stockLocations
    .filter(loc => loc.branch_id === branchId)
    .reduce((acc, loc) => acc + Number(loc.available || 0), 0);

  // Group stock locations by branch
  const groupedStock = useMemo(() => {
    const map = new Map();
    for (const loc of stockLocations) {
      const bId = loc.branch_id;
      if (!map.has(bId)) {
        map.set(bId, {
          branchId: bId,
          branchName: loc.branch_name,
          branchCode: loc.branch_code,
          isCurrent: bId === branchId,
          locations: []
        });
      }
      map.get(bId).locations.push(loc);
    }
    // Put current branch first
    return [...map.values()].sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));
  }, [stockLocations, branchId]);

  return (
    <Modal open={true} onClose={onClose} title={p?.name || 'Tovar ma’lumotlari'}>
      <div className="seller-product-detail-modal">
        {/* Navigation Tabs */}
        <div className="product-detail-tabs">
          <button
            type="button"
            className={`tab-btn ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
          >
            <Info size={15} /> Asosiy ma’lumot
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'stock' ? 'active' : ''}`}
            onClick={() => setActiveTab('stock')}
          >
            <Warehouse size={15} /> Filial va omborlar ({totalStockAll} dona)
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'reviews' ? 'active' : ''}`}
            onClick={() => setActiveTab('reviews')}
          >
            <MessageSquare size={15} /> Sharhlar ({reviewsData.total || 0})
          </button>
        </div>

        {loading ? (
          <div className="pos-real-state">
            <p>Ma’lumotlar yuklanmoqda…</p>
          </div>
        ) : (
          <div className="product-detail-content">
            {/* TAB 1: ASOSIY MA'LUMOT VA NARXLAR */}
            {activeTab === 'info' && (
              <div className="product-info-tab">
                {/* Image Gallery */}
                <div className="product-detail-gallery">
                  <div className="main-image-wrap">
                    {media.length > 0 ? (
                      <img
                        src={media[activeMediaIndex]?.public_url || media[0]?.public_url}
                        alt={p?.name}
                      />
                    ) : productSummary?.image ? (
                      <img src={productSummary.image} alt={p?.name} />
                    ) : (
                      <div className="no-image-box">
                        <Boxes size={48} />
                        <span>Rasm yuklanmagan</span>
                      </div>
                    )}
                  </div>
                  {media.length > 1 && (
                    <div className="gallery-thumbs">
                      {media.map((img, idx) => (
                        <button
                          key={img.id || idx}
                          type="button"
                          className={`thumb-btn ${idx === activeMediaIndex ? 'active' : ''}`}
                          onClick={() => setActiveMediaIndex(idx)}
                        >
                          <img src={img.public_url} alt="" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Saytdagi Havolasi (Storefront Link) */}
                <div className="storefront-link-box">
                  <div className="storefront-link-info">
                    <ExternalLink size={16} />
                    <div>
                      <b>Saytdagi havolasi:</b>
                      <a href={storefrontProductUrl} target="_blank" rel="noopener noreferrer">
                        {storefrontProductUrl}
                      </a>
                    </div>
                  </div>
                  <div className="storefront-link-actions">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={copyStorefrontLink}
                    >
                      {copied ? <Check size={14} color="#16a34a" /> : <Copy size={14} />}
                      {copied ? 'Nusxalandi' : 'Nusxalash'}
                    </button>
                    <a
                      href={storefrontProductUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-sm"
                    >
                      Saytda ko‘rish
                    </a>
                  </div>
                </div>

                {/* Narxlar bo'limi (All Prices) */}
                <div className="product-all-prices-card">
                  <h4 className="section-title">
                    <Tag size={16} /> Barcha narxlar
                  </h4>
                  <div className="prices-grid">
                    {/* Sotish narxi */}
                    <div className="price-item highlight">
                      <span className="price-name">Chakana / Sotish narxi</span>
                      <DualPrice
                        value={Number(p?.retail_price || 0)}
                        usdValue={p?.retail_price_usd != null ? Number(p?.retail_price_usd) : undefined}
                        rate={rate}
                      />
                      <small>Mijozga aytiladigan rasmiy narx</small>
                    </div>

                    {/* Minimal sotish narxi */}
                    <div className="price-item">
                      <span className="price-name">Minimal sotish narxi</span>
                      <DualPrice
                        value={Number(p?.minimum_sale_price || 0)}
                        usdValue={p?.minimum_sale_price_usd != null ? Number(p?.minimum_sale_price_usd) : undefined}
                        rate={rate}
                      />
                      <small>Sotuvchi tushishi mumkin bo‘lgan eng quyi chegara</small>
                    </div>

                    {/* Ulgurji narxi */}
                    <div className="price-item">
                      <span className="price-name">Ulgurji narx</span>
                      <DualPrice
                        value={Number(p?.wholesale_price || 0)}
                        usdValue={p?.wholesale_price_usd != null ? Number(p?.wholesale_price_usd) : undefined}
                        rate={rate}
                      />
                      <small>Ko‘p miqdorda oluvchilar uchun</small>
                    </div>

                    {/* Tannarxi */}
                    <div className="price-item cost">
                      <span className="price-name">Tannarxi (Kirim)</span>
                      <DualPrice
                        value={Number(p?.cost_price || 0)}
                        usdValue={p?.cost_price_usd != null ? Number(p?.cost_price_usd) : undefined}
                        rate={rate}
                      />
                      <small>Mahsulotning bazaviy tannarxi</small>
                    </div>

                    {/* Solishtirma narx / aksiya */}
                    {Number(p?.compare_at_price || 0) > 0 && (
                      <div className="price-item">
                        <span className="price-name">Eski / Chegirmadan oldingi narx</span>
                        <div style={{ textDecoration: 'line-through', color: '#94a3b8', fontWeight: 600 }}>
                          {formatMoney(Number(p.compare_at_price))}
                        </div>
                        <small>Saytda chizilgan holda ko‘rinadi</small>
                      </div>
                    )}
                  </div>
                </div>

                {/* Quick Stock Bar */}
                <div className="quick-stock-summary card">
                  <div>
                    <Store size={18} />
                    <span>Joriy filialda: <b>{totalInCurrentBranch} dona</b> mavjud</span>
                  </div>
                  <div>
                    <Warehouse size={18} />
                    <span>Barcha filial va omborlarda: <b>{totalStockAll} dona</b></span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => setActiveTab('stock')}
                  >
                    Barcha joylarni ko‘rish ›
                  </button>
                </div>

                {/* Savatga qo'shish imkoniyati (agar joriy filialda tovar bo'lsa) */}
                {availableUnits.length > 0 && onAddToCart && (
                  <div className="current-branch-add-card card">
                    <div className="between">
                      <div>
                        <b>Shu filialdagi birliklar ({availableUnits.length} ta)</b>
                        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
                          Sotuvga chiqarish uchun birlikni savatga qo‘shing:
                        </p>
                      </div>
                    </div>
                    <div className="quick-units-list">
                      {availableUnits.slice(0, 10).map(u => (
                        <div key={u.id} className="quick-unit-item">
                          <span>
                            <b>{u.qr_code}</b>
                            {u.serial_number && <small>Seriya: {u.serial_number}</small>}
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              onAddToCart({
                                ...u,
                                product_id: p.id,
                                product_name: p.name,
                                sku: p.sku,
                                retail_price: p.retail_price,
                                retail_price_usd: p.retail_price_usd,
                                cost_price: p.cost_price,
                                cost_price_usd: p.cost_price_usd,
                                tax_rate: p.tax_rate
                              });
                            }}
                          >
                            <ShoppingCart size={13} /> Savatga
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Description & Specs */}
                <div className="product-description-card card">
                  <h4 className="section-title">
                    <Info size={16} /> Mahsulot tavsifi
                  </h4>
                  {p?.description ? (
                    <div
                      className="product-description-text"
                      dangerouslySetInnerHTML={{ __html: p.description }}
                    />
                  ) : (
                    <p style={{ color: 'var(--muted)', fontSize: 13 }}>Tavsif kiritilmagan.</p>
                  )}

                  {p?.video_url && (
                    <div className="product-video-link">
                      <Play size={16} color="#ef4444" />
                      <a href={p.video_url} target="_blank" rel="noopener noreferrer">
                        Mahsulot videosini tomosha qilish
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: FILIAL VA OMBORLARDAGI QOLDIQLAR */}
            {activeTab === 'stock' && (
              <div className="product-stock-tab">
                <div className="stock-tab-header card">
                  <div>
                    <h3>Qaysi do‘konda nechta bor?</h3>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                      Mijoz so‘raganda barcha filiallar va omborlardagi tovar sonini shu yerdan tekshiring.
                    </p>
                  </div>
                  <div className="stock-total-badge">
                    <span>Jami:</span>
                    <b>{totalStockAll} dona</b>
                  </div>
                </div>

                {groupedStock.length === 0 ? (
                  <Empty
                    title="Qoldiq mavjud emas"
                    text="Ushbu mahsulot hozirda hech bir filial yoki omborda mavjud emas."
                  />
                ) : (
                  <div className="branch-stock-list">
                    {groupedStock.map(b => (
                      <div
                        key={b.branchId}
                        className={`branch-stock-card card ${b.isCurrent ? 'current-branch' : ''}`}
                      >
                        <div className="branch-card-header">
                          <div>
                            <span className="branch-name">
                              <Store size={16} /> {b.branchName}
                            </span>
                            {b.isCurrent && (
                              <Status type="green">Sizning filialingiz</Status>
                            )}
                          </div>
                          <b>
                            {b.locations.reduce((s, l) => s + Number(l.available || 0), 0)} dona
                          </b>
                        </div>

                        <div className="locations-subtable">
                          {b.locations.map(loc => (
                            <div key={loc.location_id} className="loc-row">
                              <div className="loc-info">
                                {loc.location_type === 'store' ? (
                                  <Store size={14} color="#0284c7" />
                                ) : (
                                  <Warehouse size={14} color="#ea580c" />
                                )}
                                <span>{loc.location_name}</span>
                                <small className="loc-type-tag">
                                  {loc.location_type === 'store' ? "Do'kon zali" : 'Ombor'}
                                </small>
                              </div>

                              <div className="loc-counts">
                                <span className="avail">
                                  <b>{Number(loc.available)}</b> dona sotuvga tayyor
                                </span>
                                {Number(loc.reserved) > 0 && (
                                  <span className="reserved">
                                    ({Number(loc.reserved)} ta band)
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: SHARHLAR VA IZOHLAR */}
            {activeTab === 'reviews' && (
              <div className="product-reviews-tab">
                <div className="reviews-header card">
                  <div className="rating-summary">
                    <div className="rating-num">
                      {reviewsData.average_rating ? Number(reviewsData.average_rating).toFixed(1) : '0.0'}
                    </div>
                    <div className="rating-stars">
                      <div style={{ display: 'flex', gap: 2 }}>
                        {[1, 2, 3, 4, 5].map(star => (
                          <Star
                            key={star}
                            size={18}
                            fill={star <= Math.round(reviewsData.average_rating || 0) ? '#f59e0b' : 'none'}
                            color={star <= Math.round(reviewsData.average_rating || 0) ? '#f59e0b' : '#cbd5e1'}
                          />
                        ))}
                      </div>
                      <small>Jami {reviewsData.total || 0} ta sharh</small>
                    </div>
                  </div>
                </div>

                {reviewsData.items.length === 0 ? (
                  <Empty
                    title="Sharhlar yo‘q"
                    text="Ushbu mahsulotga hali mijozlar tomonidan sharh yoki baho qoldirilmagan."
                  />
                ) : (
                  <div className="reviews-list">
                    {reviewsData.items.map(rev => (
                      <div key={rev.id} className="review-card card">
                        <div className="review-top">
                          <b>{rev.reviewer_name || 'Xaridor'}</b>
                          <div style={{ display: 'flex', gap: 2 }}>
                            {[1, 2, 3, 4, 5].map(star => (
                              <Star
                                key={star}
                                size={14}
                                fill={star <= Number(rev.rating) ? '#f59e0b' : 'none'}
                                color={star <= Number(rev.rating) ? '#f59e0b' : '#cbd5e1'}
                              />
                            ))}
                          </div>
                        </div>
                        {rev.body && <p className="review-body">{rev.body}</p>}
                        <time className="review-date">
                          {new Date(rev.created_at).toLocaleDateString('uz-UZ')}
                        </time>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
