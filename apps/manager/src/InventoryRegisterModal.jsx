import React,{useEffect,useState}from'react';
import{AlertTriangle,Boxes,Plus,X}from'lucide-react';
import{ColorVariantEditor,ProductComponentEditor,DualPriceInput,Modal,Status,formatMoney,SearchableCategoryPicker,SearchableBrandPicker,saveStoredRecent,RECENT_CATS_KEY,RECENT_BRANDS_KEY}from'@texnobazar/ui';
import{getBrowserClient,getInventoryReferences,getLatestExchangeRate,saveProductVariants,saveProductComponents,uploadProductMedia}from'@texnobazar/data';
import RichTextEditor from'./RichTextEditor';

const err=e=>String(e?.message||'Amalni bajarib bo\'lmadi.');

/**
 * Yangi tovar yaratish modali (Katalog).
 * DIQQAT: Ushbu modal FAQAT tovar ma'lumotlarini (nomi, narxi, rasmlari, rang variantlari)
 * yaratadi. U sonini (qoldiq) kiritmaydi va HECH QANDAY partiya (stock receipt) yaratmaydi!
 * Qoldiqlar faqat "Partiyalar" sahifasida Yangi partiya yoki Inventarizatsiya orqali kiritiladi.
 */
export default function CreateProductModal({open,close,branchId,created}){
  const[refs,setRefs]=useState({categories:[],brands:[]});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[rate,setRate]=useState(null);

  useEffect(()=>{
    getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{});
  },[]);

  useEffect(()=>{
    if(!open)return;
    setError('');
    Promise.all([
      getBrowserClient().from('categories').select('id,name,slug,parent_id').eq('is_active',true).order('sort_order'),
      getBrowserClient().from('brands').select('id,name').eq('is_active',true).order('name'),
    ]).then(([{data:cats},{data:brands}])=>{
      setRefs({categories:cats||[],brands:brands||[]});
    }).catch(e=>setError(err(e)));
  },[open]);

  const handleProductCreate=async(form,images=[],variants=[],components=[])=>{
    setBusy(true);
    setError('');
    try{
      const client=getBrowserClient();
      const slug=form.slug?.trim()||form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+Date.now().toString(36);
      const{data,error:insertErr}=await client.from('products').insert({
        name:form.name.trim(),
        sku:form.sku?.trim().toUpperCase()||('TB-'+Date.now().toString(36).toUpperCase()),
        barcode:form.barcode?.trim()||null,
        slug,
        category_id:form.category_id||null,
        brand_id:form.brand_id||null,
        cost_price:Number(form.cost_price)||0,
        cost_price_usd:form.cost_price_usd!==''&&form.cost_price_usd!=null&&!isNaN(Number(form.cost_price_usd))?Number(form.cost_price_usd):(rate&&Number(form.cost_price)?Number((Number(form.cost_price)/rate).toFixed(2)):null),
        retail_price:Number(form.retail_price)||0,
        retail_price_usd:form.retail_price_usd!==''&&form.retail_price_usd!=null&&!isNaN(Number(form.retail_price_usd))?Number(form.retail_price_usd):(rate&&Number(form.retail_price)?Number((Number(form.retail_price)/rate).toFixed(2)):null),
        wholesale_price:Number(form.wholesale_price)||null,
        wholesale_price_usd:form.wholesale_price_usd===''?null:(form.wholesale_price_usd!=null&&!isNaN(Number(form.wholesale_price_usd))?Number(form.wholesale_price_usd):(rate&&Number(form.wholesale_price)?Number((Number(form.wholesale_price)/rate).toFixed(2)):null)),
        promotion_price:Number(form.promotion_price)||null,
        minimum_sale_price:Number(form.minimum_sale_price)||0,
        currency: form.currency || (form.cost_price_usd && Number(form.cost_price_usd) > 0 ? 'USD' : (form.retail_price_usd && Number(form.retail_price_usd) > 0 ? 'USD' : 'UZS')),
        compare_at_price:Number(form.compare_at_price)||null,
        description:form.description||null,
        seo_image_url:null,
        status:'active',
        is_published:true,
        track_individual_units:true,
        tax_rate:0,
      }).select('id,name,sku,category_id,cost_price,cost_price_usd,retail_price,retail_price_usd,wholesale_price,wholesale_price_usd,minimum_sale_price,minimum_sale_price_usd').single();

      if(insertErr)throw insertErr;

      const failed=[];
      let primaryMediaUrl=null;
      for(const file of images){
        try{
          const uploaded = await uploadProductMedia(data.id,file,form.name.trim());
          if(!primaryMediaUrl && (uploaded?.publicUrl || uploaded?.url)){
            primaryMediaUrl = uploaded.publicUrl || uploaded.url;
          }
        }catch(uploadError){
          failed.push(`${file.name}: ${err(uploadError)}`);
        }
      }
      if(primaryMediaUrl){
        data.image = primaryMediaUrl;
        data.seo_image_url = primaryMediaUrl;
        try {
          await client.from('products').update({ seo_image_url: primaryMediaUrl }).eq('id', data.id);
        } catch {}
      }

      const namedVariants=variants.filter(v=>v.color_name?.trim());
      if(namedVariants.length){
        const variantsPayload=namedVariants.map(v=>({
          color_name:v.color_name.trim(),
          color_hex:v.color_hex||null,
          cost_price:v.cost_price===''||v.cost_price==null?null:Number(v.cost_price),
          cost_price_usd:v.cost_price_usd===''||v.cost_price_usd==null?null:Number(v.cost_price_usd),
          retail_price:v.retail_price===''||v.retail_price==null?null:Number(v.retail_price),
          retail_price_usd:v.retail_price_usd===''||v.retail_price_usd==null?null:Number(v.retail_price_usd),
          wholesale_price:v.wholesale_price===''||v.wholesale_price==null?null:Number(v.wholesale_price),
          wholesale_price_usd:v.wholesale_price_usd===''||v.wholesale_price_usd==null?null:Number(v.wholesale_price_usd),
          is_active:true
        }));
        const createdVariants=await saveProductVariants(data.id,variantsPayload);
        for(let i=0;i<createdVariants.length&&i<namedVariants.length;i++){
          for(const file of namedVariants[i].imageFiles||[]){
            try{
              await uploadProductMedia(data.id,file,form.name.trim(),createdVariants[i].id);
            }catch(uploadError){
              failed.push(`${namedVariants[i].color_name}: ${err(uploadError)}`);
            }
          }
        }

        // Retroaktiv bog'lash: agar tovarning eski variant_id=NULL bo'lgan birliklari
        // yoki partiyalari bo'lsa, ularni 1-variant (asosiy rang)ga biriktiramiz
        if (createdVariants && createdVariants.length > 0 && createdVariants[0]?.id) {
          const firstVarId = createdVariants[0].id;
          try {
            await client.from('inventory_units').update({ variant_id: firstVarId }).eq('product_id', data.id).is('variant_id', null);
            await client.from('stock_batches').update({ variant_id: firstVarId }).eq('product_id', data.id).is('variant_id', null);
            await client.from('order_lines').update({
              variant_id: firstVarId,
              variant_color: createdVariants[0].color_name
            }).eq('product_id', data.id).is('variant_id', null);
          } catch (syncErr) {
            console.warn('Orphan stock sync notice:', syncErr);
          }
        }
      }

      const namedComponents=(components||[]).filter(c=>c.name?.trim());
      if(namedComponents.length){
        for(const c of namedComponents){
          if(c.imageFile){
            try{
              const uploaded=await uploadProductMedia(data.id,c.imageFile,`${name.trim()} - ${c.name}`);
              c.image_url=uploaded?.publicUrl||uploaded?.url||c.image_url;
            }catch(imgErr){
              failed.push(`${c.name} rasmi: ${err(imgErr)}`);
            }
          }
        }
        const componentsPayload=namedComponents.map((c,idx)=>({
          name:c.name.trim(),
          color_name:c.color_name?.trim()||null,
          color_hex:c.color_hex||null,
          cost_price: (c.cost_price !== '' && c.cost_price != null) ? Number(c.cost_price) : ((c.cost_price_uzs !== '' && c.cost_price_uzs != null) ? Number(c.cost_price_uzs) : null),
          cost_price_usd: c.cost_price_usd === '' || c.cost_price_usd == null ? null : Number(c.cost_price_usd),
          retail_price: (c.retail_price !== '' && c.retail_price != null) ? Number(c.retail_price) : ((c.retail_price_uzs !== '' && c.retail_price_uzs != null) ? Number(c.retail_price_uzs) : null),
          retail_price_usd: c.retail_price_usd === '' || c.retail_price_usd == null ? null : Number(c.retail_price_usd),
          wholesale_price: (c.wholesale_price !== '' && c.wholesale_price != null) ? Number(c.wholesale_price) : ((c.wholesale_price_uzs !== '' && c.wholesale_price_uzs != null) ? Number(c.wholesale_price_uzs) : null),
          wholesale_price_usd: c.wholesale_price_usd === '' || c.wholesale_price_usd == null ? null : Number(c.wholesale_price_usd),
          is_default:Boolean(c.is_default),
          is_required:Boolean(c.is_required),
          can_buy_standalone:c.can_buy_standalone!==false,
          image_url:(c.image_url&&!c.image_url.startsWith('blob:'))?c.image_url:null,
          sort_order:idx,
          quantity: Math.max(1, Number(c.quantity) || 1),
          is_active:true
        }));
        try{
          await saveProductComponents(data.id,componentsPayload);
        }catch(compErr){
          failed.push(`Tarkibiy qismlar: ${err(compErr)}`);
        }
      }

      await created?.(data);
      close();
    }catch(e){
      setError(err(e));
    }finally{
      setBusy(false);
    }
  };

  if(!open)return null;

  return <div className="receipt-create-overlay">
    <div className="receipt-create-form card">
      <div className="between" style={{marginBottom:14,borderBottom:'1px solid var(--line)',paddingBottom:12}}>
        <div>
          <h2 style={{margin:0,fontSize:18}}>Yangi tovar qo'shish (Katalog)</h2>
          <p style={{margin:'4px 0 0',fontSize:12,color:'var(--muted)'}}>Tovar ma'lumotlari katalogga kiritiladi. Partiya va soni kiritilmaydi.</p>
        </div>
        <button type="button" className="icon-btn" onClick={close}><X size={18}/></button>
      </div>
      {error&&<div className="employee-error" style={{marginBottom:14}}>{error}</div>}
      <CreateProductForm
        categories={refs.categories}
        brands={refs.brands}
        onSave={handleProductCreate}
        onCancel={close}
        busy={busy}
        rate={rate}
        onCategoryCreated={cat => setRefs(prev => ({ ...prev, categories: [...(prev.categories || []).filter(c => c.id !== cat.id), cat] }))}
        onBrandCreated={b => setRefs(prev => ({ ...prev, brands: [...(prev.brands || []).filter(x => x.id !== b.id), b] }))}
      />
    </div>
  </div>;
}

