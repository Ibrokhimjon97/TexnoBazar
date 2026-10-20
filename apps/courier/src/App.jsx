import React,{useCallback,useEffect,useMemo,useRef,useState}from'react';
import{AlertCircle,ArrowLeft,BarChart3,Bell,Check,CheckCircle2,ChevronRight,Clock3,ExternalLink,Home,MapPin,Navigation,Package,Phone,RefreshCw,Route,Truck,User,WalletCards,X,XCircle}from'lucide-react';
import{AccountMenu,Status,ThemeToggle,Toast,formatMoney,useAuth}from'@texnobazar/ui';
import{formatUzDate,getUzMonthName,courierVerifyOrderUnit,deleteDeliveryProof,getCourierOrderVerification,getCourierStats,listCourierDeliveries,listCourierPendingCash,listNotifications,markNotificationsRead,setCourierDeliveryStatus,subscribeDeliveries,subscribeNotifications,uploadDeliveryProof,watchCourierPosition}from'@texnobazar/data';

const labels={assigned:'Biriktirildi',picked_up:'Olib ketildi',in_transit:'Yo‘lda',delivered:'Yetkazildi',failed:'Yetkazilmadi',cancelled:'Bekor qilindi',pending:'Kutilmoqda'};
const activeStatuses=new Set(['assigned','picked_up','in_transit']);
const tashkentDateKey=(date=new Date())=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date),get=type=>parts.find(part=>part.type===type)?.value;return`${get('year')}-${get('month')}-${get('day')}`};
const errorText=(error,fallback)=>String(error?.message||fallback);

