import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, CreditCard, Grid2X2, Heart,
  Home as HomeIcon, LoaderCircle, MapPin, Menu, Minus, PackageCheck, Plus,
  Search, Send, ShieldCheck, ShoppingCart, SlidersHorizontal, Trash2, Truck,
  User, X,
} from 'lucide-react';
import { Empty, Status, Toast } from '@texnobazar/ui';
import {
  createCheckoutToken, getBrowserClient, getOnlinePaymentStatus, getStorefrontSession, initiateOnlinePayment, listNotifications, loadCustomerAccount, loadCustomerOrders,
  loadStorefrontCatalog, loadStorefrontCms, loadStorefrontPaymentMethods, loadStorefrontProduct, loadStorefrontProducts, loadStorefrontReferences, markNotificationsRead, removeCustomerAddress, saveCustomerAddress,
  saveCustomerProfile, setCustomerCartItem, setCustomerFavorite, signInCustomer,
  signOutCustomer, signUpCustomer, submitOnlineOrder, subscribeCms, subscribeNotifications,
} from '@texnobazar/data';

const ANON_CART_KEY = 'texnobazar.storefront.cart.v1';
const ANON_FAV_KEY = 'texnobazar.storefront.favorites.v1';
const PAGE_SIZE = 12;
const emptyCms = { banners: [], home_blocks: [], menu_items: [], promotions: [], pages: [], settings: {} };
const money = value => `${new Intl.NumberFormat('uz-UZ').format(Number(value) || 0)} so‘m`;
const errorText = error => error?.message || 'Kutilmagan xatolik yuz berdi.';
const numberOf = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const safeArray = value => Array.isArray(value) ? value : [];
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
  price: numberOf(raw.promotion_price ?? raw.retail_price),
  oldPrice: numberOf(raw.compare_at_price ?? (raw.promotion_price != null ? raw.retail_price : 0)),
  stock: Math.max(0, Math.trunc(numberOf(raw.available_stock))),
  attributes: safeArray(raw.attributes).map(item => ({ code: String(item.code || item.name || ''), name: String(item.name || item.code || ''), value: plainValue(item.value) })),
  categoryId: raw.category_id ? String(raw.category_id) : '',
  brandId: raw.brand_id ? String(raw.brand_id) : '',
});
const parseRoute = () => {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/product/')) return { view: 'product', slug: decodeURIComponent(path.slice(9)) };
  if (path.startsWith('/category/')) return { view: 'category', slug: decodeURIComponent(path.slice(10)) };
  if (path.startsWith('/page/')) return { view: 'page', slug: decodeURIComponent(path.slice(6)) };
  if (['/catalog', '/cart', '/checkout', '/profile'].includes(path)) return { view: path.slice(1) };
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
  const [references, setReferences] = useState({ categories: {}, brands: {}, categoryDetails: [] });
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
    const categories=safeArray(payload?.categories),brands=safeArray(payload?.brands);
    setReferences({
      categories: Object.fromEntries(categories.map(item => [String(item.id), plainValue(item.name)])),
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
        history.pushState({}, '', `${url.pathname}${url.search}`); setRoute(parseRoute()); window.scrollTo(0, 0);
      } else if (['http:', 'https:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
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
    try { if (session) await setCustomerFavorite(product.id, !loved); }
    catch (error) { setToast(errorText(error)); refreshAccount(); }
  };
  const clearCart = async () => {
    const ids = cart.map(item => item.id);
    setCart([]);
    storageWrite(ANON_CART_KEY, []);
    if (session) await Promise.all(ids.map(id => setCustomerCartItem(id, 0)));
  };

  if (!authReady) return <div className="app-loading"><LoaderCircle className="spin"/><b>Texnobazar yuklanmoqda…</b></div>;
  return <>
    <Promo settings={cms.settings}/>
  <Header {...{ go, cart, favorites, query, setQuery, menu, setMenu, session, navigateTarget, route, references }} settings={cms.settings} menuItems={safeArray(cms.menu_items)}/>
    <main>
      {route.view === 'home' && <Home {...{ go, add, toggleFavorite, favorites, catalog, cms, catalogState, cmsState, loadCatalog, loadCms, navigateTarget, references, mergeCatalogProducts }}/>} 
      {route.view === 'catalog' && <ServerCatalog {...{ go, add, toggleFavorite, favorites, query, setQuery, references, navigateTarget }} cmsBanners={safeArray(cms.banners)} onItemsLoaded={mergeCatalogProducts}/>} 
      {route.view === 'product' && (selected ? <Product product={selected} {...{ go, add, toggleFavorite, favorites }} loved={favorites.includes(selected.id)} related={catalog.filter(item => item.id !== selected.id && (item.categoryId === selected.categoryId || item.brandId === selected.brandId)).slice(0, 5)}/> : <StatePanel loading={detailState.loading||catalogState.loading} error={detailState.error||catalogState.error} onRetry={()=>loadStorefrontProduct(route.slug).then(raw=>raw&&mergeCatalogProducts([raw]))} title="Mahsulot topilmadi"/>)}
      {route.view === 'category' && (selectedCategory ? <CategoryLanding key={selectedCategory.id} category={selectedCategory} {...{go,add,toggleFavorite,favorites,query,setQuery,references,navigateTarget}} cmsBanners={safeArray(cms.banners)} onItemsLoaded={mergeCatalogProducts}/> : <StatePanel loading={catalogState.loading} error={catalogState.error} onRetry={loadCatalog} title="Kategoriya topilmadi"/>)}
      {route.view === 'page' && (selectedPage ? <CmsPage page={selectedPage}/> : <StatePanel loading={cmsState.loading} error={cmsState.error} onRetry={loadCms} title="Sahifa topilmadi"/>)}
      {route.view === 'cart' && <Cart {...{ cartItems, go, updateCart }}/>}
      {route.view === 'checkout' && <Checkout {...{ cartItems, go, session, account, clearCart, setToast, customerStateReady }}/>} 
      {route.view === 'profile' && <Profile {...{ go, session, account, accountError, refreshAccount, favorites, catalog, setAuthOpen, setToast }}/>} 
    </main>
    <Footer go={go} settings={cms.settings} pages={safeArray(cms.pages)} menuItems={safeArray(cms.menu_items)} navigateTarget={navigateTarget}/>
    <MobileNav go={go} cart={cart} route={route}/>
    {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSuccess={() => { setAuthOpen(false); refreshAccount(); }} setToast={setToast}/>} 
    <Toast message={toast} onClose={() => setToast('')}/>
  </>;
}

function Promo({ settings }) {
  const message=plainValue(settings?.delivery_message)||'Butun O‘zbekiston bo‘ylab tezkor yetkazib berish',phone=plainValue(settings?.support_phone);
  return <div className="promo"><div className="container promo-inner"><span className="promo-message"><Check size={14}/>{message}</span><span className="promo-points"><b>100% original</b><i/> <b>Real qoldiq</b>{phone&&<><i/><a href={`tel:${phone.replace(/\s/g,'')}`}>{phone}</a></>}</span></div></div>;
}
function Logo({ go, siteName='Texnobazar' }) { return <button className="logo" onClick={() => go('home')} aria-label={`${siteName} bosh sahifasi`}><span>T</span><strong>{siteName}</strong></button>; }
function Header({ go, cart, favorites, query, setQuery, menu, setMenu, session, menuItems, navigateTarget, settings, references, route }) {
  const cmsHeaderRoots=menuItems.filter(item=>!item.parent_id&&(!item.location||item.location==='header')).slice(0,8),cmsMobileRoots=menuItems.filter(item=>!item.parent_id&&item.location==='mobile').slice(0,10);
  const categoryNav=safeArray(references?.categoryDetails).slice(0,8).map(item=>({id:item.id,label:item.name,target_url:`/category/${item.slug}`,category:item}));
  const navItems=cmsHeaderRoots.length?cmsHeaderRoots:categoryNav,mobileItems=cmsMobileRoots.length?cmsMobileRoots:navItems,siteName=plainValue(settings?.site_name)||'Texnobazar';
  const childrenFor=parent=>menuItems.filter(item=>item.parent_id===parent.id&&(!item.location||item.location===parent.location));
  const openItem=item=>item.category?go('category',item.category):navigateTarget(item.target_url),submitSearch=()=>go('catalog');
  return <><header className="site-header"><div className="container header-main"><Logo go={go} siteName={siteName}/><button className="btn catalog-btn" onClick={()=>go('catalog')}><Grid2X2 size={19}/><span>Katalog</span></button><label className="search"><Search size={19}/><span className="sr-only">Mahsulot qidirish</span><input value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>event.key==='Enter'&&submitSearch()} placeholder="Mahsulot, brend yoki SKU qidiring..."/><button onClick={submitSearch} aria-label="Qidirish"><ArrowRight size={19}/></button></label><div className="header-actions"><HeaderAction icon={Heart} text="Saralangan" count={favorites.length} onClick={()=>go('profile')}/><HeaderAction icon={ShoppingCart} text="Savatcha" count={cart.reduce((sum,item)=>sum+item.qty,0)} onClick={()=>go('cart')}/><HeaderAction icon={User} text={session?'Profil':'Kirish'} onClick={()=>go('profile')}/></div><button className="icon-btn mobile-menu" onClick={()=>setMenu(!menu)} aria-expanded={menu} aria-label="Menyuni ochish">{menu?<X/>:<Menu/>}</button></div><nav className="container categories desktop-only" aria-label="Asosiy menyu"><button className={route?.view==='home'?'active':''} onClick={()=>go('home')}>Bosh sahifa</button>{navItems.map(item=>{const children=childrenFor(item);return <div className="nav-group" key={item.id}><button className={route?.slug&&item.target_url?.endsWith(route.slug)?'active':''} onClick={()=>openItem(item)}>{plainValue(item.label)}{children.length>0&&<ChevronRight/>}</button>{children.length>0&&<div className="nav-submenu">{children.map(child=><button key={child.id} onClick={()=>navigateTarget(child.target_url)}>{plainValue(child.label)}<ArrowRight/></button>)}</div>}</div>})}<button className="nav-sale" onClick={()=>go('catalog')}>Aksiyalar</button></nav></header>{menu&&<div className="mobile-drawer" role="navigation"><div><Logo go={go} siteName={siteName}/><button className="icon-btn" aria-label="Mobil menyuni yopish" onClick={()=>setMenu(false)}><X/></button></div>{mobileItems.map(item=><React.Fragment key={item.id}><button onClick={()=>openItem(item)}>{plainValue(item.label)}<ChevronRight/></button>{childrenFor(item).map(child=><button className="mobile-subitem" key={child.id} onClick={()=>navigateTarget(child.target_url)}>{plainValue(child.label)}<ArrowRight/></button>)}</React.Fragment>)}<button onClick={()=>go('catalog')}>Barcha mahsulotlar<ChevronRight/></button><button onClick={()=>go('profile')}>Shaxsiy kabinet<ChevronRight/></button><button onClick={()=>go('cart')}>Savatcha<ChevronRight/></button></div>}</>;
}
function HeaderAction({ icon: Icon, text, count = 0, onClick }) { return <button className="head-action" onClick={onClick}><span><Icon size={21}/>{count > 0 && <i>{count}</i>}</span><small>{text}</small></button>; }

function Home({go,add,toggleFavorite,favorites,catalog,cms,catalogState,cmsState,loadCatalog,loadCms,navigateTarget,references,mergeCatalogProducts}){
  const settings=cms.settings||{},cmsBanners=safeArray(cms.banners).filter(item=>item.image_url&&(!item.placement||item.placement.includes('hero')));
  const fallback={id:'default',title:plainValue(settings.hero_title)||'Texnologiya — endi yanada yaqin',subtitle:plainValue(settings.hero_subtitle)||'Smartfon, maishiy texnika va aksessuarlarni real ombor qoldig‘i bilan tanlang.',eyebrow:plainValue(settings.hero_eyebrow)||'YANGI AVLOD TEXNIKALARI',target_url:plainValue(settings.hero_cta_url)||'/catalog',cta:plainValue(settings.hero_cta_label)||'Katalogni ko‘rish'};
  const banners=cmsBanners.length?cmsBanners.map(item=>({...item,subtitle:fallback.subtitle,eyebrow:fallback.eyebrow,cta:fallback.cta})): [fallback];
  const[slide,setSlide]=useState(0),[paused,setPaused]=useState(false);
  useEffect(()=>setSlide(current=>current%banners.length),[banners.length]);
  useEffect(()=>{if(paused||banners.length<2)return;const timer=setInterval(()=>setSlide(current=>(current+1)%banners.length),5500);return()=>clearInterval(timer)},[banners.length,paused]);
  const active=banners[slide],promotions=safeArray(cms.promotions),blocks=safeArray(cms.home_blocks),categories=safeArray(references?.categoryDetails),hydrationAttempts=useRef(new Set());
  const referencedProductIds=useMemo(()=>[...new Set([...promotions.flatMap(item=>safeArray(item.product_ids)),...blocks.flatMap(block=>safeArray(block.content?.product_ids))].map(String))],[promotions,blocks]);
  useEffect(()=>{const missing=referencedProductIds.filter(id=>!catalog.some(item=>item.id===id)&&!hydrationAttempts.current.has(id));if(!missing.length)return;missing.forEach(id=>hydrationAttempts.current.add(id));let activeRequest=true;loadStorefrontProducts(missing).then(items=>{if(activeRequest)mergeCatalogProducts(items)}).catch(error=>{missing.forEach(id=>hydrationAttempts.current.delete(id));if(activeRequest)console.warn('CMS mahsulotlari yuklanmadi:',errorText(error))});return()=>{activeRequest=false}},[referencedProductIds,catalog,mergeCatalogProducts]);
  const promoBanners=safeArray(cms.banners).filter(item=>item.image_url&&item.placement==='home_promo');
  return <>
    {cmsState.error&&<InlineError text={cmsState.error} onRetry={loadCms}/>} 
    <section className="container hero-shell" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)}><div className="hero-modern"><div className="hero-glow"/><div className="hero-copy"><span className="hero-eyebrow">{plainValue(active.eyebrow||active.placement)||'TEXNOBAZAR TANLOVI'}</span><h1>{plainValue(active.title)}</h1><p>{plainValue(active.subtitle)}</p><div className="hero-actions"><button className="btn btn-primary" onClick={()=>navigateTarget(active.target_url||'/catalog')}>{plainValue(active.cta)||'Batafsil'} <ArrowRight size={18}/></button><button className="btn hero-secondary" onClick={()=>go('catalog')}><Grid2X2 size={18}/> Barcha mahsulotlar</button></div><div className="hero-trust"><span><Check/> Real qoldiq</span><span><ShieldCheck/> Rasmiy kafolat</span><span><Truck/> Tez yetkazish</span></div></div>{active.image_url?<div className="hero-visual"><ImageWithFallback src={active.image_url} alt={plainValue(active.title)} className="hero-image"/><span className="hero-stock"><PackageCheck/><b>Omborda mavjud</b><small>Qoldiq real vaqtda</small></span></div>:<div className="hero-visual hero-art" aria-hidden="true"><div className="device device-one"/><div className="device device-two"/><span className="hero-stock"><PackageCheck/><b>Real katalog</b><small>Admin paneldan boshqariladi</small></span></div>}{banners.length>1&&<div className="hero-controls"><button onClick={()=>setSlide((slide-1+banners.length)%banners.length)} aria-label="Oldingi banner"><ChevronLeft/></button>{banners.map((banner,index)=><button className={`hero-dot ${index===slide?'active':''}`} key={banner.id} onClick={()=>setSlide(index)} aria-label={`${index+1}-banner`}/>)}<button onClick={()=>setSlide((slide+1)%banners.length)} aria-label="Keyingi banner"><ChevronRight/></button></div>}</div></section>
    {promoBanners.length>0&&<section className="container home-promo-banners">{promoBanners.map(banner=><button key={banner.id} onClick={()=>navigateTarget(banner.target_url)}><ImageWithFallback src={banner.image_url} alt={plainValue(banner.title)}/><span><small>MAXSUS TAKLIF</small><b>{plainValue(banner.title)}</b><em>Batafsil <ArrowRight/></em></span></button>)}</section>}
    <CategoryRail title={plainValue(settings.catalog_title)||'Ommabop kategoriyalar'} categories={categories} catalog={catalog} go={go}/>
    {promotions.length>0&&<section className="container section"><div className="section-kicker">MAXSUS TAKLIFLAR</div><div className="promotion-modern-grid">{promotions.slice(0,3).map((promotion,index)=><article key={promotion.id} className={`promotion-modern tone-${index%3}`}><span>{promotion.discount_type==='percent'?`${plainValue(promotion.discount_value)}% gacha`:'Maxsus narx'}</span><h2>{plainValue(promotion.name)}</h2><p>{plainValue(promotion.description)}</p><button onClick={()=>go('catalog')}>Takliflarni ko‘rish <ArrowRight/></button></article>)}</div></section>}
    <CmsHomeSections blocks={blocks} catalog={catalog} references={references} {...{go,add,toggleFavorite,favorites,navigateTarget}}/>
    <ProductSection title={plainValue(settings.featured_title)||'Siz uchun tanladik'} subtitle="Real ombor qoldig‘idagi yangi mahsulotlar" list={[...catalog].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,10)} {...{go,add,toggleFavorite,favorites}} state={catalogState} onRetry={loadCatalog}/>
    {promotions.map(promotion=>{const ids=safeArray(promotion.product_ids).map(String),promoted=catalog.filter(item=>ids.includes(item.id)).slice(0,10);return promoted.length?<ProductSection key={promotion.id} title={plainValue(promotion.name)} subtitle={plainValue(promotion.description)} list={promoted} {...{go,add,toggleFavorite,favorites}}/>:null})}
    <Services/>
    {safeArray(cms.pages).length>0&&<section className="container section info-section"><div className="section-head"><div><span className="section-kicker">YORDAM MARKAZI</span><h2 className="section-title">Kerakli ma’lumotlar</h2></div></div><div className="page-grid">{safeArray(cms.pages).slice(0,6).map(page=><button className="info-link card" key={page.id} onClick={()=>go('page',page)}><FileTextIcon/><span><b>{plainValue(page.title)}</b><small>Batafsil ma’lumot</small></span><ChevronRight/></button>)}</div></section>}
  </>;
}
function CategoryRail({title,categories,catalog,go}){if(!categories.length)return null;return <section className="container section category-section"><div className="section-head"><div><span className="section-kicker">TEZKOR TANLOV</span><h2 className="section-title">{title}</h2></div><button onClick={()=>go('catalog')}>Barchasi <ArrowRight size={16}/></button></div><div className="category-rail">{categories.slice(0,10).map((category,index)=>{const count=catalog.filter(item=>item.categoryId===String(category.id)).length;return <button key={category.id} className={`category-modern c${index%8}`} onClick={()=>go('category',category)}>{category.seo_image_url?<ImageWithFallback src={category.seo_image_url} alt=""/>:<span><Grid2X2/></span>}<b>{category.name}</b><small>{count?`${count} ta mahsulot`:'Katalogni ko‘rish'}</small><i><ArrowRight/></i></button>})}</div></section>}
function CmsHomeSections({blocks,catalog,references,go,add,toggleFavorite,favorites,navigateTarget}){return blocks.map(block=>{const content=block.content||{},title=plainValue(block.title)||'Texnobazar';if(block.block_type==='categories')return <CategoryRail key={block.id} title={title} categories={safeArray(references?.categoryDetails)} catalog={catalog} go={go}/>;if(block.block_type==='products'){const ids=safeArray(content.product_ids).map(String),list=(ids.length?catalog.filter(item=>ids.includes(item.id)):catalog).slice(0,10);return <ProductSection key={block.id} title={title} subtitle={plainValue(content.subtitle)} list={list} {...{go,add,toggleFavorite,favorites}}/>}if(block.block_type==='promotion')return <section className="container section" key={block.id}><article className="promotion-modern cms-promotion-block"><span>MAXSUS TAKLIF</span><h2>{title}</h2><p>{plainValue(content.text||content.subtitle)}</p>{content.cta_label&&<button onClick={()=>navigateTarget(content.cta_url)}>{plainValue(content.cta_label)} <ArrowRight/></button>}</article></section>;if(block.block_type==='rich_text'||block.block_type==='hero')return <section className="container section" key={block.id}><article className="cms-rich-modern"><div><span className="section-kicker">TEXNOBAZAR</span><h2>{title}</h2><p>{plainValue(content.text||content.subtitle)}</p>{content.cta_label&&<button className="btn btn-primary" onClick={()=>navigateTarget(content.cta_url)}>{plainValue(content.cta_label)} <ArrowRight/></button>}</div><div className="cms-rich-pattern"><Grid2X2/></div></article></section>;return null})}
function FileTextIcon(){return <span className="info-icon"><PackageCheck/></span>}

