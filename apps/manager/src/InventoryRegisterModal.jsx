import React,{useEffect,useState}from'react';
import{AlertTriangle,Boxes,Plus,QrCode,Search,X}from'lucide-react';
import{DualPriceInput,Modal,Status,formatMoney}from'@texnobazar/ui';
import{createStockReceipt,getBrowserClient,getInventoryReferences,getLatestExchangeRate}from'@texnobazar/data';
import RichTextEditor from'./RichTextEditor';

const err=e=>String(e?.message||'Amalni bajarib bo\'lmadi.');

export default function InventoryRegisterModal({open,close,branchId,created}){
  const[step,setStep]=useState(1);
  const[refs,setRefs]=useState({locations:[],suppliers:[],products:[],categories:[],brands:[]});
  const[categoryId,setCategoryId]=useState('');
  const[productId,setProductId]=useState('');
  const[productSearch,setProductSearch]=useState('');
  const[quantity,setQuantity]=useState(1);
  const[unitCost,setUnitCost]=useState('');
  const[locationId,setLocationId]=useState('');
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[showCreateProduct,setShowCreateProduct]=useState(false);
  const[rate,setRate]=useState(null);
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{})},[]);

  useEffect(()=>{
    if(!open||!branchId)return;
    setStep(1);setCategoryId('');setProductId('');setQuantity(1);setUnitCost('');setError('');setProductSearch('');
    Promise.all([
      getInventoryReferences(branchId).then(async ref=>{const{data:prods}=await getBrowserClient().from('products').select('id,name,sku,cost_price,category_id').neq('status','archived');return{...ref,products:(prods||[]).map(p=>({...p,...(ref.products||[]).find(x=>x.id===p.id)}))}}),
      getBrowserClient().from('categories').select('id,name,slug,parent_id').eq('is_active',true).order('sort_order'),
      getBrowserClient().from('brands').select('id,name').eq('is_active',true).order('name'),
    ]).then(([ref,{data:cats},{data:brands}])=>{
      setRefs({...ref,categories:cats||[],brands:brands||[]});
      setLocationId(ref.locations.find(x=>x.type==='warehouse')?.id||ref.locations[0]?.id||'');
    }).catch(e=>setError(err(e)));
  },[open,branchId]);

  const filteredProducts=refs.products.filter(p=>{
    if(categoryId&&p.category_id!==categoryId)return false;
    if(productSearch){
      const q=productSearch.toLowerCase();
      return p.name.toLowerCase().includes(q)||p.sku.toLowerCase().includes(q);
    }
    return true;
  });

  const selectedProduct=refs.products.find(p=>p.id===productId);

  const submit=async()=>{
    if(!productId||!quantity||!locationId){setError('Tovar, son va joyni tanlang');return}
    setBusy(true);setError('');
    try{
      const receiptNo=`INV-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Date.now().toString(36).toUpperCase()}`;
      // Inventarizatsiya uchun maxsus ta'minotchi shart emas — birinchi ta'minotchini ishlatamiz yoki "Inventarizatsiya" nomli
      let supplierId=refs.suppliers.find(s=>s.name.toLowerCase().includes('inventar'))?.id||refs.suppliers[0]?.id;
      if(!supplierId){
        // Ta'minotchi yo'q — yaratamiz
        const{data:newSupplier}=await getBrowserClient().from('suppliers').insert({code:'INVENTAR',name:'Inventarizatsiya',is_active:true}).select('id').single();
        supplierId=newSupplier?.id;
      }
      await createStockReceipt({
        receipt_no:receiptNo,
        supplier_id:supplierId,
        receiving_location_id:locationId,
        branch_id:branchId,
        currency:'UZS',
        payment_status:'paid',
        received_at:new Date().toISOString(),
        notes:'Inventarizatsiya orqali ro\'yxatga olingan',
      },[{
        product_id:productId,
        quantity:Number(quantity),
        unit_cost:Number(unitCost)||0,
        serial_numbers:[],
      }]);
      await created();
    }catch(e){setError(err(e))}finally{setBusy(false)}
  };

  const createProduct=async(form)=>{
    try{
      const client=getBrowserClient();
      const slug=form.slug?.trim()||form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const{data,error:insertErr}=await client.from('products').insert({
        name:form.name.trim(),
        sku:form.sku.trim().toUpperCase()||('INV-'+Date.now()),
        barcode:form.barcode?.trim()||null,
        slug,
        category_id:form.category_id||categoryId||null,
        brand_id:form.brand_id||null,
        cost_price:Number(form.cost_price)||0,
        retail_price:Number(form.retail_price)||0,
        wholesale_price:Number(form.wholesale_price)||null,
        promotion_price:Number(form.promotion_price)||null,
        minimum_sale_price:Number(form.minimum_sale_price)||0,
        compare_at_price:Number(form.compare_at_price)||null,
        description:form.description||null,
        status:'active',
        is_published:false,
        track_individual_units:true,
        tax_rate:0,
      }).select('id,name,sku,category_id,cost_price').single();
      if(insertErr)throw insertErr;
      setRefs(prev=>({...prev,products:[...prev.products,data]}));
      setProductId(data.id);setUnitCost(String(data.cost_price||''));
      setShowCreateProduct(false);
      setStep(3);
    }catch(e){throw e}
  };

  if(!open)return null;

  return <Modal open onClose={close} wide title="Inventarizatsiya — tovar ro'yxatga olish">
    <div className="inv-register">
      <div className="inv-steps">
        <span className={step>=1?'active':''}>1. Kategoriya</span>
        <span className={step>=2?'active':''}>2. Tovar</span>
        <span className={step>=3?'active':''}>3. Son va joy</span>
      </div>

      {error&&<div className="employee-error">{error}</div>}

      {step===1&&<div className="inv-step-content">
        <p>Tovar qaysi kategoriyaga mansub?</p>
        <div className="inv-category-grid">
          {refs.categories.filter(c=>!c.parent_id).map(cat=><button key={cat.id} className={categoryId===cat.id?'active':''} onClick={()=>{setCategoryId(cat.id);setStep(2)}}>{cat.name}</button>)}
        </div>
        <button className="btn btn-outline" onClick={()=>setStep(2)}>Kategoriyasiz davom etish</button>
      </div>}

      {step===2&&<div className="inv-step-content">
        <p>Tovarni tanlang yoki yangi tovar yarating:</p>
        <div className="inv-search">
          <Search size={16}/>
          <input value={productSearch} onChange={e=>setProductSearch(e.target.value)} placeholder="Tovar nomi yoki SKU bo'yicha qidirish..."/>
        </div>
        <div className="inv-product-list">
          {filteredProducts.slice(0,20).map(p=><button key={p.id} className={productId===p.id?'active':''} onClick={()=>{setProductId(p.id);setUnitCost(String(p.cost_price||''));setStep(3)}}>
            <b>{p.name}</b><span>{p.sku}</span>
          </button>)}
          {filteredProducts.length===0&&<p className="inv-empty">Mos tovar topilmadi</p>}
          {filteredProducts.length>20&&<p className="inv-empty">Yana {filteredProducts.length-20} ta natija — qidiruvni aniqlashtiring</p>}
        </div>
        <button className="btn btn-primary" onClick={()=>setShowCreateProduct(true)}><Plus size={15}/>Yangi tovar yaratish</button>
        {categoryId&&<button className="btn btn-outline" onClick={()=>setStep(1)}>Kategoriyaga qaytish</button>}
      </div>}

      {step===3&&<div className="inv-step-content">
        {selectedProduct&&<div className="inv-selected-product"><Boxes size={20}/><div><b>{selectedProduct.name}</b><span>{selectedProduct.sku}</span></div></div>}
        <div className="inv-form-grid">
          <label><span>Nechta dona?</span><input className="input" type="number" min="1" max="1000" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>
          <DualPriceInput label="Birlik tannarxi" valueUzs={unitCost} onChangeUzs={setUnitCost} rate={rate}/>
          <label><span>Qabul joyi</span><select className="select" value={locationId} onChange={e=>setLocationId(e.target.value)}>{refs.locations.map(x=><option key={x.id} value={x.id}>{x.name} ({x.type==='warehouse'?'Ombor':'Do\'kon'})</option>)}</select></label>
        </div>
        <div className="inv-qr-info"><QrCode size={20}/><b>{quantity} ta noyob QR kod</b><span>avtomatik generatsiya qilinadi</span></div>
        <div className="inv-actions">
          <button className="btn btn-outline" onClick={()=>setStep(2)}>Ortga</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy?'Ro\'yxatga olinmoqda...':'Ro\'yxatga olish'}</button>
        </div>
      </div>}

      {showCreateProduct&&<CreateProductInline categories={refs.categories} brands={refs.brands} categoryId={categoryId} onCreated={createProduct} onCancel={()=>setShowCreateProduct(false)} rate={rate}/>}
    </div>
  </Modal>;
}

