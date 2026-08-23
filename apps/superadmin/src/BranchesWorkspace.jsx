import React,{useEffect,useState}from'react';
import{AlertTriangle,ArrowLeft,BarChart3,MapPin,Pencil,Plus,Store,Trash2,Users,Warehouse}from'lucide-react';
import{DualPrice,Empty,Modal,Status,useExchangeRate}from'@texnobazar/ui';
import{createMasterRecord,deleteMasterRecord,getAccessToken,getBrowserClient,listActiveBranches,listEmployees,listMasterRecords,updateMasterRecord}from'@texnobazar/data';

const roleLabels={manager:'Menejer',seller:'Sotuvchi',courier:'Kuryer',warehouse:'Omborchi',accountant:'Hisobchi'};
const locationTypes={store:'Do’kon',warehouse:'Ombor'};

export default function BranchesWorkspace({toast}){
  const[branches,setBranches]=useState([]),[locations,setLocations]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const[selected,setSelected]=useState(null);
  const[branchModal,setBranchModal]=useState(false),[editing,setEditing]=useState(null);
  const load=async()=>{setLoading(true);setError('');try{const[b,l]=await Promise.all([listMasterRecords('branches'),listMasterRecords('locations')]);setBranches(b);setLocations(l)}catch(e){setError(e.message||'Filiallar yuklanmadi')}finally{setLoading(false)}};
  useEffect(()=>{load()},[]);

  if(selected)return <BranchDetail branch={selected} locations={locations.filter(l=>l.branch_id===selected.id)} back={()=>setSelected(null)} toast={toast} reload={load}/>;

  const openNew=()=>{setEditing(null);setBranchModal(true)};
  const openEdit=(b,e)=>{e.stopPropagation();setEditing(b);setBranchModal(true)};
  const removeBranch=async(b,e)=>{e.stopPropagation();if(!confirm(`"${b.name}" filialini o’chirishni tasdiqlaysizmi?`))return;try{await deleteMasterRecord('branches',b.id);toast('Filial o’chirildi');await load()}catch(err){setError(err.message)}};

  return <><div className="page-head between"><div><h2>Filiallar</h2><p>Filiallar, omborlar va xodimlarni boshqaring</p></div><button className="btn btn-primary" onClick={openNew}><Plus/> Yangi filial</button></div>
  {loading?<div className="employee-loading">Yuklanmoqda…</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:branches.length===0?<Empty title="Filiallar yo’q" text="Yangi filial qo’shing."/>:
  <div className="branch-cards">{branches.map(b=>{const locs=locations.filter(l=>l.branch_id===b.id);return <div key={b.id} className="branch-card" onClick={()=>setSelected(b)}><div className="branch-card-head"><Store/><div><h3>{b.name}</h3><span className="muted">{b.code}</span></div><Status type={b.is_active?'green':'red'}>{b.is_active?'Faol':'Nofaol'}</Status></div><div className="branch-card-info"><p><MapPin size={14}/> {b.address?.text||b.phone||'Manzil kiritilmagan'}</p><p><Warehouse size={14}/> {locs.length} ta joy</p></div><div className="branch-card-actions"><button className="icon-btn" title="Tahrirlash" onClick={e=>openEdit(b,e)}><Pencil size={16}/></button><button className="icon-btn" title="O’chirish" onClick={e=>removeBranch(b,e)}><Trash2 size={16}/></button></div></div>})}</div>}
  <BranchModal open={branchModal} close={()=>{setBranchModal(false);setEditing(null)}} branch={editing} toast={toast} reload={load}/></>;
}

