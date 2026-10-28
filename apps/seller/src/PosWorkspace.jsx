import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import{AlertTriangle,ArrowLeftRight,ArrowUpRight,BarChart3,Boxes,Check,ChevronLeft,ChevronRight,Clock,CreditCard,ExternalLink,Eye,EyeOff,FileText,Home,Layers,Mail,MapPin,Menu,Package,Plus,Printer,QrCode,ReceiptText,RotateCcw,Search,Send,ShoppingCart,Store,Trash2,Truck,User,Warehouse,X,Trophy}from'lucide-react';
import{DualPrice,Empty,Modal,QrScanButton,Status,formatDualMoney,useExchangeRate,printThermalReceipt,ThermalReceiptPreview}from'@texnobazar/ui';
import{createPosPendingSale,updatePosPendingSale,deletePosPendingSale,getBrowserClient,getPosBatchUnits,getPosPendingSale,getPosProductAvailability,getPosReferences,getPosUnitContext,getReceiptDeliveryStatus,getSaleReceipt,listMyPosPendingSalesByDate,listMyPosSales,listPosUnits,queueSaleReceipt,relocatePosUnits}from'@texnobazar/data';
import ProfileWorkspace from'./ProfileWorkspace';
import AttendanceWorkspace from'./AttendanceWorkspace';
import ProductCatalogWorkspace from'./ProductCatalogWorkspace';
import ReturnsWorkspace from'./ReturnsWorkspace';
import SellerRatingWorkspace from'./SellerRatingWorkspace';
import CustomerTabsBar from './CustomerTabsBar';
import BranchTransferWorkspace from './BranchTransferWorkspace';


const msg=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const when=value=>value?new Date(value).toLocaleString('uz-UZ'):'—';
const address=value=>{if(!value)return'';if(typeof value==='string')return value;return[value.line1,value.line2,value.district,value.city,value.region,value.postal_code].filter(Boolean).join(', ')};
const labels={pending:'Kutilmoqda',confirmed:'Tasdiqlandi',rejected:'Rad etildi',expired:'Muddati tugadi',nasiya:'Nasiya'};
const unitStates={available:'Sotuvga tayyor',reserved:'Band qilingan',in_transit:'Yo‘lda',sold:'Sotilgan',returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:'Ta’mirda'};
const colors={pending:'orange',confirmed:'green',rejected:'red',expired:'gray',nasiya:'purple'};
const lineTax=line=>Math.round((Number(line.unit_price||0)-Number(line.discount||0))*Number(line.tax_rate||0))/100;
const lineTotal=line=>Number(line.unit_price||0)-Number(line.discount||0)+lineTax(line);
// Money inputs stay strings so the seller can fully clear a value instead of
// fighting a sticky leading zero.
const numericText=value=>{const raw=String(value??'').replace(/[^\d.]/g,'');const[whole,...rest]=raw.split('.');const head=whole.replace(/^0+(?=\d)/,'');return rest.length?`${head||'0'}.${rest.join('').slice(0,2)}`:head};
const STOREFRONT=(import.meta.env?.VITE_STOREFRONT_URL)||'https://texnobazar-storefront.netlify.app';
const getProductStorefrontUrl=(item)=>{
  if(!item)return STOREFRONT;
  if(item.storefront_url){
    return item.storefront_url.startsWith('http')?item.storefront_url:`${STOREFRONT}${item.storefront_url.startsWith('/')?'':'/'}${item.storefront_url}`;
  }
  if(item.slug){
    return `${STOREFRONT}/product/${encodeURIComponent(item.slug)}`;
  }
  const query=item.sku||item.product_name||'';
  return `${STOREFRONT}/catalog?query=${encodeURIComponent(query)}`;
};
const todayInput=()=>{const date=new Date();return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`};
const emptySales=()=>({items:[],today:{count:0,total:0,profit:0,rank:0,discount:0}});

const getCartKey = (branchId, profileId) => {
  if (!branchId) return null;
  return `texnobazar:seller-cart:${profileId || 'active'}:${branchId}`;
};

const getPageKey = (branchId, profileId) => {
  if (!branchId) return null;
  return `texnobazar:seller-page:${profileId || 'active'}:${branchId}`;
};

const getEditingKey = (branchId, profileId) => {
  if (!branchId) return null;
  return `texnobazar:seller-editing:${profileId || 'active'}:${branchId}`;
};

const getTabsKey = (branchId, profileId) => {
  if (!branchId) return null;
  return `texnobazar:seller-tabs:${profileId || 'active'}:${branchId}`;
};

const getActiveTabKey = (branchId, profileId) => {
  if (!branchId) return null;
  return `texnobazar:seller-active-tab:${profileId || 'active'}:${branchId}`;
};

const createInitialTab = (index = 1, initialData = {}) => ({
  id: initialData.id || `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
  label: initialData.label || `${index}-mijoz`,
  cart: Array.isArray(initialData.cart) ? initialData.cart : [],
  customer: initialData.customer || { full_name: '', phone: '', address: '' },
  notes: initialData.notes || '',
  paymentType: initialData.paymentType || 'cash',
  showCustomer: Boolean(initialData.showCustomer),
  editingPendingSale: initialData.editingPendingSale || null,
  createdAt: initialData.createdAt || Date.now()
});

const readStoredCart = (branchId, profileId) => {
  if (!branchId) return [];
  const primaryKey = getCartKey(branchId, profileId);
  const fallbackKeys = [
    primaryKey,
    profileId ? `texnobazar:seller-cart:${profileId}:${branchId}` : null,
    `texnobazar:seller-cart:active:${branchId}`,
    `texnobazar:seller-cart:${branchId}`
  ].filter(Boolean);

  for (const k of fallbackKeys) {
    try {
      const raw = localStorage.getItem(k);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.filter(line => line && line.id);
        }
      }
    } catch {}
  }
  return [];
};

const readStoredEditingSale = (branchId, profileId) => {
  const k = getEditingKey(branchId, profileId);
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const readStoredTabs = (branchId, profileId) => {
  if (!branchId) return [createInitialTab(1)];
  const tabsKey = getTabsKey(branchId, profileId);
  try {
    const raw = tabsKey ? localStorage.getItem(tabsKey) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((t, idx) => ({
          id: t.id || `tab_${idx + 1}`,
          label: t.label || `${idx + 1}-mijoz`,
          cart: Array.isArray(t.cart) ? t.cart.filter(x => x && x.id) : [],
          customer: t.customer || { full_name: '', phone: '', address: '' },
          notes: t.notes || '',
          paymentType: t.paymentType || 'cash',
          showCustomer: Boolean(t.showCustomer || t.customer?.full_name || t.customer?.phone),
          editingPendingSale: t.editingPendingSale || null,
          createdAt: t.createdAt || Date.now()
        }));
      }
    }
  } catch {}

  // Fallback / migration from legacy single cart if exists:
  const legacyCart = readStoredCart(branchId, profileId);
  const legacyEditing = readStoredEditingSale(branchId, profileId);
  let legacyMeta = null;
  try {
    const metaKey = `texnobazar:seller-cart-meta:${branchId}`;
    const raw = localStorage.getItem(metaKey);
    if (raw) legacyMeta = JSON.parse(raw);
  } catch {}

  return [createInitialTab(1, {
    cart: legacyCart,
    editingPendingSale: legacyEditing,
    notes: legacyMeta?.notes || legacyEditing?.notes || '',
    customer: legacyMeta?.customer || (legacyEditing?.customer ? {
      full_name: legacyEditing.customer.full_name || '',
      phone: legacyEditing.customer.phone || '',
      address: legacyEditing.customer.address || ''
    } : { full_name: '', phone: '', address: '' }),
    showCustomer: Boolean(legacyMeta?.showCustomer || legacyEditing?.customer?.phone || legacyEditing?.customer?.full_name),
    paymentType: legacyEditing?.payments?.[0]?.method_code === 'nasiya' ? 'nasiya' : 'cash'
  })];
};

const readStoredActiveTabId = (branchId, profileId, initialTabs = []) => {
  const activeKey = getActiveTabKey(branchId, profileId);
  try {
    const saved = activeKey ? localStorage.getItem(activeKey) : null;
    if (saved && initialTabs.some(t => t.id === saved)) {
      return saved;
    }
  } catch {}
  return initialTabs[0]?.id || null;
};

