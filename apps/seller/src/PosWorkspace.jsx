import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,ArrowLeftRight,BarChart3,Boxes,ChevronRight,CreditCard,ExternalLink,Home,Layers,Mail,MapPin,Package,Plus,Printer,QrCode,ReceiptText,Search,Send,ShoppingCart,Store,Trash2,User,Warehouse,X}from'lucide-react';
import{DualPrice,Empty,Modal,QrScanButton,Status,formatDualMoney,useExchangeRate}from'@texnobazar/ui';
import{createPosPendingSale,getPosPendingSale,getPosProductAvailability,getPosReferences,getPosUnitContext,getReceiptDeliveryStatus,getSaleReceipt,listMyPosPendingSalesByDate,listMyPosSales,listPosUnits,queueSaleReceipt,relocatePosUnits}from'@texnobazar/data';
import ProfileWorkspace from'./ProfileWorkspace';

const msg=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const when=value=>value?new Date(value).toLocaleString('uz-UZ'):'—';
const address=value=>{if(!value)return'';if(typeof value==='string')return value;return[value.line1,value.line2,value.district,value.city,value.region,value.postal_code].filter(Boolean).join(', ')};
const labels={pending:'Kutilmoqda',confirmed:'Tasdiqlandi',rejected:'Rad etildi',expired:'Muddati tugadi'};
const unitStates={available:'Sotuvga tayyor',reserved:'Band qilingan',in_transit:'Yo‘lda',sold:'Sotilgan',returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:'Ta’mirda'};
const colors={pending:'orange',confirmed:'green',rejected:'red',expired:'gray'};
const lineTax=line=>Math.round((Number(line.unit_price||0)-Number(line.discount||0))*Number(line.tax_rate||0))/100;
const lineTotal=line=>Number(line.unit_price||0)-Number(line.discount||0)+lineTax(line);
// Money inputs stay strings so the seller can fully clear a value instead of
// fighting a sticky leading zero.
const numericText=value=>{const raw=String(value??'').replace(/[^\d.]/g,'');const[whole,...rest]=raw.split('.');const head=whole.replace(/^0+(?=\d)/,'');return rest.length?`${head||'0'}.${rest.join('').slice(0,2)}`:head};
const STOREFRONT=(import.meta.env?.VITE_STOREFRONT_URL)||'https://texnobazar-storefront.netlify.app';
const todayInput=()=>{const date=new Date();return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`};
const emptySales=()=>({items:[],today:{count:0,total:0,profit:0,avg_check:0,discount:0}});

export default function PosWorkspace({branchId,profile,toast}){
  const rate=useExchangeRate();
  const[page,setPage]=useState('home'),[refs,setRefs]=useState(null),[units,setUnits]=useState([]),[sales,setSales]=useState(emptySales),[pending,setPending]=useState({items:[]}),[homeDate,setHomeDate]=useState(todayInput);
  const[cart,setCart]=useState([]),[query,setQuery]=useState(''),[debounced,setDebounced]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[receipt,setReceipt]=useState(null),[pendingDetail,setPendingDetail]=useState(null),[created,setCreated]=useState(null);
  const[relocateBatch,setRelocateBatch]=useState([]);
  // The unfinished basket survives accidental logout/refresh until a new sale starts.
  const cartKey=profile?.id&&branchId?`texnobazar:seller-cart:${profile.id}:${branchId}`:null;
  const[cartReady,setCartReady]=useState(false);
  useEffect(()=>{setCartReady(false);setCart([]);if(!cartKey){setCartReady(true);return}try{const saved=JSON.parse(localStorage.getItem(cartKey)||'[]');setCart(Array.isArray(saved)?saved.filter(line=>line&&line.id):[])}catch{localStorage.removeItem(cartKey)}setCartReady(true)},[cartKey]);
  useEffect(()=>{if(!cartKey||!cartReady)return;if(cart.length)localStorage.setItem(cartKey,JSON.stringify(cart));else localStorage.removeItem(cartKey)},[cart,cartKey,cartReady]);
  const loadHome=async date=>{const[s,p]=await Promise.all([listMyPosSales({branchId,date,pageSize:100}),listMyPosPendingSalesByDate({branchId,date,pageSize:100})]);setSales(s||emptySales());setPending(p||{items:[]})};
  const load=async()=>{if(!branchId){setLoading(false);return}setLoading(true);setError('');try{const[r]=await Promise.all([getPosReferences(branchId),loadHome(homeDate)]);setRefs(r)}catch(e){setError(msg(e))}finally{setLoading(false)}};
  const changeHomeDate=async value=>{setHomeDate(value);setLoading(true);setError('');try{await loadHome(value)}catch(e){setError(msg(e))}finally{setLoading(false)}};
  useEffect(()=>{load()},[branchId]);
  useEffect(()=>{setUnits([]);const id=setTimeout(()=>setDebounced(query.trim()),300);return()=>clearTimeout(id)},[query]);
  useEffect(()=>{if(!branchId||page!=='scan'||!debounced){setUnits([]);return}let active=true;listPosUnits({branchId,query:debounced,pageSize:30}).then(r=>active&&setUnits(r.items||[])).catch(e=>active&&setError(msg(e)));return()=>{active=false}},[branchId,page,debounced]);
  const add=unit=>setCart(current=>{if(current.some(x=>x.id===unit.id)){toast?.('Bu mahsulot birligi savdoda mavjud');return current}toast?.('Mahsulot savdoga qo‘shildi');return[...current,{...unit,unit_price:numericText(unit.retail_price),discount:'',tax_rate:Number(unit.tax_rate||0)}]});
  const addToRelocate=unit=>setRelocateBatch(current=>{if(current.some(x=>x.id===unit.id)){toast?.('Bu mahsulot birligi ro‘yxatda bor');return current}toast?.('Ko‘chirish ro‘yxatiga qo‘shildi');return[...current,unit]});
  const openReceipt=async id=>{try{setReceipt({...await getSaleReceipt(id),sale_id:id})}catch(e){setError(msg(e))}};
  const openPending=async id=>{try{setPendingDetail(await getPosPendingSale(id))}catch(e){setError(msg(e))}};
  return <><main className="pos-real-workspace">
    {page!=='scan'&&page!=='profile'&&!loading&&!error&&<button type="button" className="pos-real-scan-cta pos-real-scan-sticky" onClick={()=>setPage('scan')}><QrCode/><span><b>QR/seriyani kiritish</b><small>Skaner qurilmasi yoki klaviatura orqali</small></span><ChevronRight/></button>}
    {loading?<State text="POS ma’lumotlari yuklanmoqda…"/>:error?<State error text={error} retry={load}/>:page==='home'?<HomePage sales={sales} pending={pending} date={homeDate} setDate={changeHomeDate} profile={profile} openReceipt={openReceipt} openPending={openPending} go={setPage} rate={rate}/>:page==='scan'?<Scanner branchId={branchId} query={query} setQuery={setQuery} units={units} add={add} addToRelocate={addToRelocate} relocateCount={relocateBatch.length} goRelocate={()=>setPage('relocate')} toast={toast} rate={rate}/>:page==='cart'?<Cart branchId={branchId} cart={cart} setCart={setCart} refs={refs} created={created} setCreated={setCreated} refresh={load} toast={toast} rate={rate}/>:page==='relocate'?<Relocate branchId={branchId} batch={relocateBatch} setBatch={setRelocateBatch} toast={toast} back={()=>setPage('scan')}/>:page==='profile'?<ProfileWorkspace toast={toast}/>:<Kpi branchId={branchId} openReceipt={openReceipt} rate={rate}/>}
  </main><nav className="pos-real-nav">{[['home',Home,'Asosiy'],['scan',QrCode,'Skaner'],['cart',ShoppingCart,'Savdo'],['kpi',BarChart3,'KPI'],['profile',User,'Profil']].map(([key,Icon,text])=><button type="button" key={key} className={page===key?'active':''} onClick={()=>setPage(key)}><span><Icon/>{key==='cart'&&cart.length>0&&<i>{cart.length}</i>}</span>{text}</button>)}</nav>
  <PendingDetail sale={pendingDetail} close={()=>setPendingDetail(null)} rate={rate}/><Receipt receipt={receipt} close={()=>setReceipt(null)} rate={rate}/></>;
}

function State({text,error,retry}){return <div className={'pos-real-state '+(error?'error':'')}>{error&&<AlertTriangle/>}<p>{text}</p>{retry&&<button type="button" className="btn" onClick={retry}>Qayta urinish</button>}</div>}
function HomePage({sales,pending,date,setDate,profile,openReceipt,openPending,go,rate}){const k=sales.today||{};const isToday=date===todayInput();return <section><div className="pos-real-title"><div><small>{isToday?'Bugungi natija':'Tanlangan kun natijasi'}</small><h2>{profile?.full_name?.split(' ')[0]||'Sotuvchi'}</h2></div><Status type="green">Yangilangan</Status></div><DateFilter value={date} onChange={setDate}/><KpiCards kpi={k} rate={rate}/><h3>Kassadagi so‘rovlar</h3>{pending.items?.length?<div className="pos-real-pending">{pending.items.map(x=><button type="button" key={x.id} onClick={()=>openPending(x.id)}><div><b>{x.pending_no}</b><small>{x.unit_count} dona · {when(x.created_at)}</small></div><strong><DualPrice value={Number(x.total||0)} rate={rate}/></strong><Status type={colors[x.status]}>{labels[x.status]||x.status}</Status><ChevronRight/></button>)}</div>:<Empty title="Kassa so‘rovlari yo‘q" text="Tanlangan kunda kassaga yuborilgan so‘rovlar mavjud emas."/>}<Sales title="Tanlangan kundagi savdolar" rows={sales.items} openReceipt={openReceipt} rate={rate}/></section>}
function DateFilter({value,onChange}){return <label className="pos-real-date-filter"><span>Sana</span><input type="date" value={value} onChange={event=>onChange(event.target.value)}/></label>}
function KpiCards({kpi,rate}){return <div className="pos-real-kpis"><article><small>Savdo</small><b>{<DualPrice value={Number(kpi.total||0)} rate={rate}/>}</b></article><article><small>Cheklar</small><b>{Number(kpi.count||0)} ta</b></article><article><small>Foyda</small><b>{<DualPrice value={Number(kpi.profit||0)} rate={rate}/>}</b></article><article><small>O‘rtacha chek</small><b>{<DualPrice value={Number(kpi.avg_check||0)} rate={rate}/>}</b></article></div>}

// --- Scanner: looks up a unit via get_pos_unit_context (full pricing + stock context),
// shows a detail card the seller can act on (open storefront page, add to sale cart, or
// add to the store<->warehouse relocation batch). Falls back to the simple add-to-cart
// flow for units already in the list below.
function Scanner({branchId,query,setQuery,units,add,addToRelocate,relocateCount,goRelocate,toast,rate}){
  const[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[context,setContext]=useState(null);
  const[quantity,setQuantity]=useState(1);
  // Multi-unit sales: every physical item keeps its own QR, so the seller is
  // asked to scan exactly as many units as the customer buys.
  const[plan,setPlan]=useState(null);
  const cartLine=unit=>({id:unit.id,qr_code:unit.qr_code,serial_number:unit.serial_number,product_name:unit.product_name,sku:unit.sku,brand_name:unit.brand_name,image:unit.image,location_type:unit.location_type,retail_price:unit.prices.retail_price_uzs,minimum_sale_price:unit.prices.minimum_sale_price_uzs,unit_cost:unit.prices.unit_cost_uzs,tax_rate:unit.prices.tax_rate,available_branch_count:unit.branch_stock.store+unit.branch_stock.warehouse});
  const sellable=unit=>unit&&unit.in_current_branch!==false&&unit.product_status==='active'&&unit.status==='available'&&unit.is_sellable!==false;
  const extractQr=value=>{const raw=String(value||'').trim();if(!raw)return'';try{const url=new URL(raw,STOREFRONT);const match=url.pathname.match(/^\/qr\/([^/]+)\/?$/i);return match?decodeURIComponent(match[1]).trim():raw}catch{return raw}};
  const applyResult=result=>{
    if(plan&&sellable(result)&&result.product_id===plan.productId&&!plan.scannedIds.includes(result.id)){
      add(cartLine(result));
      const scannedIds=[...plan.scannedIds,result.id];
      if(scannedIds.length>=plan.total){setPlan(null);setContext(null);toast?.(`${plan.total} ta ${result.product_name} savdoga qo‘shildi`)}
      else{setPlan({...plan,scannedIds});setContext(null);toast?.(`${scannedIds.length}/${plan.total} ta skanerlandi`)}
      return;
    }
    if(plan&&result.product_id!==plan.productId)setError(`Avval ${plan.productName} turidagi mahsulotlarni skanerlang yoki ro‘yxatni bekor qiling.`);
    setContext(result);
  };
  const runLookup=async raw=>{const value=extractQr(raw);if(!value)return;setBusy(true);setError('');setContext(null);try{applyResult(await getPosUnitContext(branchId,value));setCode('')}catch(e){setError(msg(e))}finally{setBusy(false)}};
  const lookup=e=>{e?.preventDefault?.();if(!code.trim())return;runLookup(code)};
  const addFromContext=()=>{
    if(!context)return;
    add(cartLine(context));
    const total=Math.max(1,Math.min(50,Number(quantity)||1));
    if(total>1){setPlan({productId:context.product_id,productName:context.product_name,total,scannedIds:[context.id]});toast?.(`1/${total} ta skanerlandi, yana ${total-1} ta QR skanerlang`)}
    setContext(null);setQuantity(1);
  };
  const relocateFromContext=()=>{if(!context)return;addToRelocate({id:context.id,qr_code:context.qr_code,serial_number:context.serial_number,product_name:context.product_name,sku:context.sku,image:context.image,location_type:context.location_type});setContext(null)};
  return <section>
    <div className="pos-real-title"><div><h2>Skaner va qidiruv</h2><small>Sotish yoki joyini o‘zgartirish uchun mahsulotni skanerlang</small></div>{relocateCount>0&&<button type="button" className="btn btn-outline" onClick={goRelocate}><ArrowLeftRight size={15}/> {relocateCount} ta ko‘chirishga tayyor</button>}</div>
    <form className="pos-real-code" onSubmit={lookup}><QrCode/><input autoFocus value={code} onChange={e=>setCode(e.target.value)} placeholder="QR, seriya, shtrix-kod yoki SKU"/><QrScanButton onScan={value=>{setCode(extractQr(value));runLookup(value)}}/><button type="submit" disabled={busy}>{busy?'Izlanmoqda…':'Topish'}</button></form>
    {plan&&<div className="pos-real-warning"><Layers size={14}/> {plan.productName}: {plan.scannedIds.length}/{plan.total} ta skanerlandi. Yana {plan.total-plan.scannedIds.length} ta QR skanerlang. <button type="button" className="btn btn-sm" onClick={()=>{setPlan(null);setError('')}}>Bekor qilish</button></div>}
    {error&&<div className="pos-real-inline-error">{error}</div>}
    {context&&<UnitContextCard branchId={branchId} context={context} quantity={quantity} setQuantity={setQuantity} onAddToSale={addFromContext} onAddToRelocate={relocateFromContext} onClose={()=>setContext(null)} rate={rate}/>}
    <label className="pos-real-search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Mahsulot nomi yoki kodi bo‘yicha"/></label>
    <div className="pos-real-unit-list">{!query.trim()?<Empty title="Qidirishni boshlang" text="Mahsulot nomi, SKU yoki kodni yozing. Bo‘sh qidiruvda katalog yuklanmaydi."/>:units.length?units.map(unit=><Unit key={unit.id} unit={unit} add={()=>add(unit)} rate={rate}/>):<Empty title="Mahsulot topilmadi" text="Qidiruvni o‘zgartiring yoki QR kodni yuqoridagi aniq qidiruvga kiriting."/>}</div>
  </section>;
}

// Full detail card shown after a successful scan: pricing in UZS+USD, per-branch
// store/warehouse stock, stock in other branches, and a link to the storefront page.
function UnitContextCard({branchId,context,quantity,setQuantity,onAddToSale,onAddToRelocate,onClose,rate}){
  const p=context.prices,stock=context.branch_stock;
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
        <small>QR: {context.qr_code}{context.serial_number?` · S/N: ${context.serial_number}`:''}</small>
        <Status type={context.location_type==='store'?'green':'blue'}>{context.location_type==='store'?'Do‘konda':'Omborda'}</Status>
        {context.unit_branch_name&&<Status type={inCurrentBranch?'green':'orange'}>{context.unit_branch_name}</Status>}
        {!free&&<Status type={context.status==='sold'?'blue':'orange'}>{unitStates[context.status]||context.status}</Status>}
        {!productActive&&<Status type="orange">{context.product_status==='draft'?'Qoralama':'Faol emas'}</Status>}
      </div>
      {context.storefront_url&&<a className="btn btn-outline btn-sm pos-unit-context-link" href={STOREFRONT+context.storefront_url} target="_blank" rel="noopener"><ExternalLink size={13}/> Saytda ko‘rish</a>}
    </div>
    <div className="pos-unit-context-prices">
      <span><small>Sotish narxi</small><b><DualPrice value={Number(p.retail_price_uzs||0)} rate={rate}/></b></span>
      <span><small>Ulgurji narxi</small><b>{p.wholesale_price_uzs!=null?<DualPrice value={Number(p.wholesale_price_uzs||0)} rate={rate}/>:'—'}</b></span>
      <span><small>Minimal narx</small><b><DualPrice value={Number(p.minimum_sale_price_uzs||0)} rate={rate}/></b></span>
    </div>
    <div className="pos-unit-context-stock">
      <span><Store size={15}/> Do‘konda: <b>{stock.store}</b> dona</span>
      <span><Warehouse size={15}/> Omborda: <b>{stock.warehouse}</b> dona</span>
    </div>
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
    {canSell&&<label className="pos-unit-context-qty">Mahsulot soni<input type="text" inputMode="numeric" autoComplete="off" placeholder="1" value={quantity} onChange={event=>setQuantity(String(event.target.value).replace(/[^\d]/g,'').replace(/^0+(?=\d)/,'').slice(0,2))} onBlur={()=>setQuantity(String(Math.max(1,Math.min(50,Number(quantity)||1))))}/><small>1 dan katta bo‘lsa, shuncha QR skanerlash so‘raladi</small></label>}
    <div className="pos-unit-context-actions">
      <button type="button" className="btn btn-primary" disabled={!canSell} onClick={onAddToSale}><ShoppingCart size={15}/> {saleLabel}</button>
      <button type="button" className="btn btn-outline" disabled={!canRelocate} onClick={onAddToRelocate}><ArrowLeftRight size={15}/> {canRelocate?'Joyini o‘zgartirish':'Boshqa filialda'}</button>
    </div>
  </article>;
}

function Unit({unit,add,rate}){return <article className="pos-real-unit">{unit.image?<img src={unit.image} alt=""/>:<span className="pos-real-image"><QrCode/></span>}<div><b>{unit.product_name}</b><small>{unit.brand_name||'Brendsiz'} · {unit.sku}</small><small>QR: {unit.qr_code}{unit.serial_number?` · S/N: ${unit.serial_number}`:''}</small>{unit.location_type&&<Status type={unit.location_type==='store'?'green':'blue'}>{unit.location_type==='store'?'Do‘konda':'Omborda'}</Status>}<strong>{<DualPrice value={Number(unit.retail_price||0)} rate={rate}/>}</strong><em>Minimum: {<DualPrice value={Number(unit.minimum_sale_price||0)} rate={rate}/>} · Tannarx: {<DualPrice value={Number(unit.unit_cost||0)} rate={rate}/>}</em>{unit.latest_batch_retail&&Number(unit.latest_batch_retail)!==Number(unit.retail_price)&&<em style={{color:'#059669'}}>Yangi partiya narxi: {<DualPrice value={Number(unit.latest_batch_retail||0)} rate={rate}/>}</em>}<em>Filialda: {unit.available_branch_count} dona</em></div><button type="button" onClick={add} aria-label="Savdoga qo'shish"><Plus/></button></article>}

// --- Sale flow: cart + optional customer info + minimum-price warning (soft, not blocking).
function Cart({branchId,cart,setCart,refs,created,setCreated,refresh,toast,rate}){
  const[payments,setPayments]=useState([]),[notes,setNotes]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[customer,setCustomer]=useState({full_name:'',phone:'',address:''}),[showCustomer,setShowCustomer]=useState(false);
  const total=useMemo(()=>cart.reduce((sum,line)=>sum+lineTotal(line),0),[cart]);
  const paid=payments.reduce((sum,p)=>sum+Number(p.amount||0),0);
  const methods=refs?.payment_methods||[];
  useEffect(()=>{if(!methods.length)return;setPayments(current=>current.length?current:[{method_code:(methods.find(x=>x.code==='cash')||methods[0]).code,amount:total?total.toFixed(2):'',external_reference:''}])},[methods.length]);
  useEffect(()=>setPayments(current=>current.length===1?[{...current[0],amount:total?total.toFixed(2):''}]:current),[total]);
  const editLine=(id,key,value)=>setCart(rows=>rows.map(row=>row.id===id?{...row,[key]:numericText(value)}:row));
  // Limits are enforced when the field loses focus so typing is never blocked.
  const normalizeLine=(id,key)=>setCart(rows=>rows.map(row=>{
    if(row.id!==id)return row;
    const percent=Number(refs?.discount_policy?.seller_max_line_discount_percent||20)/100;
    if(key==='unit_price'){
      const price=Math.min(Number(row.retail_price||0)*2,Math.max(0,Number(row.unit_price||0)));
      const maxDiscount=Math.max(0,Math.min(price*percent,price));
      return{...row,unit_price:numericText(price),discount:row.discount===''?'':numericText(Math.min(Number(row.discount||0),maxDiscount))};
    }
    if(row.discount==='')return row;
    const maxDiscount=Math.max(0,Math.min(Number(row.unit_price||0)*percent,Number(row.unit_price||0)));
    return{...row,discount:numericText(Math.min(maxDiscount,Math.max(0,Number(row.discount||0))))};
  }));
  const addPayment=()=>{if(payments.length>=10||!methods.length)return;setPayments([...payments,{method_code:methods[0].code,amount:'',external_reference:''}])};
  const belowMinimumLines=cart.filter(line=>lineTotal(line)-lineTax(line)<Number(line.minimum_sale_price||0));
  const submit=async e=>{
    e.preventDefault();if(!cart.length)return;
    if(Math.abs(paid-total)>0.005)return setError('To‘lovlar jami hisoblangan umumiy summaga teng bo‘lishi kerak.');
    setBusy(true);setError('');
    try{
      const customerPayload=customer.phone.trim()?{full_name:customer.full_name.trim()||null,phone:customer.phone.trim(),address:customer.address.trim()||null}:null;
      const result=await createPosPendingSale({branchId,lines:cart.map(x=>({unit_id:x.id,unit_price:Number(x.unit_price),discount:Number(x.discount||0)})),payments:payments.map(x=>({method_code:x.method_code,amount:Number(x.amount),external_reference:x.external_reference||null})),notes,customer:customerPayload});
      setCreated(result);setCart([]);setNotes('');setCustomer({full_name:'',phone:'',address:''});setShowCustomer(false);
      toast?.('Savdo menejer kassasiga yuborildi');await refresh();
    }catch(e){setError(msg(e))}finally{setBusy(false)}
  };
  if(created&&!cart.length)return <section><div className="pos-real-success"><ReceiptText/><h2>Kassaga yuborildi</h2><b>{created.pending_no}</b><Status type={colors[created.status]}>{labels[created.status]||created.status}</Status><p>Rezerv tugashi: {when(created.expires_at)}</p><strong>{<DualPrice value={Number(created.total||0)} rate={rate}/>}</strong><button type="button" className="btn btn-primary" onClick={()=>setCreated(null)}>Yangi savdo</button></div></section>;
  return <section>
    <div className="pos-real-title"><div><h2>Joriy savdo</h2><small>{cart.length} ta noyob mahsulot birligi</small></div></div>
    {!cart.length?<Empty title="Savdo bo‘sh" text="Skaner yoki qidiruvdan mahsulot birligini qo‘shing."/>:<form onSubmit={submit}>
      <div className="pos-real-cart">{cart.map(line=>{
        const currentTotal=lineTotal(line)-lineTax(line);
        const isBelowMinimum=currentTotal<Number(line.minimum_sale_price||0);
        return <article key={line.id}>
          <div className="pos-real-cart-head"><div><b>{line.product_name}</b><small>{line.qr_code}{line.serial_number?` · ${line.serial_number}`:''}</small>{line.location_type&&<Status type={line.location_type==='store'?'green':'blue'}>{line.location_type==='store'?'Do‘kondan':'Ombordan'}</Status>}</div><button type="button" onClick={()=>setCart(x=>x.filter(y=>y.id!==line.id))}><Trash2/></button></div>
          <div className="pos-real-line-grid">
            <label>Sotuv narxi<input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={line.unit_price} onChange={e=>editLine(line.id,'unit_price',e.target.value)} onBlur={()=>normalizeLine(line.id,'unit_price')}/></label>
            <label>Chegirma<input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={line.discount} onChange={e=>editLine(line.id,'discount',e.target.value)} onBlur={()=>normalizeLine(line.id,'discount')}/></label>
          </div>
          {isBelowMinimum&&<div className="pos-real-warning"><AlertTriangle size={14}/> Narx minimal sotish summasidan past ({<DualPrice value={Number(line.minimum_sale_price||0)} rate={rate}/>}). Sotish mumkin, ammo menejer bunga e’tibor beradi.</div>}
          <div className="pos-real-prices"><span>Retail <b>{<DualPrice value={Number(line.retail_price||0)} rate={rate}/>}</b></span><span>Minimum <b>{<DualPrice value={Number(line.minimum_sale_price||0)} rate={rate}/>}</b></span><span>Tannarx <b>{<DualPrice value={Number(line.unit_cost||0)} rate={rate}/>}</b></span><span>Tax ({Number(line.tax_rate||0)}%) <b>{<DualPrice value={Number(lineTax(line)||0)} rate={rate}/>}</b></span><span>Taxminiy foyda <b>{<DualPrice value={Number(lineTotal(line)-lineTax(line)-Number(line.unit_cost)||0)} rate={rate}/>}</b></span><span>Filialda <b>{line.available_branch_count} dona</b></span></div>
        </article>;
      })}</div>
      <div className="pos-real-totals"><span>Narxlar − chegirma<b>{<DualPrice value={Number(cart.reduce((s,x)=>s+Number(x.unit_price)-Number(x.discount||0),0)||0)} rate={rate}/>}</b></span><span>Soliq<b>{<DualPrice value={Number(cart.reduce((s,x)=>s+lineTax(x),0)||0)} rate={rate}/>}</b></span><strong>Jami<b>{<DualPrice value={Number(total||0)} rate={rate}/>}</b></strong></div>
      <div className="pos-real-customer">
        <button type="button" className="between pos-real-customer-toggle" onClick={()=>setShowCustomer(v=>!v)}><span><User size={15}/> Mijoz ma’lumotlari (ixtiyoriy)</span><ChevronRight style={{transform:showCustomer?'rotate(90deg)':'none'}}/></button>
        {showCustomer&&<div className="pos-real-customer-fields">
          <label>Mijoz ismi<input className="input" value={customer.full_name} onChange={e=>setCustomer(c=>({...c,full_name:e.target.value}))} placeholder="Ixtiyoriy"/></label>
          <label>Telefon raqami<input className="input" type="tel" value={customer.phone} onChange={e=>setCustomer(c=>({...c,phone:e.target.value}))} placeholder="+998 90 123 45 67"/></label>
          <label>Manzil<input className="input" value={customer.address} onChange={e=>setCustomer(c=>({...c,address:e.target.value}))} placeholder="Ixtiyoriy"/></label>
        </div>}
      </div>
      <div className="pos-real-payment"><div className="between"><h3>To‘lov taqsimoti</h3><button type="button" onClick={addPayment}><Plus/> Qator</button></div>{payments.map((p,i)=><div className="pos-real-payment-row" key={i}><select value={p.method_code} onChange={e=>setPayments(x=>x.map((v,n)=>n===i?{...v,method_code:e.target.value}:v))}>{methods.map(m=><option key={m.code} value={m.code}>{m.name}</option>)}</select><input aria-label="Summa" type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={p.amount} onChange={e=>setPayments(x=>x.map((v,n)=>n===i?{...v,amount:numericText(e.target.value)}:v))}/><input aria-label="Havola" value={p.external_reference} onChange={e=>setPayments(x=>x.map((v,n)=>n===i?{...v,external_reference:e.target.value}:v))} placeholder="Havola (ixtiyoriy)"/><button type="button" disabled={payments.length===1} onClick={()=>setPayments(x=>x.filter((_,n)=>n!==i))}><X/></button></div>)}<small>To‘lovlar: {<DualPrice value={Number(paid||0)} rate={rate}/>} / {<DualPrice value={Number(total||0)} rate={rate}/>}</small></div>
      <label className="pos-real-notes">Izoh<textarea value={notes} onChange={e=>setNotes(e.target.value)} rows="2"/></label>
      {belowMinimumLines.length>0&&<div className="pos-real-warning"><AlertTriangle size={14}/> {belowMinimumLines.length} ta mahsulot minimal narxdan past sotilmoqda.</div>}
      {error&&<div className="pos-real-inline-error">{error}</div>}
      <button type="submit" className="btn btn-primary btn-block pos-real-submit" disabled={busy||Math.abs(paid-total)>.005}><CreditCard/>{busy?'Yuborilmoqda…':'Kassaga yuborish'}</button>
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

function Kpi({branchId,openReceipt,rate}){
  const[date,setDate]=useState(todayInput),[draft,setDraft]=useState(''),[query,setQuery]=useState(''),[sales,setSales]=useState(emptySales),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useEffect(()=>{if(!branchId)return;let active=true;setLoading(true);setError('');listMyPosSales({branchId,date,query,pageSize:100}).then(result=>active&&setSales(result||emptySales())).catch(currentError=>active&&setError(msg(currentError))).finally(()=>active&&setLoading(false));return()=>{active=false}},[branchId,date,query]);
  const apply=event=>{event.preventDefault();setQuery(draft.trim())};
  return <section><div className="pos-real-title"><div><h2>KPI</h2><small>Filial vaqt mintaqasi bo‘yicha tanlangan kun</small></div></div><form className="pos-real-kpi-filters" onSubmit={apply}><DateFilter value={date} onChange={setDate}/><label className="pos-real-search"><Search/><input value={draft} onChange={event=>setDraft(event.target.value)} placeholder="Chek, mahsulot, SKU, QR yoki seriya"/><button type="submit">Qidirish</button></label>{query&&<button type="button" className="btn btn-outline" onClick={()=>{setDraft('');setQuery('')}}>Filtrni tozalash</button>}</form>{error?<div className="pos-real-inline-error">{error}</div>:loading?<State text="KPI yuklanmoqda…"/>:<><KpiCards kpi={sales.today||{}} rate={rate}/><div className="pos-real-kpi-wide"><span>Berilgan chegirma<b><DualPrice value={Number(sales.today?.discount||0)} rate={rate}/></b></span><span>Sof foyda<b><DualPrice value={Number(sales.today?.profit||0)} rate={rate}/></b></span></div><Sales title="Filtrlangan savdolar" rows={sales.items} openReceipt={openReceipt} rate={rate}/></>}</section>
}
function Sales({title,rows=[],openReceipt,rate}){return <><h3>{title}</h3>{rows.length?<div className="pos-real-sales">{rows.map(sale=><button type="button" key={sale.id} onClick={()=>openReceipt(sale.id)}><ReceiptText/><span><b>{sale.sale_no}</b><small>{when(sale.sold_at)} · {sale.unit_count} dona</small></span><strong>{<DualPrice value={Number(sale.total||0)} rate={rate}/>}</strong><ChevronRight/></button>)}</div>:<Empty title="Savdolar yo‘q" text="Tasdiqlangan savdolar shu yerda ko‘rinadi."/>}</>}
function PendingDetail({sale,close,rate}){return <Modal open={Boolean(sale)} onClose={close} title={sale?.pending_no||'Kassa so‘rovi'}>{sale&&<div className="pos-real-pending-detail"><div className="between"><Status type={colors[sale.status]}>{labels[sale.status]||sale.status}</Status><small>{when(sale.created_at)}</small></div><p>Rezerv tugashi: <b>{when(sale.expires_at)}</b></p>{sale.rejection_reason&&<div className="pos-real-inline-error">Sabab: {sale.rejection_reason}</div>}<h3>Mahsulotlar</h3>{sale.lines?.map(line=><article key={line.id}><span><b>{line.product_name}</b><small>{line.sku} · {line.qr_code}</small></span><strong>{<DualPrice value={Number(line.line_total||0)} rate={rate}/>}</strong></article>)}<div className="pos-real-totals"><span>Chegirma<b>{<DualPrice value={Number(sale.discount||0)} rate={rate}/>}</b></span><span>Soliq<b>{<DualPrice value={Number(sale.tax||0)} rate={rate}/>}</b></span><strong>Jami<b>{<DualPrice value={Number(sale.total||0)} rate={rate}/>}</b></strong></div><h3>To‘lovlar</h3>{sale.payments?.map((payment,index)=><p key={index}>{payment.method_name}: <b>{<DualPrice value={Number(payment.amount||0)} rate={rate}/>}</b>{payment.external_reference?` · ${payment.external_reference}`:''}</p>)}</div>}</Modal>}
function Receipt({receipt,close,rate}){const[email,setEmail]=useState(''),[delivery,setDelivery]=useState(null),[busy,setBusy]=useState(false),[deliveryError,setDeliveryError]=useState(''),[idempotencyKey,setIdempotencyKey]=useState(()=>crypto.randomUUID());useEffect(()=>{let active=true;setEmail('');setDelivery(null);setDeliveryError('');setIdempotencyKey(crypto.randomUUID());if(receipt?.sale_id)getReceiptDeliveryStatus({saleId:receipt.sale_id}).then(value=>active&&setDelivery(value)).catch(error=>active&&setDeliveryError(msg(error)));return()=>{active=false}},[receipt?.sale_id]);useEffect(()=>{if(!delivery?.id||!['pending','processing'].includes(delivery.status))return;const timer=setInterval(()=>getReceiptDeliveryStatus({deliveryId:delivery.id}).then(setDelivery).catch(()=>{}),4000);return()=>clearInterval(timer)},[delivery?.id,delivery?.status]);const send=async()=>{if(!receipt?.sale_id||!email.trim())return;setBusy(true);setDeliveryError('');try{const key=delivery?.status==='dead'?crypto.randomUUID():idempotencyKey;if(key!==idempotencyKey)setIdempotencyKey(key);setDelivery(await queueSaleReceipt({saleId:receipt.sale_id,email:email.trim(),idempotencyKey:key}))}catch(error){setDeliveryError(msg(error))}finally{setBusy(false)}};const locked=['pending','processing','sent','ambiguous'].includes(delivery?.status);return <Modal open={Boolean(receipt)} onClose={close} title="Savdo cheki">{receipt&&<div className="pos-real-receipt"><header><h2>{receipt.branch_name}</h2><p>{address(receipt.branch_address)}{receipt.branch_phone?` · ${receipt.branch_phone}`:''}</p><b>{receipt.sale_no}</b><small>{when(receipt.sold_at)}</small></header><div><span>Sotuvchi <b>{receipt.seller_name}</b></span><span>Menejer <b>{receipt.manager_name||'—'}</b></span></div><section>{receipt.lines?.map((line,i)=><article key={`${line.sku}-${line.serial_number||i}`}><span><b>{line.product_name}</b><small>{line.sku}{line.serial_number?` · S/N: ${line.serial_number}`:''}</small></span><strong>{<DualPrice value={Number(line.line_total||0)} rate={rate}/>}</strong><small>Narx {<DualPrice value={Number(line.unit_price||0)} rate={rate}/>} · Chegirma {<DualPrice value={Number(line.discount||0)} rate={rate}/>} · Soliq {<DualPrice value={Number(line.tax||0)} rate={rate}/>}</small></article>)}</section><dl><div><dt>Subtotal</dt><dd>{<DualPrice value={Number(receipt.subtotal||0)} rate={rate}/>}</dd></div><div><dt>Chegirma</dt><dd>{<DualPrice value={Number(receipt.discount||0)} rate={rate}/>}</dd></div><div><dt>Soliq</dt><dd>{<DualPrice value={Number(receipt.tax||0)} rate={rate}/>}</dd></div><div><dt>Jami</dt><dd>{<DualPrice value={Number(receipt.total||0)} rate={rate}/>}</dd></div></dl><h3>To‘lovlar</h3>{receipt.payments?.map((p,i)=><p key={i}>{p.method_name}: <b>{<DualPrice value={Number(p.amount||0)} rate={rate}/>}</b></p>)}<div className="receipt-delivery"><h3><Mail/> Elektron chek</h3><label><input type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} disabled={locked} placeholder="mijoz@example.uz"/><button type="button" className="btn btn-primary" disabled={busy||locked||!email.trim()} onClick={send}><Send/>{busy?'Navbatga qo‘yilmoqda…':delivery?.status==='dead'?'Qayta urinish':'Emailga yuborish'}</button></label>{delivery&&<small className={`receipt-delivery-status ${delivery.status}`}>{delivery.message||delivery.status}{delivery.recipient_hint?` · ${delivery.recipient_hint}`:''}</small>}{deliveryError&&<div className="receipt-delivery-error">{deliveryError}</div>}</div><button type="button" className="btn btn-primary btn-block pos-real-no-print" onClick={()=>window.print()}><Printer/> Chop etish</button></div>}</Modal>}
