import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,ArrowLeftRight,BadgeCheck,Boxes,CalendarDays,CheckCircle2,ChevronRight,History,MapPin,QrCode,Receipt,RotateCcw,ShieldAlert,ShoppingBag,User}from'lucide-react';
import{Empty,Modal,QrScanButton,Status,formatMoney}from'@texnobazar/ui';
import{RETURN_CONDITIONS,approveSaleReturn,cancelSaleReturn,completeSaleReturn,executeSaleExchange,executeSaleReturn,findSaleReturnUnit,getExchangeQuote,getInventoryReferences,getUnitLifecycle,listProviderRefunds,listSaleReturnHistory,listSaleReturns}from'@texnobazar/data';

const message=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const money=value=>formatMoney(Number(value||0));
const stamp=value=>value?new Date(value).toLocaleString('uz-UZ',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>`${today().slice(0,7)}-01`;
const statusLabels={requested:'So‘ralgan',approved:'Tasdiqlangan',completed:'Yakunlangan',rejected:'Rad etilgan',cancelled:'Bekor qilingan'};
const statusColors={requested:'blue',approved:'orange',completed:'green',rejected:'red',cancelled:'red'};
const conditionLabel=code=>RETURN_CONDITIONS.find(([key])=>key===code)?.[1]||code||'—';

export default function ReturnsWorkspace({branchId,toast}){
  const[tab,setTab]=useState('accept');
  const[historyKey,setHistoryKey]=useState(0);
  const[lifecycleCode,setLifecycleCode]=useState('');
  if(!branchId)return <div className="rt-state rt-error"><AlertTriangle/><b>Filial tanlanmagan</b><p>Qaytarish uchun filial tanlang.</p></div>;
  return <section className="rt-workspace">
    <div className="m-page-head">
      <h2>Qaytarib olish</h2>
      <p>QR yoki seriyani skanerlang — tizim tovar shu do‘konda sotilganini tekshiradi, tasdiqlagach birlik qoldiqqa qaytadi.</p>
    </div>
    <div className="rt-tabs">
      <button className={tab==='accept'?'active':''} onClick={()=>setTab('accept')}>Qaytarib olish</button>
      <button className={tab==='history'?'active':''} onClick={()=>setTab('history')}>Tarix</button>
      <button className={tab==='requests'?'active':''} onClick={()=>setTab('requests')}>So‘rovlar va almashtirish</button>
    </div>
    {tab==='accept'
      ?<AcceptReturn branchId={branchId} toast={toast} openLifecycle={setLifecycleCode}
        done={()=>{setHistoryKey(x=>x+1);setTab('history');}}/>
      :tab==='history'
      ?<ReturnHistory branchId={branchId} refreshKey={historyKey} openLifecycle={setLifecycleCode}/>
      :<ReturnRequests branchId={branchId} toast={toast} onChange={()=>setHistoryKey(x=>x+1)}/>}
    <LifecycleModal code={lifecycleCode} close={()=>setLifecycleCode('')}/>
  </section>;
}

function AcceptReturn({branchId,toast,done,openLifecycle}){
  const[code,setCode]=useState('');
  const[found,setFound]=useState(null);
  const[refs,setRefs]=useState({locations:[]});
  const[condition,setCondition]=useState('resellable');
  const[reason,setReason]=useState('');
  const[refund,setRefund]=useState('');
  const[locationId,setLocationId]=useState('');
  const[confirmed,setConfirmed]=useState(false);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[lookupError,setLookupError]=useState('');

  useEffect(()=>{getInventoryReferences(branchId).then(setRefs).catch(e=>setError(message(e)));},[branchId]);

  const reset=()=>{setFound(null);setCondition('resellable');setReason('');setRefund('');setConfirmed(false);setError('');};

  const lookup=async e=>{
    e.preventDefault();
    const value=code.trim();
    if(!value)return;
    setBusy(true);setLookupError('');reset();
    try{
      const result=await findSaleReturnUnit(branchId,value);
      setFound(result);
      setRefund(String(result?.sale_line?.max_refund??''));
      setLocationId(result?.default_resell_location_id||refs.locations?.[0]?.id||'');
    }catch(e){setLookupError(message(e));}
    finally{setBusy(false);}
  };

  const submit=async e=>{
    e.preventDefault();
    setError('');
    if(!found?.eligible)return;
    if(!confirmed){setError('Tovar shu do‘konda sotilganini tasdiqlang.');return;}
    if(reason.trim().length<3){setError('Qaytarish sababi kamida 3 belgidan iborat bo‘lishi kerak.');return;}
    const amount=Number(refund);
    const max=Number(found.sale_line?.max_refund||0);
    if(!Number.isFinite(amount)||amount<0||amount>max){setError(`Qaytarish summasi 0 va ${money(max)} orasida bo‘lishi kerak.`);return;}
    if(!window.confirm(`${found.product?.name} qaytarib olinadi.${condition==='resellable'?' Birlik qoldiqqa qaytadi.':' Birlik hisobdan chiqariladi.'} Mijozga ${money(amount)} qaytariladi. Davom etasizmi?`))return;
    setBusy(true);
    try{
      const result=await executeSaleReturn({branchId,unitId:found.unit.id,condition,reason:reason.trim(),
        refundAmount:amount,resellLocationId:locationId});
      setCode('');reset();
      toast?.(`${result?.return_no||'Qaytarish'} yakunlandi — ${result?.restocked?'birlik qoldiqqa qaytdi':'birlik hisobdan chiqarildi'} (${money(amount)})`);
      done?.();
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  };

  const sale=found?.sale,line=found?.sale_line,unit=found?.unit,product=found?.product,stamps=found?.stamps;

  return <div className="rt-accept">
    <form className="card rt-scan" onSubmit={lookup}>
      <h3>1. Tovarni skanerlang yoki kodini kiriting</h3>
      <div className="rt-scan-row">
        <QrCode/>
        <input className="input" value={code} onChange={e=>setCode(e.target.value)} autoFocus
          placeholder="QR yoki seriya raqami"/>
        <QrScanButton onScan={v=>setCode(v)}/>
        <button className="btn btn-primary" disabled={busy||!code.trim()}>{busy?'Tekshirilmoqda…':'Tekshirish'}</button>
        {code&&<button type="button" className="btn" onClick={()=>{setCode('');reset();setLookupError('');}}>Tozalash</button>}
      </div>
      {lookupError&&<InlineError text={lookupError}/>}
      {!found&&!lookupError&&<p className="rt-hint">Tizim birlikni topib, qaysi chek bilan, kim tomonidan va qancha narxda sotilganini ko‘rsatadi.</p>}
    </form>

    {found&&<>
      <div className={'card rt-verify '+(found.eligible?'ok':'bad')}>
        <div className="rt-verify-head">
          {found.eligible?<CheckCircle2/>:<ShieldAlert/>}
          <div>
            <b>{found.eligible?'Sotuv tasdiqlandi — qaytarish mumkin':'Qaytarish mumkin emas'}</b>
            <small>{found.eligible
              ?'Bu birlik shu filialda sotilgan va hozircha qaytarilmagan.'
              :found.reason}</small>
          </div>
          <button type="button" className="btn" onClick={()=>openLifecycle(unit.qr_code)}><History/>Hayot sikli</button>
        </div>

        <div className="rt-unit">
          {product?.image?<img src={product.image} alt=""/>:<span className="rt-thumb"><Boxes/></span>}
          <div className="rt-unit-info">
            <b>{product?.name}</b>
            <small>{product?.sku}{product?.brand_name?` · ${product.brand_name}`:''}</small>
            <small><code>{unit?.qr_code}</code>{unit?.serial_number?` · S/N: ${unit.serial_number}`:''}</small>
            <small><MapPin/>{unit?.location_name} · <Status type={unit?.status==='sold'?'green':'gray'}>{unit?.status_label}</Status></small>
          </div>
          <div className="rt-prices">
            <span><small>Tannarx</small><b>{money(found.unit_cost)}</b></span>
            <span><small>Sotilgan narx</small><b>{money(line?.line_total??product?.retail_price)}</b></span>
          </div>
        </div>

        {sale?<div className="rt-proof">
          <h4><Receipt/>Sotuv isboti</h4>
          <div className="rt-proof-grid">
            <span><small>Chek</small><b>{sale.sale_no}</b></span>
            <span><small>Sotilgan vaqti</small><b>{stamp(sale.sold_at)}</b></span>
            <span><small>Filial</small><b>{sale.branch_name||'—'}</b></span>
            <span><small>Sotuvchi</small><b>{sale.seller_name||'—'}</b></span>
            <span><small>Mijoz</small><b>{sale.customer_name||'Ko‘rsatilmagan'}</b></span>
            <span><small>Telefon</small><b>{sale.customer_phone||'—'}</b></span>
            <span><small>To‘lov usuli</small><b>{(sale.payment_methods||[]).join(', ')||'—'}</b></span>
            <span><small>Chek summasi</small><b>{money(sale.total)}</b></span>
          </div>
        </div>:<p className="rt-hint">Bu birlik uchun sotuv tarixi topilmadi.</p>}

        {(stamps?.sold_count>0||stamps?.returned_count>0)&&<div className="rt-stamps">
          {stamps.sold_count>0&&<span className="rt-stamp sold"><ShoppingBag/>Sotilgan · {stamps.sold_count} marta<small>{stamp(stamps.last_sold_at)}</small></span>}
          {stamps.returned_count>0&&<span className="rt-stamp returned"><RotateCcw/>Qaytarilgan · {stamps.returned_count} marta<small>{stamp(stamps.last_returned_at)}</small></span>}
        </div>}

        {found.warning&&<div className="rt-warning"><AlertTriangle/><span>{found.warning}</span></div>}
        {found.pending_return&&<div className="rt-warning"><AlertTriangle/><span>
          Mavjud so‘rov: {found.pending_return.return_no} ({statusLabels[found.pending_return.status]||found.pending_return.status}) — “So‘rovlar” bo‘limida yakunlang.
        </span></div>}

        {(found.previous_returns||[]).length>0&&<div className="rt-previous">
          <h4>Oldingi qaytarishlar</h4>
          {found.previous_returns.map((row,index)=><div key={`${row.return_no}-${index}`}>
            <RotateCcw/>
            <span><b>{row.return_no}</b><small>{row.sale_no} · {row.condition_label||conditionLabel(row.condition)}</small></span>
            <em>{stamp(row.completed_at||row.created_at)}</em>
            <strong>{money(row.refund_amount)}</strong>
          </div>)}
        </div>}
      </div>

      {found.eligible&&<form className="card rt-confirm" onSubmit={submit}>
        <h3>2. Menejer tasdiqi</h3>
        <label className="rt-check">
          <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
          <span><BadgeCheck/>Bu tovar haqiqatda shu do‘konda sotilganini va qaytarilishi mumkinligini tasdiqlayman</span>
        </label>
        <div className="rt-form-grid">
          <label>
            <span>Tovar holati</span>
            <select className="select" value={condition} onChange={e=>setCondition(e.target.value)}>
              {RETURN_CONDITIONS.map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Mijozga qaytariladigan summa</span>
            <input className="input" type="number" min="0" step="0.01" max={line?.max_refund} value={refund}
              onChange={e=>setRefund(e.target.value)} required/>
          </label>
          <label className="wide">
            <span>Qaytariladigan joy {condition!=='resellable'&&'(faqat qayta sotiladigan holat uchun ishlatiladi)'}</span>
            <select className="select" value={locationId} onChange={e=>setLocationId(e.target.value)}>
              {refs.locations?.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="wide">
            <span>Sabab (majburiy)</span>
            <textarea className="textarea" value={reason} onChange={e=>setReason(e.target.value)} required minLength={3}
              placeholder="Masalan: mijozga o‘lcham to‘g‘ri kelmadi"/>
          </label>
        </div>
        <div className={'rt-outcome '+(condition==='resellable'?'ok':'warn')}>
          {condition==='resellable'
            ?<><Boxes/><span><b>Birlik qoldiqqa qaytadi</b><small>Tannarx {money(found.unit_cost)} va sotilish narxi {money(line?.line_total)} tiklanadi, tovar qayta sotuvga tayyor bo‘ladi.</small></span></>
            :<><AlertTriangle/><span><b>Birlik hisobdan chiqariladi</b><small>Shikastlangan/nuqsonli tovar qoldiqqa qaytmaydi, hisobdan chiqarilgan fondga o‘tadi.</small></span></>}
        </div>
        {error&&<InlineError text={error}/>}
        <button className="btn btn-primary btn-block" disabled={busy||!confirmed||reason.trim().length<3}>
          {busy?'Bajarilmoqda…':'Qaytarib olishni tasdiqlash'}
        </button>
      </form>}
    </>}
  </div>;
}

function ReturnHistory({branchId,refreshKey,openLifecycle}){
  const[data,setData]=useState(null);
  const[filters,setFilters]=useState({from:monthStart(),to:today(),query:'',condition:'',status:''});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');

  const load=async()=>{
    setLoading(true);setError('');
    try{
      setData(await listSaleReturnHistory({branchId,from:filters.from||null,to:filters.to||null,
        query:filters.query||'',condition:filters.condition||null,status:filters.status||null,pageSize:200}));
    }catch(e){setError(message(e));}
    finally{setLoading(false);}
  };

  useEffect(()=>{
    const timer=setTimeout(load,filters.query?300:0);
    return()=>clearTimeout(timer);
  },[branchId,refreshKey,filters.from,filters.to,filters.query,filters.condition,filters.status]);

  const items=data?.items||[];
  const set=(key,value)=>setFilters(current=>({...current,[key]:value}));

  return <div className="rt-history">
    <div className="rt-stats">
      <div className="rt-stat"><span>Tanlangan davr</span><b>{money(data?.refund_total)}</b><small>{Number(data?.total||0)} dona · {Number(data?.document_count||0)} hujjat</small></div>
      <div className="rt-stat cost"><span>Qaytgan tannarx</span><b>{money(data?.cost_total)}</b><small>Qoldiqqa tiklangan qiymat</small></div>
      <div className="rt-stat month"><span>Joriy oy refundi</span><b>{money(data?.month_refund)}</b><small>{Number(data?.month_units||0)} dona</small></div>
    </div>

    {(data?.by_condition||[]).length>0&&<div className="rt-condition-summary">
      {data.by_condition.map(row=><span key={row.condition}>
        <small>{row.label||conditionLabel(row.condition)}</small>
        <b>{money(row.refund)}</b>
        <em>{Number(row.units||0)} dona · tannarx {money(row.cost)}</em>
      </span>)}
    </div>}

    <div className="rt-filters">
      <label><span>Dan</span><input className="input" type="date" value={filters.from} onChange={e=>set('from',e.target.value)}/></label>
      <label><span>Gacha</span><input className="input" type="date" value={filters.to} onChange={e=>set('to',e.target.value)}/></label>
      <label><span>Holat</span>
        <select className="select" value={filters.condition} onChange={e=>set('condition',e.target.value)}>
          <option value="">Barchasi</option>
          {RETURN_CONDITIONS.map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label><span>Status</span>
        <select className="select" value={filters.status} onChange={e=>set('status',e.target.value)}>
          <option value="">Barchasi</option>
          {Object.entries(statusLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label className="rt-filter-search"><span>Qidiruv / QR</span>
        <input className="input" value={filters.query} onChange={e=>set('query',e.target.value)}
          placeholder="Tovar, SKU, QR, seriya, chek, mijoz yoki sabab"/>
      </label>
    </div>

    {loading?<div className="rt-state">Tarix yuklanmoqda…</div>
      :error?<div className="rt-state rt-error"><AlertTriangle/><b>Xatolik</b><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>
      :items.length===0?<Empty title="Yozuv topilmadi" text="Tanlangan davr yoki filtr bo‘yicha qaytarilgan tovar yo‘q."/>
      :<>
        <div className="rt-table-wrap">
          <table className="table rt-table">
            <thead><tr>
              <th>Qaytarilgan vaqti</th><th>Tovar</th><th>QR / seriya</th><th>Holat</th>
              <th>Sotuv</th><th>Tannarx</th><th className="right">Refund</th><th/>
            </tr></thead>
            <tbody>
              {items.map(row=><tr key={row.line_id}>
                <td><b>{stamp(row.occurred_at)}</b><small>{row.return_no}</small>
                  <Status type={statusColors[row.status]}>{statusLabels[row.status]||row.status}</Status></td>
                <td><b>{row.product_name}</b><small>{row.sku}</small>
                  {row.restock_location_name&&<small><MapPin/>{row.restock_location_name}</small>}</td>
                <td><code>{row.qr_code||'—'}</code>{row.serial_number&&<small>S/N: {row.serial_number}</small>}</td>
                <td><span className={'rt-chip '+row.condition}>{row.condition_label||conditionLabel(row.condition)}</span></td>
                <td><b>{row.sale_no}</b><small>{stamp(row.sold_at)}</small>
                  {row.seller_name&&<small><User/>{row.seller_name}</small>}</td>
                <td>{money(row.unit_cost)}<small>narx {money(row.line_total)}</small></td>
                <td className="right"><strong>{money(row.refund_amount)}</strong></td>
                <td><button className="btn rt-icon-btn" onClick={()=>openLifecycle(row.qr_code)} aria-label="Hayot sikli"><History/></button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="rt-cards">
          {items.map(row=><article className="card rt-history-card" key={row.line_id}>
            <div className="rt-card-icon"><RotateCcw/></div>
            <div className="rt-card-main">
              <div className="between"><b>{row.product_name}</b><strong>{money(row.refund_amount)}</strong></div>
              <small>{row.sku} · QR: {row.qr_code||'—'}</small>
              <div className="rt-card-meta">
                <span><CalendarDays/>{stamp(row.occurred_at)}</span>
                <span className={'rt-chip '+row.condition}>{row.condition_label||conditionLabel(row.condition)}</span>
              </div>
              <small>{row.return_no} · Sotuv {row.sale_no} · Tannarx {money(row.unit_cost)}</small>
              <button className="btn btn-block" onClick={()=>openLifecycle(row.qr_code)}><History/>Hayot sikli</button>
            </div>
          </article>)}
        </div>
      </>}
  </div>;
}

function LifecycleModal({code,close}){
  const[data,setData]=useState(null);
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState('');

  useEffect(()=>{
    if(!code){setData(null);setError('');return;}
    let alive=true;
    setLoading(true);setError('');
    getUnitLifecycle(code).then(result=>{if(alive)setData(result);})
      .catch(e=>{if(alive)setError(message(e));})
      .finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[code]);

  const stamps=data?.stamps;
  return <Modal open={Boolean(code)} onClose={close} title={data?.product?.name||'Birlik hayot sikli'}>
    {loading?<div className="rt-state">Yuklanmoqda…</div>
      :error?<InlineError text={error}/>
      :data&&<div className="rt-lifecycle">
        <div className="rt-unit">
          {data.product?.image?<img src={data.product.image} alt=""/>:<span className="rt-thumb"><Boxes/></span>}
          <div className="rt-unit-info">
            <b>{data.product?.name}</b>
            <small>{data.product?.sku}</small>
            <small><code>{data.unit?.qr_code}</code>{data.unit?.serial_number?` · S/N: ${data.unit.serial_number}`:''}</small>
            <small><MapPin/>{data.unit?.location_name} · {data.unit?.branch_name||'—'}</small>
          </div>
        </div>

        <div className="rt-stamps">
          {stamps?.was_sold&&<span className="rt-stamp sold"><ShoppingBag/>Sotilgan · {stamps.sold_count} marta<small>{stamp(stamps.last_sold_at)}</small></span>}
          {stamps?.was_returned&&<span className="rt-stamp returned"><RotateCcw/>Qaytarilgan · {stamps.returned_count} marta<small>{stamp(stamps.last_returned_at)}</small></span>}
          {stamps?.was_written_off&&<span className="rt-stamp writeoff"><AlertTriangle/>Hisobdan chiqarilgan</span>}
          {!stamps?.was_sold&&!stamps?.was_returned&&<span className="rt-stamp">Hali sotilmagan</span>}
        </div>

        {(data.sales||[]).length>0&&<div className="rt-lifecycle-block">
          <h4><ShoppingBag/>Sotuvlar</h4>
          {data.sales.map(row=><div className="rt-lifecycle-row" key={row.sale_id}>
            <span><b>{row.sale_no}</b><small>{stamp(row.sold_at)} · {row.branch_name}</small>
              <small>{row.seller_name||'—'}{row.customer_name?` → ${row.customer_name}`:''}</small></span>
            <em>{row.returned?<Status type="orange">Qaytarilgan</Status>:<Status type="green">Sotilgan</Status>}</em>
            <strong>{money(row.line_total)}<small>tannarx {money(row.unit_cost)}</small></strong>
          </div>)}
        </div>}

        {(data.returns||[]).length>0&&<div className="rt-lifecycle-block">
          <h4><RotateCcw/>Qaytarishlar</h4>
          {data.returns.map(row=><div className="rt-lifecycle-row" key={row.return_id}>
            <span><b>{row.return_no}</b><small>{stamp(row.completed_at||row.created_at)} · {row.condition_label}</small>
              <small>{row.reason}</small></span>
            <em><Status type={statusColors[row.status]}>{statusLabels[row.status]||row.status}</Status></em>
            <strong>{money(row.refund_amount)}</strong>
          </div>)}
        </div>}

        <div className="rt-lifecycle-block">
          <h4><History/>Harakatlar tarixi</h4>
          <div className="rt-timeline">
            {(data.movements||[]).map(row=><div className={'rt-timeline-row '+row.type} key={row.id}>
              <i/>
              <span><b>{row.label}</b><small>{stamp(row.occurred_at)}</small>
                <small>{[row.from_location,row.to_location].filter(Boolean).join(' → ')||'—'}</small>
                {row.reason&&<small>{row.reason}</small>}</span>
              <em>{row.actor_name||'—'}</em>
            </div>)}
            {(data.movements||[]).length===0&&<p className="rt-hint">Harakat yozuvi yo‘q.</p>}
          </div>
        </div>
      </div>}
  </Modal>;
}

function ReturnRequests({branchId,toast,onChange}){
  const[refs,setRefs]=useState({locations:[]});
  const[rows,setRows]=useState([]);
  const[detail,setDetail]=useState(null);
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');

  const load=async focusId=>{
    setLoading(true);setError('');
    try{
      const[reference,returns]=await Promise.all([getInventoryReferences(branchId),listSaleReturns({branchId})]);
      const refundResult=await Promise.allSettled([listProviderRefunds(branchId)]);
      const refunds=refundResult[0].status==='fulfilled'?refundResult[0].value:[];
      const enriched=(returns||[]).map(row=>({...row,provider_refunds:(refunds||[]).filter(x=>x.return_id===row.id)}));
      setRefs(reference);setRows(enriched);
      if(focusId)setDetail(enriched.find(x=>x.id===focusId)||null);
    }catch(e){setError(message(e));}
    finally{setLoading(false);}
  };
  useEffect(()=>{load();},[branchId]);

  const open=useMemo(()=>rows.filter(x=>['requested','approved'].includes(x.status)),[rows]);

  const action=async(type,options={})=>{
    if(!detail)return;
    if(!window.confirm(type==='complete'?'Qaytarilgan birliklar holati o‘zgaradi. Yakunlaysizmi?':type==='approve'?'Qaytarishni tasdiqlaysizmi?':'Qaytarishni bekor qilasizmi?'))return;
    let reason='';
    if(type==='cancel'){reason=window.prompt('Bekor qilish sababi:','')||'';if(!reason.trim())return;}
    setBusy(true);setError('');
    try{
      if(type==='approve')await approveSaleReturn(detail.id);
      else if(type==='cancel')await cancelSaleReturn(detail.id,reason);
      else if(detail.kind==='exchange')await executeSaleExchange({returnId:detail.id,replacementPendingSaleId:options.replacementPendingSaleId,resellLocationId:options.locationId,settlements:options.settlements||[],refundSettlement:options.refundSettlement||null,idempotencyKey:options.idempotencyKey});
      else await completeSaleReturn(detail.id,options.locationId);
      await load(detail.id);onChange?.();
      toast?.(type==='approve'?'Qaytarish tasdiqlandi':type==='complete'?'Qaytarish yakunlandi':'Qaytarish bekor qilindi');
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  };

  return <div className="rt-requests">
    <p className="rt-hint">Bu bo‘limda ochiq so‘rovlar, almashtirishlar va provayder refundlari boshqariladi. Oddiy qaytarishni “Qaytarib olish” bo‘limida bir amalda bajarish mumkin.</p>
    {error&&<InlineError text={error}/>}
    {loading?<div className="rt-state">Yuklanmoqda…</div>
      :rows.length===0?<Empty title="Qaytarishlar yo‘q" text="Hozircha so‘rov yaratilmagan."/>
      :<>
        {open.length>0&&<h4 className="rt-block-title">Ochiq so‘rovlar ({open.length})</h4>}
        <div className="rt-request-list">
          {rows.map(row=><button className="card rt-request" key={row.id} onClick={()=>setDetail(row)}>
            <span className="rt-card-icon">{row.kind==='exchange'?<ArrowLeftRight/>:<RotateCcw/>}</span>
            <div className="rt-card-main">
              <div className="between"><b>{row.return_no}</b><Status type={statusColors[row.status]}>{statusLabels[row.status]||row.status}</Status></div>
              <strong>{row.kind==='exchange'?'Almashtirish':'Qaytarish'} · {money(row.refund_amount)}</strong>
              <small>{row.reason}</small>
              <small>{stamp(row.created_at)} · {row.sale_return_lines?.length||0} dona</small>
            </div>
            <ChevronRight/>
          </button>)}
        </div>
      </>}
    <RequestDetail row={detail} refs={refs} close={()=>setDetail(null)} busy={busy} error={error} action={action}/>
  </div>;
}

function RequestDetail({row,refs,close,busy,error,action}){
  const[locationId,setLocationId]=useState('');
  const[pendingId,setPendingId]=useState('');
  const[quote,setQuote]=useState(null);
  const[method,setMethod]=useState('cash');
  const[externalReference,setExternalReference]=useState('');
  const[refundMethod,setRefundMethod]=useState('cash');
  const[refundReference,setRefundReference]=useState('');
  const[exchangeKey,setExchangeKey]=useState(()=>crypto.randomUUID());
  const[quoteBusy,setQuoteBusy]=useState(false);
  const[quoteError,setQuoteError]=useState('');

  useEffect(()=>{
    if(row){setLocationId(refs.locations?.[0]?.id||'');setPendingId('');setQuote(null);setQuoteError('');
      setExchangeKey(crypto.randomUUID());setRefundReference('');}
  },[row,refs]);

  const calculate=async()=>{
    setQuoteBusy(true);setQuoteError('');
    try{setQuote(await getExchangeQuote(row.id,pendingId.trim()));}
    catch(e){setQuote(null);setQuoteError(message(e));}
    finally{setQuoteBusy(false);}
  };
  const complete=()=>{
    const amount=Number(quote?.amount_due||0),refund=Number(quote?.refund_due||0);
    const settlements=amount>0?[{method_code:method,amount,external_reference:externalReference.trim()||null}]:[];
    const refundSettlement=refund>0?{method_code:refundMethod,amount:refund,external_reference:refundReference.trim()||null}:null;
    action('complete',{locationId,replacementPendingSaleId:pendingId.trim(),settlements,refundSettlement,idempotencyKey:exchangeKey});
  };
  const payoutReady=!quote||Number(quote.refund_due||0)===0||refundMethod==='cash'||refundReference.trim();
  const canComplete=(row?.kind!=='exchange'||(quote&&quote.pending_sale_id===pendingId.trim()))&&payoutReady;

  return <Modal open={Boolean(row)} onClose={close} title={row?.return_no||'Qaytarish'}>
    {row&&<div className="rt-detail">
      <div className="between">
        <Status type={statusColors[row.status]}>{statusLabels[row.status]||row.status}</Status>
        <b>{money(row.refund_amount)}</b>
      </div>
      <p className="rt-note">{row.reason}</p>
      {row.provider_refunds?.map(refund=><div className="rt-warning" key={refund.id}>
        <AlertTriangle/><span><b>{refund.provider?.toUpperCase()} refund: {refund.state}</b> {money(Number(refund.amount_minor||0)/100)}
        {refund.action_required&&<small>{refund.action_required}</small>}
        {refund.last_error&&<small>{refund.last_error}</small>}</span>
      </div>)}
      {error&&<InlineError text={error}/>}
      <div className="rt-lines">
        {row.sale_return_lines?.map(line=><div key={line.id}>
          <RotateCcw/>
          <span><b>{conditionLabel(line.condition)}</b><small>{line.unit_id}</small></span>
          <strong>{money(line.refund_amount)}</strong>
        </div>)}
      </div>
      {row.status==='approved'&&<div className="rt-form-grid">
        <label className="wide"><span>Qayta sotiladigan birliklar joyi</span>
          <select className="select" value={locationId} onChange={e=>setLocationId(e.target.value)}>
            {refs.locations?.map(x=><option value={x.id} key={x.id}>{x.name}</option>)}
          </select>
        </label>
        {row.kind==='exchange'&&<>
          <label className="wide"><span>Replacement pending sale ID</span>
            <div className="rt-scan-row">
              <input className="input" value={pendingId} onChange={e=>{setPendingId(e.target.value);setQuote(null);}} placeholder="Rezervlangan POS so‘rovi UUID"/>
              <button type="button" className="btn" disabled={quoteBusy||!pendingId.trim()} onClick={calculate}>{quoteBusy?'Hisoblanmoqda…':'Farqni hisoblash'}</button>
            </div>
          </label>
          {quoteError&&<div className="wide"><InlineError text={quoteError}/></div>}
          {quote&&<div className="wide rt-quote">
            <div className="between"><span>Qaytarish krediti</span><b>{money(quote.return_credit)}</b></div>
            <div className="between"><span>Yangi sotuv</span><b>{money(quote.replacement_total)}</b></div>
            <div className="between"><span>Qo‘shimcha to‘lov</span><b>{money(quote.amount_due)}</b></div>
            <div className="between"><span>Mijozga qaytariladi</span><b>{money(quote.refund_due)}</b></div>
          </div>}
          {Number(quote?.amount_due||0)>0&&<>
            <label><span>Farq to‘lov usuli</span>
              <select className="select" value={method} onChange={e=>setMethod(e.target.value)}>
                <option value="cash">Naqd</option><option value="card">Karta</option><option value="click">Click</option><option value="payme">Payme</option>
              </select>
            </label>
            <label><span>Tashqi reference</span><input className="input" value={externalReference} onChange={e=>setExternalReference(e.target.value)} placeholder="Ixtiyoriy"/></label>
          </>}
          {Number(quote?.refund_due||0)>0&&<>
            <label><span>Refund berish usuli</span>
              <select className="select" value={refundMethod} onChange={e=>setRefundMethod(e.target.value)}>
                <option value="cash">Naqd</option><option value="card">Karta</option><option value="bank_transfer">Bank o‘tkazmasi</option><option value="click">Click</option><option value="payme">Payme</option>
              </select>
            </label>
            <label><span>Refund reference {refundMethod==='cash'?'(ixtiyoriy)':'(majburiy)'}</span>
              <input className="input" required={refundMethod!=='cash'} value={refundReference} onChange={e=>setRefundReference(e.target.value)}/>
            </label>
          </>}
        </>}
      </div>}
      <div className="rt-actions">
        {row.status==='requested'&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('approve')}>Tasdiqlash</button>}
        {row.status==='approved'&&<button className="btn btn-primary" disabled={busy||!locationId||!canComplete} onClick={complete}>{row.kind==='exchange'?'Atomik almashtirish':'Yakunlash'}</button>}
        {!['completed','cancelled'].includes(row.status)&&<button className="btn rt-danger" disabled={busy} onClick={()=>action('cancel')}>Bekor qilish</button>}
      </div>
    </div>}
  </Modal>;
}

function InlineError({text}){
  return <div className="rt-inline-error"><AlertTriangle/><span>{text}</span></div>;
}
