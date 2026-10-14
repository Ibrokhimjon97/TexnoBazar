import React,{useCallback,useEffect,useRef,useState}from'react';
import{AlertTriangle,Archive,ArrowLeftRight,Bell,CalendarCheck,Sparkles,Boxes,ClipboardCheck,DollarSign,FileX2,Home,Landmark,Menu,PackagePlus,QrCode,RotateCcw,ShoppingBag,Truck,WalletCards,Warehouse,Wrench,X}from'lucide-react';
import{AccountMenu,AiChat,Status,ThemeToggle,Toast,formatMoney,useAuth}from'@texnobazar/ui';
import{formatUzDate,getManagementDashboard,listCourierPerformance,listNotifications,listPosPendingSales,markNotificationsRead,subscribeNotifications}from'@texnobazar/data';

// Qisqa signal: kassaga yangi so‘rov kelganda menejer eshitadi (fayl talab qilmaydi).
function playAlert(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx)return;
    const ctx=new Ctx();
    const gain=ctx.createGain();gain.gain.value=0.0001;gain.connect(ctx.destination);
    const beep=(startAt,frequency)=>{const osc=ctx.createOscillator();osc.type='sine';osc.frequency.value=frequency;osc.connect(gain);osc.start(startAt);osc.stop(startAt+0.16)};
    const now=ctx.currentTime;
    gain.gain.setValueAtTime(0.0001,now);
    gain.gain.exponentialRampToValueAtTime(0.22,now+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001,now+0.42);
    beep(now,880);beep(now+0.2,1180);
    setTimeout(()=>ctx.close().catch(()=>{}),900);
  }catch{/* audio bloklangan bo‘lsa jim qolamiz */}
}
import{InventoryBatches,InventoryScanner,InventoryStock,ReceiptModal}from'./InventoryWorkspace';
import TransferWorkspace from'./TransferWorkspace';
import DebtWorkspace from'./DebtWorkspace';
import CashWorkspace from'./CashWorkspace';
import InventoryCountWorkspace from'./InventoryCountWorkspace';
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

