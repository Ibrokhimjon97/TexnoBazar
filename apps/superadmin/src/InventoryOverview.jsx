import React,{useCallback,useEffect,useMemo,useState}from'react';
import RichTextEditor from'./RichTextEditor';
import{AlertTriangle,Bluetooth,Boxes,CheckSquare,Download,Pencil,Plus,Printer,RefreshCw,Search,Store,Trash2,Upload,Warehouse,X}from'lucide-react';
import{DualPrice,DualPriceInput,Empty,Modal,QrScanButton,Status,useExchangeRate,DetongerPrintModal,formatSecretCostCode}from'@texnobazar/ui';
import{bulkDeleteProducts,deleteCategoryProducts,getBrowserClient,listInventoryBalances,listInventorySearchSellers,listMasterRecords,searchInventoryUnits}from'@texnobazar/data';
import ProductCatalog,{ProductEditor}from'./ProductCatalog';

const PAGE_SIZE=100;
const STOREFRONT=(import.meta.env?.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app').replace(/\/$/,'');
const unitStatusLabel=status=>({available:'Sotuvga tayyor',reserved:'Band',in_transit:'Yo‘lda',sold:'Sotilgan',returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:'Ta’mirda'}[status]||status);
const initial={query:'',qr:'',serial:'',batch:'',sku:'',model:'',color:'',size:'',min_price:'',max_price:'',branch:'',location:'',status:'',seller:'',from:'',to:'',category:'',availability:''};
const compact=value=>Object.fromEntries(Object.entries(value).filter(([,item])=>item!==''&&item!=null));
const nextDay=value=>{const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString()};
const unitFilters=form=>compact({query:form.query,qr:form.qr,serial:form.serial,batch:form.batch,sku:form.sku,model:form.model,color:form.color,size:form.size,min_price:form.min_price,max_price:form.max_price,branch_ids:form.branch?[form.branch]:[],location_ids:form.location?[form.location]:[],statuses:form.status?[form.status]:[],seller_ids:form.seller?[form.seller]:[],from:form.from?`${form.from}T00:00:00Z`:'',to:form.to?nextDay(form.to):''});

export default function InventoryOverview({toast}){
  const[tab,setTab]=useState('catalog');
  if(tab==='catalog')return <section><div className="inventory-tabs"><button className={tab==='catalog'?'active':''} onClick={()=>setTab('catalog')}>Mahsulot katalogi</button><button className={tab==='balance'?'active':''} onClick={()=>setTab('balance')}>Qoldiq (Balans)</button><button className={tab==='units'?'active':''} onClick={()=>setTab('units')}>Individual birliklar</button></div><ProductCatalog toast={toast}/></section>;
  return <InventoryBalanceView toast={toast} tab={tab} setTab={setTab}/>;
}
function InventoryBalanceView({toast,tab,setTab}){
  const rate=useExchangeRate();
  const[mode,setMode]=useState('summary');
  const[rows,setRows]=useState([]);
  const[totalRows,setTotalRows]=useState(0);
  const[aggregates,setAggregates]=useState({totalOnHand:0,totalValue:0,totalCost:0});
  const[refs,setRefs]=useState({branches:[],locations:[],employees:[],categories:[]});
  const[form,setForm]=useState(initial);
  const[applied,setApplied]=useState(initial);
  const[page,setPage]=useState(1);
  const[loading,setLoading]=useState(true);
  const[selectedProduct,setSelectedProduct]=useState(null),[editingProduct,setEditingProduct]=useState(null),[newProductModal,setNewProductModal]=useState(false);
  const[error,setError]=useState('');
  const[selected,setSelected]=useState([]);
  const[bulkDeleting,setBulkDeleting]=useState(false);
  const[categoryDeleting,setCategoryDeleting]=useState(false);

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
      if(mode==='summary'&&result){
        setAggregates({
          totalOnHand: Number(result.total_on_hand || 0),
          totalValue: Number(result.total_value || 0),
          totalCost: Number(result.total_cost || 0)
        });
      }
    }catch(currentError){setRows([]);setTotalRows(0);setError(currentError.message||'Qoldiq yuklanmadi')}
    finally{setLoading(false)}
  },[mode,applied,page]);

  useEffect(()=>{load()},[load]);

  const apply=event=>{event?.preventDefault();setPage(1);setSelected([]);setApplied({...form})};
  const reset=()=>{setForm(initial);setApplied(initial);setSelected([]);setPage(1)};
  const switchMode=next=>{setMode(next);setSelected([]);setPage(1)};
  const totalPages=Math.max(1,Math.ceil(totalRows/PAGE_SIZE));
  const locations=refs.locations.filter(item=>!form.branch||item.branch_id===form.branch);
  const activeCategoryObj=useMemo(()=>refs.categories.find(c=>c.id===applied.category),[refs.categories,applied.category]);

  const summary=useMemo(()=>mode==='summary'
    ?rows.reduce((result,item)=>({on:result.on+Number(item.on_hand),reserved:result.reserved+Number(item.reserved),value:result.value+Number(item.on_hand)*Number(item.retail_price),cost:result.cost+Number(item.on_hand)*Number(item.cost_price||0),types:result.types.add(item.product_id)}),{on:0,reserved:0,value:0,cost:0,types:new Set()})
    :rows.reduce((result,item)=>({available:result.available+(item.status==='available'?1:0),reserved:result.reserved+(item.status==='reserved'?1:0),value:result.value+Number((item.promotion_price??item.retail_price)||0)}),{available:0,reserved:0,value:0}),[rows,mode]);

  const editProduct=item=>{setEditingProduct(item)};
  const deleteProduct=async item=>{if(!confirm(item.product_name+" mahsulotini ochirasizmi?"))return;try{const client=getBrowserClient();const{error:err}=await client.rpc('delete_product_cascade',{p_product_id:item.product_id});if(err)throw err;if(toast)toast('Mahsulot ochirildi');setRows(prev=>prev.filter(r=>r.product_id!==item.product_id))}catch(e){setError(e.message)}};

  const uniqueProductIds=useMemo(()=>[...new Set(rows.map(r=>r.product_id).filter(Boolean))],[rows]);
  const allSelected=uniqueProductIds.length>0&&uniqueProductIds.every(id=>selected.includes(id));
  const toggleSelect=id=>setSelected(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const toggleSelectAll=()=>setSelected(allSelected?[]:[...uniqueProductIds]);

  const bulkDelete=async()=>{
    if(!selected.length)return;
    const count=selected.length;
    if(!confirm(`${count} ta mahsulotni o‘chirishni tasdiqlaysizmi?\n\nDIQQAT: Ushbu mahsulotlar va ularning ombordagi barcha birliklari butunlay o‘chiriladi!`))return;
    setBulkDeleting(true);setError('');
    try{
      const res=await bulkDeleteProducts(selected);
      const done=res?.deleted_count??selected.length;
      setSelected([]);
      if(toast)toast(`${done} ta mahsulot o‘chirildi`);
      await load();
    }catch(e){
      try{
        const client=getBrowserClient();
        let done=0;
        for(const id of selected){
          await client.rpc('delete_product_cascade',{p_product_id:id});
          done++;
        }
        setSelected([]);
        if(toast)toast(`${done} ta mahsulot o‘chirildi`);
        await load();
      }catch(err2){setError(err2?.message||e?.message)}
    }finally{setBulkDeleting(false)}
  };

  const deleteActiveCategoryProducts=async()=>{
    if(!applied.category||!activeCategoryObj)return;
    const client=getBrowserClient();
    const subCats=refs.categories.filter(c=>c.parent_id===applied.category).map(c=>c.id);
    const catIds=[applied.category,...subCats];
    const{count,error:cErr}=await client.from('products').select('id',{count:'exact',head:true}).in('category_id',catIds);
    if(cErr){setError(cErr.message);return}
    const prodCount=count||0;
    if(prodCount===0){
      alert(`“${activeCategoryObj.name}” kategoriyasida tovar topilmadi.`);
      return;
    }
    if(!confirm(`DIQQAT!\n\n“${activeCategoryObj.name}” kategoriyasidagi BARCHA (${prodCount} ta) tovarlarni butunlay o‘chirishni tasdiqlaysizmi?\n\nBu amal qaytarilmaydi!`))return;
    setCategoryDeleting(true);setError('');
    try{
      const res=await deleteCategoryProducts(applied.category,true);
      const done=res?.deleted_count??prodCount;
      setSelected([]);
      if(toast)toast(`“${activeCategoryObj.name}” kategoriyasidagi ${done} ta tovar o‘chirildi`);
      await load();
    }catch(e){
      try{
        const{data:prods}=await client.from('products').select('id').in('category_id',catIds);
        let done=0;
        for(const p of(prods||[])){
          await client.rpc('delete_product_cascade',{p_product_id:p.id});
          done++;
        }
        setSelected([]);
        if(toast)toast(`“${activeCategoryObj.name}” kategoriyasidagi ${done} ta tovar o‘chirildi`);
        await load();
      }catch(err2){setError(err2?.message||e?.message)}
    }finally{setCategoryDeleting(false)}
  };

  return <>
    <div className="inventory-tabs"><button className={tab==='catalog'?'active':''} onClick={()=>setTab('catalog')}>Mahsulot katalogi</button><button className={tab==='balance'?'active':''} onClick={()=>setTab('balance')}>Qoldiq (Balans)</button><button className={tab==='units'?'active':''} onClick={()=>setTab('units')}>Individual birliklar</button></div>
    <div className="page-head between"><div><h2>Ombor va advanced qidiruv</h2><p>Balans yoki QR/seriya/partiya/model/rang/o‘lcham/narx/sotuvchi/sana bo‘yicha individual birliklar</p></div><button className="btn btn-outline" onClick={load}><RefreshCw/>Yangilash</button><button className="btn btn-primary" onClick={()=>setNewProductModal(true)}><Plus/> Yangi tovar</button></div>
    <div className="mini-kpis">{mode==='summary'?<><div><Boxes/><span><b>{totalRows}</b>Tovar turlari</span></div><div><Warehouse/><span><b>{aggregates.totalOnHand}</b>Mavjud tovarlar</span></div><div><Boxes/><span><b><DualPrice value={aggregates.totalValue} rate={rate}/></b>Sotish narxi</span></div><div><Warehouse/><span><b><DualPrice value={aggregates.totalCost} rate={rate}/></b>Tannarxi</span></div></>:<><div><Boxes/><span><b>{totalRows}</b>Tovar turlari</span></div><div><Warehouse/><span><b>{summary.available}</b>Mavjud tovarlar</span></div><div><Boxes/><span><b><DualPrice value={summary.value} rate={rate}/></b>Sotish narxi</span></div><div><Warehouse/><span><b><DualPrice value={summary.cost} rate={rate}/></b>Tannarxi</span></div></>}</div>
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

      {activeCategoryObj&&mode==='summary'&&(
        <div className="category-action-strip">
          <span>Kategoriya: <b>{activeCategoryObj.name}</b> ({totalRows} ta mahsulot)</span>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <button type="button" className="btn btn-outline btn-xs" onClick={()=>setSelected([...uniqueProductIds])}>Ushbu tovarlarni tanlash</button>
            <button type="button" className="btn btn-danger-outline btn-xs" onClick={deleteActiveCategoryProducts} disabled={categoryDeleting}>
              <Trash2 size={13}/>{categoryDeleting?'O‘chirilmoqda…':'Kategoriyadagi barcha tovarlarni o‘chirish'}
            </button>
          </div>
        </div>
      )}

      {selected.length>0&&(
        <div className="bulk-actions-bar">
          <div className="bulk-actions-info">
            <CheckSquare size={16}/>
            <span><b>{selected.length} ta</b> mahsulot tanlandi</span>
          </div>
          <div className="bulk-actions-btns">
            <button type="button" className="btn btn-danger btn-sm" onClick={bulkDelete} disabled={bulkDeleting}>
              <Trash2 size={14}/>
              {bulkDeleting?'O‘chirilmoqda…':`Tanlanganlarni o‘chirish (${selected.length})`}
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={()=>setSelected([])}>
              Bekor qilish
            </button>
          </div>
        </div>
      )}

      {loading?<div className="employee-loading">Qoldiq yuklanmoqda…</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:rows.length===0?<Empty title="Qoldiq topilmadi" text="Filtrlarga mos mahsulot birliklari yo‘q."/>:mode==='summary'?<BalanceTable rows={rows} selected={selected} toggleSelect={toggleSelect} allSelected={allSelected} toggleSelectAll={toggleSelectAll} onEdit={editProduct} onDelete={deleteProduct} onSelect={setSelectedProduct} rate={rate}/>:<UnitTable rows={rows} rate={rate}/>}
      {!loading&&!error&&totalRows>0&&<><div className="unit-page-note">{(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,totalRows)} / {totalRows}</div><div className="inventory-search-pagination"><span>{page}-sahifa / {totalPages}</span><div><button className="btn btn-outline" disabled={page<=1} onClick={()=>setPage(current=>current-1)}>Oldingi</button><button className="btn btn-outline" disabled={page>=totalPages} onClick={()=>setPage(current=>current+1)}>Keyingi</button></div></div></>}
    </div>

    {newProductModal&&<NewProductModal close={()=>setNewProductModal(false)} toast={toast} onCreated={()=>{setNewProductModal(false);load()}}/>}
    {editingProduct&&<ProductEditor open={Boolean(editingProduct)} close={()=>setEditingProduct(null)} product={editingProduct} refs={refs} toast={toast} saved={load} RichTextEditor={RichTextEditor}/>}
    {selectedProduct&&<ProductDetailModal product={selectedProduct} close={()=>setSelectedProduct(null)} toast={toast} rate={rate} onEdit={editProduct}/>}
  </>
}