/* --- Branch Detail: locations + employees inside a branch --- */
function BranchDetail({branch,locations,back,toast,reload}){
  const[locModal,setLocModal]=useState(false),[editLoc,setEditLoc]=useState(null),[selectedEmp,setSelectedEmp]=useState(null),[selectedLoc,setSelectedLoc]=useState(null);
  const[empModal,setEmpModal]=useState(false),[editEmp,setEditEmp]=useState(null),[branches,setBranches]=useState([]);
  useEffect(()=>{listActiveBranches().then(setBranches).catch(()=>{})},[]);

  const removeLoc=async loc=>{if(!confirm(`"${loc.name}" ni o’chirishni tasdiqlaysizmi?`))return;try{await deleteMasterRecord('locations',loc.id);toast('Joy o’chirildi');await reload()}catch(e){alert(e.message)}};

  if(selectedLoc)return <LocationDetail location={selectedLoc} branch={branch} back={()=>setSelectedLoc(null)} toast={toast}/>;
  if(selectedEmp)return <BranchEmployeeStats employee={selectedEmp} back={()=>setSelectedEmp(null)}/>;

  return <><div className="page-head between"><div style={{display:'flex',alignItems:'center',gap:12}}><button className="icon-btn" onClick={back}><ArrowLeft/></button><div><h2>{branch.name}</h2><p>{branch.code} · {branch.phone||'Telefon yo’q'} · {branch.address?.text||''}</p></div></div></div>

  <div className="branch-detail-sections">
    <section className="card"><div className="section-head"><h3><Warehouse size={18}/> Omborlar va joylar</h3><button className="btn btn-primary btn-sm" onClick={()=>{setEditLoc(null);setLocModal(true)}}><Plus size={14}/> Yangi joy</button></div>
    {locations.length===0?<p className="muted" style={{padding:'1rem'}}>Bu filialda hali joy yo’q</p>:<div className="table-wrap"><table className="table"><thead><tr><th>Nomi</th><th>Kod</th><th>Turi</th><th>Holat</th><th>Amal</th></tr></thead><tbody>{locations.map(loc=><tr key={loc.id} className="clickable-row" onClick={()=>setSelectedLoc(loc)}><td><b>{loc.name}</b></td><td><code>{loc.code}</code></td><td>{locationTypes[loc.type]||loc.type}</td><td><Status type={loc.is_active?'green':'red'}>{loc.is_active?'Faol':'Nofaol'}</Status></td><td><div className="master-actions"><button className="icon-btn" onClick={()=>{setEditLoc(loc);setLocModal(true)}}><Pencil size={14}/></button><button className="icon-btn" onClick={()=>removeLoc(loc)}><Trash2 size={14}/></button></div></td></tr>)}</tbody></table></div>}</section>

    <BranchEmployees branchId={branch.id} onAdd={()=>setEmpModal(true)} onSelect={setSelectedEmp} onEdit={emp=>{setEditEmp(emp);setEmpModal(true)}} onDelete={async emp=>{if(!confirm(emp.full_name+" xodimini butunlay ochirishni tasdiqlaysizmi?"))return;try{const token=await getAccessToken();const res=await fetch("/api/employees/create",{method:"DELETE",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify({employeeId:emp.employee_id})});if(!res.ok)throw new Error("Xodimni ochirib bolmadi");toast("Xodim ochirildi");await reload()}catch(e){alert(e.message)}}}/>
  </div>

  <LocationModal open={locModal} close={()=>{setLocModal(false);setEditLoc(null)}} location={editLoc} branchId={branch.id} toast={toast} reload={reload}/>
  <EmployeeQuickModal open={empModal} close={()=>setEmpModal(false)} branchId={branch.id} branchName={branch.name} branches={branches} toast={toast}/></>;
}

/* --- Branch Create/Edit Modal --- */
function BranchModal({open,close,branch,toast,reload}){
  const empty={name:'',phone:'',address:'',is_active:true};
  const[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){setForm(branch?{name:branch.name||'',phone:branch.phone||'',address:branch.address?.text||'',is_active:branch.is_active!==false}:{...empty});setError('')}},[open,branch]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const payload={name:form.name.trim(),phone:form.phone.trim()||null,address:form.address.trim()?{text:form.address.trim()}:{},is_active:form.is_active};if(!payload.name)throw new Error('Filial nomi kiritilmagan');if(branch){await updateMasterRecord('branches',branch.id,payload)}else{const code=payload.name.trim().toUpperCase().replace(/\s+/g,'-').slice(0,20);await createMasterRecord('branches',{...payload,code,timezone:'Asia/Tashkent',currency:'UZS'})}close();toast(branch?'Filial yangilandi':'Filial yaratildi');await reload()}catch(err){setError(err.message)}finally{setBusy(false)}};
  return <Modal open={open} onClose={close} title={branch?'Filialni tahrirlash':'Yangi filial'}><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label className="wide"><span className="label">Filial nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2"/></label><label><span className="label">Telefon</span><input className="input" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} required/></label><label><span className="label">Manzil</span><input className="input" value={form.address} onChange={e=>setForm({...form,address:e.target.value})} placeholder="Toshkent shahri..."/></label><label className="master-check"><input type="checkbox" checked={form.is_active} onChange={e=>setForm({...form,is_active:e.target.checked})}/><span>Faol</span></label><button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda…':'Saqlash'}</button></form></Modal>;
}