function Services() {
  return <section className="container services"><div><span><Truck/></span><div><b>Tezkor yetkazib berish</b><p>Buyurtmangiz ko‘rsatilgan manzilga yetkaziladi</p></div></div><div><span><ShieldCheck/></span><div><b>Rasmiy mahsulotlar</b><p>Katalogdagi haqiqiy ombor qoldig‘i ko‘rsatiladi</p></div></div><div><span><CreditCard/></span><div><b>Qulay to‘lov</b><p>Faol to‘lov usulini buyurtmada tanlang</p></div></div></section>;
}
function ProductSection({ title, subtitle, list, go, add, toggleFavorite, favorites, state, onRetry }) {
  return <section className="container section"><div className="between section-head"><div><h2 className="section-title">{title}</h2><span className="muted">{subtitle}</span></div><button onClick={() => go('catalog')}>Barchasi <ChevronRight size={18}/></button></div>{state?.loading ? <LoadingGrid/> : state?.error ? <StatePanel error={state.error} onRetry={onRetry}/> : list.length ? <div className="product-grid">{list.map(product => <ProductCard key={product.id} product={product} {...{ go, add, toggleFavorite }} loved={favorites.includes(product.id)}/>)}</div> : <div className="card"><Empty title="Mahsulotlar mavjud emas" text="Katalog yangilangach bu yerda mahsulotlar chiqadi."/></div>}</section>;
}
function ImageWithFallback({src,alt='',className=''}){const[failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return src&&!failed?<img className={className} src={src} alt={alt} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<div className={`media-placeholder ${className}`} role="img" aria-label={alt||'Rasm mavjud emas'}><Grid2X2/><span>Rasm tayyorlanmoqda</span></div>}
function ProductMedia({ product, className = '' }) { return <ImageWithFallback className={className} src={product.image} alt={product.name}/>; }
function ProductCard({ product, go, add, toggleFavorite, loved }) {
  const discount=product.oldPrice>product.price?Math.max(1,Math.round((1-product.price/product.oldPrice)*100)):0,feature=product.attributes[0];
  return <article className="product-card modern-card"><div className="product-img"><ProductMedia product={product}/><div className="product-tags">{discount>0&&<span className="product-badge">-{discount}%</span>}{product.stock>0&&product.stock<4&&<span className="product-limited">Oxirgi {product.stock} dona</span>}</div><button type="button" className="product-open" onClick={()=>go('product',product)} aria-label={`${product.name} mahsulotini ochish`}/></div><button type="button" className={`product-heart ${loved?'loved':''}`} onClick={()=>toggleFavorite(product)} aria-label={loved?'Saralanganlardan olib tashlash':'Saralanganlarga qo‘shish'}><Heart size={19} fill={loved?'currentColor':'none'}/></button><div className="product-body"><span className={`stock-label ${product.stock?'':'out'}`}><i/>{product.stock?`${product.stock} dona mavjud`:'Sotuvda yo‘q'}</span><h3 onClick={()=>go('product',product)}>{product.name}</h3><div className="product-meta">{feature?`${feature.name}: ${plainValue(feature.value)}`:`SKU: ${product.sku||'—'}`}</div><div className="product-price-row"><div>{discount>0&&<div className="old-price">{money(product.oldPrice)}</div>}<div className="price">{money(product.price)}</div></div><button className="cart-add" onClick={()=>add(product)} disabled={!product.stock} aria-label="Savatchaga qo‘shish"><ShoppingCart size={19}/></button></div></div></article>;
}

function CatalogTopBanner({banners,navigateTarget}){const banner=safeArray(banners).find(item=>item.image_url&&item.placement==='catalog_top');if(!banner)return null;return <button type="button" className="catalog-top-banner" onClick={()=>navigateTarget?.(banner.target_url||'/catalog')}><ImageWithFallback src={banner.image_url} alt={plainValue(banner.title)}/><span><small>KATALOG TAKLIFI</small><b>{plainValue(banner.title)||'Maxsus taklif'}</b><em>Batafsil <ArrowRight/></em></span></button>}
function CategoryLanding({category,go,add,toggleFavorite,favorites,query,setQuery,references,onItemsLoaded,cmsBanners,navigateTarget}){return <><section className="container seo-landing"><div className="breadcrumbs"><button onClick={()=>go('home')}>Bosh sahifa</button><ChevronRight/>{category.name}</div><header className="card">{category.seo_image_url&&<img src={category.seo_image_url} alt=""/>}<div><h1>{category.name}</h1>{category.description&&<p>{category.description}</p>}</div></header></section><ServerCatalog {...{go,add,toggleFavorite,favorites,query,setQuery,references,onItemsLoaded,cmsBanners,navigateTarget}} initialCategoryIds={[String(category.id)]} title={category.name}/></>}
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
  return <section className="container catalog-page"><div className="breadcrumbs">Bosh sahifa <ChevronRight/> Katalog</div><div className="between catalog-title"><div><h1 className="title">{title}</h1><span className="muted">{shown.length} ta mahsulot topildi</span></div><div className="row"><button className="btn btn-outline mobile-filter" onClick={() => setFiltersOpen(true)}><SlidersHorizontal/> Filtr</button><label><span className="sr-only">Saralash</span><select className="select sort" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Nomi bo‘yicha</option><option value="new">Eng yangi</option><option value="cheap">Arzon narx</option><option value="expensive">Qimmat narx</option></select></label></div></div><div className="catalog-layout">{filter}<div>{catalogState.loading ? <LoadingGrid/> : catalogState.error ? <StatePanel error={catalogState.error} onRetry={loadCatalog}/> : shown.length ? <><div className="product-grid catalog-products">{shown.slice(0, visible).map(product => <ProductCard key={product.id} {...{ product, go, add, toggleFavorite }} loved={favorites.includes(product.id)}/>)}</div>{visible < shown.length && <div className="load-more"><button className="btn btn-outline" onClick={() => setVisible(value => value + PAGE_SIZE)}>Yana yuklash</button></div>}</> : <div className="card"><Empty title="Mahsulot topilmadi" text="Qidiruv so‘zini yoki filtrlarni o‘zgartirib ko‘ring."/></div>}</div></div>{filtersOpen && <div className="filter-overlay">{filter}</div>}</section>;
}