export function CreateProductInline({categories,brands,categoryId,onCreated,onCancel,rate,onCategoryCreated,onBrandCreated}){
  return <div className="inv-create-overlay">
    <div className="inv-create-form card">
      <div className="between" style={{marginBottom:16}}>
        <h3>Yangi tovar yaratish</h3>
        <button type="button" className="icon-btn" onClick={onCancel}><X size={18}/></button>
      </div>
      <CreateProductForm
        categories={categories}
        brands={brands}
        initialCategoryId={categoryId}
        onSave={onCreated}
        onCancel={onCancel}
        rate={rate}
        onCategoryCreated={onCategoryCreated}
        onBrandCreated={onBrandCreated}
      />
    </div>
  </div>;
}

function CreateProductForm({categories=[],brands=[],initialCategoryId='',onSave,onCancel,busy=false,rate,onCategoryCreated,onBrandCreated}){
  const[localCategories,setLocalCategories]=useState(categories||[]);
  const[localBrands,setLocalBrands]=useState(brands||[]);
  useEffect(()=>{setLocalCategories(categories||[])},[categories]);
  useEffect(()=>{setLocalBrands(brands||[])},[brands]);

  const[form,setForm]=useState({
    name:'',sku:'',barcode:'',category_id:initialCategoryId||'',brand_id:'',
    cost_price:'',cost_price_usd:'',retail_price:'',retail_price_usd:'',wholesale_price:'',wholesale_price_usd:'',promotion_price:'',
    minimum_sale_price:'0',minimum_sale_price_usd:'0',compare_at_price:'',slug:'',video_url:'',description:'',
    currency:'UZS'
  });
  const[images,setImages]=useState([]);
  const[variants,setVariants]=useState([]);
  const[components,setComponents]=useState([]);
  const[submitting,setSubmitting]=useState(false);
  const[formError,setFormError]=useState('');

  const submit=async e=>{
    e.preventDefault();
    if(!form.name.trim()){
      setFormError('Mahsulot nomini kiriting');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try{
      await onSave(form,images,variants,components);
    }catch(e){
      setFormError(err(e));
    }finally{
      setSubmitting(false);
    }
  };

  const isBusy = busy || submitting;

  return <form className="employee-form-grid" onSubmit={submit}>
    {formError&&<div className="employee-error wide">{formError}</div>}
    <label className="wide"><span className="label">Mahsulot nomi *</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2" placeholder="Masalan: Gaz plita Artel Apetito 50-00E"/></label>
    <label><span className="label">SKU / Artikul</span><input className="input" value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})} placeholder="Avtomatik (TB-...)"/></label>
    <label><span className="label">Shtrix-kod (barcode)</span><input className="input" value={form.barcode} onChange={e=>setForm({...form,barcode:e.target.value})} placeholder="Skaner yoki raqamlar"/></label>
    <div>
      <span className="label">Kategoriya</span>
      <SearchableCategoryPicker
        categories={localCategories}
        value={form.category_id}
        onChange={catId => setForm(f => ({ ...f, category_id: catId }))}
      />
      <NewCategoryInline
        categories={localCategories}
        onCreated={cat => {
          setLocalCategories(prev => [...prev.filter(c => c.id !== cat.id), cat]);
          setForm(f => ({ ...f, category_id: cat.id }));
          saveStoredRecent(RECENT_CATS_KEY, cat.id);
          onCategoryCreated?.(cat);
        }}
      />
    </div>
    <div>
      <span className="label">Brend</span>
      <div style={{ display: 'flex', gap: 6, position: 'relative', alignItems: 'flex-start' }}>
        <SearchableBrandPicker
          brands={localBrands}
          value={form.brand_id}
          onChange={bId => setForm(f => ({ ...f, brand_id: bId }))}
        />
        <NewBrandInline
          brands={localBrands}
          onCreated={b => {
            setLocalBrands(prev => [...prev.filter(x => x.id !== b.id), b]);
            setForm(f => ({ ...f, brand_id: b.id }));
            saveStoredRecent(RECENT_BRANDS_KEY, b.id);
            onBrandCreated?.(b);
          }}
        />
      </div>
    </div>
    <DualPriceInput label="Tannarx" valueUzs={form.cost_price} onChangeUzs={v=>setForm(f=>({...f,cost_price:v}))} valueUsd={form.cost_price_usd} onChangeUsd={v=>setForm(f=>({...f,cost_price_usd:v}))} rate={rate} currency={form.currency} onCurrencyChange={c=>setForm(f=>({...f,currency:c}))}/>
    <DualPriceInput label="Sotish narxi *" valueUzs={form.retail_price} onChangeUzs={v=>setForm(f=>({...f,retail_price:v}))} valueUsd={form.retail_price_usd} onChangeUsd={v=>setForm(f=>({...f,retail_price_usd:v}))} rate={rate} currency={form.currency} onCurrencyChange={c=>setForm(f=>({...f,currency:c}))}/>
    <DualPriceInput label="Ulgurji narx" valueUzs={form.wholesale_price} onChangeUzs={v=>setForm(f=>({...f,wholesale_price:v}))} valueUsd={form.wholesale_price_usd} onChangeUsd={v=>setForm(f=>({...f,wholesale_price_usd:v}))} rate={rate} currency={form.currency} onCurrencyChange={c=>setForm(f=>({...f,currency:c}))}/>
    <DualPriceInput label="Minimal sotuv narxi" valueUzs={form.minimum_sale_price} onChangeUzs={v=>setForm(f=>({...f,minimum_sale_price:v}))} valueUsd={form.minimum_sale_price_usd} onChangeUsd={v=>setForm(f=>({...f,minimum_sale_price_usd:v}))} rate={rate} currency={form.currency} onCurrencyChange={c=>setForm(f=>({...f,currency:c}))}/>
    <label><span className="label">Aksiya narxi</span><input className="input" type="number" min="0" value={form.promotion_price} onChange={e=>setForm({...form,promotion_price:e.target.value})} placeholder="Ixtiyoriy"/></label>
    <label><span className="label">Eski narx (chizilgan)</span><input className="input" type="number" min="0" value={form.compare_at_price} onChange={e=>setForm({...form,compare_at_price:e.target.value})} placeholder="Ixtiyoriy"/></label>
    <label className="wide"><span className="label">YouTube video URL</span><input className="input" value={form.video_url} onChange={e=>setForm({...form,video_url:e.target.value})} placeholder="https://youtube.com/watch?v=..."/></label>
    <div className="wide"><span className="label">Tavsif</span><RichTextEditor value={form.description} onChange={v=>setForm({...form,description:v})}/></div>
    <div className="wide">
      <span className="label">Rasmlar ({images.length} ta tanlangan)</span>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
        {images.map((file,i)=><div key={i} style={{width:64,height:64,borderRadius:8,overflow:'hidden',position:'relative',border:'1px solid var(--line)'}}>
          <img src={URL.createObjectURL(file)} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
          <button type="button" style={{position:'absolute',top:2,right:2,width:20,height:20,border:0,borderRadius:'50%',background:'rgba(0,0,0,.7)',color:'#fff',fontSize:11,cursor:'pointer',display:'grid',placeItems:'center'}} onClick={()=>setImages(imgs=>imgs.filter((_,j)=>j!==i))}>&times;</button>
        </div>)}
      </div>
      <label className="btn btn-outline btn-sm" style={{cursor:'pointer',display:'inline-flex',alignItems:'center',gap:6}}>
        <Plus size={14}/> Rasm tanlash
        <input type="file" accept="image/*" multiple hidden onChange={e=>{const files=[...e.target.files];if(files.length){setImages(prev=>[...prev,...files])}e.target.value=''}}/>
      </label>
    </div>
    <div className="wide">
      <ColorVariantEditor
        variants={variants}
        setVariants={setVariants}
        showQuantity={false}
        showWholesale
        showCost
        rate={rate}
        basePriceHint={form.retail_price?`${form.retail_price} so'm`:''}
        baseCostHint={form.cost_price?`${form.cost_price} so'm`:''}
        productImages={images}
      />
    </div>
    <div className="wide">
      <ProductComponentEditor
        components={components}
        onChange={setComponents}
        rate={rate}
        showQuantity={false}
      />
    </div>
    <div className="wide" style={{display:'flex',gap:10,marginTop:10,flexWrap:'wrap'}}>
      <button className="btn btn-primary" type="submit" disabled={isBusy} style={{flex:'1 1 180px'}}>
        {isBusy?'Saqlanmoqda...':'Tovarni saqlash'}
      </button>
      <button className="btn" type="button" onClick={onCancel} disabled={isBusy} style={{flex:'1 1 120px'}}>
        Bekor qilish
      </button>
    </div>
  </form>;
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
      try { categories.push(data); } catch {}
      saveStoredRecent(RECENT_CATS_KEY, data.id);
      onCreated(data);
      setOpen(false);setForm({name:'',parentId:'',imageUrl:''});
    }catch(e){setError(err(e))}finally{setBusy(false)}
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
      try { brands.push(data); } catch {}
      saveStoredRecent(RECENT_BRANDS_KEY, data.id);
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