function BalanceTable({rows,selected=[],toggleSelect,allSelected=false,toggleSelectAll,onEdit,onDelete,onSelect,rate}){
  return <div className="table-wrap"><table className="table">
    <thead>
      <tr>
        <th style={{width:38,textAlign:'center'}}><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="Barchasini tanlash"/></th>
        <th>Mahsulot</th><th>Filial</th><th>Joylashuv</th><th>Turi</th><th>Jami</th><th>Mavjud</th><th>Sotish narxi</th><th>Tannarxi</th><th>Amal</th>
      </tr>
    </thead>
    <tbody>{rows.map(item=><tr key={`${item.location_id}-${item.product_id}`} className={`clickable-row ${selected.includes(item.product_id)?'selected-row':''}`} onClick={()=>onSelect&&onSelect(item)}>
      <td style={{textAlign:'center'}} onClick={e=>e.stopPropagation()}><input type="checkbox" checked={selected.includes(item.product_id)} onChange={()=>toggleSelect(item.product_id)}/></td>
      <td><div className="product-cell">{item.image?<img src={item.image} alt=""/>:<span className="product-placeholder"><Boxes/></span>}<div><b>{item.product_name}</b><span>{item.sku}</span></div></div></td>
      <td>{item.branch_name}</td><td>{item.location_name}</td><td><Status type={item.location_type==='warehouse'?'blue':'green'}>{item.location_type}</Status></td>
      <td><b>{Number(item.on_hand)}</b></td><td><b>{Number(item.available)}</b></td>
      <td><DualPrice value={Number(item.on_hand)*Number(item.retail_price)} rate={rate}/></td>
      <td><DualPrice value={Number(item.on_hand)*Number(item.cost_price||0)} rate={rate}/></td>
      <td><div className="master-actions" onClick={e=>e.stopPropagation()}><button className="icon-btn" title="Tahrirlash" onClick={()=>onEdit&&onEdit(item)}><Pencil size={14}/></button><button className="icon-btn danger-icon" title="Ochirish" onClick={()=>onDelete&&onDelete(item)}><Trash2 size={14}/></button></div></td>
    </tr>)}</tbody>
  </table></div>;
}