export default function App(){
  const{profile}=useAuth();
  const[page,setPage]=useState('home'),[selectedId,setSelectedId]=useState(null),[deliveries,setDeliveries]=useState([]),[stats,setStats]=useState(null);
  const[loading,setLoading]=useState(true),[error,setError]=useState(''),[toast,setToast]=useState(''),[busyId,setBusyId]=useState(null);
  const[trackingId,setTrackingId]=useState(null),[tracking,setTracking]=useState({state:'idle',message:'GPS kuzatuv o‘chiq'});
  const load=useCallback(async(silent=false)=>{if(!silent)setLoading(true);setError('');try{const today=tashkentDateKey(),monthStart=`${today.slice(0,7)}-01`,[list,summary]=await Promise.all([listCourierDeliveries({pageSize:100}),getCourierStats(monthStart,today)]);setDeliveries(list?.items||[]);setStats(summary||null);}catch(e){setError(errorText(e,'Yetkazishlar yuklanmadi.'));}finally{if(!silent)setLoading(false);}},[]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{if(!profile?.id)return;let timer;const refresh=()=>{clearTimeout(timer);timer=setTimeout(()=>load(true),250);};const clean=subscribeDeliveries(refresh,e=>setError(errorText(e,'Realtime ulanmadi.')),profile.id);return()=>{clearTimeout(timer);clean();};},[profile?.id,load]);
  const trackedDelivery=deliveries.find(item=>item.id===trackingId&&item.status==='in_transit');
  useEffect(()=>{if(!trackedDelivery){if(trackingId)setTrackingId(null);return;}setTracking({state:'active',message:'GPS koordinatalari serverga yuborilmoqda'});return watchCourierPosition(trackedDelivery.id,p=>setTracking({state:'active',message:`Oxirgi yuborish: ${new Date().toLocaleTimeString('uz-UZ',{hour:'2-digit',minute:'2-digit'})} · ±${Math.round(p.accuracy||0)} m`}),e=>setTracking({state:'error',message:errorText(e,'GPS xatosi')}));},[trackingId,trackedDelivery?.id]);
  const selected=deliveries.find(item=>item.id===selectedId)||null;
  useEffect(()=>{if(page==='detail'&&!selected&&!loading)setPage('home');},[page,selected,loading]);
  const openDetail=item=>{setSelectedId(item.id);setPage('detail');};
  const onNotificationNavigate=item=>{
    const data=item?.data||{};
    if(data.handover_id){setPage('profile');return}
    const target=deliveries.find(row=>row.id===data.delivery_id||row.order_id===data.order_id);
    if(target)openDetail(target);
  };
  const transition=async(item,status,{note=null,file=null}={})=>{setBusyId(item.id);setError('');let proof=null;try{if(status==='delivered'&&file){proof=await uploadDeliveryProof(item.id,file);}await setCourierDeliveryStatus({deliveryId:item.id,status,note,proofId:proof?.proofId||null});proof=null;if(status==='in_transit'){setDeliveries(rows=>rows.map(row=>row.id===item.id?{...row,status:'in_transit'}:row));setTrackingId(item.id);}if(status==='delivered'||status==='failed')setTrackingId(current=>current===item.id?null:current);await load(true);setToast(`Holat “${labels[status]}”ga yangilandi`);}catch(e){if(proof)try{await deleteDeliveryProof({deliveryId:item.id,proofId:proof.proofId,key:proof.key});}catch(cleanupError){console.error('Delivery proof cleanup navbatga qo‘yilmadi.',cleanupError);}setError(errorText(e,'Holat yangilanmadi.'));throw e;}finally{setBusyId(null);}};
  return <div className="courier-shell"><div className="courier"><header>{page==='detail'?<button onClick={()=>setPage('home')} aria-label="Orqaga"><ArrowLeft/></button>:<div><span>{formatUzDate(new Date(), { weekday: 'long', day: true, month: 'long', year: true })}</span><b>Salom, {profile?.full_name?.split(' ')[0]||'Kuryer'}!</b></div>}<div className="courier-brand"><i>T</i></div><ThemeToggle/><NotificationCenter profileId={profile?.id} onOpenItem={onNotificationNavigate}/><AccountMenu compact/></header><main>{error&&<div className="courier-error"><AlertCircle/><span>{error}</span><button onClick={()=>load()}>Qayta urinish</button></div>}{loading?<CourierState text="Yetkazishlar yuklanmoqda…"/>:<>{page==='home'&&<CourierHome deliveries={deliveries} stats={stats} detail={openDetail} tracking={tracking} trackingId={trackingId}/>} {page==='route'&&<RoutePage deliveries={deliveries} detail={openDetail}/>} {page==='stats'&&<CourierStats stats={stats}/>} {page==='profile'&&<Profile profile={profile}/>} {page==='detail'&&selected&&<DeliveryDetail data={selected} busy={busyId===selected.id} update={(status,options)=>transition(selected,status,options)} tracking={trackingId===selected.id?tracking:null} toggleTracking={()=>setTrackingId(current=>current===selected.id?null:selected.id)}/>}</>}</main>{page!=='detail'&&<nav>{[['home',Home,'Asosiy'],['route',Route,'Manzillar'],['stats',BarChart3,'Natijalar'],['profile',User,'Profil']].map(([key,Icon,title])=><button key={key} className={page===key?'active':''} onClick={()=>setPage(key)}><Icon/><span>{title}</span></button>)}</nav>}<Toast message={toast} onClose={()=>setToast('')}/></div></div>;
}