function ServerCatalog({go,add,toggleFavorite,favorites,query,setQuery,references,onItemsLoaded=()=>{},initialCategoryIds=[],title='Mahsulotlar katalogi',cmsBanners=[],navigateTarget}){const[filters,setFilters]=useState({categoryIds:initialCategoryIds,brandIds:[],attributes:{},minPrice:'',maxPrice:'',inStock:false,sort:'name'}),[result,setResult]=useState({items:[],total:0,facets:{categories:[],brands:[],attributes:{},price:{}}}),[state,setState]=useState({loading:true,error:''}),[page,setPage]=useState(1),[filtersOpen,setFiltersOpen]=useState(false),requestGeneration=useRef(0);const key=JSON.stringify(filters);const fetchPage=useCallback(async(nextPage=1,append=false)=>{const generation=++requestGeneration.current;setState({loading:true,error:''});try{const data=await loadStorefrontCatalog({query,categoryIds:filters.categoryIds,brandIds:filters.brandIds,attributes:filters.attributes,minPrice:filters.minPrice||null,maxPrice:filters.maxPrice||null,inStock:filters.inStock,sort:filters.sort,page:nextPage,pageSize:PAGE_SIZE});if(generation!==requestGeneration.current)return;const items=safeArray(data.items).map(adaptProduct);onItemsLoaded(items);setResult(current=>({items:append?[...current.items,...items]:items,total:Number(data.total||0),facets:data.facets||{categories:[],brands:[],attributes:{},price:{}}}));setPage(nextPage);setState({loading:false,error:''});}catch(error){if(generation===requestGeneration.current)setState({loading:false,error:errorText(error)});}},[query,key,onItemsLoaded]);useEffect(()=>{const timer=setTimeout(()=>fetchPage(1,false),query?300:0);return()=>clearTimeout(timer)},[fetchPage]);const toggle=(field,value)=>setFilters(current=>({...current,[field]:current[field].includes(value)?current[field].filter(x=>x!==value):[...current[field],value]}));const toggleAttribute=(code,value)=>setFilters(current=>{const values=current.attributes[code]||[],next=values.includes(value)?values.filter(x=>x!==value):[...values,value],attributes={...current.attributes};if(next.length)attributes[code]=next;else delete attributes[code];return{...current,attributes}});const reset=()=>{setQuery('');setFilters({categoryIds:initialCategoryIds,brandIds:[],attributes:{},minPrice:'',maxPrice:'',inStock:false,sort:'name'})};const renderFilter=()=> <aside className="filter card"><div className="between"><b>Server filtrlar</b><button className="mobile-filter-close" onClick={()=>setFiltersOpen(false)} aria-label="Filtrlarni yopish"><X/></button></div><div className="filter-block"><b>Kategoriyalar</b>{safeArray(result.facets?.categories).map(item=><label className="check-row" key={item.id}><input type="checkbox" checked={filters.categoryIds.includes(String(item.id))} onChange={()=>toggle('categoryIds',String(item.id))}/><span>{item.name} ({item.count})</span></label>)}</div><div className="filter-block"><b>Brendlar</b>{safeArray(result.facets?.brands).map(item=><label className="check-row" key={item.id}><input type="checkbox" checked={filters.brandIds.includes(String(item.id))} onChange={()=>toggle('brandIds',String(item.id))}/><span>{item.name} ({item.count})</span></label>)}</div>{Object.entries(result.facets?.attributes||{}).map(([code,values])=><div className="filter-block" key={code}><b>{code}</b>{safeArray(values).map(item=><label className="check-row" key={JSON.stringify(item.value)}><input type="checkbox" checked={(filters.attributes[code]||[]).some(value=>JSON.stringify(value)===JSON.stringify(item.value))} onChange={()=>toggleAttribute(code,item.value)}/><span>{plainValue(item.value)} ({item.count})</span></label>)}</div>)}<div className="filter-block"><b>Narx oralig‘i</b><div className="row"><input className="input" type="number" min="0" value={filters.minPrice} onChange={e=>setFilters({...filters,minPrice:e.target.value})} placeholder="dan"/><input className="input" type="number" min="0" value={filters.maxPrice} onChange={e=>setFilters({...filters,maxPrice:e.target.value})} placeholder="gacha"/></div></div><label className="check-row"><input type="checkbox" checked={filters.inStock} onChange={e=>setFilters({...filters,inStock:e.target.checked})}/><span>Faqat mavjudlari</span></label><button className="btn btn-outline btn-block" onClick={reset}>Tozalash</button></aside>;return <section className="container catalog-page"><CatalogTopBanner banners={cmsBanners} navigateTarget={navigateTarget}/><div className="breadcrumbs">Bosh sahifa <ChevronRight/> Katalog</div><div className="between catalog-title"><div><h1 className="title">{title}</h1><span className="muted">{result.total} ta mahsulot topildi</span></div><div className="row"><button className="btn btn-outline mobile-filter" onClick={()=>setFiltersOpen(true)}><SlidersHorizontal/> Filtr</button><select className="select sort" value={filters.sort} onChange={e=>setFilters({...filters,sort:e.target.value})}><option value="name">Nomi bo‘yicha</option><option value="new">Eng yangi</option><option value="cheap">Arzon narx</option><option value="expensive">Qimmat narx</option></select></div></div><div className="catalog-layout">{renderFilter()}<div>{state.loading&&!result.items.length?<LoadingGrid/>:state.error?<StatePanel error={state.error} onRetry={()=>fetchPage(1,false)}/>:result.items.length?<><div className="product-grid catalog-products">{result.items.map(product=><ProductCard key={product.id} {...{product,go,add,toggleFavorite}} loved={favorites.includes(product.id)}/>)}</div>{result.items.length<result.total&&<div className="load-more"><button className="btn btn-outline" disabled={state.loading} onClick={()=>fetchPage(page+1,true)}>{state.loading?'Yuklanmoqda…':'Yana yuklash'}</button></div>}</>:<div className="card"><Empty title="Mahsulot topilmadi" text="Qidiruv yoki facetlarni o‘zgartiring."/></div>}</div></div>{filtersOpen&&<div className="filter-overlay">{renderFilter()}</div>}</section>}

