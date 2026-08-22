import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,ArrowLeftRight,BarChart3,Boxes,ChevronRight,CreditCard,ExternalLink,Home,Mail,MapPin,Package,Plus,Printer,QrCode,ReceiptText,Search,Send,ShoppingCart,Store,Trash2,User,Warehouse,X}from'lucide-react';
import{Empty,Modal,QrScanButton,Status,formatMoney}from'@texnobazar/ui';
import{createPosPendingSale,findPosUnit,getPosPendingSale,getPosReferences,getPosUnitContext,getReceiptDeliveryStatus,getSaleReceipt,listMyPosSales,listPosPendingSales,listPosUnits,queueSaleReceipt,relocatePosUnits}from'@texnobazar/data';
import ProfileWorkspace from'./ProfileWorkspace';

const msg=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const money=value=>formatMoney(Number(value||0));
const when=value=>value?new Date(value).toLocaleString('uz-UZ'):'—';
const address=value=>{if(!value)return'';if(typeof value==='string')return value;return[value.line1,value.line2,value.district,value.city,value.region,value.postal_code].filter(Boolean).join(', ')};
const labels={pending:'Kutilmoqda',confirmed:'Tasdiqlandi',rejected:'Rad etildi',expired:'Muddati tugadi'};
const colors={pending:'orange',confirmed:'green',rejected:'red',expired:'gray'};
const lineTax=line=>Math.round((Number(line.unit_price)-Number(line.discount||0))*Number(line.tax_rate||0))/100;
const lineTotal=line=>Number(line.unit_price)-Number(line.discount||0)+lineTax(line);
const STOREFRONT=(import.meta.env?.VITE_STOREFRONT_URL)||'https://texnobazar-storefront.netlify.app';

export default function PosWorkspace({branchId,profile,toast}){
  const[page,setPage]=useState('home'),[refs,setRefs]=useState(null),[units,setUnits]=useState([]),[sales,setSales]=useState({items:[],today:{}}),[pending,setPending]=useState({items:[]});
  const[cart,setCart]=useState([]),[query,setQuery]=useState(''),[debounced,setDebounced]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[receipt,setReceipt]=useState(null),[pendingDetail,setPendingDetail]=useState(null),[created,setCreated]=useState(null);
  const[relocateBatch,setRelocateBatch]=useState([]);
  const load=async()=>{if(!branchId){setLoading(false);return}setLoading(true);setError('');try{const[r,u,s,p]=await Promise.all([getPosReferences(branchId),listPosUnits({branchId,pageSize:30}),listMyPosSales({branchId,pageSize:20}),listPosPendingSales({branchId,pageSize:20})]);setRefs(r);setUnits(u.items||[]);setSales(s||{items:[],today:{}});setPending(p||{items:[]})}catch(e){setError(msg(e))}finally{setLoading(false)}};
  useEffect(()=>{load()},[branchId]);
  useEffect(()=>{const id=setTimeout(()=>setDebounced(query.trim()),300);return()=>clearTimeout(id)},[query]);
  useEffect(()=>{if(!branchId)return;let active=true;listPosUnits({branchId,query:debounced,pageSize:30}).then(r=>active&&setUnits(r.items||[])).catch(e=>active&&setError(msg(e)));return()=>{active=false}},[branchId,debounced]);
  const add=unit=>setCart(current=>{if(current.some(x=>x.id===unit.id)){toast?.('Bu mahsulot birligi savdoda mavjud');return current}toast?.('Mahsulot savdoga qo‘shildi');return[...current,{...unit,unit_price:Number(unit.retail_price),discount:0,tax_rate:Number(unit.tax_rate||0)}]});
  const addToRelocate=unit=>setRelocateBatch(current=>{if(current.some(x=>x.id===unit.id)){toast?.('Bu mahsulot birligi ro‘yxatda bor');return current}toast?.('Ko‘chirish ro‘yxatiga qo‘shildi');return[...current,unit]});
  const openReceipt=async id=>{try{setReceipt({...await getSaleReceipt(id),sale_id:id})}catch(e){setError(msg(e))}};
  const openPending=async id=>{try{setPendingDetail(await getPosPendingSale(id))}catch(e){setError(msg(e))}};
  return <><main className="pos-real-workspace">
    {loading?<State text="POS ma’lumotlari yuklanmoqda…"/>:error?<State error text={error} retry={load}/>:page==='home'?<HomePage sales={sales} pending={pending} profile={profile} openReceipt={openReceipt} openPending={openPending} go={setPage}/>:page==='scan'?<Scanner branchId={branchId} query={query} setQuery={setQuery} units={units} add={add} addToRelocate={addToRelocate} relocateCount={relocateBatch.length} goRelocate={()=>setPage('relocate')}/>:page==='cart'?<Cart branchId={branchId} cart={cart} setCart={setCart} refs={refs} created={created} setCreated={setCreated} refresh={load} toast={toast}/>:page==='relocate'?<Relocate branchId={branchId} batch={relocateBatch} setBatch={setRelocateBatch} toast={toast} back={()=>setPage('scan')}/>:page==='profile'?<ProfileWorkspace toast={toast}/>:<Kpi sales={sales} openReceipt={openReceipt}/>}
  </main><nav className="pos-real-nav">{[['home',Home,'Asosiy'],['scan',QrCode,'Skaner'],['cart',ShoppingCart,'Savdo'],['kpi',BarChart3,'KPI'],['profile',User,'Profil']].map(([key,Icon,text])=><button type="button" key={key} className={page===key?'active':''} onClick={()=>setPage(key)}><span><Icon/>{key==='cart'&&cart.length>0&&<i>{cart.length}</i>}</span>{text}</button>)}</nav>
  <PendingDetail sale={pendingDetail} close={()=>setPendingDetail(null)}/><Receipt receipt={receipt} close={()=>setReceipt(null)}/></>;
}