export default function PosWorkspace({branchId,profile,toast,focusPendingSaleId,clearFocus}){
  const rate=useExchangeRate();

  const tabsKey = useMemo(() => getTabsKey(branchId, profile?.id), [branchId, profile?.id]);
  const activeTabKey = useMemo(() => getActiveTabKey(branchId, profile?.id), [branchId, profile?.id]);
  const cartKey = useMemo(() => getCartKey(branchId, profile?.id), [branchId, profile?.id]);
  const pageKey = useMemo(() => getPageKey(branchId, profile?.id), [branchId, profile?.id]);
  const editingKey = useMemo(() => getEditingKey(branchId, profile?.id), [branchId, profile?.id]);

  const [tabs, setTabs] = useState(() => readStoredTabs(branchId, profile?.id));
  const [activeTabId, setActiveTabId] = useState(() => {
    const initialTabs = readStoredTabs(branchId, profile?.id);
    return readStoredActiveTabId(branchId, profile?.id, initialTabs);
  });

  const activeTab = useMemo(() => {
    return tabs.find(t => t.id === activeTabId) || tabs[0] || createInitialTab(1);
  }, [tabs, activeTabId]);

  const cart = activeTab.cart || [];
  const editingPendingSale = activeTab.editingPendingSale || null;
  const [closingTab, setClosingTab] = useState(null);

  const totalAllCartItems = useMemo(() => {
    return tabs.reduce((sum, t) => sum + (t.cart?.length || 0), 0);
  }, [tabs]);

  const [page, setPage] = useState(() => {
    try {
      const hash = typeof window !== 'undefined' ? window.location.hash?.replace(/^#/, '') : '';
      if (hash && ['home', 'products', 'scan', 'cart', 'pos', 'returns', 'attendance', 'profile', 'kpi', 'branch_transfer', 'rating'].includes(hash)) {
        return hash === 'pos' ? 'cart' : hash;
      }
      const saved = pageKey ? localStorage.getItem(pageKey) : null;
      if (saved && ['home', 'products', 'scan', 'cart', 'returns', 'attendance', 'profile', 'kpi', 'branch_transfer'].includes(saved)) {
        return saved;
      }
      const initialTabs = readStoredTabs(branchId, profile?.id);
      if (initialTabs.some(t => t.cart && t.cart.length > 0)) return 'cart';
    } catch {}
    return 'home';
  });

  useEffect(() => {
    const handleHash = () => {
      const h = window.location.hash?.replace(/^#/, '');
      if (h && ['home', 'products', 'scan', 'cart', 'pos', 'returns', 'attendance', 'profile', 'kpi', 'branch_transfer', 'rating'].includes(h)) {
        setPage(h === 'pos' ? 'cart' : h);
      }
    };
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  const [refs,setRefs]=useState(null),[units,setUnits]=useState([]),[sales,setSales]=useState(emptySales),[pending,setPending]=useState({items:[]}),[homeDate,setHomeDate]=useState(todayInput);
  const [query,setQuery]=useState(''),[debounced,setDebounced]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[receipt,setReceipt]=useState(null),[pendingDetail,setPendingDetail]=useState(null),[created,setCreated]=useState(null);
  const [cancelConfirmSale,setCancelConfirmSale]=useState(null);
  const [canceling,setCanceling]=useState(false);
  const [menuOpen,setMenuOpen]=useState(false);
  const [relocateBatch,setRelocateBatch]=useState([]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Persist tabs and active tab to localStorage
  useEffect(() => {
    if (!tabsKey) return;
    try {
      localStorage.setItem(tabsKey, JSON.stringify(tabs));
      // Legacy fallback sync
      if (cartKey) {
        if (cart.length > 0) localStorage.setItem(cartKey, JSON.stringify(cart));
        else localStorage.removeItem(cartKey);
      }
      if (editingKey) {
        if (editingPendingSale) localStorage.setItem(editingKey, JSON.stringify(editingPendingSale));
        else localStorage.removeItem(editingKey);
      }
    } catch {}
  }, [tabs, tabsKey, cartKey, editingKey, cart, editingPendingSale]);

  useEffect(() => {
    if (!activeTabKey || !activeTabId) return;
    try {
      localStorage.setItem(activeTabKey, activeTabId);
    } catch {}
  }, [activeTabId, activeTabKey]);

  // Persist page to localStorage and hash
  useEffect(() => {
    if (!pageKey || !page) return;
    try {
      localStorage.setItem(pageKey, page);
      const targetHash = page === 'cart' ? 'pos' : page;
      if (window.location.hash !== `#${targetHash}`) {
        window.history.replaceState(null, '', `#${targetHash}`);
      }
    } catch {}
  }, [page, pageKey]);

  // Mobile switching / backgrounding protection: save on hide/blur, restore on show/focus
  useEffect(() => {
    const persistNow = () => {
      if (tabsKey && tabsRef.current) {
        try {
          localStorage.setItem(tabsKey, JSON.stringify(tabsRef.current));
        } catch {}
      }
      if (pageKey && page) {
        try { localStorage.setItem(pageKey, page); } catch {}
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistNow();
      } else if (document.visibilityState === 'visible' && tabsKey) {
        const saved = readStoredTabs(branchId, profile?.id);
        if (saved.length > 0 && (!tabsRef.current || tabsRef.current.length === 0)) {
          setTabs(saved);
        }
      }
    };

    const handleFocus = () => {
      if (tabsKey) {
        const saved = readStoredTabs(branchId, profile?.id);
        if (saved.length > 0 && (!tabsRef.current || tabsRef.current.length === 0)) {
          setTabs(saved);
        }
      }
    };

    window.addEventListener('pagehide', persistNow);
    window.addEventListener('beforeunload', persistNow);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('pagehide', persistNow);
      window.removeEventListener('beforeunload', persistNow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [tabsKey, pageKey, branchId, profile?.id, page]);

  const setCart = useCallback((updater) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const nextCart = typeof updater === 'function' ? updater(t.cart || []) : updater;
      return { ...t, cart: nextCart };
    }));
  }, [activeTabId]);

  const setCustomer = useCallback((updater) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const nextCust = typeof updater === 'function' ? updater(t.customer || { full_name: '', phone: '', address: '' }) : updater;
      return { ...t, customer: nextCust };
    }));
  }, [activeTabId]);

  const setNotes = useCallback((updater) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const nextNotes = typeof updater === 'function' ? updater(t.notes || '') : updater;
      return { ...t, notes: nextNotes };
    }));
  }, [activeTabId]);

  const setPaymentType = useCallback((updater) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const nextPay = typeof updater === 'function' ? updater(t.paymentType || 'cash') : updater;
      return { ...t, paymentType: nextPay };
    }));
  }, [activeTabId]);

  const setShowCustomer = useCallback((updater) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const nextShow = typeof updater === 'function' ? updater(Boolean(t.showCustomer)) : updater;
      return { ...t, showCustomer: Boolean(nextShow) };
    }));
  }, [activeTabId]);

  const setEditingPendingSale = useCallback((val) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      return { ...t, editingPendingSale: typeof val === 'function' ? val(t.editingPendingSale) : val };
    }));
  }, [activeTabId]);

  const addNewTab = useCallback(() => {
    let newTabId = null;
    setTabs(prev => {
      const maxNum = prev.reduce((max, t) => {
        const match = t.label?.match(/^(\d+)-mijoz$/);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
      }, 0);
      const newNum = Math.max(maxNum + 1, prev.length + 1);
      const newTab = createInitialTab(newNum);
      newTabId = newTab.id;
      return [...prev, newTab];
    });
    if (newTabId) setActiveTabId(newTabId);
    setCreated(null);
    toast?.('Yangi mijoz tabi ochildi');
  }, [toast]);

  const handleDeleteTab = useCallback((tabId) => {
    let newActiveId = null;
    let toastMsg = null;
    setTabs(prev => {
      if (prev.length <= 1) {
        const fresh = createInitialTab(1);
        newActiveId = fresh.id;
        toastMsg = 'Mijoz savati tozalandi';
        return [fresh];
      }
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        const closedIdx = prev.findIndex(t => t.id === tabId);
        const nextActive = next[Math.max(0, closedIdx - 1)] || next[0];
        newActiveId = nextActive.id;
      }
      toastMsg = 'Mijoz tabi yopildi';
      return next;
    });
    if (newActiveId) setActiveTabId(newActiveId);
    if (toastMsg) toast?.(toastMsg);
    setClosingTab(null);
    setCreated(null);
  }, [activeTabId, toast]);

  const requestCloseTab = useCallback((tabId) => {
    const tabToClose = tabs.find(t => t.id === tabId);
    if (!tabToClose) return;
    if (tabToClose.cart && tabToClose.cart.length > 0) {
      setClosingTab(tabToClose);
    } else {
      handleDeleteTab(tabId);
    }
  }, [tabs, handleDeleteTab]);

  const onSaleSuccess = useCallback((tabId, result) => {
    let nextTargetId = null;
    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== tabId);
      if (remaining.length > 0) {
        const nextTarget = remaining.find(t => t.cart.length > 0) || remaining[0];
        nextTargetId = nextTarget.id;
        return remaining;
      } else {
        const fresh = createInitialTab(1);
        nextTargetId = fresh.id;
        return [fresh];
      }
    });
    if (nextTargetId) setActiveTabId(nextTargetId);
  }, []);

  const loadHome=async date=>{const[s,p]=await Promise.all([listMyPosSales({branchId,date,pageSize:100}),listMyPosPendingSalesByDate({branchId,date,pageSize:100})]);setSales(s||emptySales());setPending(p||{items:[]})};
  const load=async()=>{if(!branchId){setLoading(false);return}setLoading(true);setError('');try{const[r]=await Promise.all([getPosReferences(branchId),loadHome(homeDate)]);setRefs(r)}catch(e){setError(msg(e))}finally{setLoading(false)}};
  const changeHomeDate=async value=>{setHomeDate(value);setLoading(true);setError('');try{await loadHome(value)}catch(e){setError(msg(e))}finally{setLoading(false)}};
  useEffect(()=>{load()},[branchId]);
  useEffect(()=>{setUnits([]);const id=setTimeout(()=>setDebounced(query.trim()),300);return()=>clearTimeout(id)},[query]);
  useEffect(()=>{if(!branchId||page!=='scan'||!debounced){setUnits([]);return}let active=true;listPosUnits({branchId,query:debounced,pageSize:30}).then(r=>active&&setUnits(r.items||[])).catch(e=>active&&setError(msg(e)));return()=>{active=false}},[branchId,page,debounced]);

  const add = useCallback(unit => {
    let toastMsg = null;
    setTabs(prevTabs => {
      const targetTab = prevTabs.find(t => t.id === activeTabId) || prevTabs[0];
      if (targetTab.cart.some(x => x.id === unit.id)) {
        toastMsg = 'Bu mahsulot ushbu mijoz savdosida mavjud';
        return prevTabs;
      }
      const otherTab = prevTabs.find(t => t.id !== targetTab.id && t.cart.some(x => x.id === unit.id));
      if (otherTab) {
        const otherName = otherTab.customer?.full_name?.trim() || otherTab.label || 'Boshqa mijoz';
        toastMsg = `Bu tovar allaqachon "${otherName}" tabida band qilingan!`;
        return prevTabs;
      }
      const tabName = targetTab.customer?.full_name?.trim() || targetTab.label || 'Mijoz';
      toastMsg = `Mahsulot (${tabName}) savdosiga qo‘shildi`;
      const nextLine = {
        ...unit,
        unit_price: numericText(unit.retail_price),
        discount: '',
        tax_rate: Number(unit.tax_rate || 0)
      };
      return prevTabs.map(t => t.id === targetTab.id ? { ...t, cart: [...t.cart, nextLine] } : t);
    });
    if (toastMsg) toast?.(toastMsg);
  }, [activeTabId, toast]);

  const addMultiple = useCallback(newUnits => {
    let toastMsg = null;
    setTabs(prevTabs => {
      const targetTab = prevTabs.find(t => t.id === activeTabId) || prevTabs[0];
      const existingIds = new Set(targetTab.cart.map(x => x.id));
      const otherReservedIds = new Set(prevTabs.filter(t => t.id !== targetTab.id).flatMap(t => t.cart.map(x => x.id)));

      const toAdd = newUnits.filter(u => !existingIds.has(u.id) && !otherReservedIds.has(u.id));
      if (!toAdd.length) {
        toastMsg = 'Bu mahsulotlar allaqachon savdoga qo‘shilgan yoki boshqa tabda band';
        return prevTabs;
      }
      const tabName = targetTab.customer?.full_name?.trim() || targetTab.label || 'Mijoz';
      toastMsg = `${toAdd.length} ta mahsulot (${tabName}) savdosiga qo‘shildi`;
      const newLines = toAdd.map(unit => ({
        ...unit,
        unit_price: numericText(unit.retail_price),
        discount: '',
        tax_rate: Number(unit.tax_rate || 0)
      }));
      return prevTabs.map(t => t.id === targetTab.id ? { ...t, cart: [...t.cart, ...newLines] } : t);
    });
    if (toastMsg) toast?.(toastMsg);
  }, [activeTabId, toast]);

  const addToRelocate = unit => {
    let toastMsg = null;
    setRelocateBatch(current => {
      if (current.some(x => x.id === unit.id)) {
        toastMsg = 'Bu mahsulot birligi ro‘yxatda bor';
        return current;
      }
      toastMsg = 'Ko‘chirish ro‘yxatiga qo‘shildi';
      return [...current, unit];
    });
    if (toastMsg) toast?.(toastMsg);
  };
  const openReceipt=async id=>{try{setReceipt({...await getSaleReceipt(id),sale_id:id})}catch(e){setError(msg(e))}};
  const openPending=async id=>{try{setPendingDetail(await getPosPendingSale(id))}catch(e){setError(msg(e))}};

  const startEditPendingSale = sale => {
    if (!sale || !sale.lines?.length) return;
    const mappedCart = sale.lines.map(line => ({
      id: line.unit_id,
      product_id: line.product_id,
      product_name: line.product_name,
      sku: line.sku,
      qr_code: line.qr_code,
      serial_number: line.serial_number,
      image: line.image,
      unit_price: numericText(line.unit_price),
      discount: line.discount ? numericText(line.discount) : '',
      tax_rate: Number(line.tax_rate || 0),
      retail_price: line.retail_price,
      minimum_sale_price: line.minimum_sale_price,
      unit_cost: line.unit_cost,
      selected_components: line.selected_components || [],
      location_type: line.location_type || 'store',
      available_branch_count: 1
    }));
    const saleCust = sale.customer ? {
      full_name: sale.customer.full_name || '',
      phone: sale.customer.phone || '',
      address: sale.customer.address || ''
    } : { full_name: '', phone: '', address: '' };
    const pCode = sale.payments?.[0]?.method_code || sale.payments?.[0]?.code;
    const paymentType = pCode === 'nasiya' ? 'nasiya' : (pCode === 'card' || pCode === 'terminal' || pCode === 'click') ? 'card' : 'cash';

    setTabs(prev => {
      const active = prev.find(t => t.id === activeTabId) || prev[0];
      if (active && (!active.cart || active.cart.length === 0) && !active.editingPendingSale) {
        return prev.map(t => t.id === active.id ? {
          ...t,
          label: `So‘rov #${sale.pending_no}`,
          cart: mappedCart,
          editingPendingSale: sale,
          customer: saleCust,
          notes: sale.notes || '',
          paymentType,
          showCustomer: Boolean(saleCust.phone || saleCust.full_name || paymentType === 'nasiya')
        } : t);
      } else {
        const newTab = createInitialTab(prev.length + 1, {
          label: `So‘rov #${sale.pending_no}`,
          cart: mappedCart,
          editingPendingSale: sale,
          customer: saleCust,
          notes: sale.notes || '',
          paymentType,
          showCustomer: Boolean(saleCust.phone || saleCust.full_name || paymentType === 'nasiya')
        });
        setActiveTabId(newTab.id);
        return [...prev, newTab];
      }
    });

    setPendingDetail(null);
    setPage('cart');
    toast?.(`Kassa so‘rovi #${sale.pending_no} tahrirlash uchun ochildi`);
  };

  const cancelPendingSale = async sale => {
    if (!sale?.id) return;
    setCanceling(true);
    try {
      await deletePosPendingSale(sale.id, true);
      toast?.(`So‘rov #${sale.pending_no} bekor qilindi, tovarlar sotuvga qaytarildi`);
      setCancelConfirmSale(null);
      setPendingDetail(null);
      await loadHome(homeDate);
    } catch (e) {
      toast?.(msg(e));
    } finally {
      setCanceling(false);
    }
  };

  useEffect(()=>{
    if(!focusPendingSaleId)return;
    setPage('home');
    openPending(focusPendingSaleId).then(()=>clearFocus?.()).catch(()=>clearFocus?.());
    // Only re-run when the focus target itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[focusPendingSaleId]);
  return <><main className="pos-real-workspace">
    {page!=='scan'&&page!=='products'&&page!=='profile'&&page!=='attendance'&&page!=='returns'&&page!=='branch_transfer'&&!loading&&!error&&<button type="button" className="pos-real-scan-cta pos-real-scan-sticky" onClick={()=>setPage('scan')}><QrCode/><span><b>QR/seriyani kiritish</b><small>Skaner qurilmasi yoki klaviatura orqali</small></span><ChevronRight/></button>}
    {loading?<State text="POS ma’lumotlari yuklanmoqda…"/>:error?<State error text={error} retry={load}/>:page==='home'?<HomePage sales={sales} pending={pending} date={homeDate} setDate={changeHomeDate} profile={profile} openReceipt={openReceipt} openPending={openPending} go={setPage} rate={rate}/>:page==='products'?<ProductCatalogWorkspace branchId={branchId} onAddToCart={add} toast={toast} customerTabsProps={{ tabs, activeTabId, onSelectTab: (id) => { setActiveTabId(id); setCreated(null); }, onAddTab: addNewTab, onCloseTab: requestCloseTab, activeTab }}/>:page==='scan'?<Scanner branchId={branchId} query={query} setQuery={setQuery} units={units} add={add} addMultiple={addMultiple} cart={cart} addToRelocate={addToRelocate} relocateCount={relocateBatch.length} goRelocate={()=>setPage('relocate')} toast={toast} rate={rate} tabs={tabs} activeTabId={activeTabId} onSelectTab={(id)=>{setActiveTabId(id);setCreated(null);}} onAddTab={addNewTab} onCloseTab={requestCloseTab} activeTab={activeTab}/>:page==='cart'?<Cart branchId={branchId} tabs={tabs} activeTab={activeTab} activeTabId={activeTabId} onSelectTab={(id)=>{setActiveTabId(id);setCreated(null);}} onAddTab={addNewTab} onCloseTab={requestCloseTab} onSaleSuccess={onSaleSuccess} setCart={setCart} setCustomer={setCustomer} setNotes={setNotes} setPaymentType={setPaymentType} setShowCustomer={setShowCustomer} setEditingPendingSale={setEditingPendingSale} refs={refs} created={created} setCreated={setCreated} refresh={load} toast={toast} rate={rate}/>:page==='returns'?<ReturnsWorkspace branchId={branchId} toast={toast} goPage={setPage}/>:page==='branch_transfer'?<BranchTransferWorkspace branchId={branchId} profile={profile} toast={toast} onBack={()=>setPage('home')}/>:page==='relocate'?<Relocate branchId={branchId} batch={relocateBatch} setBatch={setRelocateBatch} toast={toast} back={()=>setPage('scan')}/>:page==='attendance'?<AttendanceWorkspace branchId={branchId} profile={profile} toast={toast}/>:page==='profile'?<ProfileWorkspace toast={toast}/>:page==='rating'?<SellerRatingWorkspace branchId={branchId} profile={profile} toast={toast} onBack={()=>setPage('home')}/>:<Kpi branchId={branchId} openReceipt={openReceipt} rate={rate} onOpenRating={()=>setPage('rating')}/>}
  </main>
  <nav className="pos-real-nav">
    {[
      ['home',Home,'Asosiy'],
      ['products',Boxes,'Tovarlar'],
      ['scan',QrCode,'Skaner'],
      ['cart',ShoppingCart,'Savdo'],
      ['returns',RotateCcw,'Qaytarish'],
      ['attendance',Clock,'Davomat']
    ].map(([key,Icon,text])=>(
      <button
        type="button"
        key={key}
        className={page===key?'active':''}
        onClick={()=>{setMenuOpen(false);setPage(key);}}
      >
        <span><Icon/>{key==='cart'&&totalAllCartItems>0&&<i>{totalAllCartItems}</i>}</span>
        {text}
      </button>
    ))}
    <button
      type="button"
      className={page==='kpi'||page==='profile'||page==='rating'||page==='branch_transfer'||menuOpen?'active':''}
      onClick={()=>setMenuOpen(v=>!v)}
      aria-label="Ko‘proq menyu"
    >
      <span><Menu/></span>
      Menyu
    </button>
  </nav>

  {/* Hamburger Menu Modal for KPI, Rating, and Profile */}
  <Modal open={menuOpen} onClose={()=>setMenuOpen(false)} title="Qo‘shimcha menyu">
    <div className="seller-hamburger-panel">
      <div className="hamburger-user-card">
        <div className="user-avatar-circle">
          <User size={22}/>
        </div>
        <div>
          <b>{profile?.full_name||'Sotuvchi'}</b>
          <small>{profile?.email}</small>
        </div>
      </div>
      <div className="hamburger-menu-options">
        <button
          type="button"
          className={`hamburger-option-item ${page==='branch_transfer'?'active':''}`}
          onClick={()=>{setMenuOpen(false);setPage('branch_transfer');}}
        >
          <div className="option-icon-box transfer">
            <ArrowUpRight size={20}/>
          </div>
          <div className="option-text-box">
            <b>Filialga transfer</b>
            <small>Tovarlarni do‘kon yoki ombordan boshqa filialga tarqatish</small>
          </div>
          <ChevronRight size={18} className="chevron"/>
        </button>

        <button
          type="button"
          className={`hamburger-option-item ${page==='rating'?'active':''}`}
          onClick={()=>{setMenuOpen(false);setPage('rating');}}
        >
          <div className="option-icon-box rating">
            <Trophy size={20}/>
          </div>
          <div className="option-text-box">
            <b>Reyting (Sotuvchilar musobaqasi)</b>
            <small>Kunlik, haftalik, oylik va yillik jamoaviy peshqadamlar</small>
          </div>
          <ChevronRight size={18} className="chevron"/>
        </button>

        <button
          type="button"
          className={`hamburger-option-item ${page==='kpi'?'active':''}`}
          onClick={()=>{setMenuOpen(false);setPage('kpi');}}
        >
          <div className="option-icon-box kpi">
            <BarChart3 size={20}/>
          </div>
          <div className="option-text-box">
            <b>Mening KPI ko‘rsatkichlarim</b>
            <small>Kunlik va oylik shaxsiy savdo natijalari va daromad</small>
          </div>
          <ChevronRight size={18} className="chevron"/>
        </button>

        <button
          type="button"
          className={`hamburger-option-item ${page==='profile'?'active':''}`}
          onClick={()=>{setMenuOpen(false);setPage('profile');}}
        >
          <div className="option-icon-box profile">
            <User size={20}/>
          </div>
          <div className="option-text-box">
            <b>Mening profilim</b>
            <small>Shaxsiy ma’lumotlar, parol va xavfsizlik sozlamalari</small>
          </div>
          <ChevronRight size={18} className="chevron"/>
        </button>
      </div>
    </div>
  </Modal>
  <PendingDetail sale={pendingDetail} close={()=>setPendingDetail(null)} onEdit={startEditPendingSale} onDelete={setCancelConfirmSale} rate={rate}/>
  <Receipt receipt={receipt} close={()=>setReceipt(null)} rate={rate}/>
  <Modal open={Boolean(cancelConfirmSale)} onClose={()=>!canceling&&setCancelConfirmSale(null)} title="So‘rovni bekor qilish">
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <p style={{margin:0,fontSize:14,color:'var(--navy)'}}>Haqiqatan ham <b>#{cancelConfirmSale?.pending_no}</b> kassa so‘rovini bekor qilmoqchimisiz?</p>
      <div style={{padding:'10px 14px',background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:8,fontSize:13,color:'#166534'}}>
        Tovar(lar) zudlik bilan bandlikdan bo‘shatiladi va qaytadan erkin sotuvga chiqadi.
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:6}}>
        <button type="button" className="btn btn-outline" disabled={canceling} onClick={()=>setCancelConfirmSale(null)}>Bekor qilish</button>
        <button type="button" className="btn" style={{background:'#e11d48',borderColor:'#e11d48',color:'#fff',fontWeight:700}} disabled={canceling} onClick={()=>cancelPendingSale(cancelConfirmSale)}>{canceling?'Bekor qilinmoqda…':'Ha, so‘rovni bekor qilish'}</button>
      </div>
    </div>
  </Modal>
  <Modal open={Boolean(closingTab)} onClose={()=>setClosingTab(null)} title="Mijoz savatchasini yopish">
    <div style={{display:'flex',flexDirection:'column',gap:14}}>
      <p style={{margin:0,fontSize:14,color:'var(--navy)'}}>Haqiqatan ham <b>{closingTab?.customer?.full_name?.trim()||closingTab?.label}</b> tabini yopmoqchimisiz?</p>
      <div style={{padding:'10px 14px',background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:8,fontSize:13,color:'#c2410c'}}>
        Savatchada <b>{closingTab?.cart?.length||0} ta mahsulot</b> mavjud. Tab yopilsa, ushbu tovarlar savatdan o‘chiriladi.
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:6}}>
        <button type="button" className="btn btn-outline" onClick={()=>setClosingTab(null)}>Bekor qilish</button>
        <button type="button" className="btn" style={{background:'#e11d48',borderColor:'#e11d48',color:'#fff',fontWeight:700}} onClick={()=>handleDeleteTab(closingTab.id)}>Ha, tabni yopish</button>
      </div>
    </div>
  </Modal>
  </>;
}