function RichDescription({product}){const media=new Map(safeArray(product.media).map(item=>[String(item.id),item]));const blocks=safeArray(product.descriptionBlocks);if(!blocks.length)return <p>{product.description||'Mahsulot tavsifi kiritilmagan.'}</p>;return <div className="structured-product-description">{blocks.map((block,index)=>{if(block.type==='text')return <p key={index}>{block.text}</p>;if(block.type==='heading'){const Tag=`h${Math.min(4,Math.max(2,Number(block.level)||2))}`;return <Tag key={index}>{block.text}</Tag>}if(block.type==='list')return <ul key={index}>{safeArray(block.items).map((item,i)=><li key={i}>{plainValue(item)}</li>)}</ul>;if(block.type==='table')return <div className="table-wrap" key={index}><table className="table"><thead><tr>{safeArray(block.headers).map((cell,i)=><th key={i}>{plainValue(cell)}</th>)}</tr></thead><tbody>{safeArray(block.rows).map((row,i)=><tr key={i}>{safeArray(row).map((cell,j)=><td key={j}>{plainValue(cell)}</td>)}</tr>)}</tbody></table></div>;if(block.type==='image'){const item=media.get(String(block.media_id));return item?<figure key={index}><img src={item.url} alt={block.caption||item.alt||product.name}/>{block.caption&&<figcaption>{block.caption}</figcaption>}</figure>:null}if(block.type==='video'||block.type==='link')return <p key={index}><a href={block.url} target="_blank" rel="noopener noreferrer">{block.label||(block.type==='video'?'Videoni ko‘rish':'Havolani ochish')}</a></p>;return null})}</div>}