export function CreateProductInline({categories,brands,categoryId,onCreated,onCancel,rate}){
  const[form,setForm]=useState({name:'',sku:'',barcode:'',category_id:categoryId||'',brand_id:'',cost_price:'',retail_price:'',wholesale_price:'',promotion_price:'',minimum_sale_price:'0',compare_at_price:'',slug:'',video_url:'',description:''});
  const[images,setImages]=useState([]);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const submit=async e=>{
    e.preventDefault();
    if(!form.name.trim()){setError('Mahsulot nomini kiriting');return}
    setBusy(true);setError('');
    try{await onCreated(form)}catch(e){setError(err(e))}finally{setBusy(false)}
  };
  return <div className="inv-create-overlay">
    <div className="inv-create-form card">
      <div className="between" style={{marginBottom:16}}><h3>Yangi mahsulot</h3><button type="button" className="icon-btn" onClick={onCancel}><X size={18}/></button></div>
      <form className="employee-form-grid" onSubmit={submit}>
        {error&&<div className="employee-error wide">{error}</div>}
        <label className="wide"><span className="label">Mahsulot nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2"/></label>
        <label><span className="label">SKU</span><input className="input" value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})} placeholder="Avtomatik"/></label>
        <label><span className="label">Kategoriya</span><select className="select" value={form.category_id} onChange={e=>setForm({...form,category_id:e.target.value})}><option value="">Tanlang</option>{categories.filter(c=>!c.parent_id).map(p=><optgroup key={p.id} label={p.name}><option value={p.id}>{p.name}</option>{categories.filter(c=>c.parent_id===p.id).map(child=><option key={child.id} value={child.id}>&nbsp;&nbsp;{child.name}</option>)}</optgroup>)}</select></label>
        <NewCategoryInline categories={categories} onCreated={cat=>setForm({...form,category_id:cat.id})}/>
        <label><span className="label">Brend</span><div style={{display:'flex',gap:6,position:'relative'}}><select className="select" style={{flex:1}} value={form.brand_id} onChange={e=>setForm({...form,brand_id:e.target.value})}><option value="">Brendsiz</option>{brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><NewBrandInline brands={brands} onCreated={b=>setForm({...form,brand_id:b.id})}/></div></label>
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
        <div className="wide"><span className="label">Rasmlar ({images.length} ta tanlangan)</span><div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>{images.map((file,i)=><div key={i} style={{width:60,height:60,borderRadius:8,overflow:'hidden',position:'relative'}}><img src={URL.createObjectURL(file)} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/><button type="button" style={{position:'absolute',top:2,right:2,width:18,height:18,border:0,borderRadius:4,background:'rgba(0,0,0,.6)',color:'#fff',fontSize:10,cursor:'pointer'}} onClick={()=>setImages(imgs=>imgs.filter((_,j)=>j!==i))}>x</button></div>)}</div><label className="btn btn-outline btn-sm" style={{cursor:'pointer'}}>Rasm tanlash<input type="file" accept="image/*" multiple hidden onChange={e=>{const files=[...e.target.files];if(files.length)setImages(prev=>[...prev,...files]);e.target.value=''}}/></label></div>
        <button className="btn btn-primary wide" disabled={busy}>{busy?'Yaratilmoqda...':'Yaratish'}</button>
      </form>
    </div>
  </div>;
}

