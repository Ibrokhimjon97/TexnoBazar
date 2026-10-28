import React,{useCallback,useEffect,useMemo,useRef,useState}from'react';
import{AlertTriangle,Archive,ArrowLeftRight,Bell,Calendar,CalendarCheck,Check,Sparkles,Boxes,ClipboardCheck,DollarSign,FileX2,Home,Landmark,Menu,PackagePlus,QrCode,RotateCcw,ShoppingBag,Truck,WalletCards,Warehouse,Wrench,X,Trophy,TrendingUp,ScanSearch}from'lucide-react';
import{AccountMenu,AiChat,Status,ThemeToggle,Toast,formatMoney,useAuth}from'@texnobazar/ui';
import{formatUzDate,getManagementDashboard,listCourierPerformance,listNotifications,listPosPendingSales,markNotificationsRead,subscribeNotifications,subscribePosPendingSales}from'@texnobazar/data';
import{LowStockModal,ProductSalesAnalyticsModal}from'./ManagerDashboardModals';
import{playCashierAlert,playNotificationAlert}from'./audioAlert.js';
import{InventoryBatches,InventoryScanner,InventoryStock,ReceiptModal}from'./InventoryWorkspace';
import TransferWorkspace from'./TransferWorkspace';
import DebtWorkspace from'./DebtWorkspace';
import CashWorkspace from'./CashWorkspace';
import InventoryCountWorkspace from'./InventoryCountWorkspace';
import StockReconciliationWorkspace from'./StockReconciliationWorkspace';
import InventoryRegisterModal from'./InventoryRegisterModal';
import WriteoffWorkspace from'./WriteoffWorkspace';
import ReturnsWorkspace from'./ReturnsWorkspace';
import RepairWorkspace from'./RepairWorkspace';
import OnlineOrderWorkspace from'./OnlineOrderWorkspace';
import FinanceWorkspace from'./FinanceWorkspace';
import ExchangeRateWorkspace from'./ExchangeRateWorkspace';
import SalesHistoryWorkspace from'./SalesHistoryWorkspace';
import ManagerBackupWorkspace from'./ManagerBackupWorkspace';
import AttendanceWorkspace from'./AttendanceWorkspace';
import DeliveryWorkspace from'./DeliveryWorkspace';
import RatingWorkspace from'./RatingWorkspace';