function Product({ product, go, add, toggleFavorite, loved, related, favorites }) {
  return <section className="container product-page"><div className="breadcrumbs"><button onClick={() => go('home')}>Bosh sahifa</button><ChevronRight/><button onClick={() => go('catalog')}>Katalog</button><ChevronRight/>{product.name}</div><div className="product-detail card"><div className="gallery single-media"><div className="main-img"><ProductMedia product={product}/>{product.oldPrice > product.price && <span className="badge">Aksiya</span>}</div></div><div className="detail-info"><div className="row"><Status type={product.stock ? 'green' : 'red'}>{product.stock ? 'Sotuvda mavjud' : 'Sotuvda yo‘q'}</Status></div><h1>{product.name}</h1><p className="muted">Artikul: {product.sku || '—'}</p><div className="divider"/>{product.oldPrice > product.price && <div className="old-price">{money(product.oldPrice)}</div>}<div className="detail-price">{money(product.price)}</div><div className={`stock ${product.stock ? '' : 'out'}`}>{product.stock ? <Check size={18}/> : <X size={18}/>} {product.stock ? `Omborda ${product.stock} dona mavjud` : 'Omborda mavjud emas'}</div><div className="detail-actions"><button className="btn btn-primary" onClick={() => add(product)} disabled={!product.stock}><ShoppingCart/> Savatchaga</button><button className={`btn btn-outline ${loved ? 'loved' : ''}`} onClick={() => toggleFavorite(product)}><Heart fill={loved ? 'currentColor' : 'none'}/> {loved ? 'Saralangan' : 'Saralash'}</button></div></div></div><div className="detail-tabs card"><h2>Mahsulot haqida</h2><RichDescription product={product}/><h3>Asosiy xususiyatlar</h3>{product.attributes.length ? <div className="spec-grid">{product.attributes.map(item => <div key={`${item.code}-${item.value}`}><span>{item.name}</span><b>{item.value || '—'}</b></div>)}</div> : <p className="muted">Xususiyatlar kiritilmagan.</p>}</div>{related.length > 0 && <ProductSection title="O‘xshash mahsulotlar" subtitle="Sizga mos takliflar" list={related} {...{ go, add, toggleFavorite, favorites }}/>}</section>;
}