function State({text,error,retry}){return <div className={'pos-real-state '+(error?'error':'')}>{error&&<AlertTriangle/>}<p>{text}</p>{retry&&<button type="button" className="btn" onClick={retry}>Qayta urinish</button>}</div>}
function HomePage({sales,pending,profile,openReceipt,openPending,go}){const k=sales.today||{};return <section><div className="pos-real-title"><div><small>Bugungi natija</small><h2>{profile?.full_name?.split(' ')[0]||'Sotuvchi'}</h2></div><Status type="green">Real vaqt</Status></div><KpiCards kpi={k}/><button type="button" className="pos-real-scan-cta" onClick={()=>go('scan')}><QrCode/><span><b>QR/seriyani kiritish</b><small>Skaner qurilmasi yoki klaviatura orqali</small></span><ChevronRight/></button>{pending.items?.length>0&&<><h3>Kassadagi so‘rovlar</h3><div className="pos-real-pending">{pending.items.slice(0,4).map(x=><button type="button" key={x.id} onClick={()=>openPending(x.id)}><div><b>{x.pending_no}</b><small>{x.unit_count} dona · {when(x.expires_at)}</small></div><strong>{money(x.total)}</strong><Status type={colors[x.status]}>{labels[x.status]||x.status}</Status><ChevronRight/></button>)}</div></>}<Sales title="So‘nggi savdolar" rows={sales.items} openReceipt={openReceipt}/></section>}
function KpiCards({kpi}){return <div className="pos-real-kpis"><article><small>Savdo</small><b>{money(kpi.total)}</b></article><article><small>Cheklar</small><b>{Number(kpi.count||0)} ta</b></article><article><small>Foyda</small><b>{money(kpi.profit)}</b></article><article><small>O‘rtacha chek</small><b>{money(kpi.avg_check)}</b></article></div>}