const nav=[
  ['Asosiy',Home,'home'],['Partiyalar',PackagePlus,'batches'],['Tovarlar',Warehouse,'stock'],
  ['Reviziya (Solishtirish)',ScanSearch,'audit'],
  ['Zahira / Tiklash',Archive,'backup'],
  ['Transfer',ArrowLeftRight,'transfer'],['Hisobdan chiqarish',FileX2,'writeoff'],
  ['Qaytarish',RotateCcw,'returns'],['Ta’mirlash',Wrench,'repairs'],['Kassa',WalletCards,'cash'],['Reyting',Trophy,'rating'],['Dostavka',Truck,'delivery'],['Davomat',CalendarCheck,'attendance'],['Online / Kuryer',Truck,'orders'],['Sotuvlar tarixi',ClipboardCheck,'sales-history'],['AI yordamchi',Sparkles,'ai-chat'],
  ['Moliya',Landmark,'finance'],['Valyuta',DollarSign,'exchange'],['Qarzdorlik',ShoppingBag,'debt'],
];
export default function App(){
  const{profile,branch}=useAuth();
  const[page,setPage]=useState(()=>window.location.hash.slice(1)||'home'),[scan,setScan]=useState(false),[batch,setBatch]=useState(false),[register,setRegister]=useState(false),[toast,setToast]=useState(''),[menu,setMenu]=useState(false);
  const[focusOrderId,setFocusOrderId]=useState(null);
  const[focusTransferId,setFocusTransferId]=useState(null);
  const[focusPendingSaleId,setFocusPendingSaleId]=useState(null);
  const go=value=>{setPage(value);setMenu(false);window.location.hash=value};
  useEffect(()=>{
    const onHashChange=()=>{const p=window.location.hash.slice(1)||'home';setPage(p);};
    window.addEventListener('hashchange',onHashChange);
    return()=>window.removeEventListener('hashchange',onHashChange);
  },[]);
  const onNotificationNavigate=item=>{
    const data=item?.data||{};
    if(data.type==='pos_pending_sale'&&data.pending_sale_id){setFocusPendingSaleId(data.pending_sale_id);go('cash');return}
    if(data.type&&String(data.type).startsWith('transfer_')&&data.transfer_id){setFocusTransferId(data.transfer_id);go('transfer');return}
    if(data.type&&String(data.type).startsWith('attendance')){go('attendance');return}
    if(data.order_id){setFocusOrderId(data.order_id);go('orders')}
  };
  const common={branchId:branch?.id,branchName:branch?.name||'TEXNOBAZAR',toast:setToast};
  // Kassadagi tasdiqlanmagan so‘rovlar soni: nav badge va signal uchun.
  const[pendingCount,setPendingCount]=useState(0);
  const pendingSeen=useRef(null);
  const loadPending=useCallback(async()=>{
    if(!branch?.id)return;
    try{
      const result=await listPosPendingSales({branchId:branch.id,status:'pending',pageSize:1});
      const count=Number(result?.summary?.pending_count??result?.total??0);
      setPendingCount(count);
      if(pendingSeen.current!==null&&count>pendingSeen.current){playCashierAlert();setToast('Kassaga yangi savdo so‘rovi keldi');}
      pendingSeen.current=count;
    }catch{/* filial yoki ruxsat mavjud bo‘lmasa jim qolamiz */}
  },[branch?.id]);
  useEffect(()=>{
    if(!branch?.id)return;
    const tick = () => {
      if(typeof document === 'undefined' || document.visibilityState === 'visible'){
        loadPending();
      }
    };
    const timer = setInterval(tick, 20000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  },[branch?.id,loadPending]);
  useEffect(()=>{
    if(!branch?.id)return;
    const unsub=subscribePosPendingSales(()=>{loadPending();},null,branch.id);
    return()=>unsub?.();
  },[branch?.id,loadPending]);
  const[batchMode,setBatchMode]=useState('batch');
  const[autoOpenReceiptId,setAutoOpenReceiptId]=useState(null);
  const[refreshBatchesTrigger,setRefreshBatchesTrigger]=useState(0);
  return (
    <div className="manager">
      <aside className={'m-side '+(menu?'open':'')}>
        <div className="m-logo"><i>T</i><span><b>texnobazar</b><small>Menejer paneli</small></span><button onClick={()=>setMenu(false)}><X/></button></div>
        <div className="branch-select"><Landmark/><span><small>Joriy filial</small><b>{branch?.name||'Filial tanlanmagan'}</b></span></div>
        <nav>{nav.map(([title,Icon,key])=><button className={page===key?'active':''} onClick={()=>go(key)} key={key}><Icon/><span>{title}</span>{key==='cash'&&pendingCount>0&&<em className="nav-badge">{pendingCount>99?'99+':pendingCount}</em>}</button>)}</nav>
        <div className="m-user"><AccountMenu/></div>
      </aside>
      <main>
        <header className="m-top">
          <button className="icon-btn m-menu" onClick={()=>setMenu(true)}><Menu/></button>
          <div><h1>{nav.find(x=>x[2]===page)?.[0]||'Menejer'}</h1><span>{branch?.name||'Filial tanlanmagan'}</span></div>
          <div className="m-top-spacer"/>
          <ThemeToggle/>
          <NotificationCenter profileId={profile?.id} onAlert={item=>{setToast(item?.title||'Yangi bildirishnoma');loadPending();}} onOpenItem={onNotificationNavigate}/>
          <AccountMenu compact/>
        </header>
        <div className="m-content">
          {page==='home'?(
            <Overview branchId={branch?.id} go={go} scan={()=>setScan(true)} batch={()=>{setBatchMode('batch');setBatch(true);}} name={profile?.full_name}/>
          ):page==='batches'?(
            <InventoryBatches
              branchId={branch?.id}
              toast={setToast}
              onCreateBatch={()=>{setBatchMode('batch');setBatch(true);}}
              onCreateInventory={()=>{setBatchMode('inventory');setBatch(true);}}
              autoOpenReceiptId={autoOpenReceiptId}
              onAutoOpenReceiptHandled={()=>setAutoOpenReceiptId(null)}
              refreshTrigger={refreshBatchesTrigger}
            />
          ):page==='stock'?(
            <InventoryStock branchId={branch?.id} onScan={()=>setScan(true)} onRegister={()=>setRegister(true)} toast={setToast}/>
          ):page==='audit'?(
            <StockReconciliationWorkspace {...common}/>
          ):page==='backup'?(
            <ManagerBackupWorkspace {...common}/>
          ):page==='transfer'?(
            <TransferWorkspace {...common} focusTransferId={focusTransferId} clearFocus={()=>setFocusTransferId(null)}/>
          ):page==='writeoff'?(
            <WriteoffWorkspace {...common}/>
          ):page==='returns'?(
            <ReturnsWorkspace {...common}/>
          ):page==='repairs'?(
            <RepairWorkspace {...common}/>
          ):page==='cash'?(
            <CashWorkspace {...common} focusPendingSaleId={focusPendingSaleId} clearFocus={()=>setFocusPendingSaleId(null)}/>
          ):page==='rating'?(
            <RatingWorkspace {...common}/>
          ):page==='delivery'?(
            <DeliveryWorkspace {...common}/>
          ):page==='attendance'?(
            <AttendanceWorkspace {...common}/>
          ):page==='orders'?(
            <OnlineOrderWorkspace {...common} focusOrderId={focusOrderId} clearFocus={()=>setFocusOrderId(null)}/>
          ):page==='finance'?(
            <FinanceWorkspace {...common}/>
          ):page==='ai-chat'?(
            <AiChat/>
          ):page==='sales-history'?(
            <SalesHistoryWorkspace branchId={branch?.id} toast={setToast}/>
          ):page==='exchange'?(
            <ExchangeRateWorkspace {...common}/>
          ):(
            <DebtWorkspace {...common}/>
          )}
        </div>
        <BottomNav page={page} go={go} scan={()=>setScan(true)}/>
      </main>
      <InventoryScanner open={scan} close={()=>setScan(false)} branchId={branch?.id} toast={setToast}/>
      <ReceiptModal
        open={batch}
        close={()=>setBatch(false)}
        branchId={branch?.id}
        mode={batchMode}
        toast={setToast}
        created={async(createdRes)=>{
          setBatch(false);
          setToast(batchMode==='inventory'?'Inventarizatsiya muvaffaqiyatli saqlandi':'Partiya va QR kodlar yaratildi');
          const newReceiptId = createdRes?.receipt_id || createdRes?.id;
          if(page!=='batches'){
            go('batches');
          }
          if(newReceiptId){
            setAutoOpenReceiptId(newReceiptId);
          }
          setRefreshBatchesTrigger(prev=>prev+1);
        }}
      />
      <InventoryRegisterModal open={register} close={()=>setRegister(false)} branchId={branch?.id} created={async()=>{setRegister(false);setToast('Tovar katalogga qo‘shildi');}}/>
      <Toast message={toast} onClose={()=>setToast('')}/>
    </div>
  );
}

function Overview({branchId,go,scan,batch,name}){
  const[data,setData]=useState(null);
  const[loading,setLoading]=useState(true);
  const[refreshing,setRefreshing]=useState(false);
  const[error,setError]=useState('');
  const[period,setPeriod]=useState('today'); // Default: Bugun
  const[customFrom,setCustomFrom]=useState(()=>dateKey(new Date()));
  const[customTo,setCustomTo]=useState(()=>dateKey(new Date()));
  const[showCustom,setShowCustom]=useState(false);
  const[lowStockOpen,setLowStockOpen]=useState(false);
  const[topProductsOpen,setTopProductsOpen]=useState(false);

  const periodInfo=useMemo(()=>{
    const now=new Date();
    const todayStr=dateKey(now);
    if(period==='custom'){
      return{from:customFrom||todayStr,to:customTo||todayStr,label:'Maxsus',badge:`${customFrom} — ${customTo}`};
    }
    if(period==='week'){
      const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()-6);
      return{from:dateKey(d),to:todayStr,label:'1 hafta',badge:'1 haftalik'};
    }
    if(period==='month'){
      const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()-29);
      return{from:dateKey(d),to:todayStr,label:'1 oy',badge:'1 oylik'};
    }
    if(period==='6months'){
      const d=new Date(now.getFullYear(),now.getMonth()-6,now.getDate());
      return{from:dateKey(d),to:todayStr,label:'6 oy',badge:'6 oylik'};
    }
    if(period==='year'){
      const d=new Date(now.getFullYear()-1,now.getMonth(),now.getDate());
      return{from:dateKey(d),to:todayStr,label:'1 yil',badge:'1 yillik'};
    }
    if(period==='all'){
      return{from:'2024-01-01',to:todayStr,label:'Barchasi',badge:'Barcha davr'};
    }
    // Default: 'today'
    return{from:todayStr,to:todayStr,label:'Bugun',badge:'Bugungi'};
  },[period,customFrom,customTo]);

  const load=useCallback(async()=>{
    if(!branchId){setLoading(false);return;}
    if(!data)setLoading(true);
    else setRefreshing(true);
    setError('');
    try{
      const{from,to}=periodInfo;
      const[dashboard,courier]=await Promise.all([
        getManagementDashboard({from,to,branchId}),
        listCourierPerformance({from,to,branchId})
      ]);
      setData({dashboard,courier});
    }catch(e){
      setError(String(e?.message||'Dashboard yuklanmadi.'));
    }finally{
      setLoading(false);
      setRefreshing(false);
    }
  },[branchId,periodInfo]);

  useEffect(()=>{load();},[load]);

  if(!branchId)return <OverviewState error="Dashboard uchun filial tanlanmagan."/>;
  if(loading&&!data)return <OverviewState/>;
  if(error&&!data)return <OverviewState error={error} retry={load}/>;

  const dashboard=data?.dashboard||{};
  const pl=dashboard.profit_loss||{};
  const orders=dashboard.orders||{};
  const inventory=dashboard.inventory||{};
  const payables=Number(dashboard.payables||0);
  const receivables=Number(dashboard.receivables||0);
  const courier=data?.courier||{};
  const couriers=courier.couriers||[];
  const netProfit=Number(pl.net_profit||0);
  const netSales=Number(pl.net_sales||0);
  const grossProfit=Number(pl.gross_profit||0);
  const isProfitPositive=netProfit>=0;

  return (
    <>
      <div className="greeting">
        <span>{formatUzDate(new Date(), { weekday: 'long', day: true, month: 'long', year: true })}</span>
        <h2>Xayrli kun, {name?.split(' ')[0]||'Menejer'}!</h2>
        <p>Filialning serverdagi joriy ko‘rsatkichlari va moliyaviy hisobotlari.</p>
      </div>

      {/* Davr filtri: Default Bugun, 1 hafta, 1 oy, 6 oy, 1 yil, Barchasi */}
      <div className="overview-filter-container" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div className="segmented" style={{ margin: 0, padding: 3, display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            <button
              type="button"
              className={period === 'today' ? 'active' : ''}
              onClick={() => { setPeriod('today'); setShowCustom(false); }}
            >
              Bugun
            </button>
            <button
              type="button"
              className={period === 'week' ? 'active' : ''}
              onClick={() => { setPeriod('week'); setShowCustom(false); }}
            >
              1 hafta
            </button>
            <button
              type="button"
              className={period === 'month' ? 'active' : ''}
              onClick={() => { setPeriod('month'); setShowCustom(false); }}
            >
              1 oy
            </button>
            <button
              type="button"
              className={period === '6months' ? 'active' : ''}
              onClick={() => { setPeriod('6months'); setShowCustom(false); }}
            >
              6 oy
            </button>
            <button
              type="button"
              className={period === 'year' ? 'active' : ''}
              onClick={() => { setPeriod('year'); setShowCustom(false); }}
            >
              1 yil
            </button>
            <button
              type="button"
              className={period === 'all' ? 'active' : ''}
              onClick={() => { setPeriod('all'); setShowCustom(false); }}
            >
              Barchasi
            </button>
            <button
              type="button"
              className={period === 'custom' || showCustom ? 'active' : ''}
              onClick={() => { setShowCustom(!showCustom); if (!showCustom) setPeriod('custom'); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <Calendar size={13} />
              <span>Sana tanlash</span>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {refreshing && (
              <span style={{ fontSize: 11, color: 'var(--orange)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span className="spinner-sm" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block' }} />
                Yangilanmoqda…
              </span>
            )}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text)',
              background: 'var(--surface)',
              padding: '6px 12px',
              borderRadius: 10,
              border: '1px solid var(--line)',
              fontWeight: 600
            }}>
              <Calendar size={14} style={{ color: 'var(--orange)' }} />
              <span>{periodInfo.from === periodInfo.to ? periodInfo.from : `${periodInfo.from} — ${periodInfo.to}`}</span>
            </div>
          </div>
        </div>

        {showCustom && (
          <div style={{
            marginTop: 10,
            padding: '10px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap'
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Oraliqni tanlang:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span>Dan:</span>
              <input
                type="date"
                value={customFrom}
                max={customTo || dateKey(new Date())}
                onChange={e => {
                  setCustomFrom(e.target.value);
                  setPeriod('custom');
                }}
                style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span>Gacha:</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={dateKey(new Date())}
                onChange={e => {
                  setCustomTo(e.target.value);
                  setPeriod('custom');
                }}
                style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </label>
          </div>
        )}
      </div>

      {/* Asosiy statistikalar: Boshida {periodInfo.badge} sof foyda va sof savdo */}
      <div className="m-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="primary">
          <TrendingUp size={24}/>
          <span>
            {periodInfo.badge} sof foyda
            <b style={{ fontSize: '1.25rem', letterSpacing: '-0.02em', color: '#fff' }}>
              {formatMoney(netProfit)}
            </b>
            <small style={{ color: 'rgba(255,255,255,0.85)' }}>
              Sof savdo: {formatMoney(netSales)}
            </small>
          </span>
        </div>
        <div>
          <WalletCards size={24} style={{ color: 'var(--orange, #f97316)' }}/>
          <span>
            {periodInfo.badge} sof savdo
            <b>{formatMoney(netSales)}</b>
            <small>Yalpi foyda: {formatMoney(grossProfit)}</small>
          </span>
        </div>
        <div>
          <Truck size={24} style={{ color: '#2563eb' }}/>
          <span>
            {periodInfo.badge} buyurtmalar
            <b>{Number(orders.total || 0)} ta</b>
            <small>{Number(orders.delivered || 0)} ta yetkazildi</small>
          </span>
        </div>
        <div>
          <Boxes size={24} style={{ color: '#16a34a' }}/>
          <span>
            Real tovar qoldig‘i
            <b>{Number(inventory.units || 0)} dona</b>
            <small>{Number(inventory.reserved || 0)} rezervda</small>
          </span>
        </div>
        <div>
          <AlertTriangle size={24} style={{ color: '#eab308' }}/>
          <span>
            Filial qarzdorligi
            <b>{formatMoney(payables)}</b>
            <small>Olinadigan: {formatMoney(receivables)}</small>
          </span>
        </div>
      </div>

      <h3 className="block-title">Tezkor amallar va Tahlil</h3>
      <div className="quick-actions" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <button type="button" onClick={scan}>
          <span><QrCode/></span>
          <b>QR skanerlash</b>
          <small>Birlik pasporti</small>
        </button>
        <button type="button" onClick={batch}>
          <span><PackagePlus/></span>
          <b>Partiya yaratish</b>
          <small>Yangi real kirim</small>
        </button>
        <button type="button" onClick={()=>go('transfer')}>
          <span><ArrowLeftRight/></span>
          <b>Transfer</b>
          <small>Filialga yuborish</small>
        </button>
        <button
          type="button"
          onClick={() => setLowStockOpen(true)}
          style={{ border: '1px solid #fed7aa', background: 'var(--surface, #fff)' }}
        >
          <span style={{ background: '#ffedd5', color: '#ea580c' }}><AlertTriangle size={20} /></span>
          <b style={{ color: '#c2410c' }}>Kam qolgan tovarlar</b>
          <small>Qoldiq ≤ 5 dona bo‘lganlar</small>
        </button>
        <button
          type="button"
          onClick={() => setTopProductsOpen(true)}
          style={{ border: '1px solid #bbf7d0', background: 'var(--surface, #fff)' }}
        >
          <span style={{ background: '#dcfce7', color: '#16a34a' }}><TrendingUp size={20} /></span>
          <b style={{ color: '#15803d' }}>Top 50 tovarlar tahlili</b>
          <small>Eng ko‘p va kam sotilganlar</small>
        </button>
      </div>

      {/* Tanlangan davr P&L va Sof Foyda Tahlili */}
      <div className="overview-real card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>
              {periodInfo.badge} P&amp;L va Sof foyda tahlili
            </h3>
            <small style={{ color: 'var(--muted)', fontSize: 11 }}>
              {periodInfo.from === periodInfo.to
                ? `${periodInfo.from} sanasidagi barcha operatsiyalar`
                : `${periodInfo.from} dan ${periodInfo.to} gacha bo‘lgan barcha operatsiyalar`}
            </small>
          </div>
          <span style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--surface-2, #f1f5f9)', padding: '5px 12px', borderRadius: 8, fontWeight: 600, border: '1px solid var(--line)' }}>
            Davr: {periodInfo.label} ({periodInfo.from === periodInfo.to ? periodInfo.from : `${periodInfo.from} — ${periodInfo.to}`})
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <span>
            <small>Sof savdo (Daromad)</small>
            <b>{formatMoney(netSales)}</b>
          </span>
          <span>
            <small>Tovar tannarxi (COGS)</small>
            <b>{formatMoney(Number(pl.cost_of_goods || 0))}</b>
          </span>
          <span>
            <small>Yalpi foyda</small>
            <b style={{ color: grossProfit >= 0 ? '#16a34a' : '#dc2626' }}>
              {formatMoney(grossProfit)}
            </b>
          </span>
          <span>
            <small>Operatsion xarajat</small>
            <b>{formatMoney(Number(pl.operating_expenses || 0))}</b>
          </span>
          <span>
            <small>Boshqa daromad</small>
            <b>{formatMoney(Number(pl.other_income || 0))}</b>
          </span>
          <span style={{
            background: isProfitPositive ? 'rgba(22, 163, 74, 0.1)' : 'rgba(220, 38, 38, 0.1)',
            border: `1.5px solid ${isProfitPositive ? 'rgba(22, 163, 74, 0.35)' : 'rgba(220, 38, 38, 0.35)'}`,
            padding: '12px 14px',
            borderRadius: 10
          }}>
            <small style={{ color: isProfitPositive ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
              ★ Sof foyda ({periodInfo.label})
            </small>
            <b style={{ color: isProfitPositive ? '#15803d' : '#b91c1c', fontSize: 18, marginTop: 4 }}>
              {formatMoney(netProfit)}
            </b>
          </span>
        </div>
      </div>

      <section className="overview-real card courier-performance">
        <div className="between">
          <div>
            <h3>Kuryerlar — {periodInfo.badge}</h3>
            <small>Filial bo‘yicha tanlangan davrdagi sifatli GPS segmentlari va yetkazishlar</small>
          </div>
          <b>{formatDistance(courier.summary?.distance_m)} jami masofa</b>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Kuryer</th>
                <th>Masofa</th>
                <th>Yetkazildi</th>
                <th>Faol</th>
                <th>Natija</th>
              </tr>
            </thead>
            <tbody>
              {couriers.map(row=>(
                <tr key={`${row.branch_id}-${row.courier_id}`}>
                  <td><b>{row.full_name}</b></td>
                  <td>{formatDistance(row.distance_m)}</td>
                  <td>{Number(row.delivered||0)} ta</td>
                  <td>{Number(row.active||0)} ta</td>
                  <td>{Number(row.delivery_rate||0).toLocaleString('uz-UZ')}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!couriers.length && <p className="admin-inline-empty">Tanlangan davrda filialda kuryer harakati qayd etilmadi.</p>}
      </section>

      <LowStockModal
        open={lowStockOpen}
        onClose={() => setLowStockOpen(false)}
        branchId={branchId}
        onGoTransfer={() => go('transfer')}
        onGoBatch={() => batch()}
      />
      <ProductSalesAnalyticsModal
        open={topProductsOpen}
        onClose={() => setTopProductsOpen(false)}
        branchId={branchId}
      />
    </>
  );
}

function NotificationCenter({profileId,onAlert,onOpenItem}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const[showAll,setShowAll]=useState(false);
  const seen=useRef(null);
  const wrapRef=useRef(null);

  const load=useCallback(async()=>{
    if(!profileId)return;
    setLoading(true);setError('');
    try{
      const result=await listNotifications({pageSize:30});
      const nextUnread=Number(result.unread_count||0);
      setItems(result.items||[]);setUnread(nextUnread);
      // Faqat yangi qo‘shilganda signal beriladi, birinchi yuklashda emas.
      if(seen.current!==null&&nextUnread>seen.current){
        const latest=result.items?.[0];
        if(latest?.data?.type==='pos_pending_sale'){
          playCashierAlert();
        }else{
          playNotificationAlert();
        }
        onAlert?.(latest);
      }
      seen.current=nextUnread;
    }catch(e){setError(String(e?.message||'Bildirishnomalar yuklanmadi.'));}
    finally{setLoading(false);}
  },[profileId,onAlert]);

  useEffect(()=>{load();},[load]);
  useEffect(()=>{
    if(!profileId)return;
    const tick=()=>{
      if(typeof document === 'undefined' || document.visibilityState === 'visible'){
        load();
      }
    };
    const timer=setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return()=>{
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  },[profileId,load]);

  // Tashqariga bosilganda bildirishnoma panelini yopish
  useEffect(()=>{
    if(!open)return;
    const handleOutside=(e)=>{
      if(wrapRef.current&&!wrapRef.current.contains(e.target)){
        setOpen(false);
      }
    };
    document.addEventListener('mousedown',handleOutside);
    document.addEventListener('touchstart',handleOutside);
    return()=>{
      document.removeEventListener('mousedown',handleOutside);
      document.removeEventListener('touchstart',handleOutside);
    };
  },[open]);

  const mark=async ids=>{
    try{
      await markNotificationsRead(ids);
      seen.current=null;
      await load();
      if(!ids){
        // Barchasini o'qish bosilganda bildirishnomalar yashiriladi va qisqa vaqtdan so'ng oyna yopiladi
        setTimeout(()=>setOpen(false),800);
      }
    }catch(e){setError(String(e?.message||e));}
  };

  const openItem=item=>{
    if(!item.read_at)mark([item.id]);
    setOpen(false);
    const data=item?.data;
    if(data?.order_id||data?.transfer_id||data?.pending_sale_id)onOpenItem?.(item);
  };

  const displayItems=showAll?items:items.filter(item=>!item.read_at);

  return (
    <div className="notification-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn notification-bell"
        onClick={()=>{setOpen(!open);if(!open)load();}}
        aria-label={`Bildirishnomalar${unread?`: ${unread} ta yangi`:''}`}
      >
        <Bell/>
        {unread>0&&<em className="notification-count">{unread>99?'99+':unread}</em>}
      </button>
      {open&&(
        <div className="notification-panel">
          <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 14px',borderBottom:'1px solid var(--line)'}}>
            <div>
              <b>Bildirishnomalar</b>
              <small>{unread} ta o‘qilmagan</small>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              {items.length>0&&(
                <button
                  type="button"
                  onClick={()=>setShowAll(v=>!v)}
                  style={{
                    border:'1px solid var(--line)',
                    background:showAll?'var(--surface-2, #f1f5f9)':'transparent',
                    borderRadius:6,
                    padding:'3px 8px',
                    fontSize:10,
                    cursor:'pointer',
                    color:'var(--text)',
                    fontWeight:600
                  }}
                >
                  {showAll?'Faqat yangilar':`Barchasi (${items.length})`}
                </button>
              )}
              <button
                type="button"
                onClick={()=>mark(null)}
                disabled={!unread}
                style={{
                  border:0,
                  background:'none',
                  color:unread?'var(--orange)':'var(--muted)',
                  fontSize:11,
                  fontWeight:700,
                  cursor:unread?'pointer':'default',
                  padding:'4px 6px'
                }}
              >
                Barchasini o‘qish
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={()=>setOpen(false)}
                aria-label="Yopish"
                style={{width:26,height:26,display:'grid',placeItems:'center',borderRadius:'50%',cursor:'pointer',border:0,padding:0,color:'var(--muted)'}}
              >
                <X size={15}/>
              </button>
            </div>
          </header>
          {loading?(
            <div className="notification-state">Yuklanmoqda…</div>
          ):error?(
            <div className="notification-state error">{error}<button onClick={load}>Qayta urinish</button></div>
          ):displayItems.length===0?(
            <div className="notification-state" style={{padding:'28px 16px'}}>
              <Check size={28} style={{color:'#16a34a',margin:'0 auto 6px',display:'block'}}/>
              <b style={{color:'var(--text)'}}>{showAll?'Bildirishnoma yo‘q':'O‘qilmagan bildirishnoma yo‘q'}</b>
              <p style={{margin:'4px 0 0',fontSize:11,color:'var(--muted)'}}>
                {showAll?'Hozircha hech qanday bildirishnoma mavjud emas.':'Barcha bildirishnomalar o‘qilgan.'}
              </p>
              {!showAll&&items.length>0&&(
                <button
                  type="button"
                  style={{
                    margin:'12px auto 0',
                    fontSize:11,
                    padding:'5px 12px',
                    border:'1px solid var(--line)',
                    borderRadius:8,
                    background:'var(--surface-2, #f8fafc)',
                    color:'var(--text)',
                    cursor:'pointer',
                    display:'block'
                  }}
                  onClick={()=>setShowAll(true)}
                >
                  O‘qilganlarni ko‘rish ({items.length})
                </button>
              )}
            </div>
          ):(
            <div className="notification-list">
              {displayItems.map(item=>(
                <button key={item.id} className={item.read_at?'':'unread'} onClick={()=>openItem(item)}>
                  <span>
                    <b>{item.title}</b>
                    <small>{item.body}</small>
                    <time>{new Date(item.created_at).toLocaleString('uz-UZ')}</time>
                  </span>
                  {!item.read_at&&<Status type="orange">Yangi</Status>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewState({error,retry}){return <div className={'ops-state '+(error?'ops-error':'')}>{error?<><AlertTriangle/><b>Dashboard yuklanmadi</b><p>{error}</p>{retry&&<button className="btn" onClick={retry}>Qayta urinish</button>}</>:<>Dashboard yuklanmoqda…</>}</div>;}
function BottomNav({page,go,scan}){const links=[['Asosiy',Home,'home'],['Qoldiq',Warehouse,'stock'],['Transfer',ArrowLeftRight,'transfer'],['Online',Truck,'orders']];return <nav className="bottom-nav">{links.slice(0,2).map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)}><Icon/><span>{title}</span></button>)}<button className="scan-main" onClick={scan}><QrCode/></button>{links.slice(2).map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)}><Icon/><span>{title}</span></button>)}</nav>;}
const formatDistance=value=>{const meters=Number(value||0);return meters>=1000?`${(meters/1000).toLocaleString('uz-UZ',{minimumFractionDigits:1,maximumFractionDigits:2})} km`:`${Math.round(meters).toLocaleString('uz-UZ')} m`};
const dateKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