function CourierHome({deliveries,stats,detail,tracking,trackingId}){
  const active=deliveries.filter(item=>activeStatuses.has(item.status)),completed=Number(stats?.delivered||0),total=Number(stats?.assigned||0),rate=total?Math.round(completed/total*100):0,next=active[0],distance=formatDistance(stats?.distance_m);
  return <><section className="courier-hero"><div><span>Joriy oy rejasi</span><b>{total} ta yetkazib berish</b><small>{completed} tasi yetkazildi · {Number(stats?.active||0)} tasi faol · {distance} yo‘l</small></div><div className="route-ring" style={{background:`conic-gradient(var(--orange) ${rate}%,#64748b 0)`,border:0}}><b>{rate}%</b></div></section><div className="courier-stats"><div><Package/><span><b>{Number(stats?.active||0)}</b>Faol</span></div><div><CheckCircle2/><span><b>{completed}</b>Yetkazildi</span></div><div><XCircle/><span><b>{Number(stats?.failed||0)}</b>Muvaffaqiyatsiz</span></div></div>{trackingId&&<div className={'tracking-banner '+(tracking.state==='error'?'error':'')}><Navigation/><span><b>GPS kuzatuv</b><small>{tracking.message}</small></span></div>}{next?<button className="start-route" onClick={()=>detail(next)}><Navigation/><span><b>Keyingi yetkazishni ochish</b><small>{formatAddress(next.shipping_address)}</small></span><ChevronRight/></button>:<CourierState text="Faol yetkazish yo‘q." compact/>}<div className="section-row"><h3>Faol yetkazishlar</h3><span>{active.length} ta</span></div>{active.length?<div className="delivery-list">{active.map((item,index)=><DeliveryCard key={item.id} item={item} index={index} detail={detail}/>)}</div>:<CourierState text="Sizga biriktirilgan faol yetkazish yo‘q." compact/>}</>;
}

function DeliveryCard({item,index,detail}){const quantity=lineQuantity(item),address=formatAddress(item.shipping_address);return <article className="delivery-card" onClick={()=>detail(item)}><div className="delivery-order"><span>{index+1}</span><div><b>{item.order_no||item.tracking_code}</b><small><Clock3/> {formatDate(item.assigned_at||item.created_at)}</small></div><DeliveryStatus status={item.status}/></div><h3>{item.customer_name||'Mijoz'}</h3><p><MapPin/> {address}</p><div className="delivery-bottom"><span><Package/> {quantity} ta mahsulot</span><span><WalletCards/> {paymentLabel(item.payment_status)}</span><b>{formatMoney(Number(item.total||0))}</b></div></article>}

function RoutePage({deliveries,detail}){const active=deliveries.filter(item=>activeStatuses.has(item.status));return <><div className="page-heading"><h2>Faol manzillar</h2><span>{active.length} ta serverdagi yetkazish</span></div><div className="route-notice card"><MapPin/><div><b>Navigatsiya tashqi xaritada ochiladi</b><span>Manzillar serverdan olinadi. Ketma-ketlik biriktirilgan vaqt bo‘yicha ko‘rsatilgan.</span></div></div>{active.length?<div className="route-stops">{active.map((item,index)=><div key={item.id}><span className={index===0?'current':''}>{index+1}</span><button className="route-stop-main" onClick={()=>detail(item)}><b>{item.customer_name||item.order_no}</b><small>{formatAddress(item.shipping_address)}</small><em>{labels[item.status]} · {lineQuantity(item)} ta mahsulot</em></button><a href={mapsUrl(item.shipping_address)} target="_blank" rel="noreferrer" aria-label="Xaritada ochish"><ExternalLink/></a></div>)}</div>:<CourierState text="Navigatsiya uchun faol manzil yo‘q."/>}</>}

