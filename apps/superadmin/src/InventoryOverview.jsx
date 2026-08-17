import React,{useCallback,useEffect,useMemo,useState}from'react';
import{AlertTriangle,Boxes,RefreshCw,Search,Store,Warehouse}from'lucide-react';
import{Empty,Status,formatMoney}from'@texnobazar/ui';
import{listInventoryBalances,listInventorySearchSellers,listMasterRecords,searchInventoryUnits}from'@texnobazar/data';

const PAGE_SIZE=100;
const initial={query:'',qr:'',serial:'',batch:'',sku:'',model:'',color:'',size:'',min_price:'',max_price:'',branch:'',location:'',status:'',seller:'',from:'',to:''};
const compact=value=>Object.fromEntries(Object.entries(value).filter(([,item])=>item!==''&&item!=null));
const nextDay=value=>{const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString()};
const unitFilters=form=>compact({query:form.query,qr:form.qr,serial:form.serial,batch:form.batch,sku:form.sku,model:form.model,color:form.color,size:form.size,min_price:form.min_price,max_price:form.max_price,branch_ids:form.branch?[form.branch]:[],location_ids:form.location?[form.location]:[],statuses:form.status?[form.status]:[],seller_ids:form.seller?[form.seller]:[],from:form.from?`${form.from}T00:00:00Z`:'',to:form.to?nextDay(form.to):''});