function UnitTable({rows,rate}){
  const[printUnit,setPrintUnit]=useState(null);
  return <>
    <div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>QR / seriya</th><th>Partiya</th><th>Filial / joy</th><th>Status</th><th>Narx</th><th>Sotilgan sana</th><th>Chop</th></tr></thead><tbody>{rows.map(item=><tr key={item.id}><td><b>{item.product_name}</b><small>{item.sku}</small></td><td><code>{item.qr_code}</code><small>{item.serial_number||'—'}</small></td><td>{item.batch_reference||'—'}</td><td>{item.branch_name}<small>{item.location_name}</small></td><td><Status type={item.status==='available'?'green':item.status==='sold'?'blue':'orange'}>{item.status}</Status></td><td><DualPrice value={Number((item.promotion_price??item.retail_price)||0)} rate={rate}/></td><td>{item.sold_at?new Date(item.sold_at).toLocaleString('uz-UZ'):'—'}</td><td><button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:11,display:'inline-flex',alignItems:'center',gap:4}} title="Termoprinter (Detonger / MHT-L80G) orqali chop etish" onClick={()=>setPrintUnit({ id: item.id, title: item.product_name, code: item.qr_code, cost_usd: formatSecretCostCode({ cost: item.unit_cost || item.cost_price, costUsd: item.cost_price_usd || item.unit_cost_usd, currency: item.currency || 'USD' }), date: new Date().toLocaleDateString('uz-UZ'), batch: item.batch_reference })}><Bluetooth size={12} color="var(--orange)"/><Printer size={12}/></button></td></tr>)}</tbody></table></div>
    <DetongerPrintModal
      open={Boolean(printUnit)}
      onClose={()=>setPrintUnit(null)}
      labels={printUnit?[printUnit]:[]}
      batchTitle={printUnit?.batch?`Partiya #${printUnit.batch}`:''}
    />
  </>;
}

