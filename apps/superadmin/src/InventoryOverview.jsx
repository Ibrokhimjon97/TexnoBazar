import React,{useCallback,useEffect,useMemo,useState}from'react';
import RichTextEditor from'./RichTextEditor';
import{AlertTriangle,Boxes,Download,Pencil,Plus,RefreshCw,Search,Store,Trash2,Upload,Warehouse,X}from'lucide-react';
import{DualPrice,DualPriceInput,Empty,Modal,QrScanButton,Status,useExchangeRate}from'@texnobazar/ui';
import{getBrowserClient,listInventoryBalances,listInventorySearchSellers,listMasterRecords,searchInventoryUnits}from'@texnobazar/data';

import ProductCatalog from'./ProductCatalog';

const PAGE_SIZE=100;
const STOREFRONT=(import.meta.env?.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app').replace(/\/$/,'');
const unitStatusLabel=status=>({available:'Sotuvga tayyor',reserved:'Band',in_transit:'Yo‘lda',sold:'Sotilgan',returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:'Ta’mirda'}[status]||status);
const initial={query:'',qr:'',serial:'',batch:'',sku:'',model:'',color:'',size:'',min_price:'',max_price:'',branch:'',location:'',status:'',seller:'',from:'',to:'',category:'',availability:''};
const compact=value=>Object.fromEntries(Object.entries(value).filter(([,item])=>item!==''&&item!=null));
const nextDay=value=>{const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString()};
const unitFilters=form=>compact({query:form.query,qr:form.qr,serial:form.serial,batch:form.batch,sku:form.sku,model:form.model,color:form.color,size:form.size,min_price:form.min_price,max_price:form.max_price,branch_ids:form.branch?[form.branch]:[],location_ids:form.location?[form.location]:[],statuses:form.status?[form.status]:[],seller_ids:form.seller?[form.seller]:[],from:form.from?`${form.from}T00:00:00Z`:'',to:form.to?nextDay(form.to):''});

export default function InventoryOverview({toast}){
  const rate=useExchangeRate();
  const[tab,setTab]=useState('catalog');
  if(tab==='catalog')return <section><div className="inventory-tabs"><button className={tab==='catalog'?'active':''} onClick={()=>setTab('catalog')}>Mahsulot katalogi</button><button className={tab==='balance'?'active':''} onClick={()=>setTab('balance')}>Qoldiq (Balans)</button><button className={tab==='units'?'active':''} onClick={()=>setTab('units')}>Individual birliklar</button></div><ProductCatalog toast={toast}/></section>;
  return <InventoryBalanceView toast={toast} tab={tab} setTab={setTab}/>;
}
function InventoryBalanceView({toast,tab,setTab}){
  const rate=useExchangeRate();
  const[mode,setMode]=useState('summary');
  const[rows,setRows]=useState([]);
  const[totalRows,setTotalRows]=useState(0);
  const[refs,setRefs]=useState({branches:[],locations:[],employees:[],categories:[]});
  const[form,setForm]=useState(initial);
  const[applied,setApplied]=useState(initial);
  const[page,setPage]=useState(1);
  const[loading,setLoading]=useState(true);
  const[selectedProduct,setSelectedProduct]=useState(null),[newProductModal,setNewProductModal]=useState(false);
  const[error,setError]=useState('');
  const set=(key,value)=>setForm(current=>({...current,[key]:value}));

  useEffect(()=>{
    let active=true;
    Promise.all([listMasterRecords('branches'),listMasterRecords('locations'),listInventorySearchSellers(),listMasterRecords('categories')]).then(([branches,locations,employees,categories])=>{
      if(active)setRefs({branches:branches||[],locations:locations||[],employees:employees||[],categories:categories||[]});
    }).catch(currentError=>{if(active)setError(currentError.message||'Ma’lumotnomalar yuklanmadi')});
    return()=>{active=false};
  },[]);

  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const result=mode==='summary'
        ?await listInventoryBalances({branchId:applied.branch||null,locationId:applied.location||null,query:applied.query||null,categoryId:applied.category||null,minPrice:applied.min_price||null,maxPrice:applied.max_price||null,availability:applied.availability||null,page,pageSize:PAGE_SIZE})
        :await searchInventoryUnits({filters:unitFilters(applied),page,pageSize:PAGE_SIZE});
      const items=result?.items||[];
      // Enrich with cost_price from products table
      if(items.length>0){const ids=[...new Set(items.map(i=>i.product_id))];const{data:prods}=await getBrowserClient().from('products').select('id,cost_price').in('id',ids);const costMap=Object.fromEntries((prods||[]).map(p=>[p.id,p.cost_price||0]));items.forEach(i=>{i.cost_price=costMap[i.product_id]||0})}
      setRows(items);setTotalRows(Number(result?.total||0));
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
    ?rows.reduce((result,item)=>({on:result.on+Number(item.on_hand),reserved:result.reserved+Number(item.reserved),value:result.value+Number(item.on_hand)*Number(item.retail_price),cost:result.cost+Number(item.on_hand)*Number(item.cost_price||0),types:result.types.add(item.product_id)}),{on:0,reserved:0,value:0,cost:0,types:new Set()})
    :rows.reduce((result,item)=>({available:result.available+(item.status==='available'?1:0),reserved:result.reserved+(item.status==='reserved'?1:0),value:result.value+Number((item.promotion_price??item.retail_price)||0)}),{available:0,reserved:0,value:0}),[rows,mode]);

    const editProduct=item=>{setSelectedProduct(item)};
  const deleteProduct=async item=>{if(!confirm(item.product_name+" mahsulotini ochirasizmi?"))return;try{const client=getBrowserClient();const{error:err}=await client.rpc('delete_product_cascade',{p_product_id:item.product_id});if(err)throw err;if(toast)toast('Mahsulot ochirildi');setRows(prev=>prev.filter(r=>r.product_id!==item.product_id))}catch(e){setError(e.message)}};
  return <>
    <div className="inventory-tabs"><button className={tab==='catalog'?'active':''} onClick={()=>setTab('catalog')}>Mahsulot katalogi</button><button className={tab==='balance'?'active':''} onClick={()=>setTab('balance')}>Qoldiq (Balans)</button><button className={tab==='units'?'active':''} onClick={()=>setTab('units')}>Individual birliklar</button></div>
    <div className="page-head between"><div><h2>Ombor va advanced qidiruv</h2><p>Balans yoki QR/seriya/partiya/model/rang/o‘lcham/narx/sotuvchi/sana bo‘yicha individual birliklar</p></div><button className="btn btn-outline" onClick={load}><RefreshCw/>Yangilash</button><button className="btn btn-primary" onClick={()=>setNewProductModal(true)}><Plus/> Yangi tovar</button></div>
    <div className="mini-kpis">{mode==='summary'?<><div><Boxes/><span><b>{summary.types?.size||rows.length}</b>Tovar turlari</span></div><div><Warehouse/><span><b>{summary.on}</b>Mavjud tovarlar</span></div><div><Boxes/><span><b><DualPrice value={summary.value} rate={rate}/></b>Sotish narxi</span></div><div><Warehouse/><span><b><DualPrice value={summary.cost} rate={rate}/></b>Tannarxi</span></div></>:<><div><Boxes/><span><b>{totalRows}</b>Tovar turlari</span></div><div><Warehouse/><span><b>{summary.available}</b>Mavjud tovarlar</span></div><div><Boxes/><span><b><DualPrice value={summary.value} rate={rate}/></b>Sotish narxi</span></div><div><Warehouse/><span><b><DualPrice value={summary.cost} rate={rate}/></b>Tannarxi</span></div></>}</div>
    <div className="card data-card">
      <div className="tw-tabs"><button className={mode==='summary'?'active':''} onClick={()=>switchMode('summary')}>Balans</button><button className={mode==='units'?'active':''} onClick={()=>switchMode('units')}>Individual advanced search</button></div>
      <form className="inventory-admin-filters" onSubmit={apply}>
        <label><Search/><input value={form.query} onChange={event=>set('query',event.target.value)} placeholder="Mahsulot, metadata yoki umumiy kod"/></label>
        <select className="select" value={form.branch} onChange={event=>setForm(current=>({...current,branch:event.target.value,location:''}))}><option value="">Barcha filiallar</option>{refs.branches.filter(item=>item.is_active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select className="select" value={form.location} onChange={event=>set('location',event.target.value)}><option value="">Barcha joylashuvlar</option>{locations.filter(item=>item.is_active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {mode==='summary'&&<>
          <select className="select" value={form.category} onChange={event=>set('category',event.target.value)}><option value="">Barcha kategoriyalar</option>{refs.categories.filter(item=>item.is_active).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <input className="input" type="number" min="0" value={form.min_price} onChange={event=>set('min_price',event.target.value)} placeholder="Min narx"/>
          <input className="input" type="number" min="0" value={form.max_price} onChange={event=>set('max_price',event.target.value)} placeholder="Max narx"/>
          <select className="select" value={form.availability} onChange={event=>set('availability',event.target.value)}><option value="">Mavjudlik: Barchasi</option><option value="in_stock">Bor</option><option value="out_of_stock">Yo'q</option></select>
        </>}
        {mode==='units'&&<>
          <input className="input" value={form.qr} onChange={event=>set('qr',event.target.value)} placeholder="QR"/><QrScanButton onScan={code=>{set('qr',code);apply()}}/><input className="input" value={form.serial} onChange={event=>set('serial',event.target.value)} placeholder="Seriya"/><input className="input" value={form.batch} onChange={event=>set('batch',event.target.value)} placeholder="Partiya"/><input className="input" value={form.sku} onChange={event=>set('sku',event.target.value)} placeholder="SKU"/>
          <input className="input" value={form.model} onChange={event=>set('model',event.target.value)} placeholder="Model"/><input className="input" value={form.color} onChange={event=>set('color',event.target.value)} placeholder="Rang"/><input className="input" value={form.size} onChange={event=>set('size',event.target.value)} placeholder="O‘lcham"/>
          <input className="input" type="number" min="0" value={form.min_price} onChange={event=>set('min_price',event.target.value)} placeholder="Min narx"/><input className="input" type="number" min="0" value={form.max_price} onChange={event=>set('max_price',event.target.value)} placeholder="Max narx"/>
          <select className="select" value={form.status} onChange={event=>set('status',event.target.value)}><option value="">Barcha statuslar</option>{['available','reserved','in_transit','sold','returned','written_off','in_repair'].map(item=><option key={item}>{item}</option>)}</select>
          <select className="select" value={form.seller} onChange={event=>set('seller',event.target.value)}><option value="">Barcha sotuvchilar</option>{refs.employees.filter(item=>!form.branch||(item.branch_ids||[]).includes(form.branch)).map(item=><option key={item.id} value={item.id}>{item.full_name}</option>)}</select>
          <input className="input" type="date" value={form.from} onChange={event=>set('from',event.target.value)}/><input className="input" type="date" value={form.to} onChange={event=>set('to',event.target.value)}/>
        </>}
        <button className="btn btn-primary">Qidirish</button><button type="button" className="btn btn-outline" onClick={reset}>Tozalash</button>
      </form>
      {loading?<div className="employee-loading">Qoldiq yuklanmoqda…</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:rows.length===0?<Empty title="Qoldiq topilmadi" text="Filtrlarga mos mahsulot birliklari yo‘q."/>:mode==='summary'?<BalanceTable rows={rows} onEdit={editProduct} onDelete={deleteProduct} onSelect={setSelectedProduct} rate={rate}/>:<UnitTable rows={rows} rate={rate}/>}
      {!loading&&!error&&totalRows>0&&<><div className="unit-page-note">{(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,totalRows)} / {totalRows}</div><div className="inventory-search-pagination"><span>{page}-sahifa / {totalPages}</span><div><button className="btn btn-outline" disabled={page<=1} onClick={()=>setPage(current=>current-1)}>Oldingi</button><button className="btn btn-outline" disabled={page>=totalPages} onClick={()=>setPage(current=>current+1)}>Keyingi</button></div></div></>}
    </div>

    {newProductModal&&<NewProductModal close={()=>setNewProductModal(false)} toast={toast} onCreated={()=>{setNewProductModal(false);load()}}/>}
    {selectedProduct&&<ProductDetailModal product={selectedProduct} close={()=>setSelectedProduct(null)} toast={toast} rate={rate}/>}
  </>
}

function BalanceTable({rows,onEdit,onDelete,onSelect,rate}){return <div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>Filial</th><th>Joylashuv</th><th>Turi</th><th>Jami</th><th>Mavjud</th><th>Sotish narxi</th><th>Tannarxi</th><th>Amal</th></tr></thead><tbody>{rows.map(item=><tr key={`${item.location_id}-${item.product_id}`} className="clickable-row" onClick={()=>onSelect&&onSelect(item)}><td><div className="product-cell">{item.image?<img src={item.image} alt=""/>:<span className="product-placeholder"><Boxes/></span>}<div><b>{item.product_name}</b><span>{item.sku}</span></div></div></td><td>{item.branch_name}</td><td>{item.location_name}</td><td><Status type={item.location_type==='warehouse'?'blue':'green'}>{item.location_type}</Status></td><td><b>{Number(item.on_hand)}</b></td><td><b>{Number(item.available)}</b></td><td><DualPrice value={Number(item.on_hand)*Number(item.retail_price)} rate={rate}/></td><td><DualPrice value={Number(item.on_hand)*Number(item.cost_price||0)} rate={rate}/></td><td><div className="master-actions"><button className="icon-btn" title="Tahrirlash" onClick={()=>onEdit&&onEdit(item)}><Pencil size={14}/></button><button className="icon-btn danger-icon" title="Ochirish" onClick={()=>onDelete&&onDelete(item)}><Trash2 size={14}/></button></div></td></tr>)}</tbody></table></div>}
function UnitTable({rows,rate}){return <div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>QR / seriya</th><th>Partiya</th><th>Filial / joy</th><th>Status</th><th>Narx</th><th>Sotilgan sana</th></tr></thead><tbody>{rows.map(item=><tr key={item.id}><td><b>{item.product_name}</b><small>{item.sku}</small></td><td><code>{item.qr_code}</code><small>{item.serial_number||'—'}</small></td><td>{item.batch_reference||'—'}</td><td>{item.branch_name}<small>{item.location_name}</small></td><td><Status type={item.status==='available'?'green':item.status==='sold'?'blue':'orange'}>{item.status}</Status></td><td><DualPrice value={Number((item.promotion_price??item.retail_price)||0)} rate={rate}/></td><td>{item.sold_at?new Date(item.sold_at).toLocaleString('uz-UZ'):'—'}</td></tr>)}</tbody></table></div>}

function ProductDetailModal({product,close,toast,rate}){
  const[detail,setDetail]=useState(null),[units,setUnits]=useState([]),[media,setMedia]=useState([]);
  const[loading,setLoading]=useState(true),[filterBranch,setFilterBranch]=useState('');
  const[unitQuery,setUnitQuery]=useState(''),[filterStatus,setFilterStatus]=useState(''),[filterPlace,setFilterPlace]=useState('');
  const[editMode,setEditMode]=useState(false),[desc,setDesc]=useState(''),[videoUrl,setVideoUrl]=useState('');
  const[uploading,setUploading]=useState(false);

  useEffect(()=>{loadDetail()},[product]);

  const loadDetail=async()=>{setLoading(true);try{
    const client=getBrowserClient();
    const{data:p}=await client.from('products').select('*,categories(name),brands(name)').eq('id',product.product_id).single();
    const{data:u}=await client.from('inventory_units').select('id,qr_code,serial_number,status,location_id,locations(name,type,branch_id,branches(name))').eq('product_id',product.product_id).order('created_at',{ascending:false}).limit(500);
    const{data:m}=await client.from('product_media').select('*').eq('product_id',product.product_id).order('is_primary',{ascending:false}).order('sort_order');
    setDetail(p);setUnits(u||[]);setMedia(m||[]);
    setDesc(p?.description||'');setVideoUrl(p?.seo_image_url||'');
  }catch(e){}finally{setLoading(false)}};

  const branches=[...new Set((units||[]).map(u=>u.locations?.branches?.name).filter(Boolean))];
  const branchSummary=branches.map(b=>({name:b,count:units.filter(u=>u.locations?.branches?.name===b).length}));
  const unitQueryText=unitQuery.trim().toLowerCase();
  const filteredUnits=units.filter(u=>{
    if(filterBranch&&u.locations?.branches?.name!==filterBranch)return false;
    if(filterStatus&&u.status!==filterStatus)return false;
    if(filterPlace&&u.locations?.type!==filterPlace)return false;
    if(!unitQueryText)return true;
    return [u.qr_code,u.serial_number,u.locations?.name,u.locations?.branches?.name].some(value=>String(value||'').toLowerCase().includes(unitQueryText));
  });
  const statusCounts=units.reduce((acc,u)=>{acc[u.status]=(acc[u.status]||0)+1;return acc},{});
  const placeCounts=units.reduce((acc,u)=>{const type=u.locations?.type;if(type)acc[type]=(acc[type]||0)+1;return acc},{});
  const filtersActive=Boolean(filterBranch||filterStatus||filterPlace||unitQueryText);

  const saveDesc=async()=>{try{
    const{updateProductTextFields}=await import('@texnobazar/data');
    await updateProductTextFields(product.product_id,{description:desc});
    setEditMode(false);if(toast)toast('Tavsif saqlandi');
  }catch(e){alert(e.message)}};

  const saveVideo=async()=>{try{
    const{updateProductTextFields}=await import('@texnobazar/data');
    await updateProductTextFields(product.product_id,{seoImageUrl:videoUrl});
    if(toast)toast('Video URL saqlandi');
  }catch(e){alert(e.message)}};

  const uploadImage=async(e)=>{
    const files=[...e.target.files];if(!files.length)return;
    setUploading(true);
    try{
      const{uploadProductMedia}=await import('@texnobazar/data');
      for(const file of files)await uploadProductMedia(product.product_id,file,detail?.name||'');
      await loadDetail();
      if(toast)toast(files.length>1?`${files.length} ta rasm yuklandi`:'Rasm yuklandi');
    }catch(err){alert(err.message)}finally{setUploading(false);e.target.value=''}
  };

  const downloadQR=async(unit)=>{
    if(!unit.qr_code){alert('Birlik QR kodi topilmadi');return}
    const QRCode=await import('qrcode');
    const url=`${STOREFRONT}/qr/${encodeURIComponent(unit.qr_code)}`;
    const canvas=await QRCode.toCanvas(url,{width:300,margin:2,color:{dark:'#000000',light:'#ffffff'}});
    // Add label text below QR
    const labeled=document.createElement('canvas');
    labeled.width=300;labeled.height=340;
    const ctx=labeled.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,300,340);
    ctx.drawImage(canvas,0,0);
    ctx.fillStyle='#000';ctx.font='bold 11px sans-serif';ctx.textAlign='center';
    ctx.fillText(unit.qr_code||'',150,318);
    ctx.font='10px sans-serif';ctx.fillStyle='#555';
    ctx.fillText(detail?.name||'',150,333);
    const link=document.createElement('a');
    link.download=(unit.qr_code||'qr')+'.png';
    link.href=labeled.toDataURL();link.click();
  };

  if(loading)return <Modal open onClose={close} title="Yuklanmoqda..."><div className="employee-loading">Ma'lumotlar yuklanmoqda...</div></Modal>;
  if(!detail)return <Modal open onClose={close} title="Xatolik"><p>Mahsulot topilmadi</p></Modal>;

  return <Modal open onClose={close} title={detail.name+' ('+units.length+' dona)'}><div className="product-detail-modal">
    <div className="product-info-rows" style={{marginBottom:'1rem'}}>
      <div><span>SKU:</span><b>{detail.sku}</b></div>
      <div><span>Kategoriya:</span><b>{detail.categories?.name||'-'}</b></div>
      <div><span>Brend:</span><b>{detail.brands?.name||'-'}</b></div>
      <div><span>Sotish narxi:</span><b><DualPrice value={Number(detail.retail_price||0)} rate={rate}/></b></div>
      <div><span>Tannarx:</span><b><DualPrice value={Number(detail.cost_price||0)} rate={rate}/></b></div>
      <div><span>Jami soni:</span><b>{units.length} dona</b></div>
    </div>

    <h4>Filiallar bo'yicha taqsimot</h4>
    <div className="branch-dist">{branchSummary.map(b=><span key={b.name} className={filterBranch===b.name?'active':''} onClick={()=>setFilterBranch(filterBranch===b.name?'':b.name)}>{b.name}: <b>{b.count}</b></span>)}{filterBranch&&<button className="btn btn-outline btn-sm" onClick={()=>setFilterBranch('')}>Barchasini ko'rsatish</button>}</div>

    <h4>Birliklar ({filteredUnits.length}{filtersActive?` / ${units.length}`:''})</h4>
    <div className="unit-filter-bar">
      <label className="unit-filter-search"><Search size={14}/><input value={unitQuery} onChange={event=>setUnitQuery(event.target.value)} placeholder="QR kod, seriya yoki joy bo‘yicha qidirish"/>{unitQuery&&<button type="button" onClick={()=>setUnitQuery('')} aria-label="Qidiruvni tozalash"><X size={13}/></button>}</label>
      <div className="unit-filter-chips">
        <button type="button" className={filterStatus===''?'active':''} onClick={()=>setFilterStatus('')}>Barcha status <i>{units.length}</i></button>
        {['available','reserved','sold','in_transit','returned','written_off','in_repair'].filter(status=>statusCounts[status]).map(status=><button type="button" key={status} className={filterStatus===status?'active':''} onClick={()=>setFilterStatus(filterStatus===status?'':status)}>{unitStatusLabel(status)} <i>{statusCounts[status]}</i></button>)}
      </div>
      <div className="unit-filter-chips">
        <button type="button" className={filterPlace===''?'active':''} onClick={()=>setFilterPlace('')}>Barcha joy</button>
        {[['store','Do‘konda'],['warehouse','Omborda']].filter(([type])=>placeCounts[type]).map(([type,label])=><button type="button" key={type} className={filterPlace===type?'active':''} onClick={()=>setFilterPlace(filterPlace===type?'':type)}>{label} <i>{placeCounts[type]}</i></button>)}
        {filtersActive&&<button type="button" className="unit-filter-reset" onClick={()=>{setUnitQuery('');setFilterStatus('');setFilterPlace('');setFilterBranch('')}}>Filtrni tozalash</button>}
      </div>
    </div>
    <div className="table-wrap" style={{maxHeight:250,overflow:'auto'}}><table className="table"><thead><tr><th>QR kod</th><th>Seriya</th><th>Filial</th><th>Joy</th><th>Status</th><th>QR</th></tr></thead><tbody>{filteredUnits.map(u=><tr key={u.id}><td><code>{u.qr_code||'-'}</code></td><td>{u.serial_number||'-'}</td><td>{u.locations?.branches?.name||'-'}</td><td>{u.locations?.name||'-'}</td><td><Status type={u.status==='available'?'green':u.status==='sold'?'blue':'orange'}>{unitStatusLabel(u.status)}</Status></td><td><button className="icon-btn" title="QR yuklab olish" onClick={()=>downloadQR(u)}><Download size={14}/></button></td></tr>)}{!filteredUnits.length&&<tr><td colSpan="6" className="unit-filter-empty">Filtrga mos birlik topilmadi</td></tr>}</tbody></table></div>

    <h4 style={{marginTop:'1rem'}}>Rasmlar ({media.length})</h4>
    <div className="product-media-grid">{media.map(m=><div key={m.id} className="product-media-item"><img src={m.public_url} alt="" onError={e=>{e.target.style.display='none'}}/><button className="media-delete-btn" title="Ochirish" onClick={async()=>{if(!confirm('Bu rasmni ochirasizmi?'))return;try{const client=getBrowserClient();const{error:err}=await client.from('product_media').delete().eq('id',m.id);if(err)throw err;await loadDetail();if(toast)toast('Rasm ochirildi')}catch(err){alert(err.message)}}}><Trash2 size={12}/></button></div>)}</div>
    <label className="btn btn-outline btn-sm" style={{marginTop:'.5rem'}}><Upload size={14}/> {uploading?'Yuklanmoqda...':'Rasm yuklash'}<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={uploadImage} disabled={uploading}/></label>

    <h4 style={{marginTop:'1rem'}}>Video (YouTube)</h4>
    <div style={{display:'flex',gap:8}}><input className="input" value={videoUrl} onChange={e=>setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."/><button className="btn btn-primary btn-sm" onClick={saveVideo}>Saqlash</button></div>

    <h4 style={{marginTop:'1rem'}}>Tavsif</h4>
    {editMode?<><RichTextEditor value={desc} onChange={v=>setDesc(v)}/><div style={{display:'flex',gap:8,marginTop:8}}><button className="btn btn-primary btn-sm" onClick={saveDesc}>Saqlash</button><button className="btn btn-outline btn-sm" onClick={()=>setEditMode(false)}>Bekor</button></div></>:<><div className="muted" style={{whiteSpace:'pre-wrap'}} dangerouslySetInnerHTML={{__html:desc||'Tavsif kiritilmagan'}}/><button className="btn btn-outline btn-sm" onClick={()=>setEditMode(true)}><Pencil size={14}/> Tahrirlash</button></>}
  </div></Modal>;
}

export function NewProductModal({close,toast,onCreated}){
  const rate=useExchangeRate();
  const[form,setForm]=useState({name:'',sku:'',barcode:'',category_id:'',brand_id:'',cost_price:'',retail_price:'',wholesale_price:'',promotion_price:'',minimum_sale_price:'0',compare_at_price:'',tax_rate:'0',description:'',slug:'',video_url:''});
  const[images,setImages]=useState([]);
  const[categories,setCategories]=useState([]),[brands,setBrands]=useState([]),[catModal,setCatModal]=useState(false);
  const[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const client=getBrowserClient();Promise.all([client.from('categories').select('id,name').eq('is_active',true),client.from('brands').select('id,name').eq('is_active',true)]).then(([{data:c},{data:b}])=>{setCategories(c||[]);setBrands(b||[])})},[]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{
    const client=getBrowserClient();
    const slug=(form.slug?.trim()||form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''))+'-'+Date.now().toString(36);
    const{error:err}=await client.from('products').insert({
      name:form.name.trim(),sku:form.sku.trim().toUpperCase()||('TB-'+Date.now()),
      slug,category_id:form.category_id||undefined,brand_id:form.brand_id||null,
      cost_price:Number(form.cost_price)||0,retail_price:Number(form.retail_price)||0,
      description:form.description.trim()||null,status:'active',is_published:false,
      track_individual_units:true,tax_rate:0,wholesale_price:null,promotion_price:null
    });
    if(err)throw err;
    if(toast)toast('Mahsulot yaratildi');
    await onCreated();
  }catch(err){setError(err.message)}finally{setBusy(false)}};
  return <Modal open onClose={close} title="Yangi mahsulot"><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label className="wide"><span className="label">Mahsulot nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2"/></label><label><span className="label">SKU</span><input className="input" value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})} placeholder="Avtomatik"/></label><label><span className="label">Kategoriya</span><div style={{display:'flex',gap:6}}><select className="select" value={form.category_id} onChange={e=>setForm({...form,category_id:e.target.value})} style={{flex:1}} required><option value="">Tanlang</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><button type="button" className="btn btn-outline" style={{padding:'6px 12px'}} onClick={()=>setCatModal(true)}>+</button></div></label><label><span className="label">Brend</span><div style={{display:'flex',gap:6,position:'relative'}}><select className="select" style={{flex:1}} value={form.brand_id} onChange={e=>setForm({...form,brand_id:e.target.value})}><option value="">Brendsiz</option>{brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><NewBrandInline brands={brands} setBrands={setBrands} onCreated={b=>setForm({...form,brand_id:b.id})}/></div></label><DualPriceInput label="Tannarx" valueUzs={form.cost_price} onChangeUzs={v=>setForm({...form,cost_price:v})} rate={rate}/><DualPriceInput label="Sotish narxi" valueUzs={form.retail_price} onChangeUzs={v=>setForm({...form,retail_price:v})} rate={rate}/><DualPriceInput label="Ulgurji narx" valueUzs={form.wholesale_price} onChangeUzs={v=>setForm({...form,wholesale_price:v})} rate={rate}/><label><span className="label">Aksiya narxi</span><input className="input" type="number" min="0" value={form.promotion_price} onChange={e=>setForm({...form,promotion_price:e.target.value})}/></label><label><span className="label">Minimal sotuv narxi</span><input className="input" type="number" min="0" value={form.minimum_sale_price} onChange={e=>setForm({...form,minimum_sale_price:e.target.value})}/></label><label><span className="label">Eski narx</span><input className="input" type="number" min="0" value={form.compare_at_price} onChange={e=>setForm({...form,compare_at_price:e.target.value})}/></label><label><span className="label">Shtrix-kod</span><input className="input" value={form.barcode} onChange={e=>setForm({...form,barcode:e.target.value})}/></label><label className="wide"><span className="label">Slug</span><input className="input" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="Nomdan avtomatik yaratiladi"/></label><label className="wide"><span className="label">YouTube video URL</span><input className="input" value={form.video_url} onChange={e=>setForm({...form,video_url:e.target.value})} placeholder="https://youtube.com/watch?v=..."/></label><div className="wide"><span className="label">Tavsif</span><RichTextEditor value={form.description} onChange={v=>setForm({...form,description:v})}/></div><div className="wide"><span className="label">Rasmlar ({images.length} ta tanlangan)</span><div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>{images.map((file,i)=><div key={i} className="product-media-item"><img src={URL.createObjectURL(file)} alt=""/><button type="button" className="media-delete-btn" onClick={()=>setImages(imgs=>imgs.filter((_,j)=>j!==i))}><Trash2 size={10}/></button></div>)}</div><label className="btn btn-outline btn-sm"><Upload size={14}/> Rasm tanlash<input type="file" accept="image/*" multiple hidden onChange={e=>{const files=[...e.target.files];if(files.length)setImages(prev=>[...prev,...files]);e.target.value=''}}/></label></div><button className="btn btn-primary wide" disabled={busy}>{busy?'Yaratilmoqda...':'Yaratish'}</button></form>{catModal&&<InlineCategoryModal categories={categories} close={()=>setCatModal(false)} onCreated={(id,name)=>{setCategories(prev=>[...prev,{id,name}]);setForm(f=>({...f,category_id:id}));setCatModal(false)}}/>}</Modal>;
}

function InlineCategoryModal({categories,close,onCreated}){
  const[form,setForm]=useState({name:'',slug:'',description:'',sort_order:'0',seo_image_url:'',is_active:true,parent_id:''});
  const[busy,setBusy]=useState(false),[error,setError]=useState(''),[uploading,setUploading]=useState(false);
  const parents=categories.filter(c=>!c.parent_id);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{
    const client=getBrowserClient();
    const slug=form.slug.trim()||form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-');
    const{data,error:err}=await client.from('categories').insert({
      name:form.name.trim(),slug,parent_id:form.parent_id||null,
      description:form.description.trim()||null,
      seo_image_url:form.seo_image_url.trim()||null,
      sort_order:Number(form.sort_order)||0,is_active:form.is_active
    }).select('id,name').single();
    if(err)throw err;
    onCreated(data.id,data.name);
  }catch(err){setError(err.message)}finally{setBusy(false)}};
  const uploadImage=async(e)=>{
    const file=e.target.files?.[0];if(!file)return;setUploading(true);
    try{const client=getBrowserClient();const path='categories/'+Date.now()+'-'+file.name.replace(/[^a-z0-9._-]/gi,'_');const{error:ue}=await client.storage.from('logos').upload(path,file,{upsert:true});if(ue)throw ue;const{data:{publicUrl}}=client.storage.from('logos').getPublicUrl(path);setForm(f=>({...f,seo_image_url:publicUrl}))}catch(err){alert(err.message)}finally{setUploading(false);e.target.value=''}
  };
  return <Modal open onClose={close} title="Yangi kategoriya"><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label><span className="label">Ota kategoriya</span><select className="select" value={form.parent_id} onChange={e=>setForm({...form,parent_id:e.target.value})}><option value="">— Asosiy (yuqori daraja) —</option>{parents.map(p=><optgroup key={p.id} label={p.name}><option value={p.id}>{p.name} (ota)</option>{categories.filter(c=>c.parent_id===p.id).map(child=><option key={child.id} value={child.id}>&nbsp;&nbsp;↳ {child.name}</option>)}</optgroup>)}</select></label><label><span className="label">Nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2"/></label><label><span className="label">Slug</span><input className="input" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="avtomatik"/></label><label><span className="label">Tartib</span><input className="input" type="number" min="0" value={form.sort_order} onChange={e=>setForm({...form,sort_order:e.target.value})}/></label><label className="wide"><span className="label">Tavsif</span><input className="input" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><label className="wide"><span className="label">Kategoriya rasmi</span><div style={{display:'flex',gap:8,alignItems:'center'}}><input className="input" value={form.seo_image_url} onChange={e=>setForm({...form,seo_image_url:e.target.value})} placeholder="URL yoki yuklang"/><label className="btn btn-outline btn-sm" style={{whiteSpace:'nowrap',cursor:'pointer'}}>{uploading?'...':'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadImage}/></label>{form.seo_image_url&&<img src={form.seo_image_url} alt="" style={{width:40,height:40,borderRadius:8,objectFit:'cover'}}/>}</div></label><label className="master-check wide"><input type="checkbox" checked={form.is_active} onChange={e=>setForm({...form,is_active:e.target.checked})}/><span>Faol</span></label><button className="btn btn-primary wide" disabled={busy}>{busy?'Yaratilmoqda...':'Yaratish'}</button></form></Modal>;
}
function NewBrandInline({brands,setBrands,onCreated}){
  const[open,setOpen]=useState(false);
  const[form,setForm]=useState({name:'',slug:'',logo_url:'',description:''});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[uploading,setUploading]=useState(false);
  const submit=async e=>{
    e.preventDefault();
    if(!form.name.trim())return;
    setBusy(true);setError('');
    try{
      const slug=form.slug.trim()||form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const{data,error:insErr}=await getBrowserClient().from('brands').insert({
        name:form.name.trim(),slug,logo_url:form.logo_url.trim()||null,description:form.description.trim()||null,is_active:true
      }).select('id,name').single();
      if(insErr)throw insErr;
      if(setBrands)setBrands(prev=>[...prev,data]);
      else brands.push(data);
      onCreated(data);
      setOpen(false);setForm({name:'',slug:'',logo_url:'',description:''});
    }catch(e){setError(e.message)}finally{setBusy(false)}
  };
  const uploadLogo=async(e)=>{
    const file=e.target.files?.[0];if(!file)return;
    setUploading(true);
    try{
      const client=getBrowserClient();
      const path='brands/'+Date.now()+'-'+file.name.replace(/[^a-z0-9._-]/gi,'_');
      const{error:ue}=await client.storage.from('logos').upload(path,file,{upsert:true});
      if(ue)throw ue;
      const{data:{publicUrl}}=client.storage.from('logos').getPublicUrl(path);
      setForm(f=>({...f,logo_url:publicUrl}));
    }catch(er){alert(er.message)}finally{setUploading(false);e.target.value=''}
  };
  if(!open)return <button type="button" className="btn btn-outline" style={{padding:'8px 12px',whiteSpace:'nowrap'}} onClick={()=>setOpen(true)}>+</button>;
  return <div style={{position:'absolute',right:0,top:'100%',zIndex:10,background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:16,display:'grid',gap:10,width:320,boxShadow:'0 8px 24px rgba(0,0,0,.12)'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><b style={{fontSize:13}}>Yangi brend</b><button type="button" style={{border:0,background:'none',fontSize:16,cursor:'pointer'}} onClick={()=>setOpen(false)}>&times;</button></div>
    {error&&<div style={{color:'red',fontSize:11}}>{error}</div>}
    <label><span className="label">Nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required/></label>
    <label><span className="label">Slug</span><input className="input" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="avtomatik-yoki-qolda"/></label>
    <label><span className="label">Logo</span><div style={{display:'flex',gap:8}}><input className="input" value={form.logo_url} onChange={e=>setForm({...form,logo_url:e.target.value})} placeholder="URL yoki fayl yuklang"/><label className="btn btn-outline btn-sm" style={{whiteSpace:'nowrap',cursor:'pointer'}}>{uploading?'...':'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadLogo}/></label></div></label>
    <label><span className="label">Tavsif</span><input className="input" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label>
    <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy?'Yaratilmoqda...':'Saqlash'}</button>
  </div>;
}