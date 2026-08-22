import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, BadgePercent, Check, ChevronLeft, ChevronRight, CreditCard, Grid2X2, Heart,
  Home as HomeIcon, LoaderCircle, MapPin, Menu, Minus, PackageCheck, Phone, Plus,
  Search, Send, ShieldCheck, ShoppingCart, SlidersHorizontal, Sparkles, Star, Trash2, Truck,
  User, X,
} from 'lucide-react';
import { Empty, Status, ThemeToggle, Toast } from '@texnobazar/ui';
import {
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
const adaptProduct = raw => ({
  ...raw,
  id: String(raw.id),
  name: String(raw.name || 'Nomsiz mahsulot'),
  slug: String(raw.slug || raw.id),
  description: String(raw.description || ''),
  descriptionBlocks: safeArray(raw.description_blocks),
  media: safeArray(raw.media),
  hasDetail: Object.prototype.hasOwnProperty.call(raw, 'description_blocks') && Object.prototype.hasOwnProperty.call(raw, 'media'),
  sku: String(raw.sku || ''),
  image: raw.primary_media_url || '',
  seoTitle: String(raw.seo_title || ''),
  seoDescription: String(raw.seo_description || ''),
  seoImage: String(raw.seo_image_url || raw.primary_media_url || ''),
  price: numberOf(raw.promotion_price || raw.retail_price),
  oldPrice: numberOf(raw.compare_at_price || (raw.promotion_price ? raw.retail_price : 0)),
  stock: Math.max(0, Math.trunc(numberOf(raw.available_stock))),
  attributes: safeArray(raw.attributes).map(item => ({ code: String(item.code || item.name || ''), name: String(item.name || item.code || ''), value: plainValue(item.value) })),
  categoryId: raw.category_id ? String(raw.category_id) : '',
  brandId: raw.brand_id ? String(raw.brand_id) : '',
});
const parseRoute = () => {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/qr/')) return { view: 'qr', code: decodeURIComponent(path.slice(4)) };
  if (path.startsWith('/product/')) return { view: 'product', slug: decodeURIComponent(path.slice(9)) };
  if (path.startsWith('/category/')) return { view: 'category', slug: decodeURIComponent(path.slice(10)) };
  if (path.startsWith('/page/')) return { view: 'page', slug: decodeURIComponent(path.slice(6)) };
  if (['/catalog', '/cart', '/checkout', '/profile', '/favorites'].includes(path)) return { view: path.slice(1) };
  return { view: 'home' };
};
const routePath = (view, product) => view === 'home' ? '/' : ['product','category','page'].includes(view) ? `/${view}/${encodeURIComponent(product?.slug || '')}` : `/${view}`;

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
  const [cart, setCart] = useState(() => safeArray(storageRead(ANON_CART_KEY, [])).map(item => ({ id: String(item.id), qty: Math.max(1, Math.trunc(numberOf(item.qty))) })));
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
      adapted.forEach(product => merged.set(product.id, product));
      return [...merged.values()];
    });
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogState({ loading: true, error: '' });
    try {
      const first = await loadStorefrontCatalog({ page: 1, pageSize: 100, sort: 'name' });
      mergeCatalogProducts(first?.items);
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
        return { id: item.id, qty: product ? Math.min(item.qty, product.stock, 100) : Math.min(item.qty, 100) };
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
    const remoteCart = new Map(safeArray(account.cart).map(item => [String(item.product_id), Math.max(1, Math.trunc(numberOf(item.quantity))) ]));
    const requestedCart = new Map([...remoteCart, ...cart.map(item => [item.id, Math.max(item.qty, remoteCart.get(item.id) || 0)])]);
    const mergedCart = new Map();
    requestedCart.forEach((qty, id) => {
      const product = productsById.get(id);
      const safeQuantity = product ? Math.min(qty, product.stock, 100) : Math.min(qty, 100);
      if (safeQuantity > 0) mergedCart.set(id, safeQuantity);
    });
    const mergedFavorites = [...new Set([...safeArray(account.favorites).map(String), ...favorites])];
    const sync = async () => {
      if (activeUserId.current !== userId || accountOwnerId.current !== userId) return;
      const results = await Promise.allSettled([
        ...[...mergedCart].map(([id, qty]) => setCustomerCartItem(id, qty)),
        ...mergedFavorites.map(id => setCustomerFavorite(id, true)),
      ]);
      if (!cancelled) {
        mergedAccountUserId.current = { userId, pending: false };
        setCart([...mergedCart].map(([id, qty]) => ({ id, qty })));
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
      const qty = product ? Math.min(item.qty, product.stock, 100) : item.qty;
      if (product && qty !== item.qty) changed.push([item.id, qty]);
      return qty > 0 ? { id: item.id, qty } : null;
    }).filter(Boolean);
    if (changed.length) {
      setCart(next);
      if (session) Promise.all(changed.map(([id, qty]) => setCustomerCartItem(id, qty))).catch(error => setToast(errorText(error)));
    }
    // Reconcile only products actually present in the hydrated cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsById, catalogState.loading, catalogState.error, session?.user?.id]);

  useEffect(() => { if (!session) { anonymousCart.current = cart; storageWrite(ANON_CART_KEY, cart); } }, [cart]);
  useEffect(() => { if (!session) { anonymousFavorites.current = favorites; storageWrite(ANON_FAV_KEY, favorites); } }, [favorites]);

  const cartItems = useMemo(() => cart.map(item => ({ ...productsById.get(item.id), id: item.id, qty: item.qty })).filter(item => item.name), [cart, productsById]);
  const selected = route.view === 'product' ? catalog.find(product => product.slug === route.slug) : null;
  useEffect(() => {
    if (route.view !== 'product' || selected?.hasDetail || !route.slug) return;
    let active = true;setDetailState({ loading: true, error: '' });
    loadStorefrontProduct(route.slug).then(raw => { if (!active) return;if (!raw) throw new Error('Mahsulot topilmadi.');mergeCatalogProducts([raw]);setDetailState({loading:false,error:''}); }).catch(error => active&&setDetailState({loading:false,error:errorText(error)}));
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
    const next = ['product','category','page'].includes(view) ? { view, slug: product.slug } : { view };
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

  const updateCart = async (product, nextQuantity, message = '') => {
    if (!customerStateReady) { setToast('Hisob ma’lumotlari sinxronlanmoqda. Biroz kuting.'); return; }
    const quantity = Math.max(0, Math.min(Math.trunc(nextQuantity), product.stock));
    setCart(current => quantity ? [...current.filter(item => item.id !== product.id), { id: product.id, qty: quantity }] : current.filter(item => item.id !== product.id));
    try {
      if (session) await setCustomerCartItem(product.id, quantity);
      if (message) setToast(message);
    } catch (error) { setToast(errorText(error)); refreshAccount(); }
  };
  const add = product => {
    if (product.stock < 1) return;
    const existing = cart.find(item => item.id === product.id)?.qty || 0;
    if (existing >= product.stock) { setToast('Ombordagi mavjud miqdordan oshirib bo‘lmaydi.'); return; }
    updateCart(product, existing + 1, 'Mahsulot savatchaga qo‘shildi');
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
    const ids = cart.map(item => item.id);
    setCart([]);
    storageWrite(ANON_CART_KEY, []);
    if (session) await Promise.all(ids.map(id => setCustomerCartItem(id, 0)));
  };

  if (!authReady) return <div className="app-loading"><div className="app-loading-logo"><span>T</span></div><div className="app-loading-bar"><div className="app-loading-progress"/></div><b>Texnobazar yuklanmoqda...</b></div>;
  if (catalogState.loading && cmsState.loading && !catalog.length) return <div className="app-skeleton"><div className="skeleton-header"/><div className="skeleton-banner"/><div className="container"><div className="skeleton-grid">{Array.from({length:8},(_,i)=><div className="product-skeleton" key={i}/>)}</div></div></div>;
  return <>
  <Header {...{ go, cart, favorites, query, setQuery, menu, setMenu, session, navigateTarget, route, references }} settings={cms.settings} menuItems={safeArray(cms.menu_items)}/>
    <main>
      {route.view === 'home' && <Home {...{ go, add, toggleFavorite, favorites, catalog, cms, catalogState, cmsState, loadCatalog, loadCms, navigateTarget, references, mergeCatalogProducts }}/>} 
      {route.view === 'qr' && <QrResolver code={route.code} go={go}/>}
      {route.view === 'catalog' && <ServerCatalog {...{ go, add, toggleFavorite, favorites, query, setQuery, references, navigateTarget }} cmsBanners={safeArray(cms.banners)} onItemsLoaded={mergeCatalogProducts}/>} 
      {route.view === 'product' && (selected ? <Product product={selected} {...{ go, add, toggleFavorite, favorites, session, setToast }} loved={favorites.includes(selected.id)} related={catalog.filter(item => item.id !== selected.id && (item.categoryId === selected.categoryId || item.brandId === selected.brandId)).slice(0, 5)}/> : <StatePanel loading={detailState.loading||catalogState.loading} error={detailState.error||catalogState.error} onRetry={()=>loadStorefrontProduct(route.slug).then(raw=>raw&&mergeCatalogProducts([raw]))} title="Mahsulot topilmadi"/>)}
      {route.view === 'category' && (selectedCategory ? <CategoryLanding key={selectedCategory.id} category={selectedCategory} {...{go,add,toggleFavorite,favorites,query,setQuery,references,navigateTarget}} cmsBanners={safeArray(cms.banners)} onItemsLoaded={mergeCatalogProducts}/> : <StatePanel loading={catalogState.loading} error={catalogState.error} onRetry={loadCatalog} title="Kategoriya topilmadi"/>)}
      {route.view === 'page' && (selectedPage ? <CmsPage page={selectedPage}/> : <StatePanel loading={cmsState.loading} error={cmsState.error} onRetry={loadCms} title="Sahifa topilmadi"/>)}
      {route.view === 'cart' && <Cart {...{ cartItems, go, updateCart }}/>}
      {route.view === 'favorites' && <FavoritesPage {...{ favorites, catalog, go, add, toggleFavorite }}/>}
      {route.view === 'checkout' && <Checkout {...{ cartItems, go, session, account, clearCart, setToast, customerStateReady }}/>} 
      {route.view === 'profile' && <Profile {...{ go, session, account, accountError, refreshAccount, favorites, catalog, setAuthOpen, setToast }}/>} 
    </main>
    <Footer go={go} settings={cms.settings} pages={safeArray(cms.pages)} menuItems={safeArray(cms.menu_items)} navigateTarget={navigateTarget}/>
    <MobileNav go={go} cart={cart} route={route} settings={cms.settings} favorites={favorites}/>
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
  const[catalogOpen,setCatalogOpen]=useState(false),[activeRootId,setActiveRootId]=useState('');
  const catalogRoots=useMemo(()=>{const roots=safeArray(references?.categoryRoots);return roots.length?roots:navItems.filter(item=>item.category).map(item=>item.category)},[references,navItems]);
  const activeRoot=catalogRoots.find(root=>String(root.id)===String(activeRootId))||catalogRoots[0]||null;
  const activeGroups=safeArray(activeRoot?.children),hasDeepGroups=activeGroups.some(group=>safeArray(group.children).length>0);
  const openCategory=category=>{setCatalogOpen(false);go('category',category)};
  useEffect(()=>{if(!catalogOpen)return;const onKey=event=>{if(event.key==='Escape')setCatalogOpen(false)};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[catalogOpen]);
  useEffect(()=>{setCatalogOpen(false)},[route?.view,route?.slug]);
  useEffect(()=>{if(catalogOpen)setActiveRootId(current=>current||String(catalogRoots[0]?.id||''))},[catalogOpen,catalogRoots]);
  return <><header className="site-header"><div className="container header-main"><Logo go={go} siteName={siteName}/><button className={catalogOpen?'btn catalog-btn open':'btn catalog-btn'} onClick={()=>setCatalogOpen(value=>!value)} aria-expanded={catalogOpen} aria-label={catalogLabel}>{catalogOpen?<X size={18}/>:<Menu size={18}/>}<span>{catalogLabel}</span></button><label className="search"><Search size={18}/><span className="sr-only">Mahsulot qidirish</span><input value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>event.key==='Enter'&&submitSearch()} placeholder={searchPlaceholder}/><button onClick={submitSearch} aria-label="Qidirish"><Search size={17}/></button></label><div className="header-actions"><HeaderAction icon={User} text={session?accountLabel:'Kirish'} onClick={()=>go('profile')}/><HeaderAction icon={Heart} text={favoritesLabel} count={favorites.length} onClick={()=>go('profile')}/><HeaderAction icon={ShoppingCart} text={cartLabel} count={cart.reduce((sum,item)=>sum+item.qty,0)} onClick={()=>go('cart')}/><SocialIcons settings={settings}/></div><ThemeToggle/><button className="icon-btn mobile-menu" onClick={()=>setMenu(!menu)} aria-expanded={menu} aria-label="Menyuni ochish">{menu?<X/>:<Menu/>}</button></div>{catalogOpen&&<div className="catalog-mega desktop-only"><div className="container catalog-mega-inner">
    <aside className="catalog-mega-roots" aria-label="Katalog bo‘limlari">
      {catalogRoots.map(root=><button key={root.id} className={String(root.id)===String(activeRoot?.id)?'catalog-mega-root active':'catalog-mega-root'} onMouseEnter={()=>setActiveRootId(String(root.id))} onFocus={()=>setActiveRootId(String(root.id))} onClick={()=>openCategory(root)}><span>{plainValue(root.name)}</span>{safeArray(root.children).length>0&&<ChevronRight size={15}/>}</button>)}
      <button className="catalog-mega-root catalog-mega-all" onClick={()=>{setCatalogOpen(false);go('catalog')}}><span><Grid2X2 size={15}/> Barcha mahsulotlar</span></button>
      {saleLabel&&<button className="catalog-mega-root catalog-mega-sale" onClick={()=>{setCatalogOpen(false);navigateTarget(saleUrl||'/catalog')}}><span><BadgePercent size={15}/> {saleLabel}</span></button>}
    </aside>
    <div className="catalog-mega-panel">
      {activeRoot&&<><button className="catalog-mega-title" onClick={()=>openCategory(activeRoot)}>{plainValue(activeRoot.name)}</button>
      {activeGroups.length===0
        ? <p className="catalog-mega-empty">Bu bo‘limda ichki kategoriya yo‘q. Barcha mahsulotlarni ko‘rish uchun bo‘lim nomini bosing.</p>
        : hasDeepGroups
          ? <div className="catalog-mega-columns">{activeGroups.map(group=><div className="catalog-mega-group" key={group.id}><button className="catalog-mega-group-head" onClick={()=>openCategory(group)}>{plainValue(group.name)}</button>{safeArray(group.children).map(leaf=><button className="catalog-mega-leaf" key={leaf.id} onClick={()=>openCategory(leaf)}>{plainValue(leaf.name)}</button>)}</div>)}</div>
          : <div className="catalog-mega-flat">{activeGroups.map(group=><button className="catalog-mega-leaf" key={group.id} onClick={()=>openCategory(group)}>{plainValue(group.name)}</button>)}</div>}
      </>}
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
    {!hasProductBlock&&<ProductSection kicker={siteText(settings,'featured_kicker','TANLANGAN MAHSULOTLAR')} title={siteText(settings,'featured_title','Siz uchun tanladik')} subtitle={siteText(settings,'featured_subtitle','Ombordagi haqiqiy qoldiqqa ega yangi mahsulotlar')} list={[...catalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,10)} {...{go,add,toggleFavorite,favorites}} state={catalogState} onRetry={loadCatalog}/>}
    {safeArray(cms.pages).length>0&&<section className="container section info-section"><div className="section-head"><div><span className="section-kicker">{siteText(settings,'pages_kicker','YORDAM MARKAZI')}</span><h2 className="section-title">{siteText(settings,'pages_title','Kerakli ma’lumotlar')}</h2></div></div><div className="page-grid">{safeArray(cms.pages).slice(0,6).map(page=><button className="info-link card" key={page.id} onClick={()=>go('page',page)}><FileTextIcon/><span><b>{plainValue(page.title)}</b><small>Batafsil ma’lumot</small></span><ChevronRight/></button>)}</div></section>}
  </>;
}
function FeatureStrip({settings}){
  const defaults=[['Tezkor yetkazib berish','Buyurtmangiz ko‘rsatilgan manzilga yetkaziladi'],['Rasmiy kafolat','Barcha mahsulotlar rasmiy kafolat bilan sotiladi'],['Qulay to‘lov','Naqd yoki onlayn to‘lov usulini tanlang'],['Real ombor qoldig‘i','Saytdagi miqdor ombor bilan bir xil']];
  const icons=[Truck,ShieldCheck,CreditCard,PackageCheck];
  const items=defaults.map((entry,index)=>({Icon:icons[index],title:siteText(settings,`feature_${index+1}_title`,entry[0]),text:siteText(settings,`feature_${index+1}_text`,entry[1])})).filter(item=>item.title);
  if(!items.length)return null;
  return <section className="container feature-strip">{items.map(({Icon,title,text})=><article key={title}><span><Icon size={20}/></span><div><b>{title}</b><small>{text}</small></div></article>)}</section>;
}
function CategoryRail({kicker='KATEGORIYALAR',title,categories,go,id}){
  const railRef=useRef(null),[edges,setEdges]=useState({start:true,end:false});
  const syncEdges=useCallback(()=>{const node=railRef.current;if(!node)return;const max=node.scrollWidth-node.clientWidth;setEdges({start:node.scrollLeft<=4,end:node.scrollLeft>=max-4})},[]);
  useEffect(()=>{syncEdges();const node=railRef.current;if(!node)return;window.addEventListener('resize',syncEdges);return()=>window.removeEventListener('resize',syncEdges)},[syncEdges,categories.length]);
  const scrollBy=direction=>{const node=railRef.current;if(!node)return;node.scrollBy({left:direction*Math.max(240,node.clientWidth*0.8),behavior:'smooth'})};
  if(!categories.length)return null;
  return <section id={id} tabIndex={id?-1:undefined} className="container section category-section cms-home-anchor">
    <div className="section-head"><div><span className="section-kicker">{kicker}</span><h2 className="section-title">{title}</h2></div><button onClick={()=>go('catalog')}>Barchasi <ArrowRight size={15}/></button></div>
    <div className="category-rail-shell">
      <button type="button" className="category-rail-nav prev" hidden={edges.start} aria-label="Oldingi kategoriyalar" onClick={()=>scrollBy(-1)}><ChevronLeft size={18}/></button>
      <div className="category-rail" ref={railRef} onScroll={syncEdges}>
        {categories.slice(0,16).map(category=><button key={category.id} className="category-tile" onClick={()=>go('category',category)}>
          <b>{plainValue(category.name)}</b>
          <span className="category-art">{category.seo_image_url?<ImageWithFallback src={category.seo_image_url} alt=""/>:<i className="category-fallback"><Grid2X2/></i>}</span>
        </button>)}
      </div>
      <button type="button" className="category-rail-nav next" hidden={edges.end} aria-label="Keyingi kategoriyalar" onClick={()=>scrollBy(1)}><ChevronRight size={18}/></button>
    </div>
  </section>;
}
function CmsHomeSections({blocks,catalog,references,settings,go,add,toggleFavorite,favorites,navigateTarget}){const categoryMap=new Map(safeArray(references?.categoryDetails).map(category=>[String(category.id),category]));return blocks.map(block=>{const content=block.content||{},title=plainValue(block.title)||'Texnobazar',anchor=`home-block-${block.id}`;if(block.block_type==='categories'){const ids=safeArray(content.category_ids).map(String),categories=ids.length?ids.map(id=>categoryMap.get(id)).filter(Boolean):safeArray(references?.categoryRoots);return <CategoryRail key={block.id} id={anchor} kicker={plainValue(content.subtitle)||siteText(settings,'catalog_kicker','KATEGORIYALAR')} title={title} categories={categories} go={go}/>}if(block.block_type==='products'){const list=orderedProducts(content.product_ids,catalog,[...catalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))).slice(0,Math.min(16,Math.max(1,Number(content.limit)||10)));return <ProductSection key={block.id} id={anchor} kicker={siteText(settings,'featured_kicker','TANLANGAN MAHSULOTLAR')} title={title} subtitle={plainValue(content.subtitle)} list={list} {...{go,add,toggleFavorite,favorites}}/>}if(block.block_type==='promotion')return <section id={anchor} tabIndex="-1" className="container section cms-home-anchor" key={block.id}><article className="promotion-modern cms-promotion-block"><span>MAXSUS TAKLIF</span><h2>{title}</h2><p>{plainValue(content.text||content.subtitle)}</p>{content.cta_label&&<button onClick={()=>navigateTarget(content.cta_url)}>{plainValue(content.cta_label)} <ArrowRight/></button>}</article></section>;if(block.block_type==='rich_text'||block.block_type==='hero')return <section id={anchor} tabIndex="-1" className="container section cms-home-anchor" key={block.id}><article className="cms-rich-modern"><div><span className="section-kicker">TEXNOBAZAR</span><h2>{title}</h2><p>{plainValue(content.text||content.subtitle)}</p>{content.cta_label&&<button className="btn btn-primary" onClick={()=>navigateTarget(content.cta_url)}>{plainValue(content.cta_label)} <ArrowRight/></button>}</div><div className="cms-rich-pattern"><Grid2X2/></div></article></section>;return null})}
function FileTextIcon(){return <span className="info-icon"><PackageCheck/></span>}

function ProductSection({ kicker, title, subtitle, list, go, add, toggleFavorite, favorites, state, onRetry, id }) {
  return <section id={id} tabIndex={id?-1:undefined} className="container section cms-home-anchor"><div className="between section-head"><div>{kicker&&<span className="section-kicker">{kicker}</span>}<h2 className="section-title">{title}</h2>{subtitle&&<span className="muted">{subtitle}</span>}</div><button onClick={() => go('catalog')}>Barchasi <ChevronRight size={16}/></button></div>{state?.loading ? <LoadingGrid/> : state?.error ? <StatePanel error={state.error} onRetry={onRetry}/> : list.length ? <div className="product-grid">{list.map(product => <ProductCard key={product.id} product={product} {...{ go, add, toggleFavorite }} loved={favorites.includes(product.id)}/>)}</div> : <div className="card"><Empty title="Mahsulotlar mavjud emas" text="Katalog yangilangach bu yerda mahsulotlar chiqadi."/></div>}</section>;
}
function BannerMedia({banner,alt='',className='',eager=false}){const[mobileEnabled,setMobileEnabled]=useState(Boolean(banner?.mobile_image_url)),[failed,setFailed]=useState(false),desktop=plainValue(banner?.image_url),mobile=plainValue(banner?.mobile_image_url);useEffect(()=>{setMobileEnabled(Boolean(mobile));setFailed(false)},[desktop,mobile]);const fit=value=>['cover','contain','fill'].includes(value)?value:'cover',position=value=>Math.min(100,Math.max(0,numberOf(value??50))),style={'--banner-fit':fit(banner?.image_fit),'--banner-x':`${position(banner?.image_position_x)}%`,'--banner-y':`${position(banner?.image_position_y)}%`,'--banner-mobile-fit':fit(banner?.mobile_image_fit),'--banner-mobile-x':`${position(banner?.mobile_image_position_x)}%`,'--banner-mobile-y':`${position(banner?.mobile_image_position_y)}%`};if(!desktop||failed)return <span className={`media-placeholder responsive-banner-media ${className}`} role="img" aria-label={alt||'Banner rasmi mavjud emas'}><Grid2X2/><span>Rasm tayyorlanmoqda</span></span>;return <picture className={`responsive-banner-media ${className}`} style={style}>{mobileEnabled&&mobile&&<source media="(max-width: 640px)" srcSet={mobile}/>}<img src={desktop} alt={alt} loading={eager?'eager':'lazy'} fetchpriority={eager?'high':'auto'} decoding="async" onError={()=>mobileEnabled?setMobileEnabled(false):setFailed(true)}/></picture>}
function ImageWithFallback({src,alt='',className=''}){const[failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return src&&!failed?<img className={className} src={src} alt={alt} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<div className={`media-placeholder ${className}`} role="img" aria-label={alt||'Rasm mavjud emas'}><Grid2X2/><span>Rasm tayyorlanmoqda</span></div>}
function ProductMedia({ product, className = '' }) {
  const[zoom,setZoom]=useState(false);
  return <>{zoom&&<ImageZoom src={product.image} alt={product.name} onClose={()=>setZoom(false)}/>}<span onClick={()=>{if(product.image)setZoom(true)}} style={{cursor:product.image?'zoom-in':'default'}}><ImageWithFallback className={className} src={product.image} alt={product.name}/></span></>;
}
function ImageZoom({src,alt,onClose}){
  const[scale,setScale]=useState(1);const[pos,setPos]=useState({x:0,y:0});const lastDist=React.useRef(0);const dragging=React.useRef(false);const lastPos=React.useRef({x:0,y:0});
  useEffect(()=>{const onKey=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',onKey);history.pushState(null,'','');const onPop=()=>onClose();window.addEventListener('popstate',onPop);return()=>{window.removeEventListener('keydown',onKey);window.removeEventListener('popstate',onPop)}},[onClose]);
  const onWheel=e=>{e.preventDefault();setScale(s=>Math.min(5,Math.max(1,s+(e.deltaY>0?-0.3:0.3))))};
  const onTouchStart=e=>{if(e.touches.length===2){lastDist.current=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)}else if(e.touches.length===1&&scale>1){dragging.current=true;lastPos.current={x:e.touches[0].clientX-pos.x,y:e.touches[0].clientY-pos.y}}};
  const onTouchMove=e=>{if(e.touches.length===2){e.preventDefault();const dist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);if(lastDist.current>0)setScale(s=>Math.min(5,Math.max(1,s*(dist/lastDist.current))));lastDist.current=dist}else if(dragging.current&&e.touches.length===1){setPos({x:e.touches[0].clientX-lastPos.current.x,y:e.touches[0].clientY-lastPos.current.y})}};
  const onTouchEnd=()=>{lastDist.current=0;dragging.current=false;if(scale<=1)setPos({x:0,y:0})};
  const reset=()=>{setScale(1);setPos({x:0,y:0})};
  return <div className="image-zoom-overlay" onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}><button className="image-zoom-close" onClick={onClose} aria-label="Yopish">&times;</button><div className="image-zoom-body" onDoubleClick={()=>{if(scale>1)reset();else setScale(3)}}><img src={src} alt={alt} style={{transform:"translate("+pos.x+"px,"+pos.y+"px) scale("+scale+")",transition:dragging.current?"none":"transform 0.2s"}}/></div></div>;
}
function ProductCard({ product, go, add, toggleFavorite, loved, cartQty = 0, onUpdateQty }) {
  const[localQty,setLocalQty]=useState(cartQty);
  useEffect(()=>setLocalQty(cartQty),[cartQty]);
  const discount=product.oldPrice>product.price?Math.max(1,Math.round((1-product.price/product.oldPrice)*100)):0,feature=product.attributes[0];
  const handleAdd=()=>{add(product);setLocalQty(q=>q+1)};
  const increment=()=>{if(onUpdateQty){onUpdateQty(product,localQty+1)}else{add(product)};setLocalQty(q=>Math.min(q+1,product.stock))};
  const decrement=()=>{const next=localQty-1;if(onUpdateQty)onUpdateQty(product,next);setLocalQty(next)};
  return <article className="product-card modern-card"><div className="product-img"><ProductMedia product={product}/><div className="product-tags">{discount>0&&<span className="product-badge">-{discount}%</span>}{product.stock>0&&product.stock<4&&<span className="product-limited">Oxirgi {product.stock} dona</span>}</div><button type="button" className="product-open" onClick={()=>go('product',product)} aria-label={`${product.name} mahsulotini ochish`}/></div><button type="button" className={`product-heart ${loved?'loved':''}`} onClick={()=>toggleFavorite(product)} aria-label="Saralangan"><Heart size={19} fill={loved?'currentColor':'none'}/></button><div className="product-body"><span className={`stock-label ${product.stock?'':'out'}`}><i/>{product.stock?`${product.stock} dona mavjud`:'Sotuvda yo\u2019q'}</span><h3 onClick={()=>go('product',product)}>{product.name}</h3><div className="product-meta">{feature?`${feature.name}: ${plainValue(feature.value)}`:`SKU: ${product.sku||'\u2014'}`}</div><div className="product-price-row"><div>{discount>0&&<div className="old-price">{money(product.oldPrice)}</div>}<div className="price">{money(product.price)}</div></div>{localQty>0?<div className="card-qty"><button onClick={decrement} aria-label="Kamaytirish"><Minus size={15}/></button><b>{localQty}</b><button onClick={increment} disabled={localQty>=product.stock} aria-label="Ko\u2019paytirish"><Plus size={15}/></button></div>:<button className="cart-add" onClick={handleAdd} disabled={!product.stock} aria-label="Savatchaga qo\u2019shish"><ShoppingCart size={19}/></button>}</div></div></article>;
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
function QrResolver({code,go}){
  const[state,setState]=useState({loading:true,error:''});
  useEffect(()=>{
    if(!code){setState({loading:false,error:'QR kod topilmadi'});return}
    setState({loading:true,error:''});
    getBrowserClient().rpc('resolve_qr_for_storefront',{p_code:code}).then(({data,error})=>{
      if(error||!data||!data.slug){setState({loading:false,error:'Bu mahsulot hozircha saytda mavjud emas.'});return}
      window.history.replaceState({},'','/product/'+encodeURIComponent(data.slug));
      window.location.reload();
    }).catch(()=>setState({loading:false,error:'QR kodni aniqlashda xatolik yuz berdi.'}));
  },[code]);
  if(state.loading)return <section className="container" style={{padding:'80px 20px',textAlign:'center'}}><p>QR kod tekshirilmoqda...</p></section>;
  return <section className="container" style={{padding:'80px 20px',textAlign:'center'}}><h2>Mahsulot topilmadi</h2><p>{state.error}</p><button className="btn btn-primary" onClick={()=>go('home')}>Bosh sahifaga qaytish</button></section>;
}

function RichDescription({product}){const media=new Map(safeArray(product.media).map(item=>[String(item.id),item]));const blocks=safeArray(product.descriptionBlocks);if(!blocks.length)return product.description?<div className="product-html-description" dangerouslySetInnerHTML={{__html:product.description}}/>:<p>Mahsulot tavsifi kiritilmagan.</p>;return <div className="structured-product-description">{blocks.map((block,index)=>{if(block.type==='text')return block.text?.includes('<')?<div key={index} dangerouslySetInnerHTML={{__html:block.text}}/>:<p key={index}>{block.text}</p>;if(block.type==='heading'){const Tag=`h${Math.min(4,Math.max(2,Number(block.level)||2))}`;return <Tag key={index}>{block.text}</Tag>}if(block.type==='list')return <ul key={index}>{safeArray(block.items).map((item,i)=><li key={i}>{plainValue(item)}</li>)}</ul>;if(block.type==='table')return <div className="table-wrap" key={index}><table className="table"><thead><tr>{safeArray(block.headers).map((cell,i)=><th key={i}>{plainValue(cell)}</th>)}</tr></thead><tbody>{safeArray(block.rows).map((row,i)=><tr key={i}>{safeArray(row).map((cell,j)=><td key={j}>{plainValue(cell)}</td>)}</tr>)}</tbody></table></div>;if(block.type==='image'){const item=media.get(String(block.media_id));return item?<figure key={index}><img src={item.url} alt={block.caption||item.alt||product.name}/>{block.caption&&<figcaption>{block.caption}</figcaption>}</figure>:null}if(block.type==='video'||block.type==='link')return <p key={index}><a href={block.url} target="_blank" rel="noopener noreferrer">{block.label||(block.type==='video'?'Videoni ko‘rish':'Havolani ochish')}</a></p>;return null})}</div>}

function Product({ product, go, add, toggleFavorite, loved, related, favorites, session, setToast }) {
  return <section className="container product-page"><div className="breadcrumbs"><button onClick={() => go('home')}>Bosh sahifa</button><ChevronRight/><button onClick={() => go('catalog')}>Katalog</button><ChevronRight/>{product.name}</div><div className="product-detail card"><div className="gallery single-media"><div className="main-img"><ProductMedia product={product}/>{product.oldPrice > product.price && <span className="badge">Aksiya</span>}</div>{product.seoImage&&product.seoImage.includes("youtu")&&<div className="product-video"><iframe src={product.seoImage.replace("watch?v=","embed/").replace("youtu.be/","youtube.com/embed/")} title="Video" allowFullScreen style={{width:"100%",height:300,border:"none",borderRadius:12,marginTop:12}}/></div>}</div><div className="detail-info"><div className="row"><Status type={product.stock ? 'green' : 'red'}>{product.stock ? 'Sotuvda mavjud' : "Sotuvda yo\u2019q"}</Status></div><h1>{product.name}</h1><p className="muted">Artikul: {product.sku || '\u2014'}</p><div className="divider"/>{product.oldPrice > product.price && <div className="old-price">{money(product.oldPrice)}</div>}<div className="detail-price">{money(product.price)}</div><div className={`stock ${product.stock ? '' : 'out'}`}>{product.stock ? <Check size={18}/> : <X size={18}/>} {product.stock ? `Omborda ${product.stock} dona mavjud` : 'Omborda mavjud emas'}</div><div className="detail-actions"><button className="btn btn-primary" onClick={() => add(product)} disabled={!product.stock}><ShoppingCart/> Savatchaga</button><button className={`btn btn-outline ${loved ? 'loved' : ''}`} onClick={() => toggleFavorite(product)}><Heart fill={loved ? 'currentColor' : 'none'}/> {loved ? "Sevimlilardan olib tashlash" : "Sevimliga qo\u2019shish"}</button></div></div></div><div className="detail-tabs card"><h2>Mahsulot haqida</h2><RichDescription product={product}/><h3>Asosiy xususiyatlar</h3>{product.attributes.length ? <div className="spec-grid">{product.attributes.map(item => <div key={`${item.code}-${item.value}`}><span>{item.name}</span><b>{item.value || '\u2014'}</b></div>)}</div> : <p className="muted">Xususiyatlar kiritilmagan.</p>}</div><ProductReviews productId={product.id} session={session} setToast={setToast}/>{related.length > 0 && <ProductSection title="O\u2019xshash mahsulotlar" subtitle="Sizga mos takliflar" list={related} {...{ go, add, toggleFavorite, favorites }}/>}</section>;
}

function Cart({ cartItems, go, updateCart }) {
  const total = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  return <section className="container cart-page"><div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button> <ChevronRight/> Savatcha</div><h1 className="title">Savatcha</h1>{cartItems.length ? <div className="cart-layout"><div className="stack">{cartItems.map(product => <div className="cart-item card" key={product.id}><ProductMedia product={product}/><div className="cart-name"><b>{product.name}</b><span className="muted">Omborda: {product.stock} dona</span><button onClick={() => updateCart(product, 0)}><Trash2/> O‘chirish</button></div><div className="qty"><button onClick={() => updateCart(product, product.qty - 1)} aria-label="Miqdorni kamaytirish"><Minus/></button><b>{product.qty}</b><button onClick={() => updateCart(product, product.qty + 1)} disabled={product.qty >= product.stock} aria-label="Miqdorni oshirish"><Plus/></button></div><div className="price">{money(product.price * product.qty)}</div></div>)}</div><OrderTotal total={total} count={cartItems.reduce((sum, item) => sum + item.qty, 0)} onClick={() => go('checkout')}/></div> : <div className="card"><Empty title="Savatchangiz bo‘sh" text="Katalogdan o‘zingizga yoqqan texnikani tanlang."/><div className="center-action"><button className="btn btn-primary" onClick={() => go('catalog')}>Katalogga o‘tish</button></div></div>}</section>;
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
    const payload = { customer: { name: form.name.trim(), phone, email: form.email.trim() || undefined }, shippingAddress: { address: form.address.trim() }, lines: cartItems.map(item => ({ product_id: item.id, quantity: item.qty })), paymentMethodCode: payment, notes: form.notes.trim() || null };
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
  const signOut = async () => { try { await signOutCustomer(); setToast('Hisobdan chiqdingiz.'); go('home'); } catch (error) { setToast(errorText(error)); } };
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