/* --- Location Create/Edit Modal --- */
function LocationModal({open,close,location,branchId,toast,reload}){
  const empty={code:'',name:'',type:'warehouse',is_active:true};
  const[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){setForm(location?{code:location.code||'',name:location.name||'',type:location.type||'warehouse',is_active:location.is_active!==false}:{...empty});setError('')}},[open,location]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const payload={branch_id:branchId,code:form.code.trim().toUpperCase()||form.name.trim().toUpperCase().replace(/\s+/g,'-'),name:form.name.trim(),type:form.type,is_active:form.is_active};if(!payload.name)throw new Error('Nom kiritilmagan');if(location)await updateMasterRecord('locations',location.id,payload);else await createMasterRecord('locations',payload);close();toast(location?'Joy yangilandi':'Joy yaratildi');await reload()}catch(err){setError(err.message)}finally{setBusy(false)}};
  return <Modal open={open} onClose={close} title={location?'Joyni tahrirlash':'Yangi ombor/joy'}><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label><span className="label">Nomi</span><input className="input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required minLength="2"/></label><label><span className="label">Kod</span><input className="input" value={form.code} onChange={e=>setForm({...form,code:e.target.value})} placeholder="Avtomatik"/></label><label><span className="label">Turi</span><select className="select" value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>{Object.entries(locationTypes).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label className="master-check"><input type="checkbox" checked={form.is_active} onChange={e=>setForm({...form,is_active:e.target.checked})}/><span>Faol</span></label><button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda…':'Saqlash'}</button></form></Modal>;
}

/* --- Quick Employee Add from Branch Detail --- */
function EmployeeQuickModal({open,close,branchId,branchName,branches,toast}){
  const initial={fullName:'',email:'',phone:'',role:'seller',branchId,password:''};
  const[form,setForm]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(open)setForm({...initial,branchId})},[open,branchId]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi.');const res=await fetch('/api/employees/create',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(form)}),body=await res.json();if(!res.ok)throw new Error(body.error||'Xodim yaratilmadi');close();toast(`Xodim "${form.fullName}" yaratildi`)}catch(err){setError(err.message)}finally{setBusy(false)}};
  return <Modal open={open} onClose={close} title={`Xodim qo’shish — ${branchName}`}><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label className="wide"><span className="label">To’liq ism</span><input className="input" value={form.fullName} onChange={e=>setForm({...form,fullName:e.target.value})} required minLength="3"/></label><label><span className="label">Email</span><input className="input" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label><label><span className="label">Telefon</span><input className="input" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} required/></label><label><span className="label">Rol</span><select className="select" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{Object.entries(roleLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label className="wide"><span className="label">Vaqtinchalik parol</span><input className="input" type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} required minLength="4"/></label><button className="btn btn-primary wide" disabled={busy}>{busy?'Yaratilmoqda…':'Yaratish'}</button></form></Modal>;
}