function OrderQrVerification({orderId,onAllConfirmed,busy}){
  const[status,setStatus]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[code,setCode]=useState(''),[scanBusy,setScanBusy]=useState(false),[lastResult,setLastResult]=useState(null);
  const load=async()=>{setLoading(true);setError('');try{const data=await getCourierOrderVerification(orderId);setStatus(data)}catch(e){setError(errorText(e,'Yuklanmadi.'))}finally{setLoading(false)}};
  useEffect(()=>{load()},[orderId]);
  const submit=async e=>{
    e?.preventDefault?.();
    if(!code.trim())return;
    setScanBusy(true);setError('');setLastResult(null);
    try{
      const result=await courierVerifyOrderUnit(orderId,code.trim());
      setLastResult(result);
      setCode('');
      if(result.matched)await load();
    }catch(e){
      setError(errorText(e,'Tekshirilmadi.'));
    }finally{
      setScanBusy(false);
    }
  };
  if(loading)return <div className="qr-verify-loading">Tekshirilmoqda…</div>;
  const allConfirmed=status?.all_confirmed;
  return <div className="qr-verify-block">
    <h3><Package/> Mahsulotlarni QR skaner bilan tasdiqlash</h3>
    <p className="qr-verify-hint">
      Tovarni ombordan yoki doʻkondan yuklashingiz mumkin. Qaysi tovar (ombor yoki doʻkon) QR kodini skanerlasangiz, tizim avtomatik tasdiqlaydi.
    </p>
    <div className="qr-verify-list">
      {status?.items?.map((line,i)=>(
        <div key={i} className={'qr-verify-item'+(line.confirmed?' done':'')}>
          <span>{line.confirmed?<CheckCircle2/>:<Package/>}</span>
          <div style={{flex:1}}>
            <b>{line.product_name}</b>
            <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap',marginTop:2}}>
              <small>{line.sku}</small>
              {line.location_name&&<span style={{fontSize:10,padding:'1px 5px',borderRadius:4,background:line.location_type==='store'?'#fef3c7':'#dbeafe',color:line.location_type==='store'?'#92400e':'#1e40af'}}>{line.location_type==='store'?'📍 Do‘kondan yuklash':`🏢 Ombor (${line.location_name})`}</span>}
              {line.batch_code&&<span style={{fontSize:10,color:'#64748b'}}>Partiya: {line.batch_code}</span>}
            </div>
          </div>
          {line.confirmed&&<span style={{fontSize:11,color:'#16a34a',fontWeight:700}}>✓ Tasdiqlandi</span>}
        </div>
      ))}
    </div>
    <form onSubmit={submit} className="qr-verify-form">
      <input className="qr-verify-input" value={code} onChange={e=>setCode(e.target.value)} placeholder="Tovar QR kodi yoki seriya raqami" autoFocus/>
      <button type="submit" disabled={scanBusy||!code.trim()} className="qr-verify-submit">{scanBusy?'…':'Tekshirish'}</button>
    </form>
    {lastResult&&!lastResult.matched&&<div className="qr-verify-error"><AlertCircle/> {lastResult.message||"Mos kelmadi"}</div>}
    {lastResult?.matched&&<div className="qr-verify-success" style={lastResult.swapped?{background:'#f0fdf4',border:'1px solid #86efac',color:'#166534',padding:'8px 12px',borderRadius:8}:undefined}>
      <CheckCircle2 size={16}/> <b>{lastResult.product_name}</b>: {lastResult.message || 'tasdiqlandi'} ({lastResult.confirmed_count}/{lastResult.total_count})
    </div>}
    {error&&<div className="qr-verify-error"><AlertCircle/> {error}</div>}
    <button disabled={busy||!allConfirmed} className="status-button" onClick={onAllConfirmed}>
      <Package/> {busy?'Yangilanmoqda…':allConfirmed?'Buyurtmani olib ketdim':`Avval barcha mahsulotlarni tasdiqlang (${status?.items?.filter(x=>x.confirmed).length||0}/${status?.items?.length||0})`}
    </button>
  </div>;
}
function DeliveryDetail({data:item,busy,update,tracking,toggleTracking}){const[proof,setProof]=useState(null),[reason,setReason]=useState(''),[actionError,setActionError]=useState('');const run=async(status,options={})=>{setActionError('');try{await update(status,options);}catch(e){setActionError(errorText(e,'Amal bajarilmadi.'));}};const stages=['assigned','picked_up','in_transit','delivered'],current=Math.max(0,stages.indexOf(item.status));const address=formatAddress(item.shipping_address);return <section className="delivery-detail real-detail"><div className="detail-navigation"><MapPin/><div><small>Yetkazib berish manzili</small><b>{address}</b></div><a href={mapsUrl(item.shipping_address)} target="_blank" rel="noreferrer"><Navigation/> Xaritada ochish</a></div><div className="detail-sheet"><div className="sheet-handle"/><div className="between"><div><span>Buyurtma</span><h2>{item.order_no||item.tracking_code}</h2><small>{item.tracking_code}</small></div><DeliveryStatus status={item.status}/></div><div className="status-stepper">{stages.map((status,index)=><div key={status} className={current>=index&&item.status!=='failed'?'done':''}><i>{current>index?<Check/>:index+1}</i><span>{labels[status]}</span></div>)}</div><div className="customer-card"><div className="avatar">{(item.customer_name||'M')[0]}</div><div><b>{item.customer_name||'Mijoz'}</b><span>{item.customer_phone||'Telefon berilmagan'}</span></div>{item.customer_phone&&<a href={`tel:${item.customer_phone}`} aria-label="Qo‘ng‘iroq"><Phone/></a>}</div><div className="address-card"><span><MapPin/></span><div><small>Yetkazib berish manzili</small><b>{address}</b>{item.notes&&<em>Izoh: {item.notes}</em>}</div></div><div className="order-items"><h3>Buyurtma tarkibi</h3>{(item.lines||[]).map((line,index)=><div key={`${line.sku}-${index}`}><span className="product-placeholder"><Package/></span><div><b>{line.product_name}</b><span>{line.quantity} dona · SKU: {line.sku||'—'}</span></div></div>)}</div><div className="payment-info"><div><span>To‘lov holati</span><b>{paymentLabel(item.payment_status)}</b></div><div><span>Buyurtma summasi</span><b>{formatMoney(Number(item.total||0))}</b></div></div>{actionError&&<div className="detail-error"><AlertCircle/>{actionError}</div>}{item.status==='assigned'&&<OrderQrVerification orderId={item.order_id} onAllConfirmed={()=>run('picked_up')} busy={busy}/>}{item.status==='picked_up'&&<button disabled={busy} className="status-button" onClick={()=>run('in_transit')}><Truck/> {busy?'Yangilanmoqda…':'Yo‘lga chiqdim'}</button>}{item.status==='in_transit'&&<><div className={'tracking-control '+(tracking?.state==='error'?'error':'')}><Navigation/><span><b>{tracking?'GPS kuzatuv faol':'GPS kuzatuv o‘chiq'}</b><small>{tracking?.message||'Koordinatalarni serverga yuborish uchun yoqing.'}</small></span><button onClick={toggleTracking}>{tracking?'To‘xtatish':'Yoqish'}</button></div><label className="proof-picker"><span>Yetkazish isboti (ixtiyoriy: JPEG, PNG, WebP yoki AVIF; 10 MiB gacha)</span><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={event=>setProof(event.target.files?.[0]||null)}/><b>{proof?.name||'Rasm tanlang'}</b></label><button disabled={busy} className="status-button" onClick={()=>run('delivered',{file:proof})}><CheckCircle2/> {busy?'Yuklanmoqda\u2026':'Yetkazib berdim / Pulni oldim'}</button><div className="failure-form"><label htmlFor="failure-reason">Yetkazib bo‘lmagan bo‘lsa sabab</label><textarea id="failure-reason" value={reason} onChange={event=>setReason(event.target.value)} placeholder="Masalan: mijoz manzilda emas"/><button disabled={busy||!reason.trim()} onClick={()=>run('failed',{note:reason.trim()})}><AlertCircle/> Yetkazilmadi deb belgilash</button></div></>}{item.status==='delivered'&&<div className="delivered"><CheckCircle2/> Buyurtma muvaffaqiyatli yetkazildi</div>}{item.status==='failed'&&<div className="failed-result"><XCircle/> Yetkazish amalga oshmadi</div>}{item.proof_url&&<a className="proof-link" href={item.proof_url} target="_blank" rel="noreferrer"><ExternalLink/> Yetkazish isbotini ochish</a>}</div></section>}

