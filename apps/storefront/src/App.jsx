import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, BadgePercent, Check, ChevronLeft, ChevronRight, CreditCard, Grid2X2, Heart,
  Home as HomeIcon, LoaderCircle, MapPin, Menu, Minus, PackageCheck, Phone, Plus,
  QrCode, Search, Send, ShieldCheck, ShoppingCart, SlidersHorizontal, Sparkles, Star, Trash2, Truck,
  User, X,
} from 'lucide-react';
import FloatingCartButton from './FloatingCartButton.jsx';
import { Empty, Status, ThemeToggle, Toast } from '@texnobazar/ui';
import {
  formatUzDate,
  createCheckoutToken, getBrowserClient, getOnlinePaymentStatus, getStorefrontSession, initiateOnlinePayment, listNotifications, loadCustomerAccount, loadCustomerOrders,
  loadStorefrontCatalog, loadStorefrontCms, loadStorefrontPaymentMethods, loadStorefrontProduct, loadStorefrontProducts, loadStorefrontReferences, loadProductReviews, markNotificationsRead, removeCustomerAddress, saveCustomerAddress,
  saveCustomerProfile, setCustomerCartItem, setCustomerFavorite, signInCustomer,
  signOutCustomer, signUpCustomer, submitOnlineOrder, submitProductReview, subscribeCms, subscribeNotifications,
} from '@texnobazar/data';