/* --- Branch Employees List --- */
function BranchEmployees({branchId,onAdd,onSelect,onEdit,onDelete}){
  const[employees,setEmployees]=useState([]),[loading,setLoading]=useState(true);
  useEffect(()=>{loadEmps()},[branchId]);
  const loadEmps=async()=>{setLoading(true);try{const all=await listEmployees();const filtered=all.filter(emp=>(emp.roles||[]).some(r=>r.branch_id===branchId));setEmployees(filtered)}catch(e){setEmployees([])}finally{setLoading(false)}};
  return <section className="card"><div className="section-head"><h3><Users size={18}/> Xodimlar ({employees.length})</h3><button className="btn btn-primary btn-sm" onClick={onAdd}><Plus size={14}/> Xodim qo'shish</button></div>
  {loading?<p className="muted" style={{padding:'1rem'}}>Yuklanmoqda...</p>:employees.length===0?<p className="muted" style={{padding:'1rem'}}>Bu filialda hali xodim yo'q</p>:<div className="table-wrap"><table className="table"><thead><tr><th>Xodim</th><th>Rol</th><th>Telefon</th><th>Holat</th><th>Amal</th></tr></thead><tbody>{employees.map(emp=>{const role=(emp.roles||[]).find(r=>r.branch_id===branchId);return <tr key={emp.employee_id} className="clickable-row" onClick={()=>onSelect&&onSelect(emp)}><td><b>{emp.full_name||'Nomsiz'}</b><br/><small className="muted">{emp.email||''}</small></td><td><Status type="blue">{roleLabels[role?.role]||role?.role||'—'}</Status></td><td>{emp.phone||'—'}</td><td><Status type={emp.is_active?'green':'red'}>{emp.is_active?'Faol':'Nofaol'}</Status></td><td><div className="master-actions" onClick={e=>e.stopPropagation()}><button className="icon-btn" title="Tahrirlash" onClick={()=>onEdit&&onEdit(emp)}><Pencil size={14}/></button><button className="icon-btn" title="O'chirish" onClick={()=>onDelete&&onDelete(emp)}><Trash2 size={14}/></button></div></td></tr>})}</tbody></table></div>}</section>;
}

/* --- Employee Stats inside Branch Detail --- */
function BranchEmployeeStats({employee,back}){
  const rate=useExchangeRate();
  const[stats,setStats]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const[period,setPeriod]=useState('month');
  useEffect(()=>{loadStats()},[employee,period]);
  const loadStats=async()=>{setLoading(true);setError('');try{
    const now=new Date();let from;
    if(period==='week'){const d=new Date(now);d.setDate(d.getDate()-7);from=d.toISOString().split('T')[0]}
    else if(period==='month'){const d=new Date(now);d.setMonth(d.getMonth()-1);from=d.toISOString().split('T')[0]}
    else{const d=new Date(now);d.setFullYear(d.getFullYear()-1);from=d.toISOString().split('T')[0]}
    const to=now.toISOString().split('T')[0];
    const client=getBrowserClient();
    const{data:salesRows,error:sErr}=await client.rpc('report_sales_rows',{p_from:from,p_to:to,p_branch_id:null});
    if(sErr)throw sErr;
    const mySales=(salesRows||[]).filter(s=>s.seller_name===(employee.full_name));
    const salesCount=mySales.length;
    const totalRevenue=mySales.reduce((sum,s)=>sum+(Number(s.total)||0),0);
    const totalProfit=mySales.reduce((sum,s)=>sum+(Number(s.profit)||0),0);
    setStats({salesCount,totalRevenue,totalProfit,recentSales:mySales.slice(0,10)})
  }catch(e){setError(e.message)}finally{setLoading(false)}};
  const role=(employee.roles||[])[0];
  return <><div className="page-head between"><div style={{display:'flex',alignItems:'center',gap:12}}><button className="icon-btn" onClick={back}><ArrowLeft/></button><div><h2>{employee.full_name||'Nomsiz'}</h2><p>{roleLabels[role?.role]||''} · {employee.phone||employee.email||''}</p></div></div><div className="period-selector"><button className={period==='week'?'active':''} onClick={()=>setPeriod('week')}>Hafta</button><button className={period==='month'?'active':''} onClick={()=>setPeriod('month')}>Oy</button><button className={period==='year'?'active':''} onClick={()=>setPeriod('year')}>Yil</button></div></div>
  {loading?<div className="employee-loading">Statistika yuklanmoqda...</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={loadStats}>Qayta urinish</button></div>:<>
  <div className="stats-cards"><div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value">{stats.salesCount}</span><span className="stat-label">Sotuvlar soni</span></div></div><div className="stat-card"><Store size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalRevenue)} rate={rate}/></span><span className="stat-label">Umumiy tushum</span></div></div><div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalProfit)} rate={rate}/></span><span className="stat-label">Sof foyda</span></div></div></div>
  {stats.recentSales.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem 0'}}>So'nggi sotuvlar</h3><div className="table-wrap"><table className="table"><thead><tr><th>Sotuv #</th><th>Sana</th><th>Summa</th><th>Foyda</th><th>Holat</th></tr></thead><tbody>{stats.recentSales.map((s,i)=><tr key={i}><td><code>{s.sale_no}</code></td><td>{new Date(s.sold_at).toLocaleDateString('uz-UZ')}</td><td><DualPrice value={Number(s.total)} rate={rate}/></td><td><DualPrice value={Number(s.profit)} rate={rate}/></td><td><Status type={s.status==='completed'?'green':'blue'}>{s.status}</Status></td></tr>)}</tbody></table></div></div>}
  {stats.salesCount===0&&<div className="empty" style={{marginTop:'1rem'}}><BarChart3 size={40}/><h3>Statistika yo'q</h3><p>Tanlangan davrda bu xodim sotuvlar amalga oshirmagan.</p></div>}
  </>}</>;
}

/* --- Location Detail: stats, analytics, inventory --- */
function LocationDetail({location,branch,back,toast}){
  const rate=useExchangeRate();
  const[stats,setStats]=useState(null),[inventory,setInventory]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const[period,setPeriod]=useState('month'),[showInventory,setShowInventory]=useState(false),[selectedProduct,setSelectedProduct]=useState(null);

  useEffect(()=>{loadData()},[location,period]);

  const loadData=async()=>{setLoading(true);setError('');try{
    const now=new Date();let from;
    if(period==='week'){const d=new Date(now);d.setDate(d.getDate()-7);from=d.toISOString().split('T')[0]}
    else if(period==='month'){const d=new Date(now);d.setMonth(d.getMonth()-1);from=d.toISOString().split('T')[0]}
    else{const d=new Date(now);d.setFullYear(d.getFullYear()-1);from=d.toISOString().split('T')[0]}
    const to=now.toISOString().split('T')[0];
    const client=getBrowserClient();

    // Inventory units in this location
    const{data:units,error:uErr}=await client.from('inventory_units').select('id,product_id,status,products(name,sku,category_id,retail_price,cost_price,categories(name))').eq('location_id',location.id).order('created_at',{ascending:false}).limit(500);
    if(uErr)throw uErr;
    setInventory(units||[]);

    // Sales report for this branch
    const{data:salesRows,error:sErr}=await client.rpc('report_sales_rows',{p_from:from,p_to:to,p_branch_id:branch.id});
    if(sErr)throw sErr;

    const sales=(salesRows||[]).filter(s=>s.status!=='void');
    const totalRevenue=sales.reduce((s,r)=>s+(Number(r.total)||0),0);
    const totalProfit=sales.reduce((s,r)=>s+(Number(r.profit)||0),0);
    const totalCost=sales.reduce((s,r)=>s+(Number(r.cost)||0),0);

    // Inventory value
    const availableUnits=(units||[]).filter(u=>u.status==='available');
    const totalItems=availableUnits.length;
    const inventoryValue=availableUnits.reduce((s,u)=>s+(u.products?.cost_price||0),0);
    const retailValue=availableUnits.reduce((s,u)=>s+(u.products?.retail_price||0),0);

    // Category breakdown
    const catMap={};availableUnits.forEach(u=>{const cat=u.products?.categories?.name||'Boshqa';if(!catMap[cat])catMap[cat]={name:cat,count:0,value:0};catMap[cat].count++;catMap[cat].value+=u.products?.retail_price||0});
    const categories=Object.values(catMap).sort((a,b)=>b.count-a.count);

    // Top/bottom selling products
    const productSales={};sales.forEach(s=>{/* we don't have per-line in report_sales_rows, use aggregated */});
    // Use inventory sold count from units
    const soldUnits=(units||[]).filter(u=>u.status==='sold');
    const productCount={};(units||[]).forEach(u=>{const name=u.products?.name||'?';if(!productCount[name])productCount[name]={name,sku:u.products?.sku||'',available:0,sold:0};if(u.status==='available')productCount[name].available++;if(u.status==='sold')productCount[name].sold++});
    const productList=Object.values(productCount).sort((a,b)=>b.sold-a.sold);
    const topSelling=productList.filter(p=>p.sold>0).slice(0,5);
    const lowSelling=productList.filter(p=>p.sold===0&&p.available>0).slice(0,5);

    // Branch debt
    const{data:debtData}=await client.from('transfers').select('total_amount,status').eq('to_branch_id',branch.id).in('status',['in_transit','received','requested','approved']);
    const totalDebt=(debtData||[]).reduce((s,t)=>s+(Number(t.total_amount)||0),0);

    setStats({totalItems,inventoryValue,retailValue,totalRevenue,totalProfit,totalCost,totalDebt,categories,topSelling,lowSelling,salesCount:sales.length});
  }catch(e){setError(e.message)}finally{setLoading(false)}};

  if(selectedProduct)return <ProductDetailView unit={selectedProduct} back={()=>setSelectedProduct(null)}/>;

  return <><div className="page-head between"><div style={{display:'flex',alignItems:'center',gap:12}}><button className="icon-btn" onClick={back}><ArrowLeft/></button><div><h2>{location.name}</h2><p>{location.code} · {locationTypes[location.type]||location.type} · {branch.name}</p></div></div><div className="period-selector"><button className={period==='week'?'active':''} onClick={()=>setPeriod('week')}>Hafta</button><button className={period==='month'?'active':''} onClick={()=>setPeriod('month')}>Oy</button><button className={period==='year'?'active':''} onClick={()=>setPeriod('year')}>Yil</button></div></div>

  {loading?<div className="employee-loading">Yuklanmoqda...</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={loadData}>Qayta urinish</button></div>:<>

  <div className="stats-cards">
    <div className="stat-card"><Warehouse size={20}/><div><span className="stat-value">{stats.totalItems}</span><span className="stat-label">Mavjud tovarlar</span></div></div>
    <div className="stat-card"><Store size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.inventoryValue)} rate={rate}/></span><span className="stat-label">Tannarxi</span></div></div>
    <div className="stat-card"><Store size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.retailValue)} rate={rate}/></span><span className="stat-label">Chakana qiymati</span></div></div>
    <div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value">{stats.salesCount}</span><span className="stat-label">Sotuvlar soni</span></div></div>
    <div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalRevenue)} rate={rate}/></span><span className="stat-label">Daromad</span></div></div>
    <div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalProfit)} rate={rate}/></span><span className="stat-label">Sof foyda</span></div></div>
    <div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalCost)} rate={rate}/></span><span className="stat-label">Harajat (tannarx)</span></div></div>
    <div className="stat-card"><AlertTriangle size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalDebt)} rate={rate}/></span><span className="stat-label">Qarz (transfer)</span></div></div>
  </div>

  {stats.categories.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem 0'}}>Kategoriya bo'yicha tovarlar</h3><div className="table-wrap"><table className="table"><thead><tr><th>Kategoriya</th><th>Soni</th><th>Qiymati</th></tr></thead><tbody>{stats.categories.map((c,i)=><tr key={i}><td><b>{c.name}</b></td><td>{c.count}</td><td><DualPrice value={Number(c.value)} rate={rate}/></td></tr>)}</tbody></table></div></div>}

  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'1rem'}}>
  {stats.topSelling.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem 0'}}>Ko'p sotilgan</h3><div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>Sotilgan</th><th>Qoldiq</th></tr></thead><tbody>{stats.topSelling.map((p,i)=><tr key={i}><td><b>{p.name}</b><br/><small className="muted">{p.sku}</small></td><td>{p.sold}</td><td>{p.available}</td></tr>)}</tbody></table></div></div>}
  {stats.lowSelling.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem 0'}}>Kam sotilgan (qoldiqda)</h3><div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>Qoldiq</th></tr></thead><tbody>{stats.lowSelling.map((p,i)=><tr key={i}><td><b>{p.name}</b><br/><small className="muted">{p.sku}</small></td><td>{p.available}</td></tr>)}</tbody></table></div></div>}
  </div>

  <div className="card" style={{marginTop:'1rem'}}><div className="section-head"><h3><Warehouse size={18}/> Barcha tovarlar ({inventory.length})</h3><button className="btn btn-outline btn-sm" onClick={()=>setShowInventory(!showInventory)}>{showInventory?'Yopish':'Ko\'rsatish'}</button></div>
  {showInventory&&<div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>SKU</th><th>Kategoriya</th><th>Holat</th><th>Narxi</th></tr></thead><tbody>{inventory.slice(0,100).map(u=><tr key={u.id} className="clickable-row" onClick={()=>setSelectedProduct(u)}><td><b>{u.products?.name||'?'}</b></td><td><code>{u.products?.sku||'-'}</code></td><td>{u.products?.categories?.name||'-'}</td><td><Status type={u.status==='available'?'green':u.status==='sold'?'blue':'red'}>{u.status}</Status></td><td><DualPrice value={Number(u.products?.retail_price||0)} rate={rate}/></td></tr>)}</tbody></table></div>}</div>
  </>}</>;
}

