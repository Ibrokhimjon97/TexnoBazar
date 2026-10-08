import React,{useEffect,useMemo,useRef,useState}from'react';
import RichTextEditor from'./RichTextEditor';
import{AlertTriangle,Archive,Boxes,CheckCircle2,CheckSquare,Eye,FileSpreadsheet,Globe2,ImagePlus,Package,Pencil,Plus,RefreshCw,Search,Star,Trash2,TrendingDown,Upload,X}from'lucide-react';
import{ColorVariantEditor,DualPrice,DualPriceInput,Empty,Modal,ProductExcelImportModal,Status,formatMoney,useExchangeRate}from'@texnobazar/ui';
import{archiveCatalogProduct,bulkDeleteProducts,bulkPublishInventoryProducts,deleteCategoryProducts,deleteProductMedia,getBrowserClient,getCatalogProduct,listCatalogProducts,listInventoryCatalogCandidates,listMasterRecords,saveCatalogProduct,saveProductVariants,setCatalogProductPublication,setPrimaryProductMedia,uploadProductMedia}from'@texnobazar/data';
const initial={id:'',sku:'',barcode:'',category_id:'',brand_id:'',name:'',slug:'',description:'',description_blocks:[],seo_title:'',seo_description:'',seo_image_url:'',status:'draft',track_individual_units:true,cost_price:'0',retail_price:'',wholesale_price:'',promotion_price:'',minimum_sale_price:'0',compare_at_price:'',tax_rate:'0'};
const statusLabel={draft:'Qoralama',active:'Faol',archived:'Arxiv'};
const slugify=v=>v.trim().toLowerCase().replace(/[‘’ʻʼ']/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const errorText=e=>{const m=String(e?.message||'');if(m.includes('duplicate key'))return'SKU, shtrix-kod yoki slug avval mavjud.';if(m.includes('row-level'))return'Bu amal uchun ruxsat yo‘q.';return m||'Amal bajarilmadi.'};
export default function ProductCatalog({toast,onCreate}){
 const rate=useExchangeRate();
 const[rows,setRows]=useState([]),[total,setTotal]=useState(0),[refs,setRefs]=useState({categories:[],brands:[],attributes:[]}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState(''),[category,setCategory]=useState(''),[brand,setBrand]=useState(''),[page,setPage]=useState(1),[open,setOpen]=useState(false),[product,setProduct]=useState(null),loadGeneration=useRef(0);
 const[importModal,setImportModal]=useState(false);
 const[selected,setSelected]=useState([]);
 const[bulkDeleting,setBulkDeleting]=useState(false);
 const[categoryDeleting,setCategoryDeleting]=useState(false);
 const pageSize=10;

 const activeCategoryObj=useMemo(()=>(refs.categories||[]).find(x=>x.id===category),[refs.categories,category]);

 const load=async()=>{const generation=++loadGeneration.current;setLoading(true);setError('');try{const[result,categories,brands,attributes]=await Promise.all([listCatalogProducts({query,status,categoryId:category,brandId:brand,page,pageSize}),listMasterRecords('categories'),listMasterRecords('brands'),listMasterRecords('attribute_definitions')]);if(generation!==loadGeneration.current)return;setRows(result.items||[]);setTotal(Number(result.total)||0);setRefs({categories,brands,attributes})}catch(e){if(generation===loadGeneration.current)setError(errorText(e))}finally{if(generation===loadGeneration.current)setLoading(false)}};
 useEffect(()=>{setPage(1);setSelected([])},[query,status,category,brand]);
 useEffect(()=>{const timer=setTimeout(load,query?300:0);return()=>{clearTimeout(timer);loadGeneration.current+=1}},[query,status,category,brand,page]);

 const toggleSelect=id=>setSelected(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
 const allCurrentSelected=rows.length>0&&rows.every(r=>selected.includes(r.id));
 const toggleSelectAll=()=>{
   if(allCurrentSelected){
     const rowIds=new Set(rows.map(r=>r.id));
     setSelected(prev=>prev.filter(id=>!rowIds.has(id)));
   }else{
     setSelected(prev=>[...new Set([...prev,...rows.map(r=>r.id)])]);
   }
 };

 const selectAllFiltered=async()=>{
   try{
     const client=getBrowserClient();
     let q=client.from('products').select('id');
     if(query)q=q.or(`name.ilike.%${query}%,sku.ilike.%${query}%,barcode.ilike.%${query}%`);
     if(status)q=q.eq('status',status);
     if(category){
       const subCats=(refs.categories||[]).filter(c=>c.parent_id===category).map(c=>c.id);
       const catIds=[category,...subCats];
       q=q.in('category_id',catIds);
     }
     if(brand)q=q.eq('brand_id',brand);
     const{data,error:qErr}=await q;
     if(qErr)throw qErr;
     const ids=(data||[]).map(x=>x.id);
     setSelected(ids);
     if(toast)toast(`${ids.length} ta mahsulot tanlandi`);
   }catch(e){setError(errorText(e))}
 };

 const bulkDelete=async()=>{
   if(!selected.length)return;
   const count=selected.length;
   if(!confirm(`${count} ta mahsulotni butunlay o‘chirishni tasdiqlaysizmi?\n\nDIQQAT: Mahsulotlar, ularning rasmlari, variantlari va ombor qoldiqlari kaskad usulida butunlay o‘chiriladi!`))return;
   setBulkDeleting(true);setError('');
   try{
     const res=await bulkDeleteProducts(selected);
     const done=res?.deleted_count??selected.length;
     setSelected([]);
     if(toast)toast(`${done} ta mahsulot muvaffaqiyatli o‘chirildi`);
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
       if(toast)toast(`${done} ta mahsulot muvaffaqiyatli o‘chirildi`);
       await load();
     }catch(err2){setError(errorText(err2||e))}
   }finally{setBulkDeleting(false)}
 };

 const deleteActiveCategoryProducts=async()=>{
   if(!category||!activeCategoryObj)return;
   const client=getBrowserClient();
   const subCats=(refs.categories||[]).filter(c=>c.parent_id===category).map(c=>c.id);
   const catIds=[category,...subCats];
   const{count,error:cErr}=await client.from('products').select('id',{count:'exact',head:true}).in('category_id',catIds);
   if(cErr){setError(errorText(cErr));return}
   const prodCount=count||0;
   if(prodCount===0){
     alert(`“${activeCategoryObj.name}” kategoriyasida hech qanday mahsulot yo‘q.`);
     return;
   }
   if(!confirm(`DIQQAT!\n\n“${activeCategoryObj.name}” kategoriyasidagi BARCHA (${prodCount} ta) tovarlarni o‘chirishni tasdiqlaysizmi?\n\nBu amal ushbu tovarlar bilan bog‘liq barcha ma'lumotlarni butunlay o‘chiradi va uni qaytarib bo‘lmaydi!`))return;
   setCategoryDeleting(true);setError('');
   try{
     const res=await deleteCategoryProducts(category,true);
     const done=res?.deleted_count??prodCount;
     setSelected([]);
     if(toast)toast(`“${activeCategoryObj.name}” kategoriyasidagi ${done} ta mahsulot o‘chirildi`);
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
       if(toast)toast(`“${activeCategoryObj.name}” kategoriyasidagi ${done} ta mahsulot o‘chirildi`);
       await load();
     }catch(err2){setError(errorText(err2||e))}
   }finally{setCategoryDeleting(false)}
 };

 const edit=async row=>{setError('');try{setProduct(await getCatalogProduct(row.id));setOpen(true)}catch(e){setError(errorText(e))}};
 const create=()=>{if(onCreate){onCreate();return}setProduct(null);setOpen(true)};
 const publish=async(row,value)=>{try{await setCatalogProductPublication(row.id,value);toast(value?'Mahsulot saytga chiqarildi':'Mahsulot saytdan yashirildi');await load()}catch(e){setError(errorText(e))}};
 const archive=async row=>{if(!confirm(`“${row.name}” mahsulotini arxivlaysizmi?`))return;try{await archiveCatalogProduct(row.id);toast('Mahsulot arxivlandi');await load()}catch(e){setError(errorText(e))}};
 const remove=async row=>{if(!confirm(row.name+" mahsulotini ochirmoqchimisiz?"))return;try{setRows(prev=>prev.filter(r=>r.id!==row.id));setTotal(t=>t-1);const{getBrowserClient}=await import('@texnobazar/data');const client=getBrowserClient();const{error:delErr}=await client.rpc('delete_product_cascade',{p_product_id:row.id});if(delErr)throw delErr;toast('Mahsulot ochirildi')}catch(e){setError(errorText(e));await load()}};
 const pages=Math.max(1,Math.ceil(total/pageSize));
 return <><div className="page-head between"><div><h2>Mahsulotlar</h2><p>Katalog, narx, atribut va Cloudflare R2 rasmlarini boshqaring</p></div><div style={{display:'flex',gap:8,alignItems:'center'}}><button type="button" className="btn btn-outline" onClick={()=>setImportModal(true)}><FileSpreadsheet size={16}/> Exceldan import qilish</button><button className="btn btn-primary" onClick={create}><Plus/> Mahsulot qo‘shish</button></div></div><div className="mini-kpis"><div><Package/><span><b>{total}</b>Jami mahsulot</span></div><div><Eye/><span><b>{rows.filter(x=>x.is_published).length}</b>Sahifadagi nashrlar</span></div><div><TrendingDown/><span><b>{rows.filter(x=>Number(x.available_stock)<=0).length}</b>Qoldiqsiz</span></div></div>
 <div className="card data-card">
   <CatalogFilters {...{query,setQuery,status,setStatus,category,setCategory,brand,setBrand,refs,load,activeCategoryObj,selectAllFiltered,deleteActiveCategoryProducts,categoryDeleting,total}}/>
   {selected.length>0&&(
     <div className="bulk-actions-bar">
       <div className="bulk-actions-info">
         <CheckSquare size={16}/>
         <span><b>{selected.length} ta</b> mahsulot tanlandi</span>
         {total>rows.length&&selected.length<total&&(
           <button type="button" className="btn btn-outline btn-xs" onClick={selectAllFiltered}>
             Filtrdagi barcha {total} ta mahsulotni tanlash
           </button>
         )}
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
   {loading?<div className="employee-loading">Mahsulotlar yuklanmoqda…</div>:error?<div className="catalog-error"><AlertTriangle/><span>{error}</span><button onClick={load}>Qayta urinish</button></div>:rows.length===0?<Empty title="Mahsulot topilmadi" text="Yangi mahsulot qo‘shing yoki filtrlarni o‘zgartiring."/>:<ProductTable rows={rows} selected={selected} toggleSelect={toggleSelect} allCurrentSelected={allCurrentSelected} toggleSelectAll={toggleSelectAll} edit={edit} publish={publish} remove={remove} rate={rate}/>}
   <div className="pagination"><span>{total?`${(page-1)*pageSize+1}–${Math.min(page*pageSize,total)} / ${total} ta`:'0 ta'}</span><div><button disabled={page===1} onClick={()=>setPage(x=>x-1)}>‹</button><button className="active">{page}</button><button disabled={page===pages} onClick={()=>setPage(x=>x+1)}>›</button></div></div>
 </div>
 <ProductEditor open={open} close={()=>{setOpen(false);load()}} product={product} refs={refs} saved={async()=>{setOpen(false);toast('Mahsulot saqlandi');await load()}} toast={toast}/>
 <ProductExcelImportModal open={importModal} onClose={()=>setImportModal(false)} onImported={load} toast={toast}/></>;
}
export function InventoryPublishPanel({onCreate,onPublished,toast}){
 const[open,setOpen]=useState(false),[rows,setRows]=useState([]),[query,setQuery]=useState(''),[onlyUnpublished,setOnlyUnpublished]=useState(true),[selected,setSelected]=useState([]),[loading,setLoading]=useState(false),[publishing,setPublishing]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null),requestGeneration=useRef(0);
 const load=async()=>{const generation=++requestGeneration.current;setLoading(true);setError('');try{const data=await listInventoryCatalogCandidates({query,onlyUnpublished,pageSize:100});if(generation!==requestGeneration.current)return;setRows(data.items||[]);setSelected(current=>current.filter(id=>(data.items||[]).some(row=>row.id===id)))}catch(current){if(generation===requestGeneration.current)setError(errorText(current))}finally{if(generation===requestGeneration.current)setLoading(false)}};
 useEffect(()=>{if(!open){requestGeneration.current+=1;return};const timer=setTimeout(load,query?250:0);return()=>{clearTimeout(timer);requestGeneration.current+=1}},[open,query,onlyUnpublished]);
 const ready=rows.filter(row=>(row.publish_issues||[]).length===0&&!row.is_published),readyIds=ready.map(row=>row.id),allReadySelected=readyIds.length>0&&readyIds.every(id=>selected.includes(id));
 const toggle=id=>setSelected(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
 const publish=async()=>{if(!selected.length)return;setPublishing(true);setError('');setResult(null);try{const response=await bulkPublishInventoryProducts(selected),failed=(response.results||[]).filter(item=>!item.ok),failedIds=failed.map(item=>String(item.id));setResult({...response,results:response.results||[]});setSelected(failedIds);toast(failed.length?`${response.published_count} ta nashr qilindi, ${failed.length} ta mahsulotni tuzatish kerak`:`${response.published_count} ta inventory mahsuloti saytga chiqarildi`);await Promise.all([load(),onPublished()])}catch(current){setError(errorText(current))}finally{setPublishing(false)}};
 return <section className={`card inventory-publish ${open?'open':''}`}><button className="inventory-publish-head" onClick={()=>setOpen(value=>!value)}><span><Boxes/></span><div><b>Ombor va do‘kondan saytga import</b><small>Kirim yoki inventarizatsiyada mavjud bo‘lgan real mahsulotlarni dublikatsiyasiz storefrontga chiqaring.</small></div><strong>{open?'Yopish':'Mahsulotlarni tanlash'}</strong></button>{open&&<div className="inventory-publish-body"><div className="inventory-publish-steps"><span><i>1</i> Real qoldiqli mahsulotni tanlang</span><span><i>2</i> Rasm va atribut tayyorligini tekshiring</span><span><i>3</i> Saytga nashr qiling</span></div><div className="inventory-publish-toolbar"><label><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Nomi, SKU yoki shtrix-kod"/></label><label className="master-check"><input type="checkbox" checked={onlyUnpublished} onChange={e=>setOnlyUnpublished(e.target.checked)}/><span>Faqat saytda yo‘qlari</span></label><button className="btn btn-outline" onClick={onCreate}><Plus/> Yangi mahsulot yaratish</button></div>{error&&<div className="catalog-error"><AlertTriangle/><span>{error}</span><button onClick={load}>Qayta urinish</button></div>}{result&&<div className={result.failed_count?'inventory-publish-result warning':'inventory-publish-result'}><CheckCircle2/><span><b>{result.published_count} ta nashr qilindi</b>{result.failed_count>0&&<><small>{result.failed_count} ta mahsulot tekshiruvdan o‘tmadi; ular tanlangan holda qoldi.</small><ul>{(result.results||[]).filter(item=>!item.ok).map(item=><li key={item.id}><strong>{rows.find(row=>String(row.id)===String(item.id))?.name||item.id}</strong>: {item.error||'Nashr qilib bo‘lmadi'}</li>)}</ul></>}</span></div>}{loading?<div className="employee-loading">Real inventory mahsulotlari yuklanmoqda…</div>:rows.length===0?<Empty title="Import uchun mahsulot topilmadi" text="Avval yangi mahsulot yarating yoki manager panelda partiya kirim qiling."/>:<><div className="inventory-publish-selectall"><label><input type="checkbox" checked={allReadySelected} onChange={()=>setSelected(allReadySelected?selected.filter(id=>!readyIds.includes(id)):[...new Set([...selected,...readyIds])])}/><span>Nashrga tayyor {ready.length} ta mahsulotni tanlash</span></label><b>{selected.length} ta tanlandi</b></div><div className="inventory-candidate-grid">{rows.map(row=>{const issues=row.publish_issues||[],canSelect=!row.is_published&&!issues.length;return <article key={row.id} className={selected.includes(row.id)?'selected':''}><label><input type="checkbox" disabled={!canSelect} checked={selected.includes(row.id)} onChange={()=>toggle(row.id)}/>{row.primary_image?<img src={row.primary_image} alt=""/>:<span className="product-placeholder"><Package/></span>}<div><b>{row.name}</b><small>{row.sku} · {row.category_name}</small><em>{Number(row.available_stock)} dona real qoldiq</em></div></label>{row.is_published?<Status type="green"><Globe2/> Saytda</Status>:issues.length?<ul>{issues.map(issue=><li key={issue}>{issue}</li>)}</ul>:<Status type="green"><CheckCircle2/> Nashrga tayyor</Status>}</article>})}</div><div className="inventory-publish-action"><span>Bu amal mavjud product va inventory birliklarini saqlaydi; nusxa yaratilmaydi.</span><button className="btn btn-primary" disabled={!selected.length||publishing} onClick={publish}>{publishing?'Nashr qilinmoqda…':`${selected.length} ta mahsulotni saytga chiqarish`}</button></div></>}</div>}</section>;
}
function CatalogFilters({query,setQuery,status,setStatus,category,setCategory,brand,setBrand,refs,load,activeCategoryObj,selectAllFiltered,deleteActiveCategoryProducts,categoryDeleting,total}){
 return <div>
   <div className="catalog-filters">
     <label><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Nomi, SKU yoki shtrix-kod..."/></label>
     <select className="select" value={status} onChange={e=>setStatus(e.target.value)}>
       <option value="">Barcha holatlar</option>
       <option value="draft">Qoralama</option>
       <option value="active">Faol</option>
     </select>
     <select className="select" value={category} onChange={e=>setCategory(e.target.value)}>
       <option value="">Barcha kategoriyalar</option>
       {refs.categories.filter(x=>x.is_active).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
     </select>
     <select className="select" value={brand} onChange={e=>setBrand(e.target.value)}>
       <option value="">Barcha brendlar</option>
       {refs.brands.filter(x=>x.is_active).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
     </select>
     <button className="icon-btn" onClick={load} title="Yangilash"><RefreshCw/></button>
   </div>
   {activeCategoryObj&&(
     <div className="category-action-strip">
       <span>Kategoriya: <b>{activeCategoryObj.name}</b> ({total} ta mahsulot)</span>
       <div style={{display:'flex',gap:8,alignItems:'center'}}>
         <button type="button" className="btn btn-outline btn-xs" onClick={selectAllFiltered}>Ushbu kategoriyani to‘liq tanlash</button>
         <button type="button" className="btn btn-danger-outline btn-xs" onClick={deleteActiveCategoryProducts} disabled={categoryDeleting}>
           <Trash2 size={13}/>{categoryDeleting?'O‘chirilmoqda…':'Kategoriyadagi barcha tovarlarni o‘chirish'}
         </button>
       </div>
     </div>
   )}
 </div>;
}
function ProductTable({rows,selected,toggleSelect,allCurrentSelected,toggleSelectAll,edit,publish,remove,rate}){
 return <div className="table-wrap"><table className="table product-real-table">
   <thead><tr>
     <th style={{width:38,textAlign:'center'}}><input type="checkbox" checked={allCurrentSelected} onChange={toggleSelectAll} title="Barchasini tanlash"/></th>
     <th>Mahsulot</th><th>SKU</th><th>Kategoriya</th><th>Narx</th><th>Qoldiq</th><th>Holat</th><th>Amal</th>
   </tr></thead>
   <tbody>{rows.map(row=><tr key={row.id} className={selected.includes(row.id)?'selected-row':''}>
     <td style={{textAlign:'center'}} onClick={e=>e.stopPropagation()}><input type="checkbox" checked={selected.includes(row.id)} onChange={()=>toggleSelect(row.id)}/></td>
     <td><div className="product-cell">{row.primary_image?<img src={row.primary_image} alt=""/>:<div className="product-placeholder"><Package/></div>}<div><b>{row.name}</b><span>{row.brand_name||'Brendsiz'}</span></div></div></td>
     <td><code>{row.sku}</code></td><td>{row.category_name}</td>
     <td><DualPrice value={Number(row.promotion_price??row.retail_price)} rate={rate} bold/><small>Chakana: <DualPrice value={Number(row.retail_price)} rate={rate}/></small>{row.wholesale_price!=null&&<small>Ulgurji: <DualPrice value={Number(row.wholesale_price)} rate={rate}/></small>}<small>Minimum: <DualPrice value={Number(row.minimum_sale_price)} rate={rate}/></small></td>
     <td><span className={Number(row.available_stock)<=0?'stock-red':''}>{Number(row.available_stock).toLocaleString('uz-UZ')} dona</span></td>
     <td><Status type={row.is_published?'green':row.status==='archived'?'red':'gray'}>{row.is_published?'Saytda':statusLabel[row.status]}</Status></td>
     <td><div className="catalog-actions"><button className="icon-btn" onClick={()=>edit(row)} title="Tahrirlash"><Pencil/></button><button className="icon-btn danger-icon" onClick={()=>remove(row)} title="Ochirish"><Trash2/></button>{row.status!=='archived'&&<button className={row.is_published?'btn btn-outline':'btn btn-primary'} onClick={()=>publish(row,!row.is_published)}>{row.is_published?'Yashirish':'Nashr'}</button>}</div></td>
   </tr>)}</tbody>
 </table></div>;
}
function NewCategoryInline({categories,onCreated}){
  const[open,setOpen]=useState(false);
  const[form,setForm]=useState({name:'',parentId:'',imageUrl:''});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[uploading,setUploading]=useState(false);
  const parents=(categories||[]).filter(c=>!c.parent_id);
  const submit=async e=>{
    e.preventDefault();
    if(!form.name.trim()){setError('Kategoriya nomini kiriting');return}
    setBusy(true);setError('');
    try{
      const base=form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const slug=(base||'cat')+'-'+Date.now().toString(36);
      const{data,error:insErr}=await getBrowserClient().from('categories').insert({
        name:form.name.trim(),slug,parent_id:form.parentId||null,is_active:true,sort_order:0,
        seo_image_url:form.imageUrl.trim()||null
      }).select('id,name,parent_id').single();
      if(insErr)throw insErr;
      onCreated(data);
      setOpen(false);setForm({name:'',parentId:'',imageUrl:''});
    }catch(e){setError(errorText(e))}finally{setBusy(false)}
  };
  const uploadImage=async(e)=>{
    const file=e.target.files?.[0];if(!file)return;
    setUploading(true);
    try{
      const client=getBrowserClient();
      const path='categories/'+Date.now()+'-'+file.name.replace(/[^a-z0-9._-]/gi,'_');
      const{error:ue}=await client.storage.from('logos').upload(path,file,{upsert:true});
      if(ue)throw ue;
      const{data:{publicUrl}}=client.storage.from('logos').getPublicUrl(path);
      setForm(f=>({...f,imageUrl:publicUrl}));
    }catch(er){alert(er.message||'Rasm yuklanmadi')}finally{setUploading(false);e.target.value=''}
  };
  if(!open)return <button type="button" className="btn btn-outline btn-sm" style={{marginTop:4,width:'fit-content'}} onClick={()=>setOpen(true)}><Plus size={13}/> Yangi kategoriya</button>;
  return <div style={{gridColumn:'1/-1',border:'1px solid var(--border,#e2e8f0)',background:'var(--surface,#fff)',borderRadius:12,padding:14,display:'grid',gap:10}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><b style={{fontSize:13}}>Yangi kategoriya qo‘shish</b><button type="button" style={{border:0,background:'none',cursor:'pointer',fontSize:16}} onClick={()=>setOpen(false)}>&times;</button></div>
    {error&&<div className="employee-error">{error}</div>}
    <label><span className="label">Kategoriya nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required/></label>
    <label><span className="label">Ota kategoriya</span>
      <select className="select" value={form.parentId} onChange={e=>setForm({...form,parentId:e.target.value})}>
        <option value="">— Asosiy (yuqori daraja) —</option>
        {parents.map(p=><optgroup key={p.id} label={p.name}>
          <option value={p.id}>{p.name} (ota)</option>
          {categories.filter(c=>c.parent_id===p.id).map(child=><option key={child.id} value={child.id}>&nbsp;&nbsp;↳ {child.name}</option>)}
        </optgroup>)}
      </select>
    </label>
    <label><span className="label">Kategoriya rasmi</span>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <input className="input" value={form.imageUrl} onChange={e=>setForm({...form,imageUrl:e.target.value})} placeholder="URL yoki fayl yuklang"/>
        <label className="btn btn-outline btn-sm" style={{whiteSpace:'nowrap',cursor:'pointer'}}>{uploading?'...':'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadImage}/></label>
        {form.imageUrl&&<img src={form.imageUrl} alt="" style={{width:36,height:36,borderRadius:6,objectFit:'cover'}}/>}
      </div>
    </label>
    <div style={{display:'flex',gap:8}}>
      <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>{busy?'Yaratilmoqda…':'Yaratish'}</button>
      <button type="button" className="btn btn-sm" onClick={()=>setOpen(false)}>Bekor</button>
    </div>
  </div>;
}

function NewBrandInline({brands,onCreated}){
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
      onCreated(data);
      setOpen(false);setForm({name:'',slug:'',logo_url:'',description:''});
    }catch(e){setError(errorText(e))}finally{setBusy(false)}
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
    }catch(er){alert(er.message||'Logo yuklanmadi')}finally{setUploading(false);e.target.value=''}
  };
  if(!open)return <button type="button" className="btn btn-outline" style={{padding:'8px 12px',whiteSpace:'nowrap'}} onClick={()=>setOpen(true)} title="Yangi brend">+</button>;
  return <div style={{position:'absolute',right:0,top:'100%',zIndex:30,background:'var(--surface,#fff)',border:'1px solid var(--border,#e2e8f0)',borderRadius:12,padding:16,display:'grid',gap:10,width:320,boxShadow:'0 8px 24px rgba(0,0,0,.15)'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><b style={{fontSize:13}}>Yangi brend</b><button type="button" style={{border:0,background:'none',fontSize:16,cursor:'pointer'}} onClick={()=>setOpen(false)}>&times;</button></div>
    {error&&<div className="employee-error">{error}</div>}
    <label><span className="label">Nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required/></label>
    <label><span className="label">Slug</span><input className="input" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="avtomatik-yoki-qolda"/></label>
    <label><span className="label">Logo</span>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <input className="input" value={form.logo_url} onChange={e=>setForm({...form,logo_url:e.target.value})} placeholder="URL yoki yuklang"/>
        <label className="btn btn-outline btn-sm" style={{whiteSpace:'nowrap',cursor:'pointer'}}>{uploading?'...':'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadLogo}/></label>
      </div>
    </label>
    <label><span className="label">Tavsif</span><input className="input" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label>
    <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy?'Yaratilmoqda...':'Saqlash'}</button>
  </div>;
}

export function ProductEditor({open,close,product,refs,saved,toast}){
  const rate=useExchangeRate();
  const[form,setForm]=useState({name:'',sku:'',barcode:'',category_id:'',brand_id:'',cost_price:'',retail_price:'',wholesale_price:'',promotion_price:'',minimum_sale_price:'0',compare_at_price:'',slug:'',video_url:'',description:''});
  const[images,setImages]=useState([]);
  const[existingMedia,setExistingMedia]=useState([]);
  const[variants,setVariants]=useState([]);
  const[categories,setCategories]=useState(refs?.categories||[]);
  const[brands,setBrands]=useState(refs?.brands||[]);
  const[attributes,setAttributes]=useState({});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');

  useEffect(()=>{
    if(refs?.categories?.length)setCategories(refs.categories);
    if(refs?.brands?.length)setBrands(refs.brands);
  },[refs]);

  useEffect(()=>{
    if(!open)return;
    setError('');
    setImages([]);
    if(!refs?.categories?.length||!refs?.brands?.length){
      const client=getBrowserClient();
      Promise.all([
        client.from('categories').select('id,name,parent_id,is_active').eq('is_active',true).order('sort_order'),
        client.from('brands').select('id,name,is_active').eq('is_active',true).order('name')
      ]).then(([{data:c},{data:b}])=>{
        if(c?.length)setCategories(c);
        if(b?.length)setBrands(b);
      }).catch(()=>{});
    }
    if(product){
      setForm({
        name:product.name||'',sku:product.sku||'',barcode:product.barcode||'',
        category_id:product.category_id||'',brand_id:product.brand_id||'',
        cost_price:product.cost_price!=null?String(product.cost_price):'',
        retail_price:product.retail_price!=null?String(product.retail_price):'',
        wholesale_price:product.wholesale_price!=null?String(product.wholesale_price):'',
        promotion_price:product.promotion_price!=null?String(product.promotion_price):'',
        minimum_sale_price:product.minimum_sale_price!=null?String(product.minimum_sale_price):'0',
        compare_at_price:product.compare_at_price!=null?String(product.compare_at_price):'',
        slug:product.slug||'',video_url:product.video_url||'',description:product.description||''
      });
      setExistingMedia(product.media||[]);
      setVariants((product.variants||[]).map(v=>({...v,imageFiles:[]})));
      setAttributes(Object.fromEntries((product.attributes||[]).map(x=>[x.attribute_id,x.value])));
    }else{
      setForm({name:'',sku:'',barcode:'',category_id:'',brand_id:'',cost_price:'',retail_price:'',wholesale_price:'',promotion_price:'',minimum_sale_price:'0',compare_at_price:'',slug:'',video_url:'',description:''});
      setExistingMedia([]);
      setVariants([]);
      setAttributes({});
    }
  },[open,product]);

  const applicable=useMemo(()=>(refs?.attributes||[]).filter(a=>!a.category_id||a.category_id===form.category_id),[refs?.attributes,form.category_id]);

  const removeExistingMedia=async mediaId=>{
    if(!window.confirm('Rasmni o‘chirasizmi?'))return;
    try{
      await deleteProductMedia(mediaId);
      setExistingMedia(prev=>prev.filter(m=>m.id!==mediaId));
      if(toast)toast('Rasm o‘chirildi');
    }catch(e){setError(errorText(e))}
  };

  const makePrimary=async mediaId=>{
    if(!product?.id)return;
    try{
      await setPrimaryProductMedia(product.id,mediaId);
      setExistingMedia(prev=>prev.map(m=>({...m,is_primary:m.id===mediaId})));
      if(toast)toast('Asosiy rasm belgilandi');
    }catch(e){setError(errorText(e))}
  };

  const submit=async e=>{
    e.preventDefault();
    if(!form.name.trim()){setError('Mahsulot nomini kiriting');return}
    setBusy(true);setError('');
    try{
      const client=getBrowserClient();
      const cleanName=form.name.trim();
      const slug=form.slug?.trim()||slugify(cleanName);
      const sku=form.sku.trim().toUpperCase()||('TB-'+Date.now().toString(36).toUpperCase());

      let productId=product?.id;
      if(!productId){
        const{data:newProd,error:insErr}=await client.from('products').insert({
          name:cleanName,
          sku,
          barcode:form.barcode?.trim()||null,
          slug,
          category_id:form.category_id||null,
          brand_id:form.brand_id||null,
          cost_price:Number(form.cost_price)||0,
          retail_price:Number(form.retail_price)||0,
          wholesale_price:form.wholesale_price===''?null:Number(form.wholesale_price),
          promotion_price:form.promotion_price===''?null:Number(form.promotion_price),
          minimum_sale_price:Number(form.minimum_sale_price)||0,
          compare_at_price:form.compare_at_price===''?null:Number(form.compare_at_price),
          description:form.description||null,
          video_url:form.video_url?.trim()||null,
          status:'active',
          is_published:false,
          track_individual_units:true,
          tax_rate:0,
        }).select('id,name,sku').single();
        if(insErr)throw insErr;
        productId=newProd.id;
      }else{
        const{error:updErr}=await client.from('products').update({
          name:cleanName,
          sku,
          barcode:form.barcode?.trim()||null,
          slug,
          category_id:form.category_id||null,
          brand_id:form.brand_id||null,
          cost_price:Number(form.cost_price)||0,
          retail_price:Number(form.retail_price)||0,
          wholesale_price:form.wholesale_price===''?null:Number(form.wholesale_price),
          promotion_price:form.promotion_price===''?null:Number(form.promotion_price),
          minimum_sale_price:Number(form.minimum_sale_price)||0,
          compare_at_price:form.compare_at_price===''?null:Number(form.compare_at_price),
          description:form.description||null,
          video_url:form.video_url?.trim()||null,
        }).eq('id',productId);
        if(updErr)throw updErr;
      }

      const failed=[];
      for(const file of images){
        try{
          await uploadProductMedia(productId,file,cleanName);
        }catch(err){
          failed.push(`${file.name}: ${err.message||'Yuklanmadi'}`);
        }
      }

      const namedVariants=variants.filter(v=>v.color_name?.trim());
      if(namedVariants.length){
        const variantsPayload=namedVariants.map(v=>({
          id:v.id||null,
          color_name:v.color_name.trim(),
          color_hex:v.color_hex||null,
          retail_price:v.retail_price===''?null:v.retail_price,
          wholesale_price:v.wholesale_price===''?null:v.wholesale_price,
          promotion_price:v.promotion_price===''?null:v.promotion_price,
          minimum_sale_price:v.minimum_sale_price===''?null:v.minimum_sale_price,
          is_active:v.is_active!==false,
        }));
        const savedVariants=await saveProductVariants(productId,variantsPayload);
        for(let i=0;i<savedVariants.length&&i<namedVariants.length;i++){
          for(const file of namedVariants[i].imageFiles||[]){
            try{
              await uploadProductMedia(productId,file,cleanName,savedVariants[i].id);
            }catch(err){
              failed.push(`${namedVariants[i].color_name}: ${err.message||'Yuklanmadi'}`);
            }
          }
        }
      }

      if(applicable.length>0){
        const attrs=applicable.filter(a=>attributes[a.id]!==''&&attributes[a.id]!=null).map(a=>({attribute_id:a.id,value:coerceAttribute(a,attributes[a.id])}));
        if(attrs.length){
          try{await saveCatalogProduct({id:productId,sku,name:cleanName,retail_price:Number(form.retail_price)||0,category_id:form.category_id},attrs)}catch{}
        }
      }

      if(failed.length){
        if(toast)toast(`Mahsulot saqlandi, lekin ${failed.length} ta rasm yuklanmadi`);
      }else{
        if(toast)toast(product?'Mahsulot yangilandi':'Yangi mahsulot yaratildi');
      }

      if(saved)await saved();
    }catch(e){
      setError(errorText(e));
    }finally{
      setBusy(false);
    }
  };

  if(!open)return null;

  return <Modal open={open} onClose={close} wide title={product?'Mahsulotni tahrirlash':'Yangi mahsulot'}>
    <form className="employee-form-grid" onSubmit={submit}>
      {error&&<div className="employee-error wide">{error}</div>}
      <label className="wide"><span className="label">Mahsulot nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2"/></label>
      <label><span className="label">SKU</span><input className="input" value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})} placeholder="Avtomatik"/></label>
      <label><span className="label">Kategoriya</span>
        <select className="select" value={form.category_id} onChange={e=>setForm({...form,category_id:e.target.value})} required>
          <option value="">Tanlang</option>
          {categories.filter(c=>!c.parent_id).map(p=><optgroup key={p.id} label={p.name}>
            <option value={p.id}>{p.name}</option>
            {categories.filter(c=>c.parent_id===p.id).map(child=><option key={child.id} value={child.id}>&nbsp;&nbsp;{child.name}</option>)}
          </optgroup>)}
        </select>
        <NewCategoryInline categories={categories} onCreated={cat=>{setCategories(prev=>[...prev,cat]);setForm(f=>({...f,category_id:cat.id}))}}/>
      </label>
      <label><span className="label">Brend</span>
        <div style={{display:'flex',gap:6,position:'relative'}}>
          <select className="select" style={{flex:1}} value={form.brand_id} onChange={e=>setForm({...form,brand_id:e.target.value})}>
            <option value="">Brendsiz</option>
            {brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <NewBrandInline brands={brands} onCreated={b=>{setBrands(prev=>[...prev,b]);setForm(f=>({...f,brand_id:b.id}))}}/>
        </div>
      </label>
      <DualPriceInput label="Tannarx" valueUzs={form.cost_price} onChangeUzs={v=>setForm({...form,cost_price:v})} rate={rate}/>
      <DualPriceInput label="Sotish narxi" valueUzs={form.retail_price} onChangeUzs={v=>setForm({...form,retail_price:v})} rate={rate}/>
      <DualPriceInput label="Ulgurji narx" valueUzs={form.wholesale_price} onChangeUzs={v=>setForm({...form,wholesale_price:v})} rate={rate}/>
      <label><span className="label">Aksiya narxi</span><input className="input" type="number" min="0" value={form.promotion_price} onChange={e=>setForm({...form,promotion_price:e.target.value})}/></label>
      <label><span className="label">Minimal sotuv narxi</span><input className="input" type="number" min="0" value={form.minimum_sale_price} onChange={e=>setForm({...form,minimum_sale_price:e.target.value})}/></label>
      <label><span className="label">Eski narx</span><input className="input" type="number" min="0" value={form.compare_at_price} onChange={e=>setForm({...form,compare_at_price:e.target.value})}/></label>
      <label><span className="label">Shtrix-kod</span><input className="input" value={form.barcode} onChange={e=>setForm({...form,barcode:e.target.value})}/></label>
      <label className="wide"><span className="label">Slug</span><input className="input" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="Nomdan avtomatik yaratiladi"/></label>
      <label className="wide"><span className="label">YouTube video URL</span><input className="input" value={form.video_url} onChange={e=>setForm({...form,video_url:e.target.value})} placeholder="https://youtube.com/watch?v=..."/></label>
      <div className="wide"><span className="label">Tavsif</span><RichTextEditor value={form.description} onChange={v=>setForm({...form,description:v})}/></div>
      <div className="wide">
        <span className="label">Rasmlar ({images.length + (existingMedia?.length||0)} ta)</span>
        {existingMedia&&existingMedia.length>0&&(
          <div style={{marginBottom:10}}>
            <small style={{display:'block',marginBottom:6,color:'var(--muted)'}}>Yuklangan rasmlar:</small>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {existingMedia.map(m=><div key={m.id} style={{width:65,height:65,borderRadius:8,overflow:'hidden',position:'relative',border:m.is_primary?'2px solid var(--orange)':'1px solid var(--line)'}}>
                <img src={m.public_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                {m.is_primary?<span style={{position:'absolute',bottom:2,left:2,background:'var(--orange)',color:'#fff',fontSize:9,padding:'1px 4px',borderRadius:4,fontWeight:700}}>Asosiy</span>:<button type="button" title="Asosiy qilish" style={{position:'absolute',bottom:2,left:2,background:'rgba(0,0,0,.6)',color:'#fdba74',fontSize:10,border:0,borderRadius:4,padding:'1px 4px',cursor:'pointer'}} onClick={()=>makePrimary(m.id)}>★ Asosiy</button>}
                <button type="button" title="O‘chirish" style={{position:'absolute',top:2,right:2,width:18,height:18,border:0,borderRadius:4,background:'rgba(0,0,0,.6)',color:'#fff',fontSize:10,cursor:'pointer'}} onClick={()=>removeExistingMedia(m.id)}>✕</button>
              </div>)}
            </div>
          </div>
        )}
        {images.length>0&&(
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
            {images.map((file,i)=><div key={i} style={{width:65,height:65,borderRadius:8,overflow:'hidden',position:'relative',border:'1px solid var(--line)'}}>
              <img src={URL.createObjectURL(file)} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
              {i===0&&(!existingMedia||!existingMedia.length)&&<span style={{position:'absolute',bottom:2,left:2,background:'var(--orange)',color:'#fff',fontSize:9,padding:'1px 4px',borderRadius:4,fontWeight:700}}>Asosiy</span>}
              <button type="button" style={{position:'absolute',top:2,right:2,width:18,height:18,border:0,borderRadius:4,background:'rgba(0,0,0,.6)',color:'#fff',fontSize:10,cursor:'pointer'}} onClick={()=>setImages(imgs=>imgs.filter((_,j)=>j!==i))}>✕</button>
            </div>)}
          </div>
        )}
        <label className="btn btn-outline btn-sm" style={{cursor:'pointer',display:'inline-flex',alignItems:'center',gap:6,width:'fit-content'}}>
          <Upload size={14}/> Rasm tanlash
          <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={e=>{
            const files=[...e.target.files];
            const invalid=files.find(file=>file.size>10*1024*1024||!['image/jpeg','image/png','image/webp','image/avif'].includes(file.type));
            if(invalid)setError(`${invalid.name}: faqat JPG, PNG, WebP yoki AVIF, maksimal 10 MB.`);
            else if(files.length){setError('');setImages(prev=>[...prev,...files])}
            e.target.value=''
          }}/>
        </label>
      </div>
      <div className="wide">
        <ColorVariantEditor variants={variants} setVariants={setVariants} showQuantity={false} showWholesale rate={rate} basePriceHint={form.retail_price?`${form.retail_price} so'm`:''}/>
      </div>
      {applicable.length>0&&<AttributeFields definitions={applicable} values={attributes} setValues={setAttributes}/>}
      <button className="btn btn-primary wide" disabled={busy} style={{marginTop:8}}>
        {busy?(product?'Saqlanmoqda…':'Yaratilmoqda…'):(product?'O‘zgarishlarni saqlash':'Yaratish')}
      </button>
    </form>
  </Modal>;
}

function coerceAttribute(def,value){if(def.data_type==='number')return Number(value);if(def.data_type==='boolean')return Boolean(value);if(def.data_type==='multiselect')return Array.isArray(value)?value:String(value).split(',').map(x=>x.trim()).filter(Boolean);return value}
function AttributeFields({definitions,values,setValues}){return <section className="attribute-editor wide"><h3>Mahsulot xususiyatlari</h3><div className="product-form-grid">{definitions.map(def=><label key={def.id}><span className="label">{def.name}{def.is_required?' *':''}</span>{def.data_type==='boolean'?<select className="select" value={String(values[def.id]??'')} onChange={e=>setValues({...values,[def.id]:e.target.value==='true'})} required={def.is_required}><option value="">Tanlang</option><option value="true">Ha</option><option value="false">Yo‘q</option></select>:def.data_type==='select'?<select className="select" value={values[def.id]??''} onChange={e=>setValues({...values,[def.id]:e.target.value})} required={def.is_required}><option value="">Tanlang</option>{def.options.map(x=><option key={x} value={x}>{x}</option>)}</select>:def.data_type==='multiselect'?<input className="input" value={Array.isArray(values[def.id])?values[def.id].join(', '):values[def.id]??''} onChange={e=>setValues({...values,[def.id]:e.target.value})} required={def.is_required} placeholder={def.options.join(', ')}/>:<input className="input" type={def.data_type==='number'?'number':def.data_type==='date'?'date':'text'} value={values[def.id]??''} onChange={e=>setValues({...values,[def.id]:e.target.value})} required={def.is_required}/>}</label>)}</div></section>}