const nav=[
  ['Asosiy',Home,'home'],['Partiyalar',PackagePlus,'batches'],['Tovarlar',Warehouse,'stock'],
  ['Zahira / Tiklash',Archive,'backup'],
  ['Transfer',ArrowLeftRight,'transfer'],['Hisobdan chiqarish',FileX2,'writeoff'],
  ['Qaytarish',RotateCcw,'returns'],['Ta’mirlash',Wrench,'repairs'],['Kassa',WalletCards,'cash'],['Davomat',CalendarCheck,'attendance'],['Online / Kuryer',Truck,'orders'],['Sotuvlar tarixi',ClipboardCheck,'sales-history'],['AI yordamchi',Sparkles,'ai-chat'],
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
  const common={branchId:branch?.id,toast:setToast};
  // Kassadagi tasdiqlanmagan so‘rovlar soni: nav badge va signal uchun.
  const[pendingCount,setPendingCount]=useState(0);
  const pendingSeen=useRef(null);
  const loadPending=useCallback(async()=>{
    if(!branch?.id)return;
    try{
      const result=await listPosPendingSales({branchId:branch.id,status:'pending',pageSize:1});
      const count=Number(result?.summary?.pending_count??result?.total??0);
      setPendingCount(count);
      if(pendingSeen.current!==null&&count>pendingSeen.current){playAlert();setToast('Kassaga yangi savdo so‘rovi keldi');}
      pendingSeen.current=count;
    }catch{/* filial yoki ruxsat mavjud bo‘lmasa jim qolamiz */}
  },[branch?.id]);
  useEffect(()=>{pendingSeen.current=null;setPendingCount(0);loadPending();},[loadPending]);
  useEffect(()=>{if(!branch?.id)return;const timer=setInterval(loadPending,15000);return()=>clearInterval(timer)},[branch?.id,loadPending]);
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
  const[data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const load=async()=>{if(!branchId){setLoading(false);return;}setLoading(true);setError('');try{const now=new Date(),month=new Date(now.getFullYear(),now.getMonth(),1),day=dateKey(now),monthStart=dateKey(month);const[today,currentMonth,courier]=await Promise.all([getManagementDashboard({from:day,to:day,branchId}),getManagementDashboard({from:monthStart,to:day,branchId}),listCourierPerformance({from:monthStart,to:day,branchId})]);setData({today,currentMonth,courier});}catch(e){setError(String(e?.message||'Dashboard yuklanmadi.'));}finally{setLoading(false);}};
  useEffect(()=>{load();},[branchId]);
  if(!branchId)return <OverviewState error="Dashboard uchun filial tanlanmagan."/>;
  if(loading)return <OverviewState/>;
  if(error)return <OverviewState error={error} retry={load}/>;
  const day=data.today,month=data.currentMonth,courier=data.courier||{},couriers=courier.couriers||[];
  return <><div className="greeting"><span>{formatUzDate(new Date(), { weekday: 'long', day: true, month: 'long', year: true })}</span><h2>Xayrli kun, {name?.split(' ')[0]||'Menejer'}!</h2><p>Filialning serverdagi joriy ko‘rsatkichlari.</p></div><div className="m-stats"><div className="primary"><WalletCards/><span>Bugungi sof savdo<b>{formatMoney(Number(day.profit_loss?.net_sales||0))}</b><small>Refund: {formatMoney(Number(day.profit_loss?.refunds||0))}</small></span></div><div><Truck/><span>Oylik buyurtmalar<b>{Number(month.orders?.total||0)} ta</b><small>{Number(month.orders?.new||0)} ta yangi</small></span></div><div><Boxes/><span>Real qoldiq<b>{Number(month.inventory?.units||0)} dona</b><small>{Number(month.inventory?.reserved||0)} rezervda</small></span></div><div><AlertTriangle/><span>To‘lanadigan qarz<b>{formatMoney(Number(month.payables||0))}</b><small>Olinadigan: {formatMoney(Number(month.receivables||0))}</small></span></div></div><h3 className="block-title">Tezkor amallar</h3><div className="quick-actions"><button onClick={scan}><span><QrCode/></span><b>QR skanerlash</b><small>Birlik pasporti</small></button><button onClick={batch}><span><PackagePlus/></span><b>Partiya yaratish</b><small>Yangi real kirim</small></button><button onClick={()=>go('transfer')}><span><ArrowLeftRight/></span><b>Transfer</b><small>Filialga yuborish</small></button></div><div className="overview-real card"><h3>Joriy oy P&amp;L</h3><div><span><small>Sof savdo</small><b>{formatMoney(Number(month.profit_loss?.net_sales||0))}</b></span><span><small>Yalpi foyda</small><b>{formatMoney(Number(month.profit_loss?.gross_profit||0))}</b></span><span><small>Operatsion xarajat</small><b>{formatMoney(Number(month.profit_loss?.operating_expenses||0))}</b></span><span><small>Sof foyda</small><b>{formatMoney(Number(month.profit_loss?.net_profit||0))}</b></span></div></div><section className="overview-real card courier-performance"><div className="between"><div><h3>Kuryerlar — joriy oy</h3><small>Filial bo‘yicha serverda qabul qilingan sifatli GPS segmentlari</small></div><b>{formatDistance(courier.summary?.distance_m)} jami</b></div><div className="table-wrap"><table className="table"><thead><tr><th>Kuryer</th><th>Masofa</th><th>Yetkazildi</th><th>Faol</th><th>Natija</th></tr></thead><tbody>{couriers.map(row=><tr key={`${row.branch_id}-${row.courier_id}`}><td><b>{row.full_name}</b></td><td>{formatDistance(row.distance_m)}</td><td>{Number(row.delivered||0)} ta</td><td>{Number(row.active||0)} ta</td><td>{Number(row.delivery_rate||0).toLocaleString('uz-UZ')}%</td></tr>)}</tbody></table></div>{!couriers.length&&<p className="admin-inline-empty">Filialda faol kuryer topilmadi.</p>}</section></>;
}

function NotificationCenter({profileId,onAlert,onOpenItem}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const seen=useRef(null);
  const load=useCallback(async()=>{
    if(!profileId)return;
    setLoading(true);setError('');
    try{
      const result=await listNotifications({pageSize:30});
      const nextUnread=Number(result.unread_count||0);
      setItems(result.items||[]);setUnread(nextUnread);
      // Faqat yangi qo‘shilganda signal beriladi, birinchi yuklashda emas.
      if(seen.current!==null&&nextUnread>seen.current){playAlert();onAlert?.(result.items?.[0]);}
      seen.current=nextUnread;
    }catch(e){setError(String(e?.message||'Bildirishnomalar yuklanmadi.'));}
    finally{setLoading(false);}
  },[profileId,onAlert]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{if(!profileId)return;return subscribeNotifications(load,e=>setError(String(e?.message||e)),profileId);},[profileId,load]);
  useEffect(()=>{if(!profileId)return;const timer=setInterval(load,20000);return()=>clearInterval(timer)},[profileId,load]);
  const mark=async ids=>{try{await markNotificationsRead(ids);seen.current=null;await load();}catch(e){setError(String(e?.message||e));}};
  const openItem=item=>{
    if(!item.read_at)mark([item.id]);
    setOpen(false);
    const data=item?.data;
    if(data?.order_id||data?.transfer_id||data?.pending_sale_id)onOpenItem?.(item);
  };
  return <div className="notification-wrap"><button className="icon-btn notification-bell" onClick={()=>{setOpen(!open);if(!open)load();}} aria-label={`Bildirishnomalar${unread?`: ${unread} ta yangi`:''}`}><Bell/>{unread>0&&<em className="notification-count">{unread>99?'99+':unread}</em>}</button>{open&&<div className="notification-panel"><header><div><b>Bildirishnomalar</b><small>{unread} ta o‘qilmagan</small></div><button onClick={()=>mark(null)} disabled={!unread}>Barchasini o‘qish</button></header>{loading?<div className="notification-state">Yuklanmoqda…</div>:error?<div className="notification-state error">{error}<button onClick={load}>Qayta urinish</button></div>:items.length===0?<div className="notification-state">Bildirishnoma yo‘q</div>:<div className="notification-list">{items.map(item=><button key={item.id} className={item.read_at?'':'unread'} onClick={()=>openItem(item)}><span><b>{item.title}</b><small>{item.body}</small><time>{new Date(item.created_at).toLocaleString('uz-UZ')}</time></span>{!item.read_at&&<Status type="orange">Yangi</Status>}</button>)}</div>}</div>}</div>;
}

function OverviewState({error,retry}){return <div className={'ops-state '+(error?'ops-error':'')}>{error?<><AlertTriangle/><b>Dashboard yuklanmadi</b><p>{error}</p>{retry&&<button className="btn" onClick={retry}>Qayta urinish</button>}</>:<>Dashboard yuklanmoqda…</>}</div>;}
function BottomNav({page,go,scan}){const links=[['Asosiy',Home,'home'],['Qoldiq',Warehouse,'stock'],['Transfer',ArrowLeftRight,'transfer'],['Online',Truck,'orders']];return <nav className="bottom-nav">{links.slice(0,2).map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)}><Icon/><span>{title}</span></button>)}<button className="scan-main" onClick={scan}><QrCode/></button>{links.slice(2).map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)}><Icon/><span>{title}</span></button>)}</nav>;}
const formatDistance=value=>{const meters=Number(value||0);return meters>=1000?`${(meters/1000).toLocaleString('uz-UZ',{minimumFractionDigits:1,maximumFractionDigits:2})} km`:`${Math.round(meters).toLocaleString('uz-UZ')} m`};
const dateKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