export default function InventoryOverview(){
  const[mode,setMode]=useState('summary');
  const[rows,setRows]=useState([]);
  const[totalRows,setTotalRows]=useState(0);
  const[refs,setRefs]=useState({branches:[],locations:[],employees:[]});
  const[form,setForm]=useState(initial);
  const[applied,setApplied]=useState(initial);
  const[page,setPage]=useState(1);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const set=(key,value)=>setForm(current=>({...current,[key]:value}));

  useEffect(()=>{
    let active=true;
    Promise.all([listMasterRecords('branches'),listMasterRecords('locations'),listInventorySearchSellers()]).then(([branches,locations,employees])=>{
      if(active)setRefs({branches:branches||[],locations:locations||[],employees:employees||[]});
    }).catch(currentError=>{if(active)setError(currentError.message||'Ma’lumotnomalar yuklanmadi')});
    return()=>{active=false};
  },[]);

  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const result=mode==='summary'
        ?await listInventoryBalances({branchId:applied.branch||null,locationId:applied.location||null,query:applied.query||null,page,pageSize:PAGE_SIZE})
        :await searchInventoryUnits({filters:unitFilters(applied),page,pageSize:PAGE_SIZE});
      setRows(result?.items||[]);setTotalRows(Number(result?.total||0));
    }catch(currentError){setRows([]);setTotalRows(0);setError(currentError.message||'Qoldiq yuklanmadi')}
    finally{setLoading(false)}
  },[mode,applied,page]);
  useEffect(()=>{load()},[load]);

  const apply=event=>{event?.preventDefault();setPage(1);setApplied({...form})};
  const reset=()=>{setForm(initial);setApplied(initial);setPage(1)};
  const switchMode=next=>{setMode(next);setPage(1)};
  const totalPages=Math.max(1,Math.ceil(totalRows/PAGE_SIZE));
  const locations=refs.locations.filter(item=>!form.branch||item.branch_id===form.branch);
  const summary=useMemo(()=>mode==='summary'
    ?rows.reduce((result,item)=>({on:result.on+Number(item.on_hand),reserved:result.reserved+Number(item.reserved),value:result.value+Number(item.on_hand)*Number(item.retail_price)}),{on:0,reserved:0,value:0})
    :rows.reduce((result,item)=>({available:result.available+(item.status==='available'?1:0),reserved:result.reserved+(item.status==='reserved'?1:0),value:result.value+Number((item.promotion_price??item.retail_price)||0)}),{available:0,reserved:0,value:0}),[rows,mode]);

  return <>
    <div className="page-head between"><div><h2>Ombor va advanced qidiruv</h2><p>Balans yoki QR/seriya/partiya/model/rang/o‘lcham/narx/sotuvchi/sana bo‘yicha individual birliklar</p></div><button className="btn btn-outline" onClick={load}><RefreshCw/>Yangilash</button></div>
    <div className="mini-kpis">{mode==='summary'?<><div><Boxes/><span><b>{summary.on}</b>Sahifadagi birlik</span></div><div><Warehouse/><span><b>{summary.on-summary.reserved}</b>Sahifada mavjud</span></div><div><Store/><span><b>{summary.reserved}</b>Sahifada rezerv</span></div><div><Boxes/><span><b>{formatMoney(summary.value)}</b>Sahifa qiymati</span></div></>:<><div><Boxes/><span><b>{totalRows}</b>Topilgan birlik</span></div><div><Warehouse/><span><b>{summary.available}</b>Sahifada mavjud</span></div><div><Store/><span><b>{summary.reserved}</b>Sahifada rezerv</span></div><div><Boxes/><span><b>{formatMoney(summary.value)}</b>Sahifa qiymati</span></div></>}</div>
    <div className="card data-card">
      <div className="tw-tabs"><button className={mode==='summary'?'active':''} onClick={()=>switchMode('summary')}>Balans</button><button className={mode==='units'?'active':''} onClick={()=>switchMode('units')}>Individual advanced search</button></div>
      <form className="inventory-admin-filters" onSubmit={apply}>
        <label><Search/><input value={form.query} onChange={event=>set('query',event.target.value)} placeholder="Mahsulot, metadata yoki umumiy kod"/></label>
        <select className="select" value={form.branch} onChange={event=>setForm(current=>({...current,branch:event.target.value,location:''}))}><option value="">Barcha filiallar</option>{refs.branches.filter(item=>item.is_active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select className="select" value={form.location} onChange={event=>set('location',event.target.value)}><option value="">Barcha joylashuvlar</option>{locations.filter(item=>item.is_active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {mode==='units'&&<>
          <input className="input" value={form.qr} onChange={event=>set('qr',event.target.value)} placeholder="QR"/><input className="input" value={form.serial} onChange={event=>set('serial',event.target.value)} placeholder="Seriya"/><input className="input" value={form.batch} onChange={event=>set('batch',event.target.value)} placeholder="Partiya"/><input className="input" value={form.sku} onChange={event=>set('sku',event.target.value)} placeholder="SKU"/>
          <input className="input" value={form.model} onChange={event=>set('model',event.target.value)} placeholder="Model"/><input className="input" value={form.color} onChange={event=>set('color',event.target.value)} placeholder="Rang"/><input className="input" value={form.size} onChange={event=>set('size',event.target.value)} placeholder="O‘lcham"/>
          <input className="input" type="number" min="0" value={form.min_price} onChange={event=>set('min_price',event.target.value)} placeholder="Min narx"/><input className="input" type="number" min="0" value={form.max_price} onChange={event=>set('max_price',event.target.value)} placeholder="Max narx"/>
          <select className="select" value={form.status} onChange={event=>set('status',event.target.value)}><option value="">Barcha statuslar</option>{['available','reserved','in_transit','sold','returned','written_off','in_repair'].map(item=><option key={item}>{item}</option>)}</select>
          <select className="select" value={form.seller} onChange={event=>set('seller',event.target.value)}><option value="">Barcha sotuvchilar</option>{refs.employees.filter(item=>!form.branch||(item.branch_ids||[]).includes(form.branch)).map(item=><option key={item.id} value={item.id}>{item.full_name}</option>)}</select>
          <input className="input" type="date" value={form.from} onChange={event=>set('from',event.target.value)}/><input className="input" type="date" value={form.to} onChange={event=>set('to',event.target.value)}/>
        </>}
        <button className="btn btn-primary">Qidirish</button><button type="button" className="btn btn-outline" onClick={reset}>Tozalash</button>
      </form>
      {loading?<div className="employee-loading">Qoldiq yuklanmoqda…</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:rows.length===0?<Empty title="Qoldiq topilmadi" text="Filtrlarga mos mahsulot birliklari yo‘q."/>:mode==='summary'?<BalanceTable rows={rows}/>:<UnitTable rows={rows}/>}
      {!loading&&!error&&totalRows>0&&<><div className="unit-page-note">{(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,totalRows)} / {totalRows}</div><div className="inventory-search-pagination"><span>{page}-sahifa / {totalPages}</span><div><button className="btn btn-outline" disabled={page<=1} onClick={()=>setPage(current=>current-1)}>Oldingi</button><button className="btn btn-outline" disabled={page>=totalPages} onClick={()=>setPage(current=>current+1)}>Keyingi</button></div></div></>}
    </div>
  </>
}

function BalanceTable({rows}){return <div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>Filial</th><th>Joylashuv</th><th>Turi</th><th>Jami</th><th>Rezerv</th><th>Mavjud</th><th>Qiymat</th></tr></thead><tbody>{rows.map(item=><tr key={`${item.location_id}-${item.product_id}`}><td><div className="product-cell">{item.image?<img src={item.image} alt=""/>:<span className="product-placeholder"><Boxes/></span>}<div><b>{item.product_name}</b><span>{item.sku}</span></div></div></td><td>{item.branch_name}</td><td>{item.location_name}</td><td><Status type={item.location_type==='warehouse'?'blue':'green'}>{item.location_type}</Status></td><td><b>{Number(item.on_hand)}</b></td><td>{Number(item.reserved)}</td><td><b>{Number(item.available)}</b></td><td>{formatMoney(Number(item.on_hand)*Number(item.retail_price))}</td></tr>)}</tbody></table></div>}
function UnitTable({rows}){return <div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>QR / seriya</th><th>Partiya</th><th>Filial / joy</th><th>Status</th><th>Narx</th><th>Sotilgan sana</th></tr></thead><tbody>{rows.map(item=><tr key={item.id}><td><b>{item.product_name}</b><small>{item.sku}</small></td><td><code>{item.qr_code}</code><small>{item.serial_number||'—'}</small></td><td>{item.batch_reference||'—'}</td><td>{item.branch_name}<small>{item.location_name}</small></td><td><Status type={item.status==='available'?'green':item.status==='sold'?'blue':'orange'}>{item.status}</Status></td><td>{formatMoney(Number((item.promotion_price??item.retail_price)||0))}</td><td>{item.sold_at?new Date(item.sold_at).toLocaleString('uz-UZ'):'—'}</td></tr>)}</tbody></table></div>}
