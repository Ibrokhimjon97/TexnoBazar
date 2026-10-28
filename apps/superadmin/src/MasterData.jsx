import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,CheckCircle2,Pencil,Plus,RefreshCw,Search,Trash2}from'lucide-react';
import{Empty,Modal,Status}from'@texnobazar/ui';
import{createMasterRecord,deleteMasterRecord,listMasterRecords,setMasterRecordActive,updateMasterRecord,getBrowserClient}from'@texnobazar/data';

const tabs=[
  ['branches','Filiallar'],['locations','Joylashuvlar'],['categories','Kategoriyalar'],
  ['brands','Brendlar'],['attribute_definitions','Atributlar'],['suppliers','Tamirotchilar'],
  ['payment_methods','To\'lov usullari'],
];
const labels=Object.fromEntries(tabs);
const activeTables=new Set(['branches','locations','categories','brands','suppliers','payment_methods']);
const emptyForms={
  branches:{code:'',name:'',phone:'',address:'',timezone:'Asia/Tashkent',currency:'UZS',is_active:true},
  locations:{branch_id:'',code:'',name:'',type:'store',is_active:true},
  categories:{parent_id:'',name:'',slug:'',description:'',image_url:'',seo_title:'',seo_description:'',seo_image_url:'',sort_order:0,is_active:true},
  brands:{name:'',slug:'',description:'',logo_url:'',is_active:true},
  attribute_definitions:{category_id:'',code:'',name:'',data_type:'text',options:'',is_required:false,is_filterable:false,sort_order:0},
  suppliers:{code:'',name:'',contact_name:'',phone:'',email:'',address:'',is_active:true},
  payment_methods:{code:'',name:'',is_cash:false,is_online:false,is_active:true,sort_order:0},
};
const typeLabels={store:'Dokon',warehouse:'Ombor',transit:'Tranzit',writeoff:'Hisobdan chiqarish'};
const dataTypeLabels={text:'Matn',number:'Raqam',boolean:'Ha/yoq',date:'Sana',select:'Tanlov',multiselect:'Kop tanlov'};
function normalizeCode(value){return value.trim().toUpperCase().replace(/['`ʻʼ"]/g,'').replace(/[^A-Z0-9_-]+/g,'-').replace(/^-|-$/g,'')}
function normalizeSlug(value){return value.trim().toLowerCase().replace(/[''ʻʼ']/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}
function errorText(error){const message=String(error?.message||'');if(message.includes('duplicate key'))return 'Bu kod yoki slug avval royxatga olingan.';if(message.includes('violates foreign key'))return 'Bu yozuv boshqa malumorlarga boglangan.';if(message.includes('rol'))return message;return message||'Amalni bajarib bolmadi.'}
function toForm(table,row){const form={...emptyForms[table],...row};if(table==='branches'||table==='suppliers')form.address=row?.address?.text||((row?.address&&Object.keys(row.address).length)?JSON.stringify(row.address):'');if(table==='attribute_definitions')form.options=Array.isArray(row?.options)?row.options.join(', '):'';return form}
function toPayload(table,form){const p={...form};for(const key of Object.keys(p))if(typeof p[key]==='string')p[key]=p[key].trim();if('code'in p)p.code=['attribute_definitions','payment_methods'].includes(table)?normalizeSlug(p.code):normalizeCode(p.code);if('slug'in p)p.slug=normalizeSlug(p.slug||p.name);if('parent_id'in p)p.parent_id=p.parent_id||null;if('category_id'in p)p.category_id=p.category_id||null;if('branch_id'in p)p.branch_id=p.branch_id||null;if('logo_url'in p)p.logo_url=p.logo_url||null;if('image_url'in p)p.image_url=p.image_url||null;if('email'in p)p.email=p.email||null;if('phone'in p)p.phone=p.phone||null;if('description'in p)p.description=p.description||null;if('seo_title'in p)p.seo_title=p.seo_title||null;if('seo_description'in p)p.seo_description=p.seo_description||null;if('seo_image_url'in p)p.seo_image_url=p.seo_image_url||null;if('contact_name'in p)p.contact_name=p.contact_name||null;if('address'in p)p.address=p.address?{text:p.address}:{};if('sort_order'in p)p.sort_order=Number(p.sort_order)||0;if('options'in p)p.options=p.options?p.options.split(',').map(x=>x.trim()).filter(Boolean):[];return p}

export default function MasterData({initialTab='branches',toast}){
 const[tab,setTab]=useState(initialTab),[data,setData]=useState({}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[query,setQuery]=useState(''),[editing,setEditing]=useState(null),[open,setOpen]=useState(false);
 const load=async()=>{setLoading(true);setError('');try{const entries=await Promise.all(tabs.map(async([key])=>[key,await listMasterRecords(key)]));setData(Object.fromEntries(entries))}catch(e){setError(errorText(e))}finally{setLoading(false)}};
 useEffect(()=>{load()},[]);useEffect(()=>{if(tabs.some(([key])=>key===initialTab))setTab(initialTab)},[initialTab]);
 const rows=useMemo(()=>{const q=query.trim().toLowerCase();return(data[tab]||[]).filter(row=>!q||[row.name,row.code,row.slug,row.email,row.phone].some(x=>String(x||'').toLowerCase().includes(q)))},[data,tab,query]);
 const save=async form=>{try{const payload=toPayload(tab,form);if(editing)await updateMasterRecord(tab,editing.id,payload);else await createMasterRecord(tab,payload);setOpen(false);setEditing(null);toast(editing?'Malumot yangilandi':'Yangi malumot qoshildi');await load()}catch(e){throw new Error(errorText(e))}};
 const toggle=async row=>{try{await setMasterRecordActive(tab,row.id,!row.is_active);toast(row.is_active?'Yozuv faolsizlantirildi':'Yozuv faollashtirildi');await load()}catch(e){setError(errorText(e))}};
 const remove=async row=>{
   if(tab==='categories'){
     const hasChildren=(data.categories||[]).some(x=>x.parent_id===row.id);
     if(hasChildren){
       alert(`“${row.name}” kategoriyasida ichki bo‘limlar mavjud. Avval ichki bo‘limlarni o‘chiring yoki boshqa ota kategoriyaga o‘tkazing.`);
       return;
     }
   }
   const label=tab==='categories'?'kategoriyasini':'yozuvini';
   if(!window.confirm(`“${row.name}” ${label} o‘chirishni tasdiqlaysizmi?`))return;
   setError('');
   try{
     await deleteMasterRecord(tab,row.id);
     toast(tab==='categories'?'Kategoriya o‘chirildi':'Yozuv o‘chirildi');
     await load();
   }catch(e){
     const msg=String(e?.message||'');
     if(msg.includes('violates foreign key')||msg.includes('foreign key constraint')){
       setError(tab==='categories'
         ?`“${row.name}” kategoriyasiga biriktirilgan mahsulotlar mavjud. Avval ushbu kategoriyadagi mahsulotlarni boshqa kategoriyaga o‘tkazing yoki o‘chiring.`
         :'Ushbu yozuv boshqa ma’lumotlarga bog‘langan bo‘lgani uchun o‘chirib bo‘lmaydi.');
     }else{
       setError(errorText(e));
     }
   }
 };
 return <><div className="page-head between"><div><h2>Malumotnomalar</h2><p>Asosiy biznes kataloglari va operatsion sozlamalarni boshqaring</p></div><button className="btn btn-primary" onClick={()=>{setEditing(null);setOpen(true)}}><Plus/> Yangi qoshish</button></div><div className="master-tabs">{tabs.map(([key,label])=><button key={key} className={tab===key?'active':''} onClick={()=>{setTab(key);setQuery('')}}>{label}<span>{data[key]?.length||0}</span></button>)}</div><div className="card data-card"><div className="toolbar"><label><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={`${labels[tab]} boyicha qidirish...`}/></label><button className="btn btn-outline" onClick={load}><RefreshCw/> Yangilash</button></div>{loading?<div className="employee-loading">Malumotlar yuklanmoqda…</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:rows.length===0?<Empty title="Malumot topilmadi" text="Yangi yozuv qoshing yoki qidiruvni ozgartiring."/>:<MasterTable table={tab} rows={rows} data={data} edit={row=>{setEditing(row);setOpen(true)}} toggle={toggle} remove={remove}/>}</div><MasterModal table={tab} row={editing} data={data} open={open} close={()=>{setOpen(false);setEditing(null)}} save={save} remove={remove}/></>;
}
function detail(table,row,data){if(table==='branches')return row.phone||row.timezone;if(table==='locations')return `${data.branches?.find(x=>x.id===row.branch_id)?.name||'Global'} · ${typeLabels[row.type]}`;if(table==='categories')return row.parent_id?`Ota: ${data.categories?.find(x=>x.id===row.parent_id)?.name||'—'}`:'Asosiy kategoriya';if(table==='brands')return row.slug;if(table==='attribute_definitions')return `${data.categories?.find(x=>x.id===row.category_id)?.name||'Umumiy'} · ${dataTypeLabels[row.data_type]}`;if(table==='suppliers')return row.contact_name||row.email||row.phone||'Kontakt yoq';return [row.is_cash?'Naqd':null,row.is_online?'Onlayn':null].filter(Boolean).join(' · ')||'Terminal'}
function MasterTable({table,rows,data,edit,toggle,remove}){
  if(table==='categories'){
    const parents=rows.filter(r=>!r.parent_id);
    const childMap={};rows.filter(r=>r.parent_id).forEach(r=>{(childMap[r.parent_id]||(childMap[r.parent_id]=[])).push(r)});
    const orphans=rows.filter(r=>r.parent_id&&!parents.some(p=>p.id===r.parent_id));
    return <div className="table-wrap"><table className="table master-table"><thead><tr><th>Nomi</th><th>Kod / slug</th><th>Tafsilot</th><th>Tartib</th><th>Holat</th><th>Amal</th></tr></thead><tbody>{parents.map(p=><React.Fragment key={p.id}><tr key={p.id} className="category-parent"><td><b>{p.name}</b></td><td><code>{p.slug||'\u2014'}</code></td><td><b style={{color:'var(--orange)'}}>Asosiy kategoriya</b></td><td>{p.sort_order??'\u2014'}</td><td><Status type={p.is_active?'green':'red'}>{p.is_active?'Faol':'Nofaol'}</Status></td><td><div className="master-actions"><button className="icon-btn" title="Tahrirlash" onClick={()=>edit(p)}><Pencil size={15}/></button><button className="icon-btn danger" title="O‘chirish" onClick={()=>remove(p)}><Trash2 size={15}/></button><button className={p.is_active?'btn btn-danger':'btn btn-primary'} onClick={()=>toggle(p)}>{p.is_active?'Faolsizlantirish':'Faollashtirish'}</button></div></td></tr>{(childMap[p.id]||[]).map(c=><tr key={c.id} className="category-child"><td><span style={{display:'inline-flex',alignItems:'center',gap:6,paddingLeft:24}}><span style={{color:'#94a3b8',fontFamily:'monospace'}}>{'\u2514'}</span><b>{c.name}</b></span></td><td><code>{c.slug||'\u2014'}</code></td><td>Ota: {p.name}</td><td>{c.sort_order??'\u2014'}</td><td><Status type={c.is_active?'green':'red'}>{c.is_active?'Faol':'Nofaol'}</Status></td><td><div className="master-actions"><button className="icon-btn" title="Tahrirlash" onClick={()=>edit(c)}><Pencil size={15}/></button><button className="icon-btn danger" title="O‘chirish" onClick={()=>remove(c)}><Trash2 size={15}/></button><button className={c.is_active?'btn btn-danger':'btn btn-primary'} onClick={()=>toggle(c)}>{c.is_active?'Faolsizlantirish':'Faollashtirish'}</button></div></td></tr>)}</React.Fragment>)}{orphans.map(c=><tr key={c.id} className="category-child"><td><span style={{display:'inline-flex',alignItems:'center',gap:6,paddingLeft:24}}><span style={{color:'#94a3b8',fontFamily:'monospace'}}>{'\u2514'}</span><b>{c.name}</b></span></td><td><code>{c.slug||'\u2014'}</code></td><td>Ota: {data.categories?.find(x=>x.id===c.parent_id)?.name||'\u2014'}</td><td>{c.sort_order??'\u2014'}</td><td><Status type={c.is_active?'green':'red'}>{c.is_active?'Faol':'Nofaol'}</Status></td><td><div className="master-actions"><button className="icon-btn" title="Tahrirlash" onClick={()=>edit(c)}><Pencil size={15}/></button><button className="icon-btn danger" title="O‘chirish" onClick={()=>remove(c)}><Trash2 size={15}/></button><button className={c.is_active?'btn btn-danger':'btn btn-primary'} onClick={()=>toggle(c)}>{c.is_active?'Faolsizlantirish':'Faollashtirish'}</button></div></td></tr>)}</tbody></table></div>;
  }
  return <div className="table-wrap"><table className="table master-table"><thead><tr><th>Nomi</th><th>Kod / slug</th><th>Tafsilot</th><th>Tartib</th><th>Holat</th><th>Amal</th></tr></thead><tbody>{rows.map(row=>{const active=activeTables.has(table)?row.is_active:true;return <tr key={row.id}><td><b>{row.name}</b></td><td><code>{row.code||row.slug||'\u2014'}</code></td><td>{detail(table,row,data)}</td><td>{row.sort_order??'\u2014'}</td><td>{activeTables.has(table)?<Status type={active?'green':'red'}>{active?'Faol':'Nofaol'}</Status>:<Status type="blue"><CheckCircle2/> Sozlangan</Status>}</td><td><div className="master-actions"><button className="icon-btn" title="Tahrirlash" onClick={()=>edit(row)}><Pencil size={15}/></button><button className="icon-btn danger" title="O‘chirish" onClick={()=>remove(row)}><Trash2 size={15}/></button>{activeTables.has(table)&&<button className={active?'btn btn-danger':'btn btn-primary'} onClick={()=>toggle(row)}>{active?'Faolsizlantirish':'Faollashtirish'}</button>}</div></td></tr>})}</tbody></table></div>;
}
function Field({label,children,wide=false}){return <label className={wide?'wide':''}><span className="label">{label}</span>{children}</label>}
function Text({form,setForm,name,...props}){return <input className="input" value={form[name]??''} onChange={e=>setForm({...form,[name]:e.target.value})} {...props}/>}
function Check({form,setForm,name,label}){return <label className="master-check"><input type="checkbox" checked={Boolean(form[name])} onChange={e=>setForm({...form,[name]:e.target.checked})}/><span>{label}</span></label>}
function MasterModal({table,row,data,open,close,save,remove}){
  const[form,setForm]=useState(emptyForms[table]);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[uploading,setUploading]=useState(false);
  
  useEffect(()=>{
    if(open){setForm(toForm(table,row));setError('')}
  },[open,row,table]);
  
  const submit=async e=>{
    e.preventDefault();
    setBusy(true);
    setError('');
    try{await save(form)}
    catch(e){setError(e.message)}
    finally{setBusy(false)}
  };
  
  return <Modal open={open} onClose={close} title={`${row?'Tahrirlash':'Yangi'}: ${labels[table]}`}>
    <form className="employee-form-grid" onSubmit={submit}>
      {error&&<div className="employee-error wide">{error}</div>}
      <FormFields {...{table,form,setForm,data,row,uploading,setUploading}}/>
      <div className="wide modal-footer-actions" style={{display:'flex',gap:10,justifyContent:row?'space-between':'flex-end',alignItems:'center',marginTop:8}}>
        {row ? (
          <button 
            type="button" 
            className="btn btn-danger" 
            onClick={() => {
              close();
              remove?.(row);
            }}
          >
            <Trash2 size={15}/> O‘chirish
          </button>
        ) : <div/>}
        <button className="btn btn-primary" style={{minWidth:140}} disabled={busy||uploading}>
          {busy?'Saqlanmoqda…':uploading?'Rasm yuklanmoqda…':'Saqlash'}
        </button>
      </div>
    </form>
  </Modal>;
}
function FormFields({table,form,setForm,data,row,uploading,setUploading}){
  const code=<Field label="Kod"><Text form={form} setForm={setForm} name="code" required minLength="2" placeholder="MAIN"/></Field>;
  const name=<Field label="Nomi"><Text form={form} setForm={setForm} name="name" required minLength="2"/></Field>;
  const active=activeTables.has(table)&&<Check form={form} setForm={setForm} name="is_active" label="Faol"/>;
  
  const uploadImage=async(e,fieldName='seo_image_url')=>{
    const file=e.target.files?.[0];
    if(!file)return;
    setUploading(true);
    try{
      const client=getBrowserClient();
      const path='categories/'+Date.now()+'-'+file.name.replace(/[^a-z0-9._-]/gi,'_');
      const{error:ue}=await client.storage.from('logos').upload(path,file,{upsert:true});
      if(ue)throw ue;
      const{data:{publicUrl}}=client.storage.from('logos').getPublicUrl(path);
      setForm(f=>({...f,[fieldName]:publicUrl}));
    }catch(err){
      alert(err.message||'Rasm yuklanmadi');
    }finally{
      setUploading(false);
      e.target.value='';
    }
  };
  
  if(table==='branches')return <>{code}{name}<Field label="Telefon"><Text form={form} setForm={setForm} name="phone"/></Field><Field label="Valyuta"><Text form={form} setForm={setForm} name="currency" required maxLength="3"/></Field><Field label="Vaqt mintaqasi"><Text form={form} setForm={setForm} name="timezone" required/></Field><Field label="Manzil" wide><Text form={form} setForm={setForm} name="address" placeholder="Toshkent shahri..."/></Field>{active}</>;
  if(table==='locations')return <><Field label="Filial"><select className="select" value={form.branch_id||''} onChange={e=>setForm({...form,branch_id:e.target.value})} required={!['transit','writeoff'].includes(form.type)}><option value="">Global</option>{data.branches?.filter(x=>x.is_active||x.id===row?.branch_id).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>{code}{name}<Field label="Turi"><select className="select" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>{Object.entries(typeLabels).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></Field>{active}</>;
  if(table==='categories')return <>
    <Field label="Ota kategoriya">
      <select className="select" value={form.parent_id||''} onChange={e=>setForm({...form,parent_id:e.target.value})}>
        <option value="">Asosiy kategoriya</option>
        {data.categories?.filter(x=>x.id!==row?.id).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </Field>
    {name}
    <Field label="Slug"><Text form={form} setForm={setForm} name="slug" placeholder="avtomatik-yoki-qolda"/></Field>
    <Field label="Tartib"><Text form={form} setForm={setForm} name="sort_order" type="number" min="0"/></Field>
    <Field label="Tavsif" wide><Text form={form} setForm={setForm} name="description"/></Field>
    <Field label="Kategoriya rasmi" wide>
      <div style={{display:'flex',gap:'8px',alignItems:'center',marginBottom:'8px'}}>
        {form.image_url&&<img src={form.image_url} alt="Kategoriya" style={{width:'80px',height:'80px',objectFit:'cover',borderRadius:'8px',border:'1px solid var(--line)'}}/>}
        <input type="file" accept="image/*" onChange={e=>uploadImage(e,'image_url')} disabled={uploading} style={{flex:1}}/>
      </div>
      <Text form={form} setForm={setForm} name="image_url" type="url" placeholder="https://... yoki yuqoridan yuklang"/>
    </Field>
    <Field label="SEO Title" wide><Text form={form} setForm={setForm} name="seo_title" maxLength="160"/></Field>
    <Field label="SEO Description" wide><Text form={form} setForm={setForm} name="seo_description" maxLength="300"/></Field>
    <Field label="SEO rasmi" wide>
      <div style={{display:'flex',gap:'8px',alignItems:'center',marginBottom:'8px'}}>
        {form.seo_image_url&&<img src={form.seo_image_url} alt="SEO" style={{width:'80px',height:'80px',objectFit:'cover',borderRadius:'8px',border:'1px solid var(--line)'}}/>}
        <input type="file" accept="image/*" onChange={e=>uploadImage(e,'seo_image_url')} disabled={uploading} style={{flex:1}}/>
      </div>
      <Text form={form} setForm={setForm} name="seo_image_url" type="url" placeholder="https://... yoki yuqoridan yuklang"/>
    </Field>
    {active}
  </>;
  if(table==='brands')return <>{name}<Field label="Slug"><Text form={form} setForm={setForm} name="slug" placeholder="avtomatik-yoki-qolda"/></Field><Field label="Logo URL" wide><Text form={form} setForm={setForm} name="logo_url" type="url" placeholder="https://..."/></Field><Field label="Tavsif" wide><Text form={form} setForm={setForm} name="description"/></Field>{active}</>;
  if(table==='attribute_definitions')return <><Field label="Kategoriya"><select className="select" value={form.category_id||''} onChange={e=>setForm({...form,category_id:e.target.value})}><option value="">Umumiy</option>{data.categories?.filter(x=>x.is_active).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>{code}{name}<Field label="Ma'lumot turi"><select className="select" value={form.data_type} onChange={e=>setForm({...form,data_type:e.target.value})}>{Object.entries(dataTypeLabels).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></Field><Field label="Variantlar" wide><Text form={form} setForm={setForm} name="options" placeholder="Qora, Oq, Ko'k"/></Field><Field label="Tartib"><Text form={form} setForm={setForm} name="sort_order" type="number" min="0"/></Field><Check form={form} setForm={setForm} name="is_required" label="Majburiy"/><Check form={form} setForm={setForm} name="is_filterable" label="Filtrda ko'rsatish"/></>;
  if(table==='suppliers')return <>{code}{name}<Field label="Aloqa shaxsi"><Text form={form} setForm={setForm} name="contact_name"/></Field><Field label="Telefon"><Text form={form} setForm={setForm} name="phone"/></Field><Field label="Email"><Text form={form} setForm={setForm} name="email" type="email"/></Field><Field label="Manzil"><Text form={form} setForm={setForm} name="address"/></Field>{active}</>;
  return <>{code}{name}<Field label="Tartib"><Text form={form} setForm={setForm} name="sort_order" type="number" min="0"/></Field><div className="master-check-group"><Check form={form} setForm={setForm} name="is_cash" label="Naqd"/><Check form={form} setForm={setForm} name="is_online" label="Onlayn"/>{active}</div></>;
}