function State({text,error,retry}){return <div className={'pos-real-state '+(error?'error':'')}>{error&&<AlertTriangle/>}<p>{text}</p>{retry&&<button type="button" className="btn" onClick={retry}>Qayta urinish</button>}</div>}
function HomePage({sales,pending,date,setDate,profile,openReceipt,openPending,go,rate}){
  const k=sales.today||{};
  const isToday=date===todayInput();
  return <section>
    <div className="pos-real-title">
      <div>
        <small>{isToday?'Bugungi natija':'Tanlangan kun natijasi'}</small>
        <h2>{profile?.full_name?.split(' ')[0]||'Sotuvchi'}</h2>
      </div>
      <Status type="green">Yangilangan</Status>
    </div>
    <DateFilter value={date} onChange={setDate}/>
    <KpiCards kpi={k} rate={rate} onOpenRating={()=>go('rating')}/>
    <h3>Kassadagi so‘rovlar</h3>
    {pending.items?.length?(
      <div className="pos-real-pending">
        {pending.items.map(x=>{
          const productNames = x.product_names || (x.lines?.length ? x.lines.map(l => l.product_name || l.name).filter(Boolean).join(', ') : '');
          return (
            <button type="button" key={x.id} onClick={()=>openPending(x.id)} className="pos-pending-card">
              <div className="pos-pending-card-top">
                <div className="pos-pending-card-id">
                  <span className="pos-pending-num">{x.pending_no}</span>
                  {(x.is_edited || (x.updated_at && x.updated_at !== x.created_at)) && (
                    <span className="pos-pending-badge">✏️ Tahrirlangan</span>
                  )}
                </div>
                <Status type={colors[x.status]}>{labels[x.status]||x.status}</Status>
              </div>
              {productNames ? (
                <div className="pos-pending-card-products" title={productNames}>
                  <Package size={14} className="pos-pending-product-icon"/>
                  <span className="pos-pending-product-names">{productNames}</span>
                </div>
              ) : null}
              <div className="pos-pending-card-bottom">
                <small className="pos-pending-meta">{x.unit_count} dona · {when(x.created_at)}</small>
                <div className="pos-pending-price-wrap">
                  <strong className="pos-pending-price"><DualPrice value={Number(x.total||0)} rate={rate}/></strong>
                  <ChevronRight size={18} className="pos-pending-chevron"/>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    ):<Empty title="Kassa so‘rovlari yo‘q" text="Tanlangan kunda kassaga yuborilgan so‘rovlar mavjud emas."/>}
    <Sales title="Tanlangan kundagi savdolar" rows={sales.items} openReceipt={openReceipt} rate={rate}/>
  </section>;
}
function DateFilter({value,onChange}){return <label className="pos-real-date-filter"><span>Sana</span><input type="date" value={value} onChange={event=>onChange(event.target.value)}/></label>}
function KpiCards({kpi,rate,onOpenRating}){
  const rank=Number(kpi?.rank||0);
  return <div className="pos-real-kpis">
    <article>
      <small>Savdo</small>
      <b>{<DualPrice value={Number(kpi.total||0)} rate={rate}/>}</b>
    </article>
    <article>
      <small>Cheklar</small>
      <b>{Number(kpi.count||0)} ta</b>
    </article>
    <article
      className={onOpenRating?'pos-kpi-rank-card':''}
      onClick={onOpenRating}
      style={onOpenRating?{cursor:'pointer'}:undefined}
      title={onOpenRating?'Reyting musobaqasini ochish':undefined}
    >
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <small>Reytingdagi o‘rni</small>
        <Trophy size={14} style={{color:'#f59e0b'}}/>
      </div>
      <b style={{display:'flex',alignItems:'center',gap:4,color:rank===1?'#d97706':rank===2?'#475569':rank===3?'#b45309':'var(--navy)'}}>
        {rank===1?'🥇 1-o‘rin':rank===2?'🥈 2-o‘rin':rank===3?'🥉 3-o‘rin':rank>0?`${rank}-o‘rin`:'—'}
      </b>
      <span style={{display:'block',fontSize:'11px',color:'#f59e0b',fontWeight:600,marginTop:4}}>
        {rank===1?'Peshqadam 🔥':rank>0?'Musobaqani ko‘rish →':'Musobaqa jadvali'}
      </span>
    </article>
  </div>;
}

// --- Scanner: looks up a unit via get_pos_unit_context (full pricing + stock context),
// shows a detail card the seller can act on (open storefront page, add to sale cart, or
// add to the store<->warehouse relocation batch). Falls back to the simple add-to-cart
// flow for units already in the list below.
function Scanner({branchId,query,setQuery,units,add,addMultiple,cart,addToRelocate,relocateCount,goRelocate,toast,rate,tabs,activeTabId,onSelectTab,onAddTab,onCloseTab,activeTab}){
  const[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[context,setContext]=useState(null);
  const[quantity,setQuantity]=useState(1);
  const extractQr=value=>{const raw=String(value||'').trim();if(!raw)return'';try{const url=new URL(raw,STOREFRONT);const match=url.pathname.match(/^\/qr\/([^/]+)\/?$/i);return match?decodeURIComponent(match[1]).trim():raw}catch{return raw}};
  const applyResult=result=>{
    if(!result) return;
    const u = result.unit || {};
    const pr = result.product || {};
    const br = result.branch || {};
    const st = result.stock || {};
    const p = result.prices || {
      retail_price_uzs: pr.retail_price ?? result.retail_price ?? 0,
      retail_price_usd: pr.retail_price_usd ?? result.retail_price_usd,
      wholesale_price_uzs: pr.wholesale_price ?? result.wholesale_price,
      wholesale_price_usd: pr.wholesale_price_usd ?? result.wholesale_price_usd,
      minimum_sale_price_uzs: pr.minimum_sale_price ?? result.minimum_sale_price ?? 0,
      minimum_sale_price_usd: pr.minimum_sale_price_usd ?? result.minimum_sale_price_usd,
      unit_cost_uzs: u.unit_cost ?? result.unit_cost ?? 0,
      unit_cost_usd: u.unit_cost_usd ?? result.unit_cost_usd,
      tax_rate: pr.tax_rate ?? result.tax_rate ?? 0,
    };
    const bStock = result.branch_stock || {
      store: st.total_store_stock ?? 0,
      warehouse: st.total_warehouse_stock ?? 0,
      total: st.total_product_stock ?? ((st.total_store_stock || 0) + (st.total_warehouse_stock || 0)),
    };
    const normalized = {
      ...result,
      id: result.id || u.id,
      qr_code: result.qr_code || u.qr_code,
      serial_number: result.serial_number ?? u.serial_number,
      status: result.status || u.status || 'available',
      location_id: result.location_id || u.location_id,
      location_name: result.location_name || u.location_name,
      location_type: result.location_type || u.location_type || 'store',
      unit_branch_name: result.unit_branch_name || br.unit_branch_name,
      in_current_branch: result.in_current_branch ?? br.in_current_branch ?? true,
      is_sellable: result.is_sellable ?? br.is_sellable ?? true,
      product_id: result.product_id || pr.id,
      product_name: result.product_name || pr.name || 'Nomsiz tovar',
      product_status: result.product_status || pr.status || 'active',
      sku: result.sku || pr.sku || '',
      brand_name: result.brand_name || pr.brand_name || '',
      image: result.image || pr.image || '',
      storefront_url: result.storefront_url || (pr.slug ? `/product/${pr.slug}` : ''),
      prices: p,
      branch_stock: bStock,
      variants_stock: result.variants_stock || st.variants || [],
      variants_summary_text: result.variants_summary_text || st.summary_text || '',
      components: result.components || pr.components || [],
      sale: result.sale || null,
    };
    setContext(normalized);
  };
  const runLookup=async raw=>{const value=extractQr(raw);if(!value)return;setBusy(true);setError('');setContext(null);try{applyResult(await getPosUnitContext(branchId,value));setCode('')}catch(e){setError(msg(e))}finally{setBusy(false)}};
  const lookup=e=>{e?.preventDefault?.();if(!code.trim())return;runLookup(code)};
  const addFromContext=async(selectedComps=[],isStandalone=false,standaloneComp=null)=>{
    if(!context)return;
    const total=Math.max(1,Math.min(50,Number(quantity)||1));
    const allReservedIds=(tabs||[]).flatMap(t=>t.cart.map(x=>x.id));
    const currentTabIds=(cart||[]).map(x=>x.id);

    // Check if another customer tab holds this physical unit
    const otherTabHolding=(tabs||[]).find(t=>t.id!==activeTabId&&t.cart.some(x=>x.id===context.id));
    if(otherTabHolding){
      const otherName=otherTabHolding.customer?.full_name?.trim()||otherTabHolding.label||'Boshqa mijoz';
      toast?.(`Bu tovar allaqachon "${otherName}" savatchasida band qilingan!`);
      return;
    }

    // Standalone tarkibiy qismni alohida sotish
    if(isStandalone&&standaloneComp){
      const compRetail=Number(standaloneComp.retail_price_uzs||0);
      const compCost=Number(standaloneComp.cost_price_uzs||0);
      const compRetailUsd=Number(standaloneComp.retail_price_usd||(rate?compRetail/rate:0));
      const compCostUsd=Number(standaloneComp.cost_price_usd||(rate?compCost/rate:0));
      const compLine={
        id:context.id,
        qr_code:context.qr_code,
        serial_number:context.serial_number,
        product_name:`${context.product_name} — ${standaloneComp.name}${standaloneComp.color?` (${standaloneComp.color})`:''}`,
        sku:context.sku,
        brand_name:context.brand_name,
        image:standaloneComp.image_url||context.image,
        location_type:context.location_type,
        retail_price:compRetail,
        retail_price_usd:compRetailUsd,
        minimum_sale_price:compRetail,
        minimum_sale_price_usd:compRetailUsd,
        unit_cost:compCost,
        unit_cost_usd:compCostUsd,
        tax_rate:context.prices?.tax_rate||0,
        available_branch_count:(context.branch_stock?.store||0)+(context.branch_stock?.warehouse||0),
        selected_components:[standaloneComp],
        is_standalone_component:true,
      };
      add(compLine);
      setContext(null);
      setQuantity(1);
      return;
    }

    // Asosiy tovar + tanlangan tarkibiy qismlar
    const compsRetail=(selectedComps||[]).reduce((s,c)=>s+(Number(c.retail_price_uzs)||0),0);
    const compsCost=(selectedComps||[]).reduce((s,c)=>s+(Number(c.cost_price_uzs)||0),0);
    const retailPrice=Number(context.prices?.retail_price_uzs||0)+compsRetail;
    const unitCost=Number(context.prices?.unit_cost_uzs||0)+compsCost;
    const minPrice=Number(context.prices?.minimum_sale_price_uzs||0)+compsRetail;

    const compsRetailUsd=(selectedComps||[]).reduce((s,c)=>s+(Number(c.retail_price_usd)||(rate?Number(c.retail_price_uzs||0)/rate:0)),0);
    const compsCostUsd=(selectedComps||[]).reduce((s,c)=>s+(Number(c.cost_price_usd)||(rate?Number(c.cost_price_uzs||0)/rate:0)),0);
    const retailPriceUsd=(context.prices?.retail_price_usd??context.retail_price_usd)!=null?Number(context.prices?.retail_price_usd??context.retail_price_usd)+compsRetailUsd:null;
    const unitCostUsd=(context.prices?.unit_cost_usd??context.unit_cost_usd??context.cost_price_usd)!=null?Number(context.prices?.unit_cost_usd??context.unit_cost_usd??context.cost_price_usd)+compsCostUsd:null;
    const minPriceUsd=(context.prices?.minimum_sale_price_usd??context.minimum_sale_price_usd)!=null?Number(context.prices?.minimum_sale_price_usd??context.minimum_sale_price_usd)+compsRetailUsd:null;

    const buildLine=unit=>({
      id:unit.id,
      qr_code:unit.qr_code||context.qr_code,
      serial_number:unit.serial_number,
      product_name:context.product_name,
      sku:context.sku,
      brand_name:context.brand_name,
      image:context.image,
      location_type:unit.location_type||context.location_type,
      retail_price:retailPrice,
      retail_price_usd:retailPriceUsd,
      minimum_sale_price:minPrice,
      minimum_sale_price_usd:minPriceUsd,
      unit_cost:unitCost,
      unit_cost_usd:unitCostUsd,
      tax_rate:context.prices?.tax_rate||0,
      available_branch_count:(context.branch_stock?.store||0)+(context.branch_stock?.warehouse||0),
      selected_components:selectedComps||[],
      is_standalone_component:false,
    });

    if(total===1&&!currentTabIds.includes(context.id)){
      add(buildLine(context));
      setContext(null);
      setQuantity(1);
      return;
    }

    setBusy(true);
    setError('');
    try{
      const batchUnits=await getPosBatchUnits(branchId,context.sku||context.qr_code,total,allReservedIds);
      if(!batchUnits||!batchUnits.length){
        toast?.('Bu mahsulotdan boshqa qoldiq qolmagan yoki barchasi savdoga qo‘shilgan');
        return;
      }
      const toAdd=batchUnits.map(unit=>buildLine(unit));
      addMultiple(toAdd);
      if(batchUnits.length<total){
        toast?.(`Faqat ${batchUnits.length} dona mavjud edi, barchasi savdoga qo‘shildi`);
      }
      setContext(null);
      setQuantity(1);
    }catch(err){
      if(total===1&&!currentTabIds.includes(context.id)){
        add(buildLine(context));
        setContext(null);
        setQuantity(1);
      }else{
        setError(msg(err));
      }
    }finally{
      setBusy(false);
    }
  };
  const relocateFromContext=()=>{if(!context)return;addToRelocate({id:context.id,qr_code:context.qr_code,serial_number:context.serial_number,product_name:context.product_name,sku:context.sku,image:context.image,location_type:context.location_type});setContext(null)};
  return <section>
    <div className="pos-real-title"><div><h2>Skaner va qidiruv</h2><small>Sotish yoki joyini o‘zgartirish uchun mahsulotni skanerlang</small></div>{relocateCount>0&&<button type="button" className="btn btn-outline" onClick={goRelocate}><ArrowLeftRight size={15}/> {relocateCount} ta ko‘chirishga tayyor</button>}</div>

    {tabs && tabs.length > 0 && (
      <div style={{ marginBottom: 12 }}>
        <CustomerTabsBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={onSelectTab}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
          compact
        />
        <div className="pos-active-customer-indicator">
          <span>Hozirgi savdo tabi:</span>
          <b>👤 {activeTab?.customer?.full_name?.trim() || activeTab?.label || 'Mijoz'}</b>
          <span className="count-pill">{activeTab?.cart?.length || 0} ta tovar</span>
        </div>
      </div>
    )}

    <form className="pos-real-code" onSubmit={lookup}><QrCode/><input autoFocus value={code} onChange={e=>setCode(e.target.value)} placeholder="QR, seriya, shtrix-kod yoki SKU"/><QrScanButton onOpen={()=>{setCode('');setError('')}} onScan={value=>{const clean=extractQr(value);setCode(clean);runLookup(clean)}}/><button type="submit" disabled={busy}>{busy?'Izlanmoqda…':'Topish'}</button></form>
    {error&&<div className="pos-real-inline-error">{error}</div>}
    {context&&<UnitContextCard key={context.id||context.qr_code} branchId={branchId} context={context} quantity={quantity} setQuantity={setQuantity} onAddToSale={addFromContext} onAddToRelocate={relocateFromContext} onClose={()=>setContext(null)} rate={rate}/>}
    <label className="pos-real-search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Mahsulot nomi yoki kodi bo‘yicha"/></label>
    <div className="pos-real-unit-list">
      {!query.trim() ? (
        <Empty title="Qidirishni boshlang" text="Mahsulot nomi, SKU yoki kodni yozing. Bo‘sh qidiruvda katalog yuklanmaydi."/>
      ) : units.length ? (
        <>
          {units.length > 0 && units.every(u => u.is_fuzzy) && (
            <div style={{ padding: '8px 12px', marginBottom: 8, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>💡</span>
              <span>«{query}» bo‘yicha to‘liq mos tovar topilmadi. Balki buni izlayotgandirsiz:</span>
            </div>
          )}
          {units.map(unit=><Unit key={unit.id} unit={unit} add={()=>add(unit)} rate={rate}/>)}
        </>
      ) : (
        <Empty title="Mahsulot topilmadi" text="Qidiruvni o‘zgartiring yoki QR kodni yuqoridagi aniq qidiruvga kiriting."/>
      )}
    </div>
  </section>;
}

// Full detail card shown after a successful scan: pricing in UZS+USD, per-branch
// store/warehouse stock, stock in other branches, and a link to the storefront page.
function UnitContextCard({branchId,context,quantity,setQuantity,onAddToSale,onAddToRelocate,onClose,rate}){
  if (!context) return null;
  const p = context.prices || {};
  const stock = context.branch_stock || { store: 0, warehouse: 0, total: 0 };
  const components=Array.isArray(context.components)?context.components:[];
  const[selectedCompIds,setSelectedCompIds]=useState(()=>{
    return components.filter(c=>c?.is_default||c?.is_required).map(c=>c?.id).filter(Boolean);
  });
  const selectedComponents=useMemo(()=>{
    return components.filter(c=>selectedCompIds.includes(c?.id));
  },[components,selectedCompIds]);
  const compsRetailTotal=useMemo(()=>{
    return selectedComponents.reduce((sum,c)=>sum+(Number(c?.retail_price_uzs)||0),0);
  },[selectedComponents]);
  const compsCostTotal=useMemo(()=>{
    return selectedComponents.reduce((sum,c)=>sum+(Number(c?.cost_price_uzs)||0),0);
  },[selectedComponents]);

  const compsCostUsdTotal=useMemo(()=>{
    return selectedComponents.reduce((sum,c)=>sum+(Number(c?.cost_price_usd)||(rate?Number(c?.cost_price_uzs||0)/rate:0)),0);
  },[selectedComponents,rate]);
  const compsRetailUsdTotal=useMemo(()=>{
    return selectedComponents.reduce((sum,c)=>sum+(Number(c?.retail_price_usd)||(rate?Number(c?.retail_price_uzs||0)/rate:0)),0);
  },[selectedComponents,rate]);

  const[showCost,setShowCost]=useState(false);
  const baseCost=p?.unit_cost_uzs??context.unit_cost??context.cost_price;
  const baseCostUsd=p?.unit_cost_usd??context.unit_cost_usd??context.cost_price_usd;
  const effectiveCostPrice=baseCost!=null?Number(baseCost)+compsCostTotal:null;
  const effectiveCostPriceUsd=baseCostUsd!=null?Number(baseCostUsd)+compsCostUsdTotal:(effectiveCostPrice!=null&&rate?effectiveCostPrice/rate:null);

  const baseRetailPrice=p?.retail_price_uzs||0;
  const baseRetailPriceUsd=p?.retail_price_usd??context.retail_price_usd;
  const effectiveRetailPrice=Number(baseRetailPrice)+compsRetailTotal;
  const effectiveRetailPriceUsd=baseRetailPriceUsd!=null?Number(baseRetailPriceUsd)+compsRetailUsdTotal:(rate?effectiveRetailPrice/rate:null);

  const baseMinPrice=p?.minimum_sale_price_uzs||0;
  const baseMinPriceUsd=p?.minimum_sale_price_usd??context.minimum_sale_price_usd;
  const effectiveMinPrice=Number(baseMinPrice)+compsRetailTotal;
  const effectiveMinPriceUsd=baseMinPriceUsd!=null?Number(baseMinPriceUsd)+compsRetailUsdTotal:(rate?effectiveMinPrice/rate:null);

  const productActive=context.product_status==='active';
  const inCurrentBranch=context.in_current_branch!==false;
  const free=context.is_sellable!==false&&context.status==='available';
  // Warehouse units of the seller's own branch are sellable too.
  const canSell=inCurrentBranch&&productActive&&free;
  const canRelocate=inCurrentBranch&&free;
  const saleLabel=!inCurrentBranch?'Boshqa filialda':context.status==='sold'?'Sotilgan':!free?(unitStates[context.status]||'Sotuvga tayyor emas'):!productActive?'Mahsulot faol emas':'Savdoga qo‘shish';
  const sale=context.sale;
  const[availability,setAvailability]=useState(null),[availabilityBusy,setAvailabilityBusy]=useState(false),[availabilityError,setAvailabilityError]=useState('');
  const loadAvailability=async()=>{
    if(availability){setAvailability(null);return}
    setAvailabilityBusy(true);setAvailabilityError('');
    try{setAvailability(await getPosProductAvailability(branchId,context.product_id))}
    catch(error){setAvailabilityError(msg(error))}
    finally{setAvailabilityBusy(false)}
  };
  return <article className="pos-unit-context card">
    <button type="button" className="icon-btn pos-unit-context-close" onClick={onClose} aria-label="Yopish"><X size={16}/></button>
    <div className="pos-unit-context-head">
      {context.image?<img src={context.image} alt=""/>:<span className="pos-real-image"><Package/></span>}
      <div>
        <b>{context.product_name}</b>
        <small>{context.brand_name||'Brendsiz'} · {context.sku}</small>
        <small>
          QR: <code>{context.qr_code}</code>
          {context.scanned_code && String(context.scanned_code).toUpperCase() !== String(context.qr_code || '').toUpperCase() ? (
            <span style={{ marginLeft: 6, color: '#16a34a', fontWeight: 600 }} title="Skanerlangan QR kod ushbu tovarning boshqa partiyasiga tegishli edi, lekin umumiy qoldiqdan avtomatik ulandi">
              (skanerlangan: {context.scanned_code})
            </span>
          ) : null}
          {context.serial_number ? ` · S/N: ${context.serial_number}` : ''}
        </small>
        <Status type={context.location_type==='store'?'green':'blue'}>{context.location_type==='store'?'Do‘konda':'Omborda'}</Status>
        {context.variant_color&&<Status type="blue"><i style={{width:8,height:8,borderRadius:'50%',background:context.variant_color_hex||'#ccc',display:'inline-block',marginRight:4}}/>{context.variant_color}</Status>}
        {context.unit_branch_name&&<Status type={inCurrentBranch?'green':'orange'}>{context.unit_branch_name}</Status>}
        {!free&&<Status type={context.status==='sold'?'blue':'orange'}>{unitStates[context.status]||context.status}</Status>}
        {!productActive&&<Status type="orange">{context.product_status==='draft'?'Qoralama':'Faol emas'}</Status>}
      </div>
      {context.storefront_url&&<a className="btn btn-outline btn-sm pos-unit-context-link" href={STOREFRONT+context.storefront_url} target="_blank" rel="noopener"><ExternalLink size={13}/> Saytda ko‘rish</a>}
    </div>
    <div className="pos-unit-context-prices">
      <span>
        <small>Sotish narxi{compsRetailTotal>0?' (qismlar bilan)':''}</small>
        <b><DualPrice value={Number(effectiveRetailPrice||0)} usdValue={effectiveRetailPriceUsd} rate={rate}/></b>
        {compsRetailTotal>0&&<small style={{color:'var(--muted)',fontSize:'10px'}}>Asosiy: {formatDualMoney(Number(p?.retail_price_uzs||0),rate,p?.retail_price_usd)}</small>}
      </span>
      <span>
        <small>Ulgurji narxi</small>
        <b>{p?.wholesale_price_uzs!=null?<DualPrice value={Number(p.wholesale_price_uzs||0)} usdValue={p?.wholesale_price_usd} rate={rate}/>:'—'}</b>
      </span>
      <span>
        <small>Minimal narx</small>
        <b><DualPrice value={Number(effectiveMinPrice)} usdValue={effectiveMinPriceUsd} rate={rate}/></b>
      </span>
      <span className="pos-unit-price-cost-cell" onClick={()=>setShowCost(v=>!v)} title={showCost?'Tannarxni yashirish':'Tannarxni ko‘rsatish'}>
        <small style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          Tannarx{compsCostTotal>0?' (qismlar bilan)':''}
          {showCost?<EyeOff size={12}/>:<Eye size={12}/>}
        </small>
        <button type="button" className="pos-masked-price" onClick={e=>{e.stopPropagation();setShowCost(v=>!v)}} title={showCost?'Tannarxni yashirish':'Tannarxni ko‘rsatish'}>
          {showCost?<b>{effectiveCostPrice!=null&&Number(effectiveCostPrice)>0?<DualPrice value={Number(effectiveCostPrice)} usdValue={effectiveCostPriceUsd} rate={rate}/>:'—'}</b>:<b style={{letterSpacing:'0.12em'}}>******</b>}
        </button>
      </span>
    </div>

    {components.length>0&&<div style={{margin:'10px 0',padding:'10px',background:'var(--surface-alt,#f8fafc)',borderRadius:'8px',border:'1px solid var(--line,#e2e8f0)'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
        <b style={{fontSize:'12px'}}>Tarkibiy / qo‘shimcha qismlar ({selectedComponents.length}/{components.length})</b>
        {compsRetailTotal>0&&<span style={{fontSize:'11px',fontWeight:700,color:'var(--primary,#2563eb)'}}>+{formatDualMoney(compsRetailTotal,rate)}</span>}
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:'6px'}}>
        {components.map(comp=>{
          const isChecked=selectedCompIds.includes(comp.id);
          const compRetail=Number(comp.retail_price_uzs)||0;
          return <div key={comp.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'8px',padding:'6px 8px',background:'#fff',borderRadius:'6px',border:'1px solid var(--line,#e2e8f0)'}}>
            <label style={{display:'flex',alignItems:'center',gap:'8px',cursor:'pointer',fontSize:'12px',flex:1,userSelect:'none',margin:0}}>
              <input
                type="checkbox"
                checked={isChecked}
                disabled={comp.is_required}
                onChange={e=>{
                  if(comp.is_required)return;
                  setSelectedCompIds(prev=>e.target.checked?[...prev,comp.id]:prev.filter(id=>id!==comp.id));
                }}
              />
              {comp.image_url&&<img src={comp.image_url} alt="" style={{width:'32px',height:'32px',borderRadius:'6px',objectFit:'cover',border:'1px solid var(--line,#cbd5e1)',flexShrink:0}}/>}
              {comp.color_hex&&<span style={{width:'12px',height:'12px',borderRadius:'50%',background:comp.color_hex,border:'1px solid #cbd5e1',display:'inline-block',flexShrink:0}}/>}
              <span><b>{comp.name}</b>{comp.quantity > 1 ? ` (${comp.quantity} dona)` : ''}{comp.color?` (${comp.color})`:''}{comp.is_required?<span style={{marginLeft:'4px',fontSize:'10px',color:'#d97706',fontWeight:700}}>(Majburiy)</span>:null}</span>
            </label>
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
              <span style={{fontSize:'11px',fontWeight:700}}>{compRetail>0?`+${formatDualMoney(compRetail,rate)}`:'0 so‘m'}</span>
              {comp.can_buy_standalone&&canSell&&<button type="button" className="btn btn-outline btn-xs" style={{padding:'2px 6px',fontSize:'10px'}} onClick={()=>onAddToSale(null,true,comp)} title="Faqat shu qismni alohida sotish">Faqat buni sotish</button>}
            </div>
          </div>;
        })}
      </div>
    </div>}

    <div className="pos-unit-context-stock">
      <span><Store size={15}/> Do‘konda: <b>{stock?.store ?? 0}</b> dona</span>
      <span><Warehouse size={15}/> Omborda: <b>{stock?.warehouse ?? 0}</b> dona</span>
      <span>Jami: <b>{stock?.total ?? ((stock?.store || 0) + (stock?.warehouse || 0))}</b> dona</span>
    </div>
    {context.variants_summary_text && (
      <div style={{margin:'6px 0 10px',padding:'6px 10px',borderRadius:6,background:'#fff7ed',border:'1px solid #fed7aa',fontSize:11,color:'#c2410c'}}>
        <b>Ranglar bo‘yicha filial qoldig‘i:</b> {context.variants_summary_text}
      </div>
    )}
    {context.variants_stock?.length > 1 && (
      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:10}}>
        {context.variants_stock.map((vs, idx) => (
          <span key={idx} style={{
            display:'inline-flex',alignItems:'center',gap:4,padding:'3px 8px',borderRadius:6,
            background: vs.is_current ? '#ea580c' : '#f1f5f9',
            color: vs.is_current ? '#ffffff' : '#334155',
            border: vs.is_current ? '1px solid #c2410c' : '1px solid #cbd5e1',
            fontSize: 11, fontWeight: vs.is_current ? 700 : 500
          }}>
            {vs.color_hex && <i style={{width:7,height:7,borderRadius:'50%',background:vs.color_hex,display:'inline-block',border:'1px solid rgba(0,0,0,0.2)'}}/>}
            <b>{vs.color_name}</b>: {vs.total_quantity} dona {vs.is_current ? '(ushbu tovar)' : ''}
          </span>
        ))}
      </div>
    )}
    {context.other_branches?.length>0&&<div className="pos-unit-context-branches">
      <small>Boshqa filiallarda mavjud:</small>
      <div>{context.other_branches.map(b=><span key={b.branch_id}><MapPin size={12}/>{b.branch_name}: <b>{b.quantity}</b></span>)}</div>
    </div>}
    {sale&&<div className="pos-sold-info">
      <h4><ReceiptText size={15}/> Bu mahsulot sotilgan</h4>
      <div className="pos-sold-grid">
        <span><small>Chek raqami</small><b>{sale.sale_no}</b></span>
        <span><small>Sotilgan sana</small><b>{when(sale.sold_at)}</b></span>
        <span><small>Filial</small><b>{sale.branch_name||'—'}</b></span>
        <span><small>Joylashuv</small><b>{context.location_name||'—'} ({context.location_type==='store'?'Do‘kon':'Ombor'})</b></span>
        {sale.details_visible?<>
          <span><small>Sotuvchi</small><b>{sale.seller_name||'—'}</b></span>
          <span><small>Tasdiqlagan menejer</small><b>{sale.manager_name||'—'}</b></span>
          <span><small>Sotuv narxi</small><b>{<DualPrice value={Number(sale.unit_price||0)} rate={rate}/>}</b></span>
          <span><small>Chegirma</small><b>{<DualPrice value={Number(sale.discount||0)} rate={rate}/>}</b></span>
          <span><small>Soliq</small><b>{<DualPrice value={Number(sale.tax||0)} rate={rate}/>}</b></span>
          <span><small>Yakuniy summa</small><b>{<DualPrice value={Number(sale.line_total||0)} rate={rate}/>}</b></span>
          <span><small>Mijoz</small><b>{sale.customer_name||'Kiritilmagan'}</b></span>
          <span><small>Mijoz telefoni</small><b>{sale.customer_phone||'—'}</b></span>
        </>:null}
      </div>
      {sale.details_visible&&sale.payments?.length>0&&<small className="pos-sold-payments">To‘lovlar: {sale.payments.map(payment=>`${payment.method_name} ${formatDualMoney(Number(payment.amount||0),rate)}`).join(' · ')}</small>}
      {!sale.details_visible&&<small className="pos-sold-payments">Bu savdo boshqa filialda amalga oshirilgan, batafsil summalar ko‘rsatilmaydi.</small>}
      <small className="pos-sold-payments">Tovar sotilgan: joyini o‘zgartirish mumkin emas. Mijoz qaytarib bergan bo‘lsa, menejer QR skaner orqali tovarni qaytaradi.</small>
      {context.storefront_url&&<a className="btn btn-outline btn-sm" href={STOREFRONT+context.storefront_url} target="_blank" rel="noopener"><ExternalLink size={13}/> Tovar turini saytda ko‘rish</a>}
    </div>}
    {!sale&&!free&&<div className="pos-real-warning"><AlertTriangle size={14}/> Bu birlik holati: {unitStates[context.status]||context.status}. Sotuvga qo‘shib bo‘lmaydi.</div>}
    {!inCurrentBranch&&<div className="pos-real-warning"><AlertTriangle size={14}/> Bu birlik {context.unit_branch_name||'boshqa filial'}ga tegishli. Faqat ma’lumot ko‘rish mumkin.</div>}
    <div className="pos-unit-context-availability">
      <button type="button" className="btn btn-outline btn-sm" onClick={loadAvailability} disabled={availabilityBusy}><MapPin size={14}/> {availabilityBusy?'Yuklanmoqda…':availability?'Qoldiqni yopish':'Filiallardagi qoldiq'}</button>
      {availabilityError&&<div className="pos-real-inline-error">{availabilityError}</div>}
      {availability&&<div className="pos-availability-list">
        <small>Jami mavjud: <b>{availability.total_available}</b> dona · Shu filialda: <b>{availability.current_branch_total}</b> dona</small>
        {availability.branches?.length?<table className="table"><thead><tr><th>Filial</th><th>Do‘kon</th><th>Ombor</th><th>Jami</th></tr></thead><tbody>{availability.branches.map(row=><tr key={row.branch_id}><td>{row.branch_name}{row.is_current_branch?' (siz)':''}</td><td>{row.store}</td><td>{row.warehouse}</td><td><b>{row.total}</b></td></tr>)}</tbody></table>:<small>Hech bir filialda mavjud emas.</small>}
        <small>Boshqa filial mahsulotini sotib bo‘lmaydi, faqat mijozga ma’lumot berish uchun.</small>
      </div>}
    </div>
    {canSell&&<label className="pos-unit-context-qty">Mahsulot soni<input type="text" inputMode="numeric" autoComplete="off" placeholder="1" value={quantity} onChange={event=>setQuantity(String(event.target.value).replace(/[^\d]/g,'').replace(/^0+(?=\d)/,'').slice(0,2))} onBlur={()=>setQuantity(String(Math.max(1,Math.min(((stock?.store||0)+(stock?.warehouse||0))||50,Number(quantity)||1))))}/><small>Filialda mavjud qoldiq: <b>{(stock?.store||0)+(stock?.warehouse||0)}</b> dona (Do‘konda: {stock?.store||0}, Omborda: {stock?.warehouse||0})</small></label>}
    <div className="pos-unit-context-actions">
      <button type="button" className="btn btn-primary" disabled={!canSell} onClick={()=>onAddToSale(selectedComponents,false,null)}><ShoppingCart size={15}/> {Number(quantity)>1?`${quantity} dona — Savdoga qo‘shish`:saleLabel}</button>
      <button type="button" className="btn btn-outline" disabled={!canRelocate} onClick={onAddToRelocate}><ArrowLeftRight size={15}/> {canRelocate?'Joyini o‘zgartirish':'Boshqa filialda'}</button>
    </div>
  </article>;
}

function Unit({unit,add,rate}){
  const[showCost,setShowCost]=useState(false);
  const costUsd = unit.unit_cost_usd ?? unit.cost_price_usd;
  return <article className="pos-real-unit">{unit.image?<img src={unit.image} alt=""/>:<span className="pos-real-image"><QrCode/></span>}<div><b>{unit.product_name}</b>{unit.is_fuzzy&&<span style={{marginLeft:6,fontSize:10,fontWeight:700,color:'#b45309',background:'#fef3c7',border:'1px solid #fde68a',padding:'1px 6px',borderRadius:4}}>✨ Yaqin moslik</span>}<small>{unit.brand_name||'Brendsiz'} · {unit.sku}</small><small>QR: {unit.qr_code}{unit.serial_number?` · S/N: ${unit.serial_number}`:''}</small>{unit.location_type&&<Status type={unit.location_type==='store'?'green':'blue'}>{unit.location_type==='store'?'Do‘konda':'Omborda'}</Status>}<strong>{<DualPrice value={Number(unit.retail_price||0)} usdValue={unit.retail_price_usd} rate={rate}/>}</strong><em>Minimum: {<DualPrice value={Number(unit.minimum_sale_price||0)} usdValue={unit.minimum_sale_price_usd} rate={rate}/>} · Tannarx: <button type="button" className="pos-masked-price-inline" onClick={e=>{e.stopPropagation();setShowCost(v=>!v)}} title={showCost?'Tannarxni yashirish':'Tannarxni ko‘rsatish'}>{showCost?<DualPrice value={Number(unit.unit_cost||0)} usdValue={costUsd} rate={rate}/>:<b>******</b>}</button></em>{unit.latest_batch_retail&&Number(unit.latest_batch_retail)!==Number(unit.retail_price)&&<em style={{color:'#059669'}}>Yangi partiya narxi: {<DualPrice value={Number(unit.latest_batch_retail||0)} rate={rate}/>}</em>}<em>Filialda: {unit.available_branch_count} dona</em></div><button type="button" onClick={add} aria-label="Savdoga qo'shish"><Plus/></button></article>;
}

// --- Sale flow: cart + optional customer info + minimum-price warning (soft, not blocking).
function Cart({
  branchId,
  tabs,
  activeTab,
  activeTabId,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onSaleSuccess,
  setCart,
  setCustomer,
  setNotes,
  setPaymentType,
  setShowCustomer,
  setEditingPendingSale,
  refs,
  created,
  setCreated,
  refresh,
  toast,
  rate
}){
  const cart = activeTab?.cart || [];
  const customer = activeTab?.customer || { full_name: '', phone: '', address: '' };
  const notes = activeTab?.notes || '';
  const paymentType = activeTab?.paymentType || 'cash'; // 'cash' | 'card' | 'nasiya'
  const showCustomer = Boolean(activeTab?.showCustomer);
  const editingPendingSale = activeTab?.editingPendingSale || null;

  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const total = useMemo(() => cart.reduce((sum, line) => sum + lineTotal(line), 0), [cart]);

  const editLine=(id,key,value)=>setCart(rows=>{
    return rows.map(row=>row.id===id?{...row,[key]:numericText(value)}:row);
  });
  // Limits are enforced when the field loses focus so typing is never blocked.
  const normalizeLine=(id,key)=>setCart(rows=>{
    return rows.map(row=>{
      if(row.id!==id)return row;
      const percent=Math.max(1, Number(refs?.discount_policy?.seller_max_line_discount_percent||100)/100);
      if(key==='unit_price'){
        const price=Math.min(Number(row.retail_price||0)*5,Math.max(0,Number(row.unit_price||0)));
        const maxDiscount=Math.max(0,Math.min(price*percent,price));
        return{...row,unit_price:numericText(price),discount:row.discount===''?'':numericText(Math.min(Number(row.discount||0),maxDiscount))};
      }
      if(row.discount==='')return row;
      const maxDiscount=Math.max(0,Math.min(Number(row.unit_price||0)*percent,Number(row.unit_price||0)));
      return{...row,discount:numericText(Math.min(maxDiscount,Math.max(0,Number(row.discount||0))))};
    });
  });

  const belowMinimumLines = cart.filter(line => !Number(line.discount || 0) && lineTotal(line) - lineTax(line) < Number(line.minimum_sale_price || 0));
  const hasMissingPrice = cart.some(line => !line.unit_price || Number(line.unit_price) <= 0);

  const toggleLocation = async (line) => {
    const targetLoc = line.location_type === 'store' ? 'warehouse' : 'store';
    try {
      const allReservedIds = (tabs || []).flatMap(t => t.cart.map(x => x.id)).filter(id => id !== line.id);
      const units = await getPosBatchUnits(branchId, line.sku || line.qr_code, 1, allReservedIds, targetLoc);
      if (!units || !units.length) {
        toast?.(targetLoc === 'warehouse' ? 'Omborda ushbu tovardan bo‘sh qoldiq yo‘q' : 'Do‘konda ushbu tovardan bo‘sh qoldiq yo‘q');
        return;
      }
      const newUnit = units[0];
      setCart(rows => rows.map(r => r.id === line.id ? {
        ...r,
        id: newUnit.id,
        qr_code: newUnit.qr_code,
        serial_number: newUnit.serial_number,
        location_type: newUnit.location_type
      } : r));
      toast?.(newUnit.location_type === 'warehouse' ? 'Tovar ombor qoldig‘iga o‘tkazildi' : 'Tovar do‘kon qoldig‘iga o‘tkazildi');
    } catch (e) {
      toast?.(msg(e));
    }
  };

  const submit=async e=>{
    e.preventDefault();if(!cart.length)return;
    if(hasMissingPrice)return setError('Barcha mahsulotlarning sotish narxini kiriting.');
    if(paymentType === 'nasiya'){
      if(!customer.full_name?.trim())return setError('Nasiya savdo uchun mijoz ismi (F.I.O) kiritilishi shart.');
      if(!customer.phone?.trim())return setError('Nasiya savdo uchun mijoz telefon raqami kiritilishi shart.');
      if(!notes?.trim())return setError('Nasiya savdo uchun izoh kiritilishi shart.');
    }
    setBusy(true);setError('');
    try{
      const customerPayload = customer.phone?.trim() ? {
        full_name: customer.full_name?.trim() || null,
        phone: customer.phone.trim(),
        address: customer.address?.trim() || null
      } : (customer.full_name?.trim() ? {
        full_name: customer.full_name.trim(),
        phone: null,
        address: customer.address?.trim() || null
      } : null);

      const paymentsPayload = [{ method_code: paymentType, amount: Number(total.toFixed(2)), external_reference: null }];
      let result;
      if(editingPendingSale){
        result=await updatePosPendingSale({
          pendingId:editingPendingSale.id,
          lines:cart.map(x=>({unit_id:x.id,unit_price:Number(x.unit_price),discount:Number(x.discount||0),selected_components:x.selected_components||[]})),
          payments:paymentsPayload,
          notes,
          customer:customerPayload
        });
        toast?.(`Kassa so‘rovi #${result.pending_no} muvaffaqiyatli tahrirlandi`);
      }else{
        result=await createPosPendingSale({
          branchId,
          lines:cart.map(x=>({unit_id:x.id,unit_price:Number(x.unit_price),discount:Number(x.discount||0),selected_components:x.selected_components||[]})),
          payments:paymentsPayload,
          notes,
          customer:customerPayload
        });
        const custName = customer.full_name?.trim() || activeTab?.label || 'Mijoz';
        toast?.(`${custName} savdosi kassaga yuborildi`);
      }
      setCreated(result);
      onSaleSuccess(activeTabId, result);
      await refresh();
    }catch(e){setError(msg(e))}finally{setBusy(false)}
  };

  if(created&&!cart.length){
    const nextTab = (tabs || []).find(t => t.id !== activeTabId && t.cart?.length > 0) || (tabs || []).find(t => t.id !== activeTabId);
    return <section>
      <div className="pos-real-success">
        <ReceiptText/>
        <h2>{editingPendingSale?'Muvaffaqiyatli tahrirlandi':'Kassaga yuborildi'}</h2>
        <b>{created.pending_no}</b>
        <Status type={colors[created.status]}>{labels[created.status]||created.status}</Status>
        <strong>{<DualPrice value={Number(created.total||0)} rate={rate}/>}</strong>
        <div style={{display:'flex',gap:10,justifyContent:'center',marginTop:16,flexWrap:'wrap'}}>
          {nextTab && nextTab.cart?.length > 0 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setCreated(null);
                onSelectTab(nextTab.id);
              }}
            >
              Keyingi mijozga o‘tish ({nextTab.customer?.full_name?.trim() || nextTab.label})
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={()=>setCreated(null)}>
              Yangi savdo
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => {
              setCreated(null);
              onAddTab();
            }}
          >
            + Yangi mijoz ochish
          </button>
        </div>
      </div>
    </section>;
  }

  return <section>
    {tabs && tabs.length > 0 && (
      <CustomerTabsBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={(id) => { onSelectTab(id); setCreated(null); }}
        onAddTab={onAddTab}
        onCloseTab={onCloseTab}
      />
    )}

    <div className="pos-cart-customer-quick-bar">
      <div className="pos-cart-cust-input-wrap">
        <User size={16} />
        <input
          type="text"
          placeholder="Mijoz ismi yoki tab nomi (masalan: Rustam aka)..."
          value={customer.full_name || ''}
          onChange={e => setCustomer(c => ({ ...c, full_name: e.target.value }))}
        />
      </div>
      {customer.full_name && (
        <button
          type="button"
          className="btn-clear-cust"
          onClick={() => setCustomer(c => ({ ...c, full_name: '' }))}
          title="Ismni tozalash"
        >
          <X size={14} />
        </button>
      )}
    </div>

    <div className="pos-real-title"><div><h2>{editingPendingSale?'So‘rovni tahrirlash':`${customer.full_name?.trim() || activeTab?.label || 'Joriy mijoz'} savdosi`}</h2><small>{cart.length} ta noyob mahsulot birligi</small></div></div>
    {editingPendingSale&&(
      <div className="pos-editing-banner">
        <div>
          <span className="badge">✏️ Tahrirlash rejimi</span>
          <b>So‘rov #{editingPendingSale.pending_no}</b>
          <small>Yaratilgan: {when(editingPendingSale.created_at)}{editingPendingSale.updated_at && editingPendingSale.updated_at !== editingPendingSale.created_at ? ` · Tahrirlangan: ${when(editingPendingSale.updated_at)}` : ''}</small>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={()=>{
            setEditingPendingSale(null);
            setCart([]);
            setPaymentType('cash');
            toast?.('Tahrirlash bekor qilindi');
          }}
        >
          Bekor qilish
        </button>
      </div>
    )}
    {!cart.length?<Empty title="Savdo bo‘sh" text="Skaner yoki qidiruvdan mahsulot birligini qo‘shing."/>:<form onSubmit={submit}>
      <div className="pos-real-cart">{cart.map(line=>{
        const hasDiscount = Number(line.discount || 0) > 0;
        const currentTotal = lineTotal(line) - lineTax(line);
        // Chegirma kiritilganda minimal sotish narxi cheklovi ishlamaydi
        const isBelowMinimum = !hasDiscount && (currentTotal < Number(line.minimum_sale_price || 0));
        const isPriceMissing = !line.unit_price || Number(line.unit_price) <= 0;
        return <article key={line.id}>
          <div className="pos-real-cart-head">
            <div>
              <b>{line.product_name}</b>
              <small>{line.qr_code}{line.serial_number?` · ${line.serial_number}`:''}</small>
              {line.location_type&&(
                <div style={{display:'inline-flex',alignItems:'center',gap:6,marginTop:3}}>
                  <Status type={line.location_type==='store'?'green':'blue'}>{line.location_type==='store'?'Do‘kondan':'Ombordan'}</Status>
                  <button
                    type="button"
                    onClick={()=>toggleLocation(line)}
                    className="btn btn-outline btn-xs"
                    style={{fontSize:10,padding:'1px 6px',borderRadius:4,display:'inline-flex',alignItems:'center',gap:3,lineHeight:1.3}}
                    title="Do‘kon yoki ombor qoldig‘iga o‘tkazish"
                  >
                    <ArrowLeftRight size={10}/>
                    {line.location_type==='store'?'Omborga o‘tkazish':'Do‘konga o‘tkazish'}
                  </button>
                </div>
              )}
              {line.selected_components?.length>0&&<div style={{display:'flex',flexWrap:'wrap',gap:'4px',marginTop:'4px'}}>
                {line.selected_components.map((c,i)=><span key={i} style={{display:'inline-flex',alignItems:'center',gap:'4px',fontSize:'11px',padding:'2px 6px',borderRadius:'4px',background:'var(--surface-alt,#f1f5f9)',color:'var(--text)',border:'1px solid var(--line,#e2e8f0)'}}>
                  {(c.image_url||c.imageUrl)&&<img src={c.image_url||c.imageUrl} alt="" style={{width:'16px',height:'16px',borderRadius:'3px',objectFit:'cover'}}/>}
                  {c.color_hex&&<span style={{width:'8px',height:'8px',borderRadius:'50%',background:c.color_hex}}/>}
                  + {c.quantity > 1 ? `${c.quantity}x ` : ''}{c.name}{c.color?` (${c.color})`:''}
                </span>)}
              </div>}
            </div>
            <button type="button" onClick={()=>setCart(x=>x.filter(y=>y.id!==line.id))} aria-label="Mahsulotni savatdan o‘chirish"><Trash2/></button>
          </div>
          <div className="pos-sale-price-field">
            <div className="pos-sale-price-head">
              <span>Sotish narxi (so‘m) *</span>
              {isPriceMissing&&<span className="pos-price-pulse-badge">Narx kiritilmagan!</span>}
            </div>
            <input
              className={`pos-sale-price-input ${isPriceMissing?'pulse-attention':''}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="Sotuv narxini kiriting…"
              value={line.unit_price}
              onChange={e=>editLine(line.id,'unit_price',e.target.value)}
              onBlur={()=>normalizeLine(line.id,'unit_price')}
            />
          </div>
          <div className="pos-real-line-grid" style={{marginTop:6}}>
            <label>Chegirma (Aksiya summasi)<input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={line.discount} onChange={e=>editLine(line.id,'discount',e.target.value)} onBlur={()=>normalizeLine(line.id,'discount')}/></label>
          </div>
          {hasDiscount ? (
            <div style={{
              margin: '6px 0',
              padding: '6px 10px',
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: 8,
              color: '#15803d',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}>
              <Check size={14} style={{ flexShrink: 0 }} />
              <span>
                <b>Aksiya / Chegirma:</b> -{formatDualMoney(Number(line.discount), rate)}. Kassaga to‘lanadigan: <b>{formatDualMoney(lineTotal(line), rate)}</b> (minimal narx tekshiruvi bekor qilindi).
              </span>
            </div>
          ) : isBelowMinimum ? (
            <div className="pos-real-warning"><AlertTriangle size={14}/> Narx minimal sotish summasidan past ({<DualPrice value={Number(line.minimum_sale_price||0)} rate={rate}/>}). Sotish mumkin, ammo menejer bunga e’tibor beradi.</div>
          ) : null}
          <div className="pos-real-prices"><span>Retail <b>{<DualPrice value={Number(line.retail_price||0)} usdValue={line.retail_price_usd} rate={rate}/>}</b></span><span>Minimum <b>{<DualPrice value={Number(line.minimum_sale_price||0)} usdValue={line.minimum_sale_price_usd} rate={rate}/>}</b></span><span>Tannarx <b>{<DualPrice value={Number(line.unit_cost||0)} usdValue={line.unit_cost_usd} rate={rate}/>}</b></span><span>Tax ({Number(line.tax_rate||0)}%) <b>{<DualPrice value={Number(lineTax(line)||0)} rate={rate}/>}</b></span><span>Taxminiy foyda <b>{<DualPrice value={Number(lineTotal(line)-lineTax(line)-Number(line.unit_cost)||0)} rate={rate}/>}</b></span><span>Filialda <b>{line.available_branch_count} dona</b></span></div>
        </article>;
      })}</div>
      <div className="pos-real-totals">
        <span>Asl tovar narxi<b>{<DualPrice value={Number(cart.reduce((s, x) => s + Number(x.unit_price || 0), 0) || 0)} rate={rate}/>}</b></span>
        {cart.some(x => Number(x.discount || 0) > 0) && (
          <span style={{ color: '#16a34a' }}>
            Chegirma (Aksiya)
            <b>-{<DualPrice value={Number(cart.reduce((s, x) => s + Number(x.discount || 0), 0) || 0)} rate={rate}/>}</b>
          </span>
        )}
        {cart.some(x => lineTax(x) > 0) && (
          <span>Soliq<b>{<DualPrice value={Number(cart.reduce((s, x) => s + lineTax(x), 0) || 0)} rate={rate}/>}</b></span>
        )}
        <strong>Kassaga to‘lanadigan jami<b>{<DualPrice value={Number(total || 0)} rate={rate}/>}</b></strong>
      </div>

      {/* Payment Method Selector */}
      <div style={{ margin: '12px 0', padding: '12px 14px', background: '#ffffff', border: '1px solid var(--line)', borderRadius: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--navy)' }}>To‘lov shakli:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[
            ['cash', '💵 Naqd pul'],
            ['card', '💳 Plastik / Click'],
            ['nasiya', '⏳ Nasiya (Qarz)']
          ].map(([code, title]) => (
            <button
              key={code}
              type="button"
              className={`btn btn-sm ${paymentType === code ? 'btn-primary' : 'btn-outline'}`}
              style={{
                fontSize: 12,
                fontWeight: 700,
                padding: '8px 4px',
                borderRadius: 8,
                borderColor: paymentType === code ? (code === 'nasiya' ? '#9333ea' : undefined) : (code === 'nasiya' ? '#d8b4fe' : undefined),
                background: paymentType === code ? (code === 'nasiya' ? '#9333ea' : undefined) : (code === 'nasiya' ? '#faf5ff' : undefined),
                color: paymentType === code ? '#fff' : (code === 'nasiya' ? '#7e22ce' : undefined),
                cursor: 'pointer'
              }}
              onClick={() => {
                setPaymentType(code);
                if (code === 'nasiya') setShowCustomer(true);
              }}
            >
              {title}
            </button>
          ))}
        </div>
        {paymentType === 'nasiya' && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: '#6b21a8', background: '#faf5ff', padding: '8px 10px', borderRadius: 8, border: '1px solid #e9d5ff', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={15} style={{ flexShrink: 0 }} />
            <span><b>Nasiya savdo:</b> Mijoz ismi, telefon raqami va izoh kiritilishi majburiy.</span>
          </div>
        )}
      </div>

      <div className="pos-real-customer">
        <button type="button" className="between pos-real-customer-toggle" onClick={()=>setShowCustomer(v=>!v)}>
          <span><User size={15}/> Mijoz ma’lumotlari {paymentType === 'nasiya' ? <b style={{color:'#9333ea'}}>(Nasiya uchun majburiy *)</b> : '(ixtiyoriy)'}</span>
          <ChevronRight style={{transform:showCustomer?'rotate(90deg)':'none'}}/>
        </button>
        {showCustomer&&<div className="pos-real-customer-fields">
          <label>Mijoz ismi {paymentType === 'nasiya' ? '*' : ''}<input className="input" value={customer.full_name} onChange={e=>setCustomer(c=>({...c,full_name:e.target.value}))} placeholder={paymentType === 'nasiya' ? "Mijoz F.I.O (majburiy)" : "Ixtiyoriy"}/></label>
          <label>Telefon raqami {paymentType === 'nasiya' ? '*' : ''}<input className="input" type="tel" value={customer.phone} onChange={e=>setCustomer(c=>({...c,phone:e.target.value}))} placeholder="+998 90 123 45 67"/></label>
          <label>Manzil<input className="input" value={customer.address} onChange={e=>setCustomer(c=>({...c,address:e.target.value}))} placeholder="Ixtiyoriy"/></label>
          {customer.address.trim()&&(
            <div style={{gridColumn:'1 / -1',fontSize:11.5,padding:'7px 10px',background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,color:'#1e40af',display:'flex',alignItems:'center',gap:6,marginTop:2}}>
              <Truck size={15} style={{flexShrink:0}}/>
              <span><b>Dostavka tizimi:</b> Tovarni do‘kondan yoki ombordan yetkazish mumkin. Savatdagi <b>"Omborga o‘tkazish"</b> / <b>"Do‘konga o‘tkazish"</b> orqali qayerdan chiqishini erkin tanlashingiz mumkin.</span>
            </div>
          )}
        </div>}
      </div>
      <label className="pos-real-notes">Izoh {paymentType === 'nasiya' ? <b style={{color:'#9333ea'}}>*</b> : ''}<textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder={paymentType === 'nasiya' ? "Nasiya shartlari, qaytarish muddati va qarz sababi (majburiy)" : "Qo‘shimcha izoh..."} rows="2"/></label>
      {belowMinimumLines.length>0&&<div className="pos-real-warning"><AlertTriangle size={14}/> {belowMinimumLines.length} ta mahsulot minimal narxdan past sotilmoqda.</div>}
      {error&&<div className="pos-real-inline-error">{error}</div>}
      <button
        type="submit"
        className="btn btn-primary btn-block pos-real-submit"
        disabled={busy||!cart.length||hasMissingPrice}
      >
        <Send size={18}/>
        {busy ? 'Yuborilmoqda…' : editingPendingSale ? 'O‘zgarishlarni saqlash va kassaga yuborish' : `Kassaga yuborish (${formatDualMoney(total, rate)})`}
      </button>
    </form>}
  </section>;
}

// --- Relocation flow: move one or many scanned units between the branch's
// store and warehouse locations. Direction is chosen once for the whole batch.
function Relocate({branchId,batch,setBatch,toast,back}){
  const[direction,setDirection]=useState('to_store'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(null);
  const remove=id=>setBatch(rows=>rows.filter(x=>x.id!==id));
  const submit=async()=>{
    if(!batch.length)return;setBusy(true);setError('');
    try{
      const codes=batch.map(u=>u.qr_code);
      const result=await relocatePosUnits(branchId,codes,direction);
      setDone(result);setBatch([]);toast?.(`${result.relocated_count} ta mahsulot ${direction==='to_store'?'do‘konga':'omborga'} ko‘chirildi`);
    }catch(e){setError(msg(e))}finally{setBusy(false)}
  };
  if(done)return <section><div className="pos-real-success"><ArrowLeftRight/><h2>Ko‘chirish bajarildi</h2><strong>{done.relocated_count} ta mahsulot</strong><p>{done.direction==='to_store'?'Do‘konga o‘tkazildi':'Omborga o‘tkazildi'}</p><button type="button" className="btn btn-primary" onClick={()=>{setDone(null);back()}}>Skanerga qaytish</button></div></section>;
  return <section>
    <div className="pos-real-title"><div><h2>Tovar joyini o‘zgartirish</h2><small>{batch.length} ta mahsulot tanlangan</small></div><button type="button" className="btn btn-outline" onClick={back}><QrCode size={15}/> Yana skanerlash</button></div>
    <div className="pos-relocate-direction">
      <button type="button" className={direction==='to_store'?'active':''} onClick={()=>setDirection('to_store')}><Warehouse size={16}/><ArrowLeftRight size={14}/><Store size={16}/><span>Ombordan do‘konga</span></button>
      <button type="button" className={direction==='to_warehouse'?'active':''} onClick={()=>setDirection('to_warehouse')}><Store size={16}/><ArrowLeftRight size={14}/><Warehouse size={16}/><span>Do‘kondan omborga</span></button>
    </div>
    {!batch.length?<Empty title="Ro‘yxat bo‘sh" text="Skaner bo‘limida mahsulotlarni skanerlab, “Joyini o‘zgartirish” tugmasini bosing."/>:<>
      <div className="pos-relocate-list">{batch.map(unit=><article key={unit.id} className="pos-relocate-item">
        {unit.image?<img src={unit.image} alt=""/>:<span className="pos-real-image"><Boxes size={18}/></span>}
        <div><b>{unit.product_name}</b><small>{unit.sku} · {unit.qr_code}</small><Status type={unit.location_type==='store'?'green':'blue'}>{unit.location_type==='store'?'Hozir do‘konda':'Hozir omborda'}</Status></div>
        <button type="button" className="icon-btn" onClick={()=>remove(unit.id)} aria-label="O‘chirish"><Trash2 size={15}/></button>
      </article>)}</div>
      {error&&<div className="pos-real-inline-error">{error}</div>}
      <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={submit}><ArrowLeftRight/> {busy?'Ko‘chirilmoqda…':`${batch.length} ta mahsulotni ko‘chirish`}</button>
    </>}
  </section>;
}

function Kpi({branchId,openReceipt,rate,onOpenRating}){
  const[date,setDate]=useState(todayInput),[draft,setDraft]=useState(''),[query,setQuery]=useState(''),[sales,setSales]=useState(emptySales),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useEffect(()=>{if(!branchId)return;let active=true;setLoading(true);setError('');listMyPosSales({branchId,date,query,pageSize:100}).then(result=>active&&setSales(result||emptySales())).catch(currentError=>active&&setError(msg(currentError))).finally(()=>active&&setLoading(false));return()=>{active=false}},[branchId,date,query]);
  const apply=event=>{event.preventDefault();setQuery(draft.trim())};
  return <section><div className="pos-real-title"><div><h2>KPI</h2><small>Filial vaqt mintaqasi bo‘yicha tanlangan kun</small></div></div><form className="pos-real-kpi-filters" onSubmit={apply}><DateFilter value={date} onChange={setDate}/><label className="pos-real-search"><Search/><input value={draft} onChange={event=>setDraft(event.target.value)} placeholder="Chek, mahsulot, SKU, QR yoki seriya"/><button type="submit">Qidirish</button></label>{query&&<button type="button" className="btn btn-outline" onClick={()=>{setDraft('');setQuery('')}}>Filtrni tozalash</button>}</form>{error?<div className="pos-real-inline-error">{error}</div>:loading?<State text="KPI yuklanmoqda…"/>:<><KpiCards kpi={sales.today||{}} rate={rate} onOpenRating={onOpenRating}/><div className="pos-real-kpi-wide"><span>Berilgan chegirma<b><DualPrice value={Number(sales.today?.discount||0)} rate={rate}/></b></span></div><Sales title="Filtrlangan savdolar" rows={sales.items} openReceipt={openReceipt} rate={rate}/></>}</section>;
}
function Sales({title,rows=[],openReceipt,rate}){return <><h3>{title}</h3>{rows.length?<div className="pos-real-sales">{rows.map(sale=><button type="button" key={sale.id} onClick={()=>openReceipt(sale.id)}><ReceiptText/><span><b>{sale.sale_no}</b><small>{when(sale.sold_at)} · {sale.unit_count} dona</small></span><strong>{<DualPrice value={Number(sale.total||0)} rate={rate}/>}</strong><ChevronRight/></button>)}</div>:<Empty title="Savdolar yo‘q" text="Tasdiqlangan savdolar shu yerda ko‘rinadi."/>}</>}

function ProductDetailModal({product,onClose,rate}){
  const[copied,setCopied]=useState(false);
  const[extraInfo,setExtraInfo]=useState(null);

  useEffect(()=>{
    if(!product){setExtraInfo(null);return}
    let active=true;
    if(!product.image||!product.slug){
      const client=getBrowserClient();
      let query=client.from('products').select('id, name, sku, slug, seo_image_url');
      if(product.product_id){
        query=query.eq('id',product.product_id);
      }else if(product.sku){
        query=query.eq('sku',product.sku);
      }
      query.maybeSingle().then(async({data:prod})=>{
        if(!active||!prod)return;
        let imageUrl=prod.seo_image_url;
        if(!imageUrl){
          const{data:media}=await client
            .from('product_media')
            .select('public_url')
            .eq('product_id',prod.id)
            .order('is_primary',{ascending:false})
            .limit(1)
            .maybeSingle();
          imageUrl=media?.public_url;
        }
        setExtraInfo({
          image:imageUrl,
          slug:prod.slug,
          product_name:prod.name
        });
      }).catch(()=>{});
    }
    return()=>{active=false};
  },[product]);

  if(!product)return null;

  const displayImage=product.image||extraInfo?.image;
  const slug=product.slug||extraInfo?.slug;
  const storefrontUrl=product.storefront_url
    ?(product.storefront_url.startsWith('http')?product.storefront_url:`${STOREFRONT}${product.storefront_url.startsWith('/')?'':'/'}${product.storefront_url}`)
    :(slug?`${STOREFRONT}/product/${encodeURIComponent(slug)}`:`${STOREFRONT}/catalog?query=${encodeURIComponent(product.sku||product.product_name||'')}`);

  const handleCopy=()=>{
    try{
      navigator.clipboard.writeText(storefrontUrl);
      setCopied(true);
      setTimeout(()=>setCopied(false),2000);
    }catch{}
  };

  return (
    <Modal open={Boolean(product)} onClose={onClose} title="Tovar tafsilotlari">
      <div className="pos-sold-item-detail">
        <div className="pos-sold-item-media-box">
          {displayImage?(
            <img src={displayImage} alt={product.product_name||'Tovar'} className="pos-sold-item-img"/>
          ):(
            <div className="pos-sold-item-placeholder">
              <Package size={44}/>
              <small>Rasm yuklanmagan</small>
            </div>
          )}
        </div>

        <div>
          <h3 className="pos-sold-item-title">{product.product_name||extraInfo?.product_name}</h3>

          <div className="pos-sold-item-meta-tags">
            {product.sku&&<span className="pos-meta-pill">SKU: <b>{product.sku}</b></span>}
            {product.qr_code&&<span className="pos-meta-pill">QR: <b>{product.qr_code}</b></span>}
            {product.serial_number&&<span className="pos-meta-pill">S/N: <b>{product.serial_number}</b></span>}
            {product.brand_name&&<span className="pos-meta-pill">Brend: <b>{product.brand_name}</b></span>}
          </div>

          <div className="pos-sold-item-prices-card">
            <div className="price-col">
              <small>Sotuv narxi</small>
              <b><DualPrice value={Number(product.unit_price||0)} rate={rate}/></b>
            </div>
            {Number(product.discount||0)>0&&(
              <div className="price-col discount">
                <small>Chegirma</small>
                <b>−<DualPrice value={Number(product.discount)} rate={rate}/></b>
              </div>
            )}
            <div className="price-col total">
              <small>Jami to‘lov</small>
              <strong><DualPrice value={Number(product.line_total||product.unit_price||0)} rate={rate}/></strong>
            </div>
          </div>

          {product.selected_components?.length>0&&(
            <div style={{margin:'10px 0 14px',padding:'10px 12px',background:'#f8fafc',borderRadius:8,border:'1px solid #e2e8f0'}}>
              <small style={{display:'block',fontSize:11,fontWeight:700,color:'var(--muted)',marginBottom:6}}>Tarkibiy qismlar:</small>
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {product.selected_components.map((c,i)=>(
                  <span key={i} style={{display:'inline-flex',alignItems:'center',gap:4,background:'#fff',border:'1px solid #cbd5e1',padding:'3px 7px',borderRadius:6,fontSize:11.5}}>
                    {(c.image_url||c.imageUrl)&&<img src={c.image_url||c.imageUrl} alt="" style={{width:14,height:14,borderRadius:2,objectFit:'cover'}}/>}
                    {c.quantity>1?`${c.quantity}x `:''}{c.name}{c.color?` (${c.color})`:''}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="pos-sold-storefront-section">
            <div className="storefront-header">
              <span className="storefront-label">🌐 Tovarning saytdagi manzili (URL)</span>
              <a
                href={storefrontUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary btn-sm pos-storefront-btn"
              >
                <ExternalLink size={14}/> Saytda ochish
              </a>
            </div>
            <div className="pos-storefront-url-box">
              <code className="pos-storefront-url-text">{storefrontUrl}</code>
              <button type="button" className="btn btn-outline btn-xs" onClick={handleCopy} style={{display:'inline-flex',alignItems:'center',gap:4}}>
                {copied?<><Check size={13} style={{color:'#16a34a'}}/> Nusxalandi</>:'Nusxalash'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PendingDetail({sale,close,onEdit,onDelete,rate}){
  const[selectedProduct,setSelectedProduct]=useState(null);

  return (
    <>
      <Modal open={Boolean(sale)} onClose={close} title={sale?.pending_no||'Kassa so‘rovi'}>
        {sale&&<div className="pos-real-pending-detail">
          <div className="between">
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <Status type={colors[sale.status]}>{labels[sale.status]||sale.status}</Status>
              {(sale.is_edited || (sale.updated_at && sale.updated_at !== sale.created_at)) && (
                <span style={{background:'#fef3c7',color:'#b45309',border:'1px solid #fde68a',fontSize:'11px',padding:'2px 7px',borderRadius:'4px',fontWeight:700}}>✏️ Tahrirlangan</span>
              )}
            </div>
            <div style={{textAlign:'right'}}>
              <small style={{display:'block',color:'var(--muted)'}}>Yaratildi: {when(sale.created_at)}</small>
              {(sale.is_edited || (sale.updated_at && sale.updated_at !== sale.created_at)) && (
                <small style={{display:'block',color:'#d97706',fontWeight:600}}>Tahrirlandi: {when(sale.updated_at)}</small>
              )}
            </div>
          </div>
          {sale.customer&&(sale.customer.full_name||sale.customer.phone)&&(
            <p style={{margin:'6px 0',fontSize:'12px',color:'var(--navy)'}}>Mijoz: <b>{sale.customer.full_name||'Ismsiz'}</b> {sale.customer.phone?`(${sale.customer.phone})`:''}</p>
          )}
          {sale.rejection_reason&&<div className="pos-real-inline-error">Sabab: {sale.rejection_reason}</div>}
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',margin:'12px 0 8px'}}>
            <h3 style={{margin:0}}>Mahsulotlar ({sale.lines?.length||0} ta)</h3>
            <small style={{color:'var(--muted)',fontSize:'11px'}}>Rasm va sayt havolasi uchun tovar ustiga bosing</small>
          </div>
          {sale.lines?.map(line=>(
            <article
              key={line.id}
              className="pos-clickable-product-row"
              onClick={()=>setSelectedProduct(line)}
              title="Tovar rasmi va saytdagi URL manzilini ko‘rish uchun bosing"
            >
              <div className="pos-product-row-thumb">
                {line.image?(
                  <img src={line.image} alt={line.product_name}/>
                ):(
                  <span className="pos-real-image"><Package size={20}/></span>
                )}
              </div>
              <div className="pos-product-row-details">
                <div className="pos-product-row-title-bar">
                  <b>{line.product_name}</b>
                  <span className="pos-product-row-hint">Batafsil →</span>
                </div>
                <small>{line.sku} · {line.qr_code}</small>
                {line.selected_components?.length>0&&(
                  <small style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:'4px',marginTop:'2px',color:'var(--muted)'}}>
                    Qismlar: {line.selected_components.map((c,i)=>(
                      <span key={i} style={{display:'inline-flex',alignItems:'center',gap:'3px'}}>
                        {(c.image_url||c.imageUrl)&&<img src={c.image_url||c.imageUrl} alt="" style={{width:'14px',height:'14px',borderRadius:'2px',objectFit:'cover'}}/>}
                        {c.quantity>1?`${c.quantity}x `:''}{c.name}{c.color?` (${c.color})`:''}{i<line.selected_components.length-1?', ':''}
                      </span>
                    ))}
                  </small>
                )}
              </div>
              <div className="pos-product-row-price-side">
                <strong>{<DualPrice value={Number(line.line_total||0)} rate={rate}/>}</strong>
                <a
                  href={getProductStorefrontUrl(line)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pos-inline-site-link"
                  onClick={e=>e.stopPropagation()}
                  title="Saytda ochish"
                >
                  <ExternalLink size={11}/> Saytda
                </a>
              </div>
            </article>
          ))}
          <div className="pos-real-totals"><span>Chegirma<b>{<DualPrice value={Number(sale.discount||0)} rate={rate}/>}</b></span><span>Soliq<b>{<DualPrice value={Number(sale.tax||0)} rate={rate}/>}</b></span><strong>Jami<b>{<DualPrice value={Number(sale.total||0)} rate={rate}/>}</b></strong></div>
          <h3>To‘lovlar</h3>
          {sale.payments?.map((payment,index)=><p key={index}>{payment.method_name}: <b>{<DualPrice value={Number(payment.amount||0)} rate={rate}/>}</b>{payment.external_reference?` · ${payment.external_reference}`:''}</p>)}
          {sale.status==='pending'&&(
            <div style={{display:'flex',gap:10,marginTop:16,paddingTop:14,borderTop:'1px solid var(--line)',flexWrap:'wrap'}}>
              <button
                type="button"
                className="btn btn-primary"
                style={{flex:'1 1 180px',display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'12px',fontSize:'13px',fontWeight:700}}
                onClick={()=>onEdit?.(sale)}
              >
                ✏️ So‘rovni tahrirlash
              </button>
              <button
                type="button"
                className="btn btn-outline"
                style={{flex:'1 1 120px',color:'#e11d48',borderColor:'#fecdd3',background:'#fff1f2',display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'12px',fontSize:'13px',fontWeight:600}}
                onClick={()=>onDelete?.(sale)}
              >
                <Trash2 size={15}/> Bekor qilish
              </button>
            </div>
          )}
        </div>}
      </Modal>
      <ProductDetailModal product={selectedProduct} onClose={()=>setSelectedProduct(null)} rate={rate}/>
    </>
  );
}

function Receipt({receipt,close,rate}){
  const[selectedProduct,setSelectedProduct]=useState(null);
  const[email,setEmail]=useState(''),[delivery,setDelivery]=useState(null),[busy,setBusy]=useState(false),[deliveryError,setDeliveryError]=useState(''),[idempotencyKey,setIdempotencyKey]=useState(()=>crypto.randomUUID());
  const[printMode,setPrintMode]=useState('per_item'),[previewIndex,setPreviewIndex]=useState(0);
  useEffect(()=>{let active=true;setEmail('');setDelivery(null);setDeliveryError('');setIdempotencyKey(crypto.randomUUID());if(receipt?.sale_id)getReceiptDeliveryStatus({saleId:receipt.sale_id}).then(value=>active&&setDelivery(value)).catch(error=>active&&setDeliveryError(msg(error)));return()=>{active=false}},[receipt?.sale_id]);
  useEffect(()=>{if(!delivery?.id||!['pending','processing'].includes(delivery.status))return;const timer=setInterval(()=>getReceiptDeliveryStatus({deliveryId:delivery.id}).then(setDelivery).catch(()=>{}),4000);return()=>clearInterval(timer)},[delivery?.id,delivery?.status]);
  const send=async()=>{if(!receipt?.sale_id||!email.trim())return;setBusy(true);setDeliveryError('');try{const key=delivery?.status==='dead'?crypto.randomUUID():idempotencyKey;if(key!==idempotencyKey)setIdempotencyKey(key);setDelivery(await queueSaleReceipt({saleId:receipt.sale_id,email:email.trim(),idempotencyKey:key}))}catch(error){setDeliveryError(msg(error))}finally{setBusy(false)}};
  const locked=['pending','processing','sent','ambiguous'].includes(delivery?.status);
  const lines=receipt?.lines||[];
  const multipleLines=lines.length>1;
  const handlePrint=()=>{printThermalReceipt(receipt,{mode:printMode})};

  return (
    <>
      <Modal open={Boolean(receipt)} onClose={close} title="Savdo cheki">
        {receipt&&<div style={{display:'flex',flexDirection:'column',gap:14}}>
          <div style={{background:'#f8fafc',border:'1px solid var(--line)',borderRadius:12,padding:14}}>
            <div className="between" style={{marginBottom:10,alignItems:'flex-start'}}>
              <div>
                <b style={{fontSize:13,display:'block',color:'var(--navy)'}}>Termoprinter cheki (40 × 30 mm)</b>
                <small style={{color:'var(--muted)',fontSize:11}}>40x30 mm o‘lchamdagi termoprinterlar uchun moslangan</small>
              </div>
              {multipleLines&&printMode==='per_item'&&(
                <div style={{display:'flex',alignItems:'center',gap:6,background:'#fff',border:'1px solid var(--line)',borderRadius:8,padding:'2px 6px'}}>
                  <button type="button" className="icon-btn" disabled={previewIndex<=0} onClick={()=>setPreviewIndex(i=>Math.max(0,i-1))} style={{width:22,height:22}}><ChevronLeft size={14}/></button>
                  <small style={{fontWeight:800,fontSize:11}}>{previewIndex+1} / {lines.length}</small>
                  <button type="button" className="icon-btn" disabled={previewIndex>=lines.length-1} onClick={()=>setPreviewIndex(i=>Math.min(lines.length-1,i+1))} style={{width:22,height:22}}><ChevronRight size={14}/></button>
                </div>
              )}
            </div>
            {multipleLines&&(
              <div className="pos-print-mode-btns" style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
                <button type="button" className={`btn btn-sm ${printMode==='per_item'?'btn-primary':'btn-outline'}`} onClick={()=>{setPrintMode('per_item');setPreviewIndex(0);}} style={{flex:'1 1 140px',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',gap:4}}>
                  <Layers size={13}/> Har bir tovar alohida ({lines.length} ta)
                </button>
                <button type="button" className={`btn btn-sm ${printMode==='summary'?'btn-primary':'btn-outline'}`} onClick={()=>setPrintMode('summary')} style={{flex:'1 1 140px',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',gap:4}}>
                  <FileText size={13}/> Jamlangan bitta chek
                </button>
              </div>
            )}
            <div style={{background:'#e2e8f0',padding:'16px',borderRadius:'10px',display:'flex',justifyContent:'center',alignItems:'center'}}>
              <ThermalReceiptPreview receipt={receipt} mode={printMode} activeIndex={previewIndex}/>
            </div>
            <button type="button" className="btn btn-primary btn-block pos-real-no-print" style={{marginTop:14,padding:'12px',fontSize:14,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:8}} onClick={handlePrint}>
              <Printer size={16}/> Termo chekni chop etish (40 × 30 mm)
            </button>
          </div>

          <details style={{border:'1px solid var(--line)',borderRadius:10,padding:'10px 14px'}}>
            <summary style={{cursor:'pointer',fontSize:12,fontWeight:700,color:'var(--muted)',userSelect:'none'}}>Savdo to‘liq tafsilotlari va elektron chek</summary>
            <div className="pos-real-receipt" style={{marginTop:10}}>
              <header><h2>{receipt.branch_name}</h2><p>{address(receipt.branch_address)}{receipt.branch_phone?` · ${receipt.branch_phone}`:''}</p><b>{receipt.sale_no}</b><small>{when(receipt.sold_at)}</small></header>
              <div><span>Sotuvchi <b>{receipt.seller_name}</b></span><span>Menejer <b>{receipt.manager_name||'—'}</b></span></div>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',margin:'12px 0 6px'}}>
                <h4 style={{margin:0,fontSize:'12px',color:'var(--navy)'}}>Sotilgan tovarlar (batafsil ko‘rish uchun bosing)</h4>
              </div>
              <section>{receipt.lines?.map((line,i)=>(
                <article
                  key={`${line.sku}-${line.serial_number||i}`}
                  className="pos-clickable-product-row"
                  onClick={()=>setSelectedProduct(line)}
                  title="Tovar rasmi va saytdagi URL manzilini ko‘rish uchun bosing"
                >
                  <div className="pos-product-row-thumb">
                    {line.image?(
                      <img src={line.image} alt={line.product_name}/>
                    ):(
                      <span className="pos-real-image"><Package size={20}/></span>
                    )}
                  </div>
                  <div className="pos-product-row-details">
                    <div className="pos-product-row-title-bar">
                      <b>{line.product_name}</b>
                      <span className="pos-product-row-hint">Batafsil →</span>
                    </div>
                    <small>{line.sku}{line.serial_number?` · S/N: ${line.serial_number}`:''}</small>
                    {line.selected_components?.length>0&&(
                      <small style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:'4px',marginTop:'2px',color:'var(--muted)'}}>
                        Qismlar: {line.selected_components.map((c,i)=>(
                          <span key={i} style={{display:'inline-flex',alignItems:'center',gap:'3px'}}>
                            {(c.image_url||c.imageUrl)&&<img src={c.image_url||c.imageUrl} alt="" style={{width:'14px',height:'14px',borderRadius:'2px',objectFit:'cover'}}/>}
                            {c.quantity>1?`${c.quantity}x `:''}{c.name}{c.color?` (${c.color})`:''}{i<line.selected_components.length-1?', ':''}
                          </span>
                        ))}
                      </small>
                    )}
                    <small style={{display:'block',marginTop:2,color:'var(--muted)'}}>
                      Narx {<DualPrice value={Number(line.unit_price||0)} rate={rate}/>} · Chegirma {<DualPrice value={Number(line.discount||0)} rate={rate}/>} · Soliq {<DualPrice value={Number(line.tax||0)} rate={rate}/>}
                    </small>
                  </div>
                  <div className="pos-product-row-price-side">
                    <strong>{<DualPrice value={Number(line.line_total||0)} rate={rate}/>}</strong>
                    <a
                      href={getProductStorefrontUrl(line)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pos-inline-site-link"
                      onClick={e=>e.stopPropagation()}
                      title="Saytda ochish"
                    >
                      <ExternalLink size={11}/> Saytda
                    </a>
                  </div>
                </article>
              ))}</section>
              <dl><div><dt>Subtotal</dt><dd>{<DualPrice value={Number(receipt.subtotal||0)} rate={rate}/>}</dd></div><div><dt>Chegirma</dt><dd>{<DualPrice value={Number(receipt.discount||0)} rate={rate}/>}</dd></div><div><dt>Soliq</dt><dd>{<DualPrice value={Number(receipt.tax||0)} rate={rate}/>}</dd></div><div><dt>Jami</dt><dd>{<DualPrice value={Number(receipt.total||0)} rate={rate}/>}</dd></div></dl>
              <h3>To‘lovlar</h3>{receipt.payments?.map((p,i)=><p key={i}>{p.method_name}: <b>{<DualPrice value={Number(p.amount||0)} rate={rate}/>}</b></p>)}
              <div className="receipt-delivery">
                <h3><Mail/> Elektron chek</h3>
                <label><input type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} disabled={locked} placeholder="mijoz@example.uz"/><button type="button" className="btn btn-primary" disabled={busy||locked||!email.trim()} onClick={send}><Send/>{busy?'Navbatga qo‘yilmoqda…':delivery?.status==='dead'?'Qayta urinish':'Emailga yuborish'}</button></label>
                {delivery&&<small className={`receipt-delivery-status ${delivery.status}`}>{delivery.message||delivery.status}{delivery.recipient_hint?` · ${delivery.recipient_hint}`:''}</small>}
                {deliveryError&&<div className="receipt-delivery-error">{deliveryError}</div>}
              </div>
            </div>
          </details>
        </div>}
      </Modal>
      <ProductDetailModal product={selectedProduct} onClose={()=>setSelectedProduct(null)} rate={rate}/>
    </>
  );
}