/* --- Product Detail View from inventory unit --- */
function ProductDetailView({unit,back}){
  const rate=useExchangeRate();
  const[product,setProduct]=useState(null),[media,setMedia]=useState([]),[loading,setLoading]=useState(true);
  useEffect(()=>{loadProduct()},[unit]);
  const loadProduct=async()=>{setLoading(true);try{
    const client=getBrowserClient();
    const{data:p}=await client.from('products').select('*,categories(name),brands(name)').eq('id',unit.product_id).single();
    const{data:m}=await client.from('product_media').select('*').eq('product_id',unit.product_id).order('is_primary',{ascending:false}).order('sort_order');
    setProduct(p);setMedia(m||[]);
  }catch(e){}finally{setLoading(false)}};
  if(loading)return <div className="employee-loading">Yuklanmoqda...</div>;
  if(!product)return <div className="empty"><AlertTriangle/><h3>Mahsulot topilmadi</h3><button className="btn" onClick={back}>Orqaga</button></div>;
  return <><div className="page-head between"><div style={{display:'flex',alignItems:'center',gap:12}}><button className="icon-btn" onClick={back}><ArrowLeft/></button><div><h2>{product.name}</h2><p>{product.sku} · {product.categories?.name||'Kategoriya yo\'q'} · {product.brands?.name||''}</p></div></div></div>
  <div className="product-detail-grid">
    <div className="card product-info-card"><h3>Asosiy ma'lumotlar</h3>
      <div className="product-info-rows">
        <div><span>SKU:</span><b>{product.sku}</b></div>
        <div><span>Barkod:</span><b>{product.barcode||'-'}</b></div>
        <div><span>Kategoriya:</span><b>{product.categories?.name||'-'}</b></div>
        <div><span>Brend:</span><b>{product.brands?.name||'-'}</b></div>
        <div><span>Chakana narx:</span><b><DualPrice value={Number(product.retail_price||0)} rate={rate}/></b></div>
        <div><span>Ulgurji narx:</span><b><DualPrice value={Number(product.wholesale_price||0)} rate={rate}/></b></div>
        <div><span>Aksiya narx:</span><b>{product.promotion_price?<DualPrice value={Number(product.promotion_price)} rate={rate}/>:'-'}</b></div>
        <div><span>Tannarx:</span><b><DualPrice value={Number(product.cost_price||0)} rate={rate}/></b></div>
        <div><span>Holat:</span><b>{product.status}</b></div>
        <div><span>Nashr qilingan:</span><b>{product.is_published?'Ha':'Yo\'q'}</b></div>
      </div>
    </div>
    {media.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem .5rem'}}>Rasmlar ({media.length})</h3><div className="product-media-grid">{media.map(m=><div key={m.id} className="product-media-item"><img src={m.public_url} alt={m.alt_text||product.name} onError={e=>{e.target.style.display='none'}}/></div>)}</div></div>}
    {product.description&&<div className="card"><h3 style={{padding:'1rem 1rem .5rem'}}>Tavsif</h3><p style={{padding:'0 1rem 1rem',color:'var(--muted)'}}>{product.description}</p></div>}
  </div></>;
}