function Cart({ cartItems, go, updateCart }) {
  const total = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  return <section className="container cart-page"><div className="breadcrumbs">Bosh sahifa <ChevronRight/> Savatcha</div><h1 className="title">Savatcha</h1>{cartItems.length ? <div className="cart-layout"><div className="stack">{cartItems.map(product => <div className="cart-item card" key={product.id}><ProductMedia product={product}/><div className="cart-name"><b>{product.name}</b><span className="muted">Omborda: {product.stock} dona</span><button onClick={() => updateCart(product, 0)}><Trash2/> O‘chirish</button></div><div className="qty"><button onClick={() => updateCart(product, product.qty - 1)} aria-label="Miqdorni kamaytirish"><Minus/></button><b>{product.qty}</b><button onClick={() => updateCart(product, product.qty + 1)} disabled={product.qty >= product.stock} aria-label="Miqdorni oshirish"><Plus/></button></div><div className="price">{money(product.price * product.qty)}</div></div>)}</div><OrderTotal total={total} count={cartItems.reduce((sum, item) => sum + item.qty, 0)} onClick={() => go('checkout')}/></div> : <div className="card"><Empty title="Savatchangiz bo‘sh" text="Katalogdan o‘zingizga yoqqan texnikani tanlang."/><div className="center-action"><button className="btn btn-primary" onClick={() => go('catalog')}>Katalogga o‘tish</button></div></div>}</section>;
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

function Footer({ go, settings, pages, menuItems, navigateTarget }) {
  const siteName=plainValue(settings?.site_name)||'Texnobazar',footerMenu=menuItems.filter(item=>!item.parent_id&&item.location==='footer').slice(0,6),footerChildren=parent=>menuItems.filter(item=>item.parent_id===parent.id&&item.location==='footer');
  return <footer><div className="container footer-top"><div><span><Truck/> Respublika bo‘ylab yetkazish</span><span><ShieldCheck/> Rasmiy kafolat</span><span><CreditCard/> Qulay to‘lov</span></div></div><div className="container footer-grid"><div className="footer-brand"><Logo go={go} siteName={siteName}/><p>{plainValue(settings?.footer_text)||'Texnika olamidagi ishonchli hamrohingiz.'}</p><a href={`tel:${plainValue(settings?.support_phone).replace(/\s/g,'')}`}>{plainValue(settings?.support_phone)}</a></div><div><b>Ma’lumotlar</b>{pages.slice(0,6).map(page=><button key={page.id} onClick={()=>go('page',page)}>{plainValue(page.title)}</button>)}</div><div><b>Katalog</b>{footerMenu.length?footerMenu.map(item=><React.Fragment key={item.id}><button onClick={()=>navigateTarget(item.target_url)}>{plainValue(item.label)}</button>{footerChildren(item).map(child=><button className="footer-subitem" key={child.id} onClick={()=>navigateTarget(child.target_url)}>{plainValue(child.label)}</button>)}</React.Fragment>):<><button onClick={()=>go('catalog')}>Barcha mahsulotlar</button><button onClick={()=>go('cart')}>Savatcha</button><button onClick={()=>go('profile')}>Shaxsiy kabinet</button></>}</div><div><b>Yangiliklardan xabardor bo‘ling</b><p>{plainValue(settings?.newsletter_text)||'Yangi mahsulot va aksiyalar haqida birinchi bo‘lib biling.'}</p><label className="subscribe"><span className="sr-only">E-pochta</span><input type="email" placeholder="E-pochta manzilingiz"/><button aria-label="Obuna bo‘lish"><Send/></button></label></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} {siteName}. Barcha huquqlar himoyalangan.</span><span>{plainValue(settings?.payment_label)||'Click · Payme · Naqd'}</span></div></footer>;
}
function MobileNav({ go, cart, route }) { const item=(view,Icon,label)=><button className={route?.view===view?'active':''} onClick={()=>go(view)}><Icon/><span>{label}</span></button>;return <nav className="mobile-nav" aria-label="Mobil navigatsiya">{item('home',HomeIcon,'Bosh sahifa')}{item('catalog',Grid2X2,'Katalog')}<button onClick={()=>go('cart')} className={`mob-cart ${route?.view==='cart'?'active':''}`}><ShoppingCart/>{cart.length>0&&<i>{cart.reduce((sum,item)=>sum+item.qty,0)}</i>}<span>Savatcha</span></button>{item('profile',User,'Kabinet')}</nav>; }
function LoadingGrid() { return <div className="loading-grid" aria-live="polite">{Array.from({ length: 8 }, (_, index) => <div className="product-skeleton" key={index}/>)}</div>; }
function InlineError({ text, onRetry }) { return <div className="container inline-error" role="alert"><span>{text}</span>{onRetry && <button className="btn btn-outline" onClick={onRetry}>Qayta urinish</button>}</div>; }
function StatePanel({ loading, error, onRetry, title }) { return <div className="state-panel card" role={error ? 'alert' : 'status'}>{loading ? <><LoaderCircle className="spin"/><h2>Yuklanmoqda…</h2></> : <><h2>{error ? 'Ma’lumotni yuklab bo‘lmadi' : title || 'Ma’lumot topilmadi'}</h2>{error && <p>{error}</p>}{onRetry && <button className="btn btn-primary" onClick={onRetry}>Qayta urinish</button>}</>}</div>; }