function ProductDetailModal({product,close,toast,rate,onEdit}){
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
    setDesc(p?.description||'');setVideoUrl(p?.video_url||'');
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
    await updateProductTextFields(product.product_id,{videoUrl});
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
    const rawCost = (unit.unit_cost_usd != null && Number(unit.unit_cost_usd) > 0)
    const costNumStr = formatSecretCostCode({
      cost: detail?.cost_price || unit.unit_cost || '',
      costUsd: unit.unit_cost_usd || detail?.cost_price_usd || '',
      currency: detail?.currency || 'USD'
    });
    const costParam = costNumStr ? '?c=' + encodeURIComponent(costNumStr) : '';
    const url=`${STOREFRONT}/qr/${encodeURIComponent(unit.qr_code)}${costParam}`;
    const canvas=await QRCode.toCanvas(url,{width:300,margin:2,color:{dark:'#000000',light:'#ffffff'}});
    const labeled=document.createElement('canvas');
    labeled.width=300;labeled.height=360;
    const ctx=labeled.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,300,360);
    ctx.drawImage(canvas,0,0);
    ctx.fillStyle='#000';ctx.font='bold 14px monospace';ctx.textAlign='center';
    ctx.fillText(unit.qr_code||'',150,318);
    if (costNumStr) {
      ctx.font='bold 13px monospace';
      ctx.fillStyle='#333';
      ctx.fillText(costNumStr,150,336);
    }
    ctx.font='10px sans-serif';ctx.fillStyle='#555';
    ctx.fillText(detail?.name||'',150,costNumStr?354:336);
    const link=document.createElement('a');
    link.download=(unit.qr_code||'qr')+'.png';
    link.href=labeled.toDataURL();link.click();
  };

  if(loading)return <Modal open onClose={close} title="Yuklanmoqda..."><div className="employee-loading">Ma'lumotlar yuklanmoqda...</div></Modal>;
  if(!detail)return <Modal open onClose={close} title="Xatolik"><p>Mahsulot topilmadi</p></Modal>;

  return <Modal open onClose={close} title={detail.name+' ('+units.length+' dona)'}><div className="product-detail-modal">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,marginBottom:'1rem',flexWrap:'wrap'}}>
      <div className="product-info-rows" style={{flex:1,marginBottom:0}}>
        <div><span>SKU:</span><b>{detail.sku}</b></div>
        <div><span>Kategoriya:</span><b>{detail.categories?.name||'-'}</b></div>
        <div><span>Brend:</span><b>{detail.brands?.name||'-'}</b></div>
        <div><span>Sotish narxi:</span><b><DualPrice value={Number(detail.retail_price||0)} rate={rate}/></b></div>
        <div><span>Tannarx:</span><b><DualPrice value={Number(detail.cost_price||0)} rate={rate}/></b></div>
        <div><span>Jami soni:</span><b>{units.length} dona</b></div>
      </div>
      <button type="button" className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={()=>{close();onEdit?.(product);}}>
        <Pencil size={14}/> Tovarni to‘liq tahrirlash
      </button>
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
    <div className="product-media-grid">{media.map(m=><div key={m.id} className="product-media-item" style={{position:'relative',border:m.is_primary?'2px solid var(--orange,#ea580c)':'1px solid var(--border,#e2e8f0)',borderRadius:8,overflow:'hidden'}}><img src={m.public_url} alt="" onError={e=>{e.target.style.display='none'}}/>{m.is_primary?<span style={{position:'absolute',bottom:2,left:2,right:2,background:'var(--orange,#ea580c)',color:'#fff',fontSize:8,padding:'1px 3px',borderRadius:3,fontWeight:700,textAlign:'center',display:'block'}}>✓ Asosiy</span>:<button type="button" title="Asosiy qilish" style={{position:'absolute',bottom:2,left:2,right:2,background:'rgba(0,0,0,.75)',color:'#fdba74',fontSize:8,border:0,borderRadius:3,padding:'1px 3px',cursor:'pointer',fontWeight:600,textAlign:'center'}} onClick={async()=>{try{const{setPrimaryProductMedia}=await import('@texnobazar/data');await setPrimaryProductMedia(product.product_id,m.id);await loadDetail();if(toast)toast('Asosiy rasm belgilandi')}catch(e){alert(e.message)}}}>★ Asosiy</button>}<button className="media-delete-btn" title="Ochirish" onClick={async()=>{if(!confirm('Bu rasmni ochirasizmi?'))return;try{const{deleteProductMedia}=await import('@texnobazar/data');await deleteProductMedia(m.id);await loadDetail();if(toast)toast('Rasm ochirildi')}catch(err){alert(err.message)}}}><Trash2 size={12}/></button></div>)}</div>
    <label className="btn btn-outline btn-sm" style={{marginTop:'.5rem'}}><Upload size={14}/> {uploading?'Yuklanmoqda...':'Rasm yuklash'}<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={uploadImage} disabled={uploading}/></label>

    <h4 style={{marginTop:'1rem'}}>Video (YouTube)</h4>
    <div style={{display:'flex',gap:8}}><input className="input" value={videoUrl} onChange={e=>setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."/><button className="btn btn-primary btn-sm" onClick={saveVideo}>Saqlash</button></div>

    <h4 style={{marginTop:'1rem'}}>Tavsif</h4>
    {editMode?<><RichTextEditor value={desc} onChange={v=>setDesc(v)}/><div style={{display:'flex',gap:8,marginTop:8}}><button className="btn btn-primary btn-sm" onClick={saveDesc}>Saqlash</button><button className="btn btn-outline btn-sm" onClick={()=>setEditMode(false)}>Bekor</button></div></>:<><div className="muted" style={{whiteSpace:'pre-wrap'}} dangerouslySetInnerHTML={{__html:desc||'Tavsif kiritilmagan'}}/><button className="btn btn-outline btn-sm" onClick={()=>setEditMode(true)}><Pencil size={14}/> Tahrirlash</button></>}
  </div></Modal>;
}

export function NewProductModal({close,toast,onCreated}){
  return <ProductEditor open={true} close={close} product={null} toast={toast} saved={onCreated}/>;
}