function CourierStats({stats}){const rejected=Number(stats?.rejected_segments||0);return <><div className="page-heading"><h2>Mening natijalarim</h2><span>{getUzMonthName(new Date(), { withYear: true })}</span></div><section className="stats-hero"><span>Muvaffaqiyat ko‘rsatkichi</span><b>{Number(stats?.delivery_rate||0).toLocaleString('uz-UZ')}%</b><small>{formatDistance(stats?.distance_m)} yo‘l · serverdagi sifatli GPS segmentlari asosida</small></section><div className="stats-grid"><div><Package/><span><b>{Number(stats?.assigned||0)} ta</b>Jami biriktirilgan</span></div><div><CheckCircle2/><span><b>{Number(stats?.delivered||0)} ta</b>Yetkazildi</span></div><div><Navigation/><span><b>{formatDistance(stats?.distance_m)}</b>Bosib o‘tilgan yo‘l</span></div><div><Truck/><span><b>{Number(stats?.active||0)} ta</b>Faol</span></div><div><XCircle/><span><b>{Number(stats?.failed||0)} ta</b>Yetkazilmadi</span></div></div>{rejected>0&&<div className="tracking-banner"><AlertCircle/><span><b>GPS sifati nazorati</b><small>{rejected} ta noaniq yoki keskin sakragan segment masofaga qo‘shilmadi.</small></span></div>}</>}