function NewCategoryInline({categories,onCreated}){
  const[open,setOpen]=useState(false);
  const[form,setForm]=useState({name:'',parentId:'',imageUrl:''});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[uploading,setUploading]=useState(false);
  const parents=categories.filter(c=>!c.parent_id);
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
      categories.push(data);
      onCreated(data);
      setOpen(false);setForm({name:'',parentId:'',imageUrl:''});
    }catch(e){setError(err(e))}finally{setBusy(false)}
  };
  const uploadImage=async(e)=>{
    const file=e.target.files?.[0];if(!file)return;
    setUploading(true);
    try{
      const client=getBrowserClient();
      const path='categories/'+Date.now()+'-'+file.name;
      const{error:ue}=await client.storage.from('logos').upload(path,file,{upsert:true});
      if(ue)throw ue;
      const{data:{publicUrl}}=client.storage.from('logos').getPublicUrl(path);
      setForm(f=>({...f,imageUrl:publicUrl}));
    }catch(er){alert(er.message)}finally{setUploading(false);e.target.value=''}
  };
  if(!open)return <button type="button" className="btn btn-outline btn-sm" style={{marginTop:4}} onClick={()=>setOpen(true)}><Plus size={13}/>Yangi kategoriya</button>;
  return <div style={{gridColumn:'1/-1',border:'1px solid var(--line,#e2e8f0)',borderRadius:12,padding:14,display:'grid',gap:10}}>
    <div style={{display:'flex',justifyContent:'space-between'}}><b style={{fontSize:13}}>Yangi kategoriya qo'shish</b><button type="button" style={{border:0,background:'none',cursor:'pointer',fontSize:16}} onClick={()=>setOpen(false)}>&times;</button></div>
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
      <div style={{display:'flex',gap:8}}>
        <input className="input" value={form.imageUrl} onChange={e=>setForm({...form,imageUrl:e.target.value})} placeholder="URL yoki yuklang"/>
        <label className="btn btn-outline btn-sm" style={{whiteSpace:'nowrap',cursor:'pointer'}}>{uploading?'...':'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadImage}/></label>
      </div>
      {form.imageUrl&&<img src={form.imageUrl} alt="" style={{width:48,height:48,borderRadius:8,objectFit:'cover',marginTop:6}}/>}
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
    if(!form.name.trim()){setError('Brend nomini kiriting');return}
    setBusy(true);setError('');
    try{
      const slug=form.slug.trim()||form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const{data,error:insErr}=await getBrowserClient().from('brands').insert({
        name:form.name.trim(),slug,logo_url:form.logo_url.trim()||null,description:form.description.trim()||null,is_active:true
      }).select('id,name').single();
      if(insErr)throw insErr;
      brands.push(data);
      onCreated(data);
      setOpen(false);setForm({name:'',slug:'',logo_url:'',description:''});
    }catch(e){setError(err(e))}finally{setBusy(false)}
  };
  const uploadLogo=async(e)=>{
    const file=e.target.files?.[0];if(!file)return;
    setUploading(true);
    try{
      const client=getBrowserClient();
      const path='brands/'+Date.now()+'-'+file.name;
      const{error:ue}=await client.storage.from('logos').upload(path,file,{upsert:true});
      if(ue)throw ue;
      const{data:{publicUrl}}=client.storage.from('logos').getPublicUrl(path);
      setForm(f=>({...f,logo_url:publicUrl}));
    }catch(er){alert(er.message)}finally{setUploading(false);e.target.value=''}
  };
  if(!open)return <button type="button" className="btn btn-outline" style={{padding:'8px 12px',whiteSpace:'nowrap'}} onClick={()=>setOpen(true)}>+</button>;
  return <div style={{position:'absolute',right:0,top:'100%',zIndex:10,background:'#fff',border:'1px solid var(--line,#e2e8f0)',borderRadius:12,padding:16,display:'grid',gap:10,width:320,boxShadow:'0 8px 24px rgba(0,0,0,.12)'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><b style={{fontSize:13}}>Yangi brend</b><button type="button" style={{border:0,background:'none',fontSize:16,cursor:'pointer'}} onClick={()=>setOpen(false)}>&times;</button></div>
    {error&&<div className="employee-error">{error}</div>}
    <label><span className="label">Nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required/></label>
    <label><span className="label">Slug</span><input className="input" value={form.slug} onChange={e=>setForm({...form,slug:e.target.value})} placeholder="avtomatik-yoki-qolda"/></label>
    <label><span className="label">Logo</span><div style={{display:'flex',gap:8}}><input className="input" value={form.logo_url} onChange={e=>setForm({...form,logo_url:e.target.value})} placeholder="URL yoki fayl yuklang"/><label className="btn btn-outline btn-sm" style={{whiteSpace:'nowrap',cursor:'pointer'}}>{uploading?'...':'Yuklash'}<input type="file" accept="image/*" hidden onChange={uploadLogo}/></label></div></label>
    <label><span className="label">Tavsif</span><input className="input" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label>
    <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy?'Yaratilmoqda...':'Saqlash'}</button>
  </div>;
}