// --- Scanner: looks up a unit via get_pos_unit_context (full pricing + stock context),
// shows a detail card the seller can act on (open storefront page, add to sale cart, or
// add to the store<->warehouse relocation batch). Falls back to the simple add-to-cart
// flow for units already in the list below.
function Scanner({branchId,query,setQuery,units,add,addToRelocate,relocateCount,goRelocate}){
  const[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[context,setContext]=useState(null);
  const lookup=async e=>{e?.preventDefault?.();if(!code.trim())return;setBusy(true);setError('');setContext(null);try{const result=await getPosUnitContext(branchId,code.trim());setContext(result);setCode('')}catch(e){setError(msg(e))}finally{setBusy(false)}};
  const addFromContext=()=>{if(!context)return;add({id:context.id,qr_code:context.qr_code,serial_number:context.serial_number,product_name:context.product_name,sku:context.sku,brand_name:context.brand_name,image:context.image,retail_price:context.prices.retail_price_uzs,minimum_sale_price:context.prices.minimum_sale_price_uzs,unit_cost:context.prices.unit_cost_uzs,tax_rate:context.prices.tax_rate,available_branch_count:context.branch_stock.store+context.branch_stock.warehouse});setContext(null)};
  const relocateFromContext=()=>{if(!context)return;addToRelocate({id:context.id,qr_code:context.qr_code,serial_number:context.serial_number,product_name:context.product_name,sku:context.sku,image:context.image,location_type:context.location_type});setContext(null)};
  return <section>
    <div className="pos-real-title"><div><h2>Skaner va qidiruv</h2><small>Sotish yoki joyini o‘zgartirish uchun mahsulotni skanerlang</small></div>{relocateCount>0&&<button type="button" className="btn btn-outline" onClick={goRelocate}><ArrowLeftRight size={15}/> {relocateCount} ta ko‘chirishga tayyor</button>}</div>
    <form className="pos-real-code" onSubmit={lookup}><QrCode/><input autoFocus value={code} onChange={e=>setCode(e.target.value)} placeholder="QR, seriya, shtrix-kod yoki SKU"/><QrScanButton onScan={v=>{setCode(v);lookup()}}/><button type="submit" disabled={busy}>{busy?'Izlanmoqda…':'Topish'}</button></form>
    {error&&<div className="pos-real-inline-error">{error}</div>}
    {context&&<UnitContextCard context={context} onAddToSale={addFromContext} onAddToRelocate={relocateFromContext} onClose={()=>setContext(null)}/>}
    <label className="pos-real-search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Mahsulot nomi yoki kodi bo‘yicha"/></label>
    <div className="pos-real-unit-list">{units.length?units.map(unit=><Unit key={unit.id} unit={unit} add={()=>add(unit)}/>):<Empty title="Mahsulot topilmadi" text="Qidiruvni o‘zgartiring yoki QR kodni aniq kiriting."/>}</div>
  </section>;
}

// Full detail card shown after a successful scan: pricing in UZS+USD, per-branch
// store/warehouse stock, stock in other branches, and a link to the storefront page.
function UnitContextCard({context,onAddToSale,onAddToRelocate,onClose}){
  const p=context.prices,stock=context.branch_stock;
  const canSell=context.location_type==='store';
  return <article className="pos-unit-context card">
    <button type="button" className="icon-btn pos-unit-context-close" onClick={onClose} aria-label="Yopish"><X size={16}/></button>
    <div className="pos-unit-context-head">
      {context.image?<img src={context.image} alt=""/>:<span className="pos-real-image"><Package/></span>}
      <div>
        <b>{context.product_name}</b>
        <small>{context.brand_name||'Brendsiz'} · {context.sku}</small>
        <small>QR: {context.qr_code}{context.serial_number?` · S/N: ${context.serial_number}`:''}</small>
        <Status type={context.location_type==='store'?'green':'blue'}>{context.location_type==='store'?'Do‘konda':'Omborda'}</Status>
      </div>
      {context.storefront_url&&<a className="btn btn-outline btn-sm pos-unit-context-link" href={STOREFRONT+context.storefront_url} target="_blank" rel="noopener"><ExternalLink size={13}/> Saytda ko‘rish</a>}
    </div>
    <div className="pos-unit-context-prices">
      <span><small>Sotish narxi</small><b>{money(p.retail_price_uzs)}</b>{p.retail_price_usd!=null&&<em>${p.retail_price_usd}</em>}</span>
      <span><small>Ulgurji narxi</small><b>{p.wholesale_price_uzs!=null?money(p.wholesale_price_uzs):'—'}</b>{p.wholesale_price_usd!=null&&<em>${p.wholesale_price_usd}</em>}</span>
      <span><small>Minimal narx</small><b>{money(p.minimum_sale_price_uzs)}</b>{p.minimum_sale_price_usd!=null&&<em>${p.minimum_sale_price_usd}</em>}</span>
    </div>
    <div className="pos-unit-context-stock">
      <span><Store size={15}/> Do‘konda: <b>{stock.store}</b> dona</span>
      <span><Warehouse size={15}/> Omborda: <b>{stock.warehouse}</b> dona</span>
    </div>
    {context.other_branches?.length>0&&<div className="pos-unit-context-branches">
      <small>Boshqa filiallarda mavjud:</small>
      <div>{context.other_branches.map(b=><span key={b.branch_id}><MapPin size={12}/>{b.branch_name}: <b>{b.quantity}</b></span>)}</div>
    </div>}
    <div className="pos-unit-context-actions">
      <button type="button" className="btn btn-primary" disabled={!canSell} onClick={onAddToSale}><ShoppingCart size={15}/> {canSell?'Savdoga qo‘shish':'Do‘konda emas'}</button>
      <button type="button" className="btn btn-outline" onClick={onAddToRelocate}><ArrowLeftRight size={15}/> Joyini o‘zgartirish</button>
    </div>
  </article>;
}

function Unit({unit,add}){return <article className="pos-real-unit">{unit.image?<img src={unit.image} alt=""/>:<span className="pos-real-image"><QrCode/></span>}<div><b>{unit.product_name}</b><small>{unit.brand_name||'Brendsiz'} · {unit.sku}</small><small>QR: {unit.qr_code}{unit.serial_number?` · S/N: ${unit.serial_number}`:''}</small><strong>{money(unit.retail_price)}</strong><em>Minimum: {money(unit.minimum_sale_price)} · Tannarx: {money(unit.unit_cost)}</em>{unit.latest_batch_retail&&Number(unit.latest_batch_retail)!==Number(unit.retail_price)&&<em style={{color:'#059669'}}>Yangi partiya narxi: {money(unit.latest_batch_retail)}</em>}<em>Filialda: {unit.available_branch_count} dona</em></div><button type="button" onClick={add} aria-label="Savdoga qo'shish"><Plus/></button></article>}

// --- Sale flow: cart + optional customer info + minimum-price warning (soft, not blocking).
function Cart({branchId,cart,setCart,refs,created,setCreated,refresh,toast}){
  const[payments,setPayments]=useState([]),[notes,setNotes]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[customer,setCustomer]=useState({full_name:'',phone:'',address:''}),[showCustomer,setShowCustomer]=useState(false);
  const total=useMemo(()=>cart.reduce((sum,line)=>sum+lineTotal(line),0),[cart]);
  const paid=payments.reduce((sum,p)=>sum+Number(p.amount||0),0);
  const methods=refs?.payment_methods||[];
  useEffect(()=>{if(!methods.length)return;setPayments(current=>current.length?current:[{method_code:(methods.find(x=>x.code==='cash')||methods[0]).code,amount:total?total.toFixed(2):'',external_reference:''}])},[methods.length]);
  useEffect(()=>setPayments(current=>current.length===1?[{...current[0],amount:total?total.toFixed(2):''}]:current),[total]);
  const editLine=(id,key,value)=>setCart(rows=>rows.map(row=>{if(row.id!==id)return row;const n=Math.max(0,Number(value||0));const percent=Number(refs?.discount_policy?.seller_max_line_discount_percent||20)/100;if(key==='unit_price'){const price=Math.min(Number(row.retail_price)*2,Math.max(0,n));const max=Math.max(0,Math.min(price*percent,price));return{...row,unit_price:price,discount:Math.min(Number(row.discount||0),max)}}const max=Math.max(0,Math.min(Number(row.unit_price)*percent,Number(row.unit_price)));return{...row,discount:Math.min(max,n)}}));
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
  if(created&&!cart.length)return <section><div className="pos-real-success"><ReceiptText/><h2>Kassaga yuborildi</h2><b>{created.pending_no}</b><Status type={colors[created.status]}>{labels[created.status]||created.status}</Status><p>Rezerv tugashi: {when(created.expires_at)}</p><strong>{money(created.total)}</strong><button type="button" className="btn btn-primary" onClick={()=>setCreated(null)}>Yangi savdo</button></div></section>;
  return <section>
    <div className="pos-real-title"><div><h2>Joriy savdo</h2><small>{cart.length} ta noyob mahsulot birligi</small></div></div>
    {!cart.length?<Empty title="Savdo bo‘sh" text="Skaner yoki qidiruvdan mahsulot birligini qo‘shing."/>:<form onSubmit={submit}>
      <div className="pos-real-cart">{cart.map(line=>{
        const currentTotal=lineTotal(line)-lineTax(line);
        const isBelowMinimum=currentTotal<Number(line.minimum_sale_price||0);
        return <article key={line.id}>
          <div className="pos-real-cart-head"><div><b>{line.product_name}</b><small>{line.qr_code}{line.serial_number?` · ${line.serial_number}`:''}</small></div><button type="button" onClick={()=>setCart(x=>x.filter(y=>y.id!==line.id))}><Trash2/></button></div>
          <div className="pos-real-line-grid">
            <label>Sotuv narxi<input type="number" min="0" max={Number(line.retail_price)*2} step="0.01" value={line.unit_price} onChange={e=>editLine(line.id,'unit_price',e.target.value)}/></label>
            <label>Chegirma<input type="number" min="0" step="0.01" value={line.discount} onChange={e=>editLine(line.id,'discount',e.target.value)}/></label>
          </div>
          {isBelowMinimum&&<div className="pos-real-warning"><AlertTriangle size={14}/> Narx minimal sotish summasidan past ({money(line.minimum_sale_price)}). Sotish mumkin, ammo menejer bunga e’tibor beradi.</div>}
          <div className="pos-real-prices"><span>Retail <b>{money(line.retail_price)}</b></span><span>Minimum <b>{money(line.minimum_sale_price)}</b></span><span>Tannarx <b>{money(line.unit_cost)}</b></span><span>Tax ({Number(line.tax_rate||0)}%) <b>{money(lineTax(line))}</b></span><span>Taxminiy foyda <b>{money(lineTotal(line)-lineTax(line)-Number(line.unit_cost))}</b></span><span>Filialda <b>{line.available_branch_count} dona</b></span></div>
        </article>;
      })}</div>
      <div className="pos-real-totals"><span>Narxlar − chegirma<b>{money(cart.reduce((s,x)=>s+Number(x.unit_price)-Number(x.discount||0),0))}</b></span><span>Soliq<b>{money(cart.reduce((s,x)=>s+lineTax(x),0))}</b></span><strong>Jami<b>{money(total)}</b></strong></div>
      <div className="pos-real-customer">
        <button type="button" className="between pos-real-customer-toggle" onClick={()=>setShowCustomer(v=>!v)}><span><User size={15}/> Mijoz ma’lumotlari (ixtiyoriy)</span><ChevronRight style={{transform:showCustomer?'rotate(90deg)':'none'}}/></button>
        {showCustomer&&<div className="pos-real-customer-fields">
          <label>Mijoz ismi<input className="input" value={customer.full_name} onChange={e=>setCustomer(c=>({...c,full_name:e.target.value}))} placeholder="Ixtiyoriy"/></label>
          <label>Telefon raqami<input className="input" type="tel" value={customer.phone} onChange={e=>setCustomer(c=>({...c,phone:e.target.value}))} placeholder="+998 90 123 45 67"/></label>
          <label>Manzil<input className="input" value={customer.address} onChange={e=>setCustomer(c=>({...c,address:e.target.value}))} placeholder="Ixtiyoriy"/></label>
        </div>}
      </div>
      <div className="pos-real-payment"><div className="between"><h3>To‘lov taqsimoti</h3><button type="button" onClick={addPayment}><Plus/> Qator</button></div>{payments.map((p,i)=><div className="pos-real-payment-row" key={i}><select value={p.method_code} onChange={e=>setPayments(x=>x.map((v,n)=>n===i?{...v,method_code:e.target.value}:v))}>{methods.map(m=><option key={m.code} value={m.code}>{m.name}</option>)}</select><input aria-label="Summa" type="number" min="0.01" step="0.01" value={p.amount} onChange={e=>setPayments(x=>x.map((v,n)=>n===i?{...v,amount:e.target.value}:v))}/><input aria-label="Havola" value={p.external_reference} onChange={e=>setPayments(x=>x.map((v,n)=>n===i?{...v,external_reference:e.target.value}:v))} placeholder="Havola (ixtiyoriy)"/><button type="button" disabled={payments.length===1} onClick={()=>setPayments(x=>x.filter((_,n)=>n!==i))}><X/></button></div>)}<small>To‘lovlar: {money(paid)} / {money(total)}</small></div>
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

function Kpi({sales,openReceipt}){return <section><div className="pos-real-title"><div><h2>Bugungi KPI</h2><small>Filial vaqt mintaqasi bo‘yicha</small></div></div><KpiCards kpi={sales.today||{}}/><div className="pos-real-kpi-wide"><span>Berilgan chegirma<b>{money(sales.today?.discount)}</b></span><span>Sof foyda<b>{money(sales.today?.profit)}</b></span></div><Sales title="Tasdiqlangan savdolar" rows={sales.items} openReceipt={openReceipt}/></section>}
function Sales({title,rows=[],openReceipt}){return <><h3>{title}</h3>{rows.length?<div className="pos-real-sales">{rows.map(sale=><button type="button" key={sale.id} onClick={()=>openReceipt(sale.id)}><ReceiptText/><span><b>{sale.sale_no}</b><small>{when(sale.sold_at)} · {sale.unit_count} dona</small></span><strong>{money(sale.total)}</strong><ChevronRight/></button>)}</div>:<Empty title="Savdolar yo‘q" text="Tasdiqlangan savdolar shu yerda ko‘rinadi."/>}</>}
function PendingDetail({sale,close}){return <Modal open={Boolean(sale)} onClose={close} title={sale?.pending_no||'Kassa so‘rovi'}>{sale&&<div className="pos-real-pending-detail"><div className="between"><Status type={colors[sale.status]}>{labels[sale.status]||sale.status}</Status><small>{when(sale.created_at)}</small></div><p>Rezerv tugashi: <b>{when(sale.expires_at)}</b></p>{sale.rejection_reason&&<div className="pos-real-inline-error">Sabab: {sale.rejection_reason}</div>}<h3>Mahsulotlar</h3>{sale.lines?.map(line=><article key={line.id}><span><b>{line.product_name}</b><small>{line.sku} · {line.qr_code}</small></span><strong>{money(line.line_total)}</strong></article>)}<div className="pos-real-totals"><span>Chegirma<b>{money(sale.discount)}</b></span><span>Soliq<b>{money(sale.tax)}</b></span><strong>Jami<b>{money(sale.total)}</b></strong></div><h3>To‘lovlar</h3>{sale.payments?.map((payment,index)=><p key={index}>{payment.method_name}: <b>{money(payment.amount)}</b>{payment.external_reference?` · ${payment.external_reference}`:''}</p>)}</div>}</Modal>}
function Receipt({receipt,close}){const[email,setEmail]=useState(''),[delivery,setDelivery]=useState(null),[busy,setBusy]=useState(false),[deliveryError,setDeliveryError]=useState(''),[idempotencyKey,setIdempotencyKey]=useState(()=>crypto.randomUUID());useEffect(()=>{let active=true;setEmail('');setDelivery(null);setDeliveryError('');setIdempotencyKey(crypto.randomUUID());if(receipt?.sale_id)getReceiptDeliveryStatus({saleId:receipt.sale_id}).then(value=>active&&setDelivery(value)).catch(error=>active&&setDeliveryError(msg(error)));return()=>{active=false}},[receipt?.sale_id]);useEffect(()=>{if(!delivery?.id||!['pending','processing'].includes(delivery.status))return;const timer=setInterval(()=>getReceiptDeliveryStatus({deliveryId:delivery.id}).then(setDelivery).catch(()=>{}),4000);return()=>clearInterval(timer)},[delivery?.id,delivery?.status]);const send=async()=>{if(!receipt?.sale_id||!email.trim())return;setBusy(true);setDeliveryError('');try{const key=delivery?.status==='dead'?crypto.randomUUID():idempotencyKey;if(key!==idempotencyKey)setIdempotencyKey(key);setDelivery(await queueSaleReceipt({saleId:receipt.sale_id,email:email.trim(),idempotencyKey:key}))}catch(error){setDeliveryError(msg(error))}finally{setBusy(false)}};const locked=['pending','processing','sent','ambiguous'].includes(delivery?.status);return <Modal open={Boolean(receipt)} onClose={close} title="Savdo cheki">{receipt&&<div className="pos-real-receipt"><header><h2>{receipt.branch_name}</h2><p>{address(receipt.branch_address)}{receipt.branch_phone?` · ${receipt.branch_phone}`:''}</p><b>{receipt.sale_no}</b><small>{when(receipt.sold_at)}</small></header><div><span>Sotuvchi <b>{receipt.seller_name}</b></span><span>Menejer <b>{receipt.manager_name||'—'}</b></span></div><section>{receipt.lines?.map((line,i)=><article key={`${line.sku}-${line.serial_number||i}`}><span><b>{line.product_name}</b><small>{line.sku}{line.serial_number?` · S/N: ${line.serial_number}`:''}</small></span><strong>{money(line.line_total)}</strong><small>Narx {money(line.unit_price)} · Chegirma {money(line.discount)} · Soliq {money(line.tax)}</small></article>)}</section><dl><div><dt>Subtotal</dt><dd>{money(receipt.subtotal)}</dd></div><div><dt>Chegirma</dt><dd>{money(receipt.discount)}</dd></div><div><dt>Soliq</dt><dd>{money(receipt.tax)}</dd></div><div><dt>Jami</dt><dd>{money(receipt.total)}</dd></div></dl><h3>To‘lovlar</h3>{receipt.payments?.map((p,i)=><p key={i}>{p.method_name}: <b>{money(p.amount)}</b></p>)}<div className="receipt-delivery"><h3><Mail/> Elektron chek</h3><label><input type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} disabled={locked} placeholder="mijoz@example.uz"/><button type="button" className="btn btn-primary" disabled={busy||locked||!email.trim()} onClick={send}><Send/>{busy?'Navbatga qo‘yilmoqda…':delivery?.status==='dead'?'Qayta urinish':'Emailga yuborish'}</button></label>{delivery&&<small className={`receipt-delivery-status ${delivery.status}`}>{delivery.message||delivery.status}{delivery.recipient_hint?` · ${delivery.recipient_hint}`:''}</small>}{deliveryError&&<div className="receipt-delivery-error">{deliveryError}</div>}</div><button type="button" className="btn btn-primary btn-block pos-real-no-print" onClick={()=>window.print()}><Printer/> Chop etish</button></div>}</Modal>}