function NotificationCenter({profileId,onOpenItem}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const[showAll,setShowAll]=useState(false);
  const wrapRef=useRef(null);

  const load=useCallback(async()=>{
    if(!profileId)return;setLoading(true);setError('');
    try{
      const result=await listNotifications({pageSize:30});
      setItems(result?.items||[]);setUnread(Number(result?.unread_count||0));
    }catch(e){setError(errorText(e,'Bildirishnomalar yuklanmadi.'));}
    finally{setLoading(false);}
  },[profileId]);

  useEffect(()=>{load();},[load]);
  useEffect(()=>{if(!profileId)return;return subscribeNotifications(load,e=>setError(errorText(e,'Realtime ulanmadi.')),profileId);},[profileId,load]);

  // Tashqariga bosilganda yopish
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
      await load();
      if(!ids){
        setTimeout(()=>setOpen(false),800);
      }
    }catch(e){setError(errorText(e,'O‘qilgan deb belgilanmadi.'));}
  };

  const openItem=item=>{
    if(!item.read_at)mark([item.id]);
    setOpen(false);
    if(item?.data?.order_id||item?.data?.delivery_id||item?.data?.handover_id)onOpenItem?.(item);
  };

  const displayItems=showAll?items:items.filter(item=>!item.read_at);

  return (
    <div className="courier-notifications" ref={wrapRef} style={{position:'relative'}}>
      <button className="icon-btn" onClick={()=>setOpen(value=>!value)} aria-label="Bildirishnomalar">
        <Bell/>
        {unread>0&&<i/>}
      </button>
      {open&&(
        <div className="courier-notification-panel" style={{position:'absolute',right:-48,top:45,zIndex:300}}>
          <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderBottom:'1px solid var(--line)'}}>
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
                disabled={!unread}
                onClick={()=>mark(null)}
                style={{
                  border:0,
                  background:'none',
                  color:unread?'var(--orange)':'var(--muted)',
                  fontSize:10,
                  fontWeight:700,
                  cursor:unread?'pointer':'default'
                }}
              >
                Barchasini o‘qish
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={()=>setOpen(false)}
                aria-label="Yopish"
                style={{width:24,height:24,display:'grid',placeItems:'center',borderRadius:'50%',cursor:'pointer',border:0,padding:0,color:'var(--muted)'}}
              >
                <X size={14}/>
              </button>
            </div>
          </header>
          {loading?(
            <CourierState text="Yuklanmoqda…" compact/>
          ):error?(
            <CourierState text={error} compact/>
          ):displayItems.length===0?(
            <div style={{padding:'20px 14px',textAlign:'center'}}>
              <Check size={22} style={{color:'#16a34a',margin:'0 auto 6px',display:'block'}}/>
              <b>{showAll?'Bildirishnoma yo‘q':'O‘qilmagan bildirishnoma yo‘q'}</b>
              <p style={{margin:'4px 0 0',fontSize:11,color:'var(--muted)'}}>
                {showAll?'Hozircha hech qanday bildirishnoma mavjud emas.':'Barcha bildirishnomalar o‘qilgan.'}
              </p>
              {!showAll&&items.length>0&&(
                <button
                  type="button"
                  style={{
                    margin:'10px auto 0',
                    fontSize:11,
                    padding:'4px 10px',
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
            <div>
              {displayItems.map(item=>(
                <button key={item.id} className={item.read_at?'':'unread'} onClick={()=>openItem(item)}>
                  <span>
                    <b>{item.title}</b>
                    <small>{item.body}</small>
                    <time>{formatDate(item.created_at)}</time>
                  </span>
                  {!item.read_at&&<i/>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Profile({profile}){
  const[cash,setCash]=useState(null),[cashLoading,setCashLoading]=useState(true);
  useEffect(()=>{setCashLoading(true);listCourierPendingCash().then(data=>setCash(data)).catch(()=>{}).finally(()=>setCashLoading(false))},[]);
  return <><div className="profile-hero"><div className="avatar">{(profile?.full_name||'K').split(/\s+/).map(part=>part[0]).join('').slice(0,2)}</div><h2>{profile?.full_name||profile?.email}</h2><span>Kuryer</span><Status type="green">Faol akkaunt</Status></div>
  <div className="courier-cash-section card"><h3><WalletCards/> Do'konga topshirishim kerak bo'lgan pullar</h3>
    {cashLoading?<CourierState text="Yuklanmoqda\u2026" compact/>:!cash?.items?.length?<CourierState text="Topshirish kerak bo'lgan pul yo'q." compact/>:<>
      <div className="courier-cash-total"><span>Jami topshirilmagan</span><b>{Number(cash.total||0).toLocaleString('uz-UZ')} so'm</b></div>
      <div className="courier-cash-list">{cash.items.map(item=><div key={item.id} className="courier-cash-item"><div><b>{item.order_no}</b><small>{item.customer_name}</small></div><strong>{Number(item.amount).toLocaleString('uz-UZ')} so'm</strong><Status type="orange">Kutilmoqda</Status></div>)}</div>
    </>}
  </div>
  <div className="profile-server card"><User/><div><b>Server profili</b><span>{profile?.email||'Email ko\'rsatilmagan'}</span><small>ID: {profile?.id}</small></div></div><AccountMenu/></>
}

function DeliveryStatus({status}){const type=status==='delivered'?'green':status==='failed'||status==='cancelled'?'red':status==='in_transit'?'orange':'gray';return <Status type={type}>{labels[status]||status}</Status>}
function CourierState({text,compact=false}){return <div className={'courier-state '+(compact?'compact':'')}><Package/><span>{text}</span></div>}
function lineQuantity(item){return(item.lines||[]).reduce((sum,line)=>sum+Number(line.quantity||0),0)}
function formatDistance(value){const meters=Number(value||0);return meters>=1000?`${(meters/1000).toLocaleString('uz-UZ',{minimumFractionDigits:1,maximumFractionDigits:2})} km`:`${Math.round(meters).toLocaleString('uz-UZ')} m`}
function formatDate(value){if(!value)return'Vaqt ko‘rsatilmagan';const date=new Date(value);return Number.isNaN(date.getTime())?'Vaqt ko‘rsatilmagan':date.toLocaleString('uz-UZ',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
function paymentLabel(status){return({paid:'To‘langan',pending:'To‘lov kutilmoqda',failed:'To‘lov bajarilmadi',refunded:'Qaytarilgan'})[status]||status||'Noma’lum'}
function formatAddress(value){if(typeof value==='string')return value.trim()||'Manzil ko‘rsatilmagan';if(!value||typeof value!=='object')return'Manzil ko‘rsatilmagan';if(typeof value.address==='string'&&value.address.trim())return value.address.trim();const preferred=['street','house','apartment','district','city','region'];const parts=preferred.map(key=>value[key]).filter(part=>typeof part==='string'||typeof part==='number');if(parts.length)return parts.join(', ');const fallback=Object.values(value).filter(part=>typeof part==='string'||typeof part==='number');return fallback.join(', ')||'Manzil ko‘rsatilmagan'}
function mapsUrl(address){return`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(address))}`}