const ANON_CART_KEY = 'texnobazar.storefront.cart.v1';
const ANON_FAV_KEY = 'texnobazar.storefront.favorites.v1';
const PAGE_SIZE = 12;
const emptyCms = { banners: [], home_blocks: [], menu_items: [], promotions: [], pages: [], settings: {} };
const money = value => `${new Intl.NumberFormat('uz-UZ').format(Number(value) || 0)} so‘m`;
const errorText = error => error?.message || 'Kutilmagan xatolik yuz berdi.';
const numberOf = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const safeArray = value => Array.isArray(value) ? value : [];
const flattenCategoryTree = roots => safeArray(roots).flatMap(root => [root, ...flattenCategoryTree(root?.children).map(child => ({ ...child, parent_id: child.parent_id || root.id }))]);
const getCategorySubtreeIds = (catId, categoriesList = []) => {
  if (!catId) return new Set();
  const set = new Set([String(catId)]);
  let added = true;
  while (added) {
    added = false;
    for (const c of categoriesList) {
      if (c.parent_id && set.has(String(c.parent_id)) && !set.has(String(c.id))) {
        set.add(String(c.id));
        added = true;
      }
    }
  }
  return set;
};
const orderedProducts = (ids, catalog, fallback = catalog) => {
  const byId = new Map(catalog.map(product => [product.id, product]));
  const selected = safeArray(ids).map(String).map(id => byId.get(id)).filter(Boolean);
  return selected.length || safeArray(ids).length ? selected : fallback;
};
const storageRead = (key, fallback) => {
  try { const parsed = JSON.parse(localStorage.getItem(key)); return parsed ?? fallback; } catch { return fallback; }
};
const storageWrite = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable. */ }
};
const createKey = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
// Savatcha kaliti: mahsulot + (ixtiyoriy) rang varianti + (ixtiyoriy) tarkibiy qismlar birgalikda noyob qatorni belgilaydi.
const cartKey = item => {
  if (item?.isStandaloneComponent && item?.componentId) {
    return `${item.id}::comp::${item.componentId}`;
  }
  const compKey = (item?.selectedComponents || []).map(c => c.id || c.name).sort().join(',');
  return `${item?.id}::${item?.variantId || ''}::${compKey}`;
};
const normalizePhone = value => String(value || '').replace(/[\s()-]/g, '');
const plainValue = value => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(plainValue).filter(Boolean).join(' · ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${plainValue(item)}`).join(' · ');
  return '';
};
const siteText = (settings, key, fallback = '') => plainValue(settings?.[key]).trim() || fallback;
const siteList = (settings, key, fallback = []) => {
  const raw = plainValue(settings?.[key]).trim();
  const piped = raw.split(/[|\n]+/).map(item => item.trim()).filter(Boolean);
  const items = piped.length > 1 ? piped : raw.split(',').map(item => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
};
const getYouTubeEmbedUrl = url => {
  if (!url) return null;
  const str = String(url).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/embed/${match[1]}`;
  }
  if (str.includes('youtube.com/embed/')) return str;
  return null;
};

const COLOR_HEX_MAP = {
  'qora': '#111827',
  'black': '#111827',
  'kulrang': '#64748b',
  'seriy': '#64748b',
  'gray': '#64748b',
  'grey': '#64748b',
  'oq': '#ffffff',
  'white': '#ffffff',
  'qizil': '#ef4444',
  'red': '#ef4444',
  'ko‘k': '#2563eb',
  "ko'k": '#2563eb',
  'kok': '#2563eb',
  'moviy': '#38bdf8',
  'havorang': '#38bdf8',
  'blue': '#2563eb',
  'yashil': '#10b981',
  'green': '#10b981',
  'sariq': '#f59e0b',
  'yellow': '#f59e0b',
  'tilla': '#d97706',
  'oltin': '#d97706',
  'gold': '#d97706',
  'jigarrang': '#78350f',
  'brown': '#78350f',
  'pushti': '#ec4899',
  'pink': '#ec4899',
  'siyohrang': '#8b5cf6',
  'binafsha': '#8b5cf6',
  'purple': '#8b5cf6',
  'zangori': '#06b6d4',
  'alyuminiy': '#94a3b8',
  'kumush': '#cbd5e1',
  'silver': '#cbd5e1',
  'standart': '#94a3b8',
  'standard': '#94a3b8'
};

const getColorHex = (name = '', currentHex = null) => {
  if (currentHex && typeof currentHex === 'string' && currentHex.startsWith('#') && currentHex.length >= 4) {
    return currentHex;
  }
  const clean = String(name || '').toLowerCase().trim();
  if (!clean) return '#94a3b8';
  for (const [key, val] of Object.entries(COLOR_HEX_MAP)) {
    if (clean.includes(key)) return val;
  }
  return '#94a3b8';
};

const isLightColor = (hex = '') => {
  if (!hex || typeof hex !== 'string') return false;
  const clean = hex.replace('#', '');
  if (clean.length !== 6 && clean.length !== 3) return false;
  const r = parseInt(clean.length === 3 ? clean[0] + clean[0] : clean.slice(0, 2), 16);
  const g = parseInt(clean.length === 3 ? clean[1] + clean[1] : clean.slice(2, 4), 16);
  const b = parseInt(clean.length === 3 ? clean[2] + clean[2] : clean.slice(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 180;
};

const adaptProduct = raw => {
  const primaryImg = raw.primary_media_url || raw.seo_image_url || raw.media?.[0]?.url || raw.image || '';
  const mediaList = safeArray(raw.media).length > 0
    ? safeArray(raw.media)
    : primaryImg
      ? [{ id: raw.id, url: primaryImg, alt: raw.name }]
      : [];

  const rawVariants = safeArray(raw.variants).map(v => ({
    id: String(v.id),
    colorName: String(v.color_name || v.colorName || ''),
    colorHex: getColorHex(v.color_name || v.colorName, v.color_hex || v.colorHex),
    price: numberOf(v.price),
    retailPrice: numberOf(v.retail_price || v.retailPrice || v.price),
    compareAtPrice: numberOf(v.compare_at_price || v.compareAtPrice),
    costPrice: numberOf(v.cost_price || v.costPrice),
    stock: Math.max(0, Math.trunc(numberOf(v.stock))),
    image: v.image || v.media?.[0]?.url || null,
    media: safeArray(v.media),
  }));

  // Fallback defense-in-depth: agar tovarning variantlari mavjud bo'lsa-yu, lekin 'standart' varianti ro'yxatda bo'lmasa
  // va mavjud zaxira variantlar yig'indisidan ortiq bo'lsa (ya'ni dastlabki variant_id=NULL bo'lgan qoldiq bor):
  let finalVariants = rawVariants;
  if (rawVariants.length > 0) {
    const hasStandart = rawVariants.some(v => v.id === 'standard' || ['standart', 'standard', 'baza', 'asosiy'].includes(v.colorName.toLowerCase().trim()));
    const variantsStockSum = rawVariants.reduce((sum, v) => sum + v.stock, 0);
    const totalAvail = Math.max(0, Math.trunc(numberOf(raw.available_stock)));
    if (!hasStandart && totalAvail > variantsStockSum) {
      const stdStock = totalAvail - variantsStockSum;
      finalVariants = [
        {
          id: 'standard',
          colorName: 'Standart',
          colorHex: '#94a3b8',
          price: numberOf(raw.promotion_price || raw.effective_price || raw.retail_price),
          retailPrice: numberOf(raw.retail_price),
          compareAtPrice: numberOf(raw.compare_at_price),
          costPrice: numberOf(raw.cost_price),
          stock: stdStock,
          image: primaryImg || null,
          media: mediaList,
        },
        ...rawVariants
      ];
    }
  }

  return {
    ...raw,
    id: String(raw.id),
    productId: String(raw.product_id || raw.productId || String(raw.id).split('_')[0]),
    batchId: raw.batch_id || raw.batchId || null,
    receiptNo: raw.receipt_no || raw.receiptNo || null,
    priceTiers: safeArray(raw.price_tiers || raw.priceTiers),
    name: String(raw.name || 'Nomsiz mahsulot'),
    slug: String(raw.slug || raw.id),
    description: String(raw.description || ''),
    descriptionBlocks: safeArray(raw.description_blocks),
    media: mediaList,
    hasDetail: Object.prototype.hasOwnProperty.call(raw, 'description_blocks') && Object.prototype.hasOwnProperty.call(raw, 'media'),
    sku: String(raw.sku || ''),
    image: primaryImg,
    seoTitle: String(raw.seo_title || ''),
    seoDescription: String(raw.seo_description || ''),
    seoImage: String(raw.seo_image_url || primaryImg),
    videoUrl: String(raw.video_url || ''),
    brandName: String(raw.brand_name || raw.brands?.name || raw.brand?.name || ''),
    price: numberOf(raw.promotion_price || raw.effective_price || raw.retail_price),
    oldPrice: numberOf(raw.compare_at_price || (raw.promotion_price ? raw.retail_price : 0)),
    stock: Math.max(0, Math.trunc(numberOf(raw.available_stock))),
    attributes: safeArray(raw.attributes).map(item => ({ code: String(item.code || item.name || ''), name: String(item.name || item.code || ''), value: plainValue(item.value) })),
    categoryId: raw.category_id ? String(raw.category_id) : '',
    brandId: raw.brand_id ? String(raw.brand_id) : '',
    avgRating: numberOf(raw.avg_rating),
    reviewCount: Math.max(0, Math.trunc(numberOf(raw.review_count))),
    variants: finalVariants,
    // Tarkibiy va qo'shimcha qismlar (Beshik taxtasi, sumak, yostiqcha va h.k.)
    components: safeArray(raw.components).map(c => ({
      id: String(c.id),
      name: String(c.name || ''),
      colorName: String(c.color_name || c.colorName || ''),
      colorHex: c.color_hex || c.colorHex || null,
      costPrice: numberOf(c.cost_price || c.costPrice),
      costPriceUsd: numberOf(c.cost_price_usd || c.costPriceUsd),
      price: numberOf(c.retail_price || c.price),
      retailPrice: numberOf(c.retail_price || c.price),
      retailPriceUsd: numberOf(c.retail_price_usd || c.retailPriceUsd),
      wholesalePrice: numberOf(c.wholesale_price || c.wholesalePrice),
      wholesalePriceUsd: numberOf(c.wholesale_price_usd || c.wholesalePriceUsd),
      isDefault: Boolean(c.is_default ?? c.isDefault),
      isRequired: Boolean(c.is_required ?? c.isRequired),
      canBuyStandalone: (c.can_buy_standalone ?? c.canBuyStandalone) !== false,
      imageUrl: c.image_url || c.imageUrl || null,
      quantity: Math.max(1, numberOf(c.quantity) || 1),
      sortOrder: numberOf(c.sort_order ?? c.sortOrder),
    })),
  };
};
const parseRoute = () => {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const searchParams = new URLSearchParams(window.location.search);
  const cardId = searchParams.get('id') || null;
  const variantParam = searchParams.get('variant') || searchParams.get('variant_id') || searchParams.get('color') || null;
  if (path.startsWith('/qr/')) return { view: 'qr', code: decodeURIComponent(path.slice(4)) };
  if (path.startsWith('/product/')) return { view: 'product', slug: decodeURIComponent(path.slice(9)), cardId, variantParam };
  if (path.startsWith('/category/')) return { view: 'category', slug: decodeURIComponent(path.slice(10)) };
  if (path.startsWith('/page/')) return { view: 'page', slug: decodeURIComponent(path.slice(6)) };
  if (path.startsWith('/block/')) return { view: 'block', blockId: decodeURIComponent(path.slice(7)) };
  if (['/catalog', '/cart', '/checkout', '/profile', '/favorites'].includes(path)) return { view: path.slice(1) };
  return { view: 'home' };
};
const routePath = (view, product) => {
  if (view === 'home') return '/';
  if (view === 'product') {
    const slug = encodeURIComponent(product?.slug || '');
    const params = new URLSearchParams();
    if (product?.id && String(product.id).includes('_')) params.set('id', product.id);
    if (product?.selectedVariantId) params.set('variant', product.selectedVariantId);
    const qs = params.toString();
    return qs ? `/product/${slug}?${qs}` : `/product/${slug}`;
  }
  return ['category','page'].includes(view) ? `/${view}/${encodeURIComponent(product?.slug || '')}` : view === 'block' ? `/block/${encodeURIComponent(product?.blockId || '')}` : `/${view}`;
};

export default function App() {
  const initialRoute = useRef(parseRoute());
  const [route, setRoute] = useState(initialRoute.current);
  const [catalog, setCatalog] = useState([]);
  const [catalogState, setCatalogState] = useState({ loading: true, error: '' });
  const [detailState, setDetailState] = useState({ loading: false, error: '' });
  const [cms, setCms] = useState(emptyCms);
  const [cmsState, setCmsState] = useState({ loading: true, error: '' });
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [account, setAccount] = useState(null);
  const [accountError, setAccountError] = useState('');
  const [references, setReferences] = useState({ categories: {}, brands: {}, categoryRoots: [], categoryDetails: [] });
  const [cart, setCart] = useState(() => safeArray(storageRead(ANON_CART_KEY, [])).map(item => ({ id: String(item.id), variantId: item.variantId ? String(item.variantId) : null, qty: Math.max(1, Math.trunc(numberOf(item.qty))) })));
  const [favorites, setFavorites] = useState(() => safeArray(storageRead(ANON_FAV_KEY, [])).map(String));
  const anonymousCart = useRef(cart);
  const anonymousFavorites = useRef(favorites);
  const previousUserId = useRef(undefined);
  const activeUserId = useRef(null);
  const mergedAccountUserId = useRef(null);
  const accountOwnerId = useRef(null);
  const attemptedProductHydration = useRef(new Set());
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [toast, setToast] = useState('');

  const mergeCatalogProducts = useCallback(items => {
    const adapted = safeArray(items).map(item => item?.descriptionBlocks ? item : adaptProduct(item));
    if (!adapted.length) return;
    setCatalog(current => {
      const merged = new Map(current.map(product => [product.id, product]));
      adapted.forEach(product => {
        const existing = merged.get(product.id);
        if (existing?.hasDetail && !product.hasDetail) {
          merged.set(product.id, {
            ...product,
            ...existing,
            stock: product.stock ?? existing.stock,
            price: product.price ?? existing.price,
            oldPrice: product.oldPrice ?? existing.oldPrice,
            components: (existing.components && existing.components.length > 0) ? existing.components : (product.components || []),
            variants: (existing.variants && existing.variants.length > 0) ? existing.variants : (product.variants || []),
            priceTiers: (existing.priceTiers && existing.priceTiers.length > 0) ? existing.priceTiers : (product.priceTiers || []),
            descriptionBlocks: existing.descriptionBlocks || product.descriptionBlocks,
            media: (existing.media && existing.media.length > 0) ? existing.media : product.media,
            hasDetail: true,
            seoTitle: existing.seoTitle || product.seoTitle,
            seoDescription: existing.seoDescription || product.seoDescription,
            seoImage: existing.seoImage || product.seoImage,
          });
          return;
        }
        merged.set(product.id, product);
      });
      return [...merged.values()];
    });
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogState({ loading: true, error: '' });
    try {
      const first = await loadStorefrontCatalog({ page: 1, pageSize: 100, sort: 'name' });
      const items = [...safeArray(first?.items)];
      const total = numberOf(first?.total);
      const pageSize = items.length || 100;
      if (total > items.length && pageSize > 0) {
        const totalPages = Math.ceil(total / pageSize);
        for (let p = 2; p <= totalPages; p += 3) {
          const batch = [];
          for (let b = p; b < Math.min(p + 3, totalPages + 1); b++) {
            batch.push(loadStorefrontCatalog({ page: b, pageSize, sort: 'name' }));
          }
          const settled = await Promise.allSettled(batch);
          settled.forEach(res => {
            if (res.status === 'fulfilled') {
              items.push(...safeArray(res.value?.items));
            }
          });
        }
      }
      mergeCatalogProducts(items);
      setCatalogState({ loading: false, error: '' });
    } catch (error) {
      setCatalogState({ loading: false, error: errorText(error) });
    }
  }, [mergeCatalogProducts]);

  const loadCms = useCallback(async () => {
    setCmsState(current => ({ ...current, loading: true, error: '' }));
    try {
      const payload = await loadStorefrontCms();
      setCms({ ...emptyCms, ...(payload || {}) });
      setCmsState({ loading: false, error: '' });
    } catch (error) {
      setCmsState({ loading: false, error: errorText(error) });
    }
  }, []);

  const loadReferences = useCallback(async () => {
    const payload = await loadStorefrontReferences();
    const categoryRoots=safeArray(payload?.categories),categories=flattenCategoryTree(categoryRoots),brands=safeArray(payload?.brands);
    setReferences({
      categories: Object.fromEntries(categories.map(item => [String(item.id), plainValue(item.name)])),
      categoryRoots,
      categoryDetails: categories,
      brands: Object.fromEntries(brands.map(item => [String(item.id), plainValue(item.name)])),
    });
  }, []);

  const refreshAccount = useCallback(async () => {
    const requestedUserId = session?.user?.id;
    if (!requestedUserId) { accountOwnerId.current = null; setAccount(null); return null; }
    setAccountError('');
    try {
      const next = await loadCustomerAccount();
      if (activeUserId.current !== requestedUserId) return null;
      accountOwnerId.current = requestedUserId;
      setAccount(next);
      return next;
    } catch (error) {
      if (activeUserId.current === requestedUserId) setAccountError(errorText(error));
      return null;
    }
  }, [session]);

  useEffect(() => { loadCatalog(); loadCms(); loadReferences().catch(() => {}); }, [loadCatalog, loadCms, loadReferences]);
  useEffect(() => {
    let active = true;
    let authEvents = 0;
    getStorefrontSession().then(value => { if (active && authEvents === 0) { activeUserId.current = value?.user?.id || null; setSession(value); } }).catch(error => setToast(errorText(error))).finally(() => { if (active) setAuthReady(true); });
    const { data } = getBrowserClient().auth.onAuthStateChange((_event, nextSession) => { if (active) { authEvents += 1; activeUserId.current = nextSession?.user?.id || null; setSession(nextSession); setAuthReady(true); } });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    let timer;
    const cleanup = subscribeCms(payload => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadCms();
        if (payload?.table === 'products') loadCatalog();
      }, 250);
    }, error => setToast(errorText(error)));
    return () => { clearTimeout(timer); cleanup(); };
  }, [loadCatalog, loadCms]);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!window.location.hash) return;
    let attempts = 0, timer;
    const scrollToAnchor = () => {
      const rawId = window.location.hash.slice(1);
      let id = rawId;
      try { id = decodeURIComponent(rawId); } catch { /* Use raw malformed hash without crashing navigation. */ }
      const target = document.getElementById(id);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.focus?.({ preventScroll: true }); return; }
      if (attempts++ < 8) timer = setTimeout(scrollToAnchor, 80);
    };
    timer = setTimeout(scrollToAnchor, 0);
    return () => clearTimeout(timer);
  }, [route, cms.home_blocks]);
  useEffect(() => { if (session) refreshAccount(); else { accountOwnerId.current = null; setAccount(null); } }, [session, refreshAccount]);

  const productsById = useMemo(() => new Map(catalog.map(product => [product.id, product])), [catalog]);

  useEffect(() => {
    const nextUserId = session?.user?.id || null;
    const priorUserId = previousUserId.current;
    if (priorUserId && priorUserId !== nextUserId) {
      mergedAccountUserId.current = null;
      accountOwnerId.current = null;
      setAccount(null);
      setCart(anonymousCart.current.map(item => {
        const product = productsById.get(item.id);
        const variant = product && item.variantId ? product.variants?.find(v => v.id === item.variantId) : null;
        const limit = variant ? variant.stock : product ? product.stock : 100;
        return { id: item.id, variantId: item.variantId || null, qty: product ? Math.min(item.qty, limit, 100) : Math.min(item.qty, 100) };
      }).filter(item => item.qty > 0));
      setFavorites(anonymousFavorites.current);
    }
    previousUserId.current = nextUserId;
  }, [session?.user?.id, productsById]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId || !account || accountOwnerId.current !== userId || !activeUserId.current || activeUserId.current !== userId || catalogState.loading || catalogState.error || mergedAccountUserId.current?.userId === userId) return;
    let cancelled = false;
    const marker = { userId, pending: true };
    mergedAccountUserId.current = marker;
    const remoteCart = new Map(safeArray(account.cart).map(item => {
      const entry = { id: String(item.product_id), variantId: item.variant_id ? String(item.variant_id) : null, qty: Math.max(1, Math.trunc(numberOf(item.quantity))) };
      return [cartKey(entry), entry];
    }));
    const requestedCart = new Map(remoteCart);
    cart.forEach(item => {
      const key = cartKey(item);
      const existing = requestedCart.get(key);
      requestedCart.set(key, { ...item, qty: Math.max(item.qty, existing?.qty || 0) });
    });
    const mergedCart = new Map();
    requestedCart.forEach(entry => {
      const product = productsById.get(entry.id);
      const variant = product && entry.variantId ? product.variants?.find(v => v.id === entry.variantId) : null;
      const limit = variant ? variant.stock : product ? product.stock : 100;
      const safeQuantity = product ? Math.min(entry.qty, limit, 100) : Math.min(entry.qty, 100);
      if (safeQuantity > 0) mergedCart.set(cartKey(entry), { ...entry, qty: safeQuantity });
    });
    const mergedFavorites = [...new Set([...safeArray(account.favorites).map(String), ...favorites])];
    const sync = async () => {
      if (activeUserId.current !== userId || accountOwnerId.current !== userId) return;
      const results = await Promise.allSettled([
        ...[...mergedCart.values()].map(entry => setCustomerCartItem(entry.id, entry.qty, entry.variantId || null)),
        ...mergedFavorites.map(id => setCustomerFavorite(id, true)),
      ]);
      if (!cancelled) {
        mergedAccountUserId.current = { userId, pending: false };
        setCart([...mergedCart.values()]);
        setFavorites(mergedFavorites);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) setToast(errorText(failure.reason));
      }
    };
    sync();
    return () => {
      cancelled = true;
      if (mergedAccountUserId.current === marker) mergedAccountUserId.current = null;
    };
    // Account state is merged once after both account and the initial catalog are ready.
    // Unknown product IDs are preserved until the authoritative ID lookup hydrates them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, catalogState.loading, catalogState.error, productsById, session?.user?.id]);

  const missingProductIds = useMemo(() => [...new Set([...cart.map(item => item.id), ...favorites])].filter(id => !productsById.has(id) && !attemptedProductHydration.current.has(id)), [cart, favorites, productsById]);
  useEffect(() => {
    if (!missingProductIds.length) return;
    missingProductIds.forEach(id => attemptedProductHydration.current.add(id));
    let active = true;
    loadStorefrontProducts(missingProductIds).then(items => {
      if (active) mergeCatalogProducts(items);
    }).catch(error => {
      missingProductIds.forEach(id => attemptedProductHydration.current.delete(id));
      if (active) setToast(errorText(error));
    });
    return () => { active = false; };
  }, [missingProductIds, mergeCatalogProducts]);

  useEffect(() => {
    if (catalogState.loading || catalogState.error) return;
    const changed = [];
    const next = cart.map(item => {
      const product = productsById.get(item.id);
      const variant = product && item.variantId ? product.variants?.find(v => v.id === item.variantId) : null;
      const limit = variant ? variant.stock : product ? product.stock : null;
      const qty = limit != null ? Math.min(item.qty, limit, 100) : item.qty;
      if (limit != null && qty !== item.qty) changed.push({ id: item.id, variantId: item.variantId || null, qty });
      return qty > 0 ? { id: item.id, variantId: item.variantId || null, qty } : null;
    }).filter(Boolean);
    if (changed.length) {
      setCart(next);
      if (session) Promise.all(changed.map(entry => setCustomerCartItem(String(entry.id).split('_')[0], entry.qty, entry.variantId))).catch(error => setToast(errorText(error)));
    }
    // Reconcile only products actually present in the hydrated cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsById, catalogState.loading, catalogState.error, session?.user?.id]);

  useEffect(() => { if (!session) { anonymousCart.current = cart; storageWrite(ANON_CART_KEY, cart); } }, [cart]);
  useEffect(() => { if (!session) { anonymousFavorites.current = favorites; storageWrite(ANON_FAV_KEY, favorites); } }, [favorites]);

  const cartItems = useMemo(() => cart.map(item => {
    const product = productsById.get(item.id) || productsById.get(String(item.id).split('_')[0]);
    if (!product) return { id: item.id, variantId: item.variantId, qty: item.qty };

    // Standalone tarkibiy qism (masalan faqat sumak yoki yostiqcha sotib olinayotganda)
    if (item.isStandaloneComponent && item.componentId) {
      const comp = (product.components || []).find(c => String(c.id) === String(item.componentId)) || item.component;
      const compPrice = comp?.price || comp?.retailPrice || 0;
      return {
        ...product,
        id: item.id,
        cartKey: cartKey(item),
        isStandaloneComponent: true,
        componentId: item.componentId,
        component: comp,
        name: `${product.name} — ${comp?.name || 'Qism'}${comp?.colorName ? ` (${comp.colorName})` : ''}`,
        price: compPrice,
        qty: item.qty,
        stock: product.stock,
        image: comp?.imageUrl || product.image,
      };
    }

    // Asosiy tovar + tanlangan qo'shimcha tarkibiy qismlar
    const variant = item.variantId ? product.variants?.find(v => v.id === item.variantId) : null;
    const basePrice = variant ? variant.price || product.price : product.price;
    const selectedComps = safeArray(item.selectedComponents);
    const compsTotal = selectedComps.reduce((sum, c) => sum + (Number(c.price || c.retailPrice) || 0), 0);
    const totalPrice = basePrice + compsTotal;

    return {
      ...product,
      id: item.id,
      cartKey: cartKey(item),
      productId: product.productId || String(item.id).split('_')[0],
      batchId: product.batchId || null,
      variantId: item.variantId || null,
      selectedComponents: selectedComps,
      qty: item.qty,
      basePrice,
      price: totalPrice,
      stock: variant ? variant.stock : product.stock,
      variantColorName: variant?.colorName || '',
      image: variant?.image || product.image,
    };
  }).filter(item => item.name), [cart, productsById]);
  const selected = route.view === 'product' ? ((route.cardId ? catalog.find(product => product.id === route.cardId) : null) || catalog.find(product => product.slug === route.slug)) : null;
  useEffect(() => {
    if (route.view !== 'product' || selected?.hasDetail || !route.slug) return;
    let active = true;setDetailState({ loading: true, error: '' });
    loadStorefrontProduct(route.slug).then(raw => { if (!active) return;if (!raw) throw new Error('Mahsulot topilmadi.');mergeCatalogProducts([raw]);setDetailState({loading:false,error:''});
      // O'xshash mahsulotlar uchun shu kategoriya tovarlarini serverdan yuklash
      if (raw.category_id) loadStorefrontCatalog({ categoryId: String(raw.category_id), pageSize: 20 }).then(result => { if (active && result?.items?.length) mergeCatalogProducts(result.items); }).catch(() => {});
    }).catch(error => active&&setDetailState({loading:false,error:errorText(error)}));
    return () => { active = false; };
  }, [route.view, route.slug, selected?.hasDetail, mergeCatalogProducts]);
  const selectedCategory = route.view === 'category' ? safeArray(references.categoryDetails).find(category => category.slug === route.slug) : null;
  const selectedPage = route.view === 'page' ? safeArray(cms.pages).find(page => page.slug === route.slug) : null;
  const customerStateReady = !session || (account && mergedAccountUserId.current?.userId === session.user.id && !mergedAccountUserId.current.pending);

  useEffect(() => {
    const baseTitle = plainValue(cms.settings?.site_name) || 'Texnobazar';
    const pageSeo = selectedPage?.seo || {};
    const entity = selected || selectedCategory || selectedPage;
    const pageTitle = selected?.seoTitle || selectedCategory?.seo_title || plainValue(pageSeo.title) || (entity?.name || entity?.title ? `${entity.name || entity.title} — ${baseTitle}` : route.view === 'catalog' ? `Katalog — ${baseTitle}` : route.view === 'cart' ? `Savatcha — ${baseTitle}` : route.view === 'checkout' ? `Buyurtma — ${baseTitle}` : route.view === 'profile' ? `Shaxsiy kabinet — ${baseTitle}` : baseTitle);
    const description = selected?.seoDescription || selected?.description || selectedCategory?.seo_description || selectedCategory?.description || plainValue(pageSeo.description) || plainValue(cms.settings?.seo_description) || 'Texnobazar onlayn texnika do‘koni';
    const image = selected?.seoImage || selectedCategory?.seo_image_url || plainValue(pageSeo.image_url);
    document.title = pageTitle;
    const setMeta = (selector, attributes, content) => { let element = document.querySelector(selector); if (!element) { element = document.createElement('meta'); Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value)); document.head.append(element); } element.content = content || ''; };
    setMeta('meta[name="description"]', { name: 'description' }, description.slice(0, 300));
    setMeta('meta[property="og:title"]', { property: 'og:title' }, pageTitle);
    setMeta('meta[property="og:description"]', { property: 'og:description' }, description.slice(0, 300));
    setMeta('meta[property="og:type"]', { property: 'og:type' }, selected ? 'product' : 'website');
    setMeta('meta[property="og:image"]', { property: 'og:image' }, image);
    setMeta('meta[name="twitter:card"]', { name: 'twitter:card' }, image ? 'summary_large_image' : 'summary');
    setMeta('meta[name="robots"]', { name: 'robots' }, ['cart','checkout','profile'].includes(route.view) ? 'noindex,nofollow' : 'index,follow');
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
    canonical.href = `${window.location.origin}${routePath(route.view, entity || { slug: route.slug })}`;
    setMeta('meta[property="og:url"]', { property: 'og:url' }, canonical.href);
    document.querySelector('#storefront-product-jsonld')?.remove();
    if (selected) {
      const script = document.createElement('script');
      script.id = 'storefront-product-jsonld'; script.type = 'application/ld+json';
      script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: selected.name, description, sku: selected.sku, image: image ? [image] : undefined, offers: { '@type': 'Offer', priceCurrency: 'UZS', price: selected.price, availability: selected.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: canonical.href } });
      document.head.append(script);
    }
  }, [cms.settings, route, selected, selectedCategory, selectedPage]);

  const go = useCallback((view, product, options = {}) => {
    const next = ['product','category','page'].includes(view) ? { view, slug: product.slug, cardId: product?.id || null } : view === 'block' ? { view, blockId: product?.blockId } : { view };
    const path = routePath(view, product);
    if (options.replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
    setRoute(next); setMenu(false); window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navigateTarget = target => {
    if (!target) return;
    setMenu(false);
    try {
      const url = new URL(target, window.location.origin);
      if (url.origin === window.location.origin) {
        history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
        setRoute(parseRoute());
        if (!url.hash) window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (url.protocol === 'https:') window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch { /* Ignore malformed CMS destinations. */ }
  };

  const updateCart = async (product, nextQuantity, message = '', variantId = product.selectedVariantId || null, extra = {}) => {
    if (!customerStateReady) { setToast('Hisob ma’lumotlari sinxronlanmoqda. Biroz kuting.'); return; }
    const variant = variantId ? product.variants?.find(v => v.id === variantId) : null;
    const stockLimit = variant ? variant.stock : product.stock;
    const quantity = Math.max(0, Math.min(Math.trunc(nextQuantity), stockLimit));
    const targetKey = product.cartKey || cartKey({
      id: product.id,
      variantId,
      isStandaloneComponent: extra.isStandaloneComponent ?? product.isStandaloneComponent,
      componentId: extra.componentId ?? product.componentId,
      selectedComponents: extra.selectedComponents ?? product.selectedComponents
    });
    setCart(current => {
      const filtered = current.filter(item => cartKey(item) !== targetKey);
      if (!quantity) return filtered;
      const newItem = {
        id: product.id,
        variantId: variantId || null,
        qty: quantity,
        isStandaloneComponent: Boolean(extra.isStandaloneComponent ?? product.isStandaloneComponent),
        componentId: extra.componentId ?? product.componentId ?? null,
        component: extra.component ?? product.component ?? null,
        selectedComponents: extra.selectedComponents ?? product.selectedComponents ?? []
      };
      return [...filtered, newItem];
    });
    try {
      if (session) await setCustomerCartItem(product.productId || String(product.id).split('_')[0], quantity, variantId || null);
      if (message) setToast(message);
    } catch (error) { setToast(errorText(error)); refreshAccount(); }
  };
  const add = (product, variantId = product.selectedVariantId || null, extra = {}) => {
    const variant = variantId ? product.variants?.find(v => v.id === variantId) : null;
    const stockLimit = variant ? variant.stock : product.stock;
    if (stockLimit < 1) return;
    const targetKey = cartKey({
      id: product.id,
      variantId,
      isStandaloneComponent: extra.isStandaloneComponent,
      componentId: extra.componentId,
      selectedComponents: extra.selectedComponents
    });
    const existing = cart.find(item => cartKey(item) === targetKey)?.qty || 0;
    if (existing >= stockLimit) { setToast('Ombordagi mavjud miqdordan oshirib bo‘lmaydi.'); return; }
    updateCart(product, existing + 1, 'Mahsulot savatchaga qo‘shildi', variantId, extra);
  };
  const toggleFavorite = async product => {
    if (!customerStateReady) { setToast('Hisob ma’lumotlari sinxronlanmoqda. Biroz kuting.'); return; }
    const loved = favorites.includes(product.id);
    setFavorites(current => loved ? current.filter(id => id !== product.id) : [...current, product.id]);
    if (!loved) setToast('Saralanganlarga qo\u2019shildi'); else setToast('Saralanganlardan olib tashlandi');
    try { if (session) await setCustomerFavorite(product.id, !loved); }
    catch (error) { setToast(errorText(error)); refreshAccount(); }
  };
  const clearCart = async () => {
    const items = cart;
    setCart([]);
    storageWrite(ANON_CART_KEY, []);
    if (session) await Promise.all(items.map(item => setCustomerCartItem(item.id, 0, item.variantId || null)));
  };

  if (!authReady) return <div className="app-loading"><div className="app-loading-logo"><span>T</span></div><div className="app-loading-bar"><div className="app-loading-progress"/></div><b>Texnobazar yuklanmoqda...</b></div>;
  if (catalogState.loading && cmsState.loading && !catalog.length) return <div className="app-skeleton"><div className="skeleton-header"/><div className="skeleton-banner"/><div className="container"><div className="skeleton-grid">{Array.from({length:8},(_,i)=><div className="product-skeleton" key={i}/>)}</div></div></div>;
  return <>
  <Header {...{ go, cart, favorites, query, setQuery, menu, setMenu, session, navigateTarget, route, references }} settings={cms.settings} menuItems={safeArray(cms.menu_items)}/>
    <main>
      {route.view === 'home' && <Home {...{ go, add, toggleFavorite, favorites, catalog, cms, catalogState, cmsState, loadCatalog, loadCms, navigateTarget, references, mergeCatalogProducts }}/>}
      {route.view === 'qr' && (
        <>
          <Home {...{ go, add, toggleFavorite, favorites, catalog, cms, catalogState, cmsState, loadCatalog, loadCms, navigateTarget, references, mergeCatalogProducts }}/>
          <QrResolver code={route.code} go={go} add={add} setToast={setToast} mergeCatalogProducts={mergeCatalogProducts}/>
        </>
      )}
      {route.view === 'catalog' && <ServerCatalog {...{ go, add, toggleFavorite, favorites, query, setQuery, references, navigateTarget }} cmsBanners={safeArray(cms.banners)} onItemsLoaded={mergeCatalogProducts}/>} 
      {route.view === 'product' && (selected ? <Product product={selected} route={route} {...{ go, add, toggleFavorite, favorites, session, setToast, setAuthOpen }} loved={favorites.includes(selected.id)} related={(() => { const others = catalog.filter(item => item.id !== selected.id); const sameCat = others.filter(item => item.categoryId && item.categoryId === selected.categoryId); if (sameCat.length >= 5) return sameCat.slice(0, 50); const sameBrand = others.filter(item => item.categoryId && item.categoryId === selected.categoryId || (item.brandId && item.brandId === selected.brandId)); return sameBrand.length > sameCat.length ? sameBrand.slice(0, 50) : sameCat.slice(0, 50); })()}/> : <StatePanel loading={detailState.loading||catalogState.loading} error={detailState.error||catalogState.error} onRetry={()=>loadStorefrontProduct(route.slug).then(raw=>raw&&mergeCatalogProducts([raw]))} title="Mahsulot topilmadi"/>)}
      {route.view === 'category' && (selectedCategory ? <CategoryLanding key={selectedCategory.id} category={selectedCategory} {...{go,add,toggleFavorite,favorites,query,setQuery,references,navigateTarget}} cmsBanners={safeArray(cms.banners)} onItemsLoaded={mergeCatalogProducts}/> : <StatePanel loading={catalogState.loading} error={catalogState.error} onRetry={loadCatalog} title="Kategoriya topilmadi"/>)}
      {route.view === 'page' && (selectedPage ? <CmsPage page={selectedPage}/> : <StatePanel loading={cmsState.loading} error={cmsState.error} onRetry={loadCms} title="Sahifa topilmadi"/>)}
      {route.view === 'block' && <HomeBlockPage blockId={route.blockId} blocks={safeArray(cms.home_blocks)} catalog={catalog} references={references} {...{go,add,toggleFavorite,favorites}} loading={cmsState.loading||catalogState.loading}/>}
      {route.view === 'cart' && <Cart {...{ cartItems, go, updateCart }}/>}
      {route.view === 'favorites' && <FavoritesPage {...{ favorites, catalog, go, add, toggleFavorite }}/>}
      {route.view === 'checkout' && <Checkout {...{ cartItems, go, session, account, clearCart, setToast, customerStateReady }}/>} 
      {route.view === 'profile' && <Profile {...{ go, session, account, accountError, refreshAccount, favorites, catalog, setAuthOpen, setToast }}/>} 
    </main>
    <Footer go={go} settings={cms.settings} pages={safeArray(cms.pages)} menuItems={safeArray(cms.menu_items)} navigateTarget={navigateTarget}/>
    <MobileNav go={go} cart={cart} route={route} settings={cms.settings} favorites={favorites}/>
    {route.view !== 'cart' && <FloatingCartButton count={cart.length} onClick={() => go('cart')} />}
    {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSuccess={() => { setAuthOpen(false); refreshAccount(); }} setToast={setToast}/>} 
    <Toast message={toast} onClose={() => setToast('')}/>
  </>;
}

function Promo({ settings, pages = [], navigateTarget }) {
  const city=siteText(settings,'topbar_city','Toshkent'),phone=siteText(settings,'support_phone'),supportLabel=siteText(settings,'support_label','Aloqa markazi');
  const infoLinks=safeArray(pages).filter(page=>page.slug&&page.title).slice(0,3).map(page=>({label:plainValue(page.title),target:`/page/${page.slug}`}));
  const badges=siteList(settings,'promo_badges',['100% original mahsulot','Real ombor qoldig‘i']);
  return <div className="promo"><div className="container promo-inner">
    <div className="promo-left">
      <span className="promo-city"><MapPin size={13}/>{city}</span>
      {infoLinks.length>0
        ? infoLinks.map((link,index)=><button key={link.target} className={index===1?'promo-link accent':'promo-link'} onClick={()=>navigateTarget?.(link.target)}>{link.label}</button>)
        : badges.slice(0,3).map((badge,index)=><span key={badge} className={index===1?'promo-link accent':'promo-link'}><Check size={12}/>{badge}</span>)}
    </div>
    {phone&&<div className="promo-right">
      <span className="promo-support">{supportLabel} :</span>
      <a className="promo-phone" href={`tel:${phone.replace(/\s/g,'')}`}><Phone size={13}/>{phone}</a>
    </div>}
  </div></div>;
}
function Logo({ go, siteName='Texnobazar' }) { return <button className="logo" onClick={() => go('home')} aria-label={`${siteName} bosh sahifasi`}><strong>{siteName}</strong><i aria-hidden="true">✳</i></button>; }
function Header({ go, cart, favorites, query, setQuery, menu, setMenu, session, menuItems, navigateTarget, settings, references, route }) {
  const cmsHeaderRoots=menuItems.filter(item=>!item.parent_id&&(!item.location||item.location==='header')).slice(0,8),cmsMobileRoots=menuItems.filter(item=>!item.parent_id&&item.location==='mobile').slice(0,10);
  const categoryNav=safeArray(references?.categoryRoots).slice(0,8).map(item=>({id:item.id,label:item.name,target_url:`/category/${item.slug}`,category:item}));
  const navItems=cmsHeaderRoots.length?cmsHeaderRoots:categoryNav,mobileItems=cmsMobileRoots.length?cmsMobileRoots:navItems,siteName=plainValue(settings?.site_name)||'Texnobazar';
  const childrenFor=parent=>parent.category?safeArray(parent.category.children).map(child=>({id:child.id,label:child.name,target_url:`/category/${child.slug}`,category:child})):menuItems.filter(item=>item.parent_id===parent.id&&(!item.location||item.location===parent.location));
  const openItem=item=>item.category?go('category',item.category):navigateTarget(item.target_url),submitSearch=()=>go('catalog');
  const catalogLabel=siteText(settings,'catalog_button_label','Katalog'),searchPlaceholder=siteText(settings,'search_placeholder','Mahsulot, brend yoki SKU qidiring…');
  const homeLabel=siteText(settings,'nav_home_label','Bosh sahifa'),saleLabel=siteText(settings,'nav_sale_label','Chegirmalar'),saleUrl=siteText(settings,'nav_sale_url','/catalog');
  const favoritesLabel=siteText(settings,'label_favorites','Saralangan'),cartLabel=siteText(settings,'label_cart','Savatcha'),accountLabel=siteText(settings,'label_account','Kabinet');
  const [catalogOpen, setCatalogOpen] = useState(false), [categoryFilter, setCategoryFilter] = useState('');
  const catalogRoots = useMemo(() => { const roots = safeArray(references?.categoryRoots); return roots.length ? roots : navItems.filter(item => item.category).map(item => item.category); }, [references, navItems]);
  const filteredRoots = useMemo(() => {
    if (!categoryFilter.trim()) return catalogRoots;
    const q = categoryFilter.trim().toLowerCase();
    return catalogRoots.filter(root => plainValue(root.name).toLowerCase().includes(q) || safeArray(root.children).some(child => plainValue(child.name).toLowerCase().includes(q)));
  }, [catalogRoots, categoryFilter]);
  const openCategory = category => { setCatalogOpen(false); go('category', category); };
  useEffect(() => { if (!catalogOpen) { setCategoryFilter(''); return; } const onKey = event => { if (event.key === 'Escape') setCatalogOpen(false); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [catalogOpen]);
  useEffect(() => { setCatalogOpen(false); }, [route?.view, route?.slug]);
  return <><header className="site-header"><div className="container header-main"><Logo go={go} siteName={siteName}/><button className={catalogOpen?'btn catalog-btn open':'btn catalog-btn'} onClick={()=>setCatalogOpen(value=>!value)} aria-expanded={catalogOpen} aria-label={catalogLabel}>{catalogOpen?<X size={18}/>:<Menu size={18}/>}<span>{catalogLabel}</span></button><label className="search"><Search size={18}/><span className="sr-only">Mahsulot qidirish</span><input value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>event.key==='Enter'&&submitSearch()} placeholder={searchPlaceholder}/><button onClick={submitSearch} aria-label="Qidirish"><Search size={17}/></button></label><div className="header-actions"><HeaderAction icon={User} text={session?accountLabel:'Kirish'} onClick={()=>go('profile')}/><HeaderAction icon={Heart} text={favoritesLabel} count={favorites.length} onClick={()=>go('profile')}/><HeaderAction icon={ShoppingCart} text={cartLabel} count={cart.reduce((sum,item)=>sum+item.qty,0)} onClick={()=>go('cart')}/><SocialIcons settings={settings}/></div><ThemeToggle/><button className="icon-btn mobile-menu" onClick={()=>setMenu(!menu)} aria-expanded={menu} aria-label="Menyuni ochish">{menu?<X/>:<Menu/>}</button></div>{catalogOpen&&<div className="catalog-mega desktop-only"><div className="container catalog-mega-inner">
    <div className="catalog-mega-header">
      <div className="catalog-mega-meta">
        <span className="catalog-mega-badge"><Grid2X2 size={16}/> <b>Katalog</b><span className="catalog-mega-count">({filteredRoots.length} ta bo‘lim)</span></span>
        {catalogRoots.length>10&&<div className="catalog-mega-filter"><Search size={14}/><input type="text" value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)} placeholder="Bo‘lim nomini qidirish…" aria-label="Bo‘limni qidirish"/>{categoryFilter&&<button type="button" onClick={()=>setCategoryFilter('')} aria-label="Tozalash"><X size={12}/></button>}</div>}
      </div>
      <div className="catalog-mega-actions">
        <button type="button" className="catalog-quick-btn all" onClick={()=>{setCatalogOpen(false);go('catalog')}}><Grid2X2 size={14}/><span>Barcha mahsulotlar</span></button>
        {saleLabel&&<button type="button" className="catalog-quick-btn sale" onClick={()=>{setCatalogOpen(false);navigateTarget(saleUrl||'/catalog')}}><BadgePercent size={14}/><span>{saleLabel}</span></button>}
      </div>
    </div>
    <div className="catalog-mega-columns-flow" aria-label="Katalog bo‘limlari">
      {filteredRoots.map(root=>{
        const children=safeArray(root.children),hasKids=children.length>0;
        return <div className="catalog-mega-col-card" key={root.id}>
          <button type="button" className={`catalog-mega-col-item${hasKids?' is-parent':''}`} onClick={()=>openCategory(root)} title={plainValue(root.name)}>
            <span className="catalog-cat-name">{plainValue(root.name)}</span>
            {hasKids&&<ChevronRight size={13} className="cat-chevron"/>}
          </button>
          {hasKids&&<div className="catalog-mega-col-sublist">{children.map(child=><button key={child.id} type="button" className="catalog-mega-col-subitem" onClick={()=>openCategory(child)} title={plainValue(child.name)}>{plainValue(child.name)}</button>)}</div>}
        </div>;
      })}
      {filteredRoots.length===0&&<div className="catalog-mega-no-results"><span>«{categoryFilter}» bo‘yicha kategoriya topilmadi</span></div>}
    </div>
  </div></div>}</header>{catalogOpen&&<button className="catalog-panel-backdrop desktop-only" aria-label="Katalog menyusini yopish" onClick={()=>setCatalogOpen(false)}/>}{menu&&<MobileDrawer go={go} setMenu={setMenu} catalogRoots={catalogRoots} openCategory={openCategory} siteName={siteName} catalogLabel={catalogLabel} accountLabel={accountLabel} cartLabel={cartLabel}/>}</>;
}
function MobileDrawer({go,setMenu,catalogRoots,openCategory,siteName,catalogLabel,accountLabel,cartLabel}){
  const[expanded,setExpanded]=useState(null);
  const toggle=id=>setExpanded(current=>current===id?null:id);
  const navigate=category=>{setMenu(false);openCategory(category)};
  return <div className="mobile-drawer" role="navigation">
    <div className="mobile-drawer-head"><Logo go={go} siteName={siteName}/><button className="icon-btn" aria-label="Mobil menyuni yopish" onClick={()=>setMenu(false)}><X/></button></div>
    <div className="mobile-drawer-scroll">
      {catalogRoots.map(root=>{const children=safeArray(root.children),hasKids=children.length>0,isOpen=expanded===String(root.id);
        return <div key={root.id} className={`mobile-cat${isOpen?' open':''}`}>
          <div className="mobile-cat-head">
            <button className="mobile-cat-name" onClick={()=>navigate(root)}>{plainValue(root.name)}</button>
            {hasKids&&<button className="mobile-cat-toggle" onClick={()=>toggle(String(root.id))} aria-expanded={isOpen} aria-label="Ichki bo'limlar">{isOpen?<X size={16}/>:<ChevronRight size={16}/>}</button>}
          </div>
          {hasKids&&isOpen&&<div className="mobile-cat-children">{children.map(child=>{
            const leaves=safeArray(child.children);
            return <React.Fragment key={child.id}>
              <button className="mobile-subitem" onClick={()=>navigate(child)}>{plainValue(child.name)}</button>
              {leaves.map(leaf=><button className="mobile-leaf" key={leaf.id} onClick={()=>navigate(leaf)}>{plainValue(leaf.name)}</button>)}
            </React.Fragment>
          })}</div>}
        </div>})}
      <div className="mobile-drawer-links">
        <button onClick={()=>{setMenu(false);go('catalog')}}><Grid2X2 size={16}/>{catalogLabel}</button>
        <button onClick={()=>{setMenu(false);go('profile')}}><User size={16}/>{accountLabel}</button>
        <button onClick={()=>{setMenu(false);go('cart')}}><ShoppingCart size={16}/>{cartLabel}</button>
      </div>
    </div>
  </div>;
}
function HeaderAction({ icon: Icon, text, count = 0, onClick }) { return <button className="head-action" onClick={onClick}><span><Icon size={21}/>{count > 0 && <i>{count}</i>}</span><small>{text}</small></button>; }

function Home({go,add,toggleFavorite,favorites,catalog,cms,catalogState,cmsState,loadCatalog,loadCms,navigateTarget,references,mergeCatalogProducts}){
  const settings=cms.settings||{},cmsBanners=safeArray(cms.banners).filter(item=>item.image_url&&(!item.placement||item.placement.includes('hero')));
  const fallback={id:'default',title:siteText(settings,'hero_title','Texnologiya — endi yanada yaqin'),subtitle:siteText(settings,'hero_subtitle','Smartfon, maishiy texnika va aksessuarlarni real ombor qoldig‘i bilan tanlang.'),eyebrow:siteText(settings,'hero_eyebrow','YANGI AVLOD TEXNIKALARI'),target_url:siteText(settings,'hero_cta_url','/catalog'),cta:siteText(settings,'hero_cta_label','Katalogni ko‘rish')};
  const banners=cmsBanners.length?cmsBanners:[];
  const[slide,setSlide]=useState(0),[paused,setPaused]=useState(false);
  useEffect(()=>setSlide(current=>banners.length?current%banners.length:0),[banners.length]);
  useEffect(()=>{if(paused||banners.length<2)return;const timer=setInterval(()=>setSlide(current=>(current+1)%banners.length),5500);return()=>clearInterval(timer)},[banners.length,paused]);
  const active=banners[slide],promotions=safeArray(cms.promotions),blocks=safeArray(cms.home_blocks),categories=safeArray(references?.categoryRoots),hydrationAttempts=useRef(new Set());
  const categoryBlocks=blocks.filter(block=>block.block_type==='categories'),otherBlocks=blocks.filter(block=>block.block_type!=='categories');
  const hasProductBlock=blocks.some(block=>block.block_type==='products')||(!cmsState.loading&&!cmsState.error);
  const referencedProductIds=useMemo(()=>[...new Set([...promotions.flatMap(item=>safeArray(item.product_ids)),...blocks.flatMap(block=>safeArray(block.content?.product_ids))].map(String))],[promotions,blocks]);
  useEffect(()=>{const missing=referencedProductIds.filter(id=>!catalog.some(item=>item.id===id)&&!hydrationAttempts.current.has(id));if(!missing.length)return;missing.forEach(id=>hydrationAttempts.current.add(id));let activeRequest=true;loadStorefrontProducts(missing).then(items=>{if(activeRequest)mergeCatalogProducts(items)}).catch(error=>{missing.forEach(id=>hydrationAttempts.current.delete(id));if(activeRequest)console.warn('CMS mahsulotlari yuklanmadi:',errorText(error))});return()=>{activeRequest=false}},[referencedProductIds,catalog,mergeCatalogProducts]);
  const categoryIdsToHydrate=useMemo(()=>[...new Set(blocks.map(b=>b.content?.category_id).filter(Boolean).map(String))],[blocks]);
  useEffect(()=>{if(!categoryIdsToHydrate.length)return;let active=true;Promise.allSettled(categoryIdsToHydrate.map(catId=>loadStorefrontCatalog({categoryIds:[catId],pageSize:100}))).then(responses=>{if(!active)return;const allItems=responses.filter(r=>r.status==='fulfilled').flatMap(r=>safeArray(r.value?.items));if(allItems.length)mergeCatalogProducts(allItems)}).catch(err=>console.warn('Kategoriya mahsulotlari yuklanmadi:',err));return()=>{active=false}},[categoryIdsToHydrate,mergeCatalogProducts]);
  const promoBanners=safeArray(cms.banners).filter(item=>item.image_url&&item.placement==='home_promo');
  const heroSecondary=siteText(settings,'hero_secondary_label','Barcha mahsulotlar'),heroTrust=siteList(settings,'hero_trust_items',['Real ombor qoldig‘i','Rasmiy kafolat','Tezkor yetkazish']);
  const heroBadgeTitle=siteText(settings,'hero_badge_title','Omborda mavjud'),heroBadgeText=siteText(settings,'hero_badge_text','Qoldiq real vaqtda yangilanadi'),promoBannerLabel=siteText(settings,'promo_banner_label','MAXSUS TAKLIF');
  return <>
    {cmsState.error&&<InlineError text={cmsState.error} onRetry={loadCms}/>}
    {banners.length>0&&<section className="banner-carousel" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)}>
      {banners.map((banner,index)=><button key={banner.id||index} className={`banner-slide${index===slide?' active':''}`} onClick={()=>navigateTarget(banner.target_url||'/catalog')} aria-label={plainValue(banner.title)||`Banner ${index+1}`} aria-hidden={index!==slide}>
        {banner.image_url?<BannerMedia banner={banner} alt={plainValue(banner.title)} eager={index===0}/>:<div className="banner-placeholder"><h2>{plainValue(banner.title)}</h2><p>{plainValue(banner.subtitle)}</p></div>}
      </button>)}
      {banners.length>1&&<>
        <button className="carousel-nav prev" onClick={()=>setSlide((slide-1+banners.length)%banners.length)} aria-label="Oldingi"><ChevronLeft size={20}/></button>
        <button className="carousel-nav next" onClick={()=>setSlide((slide+1)%banners.length)} aria-label="Keyingi"><ChevronRight size={20}/></button>
        <div className="carousel-dots">{banners.map((_,index)=><button key={index} className={index===slide?'active':''} onClick={()=>setSlide(index)} aria-label={`${index+1}-banner`}/>)}</div>
      </>}
    </section>}
    {categoryBlocks.length
      ? <CmsHomeSections blocks={categoryBlocks} catalog={catalog} references={references} settings={settings} {...{go,add,toggleFavorite,favorites,navigateTarget}}/>
      : <CategoryRail kicker={siteText(settings,'catalog_kicker','KATEGORIYALAR')} title={siteText(settings,'catalog_title','Ommabop kategoriyalar')} categories={categories} go={go}/>}
    {promoBanners.length>0&&<section className="container home-promo-banners">{promoBanners.map(banner=><button key={banner.id} onClick={()=>navigateTarget(banner.target_url)}><BannerMedia banner={banner} alt={plainValue(banner.title)}/><span><small>{promoBannerLabel}</small><b>{plainValue(banner.title)}</b><em>Batafsil <ArrowRight/></em></span></button>)}</section>}
    {promotions.length>0&&<section className="container section"><div className="section-head"><div><span className="section-kicker">{siteText(settings,'promotions_kicker','MAXSUS TAKLIFLAR')}</span><h2 className="section-title">{siteText(settings,'promotions_title','Foydali chegirmalar')}</h2></div></div><div className="promotion-modern-grid">{promotions.slice(0,3).map((promotion,index)=><article key={promotion.id} className={`promotion-modern${promotion.image_url?' has-image':''} tone-${index%3}`}>{promotion.image_url&&<img src={promotion.image_url} alt="" className="promo-bg" loading="lazy"/>}<span>{promotion.discount_type==='percent'?`${plainValue(promotion.discount_value)}% gacha`:'Maxsus narx'}</span><h2>{plainValue(promotion.name)}</h2><p>{plainValue(promotion.description)}</p><button onClick={()=>go('catalog')}>Takliflarni ko‘rish <ArrowRight/></button></article>)}</div></section>}
    <CmsHomeSections blocks={otherBlocks} catalog={catalog} references={references} settings={settings} {...{go,add,toggleFavorite,favorites,navigateTarget}}/>
    {!hasProductBlock&&<ProductSection kicker={siteText(settings,'featured_kicker','TANLANGAN MAHSULOTLAR')} title={siteText(settings,'featured_title','Siz uchun tanladik')} subtitle={siteText(settings,'featured_subtitle','Ombordagi haqiqiy qoldiqqa ega yangi mahsulotlar')} list={[...catalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,10)} horizontal {...{go,add,toggleFavorite,favorites}} state={catalogState} onRetry={loadCatalog}/>}
    {safeArray(cms.pages).length>0&&<section className="container section info-section"><div className="section-head"><div><span className="section-kicker">{siteText(settings,'pages_kicker','YORDAM MARKAZI')}</span><h2 className="section-title">{siteText(settings,'pages_title','Kerakli ma’lumotlar')}</h2></div></div><div className="page-grid">{safeArray(cms.pages).slice(0,6).map(page=><button className="info-link card" key={page.id} onClick={()=>go('page',page)}><FileTextIcon/><span><b>{plainValue(page.title)}</b><small>Batafsil ma’lumot</small></span><ChevronRight/></button>)}</div></section>}
  </>;
}
function FeatureStrip({settings}){
  const defaults=[['Tezkor yetkazib berish','Buyurtmangiz ko‘rsatilgan manzilga yetkaziladi'],['Rasmiy kafolat','Barcha mahsulotlar rasmiy kafolat bilan sotiladi'],['Qulay to‘lov','Naqd yoki onlayn to‘lov usulini tanlang'],['Real ombor qoldig‘i','Saytdagi miqdor ombor bilan bir xil']];
  const icons=[Truck,ShieldCheck,CreditCard,PackageCheck];
  const items=defaults.map((entry,index)=>({Icon:icons[index],title:siteText(settings,`feature_${index+1}_title`,entry[0]),text:siteText(settings,`feature_${index+1}_text`,entry[1])})).filter(item=>item.title);
  return <section className="container feature-strip">{items.map(({Icon,title,text})=><article key={title}><span><Icon size={20}/></span><div><b>{title}</b><small>{text}</small></div></article>)}</section>;
}

function useAutoScrollRail({ enabled = true, count = 0 } = {}) {
  const railRef = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const [isAutoActive, setIsAutoActive] = useState(false);
  const isVisibleRef = useRef(false);
  const pausedRef = useRef(false);
  const resumeTimerRef = useRef(null);
  const userInteractingRef = useRef(false);
  const scrollPosRef = useRef(0);

  const syncEdges = useCallback(() => {
    const node = railRef.current;
    if (!node) return;
    const max = node.scrollWidth - node.clientWidth;
    const nextStart = node.scrollLeft <= 4;
    const nextEnd = node.scrollLeft >= max - 4;
    setEdges(prev => (prev.start === nextStart && prev.end === nextEnd ? prev : { start: nextStart, end: nextEnd }));
  }, []);

  const pauseTemporarily = useCallback((ms = 1200) => {
    pausedRef.current = true;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      if (!userInteractingRef.current) {
        pausedRef.current = false;
        const node = railRef.current;
        if (node) scrollPosRef.current = node.scrollLeft;
        if (isVisibleRef.current) setIsAutoActive(true);
      }
    }, ms);
  }, []);

  const scrollBy = useCallback(direction => {
    const node = railRef.current;
    if (!node) return;
    pauseTemporarily(2400);
    node.scrollBy({ left: direction * Math.max(240, node.clientWidth * 0.8), behavior: 'smooth' });
  }, [pauseTemporarily]);

  // Observer for viewport visibility with generous margin
  useEffect(() => {
    if (!enabled) return;
    const node = railRef.current;
    if (!node) return;

    if (typeof IntersectionObserver === 'undefined') {
      isVisibleRef.current = true;
      setIsAutoActive(true);
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const visible = entry.isIntersecting;
          isVisibleRef.current = visible;
          if (visible) {
            scrollPosRef.current = node.scrollLeft;
            setIsAutoActive(true);
          } else {
            setIsAutoActive(false);
          }
        });
      },
      { threshold: 0, rootMargin: '120px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  // Sync edges on resize & count changes
  useEffect(() => {
    if (!enabled) return;
    syncEdges();
    const node = railRef.current;
    if (!node) return;
    scrollPosRef.current = node.scrollLeft;
    window.addEventListener('resize', syncEdges);
    return () => window.removeEventListener('resize', syncEdges);
  }, [syncEdges, enabled, count]);

  // Smooth continuous autoscroll loop
  useEffect(() => {
    if (!enabled) return;
    const node = railRef.current;
    if (!node) return;

    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    let rafId;
    let lastTime = performance.now();
    let waitEndUntil = 0;
    let waitStartUntil = 0;
    let returningToStart = false;
    let rewindTimeout = 0;

    scrollPosRef.current = node.scrollLeft;

    const step = now => {
      const dt = Math.min(now - lastTime, 50);
      lastTime = now;

      const rect = node.getBoundingClientRect();
      const inView = isVisibleRef.current || (rect.bottom > -80 && rect.top < window.innerHeight + 80);

      if (inView && !pausedRef.current && !userInteractingRef.current) {
        const max = node.scrollWidth - node.clientWidth;
        if (max > 10) {
          if (returningToStart) {
            if (node.scrollLeft <= 4 || now >= rewindTimeout) {
              returningToStart = false;
              scrollPosRef.current = 0;
              node.scrollLeft = 0;
              waitStartUntil = now + 600; // brief pause at beginning after loop
            }
          } else if (now >= waitStartUntil) {
            if (node.scrollLeft >= max - 4) {
              if (!waitEndUntil) {
                waitEndUntil = now + 1200; // brief pause at end before rewinding
              } else if (now >= waitEndUntil) {
                waitEndUntil = 0;
                returningToStart = true;
                rewindTimeout = now + 1400; // max time for rewind animation
                node.scrollTo({ left: 0, behavior: 'smooth' });
              }
            } else {
              waitEndUntil = 0;
              // Sync if user manually scrolled without setting interaction flag
              if (Math.abs(node.scrollLeft - scrollPosRef.current) > 15) {
                scrollPosRef.current = node.scrollLeft;
              }
              // Smooth, clearly visible speed: ~65px per second
              scrollPosRef.current += 0.065 * dt;
              if (scrollPosRef.current >= max) {
                scrollPosRef.current = max;
                node.scrollLeft = max;
              } else {
                node.scrollLeft = Math.round(scrollPosRef.current);
              }
            }
          }
        }
      }

      syncEdges();
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    const onPointerEnter = () => {
      pauseTemporarily(700);
    };

    const onPointerLeave = () => {
      userInteractingRef.current = false;
      pauseTemporarily(300);
    };

    let touchStartX = 0;
    let touchStartY = 0;
    let isVerticalSwipe = false;

    const onTouchStart = e => {
      const touch = e.touches?.[0];
      if (touch) {
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
      }
      isVerticalSwipe = false;
      userInteractingRef.current = true;
      pausedRef.current = true;
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };

    const onTouchMove = e => {
      const touch = e.touches?.[0];
      if (touch) {
        const dx = Math.abs(touch.clientX - touchStartX);
        const dy = Math.abs(touch.clientY - touchStartY);
        if (dy > dx && dy > 8) {
          // Vertical page scroll detected: release interaction lock immediately
          isVerticalSwipe = true;
          userInteractingRef.current = false;
          pausedRef.current = false;
        }
      }
    };

    const onTouchEnd = () => {
      userInteractingRef.current = false;
      if (isVerticalSwipe) {
        pausedRef.current = false;
        scrollPosRef.current = node.scrollLeft;
      } else {
        scrollPosRef.current = node.scrollLeft;
        pauseTemporarily(900);
      }
    };

    const onWheel = e => {
      // If predominantly vertical scroll, do not freeze horizontal autoscroll
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5) {
        return;
      }
      scrollPosRef.current = node.scrollLeft;
      pauseTemporarily(900);
    };

    const onScroll = () => {
      if (userInteractingRef.current || pausedRef.current) {
        scrollPosRef.current = node.scrollLeft;
      }
    };

    const onFocusIn = () => {
      userInteractingRef.current = true;
      pausedRef.current = true;
    };

    const onFocusOut = () => {
      userInteractingRef.current = false;
      pauseTemporarily(1200);
    };

    node.addEventListener('mouseenter', onPointerEnter, { passive: true });
    node.addEventListener('mouseleave', onPointerLeave, { passive: true });
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchEnd, { passive: true });
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('focusin', onFocusIn);
    node.addEventListener('focusout', onFocusOut);

    return () => {
      cancelAnimationFrame(rafId);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      node.removeEventListener('mouseenter', onPointerEnter);
      node.removeEventListener('mouseleave', onPointerLeave);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', onFocusOut);
    };
  }, [enabled, pauseTemporarily, syncEdges]);

  return { railRef, edges, scrollBy, syncEdges, isAutoActive };
}

function CategoryRail({kicker='KATEGORIYALAR',title,categories,go,id}){
  const { railRef, edges, scrollBy, syncEdges, isAutoActive } = useAutoScrollRail({ enabled: true, count: categories.length });
  if(!categories.length)return null;
  return <section id={id} tabIndex={id?-1:undefined} className="container section category-section cms-home-anchor">
    <div className="section-head"><div><span className="section-kicker">{kicker}</span><h2 className="section-title">{title}</h2></div><button onClick={()=>go('catalog')}>Barchasi <ArrowRight size={15}/></button></div>
    <div className={`category-rail-shell${!edges.end?' has-more':''}`}>
      <button type="button" className="category-rail-nav prev" hidden={edges.start} aria-label="Oldingi kategoriyalar" onClick={()=>scrollBy(-1)}><ChevronLeft size={18}/></button>
      <div className={`category-rail${isAutoActive?' autoscroll-active':''}`} ref={railRef} onScroll={syncEdges}>
        {categories.slice(0,16).map(category=><button key={category.id} className="category-tile" onClick={()=>go('category',category)}>
          <b>{plainValue(category.name)}</b>
          <span className="category-art">{category.seo_image_url?<ImageWithFallback src={category.seo_image_url} alt=""/>:<i className="category-fallback"><Grid2X2/></i>}</span>
        </button>)}
      </div>
      <button type="button" className="category-rail-nav next" hidden={edges.end} aria-label="Keyingi kategoriyalar" onClick={()=>scrollBy(1)}><ChevronRight size={18}/></button>
    </div>
  </section>;
}
function CmsHomeSections({blocks,catalog,references,settings,go,add,toggleFavorite,favorites,navigateTarget}){
  const categoryMap=new Map(safeArray(references?.categoryDetails).map(category=>[String(category.id),category]));
  return blocks.map(block=>{
    const content=block.content||{},title=plainValue(block.title)||'Texnobazar',anchor=`home-block-${block.id}`;
    if(block.block_type==='categories'){
      const ids=safeArray(content.category_ids).map(String),categories=ids.length?ids.map(id=>categoryMap.get(id)).filter(Boolean):safeArray(references?.categoryRoots);
      return <CategoryRail key={block.id} id={anchor} kicker={plainValue(content.subtitle)||siteText(settings,'catalog_kicker','KATEGORIYALAR')} title={title} categories={categories} go={go}/>;
    }
    if(block.block_type==='products'){
      const selectedCatId=content.category_id?String(content.category_id):null;
      const targetCategory=selectedCatId?categoryMap.get(selectedCatId):null;
      const catSubtree=selectedCatId?getCategorySubtreeIds(selectedCatId,safeArray(references?.categoryDetails)):null;
      const categoryFilteredCatalog=catSubtree?catalog.filter(p=>catSubtree.has(String(p.categoryId))):catalog;
      const isManual=content.product_selection==='manual'&&Array.isArray(content.product_ids)&&content.product_ids.length>0;
      const full=selectedCatId&&!isManual
        ? [...categoryFilteredCatalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))
        : (isManual
            ? orderedProducts(content.product_ids,catalog,categoryFilteredCatalog)
            : (Array.isArray(content.product_ids)&&content.product_ids.length>0
                ? orderedProducts(content.product_ids,catalog,categoryFilteredCatalog)
                : [...categoryFilteredCatalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))));
      const limit=Math.max(1,Number(content.limit)||12);
      const list=full.slice(0,limit);
      let onViewAll=undefined;
      if(targetCategory){
        onViewAll=()=>go('category',targetCategory);
      }else if(content.cta_url){
        onViewAll=()=>navigateTarget(content.cta_url);
      }else if(full.length>10){
        onViewAll=()=>go('block',{blockId:block.id});
      }
      return <ProductSection key={block.id} id={anchor} kicker={siteText(settings,'featured_kicker','TANLANGAN MAHSULOTLAR')} title={title} subtitle={plainValue(content.subtitle)} list={list} horizontal {...{go,add,toggleFavorite,favorites}} onViewAll={onViewAll} viewAllLabel={content.cta_label||'Barchasini ko‘rish'}/>;
    }
    if(block.block_type==='promotion')return <section id={anchor} tabIndex="-1" className="container section cms-home-anchor" key={block.id}><article className="promotion-modern cms-promotion-block"><span>MAXSUS TAKLIF</span><h2>{title}</h2><p>{plainValue(content.text||content.subtitle)}</p>{content.cta_label&&<button onClick={()=>navigateTarget(content.cta_url)}>{plainValue(content.cta_label)} <ArrowRight/></button>}</article></section>;
    if(block.block_type==='rich_text'||block.block_type==='hero')return <section id={anchor} tabIndex="-1" className="container section cms-home-anchor" key={block.id}><article className="cms-rich-modern"><div><span className="section-kicker">TEXNOBAZAR</span><h2>{title}</h2><p>{plainValue(content.text||content.subtitle)}</p>{content.cta_label&&<button className="btn btn-primary" onClick={()=>navigateTarget(content.cta_url)}>{plainValue(content.cta_label)} <ArrowRight/></button>}</div><div className="cms-rich-pattern"><Grid2X2/></div></article></section>;
    return null;
  });
}
function FileTextIcon(){return <span className="info-icon"><PackageCheck/></span>}

function ProductSection({ kicker, title, subtitle, list, go, add, toggleFavorite, favorites, state, onRetry, id, onViewAll, viewAllLabel, horizontal=false }) {
  const[expanded,setExpanded]=useState(false);
  const { railRef, edges, scrollBy, syncEdges, isAutoActive } = useAutoScrollRail({ enabled: horizontal, count: list.length });
  const visible=horizontal?list:(expanded?list:list.slice(0,5));
  const hasMore=horizontal?Boolean(onViewAll):(Boolean(onViewAll)||list.length>5);
  const showAllAction=horizontal?onViewAll:(onViewAll||(()=>go('catalog')));
  const toggle=horizontal?showAllAction:(onViewAll?onViewAll:()=>setExpanded(!expanded));
  const label=viewAllLabel||(horizontal?'Barchasini ko‘rish':(expanded?'Kamroq':'Barchasini ko‘rish'));
  const grid=<div className={horizontal?`product-scroll-row${isAutoActive?' autoscroll-active':''}`:"product-grid"} ref={horizontal?railRef:undefined} onScroll={horizontal?syncEdges:undefined}>{visible.map(product => <ProductCard key={product.id} product={product} {...{ go, add, toggleFavorite }} loved={favorites.includes(product.id)}/>)}</div>;
  return <section id={id} tabIndex={id?-1:undefined} className="container section cms-home-anchor"><div className="between section-head"><div>{kicker&&<span className="section-kicker">{kicker}</span>}<h2 className="section-title">{title}</h2>{subtitle&&<span className="muted">{subtitle}</span>}</div>{hasMore&&<button onClick={toggle}>{label} <ChevronRight size={16}/></button>}</div>{state?.loading ? <LoadingGrid/> : state?.error ? <StatePanel error={state.error} onRetry={onRetry}/> : visible.length ? (horizontal ? <div className={`product-scroll-shell${!edges.end?' has-more':''}`}><button type="button" className="product-scroll-nav prev" hidden={edges.start} aria-label="Oldingi mahsulotlar" onClick={()=>scrollBy(-1)}><ChevronLeft size={18}/></button>{grid}<button type="button" className="product-scroll-nav next" hidden={edges.end} aria-label="Keyingi mahsulotlar" onClick={()=>scrollBy(1)}><ChevronRight size={18}/></button></div> : grid) : <div className="card"><Empty title="Mahsulotlar mavjud emas" text="Katalog yangilangach bu yerda mahsulotlar chiqadi."/></div>}</section>;
}
function HomeBlockPage({blockId,blocks,catalog,references,go,add,toggleFavorite,favorites,loading}){
  const block=blocks.find(item=>String(item.id)===String(blockId));
  if(loading)return <StatePanel loading title="Yuklanmoqda"/>;
  if(!block)return <StatePanel error title="Blok topilmadi" onRetry={()=>go('home')}/>;
  const content=block.content||{};
  const title=plainValue(block.title)||'Mahsulotlar';
  const selectedCatId=content.category_id?String(content.category_id):null;
  const catSubtree=selectedCatId?getCategorySubtreeIds(selectedCatId,safeArray(references?.categoryDetails)):null;
  const categoryFilteredCatalog=catSubtree?catalog.filter(p=>catSubtree.has(String(p.categoryId))):catalog;
  const isManual=content.product_selection==='manual'&&Array.isArray(content.product_ids)&&content.product_ids.length>0;
  const list=selectedCatId&&!isManual
    ?[...categoryFilteredCatalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))
    :(isManual
        ?orderedProducts(content.product_ids,catalog,categoryFilteredCatalog)
        :(Array.isArray(content.product_ids)&&content.product_ids.length>0
            ?orderedProducts(content.product_ids,catalog,categoryFilteredCatalog)
            :[...categoryFilteredCatalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))));
  return <section className="container section home-block-page">
    <div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button><ChevronRight/>{title}</div>
    <div className="section-head"><div><h2 className="section-title">{title}</h2>{content.subtitle&&<span className="muted">{plainValue(content.subtitle)}</span>}</div></div>
    {list.length ? <div className="product-grid">{list.map(product=><ProductCard key={product.id} product={product} {...{go,add,toggleFavorite}} loved={favorites.includes(product.id)}/>)}</div> : <div className="card"><Empty title="Mahsulotlar mavjud emas" text="Bu blokda hali mahsulot yo'q."/></div>}
  </section>;
}
function BannerMedia({banner,alt='',className='',eager=false}){const[mobileEnabled,setMobileEnabled]=useState(Boolean(banner?.mobile_image_url)),[failed,setFailed]=useState(false),desktop=plainValue(banner?.image_url),mobile=plainValue(banner?.mobile_image_url);useEffect(()=>{setMobileEnabled(Boolean(mobile));setFailed(false)},[desktop,mobile]);const fit=value=>['cover','contain','fill'].includes(value)?value:'cover',position=value=>Math.min(100,Math.max(0,numberOf(value??50))),style={'--banner-fit':fit(banner?.image_fit),'--banner-x':`${position(banner?.image_position_x)}%`,'--banner-y':`${position(banner?.image_position_y)}%`,'--banner-mobile-fit':fit(banner?.mobile_image_fit),'--banner-mobile-x':`${position(banner?.mobile_image_position_x)}%`,'--banner-mobile-y':`${position(banner?.mobile_image_position_y)}%`};if(!desktop||failed)return <span className={`media-placeholder responsive-banner-media ${className}`} role="img" aria-label={alt||'Banner rasmi mavjud emas'}><Grid2X2/><span>Rasm tayyorlanmoqda</span></span>;return <picture className={`responsive-banner-media ${className}`} style={style}>{mobileEnabled&&mobile&&<source media="(max-width: 640px)" srcSet={mobile}/>}<img src={desktop} alt={alt} loading={eager?'eager':'lazy'} fetchpriority={eager?'high':'auto'} decoding="async" onError={()=>mobileEnabled?setMobileEnabled(false):setFailed(true)}/></picture>}
function ImageWithFallback({src,alt='',className='',style={}}){const[failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return src&&!failed?<img className={className} style={style} src={src} alt={alt} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<div className={`media-placeholder ${className}`} style={style} role="img" aria-label={alt||'Mahsulot rasmi mavjud emas'}><Grid2X2/><span>Mahsulot rasmi mavjud emas</span></div>}
function ProductMedia({ product, className = '' }) {
  const mediaImages = product.media?.map(m => m.public_url || m.url || m.image).filter(Boolean) || [];
  const primaryFallback = product.image || product.seoImage || product.seo_image_url || '';
  const images = mediaImages.length > 0 ? mediaImages : primaryFallback ? [primaryFallback] : [];
  const[active,setActive]=useState(0);
  const[zoom,setZoom]=useState(false);
  const current = images[active] || '';
  useEffect(() => setActive(0), [product.id, product.selectedVariantId, product.image, images[0]]);
  return <>{zoom&&current&&<ImageZoom images={images} activeIndex={active} alt={product.name} onClose={()=>setZoom(false)} onChangeIndex={setActive}/>}
    <div className={`product-media-carousel ${className}`}>
      <span className="product-media-main" onClick={()=>{if(current)setZoom(true)}} style={{cursor:current?'zoom-in':'default'}}><ImageWithFallback src={current} alt={product.name}/></span>
      {images.length>1&&<div className="product-media-thumbs">{images.map((src,index)=><button key={index} type="button" className={index===active?'active':''} onClick={()=>setActive(index)}><img src={src} alt="" loading="lazy"/></button>)}</div>}
    </div>
  </>;
}
function ImageZoom({images=[],activeIndex=0,alt,onClose,onChangeIndex}){
  const[index,setIndex]=useState(activeIndex);
  const[scale,setScale]=useState(1);const[pos,setPos]=useState({x:0,y:0});const lastDist=React.useRef(0);const dragging=React.useRef(false);const lastPos=React.useRef({x:0,y:0});
  const swipeStart=React.useRef(null);const swipeDelta=React.useRef(0);
  const src=images[index]||images[0]||'';
  const goTo=next=>{const clamped=Math.max(0,Math.min(images.length-1,next));setIndex(clamped);onChangeIndex?.(clamped);setScale(1);setPos({x:0,y:0})};
  const prev=()=>goTo(index-1);const next=()=>goTo(index+1);
  useEffect(()=>{const onKey=e=>{if(e.key==='Escape')onClose();if(e.key==='ArrowLeft')prev();if(e.key==='ArrowRight')next()};window.addEventListener('keydown',onKey);history.pushState(null,'','');const onPop=()=>onClose();window.addEventListener('popstate',onPop);return()=>{window.removeEventListener('keydown',onKey);window.removeEventListener('popstate',onPop)}},[onClose,index]);
  const onWheel=e=>{e.preventDefault();setScale(s=>Math.min(5,Math.max(1,s+(e.deltaY>0?-0.3:0.3))))};
  const onTouchStart=e=>{if(e.touches.length===2){lastDist.current=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)}else if(e.touches.length===1){if(scale>1){dragging.current=true;lastPos.current={x:e.touches[0].clientX-pos.x,y:e.touches[0].clientY-pos.y}}else{swipeStart.current=e.touches[0].clientX;swipeDelta.current=0}}};
  const onTouchMove=e=>{if(e.touches.length===2){e.preventDefault();const dist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);if(lastDist.current>0)setScale(s=>Math.min(5,Math.max(1,s*(dist/lastDist.current))));lastDist.current=dist}else if(dragging.current&&e.touches.length===1){setPos({x:e.touches[0].clientX-lastPos.current.x,y:e.touches[0].clientY-lastPos.current.y})}else if(swipeStart.current!==null&&e.touches.length===1){swipeDelta.current=e.touches[0].clientX-swipeStart.current}};
  const onTouchEnd=()=>{lastDist.current=0;dragging.current=false;if(scale<=1)setPos({x:0,y:0});if(swipeStart.current!==null){const threshold=50;if(swipeDelta.current<-threshold)next();else if(swipeDelta.current>threshold)prev();swipeStart.current=null;swipeDelta.current=0}};
  const reset=()=>{setScale(1);setPos({x:0,y:0})};
  return <div className="image-zoom-overlay" onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
    <button className="image-zoom-close" onClick={onClose} aria-label="Yopish">&times;</button>
    {images.length>1&&<button className="image-zoom-prev" onClick={prev} disabled={index===0} aria-label="Oldingi rasm"><ChevronLeft size={28}/></button>}
    {images.length>1&&<button className="image-zoom-next" onClick={next} disabled={index===images.length-1} aria-label="Keyingi rasm"><ChevronRight size={28}/></button>}
    <div className="image-zoom-body" onDoubleClick={()=>{if(scale>1)reset();else setScale(3)}}><img src={src} alt={alt} style={{transform:"translate("+pos.x+"px,"+pos.y+"px) scale("+scale+")",transition:dragging.current?"none":"transform 0.2s"}}/></div>
    {images.length>1&&<div className="image-zoom-counter">{index+1} / {images.length}</div>}
  </div>;
}
function ProductCard({ product, go, add, toggleFavorite, loved, cartQty = 0, onUpdateQty }) {
  const hasVariants = (product.variants || []).length > 0;
  const[localQty,setLocalQty]=useState(cartQty);
  useEffect(()=>setLocalQty(cartQty),[cartQty]);
  const discount=product.oldPrice>product.price?Math.max(1,Math.round((1-product.price/product.oldPrice)*100)):0,feature=product.attributes[0];
  const handleAdd=()=>{add(product);setLocalQty(q=>q+1)};
  const increment=()=>{if(onUpdateQty){onUpdateQty(product,localQty+1)}else{add(product)};setLocalQty(q=>Math.min(q+1,product.stock))};
  const decrement=()=>{const next=localQty-1;if(onUpdateQty)onUpdateQty(product,next);setLocalQty(next)};
  return <article className="product-card modern-card"><div className="product-img"><ProductMedia product={product}/><div className="product-tags">{discount>0&&<span className="product-badge">-{discount}%</span>}{product.stock>0&&product.stock<4&&<span className="product-limited">Oxirgi {product.stock} dona</span>}{product.components?.length>0&&<span className="product-badge" style={{background:'#ea580c',color:'#fff'}}>Komplekt</span>}</div><button type="button" className="product-open" onClick={()=>go('product',product)} aria-label={`${product.name} mahsulotini ochish`}/></div><button type="button" className={`product-heart ${loved?'loved':''}`} onClick={()=>toggleFavorite(product)} aria-label="Saralangan"><Heart size={19} fill={loved?'currentColor':'none'}/></button><div className="product-body"><span className={`stock-label ${product.stock?'':'out'}`}><i/>{product.stock?`${product.stock} dona mavjud`:'Sotuvda yo\u2019q'}</span><h3 onClick={()=>go('product',product)}>{product.name}</h3>{hasVariants&&<div className="product-color-dots">{product.variants.slice(0,6).map(v=><span key={v.id} style={{background:v.colorHex||'#ccc'}} title={v.colorName}/>)}</div>}{product.reviewCount>0?<div className="product-card-rating"><Star size={13} fill="currentColor"/><b>{product.avgRating.toFixed(1)}</b><span>({product.reviewCount} sharh)</span></div>:<div className="product-meta">{feature?`${feature.name}: ${plainValue(feature.value)}`:'Sharh hali yo\u2019q'}</div>}<div className="product-price-row"><div>{discount>0&&<div className="old-price">{money(product.oldPrice)}</div>}<div className="price">{money(product.price)}</div></div>{hasVariants?<button className="cart-add" onClick={()=>go('product',product)} aria-label="Rangni tanlash"><ShoppingCart size={19}/></button>:localQty>0?<div className="card-qty"><button onClick={decrement} aria-label="Kamaytirish"><Minus size={15}/></button><b>{localQty}</b><button onClick={increment} disabled={localQty>=product.stock} aria-label="Ko\u2019paytirish"><Plus size={15}/></button></div>:<button className="cart-add" onClick={handleAdd} disabled={!product.stock} aria-label="Savatchaga qo\u2019shish"><ShoppingCart size={19}/></button>}</div></div></article>;
}

function CatalogTopBanner({banners,navigateTarget}){const banner=safeArray(banners).find(item=>item.image_url&&item.placement==='catalog_top');if(!banner)return null;return <button type="button" className="catalog-top-banner" onClick={()=>navigateTarget?.(banner.target_url||'/catalog')}><BannerMedia banner={banner} alt={plainValue(banner.title)}/><span><small>KATALOG TAKLIFI</small><b>{plainValue(banner.title)||'Maxsus taklif'}</b><em>Batafsil <ArrowRight/></em></span></button>}
function CategoryLanding({category,go,add,toggleFavorite,favorites,query,setQuery,references,onItemsLoaded,cmsBanners,navigateTarget}){
  const children=safeArray(category.children);
  return <><section className="container seo-landing"><div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button><ChevronRight/>{category.name}</div><header className="card">{category.seo_image_url&&<img src={category.seo_image_url} alt=""/>}<div><h1>{category.name}</h1>{category.description&&<p>{category.description}</p>}</div></header></section>
  {children.length>0&&<section className="container section subcategory-section"><div className="subcategory-grid">{children.map(child=><button key={child.id} className="subcategory-card" onClick={()=>go('category',child)}>{child.seo_image_url&&<img src={child.seo_image_url} alt=""/>}<span>{plainValue(child.name)}</span></button>)}</div></section>}
  <ServerCatalog {...{go,add,toggleFavorite,favorites,query,setQuery,references,onItemsLoaded,cmsBanners,navigateTarget}} initialCategoryIds={[String(category.id)]} title={category.name}/></>;
}
function CmsPage({page}){const body=page.body||{};return <article className="container cms-public-page"><div className="breadcrumbs">Bosh sahifa <ChevronRight/>{page.title}</div><div className="card"><h1>{page.title}</h1>{typeof body==='string'?<p>{body}</p>:body.content?<p>{plainValue(body.content)}</p>:Object.entries(body).map(([key,value])=><section key={key}><h2>{key.replaceAll('_',' ')}</h2><p>{plainValue(value)}</p></section>)}</div></article>}

function Catalog({ go, add, toggleFavorite, favorites, query, setQuery, catalog, catalogState, loadCatalog, references, title = 'Mahsulotlar katalogi' }) {
  const [sort, setSort] = useState('name');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [attribute, setAttribute] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const categories = useMemo(() => [...new Set(catalog.map(item => item.categoryId).filter(Boolean))], [catalog]);
  const brands = useMemo(() => [...new Set(catalog.map(item => item.brandId).filter(Boolean))], [catalog]);
  const attributes = useMemo(() => {
    const result = new Map();
    catalog.flatMap(item => item.attributes).forEach(item => { if (item.code && item.value) result.set(`${item.code}::${item.value}`, `${item.name}: ${item.value}`); });
    return [...result];
  }, [catalog]);
  const shown = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('uz');
    const low = minPrice === '' ? 0 : numberOf(minPrice);
    const high = maxPrice === '' ? Infinity : numberOf(maxPrice);
    const result = catalog.filter(product => (!term || [product.name, product.sku, product.description, ...product.attributes.map(item => item.value)].join(' ').toLocaleLowerCase('uz').includes(term)) && (!category || product.categoryId === category) && (!brand || product.brandId === brand) && (!attribute || product.attributes.some(item => `${item.code}::${item.value}` === attribute)) && product.price >= low && product.price <= high);
    return [...result].sort((a, b) => sort === 'cheap' ? a.price - b.price : sort === 'expensive' ? b.price - a.price : sort === 'new' ? new Date(b.created_at) - new Date(a.created_at) : a.name.localeCompare(b.name, 'uz'));
  }, [catalog, query, category, brand, attribute, minPrice, maxPrice, sort]);
  useEffect(() => setVisible(PAGE_SIZE), [query, category, brand, attribute, minPrice, maxPrice, sort]);
  const reset = () => { setQuery(''); setCategory(''); setBrand(''); setAttribute(''); setMinPrice(''); setMaxPrice(''); };
  const filter = <aside className="filter card"><div className="between"><b>Filtrlar</b><button className="mobile-filter-close" onClick={() => setFiltersOpen(false)} aria-label="Filtrlarni yopish"><X/></button></div><div className="filter-block"><label className="field"><span>Kategoriya</span><select className="select" value={category} onChange={event => setCategory(event.target.value)}><option value="">Barcha kategoriyalar</option>{categories.map((id, index) => <option value={id} key={id}>{references.categories[id] || `Kategoriya ${index + 1}`}</option>)}</select></label></div><div className="filter-block"><label className="field"><span>Brend</span><select className="select" value={brand} onChange={event => setBrand(event.target.value)}><option value="">Barcha brendlar</option>{brands.map((id, index) => <option value={id} key={id}>{references.brands[id] || `Brend ${index + 1}`}</option>)}</select></label></div><div className="filter-block"><label className="field"><span>Xususiyat</span><select className="select" value={attribute} onChange={event => setAttribute(event.target.value)}><option value="">Barcha xususiyatlar</option>{attributes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div><div className="filter-block"><b>Narx oralig‘i</b><div className="row"><label className="sr-only" htmlFor="min-price">Minimal narx</label><input id="min-price" className="input" type="number" min="0" value={minPrice} onChange={event => setMinPrice(event.target.value)} placeholder="dan"/><label className="sr-only" htmlFor="max-price">Maksimal narx</label><input id="max-price" className="input" type="number" min="0" value={maxPrice} onChange={event => setMaxPrice(event.target.value)} placeholder="gacha"/></div></div><button className="btn btn-outline btn-block" onClick={reset}>Tozalash</button></aside>;
  return <section className="container catalog-page"><div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button> <ChevronRight/> Katalog</div><div className="between catalog-title"><div><h1 className="title">{title}</h1><span className="muted">{shown.length} ta mahsulot topildi</span></div><div className="row"><button className="btn btn-outline mobile-filter" onClick={() => setFiltersOpen(true)}><SlidersHorizontal/> Filtr</button><label><span className="sr-only">Saralash</span><select className="select sort" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Nomi bo‘yicha</option><option value="new">Eng yangi</option><option value="cheap">Arzon narx</option><option value="expensive">Qimmat narx</option></select></label></div></div><div className="catalog-layout">{filter}<div>{catalogState.loading ? <LoadingGrid/> : catalogState.error ? <StatePanel error={catalogState.error} onRetry={loadCatalog}/> : shown.length ? <><div className="product-grid catalog-products">{shown.slice(0, visible).map(product => <ProductCard key={product.id} {...{ product, go, add, toggleFavorite }} loved={favorites.includes(product.id)}/>)}</div>{visible < shown.length && <div className="load-more"><button className="btn btn-outline" onClick={() => setVisible(value => value + PAGE_SIZE)}>Yana yuklash</button></div>}</> : <div className="card"><Empty title="Mahsulot topilmadi" text="Qidiruv so‘zini yoki filtrlarni o‘zgartirib ko‘ring."/></div>}</div></div>{filtersOpen && <div className="filter-overlay">{filter}</div>}</section>;
}

function ServerCatalog({go,add,toggleFavorite,favorites,query,setQuery,references,onItemsLoaded=()=>{},initialCategoryIds=[],title='Mahsulotlar katalogi',cmsBanners=[],navigateTarget}){
  const categoryRoots=useMemo(()=>safeArray(references?.categoryRoots),[references]);
  const allCategories=useMemo(()=>safeArray(references?.categoryDetails),[references]);
  const[selectedCatId,setSelectedCatId]=useState(initialCategoryIds[0]||'');
  const[filters,setFilters]=useState({categoryIds:initialCategoryIds,brandIds:[],attributes:{},minPrice:'',maxPrice:'',inStock:false,sort:'name'});
  const[result,setResult]=useState({items:[],total:0,facets:{categories:[],brands:[],attributes:{},price:{}}});
  const[state,setState]=useState({loading:false,error:''});
  const[page,setPage]=useState(1);
  const[filtersOpen,setFiltersOpen]=useState(false);
  const requestGeneration=useRef(0);

  const selectedCategory=useMemo(()=>{if(!selectedCatId)return null;return allCategories.find(c=>String(c.id)===String(selectedCatId))||categoryRoots.find(c=>String(c.id)===String(selectedCatId))||null},[selectedCatId,allCategories,categoryRoots]);
  const subcategories=useMemo(()=>safeArray(selectedCategory?.children),[selectedCategory]);

  const showProducts=!!selectedCatId||!!query;

  const fetchPage=useCallback(async(nextPage=1,append=false)=>{const generation=++requestGeneration.current;setState({loading:true,error:''});try{const catIds=filters.categoryIds.length?filters.categoryIds:(selectedCatId?[selectedCatId]:[]);const data=await loadStorefrontCatalog({query,categoryIds:catIds,brandIds:filters.brandIds,attributes:filters.attributes,minPrice:filters.minPrice||null,maxPrice:filters.maxPrice||null,inStock:filters.inStock,sort:filters.sort,page:nextPage,pageSize:PAGE_SIZE});if(generation!==requestGeneration.current)return;const items=safeArray(data.items).map(adaptProduct);onItemsLoaded(items);setResult(current=>({items:append?[...current.items,...items]:items,total:Number(data.total||0),facets:data.facets||{categories:[],brands:[],attributes:{},price:{}}}));setPage(nextPage);setState({loading:false,error:''});}catch(error){if(generation===requestGeneration.current)setState({loading:false,error:errorText(error)});}},[query,JSON.stringify(filters),selectedCatId,onItemsLoaded]);

  useEffect(()=>{if(!showProducts)return;const timer=setTimeout(()=>fetchPage(1,false),query?300:0);return()=>clearTimeout(timer)},[fetchPage,showProducts]);

  const selectCategory=(cat)=>{setSelectedCatId(String(cat.id));setFilters(f=>({...f,categoryIds:[]}));setPage(1)};
  const selectSubcategory=(catId)=>{setFilters(f=>({...f,categoryIds:catId?[catId]:[]}));setPage(1)};
  const backToCategories=()=>{setSelectedCatId('');setFilters({categoryIds:[],brandIds:[],attributes:{},minPrice:'',maxPrice:'',inStock:false,sort:'name'});setResult({items:[],total:0,facets:{categories:[],brands:[],attributes:{},price:{}}})};
  const reset=()=>{setQuery('');selectSubcategory('');setFilters(f=>({...f,brandIds:[],attributes:{},minPrice:'',maxPrice:'',inStock:false,sort:'name'}))};
  const toggle=(field,value)=>setFilters(current=>({...current,[field]:current[field].includes(value)?current[field].filter(x=>x!==value):[...current[field],value]}));

  const renderFilter=()=><aside className="filter card"><div className="between"><b>Filtrlar</b><button className="mobile-filter-close" onClick={()=>setFiltersOpen(false)} aria-label="Yopish"><X/></button></div>{subcategories.length>0&&<div className="filter-block"><b>Ichki kategoriyalar</b><label className="check-row"><input type="radio" name="subcat" checked={!filters.categoryIds.length} onChange={()=>selectSubcategory('')}/><span>Barchasi</span></label>{subcategories.map(sub=><label className="check-row" key={sub.id}><input type="radio" name="subcat" checked={filters.categoryIds.includes(String(sub.id))} onChange={()=>selectSubcategory(String(sub.id))}/><span>{sub.name}</span></label>)}</div>}{safeArray(result.facets?.brands).length>0&&<div className="filter-block"><b>Brendlar</b>{safeArray(result.facets?.brands).map(item=><label className="check-row" key={item.id}><input type="checkbox" checked={filters.brandIds.includes(String(item.id))} onChange={()=>toggle('brandIds',String(item.id))}/><span>{item.name} ({item.count})</span></label>)}</div>}<div className="filter-block"><b>Narx</b><div className="row"><input className="input" type="number" min="0" value={filters.minPrice} onChange={e=>setFilters({...filters,minPrice:e.target.value})} placeholder="dan"/><input className="input" type="number" min="0" value={filters.maxPrice} onChange={e=>setFilters({...filters,maxPrice:e.target.value})} placeholder="gacha"/></div></div><label className="check-row"><input type="checkbox" checked={filters.inStock} onChange={e=>setFilters({...filters,inStock:e.target.checked})}/><span>Faqat mavjudlari</span></label><button className="btn btn-outline btn-block" onClick={reset}>Tozalash</button></aside>;

  // --- Category grid view (initial) ---
  if(!showProducts){return <section className="container catalog-page"><CatalogTopBanner banners={cmsBanners} navigateTarget={navigateTarget}/><div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button> <ChevronRight/> Katalog</div><h1 className="title catalog-main-title">{title}</h1><span className="muted">{categoryRoots.length} ta kategoriya</span>{categoryRoots.length>0?<div className="catalog-category-grid">{categoryRoots.map(cat=><button key={cat.id} className="catalog-cat-tile" onClick={()=>selectCategory(cat)}><span className="catalog-cat-img">{cat.seo_image_url?<img src={cat.seo_image_url} alt={plainValue(cat.name)} loading="lazy"/>:<Grid2X2/>}</span><b>{plainValue(cat.name)}</b>{safeArray(cat.children).length>0&&<small>{safeArray(cat.children).length} ichki kategoriya</small>}</button>)}</div>:<div className="card"><Empty title="Kategoriyalar topilmadi" text="Hozircha kategoriya mavjud emas."/></div>}</section>}

  // --- Products view (after category selected or search) ---
  return <section className="container catalog-page"><CatalogTopBanner banners={cmsBanners} navigateTarget={navigateTarget}/><div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button> <ChevronRight/> <button onClick={backToCategories}>Katalog</button>{selectedCategory&&<><ChevronRight/>{plainValue(selectedCategory.name)}</>}</div><div className="between catalog-title"><div><h1 className="title">{selectedCategory?plainValue(selectedCategory.name):title}</h1><span className="muted">{result.total} ta mahsulot topildi</span></div><div className="row"><button className="btn btn-outline mobile-filter" onClick={()=>setFiltersOpen(true)}><SlidersHorizontal/> Filtr</button><select className="select sort" value={filters.sort} onChange={e=>setFilters({...filters,sort:e.target.value})}><option value="name">Nomi bo'yicha</option><option value="new">Eng yangi</option><option value="cheap">Arzon narx</option><option value="expensive">Qimmat narx</option></select></div></div>{subcategories.length>0&&<div className="catalog-subcategory-chips"><button className={!filters.categoryIds.length?'active':''} onClick={()=>selectSubcategory('')}>Barchasi</button>{subcategories.map(sub=><button key={sub.id} className={filters.categoryIds.includes(String(sub.id))?'active':''} onClick={()=>selectSubcategory(String(sub.id))}>{sub.name}</button>)}</div>}<div className="catalog-layout">{renderFilter()}<div>{state.loading&&!result.items.length?<LoadingGrid/>:state.error?<StatePanel error={state.error} onRetry={()=>fetchPage(1,false)}/>:result.items.length?<><div className="product-grid catalog-products">{result.items.map(product=><ProductCard key={product.id} {...{product,go,add,toggleFavorite}} loved={favorites.includes(product.id)}/>)}</div>{result.items.length<result.total&&<div className="load-more"><button className="btn btn-outline" disabled={state.loading} onClick={()=>fetchPage(page+1,true)}>{state.loading?'Yuklanmoqda\u2026':'Yana yuklash'}</button></div>}</>:<div className="card"><Empty title="Mahsulot topilmadi" text="Qidiruv yoki filtrlarni o'zgartiring."/></div>}</div></div>{filtersOpen&&<div className="filter-overlay">{renderFilter()}</div>}</section>;
}
function QrResolver({ code, go, add, setToast, mergeCatalogProducts }) {
  const [state, setState] = useState({ loading: true, error: '', product: null });
  const [selectedVariantId, setSelectedVariantId] = useState(null);
  const [selectedCompIds, setSelectedCompIds] = useState(new Set());
  const [added, setAdded] = useState(false);
  const isClosingRef = useRef(false);

  useEffect(() => {
    // If opened directly via QR code from outside (camera app, scanner),
    // ensure history has a base entry so the phone hardware / browser Back button
    // navigates to the storefront home page instead of closing the browser tab.
    if (!window.history.state?.fromQr) {
      const currentPath = window.location.pathname + window.location.search;
      window.history.replaceState({ fromQrBase: true }, '', '/');
      window.history.pushState({ fromQr: true }, '', currentPath);
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!code) {
      setState({ loading: false, error: 'QR kod topilmadi.', product: null });
      return;
    }
    setState({ loading: true, error: '', product: null });

    const resolve = async () => {
      try {
        const client = getBrowserClient();
        let targetSlug = null;
        let variantId = undefined;
        let colorName = null;

        // 1. Resolve QR code via RPC
        const { data: rpcData, error: rpcError } = await client.rpc('resolve_qr_for_storefront', { p_code: code });
        if (!rpcError && rpcData?.slug) {
          targetSlug = rpcData.slug;
          variantId = rpcData.variant_id ?? null;
          colorName = rpcData.color_name || rpcData.variant_color || null;
        } else {
          // Fallback direct lookup
          const { data: fallbackUnit } = await client
            .from('inventory_units')
            .select('product_id, variant_id, qr_code, products!inner(slug, name, is_published, status)')
            .or(`qr_code.eq.${code},serial_number.eq.${code}`)
            .limit(1)
            .maybeSingle();

          if (fallbackUnit?.products?.slug) {
            targetSlug = fallbackUnit.products.slug;
            variantId = fallbackUnit.variant_id ?? null;
          }
        }

        if (!targetSlug) {
          setState({ loading: false, error: 'Ushbu QR kodga tegishli mahsulot topilmadi yoki hali saytda faol emas.', product: null });
          return;
        }

        // 2. Load the storefront product
        const rawProduct = await loadStorefrontProduct(targetSlug);
        if (!rawProduct) {
          setState({ loading: false, error: 'Mahsulot ma’lumotlarini yuklab bo‘lmadi.', product: null });
          return;
        }

        const adapted = adaptProduct(rawProduct);
        if (rpcData?.retail_price) {
          adapted.price = numberOf(rpcData.retail_price);
          if (rpcData.batch_id) adapted.batchId = rpcData.batch_id;
        }
        mergeCatalogProducts?.([adapted]);
        setState({ loading: false, error: '', product: adapted });

        // 3. Find matching variant based on scanned unit
        let matchedVariant = null;
        const variantsList = safeArray(adapted.variants);

        if (variantId) {
          matchedVariant = variantsList.find(v => String(v.id) === String(variantId));
        } else if (variantId === null) {
          // Scanned unit has variant_id IS NULL (standard variant)
          matchedVariant = variantsList.find(v => v.id === 'standard' || ['standart', 'standard', 'baza', 'asosiy'].includes(v.colorName?.toLowerCase().trim()));
        }

        // Fallback by colorName if matching by ID didn't succeed
        if (!matchedVariant && colorName) {
          matchedVariant = variantsList.find(v => v.colorName?.toLowerCase().trim() === colorName.toLowerCase().trim());
        }

        if (matchedVariant) {
          setSelectedVariantId(String(matchedVariant.id));
        } else if (variantsList.length > 0) {
          setSelectedVariantId(String(variantsList[0].id));
        } else {
          setSelectedVariantId(null);
        }
        setSelectedCompIds(new Set((adapted.components || []).filter(c => c.isDefault || c.isRequired).map(c => c.id)));
      } catch (err) {
        setState({ loading: false, error: errorText(err), product: null });
      }
    };

    resolve();
  }, [code]);

  const handleClose = () => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    if (window.history.state?.fromQr) {
      window.history.back();
    } else {
      go('home', null, { replace: true });
    }
  };

  const toggleComponent = compId => {
    const comp = (state.product?.components || []).find(c => c.id === compId);
    if (comp?.isRequired) return;
    setSelectedCompIds(prev => {
      const next = new Set(prev);
      if (next.has(compId)) next.delete(compId);
      else next.add(compId);
      return next;
    });
  };

  const components = state.product?.components || [];
  const hasComponents = components.length > 0;
  const selectedComponentsList = useMemo(() => {
    return components.filter(c => selectedCompIds.has(c.id));
  }, [components, selectedCompIds]);
  const componentsSum = useMemo(() => {
    return selectedComponentsList.reduce((sum, c) => sum + (Number(c.price) || 0), 0);
  }, [selectedComponentsList]);

  const activeVariant = state.product?.variants?.find(v => String(v.id) === String(selectedVariantId)) || state.product?.variants?.[0];
  const displayImage = activeVariant?.image || state.product?.image || state.product?.seoImage || state.product?.primary_media_url || state.product?.seo_image_url || '';
  const displayPrice = activeVariant?.price || state.product?.price || 0;
  const finalModalPrice = displayPrice + componentsSum;

  const handleAddToCart = () => {
    if (!state.product) return;
    const cartProduct = {
      ...state.product,
      price: finalModalPrice,
      selectedVariantId,
      selectedComponents: selectedComponentsList
    };
    add(cartProduct, selectedVariantId, { selectedComponents: selectedComponentsList });
    setAdded(true);
    setToast?.('Mahsulot savatga muvaffaqiyatli qo‘shildi!');
    setTimeout(() => setAdded(false), 2000);
  };

  const handleGoProduct = () => {
    if (!state.product) return;
    const toPass = selectedVariantId ? { ...state.product, selectedVariantId } : state.product;
    go('product', toPass, { replace: true });
  };

  return (
    <div className="overlay" style={{ display: 'grid', placeItems: 'center', zIndex: 1200, padding: 16 }}>
      <div className="card" style={{ maxWidth: 480, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', borderRadius: 20, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', animation: 'toastIn 0.25s ease' }} onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', background: 'var(--surface-2, #f8fafc)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--orange)', fontWeight: 800, fontSize: 13 }}>
            <QrCode size={18} />
            <span style={{ color: 'var(--text-1)' }}>QR kod bo‘yicha topildi</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={handleClose}
            aria-label="Yopish"
            style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: '50%', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        {state.loading ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)' }}>
            <LoaderCircle size={28} className="spinner" style={{ margin: '0 auto 10px', color: 'var(--orange)' }} />
            <b>QR kod tekshirilmoqda…</b>
            <p style={{ margin: '6px 0 0', fontSize: 12 }}>Mahsulot ma’lumotlari yuklanmoqda</p>
          </div>
        ) : state.error ? (
          <div style={{ padding: '30px 20px', textAlign: 'center' }}>
            <div style={{ width: 50, height: 50, borderRadius: '50%', background: '#fee2e2', color: '#ef4444', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}>
              <X size={24} />
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Mahsulot topilmadi</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{state.error}</p>
            <button type="button" className="btn btn-primary" onClick={handleClose}>Katalogga qaytish</button>
          </div>
        ) : state.product ? (
          <div style={{ padding: '20px 20px 24px', overflowY: 'auto' }}>
            {/* Image & Main Info - Mahsulot sahifasiga o'tish uchun bosiladigan blok */}
            <div
              role="button"
              tabIndex={0}
              onClick={handleGoProduct}
              onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && handleGoProduct()}
              title="Mahsulot sahifasiga o‘tish"
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'flex-start',
                marginBottom: 12,
                cursor: 'pointer',
                padding: 6,
                margin: '-6px -6px 8px -6px',
                borderRadius: 14,
                border: '1px solid transparent',
                transition: 'background 0.15s ease, border-color 0.15s ease',
                userSelect: 'none'
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--surface-2, #f8fafc)';
                e.currentTarget.style.borderColor = 'var(--border, #e2e8f0)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.borderColor = 'transparent';
              }}
            >
              <div style={{ width: 100, height: 100, borderRadius: 14, overflow: 'hidden', background: '#f1f5f9', flexShrink: 0, border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>
                <ImageWithFallback src={displayImage} alt={state.product.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {state.product.brandName && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--orange)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{state.product.brandName}</span>
                )}
                <h3 style={{ margin: '2px 0 4px', fontSize: 15, fontWeight: 800, lineHeight: 1.3, color: 'var(--text-1)' }}>
                  {state.product.name}
                </h3>
                <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--orange)' }}>
                  {money(finalModalPrice)}
                  {componentsSum > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', display: 'block' }}>
                      (Asosiy: {money(displayPrice)} + qismlar: {money(componentsSum)})
                    </span>
                  )}
                </div>
                {state.product.oldPrice > displayPrice && (
                  <del style={{ fontSize: 12, color: 'var(--muted)' }}>{money(state.product.oldPrice)}</del>
                )}
                <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--orange)', fontWeight: 700 }}>
                  <span>Batafsil ma’lumot</span>
                  <ArrowRight size={12} />
                </div>
              </div>
            </div>

            {/* Tarkibiy qismlari borligi ko'rsatuvchi belgi */}
            {hasComponents && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, background: '#fff7ed', color: '#c2410c', border: '1px solid #fdba74', fontSize: 11, fontWeight: 700, marginBottom: 12 }}>
                <PackageCheck size={14} />
                <span>To‘plam: Ushbu mahsulot {components.length} ta tarkibiy qismdan iborat</span>
              </div>
            )}

            {/* Ranglar / Variantlar tanlovi */}
            {state.product.variants?.length > 1 && (
              <div style={{ marginBottom: 14, padding: '10px 12px', background: '#f8fafc', borderRadius: 12, border: '1px solid var(--border)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>
                  Rangi: <b>{activeVariant?.colorName || 'Standart'}</b>
                </span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {state.product.variants.map(v => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVariantId(String(v.id))}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 10px',
                        borderRadius: 8,
                        border: String(selectedVariantId) === String(v.id) ? '2px solid var(--orange)' : '1px solid var(--border)',
                        background: '#fff',
                        cursor: 'pointer',
                        fontSize: 11,
                        fontWeight: 700
                      }}
                    >
                      {v.colorHex && <span style={{ width: 10, height: 10, borderRadius: '50%', background: v.colorHex, display: 'inline-block', border: '1px solid rgba(0,0,0,0.1)' }} />}
                      {v.colorName || 'Variant'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tarkibiy va qo'shimcha qismlar ro'yxati */}
            {hasComponents && (
              <div style={{ marginBottom: 14, padding: '10px 12px', background: '#f8fafc', borderRadius: 12, border: '1px solid #fed7aa' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: '#9a3412', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <PackageCheck size={14} style={{ color: 'var(--orange)' }} />
                    Tarkibiy qismlar ({components.length} ta):
                  </span>
                  <span style={{ fontSize: 10, color: '#7c2d12', fontWeight: 600 }}>
                    To‘plamga tanlash
                  </span>
                </div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 160, overflowY: 'auto', paddingRight: 2 }}>
                  {components.map(comp => {
                    const isChecked = selectedCompIds.has(comp.id);
                    return (
                      <label
                        key={comp.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          borderRadius: 8,
                          background: isChecked ? '#fff7ed' : '#ffffff',
                          border: isChecked ? '1px solid #fdba74' : '1px solid var(--border)',
                          cursor: comp.isRequired ? 'default' : 'pointer',
                          fontSize: 12,
                          gap: 8,
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={comp.isRequired}
                            onChange={() => toggleComponent(comp.id)}
                            style={{ accentColor: 'var(--orange)', cursor: comp.isRequired ? 'default' : 'pointer' }}
                          />
                          {comp.imageUrl && (
                            <img
                              src={comp.imageUrl}
                              alt={comp.name}
                              style={{ width: 28, height: 28, borderRadius: 5, objectFit: 'cover', border: '1px solid #cbd5e1', background: '#f1f5f9', flexShrink: 0 }}
                            />
                          )}
                          {comp.colorHex && (
                            <span
                              style={{ width: 10, height: 10, borderRadius: '50%', background: comp.colorHex, border: '1px solid rgba(0,0,0,0.1)', flexShrink: 0 }}
                              title={comp.colorName}
                            />
                          )}
                          <span style={{ fontWeight: isChecked ? 600 : 400, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {comp.name} {comp.quantity > 1 ? `(${comp.quantity} ta)` : ''} {comp.colorName ? `· ${comp.colorName}` : ''}
                          </span>
                          {comp.isRequired && (
                            <span style={{ fontSize: 9, background: '#fee2e2', color: '#b91c1c', padding: '1px 5px', borderRadius: 4, fontWeight: 700, flexShrink: 0 }}>
                              Majburiy
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, color: isChecked ? '#c2410c' : 'var(--muted)', flexShrink: 0 }}>
                          +{money(comp.price)}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {componentsSum > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 6, borderTop: '1px dashed #fed7aa', fontSize: 11 }}>
                    <span style={{ color: 'var(--muted)' }}>Qismlar qo‘shimcha qiymati:</span>
                    <b style={{ color: '#c2410c' }}>+{money(componentsSum)}</b>
                  </div>
                )}
              </div>
            )}

            {/* Qoldiq va seriya ma'lumoti */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--muted)', marginBottom: 18 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#16a34a', fontWeight: 700 }}>
                <Check size={14} /> Omborda mavjud
              </span>
              <span style={{ fontFamily: 'monospace' }}>QR: {code}</span>
            </div>

            {/* Tugmalar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', height: 46, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                onClick={handleAddToCart}
              >
                <ShoppingCart size={18} />
                {added ? 'Savatga qo‘shildi ✓' : 'Savatga qo‘shish'}
              </button>

              <button
                type="button"
                className="btn btn-outline"
                style={{ width: '100%', height: 42, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={handleGoProduct}
              >
                Batafsil ko‘rish <ArrowRight size={15} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RichDescription({product}){const media=new Map(safeArray(product.media).map(item=>[String(item.id),item]));const blocks=safeArray(product.descriptionBlocks);const[zoomSrc,setZoomSrc]=useState(null);if(!blocks.length){if(!product.description)return <p>Mahsulot tavsifi kiritilmagan.</p>;return <>{zoomSrc&&<ImageZoom images={[zoomSrc]} activeIndex={0} alt={product.name} onClose={()=>setZoomSrc(null)} onChangeIndex={()=>{}}/>}<div className="product-html-description" dangerouslySetInnerHTML={{__html:product.description}} onClick={e=>{if(e.target.tagName==='IMG'&&e.target.src)setZoomSrc(e.target.src)}} style={{cursor:'auto'}}/></>};const descImages=blocks.filter(b=>b.type==="image"&&media.get(String(b.media_id))).map(b=>media.get(String(b.media_id)).url);return <>{zoomSrc&&<ImageZoom images={descImages.length?descImages:[zoomSrc]} activeIndex={Math.max(0,descImages.indexOf(zoomSrc))} alt={product.name} onClose={()=>setZoomSrc(null)} onChangeIndex={()=>{}}/>}<div className="structured-product-description">{blocks.map((block,index)=>{if(block.type==='text')return block.text?.includes('<')?<div key={index} dangerouslySetInnerHTML={{__html:block.text}}/>:<p key={index}>{block.text}</p>;if(block.type==='heading'){const Tag=`h${Math.min(4,Math.max(2,Number(block.level)||2))}`;return <Tag key={index}>{block.text}</Tag>}if(block.type==='list')return <ul key={index}>{safeArray(block.items).map((item,i)=><li key={i}>{plainValue(item)}</li>)}</ul>;if(block.type==='table')return <div className="table-wrap" key={index}><table className="table"><thead><tr>{safeArray(block.headers).map((cell,i)=><th key={i}>{plainValue(cell)}</th>)}</tr></thead><tbody>{safeArray(block.rows).map((row,i)=><tr key={i}>{safeArray(row).map((cell,j)=><td key={j}>{plainValue(cell)}</td>)}</tr>)}</tbody></table></div>;if(block.type==='image'){const item=media.get(String(block.media_id));return item?<figure key={index} className="desc-zoomable" onClick={()=>setZoomSrc(item.url)} style={{cursor:'zoom-in'}}><img src={item.url} alt={block.caption||item.alt||product.name}/>{block.caption&&<figcaption>{block.caption}</figcaption>}</figure>:null}if(block.type==='video'||block.type==='link')return <p key={index}><a href={block.url} target="_blank" rel="noopener noreferrer">{block.label||(block.type==='video'?'Videoni ko‘rish':'Havolani ochish')}</a></p>;return null})}</div></>}

function StarRating({ value = 0, max = 5, onChange, size = 20 }) {
  const stars = Array.from({ length: max }, (_, i) => i + 1);
  return <div className="star-rating" role={onChange ? 'radiogroup' : 'img'} aria-label={`${value} / ${max} yulduz`}>{stars.map(n => onChange ? <button key={n} type="button" className={n <= value ? 'star filled' : 'star'} onClick={() => onChange(n)} aria-label={`${n} yulduz`}><Star size={size} fill={n <= value ? 'currentColor' : 'none'}/></button> : <span key={n} className={n <= value ? 'star filled' : 'star'}><Star size={size} fill={n <= value ? 'currentColor' : 'none'}/></span>)}</div>;
}

function ProductReviews({ productId, session, setToast, setAuthOpen }) {
  const [reviews, setReviews] = useState([]);
  const [avg, setAvg] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await loadProductReviews(productId);
      setReviews(result?.items || []);
      setAvg(Number(result?.average_rating || 0));
      setTotal(Number(result?.total || 0));
    } catch { setReviews([]); }
    finally { setLoading(false); }
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!rating) { setToast && setToast('Iltimos, baho bering (1-5 yulduz)'); return; }
    setSubmitting(true);
    try {
      await submitProductReview({ productId, rating, body: body.trim() });
      setToast && setToast('Sharhingiz qabul qilindi!');
      setRating(0); setBody('');
      await load();
    } catch (error) { setToast && setToast(error?.message || 'Sharh yuborilmadi'); }
    finally { setSubmitting(false); }
  };

  return <div className="reviews-section card detail-tabs">
    <div className="reviews-header"><h2>Sharhlar va baholar</h2>{total > 0 && <div className="reviews-summary"><StarRating value={Math.round(avg)}/><b>{avg}</b><span>({total} ta sharh)</span></div>}</div>
    {session ? <form className="review-form" onSubmit={submit}><h3>Sharh qoldirish</h3><div className="review-stars-input"><span>Bahoyingiz:</span><StarRating value={rating} onChange={setRating} size={24}/>{rating > 0 && <small>{rating} / 5</small>}</div><textarea className="textarea" value={body} onChange={e => setBody(e.target.value)} placeholder="Mahsulot haqida fikringizni yozing..." maxLength={2000} rows={3}/><button className="btn btn-primary" type="submit" disabled={submitting || !rating}>{submitting ? 'Yuborilmoqda...' : 'Sharh yuborish'}</button></form> : <p className="review-login-hint">Sharh qoldirish uchun <button type="button" className="review-login-link" onClick={()=>setAuthOpen?.(true)}>hisobingizga kiring</button>.</p>}
    {loading ? <p className="muted">Sharhlar yuklanmoqda...</p> : reviews.length > 0 ? <div className="reviews-list">{reviews.map(item => <div className="review-item" key={item.id}><div className="review-item-head"><StarRating value={item.rating} size={16}/><b>{item.reviewer_name}</b><time>{formatUzDate(item.created_at, { day: true, month: 'long', year: true })}</time></div>{item.body && <p>{item.body}</p>}</div>)}</div> : !loading && <p className="muted">Bu mahsulotga hali sharh yozilmagan. Birinchi bo'lib sharh qoldiring!</p>}
  </div>;
}

function Product({ product, go, add, toggleFavorite, loved, related, favorites, session, setToast, setAuthOpen, route }) {
  const variants = product.variants || [];
  const priceTiers = product.priceTiers || [];
  const components = product.components || [];

  const targetVariantVal = product.selectedVariantId || route?.variantParam || null;
  const initialVariantId = (targetVariantVal && variants.some(v => String(v.id) === String(targetVariantVal) || v.colorName?.toLowerCase().trim() === String(targetVariantVal).toLowerCase().trim()))
    ? (variants.find(v => String(v.id) === String(targetVariantVal) || v.colorName?.toLowerCase().trim() === String(targetVariantVal).toLowerCase().trim())?.id)
    : (variants[0]?.id || null);
  const [variantId, setVariantId] = useState(initialVariantId);
  const [selectedTierId, setSelectedTierId] = useState(() => {
    if (product.id && product.id.includes('_')) return product.id;
    return priceTiers[0]?.id || null;
  });

  const [selectedCompIds, setSelectedCompIds] = useState(() => {
    return new Set(components.filter(c => c.isDefault || c.isRequired).map(c => c.id));
  });

  const lastCompKeyRef = useRef('');
  useEffect(() => {
    const targetVal = product.selectedVariantId || route?.variantParam || null;
    const resolvedId = (targetVal && variants.some(v => String(v.id) === String(targetVal) || v.colorName?.toLowerCase().trim() === String(targetVal).toLowerCase().trim()))
      ? (variants.find(v => String(v.id) === String(targetVal) || v.colorName?.toLowerCase().trim() === String(targetVal).toLowerCase().trim())?.id)
      : (variants[0]?.id || null);
    setVariantId(resolvedId);
    setSelectedTierId(product.id && product.id.includes('_') ? product.id : (priceTiers[0]?.id || null));
    const key = `${product.id}:${(product.components || []).length}`;
    if (lastCompKeyRef.current !== key) {
      const isNewProduct = !lastCompKeyRef.current.startsWith(`${product.id}:`);
      if (isNewProduct || selectedCompIds.size === 0) {
        setSelectedCompIds(new Set((product.components || []).filter(c => c.isDefault || c.isRequired).map(c => c.id)));
      }
      lastCompKeyRef.current = key;
    }
  }, [product.id, product.selectedVariantId, priceTiers.length, (product.components || []).length]);

  const toggleComponent = compId => {
    const comp = components.find(c => c.id === compId);
    if (comp?.isRequired) return;
    setSelectedCompIds(prev => {
      const next = new Set(prev);
      if (next.has(compId)) next.delete(compId);
      else next.add(compId);
      return next;
    });
  };

  const selectedComponentsList = useMemo(() => {
    return components.filter(c => selectedCompIds.has(c.id));
  }, [components, selectedCompIds]);

  const componentsSum = useMemo(() => {
    return selectedComponentsList.reduce((sum, c) => sum + (Number(c.price) || 0), 0);
  }, [selectedComponentsList]);

  const activeVariant = variantId ? variants.find(v => v.id === variantId) : null;
  const activeTier = selectedTierId ? priceTiers.find(t => t.id === selectedTierId) : (priceTiers[0] || null);
  const displayPrice = activeVariant?.price || activeTier?.price || product.price;
  const displayOldPrice = activeVariant?.compareAtPrice || product.oldPrice;
  const displayStock = activeVariant ? activeVariant.stock : (activeTier ? activeTier.stock : product.stock);
  const displayMedia = activeVariant?.media?.length ? activeVariant.media : (activeVariant?.image ? [{ url: activeVariant.image }] : product.media);
  const mediaProduct = { ...product, media: displayMedia, image: activeVariant?.image || product.image, selectedVariantId: variantId };

  const finalBundlePrice = displayPrice + componentsSum;

  const cartProduct = {
    ...product,
    id: activeTier?.id || product.id,
    productId: product.productId || String(product.id).split('_')[0],
    batchId: activeTier?.batch_id || product.batchId || null,
    price: finalBundlePrice,
    stock: displayStock,
    selectedVariantId: variantId,
    selectedComponents: selectedComponentsList
  };
  const ytVideo = getYouTubeEmbedUrl(product.videoUrl || product.video_url || product.seoImage);

  return <section className="container product-page">
    <div className="breadcrumbs">
      <button onClick={() => go('home')}>Bosh sahifa</button>
      <ChevronRight />
      <button onClick={() => go('catalog')}>Katalog</button>
      <ChevronRight />
      {product.name}
    </div>
    <div className="product-detail card">
      <div className="gallery single-media">
        <div className="main-img">
          <ProductMedia product={mediaProduct} />
          {displayOldPrice > displayPrice && <span className="badge">Aksiya</span>}
        </div>
        {ytVideo && (
          <div className="product-video" style={{ marginTop: 14 }}>
            <iframe
              src={ytVideo}
              title={`${product.name} videosi`}
              allowFullScreen
              style={{ width: '100%', height: 320, border: 'none', borderRadius: 12 }}
            />
          </div>
        )}
      </div>
      <div className="detail-info">
        <div className="row">
          <Status type={displayStock ? 'green' : 'red'}>
            {displayStock ? 'Sotuvda mavjud' : "Sotuvda yo\u2019q"}
          </Status>
        </div>
        {product.brandName && (
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--orange)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 2 }}>
            {product.brandName}
          </span>
        )}
        <h1>{product.name}</h1>
        <p className="muted">Artikul: {product.sku || '\u2014'}</p>
        {variants.length > 0 && (
          <div className="product-color-picker">
            <span className="label">Rang: {activeVariant ? <b>{activeVariant.colorName}</b> : ''}</span>
            <div className="product-color-options">
              {variants.map(v => {
                const isSelected = String(v.id) === String(variantId);
                const light = isLightColor(v.colorHex);
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={isSelected ? 'product-color-option active' : 'product-color-option'}
                    style={{
                      background: v.colorHex || '#94a3b8',
                      color: light ? '#0f172a' : '#ffffff',
                      border: light ? '2px solid rgba(0,0,0,0.2)' : undefined
                    }}
                    title={`${v.colorName} (${v.stock} dona)`}
                    onClick={() => setVariantId(v.id)}
                  >
                    {isSelected && <Check size={13} strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {priceTiers.length > 1 && (
          <div className="product-price-tiers" style={{ marginTop: 12, marginBottom: 12 }}>
            <span className="label" style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
              Mavjud partiyalar narxi:
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {priceTiers.map(tier => {
                const isSelected = (activeTier?.id || priceTiers[0]?.id) === tier.id || displayPrice === tier.price;
                return (
                  <button
                    key={tier.id || tier.price}
                    type="button"
                    onClick={() => setSelectedTierId(tier.id)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 10,
                      border: isSelected ? '2px solid var(--orange, #f97316)' : '1px solid #e2e8f0',
                      background: isSelected ? '#fff7ed' : '#f8fafc',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: isSelected ? 700 : 500,
                      color: isSelected ? '#c2410c' : '#334155',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {money(tier.price)} <span style={{ fontSize: 11, color: '#64748b' }}>({tier.stock} dona)</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Modular Product Components / Tarkibiy va qo'shimcha qismlar */}
        {components.length > 0 && (
          <div className="product-components-buyer card pad" style={{ marginTop: 14, marginBottom: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>
                Tarkibiy va qo‘shimcha qismlar:
              </span>
              <span style={{ fontSize: 11, color: '#64748b' }}>
                To‘plamga qo‘shish / ayirish
              </span>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {components.map(comp => {
                const isChecked = selectedCompIds.has(comp.id);
                return (
                  <div
                    key={comp.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: isChecked ? '#fff7ed' : '#ffffff',
                      border: isChecked ? '1px solid #fdba74' : '1px solid #e2e8f0',
                      transition: 'all 0.15s ease',
                      flexWrap: 'wrap',
                      gap: 8
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: comp.isRequired ? 'default' : 'pointer', flex: '1 1 auto' }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={comp.isRequired}
                        onChange={() => toggleComponent(comp.id)}
                      />
                      {comp.imageUrl && (
                        <img
                          src={comp.imageUrl}
                          alt={comp.name}
                          style={{
                            width: 38,
                            height: 38,
                            borderRadius: 6,
                            objectFit: 'cover',
                            border: '1px solid #cbd5e1',
                            flexShrink: 0,
                            background: '#f1f5f9'
                          }}
                        />
                      )}
                      {comp.colorHex && (
                        <span
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: '50%',
                            background: comp.colorHex,
                            display: 'inline-block',
                            border: '1px solid #cbd5e1',
                            flexShrink: 0
                          }}
                          title={comp.colorName}
                        />
                      )}
                      <span style={{ fontSize: 13, fontWeight: isChecked ? 600 : 400, color: '#1e293b' }}>
                        {comp.name} {comp.quantity > 1 ? `(${comp.quantity} dona)` : ''} {comp.colorName ? `· ${comp.colorName}` : ''}
                      </span>
                      {comp.isRequired && (
                        <span style={{ fontSize: 10, background: '#fee2e2', color: '#b91c1c', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>
                          Majburiy
                        </span>
                      )}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: isChecked ? '#c2410c' : '#64748b' }}>
                        +{money(comp.price)}
                      </span>
                      {comp.canBuyStandalone && (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }}
                          onClick={e => {
                            e.stopPropagation();
                            add(product, null, { isStandaloneComponent: true, componentId: comp.id, component: comp });
                          }}
                          title="Faqat ushbu qismni alohida savatga qo‘shish"
                        >
                          Faqat qismni olish
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="divider" />
        {displayOldPrice > displayPrice && <div className="old-price">{money(displayOldPrice)}</div>}
        <div className="detail-price">
          {money(finalBundlePrice)}
          {componentsSum > 0 && (
            <span style={{ fontSize: 13, color: '#64748b', fontWeight: 500, marginLeft: 8 }}>
              (Asosiy: {money(displayPrice)} + Qismlar: {money(componentsSum)})
            </span>
          )}
        </div>
        <div className={`stock ${displayStock ? '' : 'out'}`}>
          {displayStock ? <Check size={18} /> : <X size={18} />}
          {displayStock ? `Omborda ${displayStock} dona mavjud` : 'Omborda mavjud emas'}
        </div>
        <div className="detail-actions">
          <button
            className="btn btn-primary"
            onClick={() => add(cartProduct, variantId, { selectedComponents: selectedComponentsList })}
            disabled={!displayStock}
          >
            <ShoppingCart /> Savatchaga
          </button>
          <button className={`btn btn-outline ${loved ? 'loved' : ''}`} onClick={() => toggleFavorite(product)}>
            <Heart fill={loved ? 'currentColor' : 'none'} />
            {loved ? "Sevimlilardan olib tashlash" : "Sevimliga qo\u2019shish"}
          </button>
        </div>
      </div>
    </div>
    <div className="detail-tabs card">
      <h2>Mahsulot haqida</h2>
      <RichDescription product={product} />
      <h3>Asosiy xususiyatlar</h3>
      {product.attributes.length ? (
        <div className="spec-grid">
          {product.attributes.map(item => (
            <div key={`${item.code}-${item.value}`}>
              <span>{item.name}</span>
              <b>{item.value || '\u2014'}</b>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">Xususiyatlar kiritilmagan.</p>
      )}
    </div>
    <ProductReviews productId={product.id} session={session} setToast={setToast} setAuthOpen={setAuthOpen} />
    {related.length > 0 && (
      <ProductSection
        title={'O\u2019xshash mahsulotlar'}
        subtitle="Sizga mos takliflar"
        list={related}
        {...{ go, add, toggleFavorite, favorites }}
        onViewAll={() => go('category', { slug: product.categorySlug || product.categoryId })}
      />
    )}
  </section>;
}

function Cart({ cartItems, go, updateCart }) {
  const total = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  return <section className="container cart-page">
    <div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button> <ChevronRight/> Savatcha</div>
    <h1 className="title">Savatcha</h1>
    {cartItems.length ? (
      <div className="cart-layout">
        <div className="stack">
          {cartItems.map(product => (
            <div className="cart-item card" key={product.cartKey || `${product.id}::${product.variantId||''}`}>
              <ProductMedia product={product}/>
              <div className="cart-name">
                <b>{product.name}</b>
                {product.variantColorName && <em className="cart-variant-tag">{product.variantColorName}</em>}
                {product.selectedComponents?.length > 0 && (
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--orange, #ea580c)' }}>Tarkibiy qismlar:</span>
                    {product.selectedComponents.map((c, i) => (
                      <span key={c.id || i} style={{ fontSize: 11, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {(c.imageUrl || c.image_url) && (
                          <img
                            src={c.imageUrl || c.image_url}
                            alt=""
                            style={{ width: 14, height: 14, borderRadius: 3, objectFit: 'cover', border: '1px solid #e2e8f0', flexShrink: 0 }}
                          />
                        )}
                        • {c.name} {c.color_name || c.colorName ? `(${c.color_name || c.colorName})` : ''} (+{money(c.retail_price || c.price || 0)})
                      </span>
                    ))}
                  </div>
                )}
                <span className="muted">Omborda: {product.stock} dona</span>
                <button onClick={() => updateCart(product, 0, '', product.variantId, { isStandaloneComponent: product.isStandaloneComponent, componentId: product.componentId, selectedComponents: product.selectedComponents })}>
                  <Trash2/> O‘chirish
                </button>
              </div>
              <div className="qty">
                <button onClick={() => updateCart(product, product.qty - 1, '', product.variantId, { isStandaloneComponent: product.isStandaloneComponent, componentId: product.componentId, selectedComponents: product.selectedComponents })} aria-label="Miqdorni kamaytirish"><Minus/></button>
                <b>{product.qty}</b>
                <button onClick={() => updateCart(product, product.qty + 1, '', product.variantId, { isStandaloneComponent: product.isStandaloneComponent, componentId: product.componentId, selectedComponents: product.selectedComponents })} disabled={product.qty >= product.stock} aria-label="Miqdorni oshirish"><Plus/></button>
              </div>
              <div className="price">{money(product.price * product.qty)}</div>
            </div>
          ))}
        </div>
        <OrderTotal total={total} count={cartItems.reduce((sum, item) => sum + item.qty, 0)} onClick={() => go('checkout')}/>
      </div>
    ) : (
      <div className="card">
        <Empty title="Savatchangiz bo‘sh" text="Katalogdan o‘zingizga yoqqan texnikani tanlang."/>
        <div className="center-action"><button className="btn btn-primary" onClick={() => go('catalog')}>Katalogga o‘tish</button></div>
      </div>
    )}
  </section>;
}
function OrderTotal({ total, count, onClick, disabled, loading }) { return <aside className="order-total card"><h3>Buyurtmangiz</h3><div className="between"><span>Mahsulotlar ({count})</span><b>{money(total)}</b></div><div className="between"><span>Yetkazib berish</span><b className="orange">Buyurtmada aniqlanadi</b></div><div className="divider"/><div className="between grand"><span>Jami</span><b>{money(total)}</b></div><button className="btn btn-primary btn-block" onClick={onClick} disabled={disabled || loading}>{loading ? 'Yuborilmoqda…' : 'Rasmiylashtirish'}</button><small className="muted">Davom etish orqali ommaviy oferta shartlariga rozilik bildirasiz.</small></aside>; }

function Checkout({ cartItems, go, session, account, clearCart, setToast, customerStateReady }) {
  const defaultAddress = safeArray(account?.addresses).find(item => item.is_default) || safeArray(account?.addresses)[0];
  const savedAddress = defaultAddress?.address?.address || plainValue(defaultAddress?.address);
  const [form, setForm] = useState({ name: account?.customer?.full_name || account?.profile?.full_name || '', phone: account?.customer?.phone || account?.profile?.phone || '', email: account?.customer?.email || account?.profile?.email || '', address: savedAddress, notes: '' });
  const dirtyFields = useRef(new Set());
  const [methods, setMethods] = useState([]);
  const [methodError, setMethodError] = useState('');
  const [payment, setPayment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [pendingPayment, setPendingPayment] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('texnobazar.checkout.pending.v1')) || null; } catch { return null; }
  });
  const [paymentState, setPaymentState] = useState(pendingPayment ? 'pending' : '');
  const [paymentMessage, setPaymentMessage] = useState('');
  const attempt = useRef({ fingerprint: '', key: '', token: '' });
  const total = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  useEffect(() => {
    if (!account) return;
    const source = account.customer || account.profile || {};
    const address = safeArray(account.addresses).find(item => item.is_default) || safeArray(account.addresses)[0];
    const defaults = { name: source.full_name || '', phone: source.phone || '', email: source.email || '', address: address?.address?.address || plainValue(address?.address) };
    setForm(current => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, dirtyFields.current.has(key) ? value : (defaults[key] ?? value)])));
  }, [account]);
  useEffect(() => {
    let active = true;
    loadStorefrontPaymentMethods().then(data => {
      if (!active) return;
      const allowed = safeArray(data);
      setMethods(allowed);
      setPayment(current => current && allowed.some(item => item.code === current) ? current : allowed[0]?.code || '');
    }).catch(error => active && setMethodError(errorText(error)));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!pendingPayment) return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      try {
        const status = await getOnlinePaymentStatus({ orderId: pendingPayment.orderId, checkoutToken: pendingPayment.checkoutToken });
        if (!active) return;
        if (status.payment_status === 'paid' || status.state === 'paid') {
          sessionStorage.removeItem('texnobazar.checkout.pending.v1');
          await clearCart();
          if (!active) return;
          setPendingPayment(null); setPaymentState('paid'); setOrderId(String(status.order_id)); setToast('Onlayn to‘lov tasdiqlandi.');
          return;
        }
        if (['cancelled', 'cancelled_after_paid', 'failed'].includes(status.state) || status.payment_status === 'failed') {
          setPaymentState('failed'); setPaymentMessage('To‘lov tasdiqlanmadi. Qayta urinishingiz mumkin.');
          return;
        }
      } catch (error) { if (active) setPaymentMessage(errorText(error)); }
      if (active) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [pendingPayment, clearCart, setToast]);
  const change = event => {
    dirtyFields.current.add(event.target.name);
    setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  };
  const openProvider = async record => {
    setSubmitting(true); setPaymentMessage('');
    try {
      const initiated = await initiateOnlinePayment({ orderId: record.orderId, checkoutToken: record.checkoutToken, provider: record.provider, idempotencyKey: record.paymentKey });
      setPaymentState('pending');
      submitHostedCheckout(initiated.checkout);
    } catch (error) { setPaymentState('failed'); setPaymentMessage(errorText(error)); setToast(errorText(error)); }
    finally { setSubmitting(false); }
  };
  const placeOrder = async () => {
    if (!customerStateReady) return setToast('Hisob ma’lumotlari sinxronlanmoqda. Biroz kuting.');
    const phone = normalizePhone(form.phone);
    if (!form.name.trim()) return setToast('Ismingizni kiriting.');
    if (!/^\+998\d{9}$/.test(phone)) return setToast('Telefon +998XXXXXXXXX formatida bo‘lishi kerak.');
    if (!form.address.trim()) return setToast('Yetkazib berish manzilini kiriting.');
    if (!cartItems.length) return setToast('Savatcha bo‘sh.');
    if (cartItems.some(item => item.qty < 1 || item.qty > item.stock)) return setToast('Savatchadagi miqdor ombor qoldig‘iga mos emas.');
    if (!methods.some(item => item.code === payment)) return setToast('Faol to‘lov usulini tanlang.');
    const payload = {
      customer: { name: form.name.trim(), phone, email: form.email.trim() || undefined },
      shippingAddress: { address: form.address.trim() },
      lines: cartItems.map(item => ({
        product_id: item.productId || item.product_id || String(item.id).split('_')[0],
        variant_id: (item.variantId && item.variantId !== 'standard' && item.variantId !== 'default') ? item.variantId : null,
        batch_id: item.batchId || null,
        quantity: item.qty,
        is_standalone_component: Boolean(item.isStandaloneComponent),
        component_id: item.componentId || null,
        selected_components: item.selectedComponents || [],
        variant_color: item.variantColorName || (item.variantId === 'standard' ? 'Standart' : null)
      })),
      paymentMethodCode: payment,
      notes: form.notes.trim() || null
    };
    const fingerprint = JSON.stringify(payload);
    if (attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: createKey(), token: createCheckoutToken() };
    setSubmitting(true);
    try {
      const result = await submitOnlineOrder({ ...payload, idempotencyKey: attempt.current.key, checkoutToken: attempt.current.token });
      const id = String(result.order_id);
      if (payment === 'click' || payment === 'payme') {
        const record = { orderId: id, checkoutToken: result.checkout_token, provider: payment, paymentKey: createKey() };
        sessionStorage.setItem('texnobazar.checkout.pending.v1', JSON.stringify(record));
        setPendingPayment(record); setPaymentState('pending');
        const initiated = await initiateOnlinePayment({ orderId: id, checkoutToken: record.checkoutToken, provider: payment, idempotencyKey: record.paymentKey });
        submitHostedCheckout(initiated.checkout);
        return;
      }
      setOrderId(id);
      await clearCart();
      setToast('Buyurtma muvaffaqiyatli yaratildi.');
    } catch (error) { setPaymentState(payment === 'click' || payment === 'payme' ? 'failed' : ''); setPaymentMessage(errorText(error)); setToast(errorText(error)); }
    finally { setSubmitting(false); }
  };
  if (orderId) return <section className="container success card"><div><PackageCheck size={70}/></div><h1>Buyurtmangiz qabul qilindi!</h1><p>Buyurtma identifikatori: <b>{orderId}</b>. Holatini {session ? 'shaxsiy kabinetingizda' : 'operator orqali'} kuzatishingiz mumkin.</p><button className="btn btn-primary" onClick={() => go(session ? 'profile' : 'catalog')}>{session ? 'Buyurtmalarim' : 'Xaridni davom ettirish'}</button></section>;
  if (pendingPayment) return <section className="container success card payment-pending"><div>{paymentState === 'pending' ? <LoaderCircle className="spin" size={62}/> : <CreditCard size={62}/>}</div><h1>{paymentState === 'pending' ? 'To‘lov tasdig‘i kutilmoqda' : 'To‘lov yakunlanmadi'}</h1><p>{paymentMessage || 'Click yoki Payme oynasida to‘lovni yakunlang. Bu sahifa faqat server webhook tasdig‘idan keyin muvaffaqiyatli holatni ko‘rsatadi.'}</p><p>Buyurtma: <b>{pendingPayment.orderId}</b></p><button className="btn btn-primary" disabled={submitting} onClick={() => openProvider({ ...pendingPayment, paymentKey: paymentState === 'failed' ? createKey() : pendingPayment.paymentKey })}>{submitting ? 'Kutilmoqda…' : 'To‘lov oynasini ochish'}</button><button className="btn btn-outline" onClick={() => go('catalog')}>Katalogga qaytish</button></section>;
  if (!cartItems.length) return <section className="container checkout"><StatePanel title="Savatchangiz bo‘sh"/><div className="center-action"><button className="btn btn-primary" onClick={() => go('catalog')}>Katalogga qaytish</button></div></section>;
  return <section className="container checkout"><div className="breadcrumbs">Savatcha <ChevronRight/> Rasmiylashtirish</div><h1 className="title">Buyurtmani rasmiylashtirish</h1>{paymentMessage && <InlineError text={paymentMessage}/>}<div className="checkout-layout"><div className="stack"><div className="card pad"><h3>Aloqa ma’lumotlari</h3><div className="form-grid"><label className="field"><span className="label">Ismingiz *</span><input className="input" name="name" value={form.name} onChange={change} autoComplete="name"/></label><label className="field"><span className="label">Telefon raqam *</span><input className="input" name="phone" value={form.phone} onChange={change} placeholder="+998901234567" inputMode="tel" autoComplete="tel"/></label><label className="field"><span className="label">E-pochta</span><input className="input" name="email" type="email" value={form.email} onChange={change} autoComplete="email"/></label></div></div><div className="card pad"><h3>Yetkazib berish manzili</h3><label className="field"><span className="label">Ko‘cha, uy va xonadon *</span><input className="input" name="address" value={form.address} onChange={change} autoComplete="street-address"/></label><label className="field"><span className="label">Buyurtma izohi</span><textarea className="textarea" name="notes" value={form.notes} onChange={change}/></label></div><div className="card pad"><h3>To‘lov usuli</h3>{methodError ? <InlineError text={methodError}/> : methods.length ? <div className="choice-grid">{methods.map(method => <Choice key={method.code} checked={payment === method.code} onClick={() => setPayment(method.code)} icon={CreditCard} title={plainValue(method.name)} text={method.is_cash ? 'Qabul qilganda' : 'Xavfsiz hosted onlayn to‘lov'}/>)}</div> : <p className="muted">Faol va sozlangan to‘lov usuli topilmadi.</p>}</div></div><OrderTotal total={total} count={cartItems.reduce((sum, item) => sum + item.qty, 0)} onClick={placeOrder} disabled={!payment || !!methodError || !customerStateReady} loading={submitting}/></div></section>;
}

function submitHostedCheckout(checkout) {
  const url = new URL(String(checkout?.url || ''));
  if (url.protocol !== 'https:') throw new Error('To‘lov manzili xavfsiz emas.');
  if (checkout.method === 'GET') { window.location.assign(url.toString()); return; }
  if (checkout.method !== 'POST') throw new Error('To‘lov usuli qo‘llab-quvvatlanmaydi.');
  const form = document.createElement('form');
  form.method = 'POST'; form.action = url.toString();
  for (const [name, value] of Object.entries(checkout.fields || {})) {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = String(value); form.appendChild(input);
  }
  document.body.appendChild(form); form.submit(); form.remove();
}
function Choice({ checked, onClick, icon: Icon, title, text }) { return <button type="button" className={`choice ${checked ? 'selected' : ''}`} onClick={onClick} aria-pressed={checked}><Icon/><span><b>{title}</b><small>{text}</small></span>{checked && <Check/>}</button>; }

function AuthDialog({ onClose, onSuccess, setToast }) {
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ email: '', password: '', fullName: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const firstInput = useRef(null);
  useEffect(() => { firstInput.current?.focus(); const onKey = event => event.key === 'Escape' && onClose(); document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, [onClose]);
  const submit = async event => {
    event.preventDefault(); setBusy(true);
    try {
      if (mode === 'signin') await signInCustomer(form.email.trim(), form.password);
      else {
        if (!form.fullName.trim() || !/^\+998\d{9}$/.test(normalizePhone(form.phone))) throw new Error('Ism va +998XXXXXXXXX formatidagi telefon talab qilinadi.');
        const result = await signUpCustomer({ email: form.email.trim(), password: form.password, fullName: form.fullName.trim(), phone: normalizePhone(form.phone) });
        if (!result.session) { setToast('Ro‘yxatdan o‘tildi. E-pochtangizdagi tasdiqlash havolasini oching.'); onClose(); return; }
        await saveCustomerProfile({ full_name: form.fullName.trim(), phone: normalizePhone(form.phone), email: form.email.trim() });
      }
      setToast(mode === 'signin' ? 'Kabinetga kirdingiz.' : 'Profil yaratildi.'); onSuccess();
    } catch (error) { setToast(errorText(error)); }
    finally { setBusy(false); }
  };
  const change = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="auth-dialog card" role="dialog" aria-modal="true" aria-labelledby="auth-title"><button className="dialog-close" onClick={onClose} aria-label="Yopish"><X/></button><h2 id="auth-title">{mode === 'signin' ? 'Kabinetga kirish' : 'Ro‘yxatdan o‘tish'}</h2><form onSubmit={submit} className="stack">{mode === 'signup' && <><label className="field"><span className="label">To‘liq ism</span><input ref={firstInput} className="input" name="fullName" value={form.fullName} onChange={change} required autoComplete="name"/></label><label className="field"><span className="label">Telefon</span><input className="input" name="phone" value={form.phone} onChange={change} required placeholder="+998901234567" autoComplete="tel"/></label></>}<label className="field"><span className="label">E-pochta</span><input ref={mode === 'signin' ? firstInput : undefined} className="input" name="email" type="email" value={form.email} onChange={change} required autoComplete="email"/></label><label className="field"><span className="label">Parol</span><input className="input" name="password" type="password" minLength="6" value={form.password} onChange={change} required autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}/></label><button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Kutilmoqda…' : mode === 'signin' ? 'Kirish' : 'Ro‘yxatdan o‘tish'}</button></form><button className="auth-switch" onClick={() => setMode(value => value === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'Hisob yo‘qmi? Ro‘yxatdan o‘ting' : 'Hisobingiz bormi? Kiring'}</button></section></div>;
}

function Profile({ go, session, account, accountError, refreshAccount, favorites, catalog, setAuthOpen, setToast }) {
  const [tab, setTab] = useState('orders');
  const [orders, setOrders] = useState({ items: [], total: 0, loading: false, error: '' });
  const [notifications,setNotifications]=useState({items:[],unread:0,loading:false,error:''});
  const loadNotifications=useCallback(async()=>{if(!session)return;setNotifications(current=>({...current,loading:true,error:''}));try{const result=await listNotifications({pageSize:50});setNotifications({items:safeArray(result?.items),unread:numberOf(result?.unread_count),loading:false,error:''})}catch(error){setNotifications({items:[],unread:0,loading:false,error:errorText(error)})}},[session]);
  const loadOrders = useCallback(async () => {
    if (!session) return;
    setOrders(current => ({ ...current, loading: true, error: '' }));
    try { const result = await loadCustomerOrders({ page: 1, pageSize: 50 }); setOrders({ items: safeArray(result?.items), total: numberOf(result?.total), loading: false, error: '' }); }
    catch (error) { setOrders({ items: [], total: 0, loading: false, error: errorText(error) }); }
  }, [session]);
  useEffect(() => { if (session) {loadOrders();loadNotifications();} }, [session, loadOrders,loadNotifications]);
  useEffect(()=>session?.user?.id?subscribeNotifications(loadNotifications,()=>{},session.user.id):undefined,[session?.user?.id,loadNotifications]);
  if (!session) return <section className="container profile-page"><div className="auth-prompt card"><User size={54}/><h1>Shaxsiy kabinet</h1><p>Profil, manzillar va buyurtmalar tarixini ko‘rish uchun hisobingizga kiring.</p><button className="btn btn-primary" onClick={() => setAuthOpen(true)}>Kirish yoki ro‘yxatdan o‘tish</button></div></section>;
  if (!account) return <section className="container profile-page"><StatePanel loading={!accountError} error={accountError} onRetry={refreshAccount}/></section>;
  const profile = account.customer || account.profile || {};
  const signOut = async () => {
    if (!window.confirm('Hisobdan chiqishni tasdiqlaysizmi?')) return;
    try { await signOutCustomer(); setToast('Hisobdan chiqdingiz.'); go('home'); } catch (error) { setToast(errorText(error)); }
  };
  return <section className="container profile-page"><h1 className="title">Shaxsiy kabinet</h1>{accountError && <InlineError text={accountError} onRetry={refreshAccount}/>}<div className="profile-layout"><aside className="card profile-menu"><div className="profile-user"><div className="avatar">{String(profile.full_name || profile.email || 'U').slice(0, 2).toUpperCase()}</div><div><b>{plainValue(profile.full_name) || 'Mijoz'}</b><span>{plainValue(profile.phone || profile.email)}</span></div></div>{[['orders', 'Buyurtmalarim'], ['notifications', `Bildirishnomalar${notifications.unread?` (${notifications.unread})`:''}`], ['info', 'Shaxsiy ma’lumotlar'], ['address', 'Manzillarim'], ['favorites', 'Saralanganlar']].map(item => <button className={tab === item[0] ? 'active' : ''} onClick={() => setTab(item[0])} key={item[0]}>{item[1]}<ChevronRight/></button>)}<button onClick={signOut}>Hisobdan chiqish<ChevronRight/></button></aside><div className="card pad">{tab === 'orders' && <OrdersPanel orders={orders} onRetry={loadOrders}/>} {tab === 'notifications' && <CustomerNotifications state={notifications} reload={loadNotifications}/>} {tab === 'info' && <ProfileForm profile={profile} onSaved={refreshAccount} setToast={setToast}/>} {tab === 'address' && <AddressesPanel addresses={safeArray(account?.addresses)} onSaved={refreshAccount} setToast={setToast}/>} {tab === 'favorites' && <FavoritesPanel favorites={favorites} catalog={catalog} go={go}/>}</div></div></section>;
}
function CustomerNotifications({state,reload}){const mark=async ids=>{await markNotificationsRead(ids);await reload()};if(state.loading)return <StatePanel loading/>;if(state.error)return <StatePanel error={state.error} onRetry={reload}/>;return <><div className="between"><h2>Bildirishnomalar</h2><button className="btn btn-outline" disabled={!state.unread} onClick={()=>mark(null)}>Barchasini o‘qish</button></div>{state.items.length?<div className="customer-notifications">{state.items.map(item=><button key={item.id} className={item.read_at?'':'unread'} onClick={()=>!item.read_at&&mark([item.id])}><span><b>{item.title}</b><small>{item.body}</small><time>{new Date(item.created_at).toLocaleString('uz-UZ')}</time></span>{!item.read_at&&<Status type="orange">Yangi</Status>}</button>)}</div>:<Empty title="Bildirishnoma yo‘q" text="Buyurtma yangiliklari shu yerda ko‘rinadi."/>}</>}
function OrdersPanel({ orders, onRetry }) {
  if (orders.loading) return <StatePanel loading/>;
  if (orders.error) return <StatePanel error={orders.error} onRetry={onRetry}/>;
  return <><h2>Buyurtmalarim</h2>{orders.items.length ? <div className="stack">{orders.items.map(order => <article className="order-card" key={order.id}><div className="between"><div><b>{plainValue(order.order_no) || order.id}</b><span>{order.placed_at ? new Date(order.placed_at).toLocaleString('uz-UZ') : ''}</span></div><Status type={order.status === 'cancelled' ? 'red' : order.status === 'delivered' ? 'green' : 'blue'}>{plainValue(order.status)}</Status></div><div className="order-lines">{safeArray(order.lines).map(line => <div className="between" key={`${line.product_id}-${line.sku}`}><span>{plainValue(line.product_name)} × {numberOf(line.quantity)}</span><b>{money(line.line_total)}</b></div>)}</div><div className="between grand"><span>Jami</span><b>{money(order.total)}</b></div></article>)}</div> : <Empty title="Buyurtmalar yo‘q" text="Birinchi buyurtmangiz bu yerda ko‘rinadi."/>}</>;
}
function ProfileForm({ profile, onSaved, setToast }) {
  const [form, setForm] = useState({ full_name: profile.full_name || '', phone: profile.phone || '', email: profile.email || '' });
  const [busy, setBusy] = useState(false);
  const submit = async event => { event.preventDefault(); if (!form.full_name.trim()) return setToast('To‘liq ism talab qilinadi.'); setBusy(true); try { await saveCustomerProfile({ full_name: form.full_name.trim(), phone: normalizePhone(form.phone) || null, email: form.email.trim() || null, address: profile.address && typeof profile.address === 'object' ? profile.address : {} }); await onSaved(); setToast('Profil saqlandi.'); } catch (error) { setToast(errorText(error)); } finally { setBusy(false); } };
  return <form onSubmit={submit}><h2>Shaxsiy ma’lumotlar</h2><div className="form-grid"><label className="field"><span className="label">To‘liq ism</span><input className="input" value={form.full_name} onChange={event => setForm({ ...form, full_name: event.target.value })} required/></label><label className="field"><span className="label">Telefon</span><input className="input" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })}/></label><label className="field"><span className="label">E-pochta</span><input className="input" type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })}/></label></div><button className="btn btn-primary form-submit" disabled={busy}>Saqlash</button></form>;
}
function AddressesPanel({ addresses, onSaved, setToast }) {
  const empty = { id: '', label: '', recipient_name: '', phone: '', addressText: '', addressObject: {}, is_default: false };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const edit = item => setForm({ id: item.id, label: item.label || '', recipient_name: item.recipient_name || '', phone: item.phone || '', addressText: item.address?.address || plainValue(item.address), addressObject: item.address && typeof item.address === 'object' ? item.address : {}, is_default: !!item.is_default });
  const submit = async event => { event.preventDefault(); setBusy(true); try { await saveCustomerAddress({ ...(form.id ? { id: form.id } : {}), label: form.label.trim(), recipient_name: form.recipient_name.trim(), phone: normalizePhone(form.phone), address: { ...form.addressObject, address: form.addressText.trim() }, is_default: form.is_default }); setForm(empty); await onSaved(); setToast('Manzil saqlandi.'); } catch (error) { setToast(errorText(error)); } finally { setBusy(false); } };
  const remove = async id => { if (!window.confirm('Manzilni o‘chirasizmi?')) return; try { await removeCustomerAddress(id); await onSaved(); setToast('Manzil o‘chirildi.'); } catch (error) { setToast(errorText(error)); } };
  return <><h2>Manzillarim</h2><div className="address-list">{addresses.map(item => <article className="order-card" key={item.id}><div className="between"><b>{plainValue(item.label)}</b>{item.is_default && <Status type="green">Asosiy</Status>}</div><p>{plainValue(item.recipient_name)} · {plainValue(item.phone)}</p><p>{plainValue(item.address)}</p><div className="row"><button className="btn btn-outline" onClick={() => edit(item)}>Tahrirlash</button><button className="btn btn-danger" onClick={() => remove(item.id)}>O‘chirish</button></div></article>)}</div><form onSubmit={submit} className="address-form"><h3>{form.id ? 'Manzilni tahrirlash' : 'Yangi manzil'}</h3><div className="form-grid"><label className="field"><span className="label">Nomi</span><input className="input" value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} required/></label><label className="field"><span className="label">Qabul qiluvchi</span><input className="input" value={form.recipient_name} onChange={event => setForm({ ...form, recipient_name: event.target.value })} required/></label><label className="field"><span className="label">Telefon</span><input className="input" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} required/></label><label className="field"><span className="label">To‘liq manzil</span><input className="input" value={form.addressText} onChange={event => setForm({ ...form, addressText: event.target.value })} required/></label><label className="check-field"><input type="checkbox" checked={form.is_default} onChange={event => setForm({ ...form, is_default: event.target.checked })}/> Asosiy manzil</label></div><div className="row form-submit"><button className="btn btn-primary" disabled={busy}>Saqlash</button>{form.id && <button type="button" className="btn btn-outline" onClick={() => setForm(empty)}>Bekor qilish</button>}</div></form></>;
}
function FavoritesPanel({ favorites, catalog, go }) {
  const products = catalog.filter(item => favorites.includes(item.id));
  return <><h2>Saralanganlar</h2>{products.length ? <div className="favorite-list">{products.map(product => <button className="order-card between" onClick={() => go('product', product)} key={product.id}><span>{product.name}</span><b>{money(product.price)}</b></button>)}</div> : <Empty title="Saralanganlar yo‘q" text="Yoqtirgan mahsulotlaringizni yurakcha orqali saqlang."/>}</>;
}
function FavoritesPage({ favorites, catalog, go, add, toggleFavorite }) {
  const products = catalog.filter(item => favorites.includes(item.id));
  return <div className="container favorites-page"><div className="section-head"><div><h2 className="section-title">Saralangan mahsulotlar</h2><span className="muted">{products.length} ta mahsulot</span></div></div>{products.length ? <div className="product-grid">{products.map(product => <ProductCard key={product.id} product={product} {...{ go, add, toggleFavorite }} loved={true}/>)}</div> : <div className="favorites-empty"><Heart size={48}/><h2>Saralanganlar bo'sh</h2><p>Yoqtirgan mahsulotlaringizni yurakcha tugmasini bosib saqlang.</p><button className="btn btn-primary" onClick={() => go('catalog')}>Katalogga o'tish</button></div>}</div>;
}


function SocialIcons({settings,size=20}){
  const socials=[
    ['social_telegram','Telegram','M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z'],
    ['social_instagram','Instagram','M7.8 2h8.4C19.4 2 22 4.6 22 7.8v8.4a5.8 5.8 0 01-5.8 5.8H7.8C4.6 22 2 19.4 2 16.2V7.8A5.8 5.8 0 017.8 2m-.2 2A3.6 3.6 0 004 7.6v8.8C4 18.39 5.61 20 7.6 20h8.8a3.6 3.6 0 003.6-3.6V7.6C20 5.61 18.39 4 16.4 4H7.6m9.65 1.5a1.25 1.25 0 110 2.5 1.25 1.25 0 010-2.5M12 7a5 5 0 110 10 5 5 0 010-10m0 2a3 3 0 100 6 3 3 0 000-6z'],
    ['social_facebook','Facebook','M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z'],
    ['social_youtube','YouTube','M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3-5.2 3z'],
    ['social_tiktok','TikTok','M16.6 5.82s.51.49 1.86.49V8.5c-.52 0-1.34-.16-1.86-.49v4.5c0 2.49-2.01 4.5-4.5 4.5s-4.5-2.01-4.5-4.5 2.01-4.5 4.5-4.5v2.19c-1.28 0-2.31 1.03-2.31 2.31 0 1.28 1.03 2.31 2.31 2.31 1.28 0 2.31-1.03 2.31-2.31V2h2.19v3.82z'],
  ];
  const items=socials.map(([key,label,svgPath])=>[siteText(settings,key,''),label,svgPath]).filter(([url])=>url);
  if(!items.length)return null;
  return <div className="social-icons">{items.map(([url,label,svgPath])=><a key={label} href={url} target="_blank" rel="noopener noreferrer" className="social-icon" aria-label={label}><svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size}><path d={svgPath}/></svg></a>)}</div>;
}
function Footer({ go, settings, pages, menuItems, navigateTarget }) {
  const siteName=siteText(settings,'site_name','Texnobazar');
  const phone=siteText(settings,'support_phone'),address=siteText(settings,'company_address',''),workHours=siteText(settings,'work_hours','');
  return <footer>
    <div className="container footer-compact">
      <div className="footer-brand">
        <Logo go={go} siteName={siteName}/>
        <p>{siteText(settings,'footer_text','Texnika olamidagi ishonchli hamrohingiz.')}</p>
      </div>
      <div className="footer-contact-row">
        {phone&&<a href={`tel:${phone.replace(/\s/g,'')}`} className="footer-phone"><Phone size={18}/><span>{phone}</span></a>}
        {address&&<span className="footer-address"><MapPin size={16}/><span>{address}</span></span>}
        {workHours&&<span className="footer-hours"><span>Ish vaqti: {workHours}</span></span>}
        <SocialIcons settings={settings} size={24}/>
      </div>
    </div>
    <div className="container footer-bottom">
      <span>{'©'} {new Date().getFullYear()} {siteName}. Barcha huquqlar himoyalangan.</span>
      <span>{siteText(settings,'payment_label','Click · Payme · Naqd')}</span>
    </div>
  </footer>;
}
function MobileNav({ go, cart, route, settings, favorites = [] }) { const item=(view,Icon,label,badge)=><button className={route?.view===view?'active':''} onClick={()=>go(view)}><Icon/>{badge>0&&<i>{badge}</i>}<span>{label}</span></button>;return <nav className="mobile-nav" aria-label="Mobil navigatsiya">{item('home',HomeIcon,siteText(settings,'nav_home_label','Bosh sahifa'))}{item('catalog',Grid2X2,siteText(settings,'catalog_button_label','Katalog'))}<button onClick={()=>go('favorites')} className={`mob-fav ${route?.view==='favorites'?'active':''}`}><Heart/>{favorites.length>0&&<i>{favorites.length}</i>}<span>Saralangan</span></button><button onClick={()=>go('cart')} className={`mob-cart ${route?.view==='cart'?'active':''}`}><ShoppingCart/>{cart.length>0&&<i>{cart.reduce((sum,item)=>sum+item.qty,0)}</i>}<span>{siteText(settings,'label_cart','Savatcha')}</span></button>{item('profile',User,siteText(settings,'label_account','Kabinet'))}</nav>; }
function LoadingGrid() { return <div className="loading-grid" aria-live="polite">{Array.from({ length: 8 }, (_, index) => <div className="product-skeleton" key={index}/>)}</div>; }
function InlineError({ text, onRetry }) { return <div className="container inline-error" role="alert"><span>{text}</span>{onRetry && <button className="btn btn-outline" onClick={onRetry}>Qayta urinish</button>}</div>; }
function StatePanel({ loading, error, onRetry, title }) { return <div className="state-panel card" role={error ? 'alert' : 'status'}>{loading ? <><LoaderCircle className="spin"/><h2>Yuklanmoqda…</h2></> : <><h2>{error ? 'Ma’lumotni yuklab bo‘lmadi' : title || 'Ma’lumot topilmadi'}</h2>{error && <p>{error}</p>}{onRetry && <button className="btn btn-primary" onClick={onRetry}>Qayta urinish</button>}</>}</div>; }
