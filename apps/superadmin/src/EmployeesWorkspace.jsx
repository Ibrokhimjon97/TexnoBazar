import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,ArrowLeft,BarChart3,Calendar,Filter,Pencil,Plus,Search,Trash2}from'lucide-react';
import{DualPrice,Empty,Modal,Status,useAuth,useExchangeRate}from'@texnobazar/ui';
import{getAccessToken,getBrowserClient,listActiveBranches,listEmployees,setEmployeeActive}from'@texnobazar/data';

const roleLabels={manager:'Menejer',seller:'Sotuvchi',courier:'Kuryer',warehouse:'Omborchi',accountant:'Hisobchi',superadmin:'Superadmin',admin:'Administrator'};

export default function EmployeesWorkspace({toast}){
  const{roles}=useAuth(),canManage=roles.some(r=>r.role==='superadmin');
  const[rows,setRows]=useState([]),[branches,setBranches]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const[open,setOpen]=useState(false),[editing,setEditing]=useState(null),[selectedEmployee,setSelectedEmployee]=useState(null);
  const[query,setQuery]=useState(''),[filterRole,setFilterRole]=useState(''),[filterBranch,setFilterBranch]=useState('');

  const load=async()=>{setLoading(true);setError('');try{const[e,b]=await Promise.all([listEmployees(),listActiveBranches()]);setRows(e);setBranches(b)}catch(e){setError(e.message||'Xodimlar yuklanmadi')}finally{setLoading(false)}};
  useEffect(()=>{if(canManage)load();else{setLoading(false);setError('Xodimlarni faqat global superadmin boshqaradi.')}},[canManage]);

  const filtered=useMemo(()=>{let list=rows;if(query.trim()){const q=query.trim().toLowerCase();list=list.filter(r=>[r.full_name,r.email,r.phone].some(x=>(x||'').toLowerCase().includes(q)))}if(filterRole){list=list.filter(r=>(r.roles||[]).some(x=>x.role===filterRole))}if(filterBranch){list=list.filter(r=>(r.roles||[]).some(x=>x.branch_id===filterBranch))}return list},[rows,query,filterRole,filterBranch]);

  const toggle=async row=>{try{await setEmployeeActive(row.employee_id,!row.is_active);toast(row.is_active?'Xodim faolsizlantirildi':'Xodim faollashtirildi');await load()}catch(e){setError(e.message)}};
  const remove=async row=>{if(!confirm(`"${row.full_name}" xodimini o'chirishni tasdiqlaysizmi?`))return;try{const token=await getAccessToken();const res=await fetch('/api/employees/create',{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({employeeId:row.employee_id})});if(!res.ok){const b=await res.json().catch(()=>({}));throw new Error(b.error||"O'chirib bo'lmadi")}toast("Xodim o'chirildi");await load()}catch(e){setError(e.message)}};

  if(selectedEmployee)return <EmployeeStats employee={selectedEmployee} back={()=>setSelectedEmployee(null)}/>;

  return <><div className="page-head between"><div><h2>Xodimlar</h2><p>Jamoa rollari, filial biriktirishlarini boshqaring va statistikani ko'ring.</p></div>{canManage&&<button className="btn btn-primary" onClick={()=>{setEditing(null);setOpen(true)}}><Plus/> Xodim qo'shish</button>}</div>
  <div className="card data-card"><div className="toolbar"><label><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Ism, email yoki telefon bo'yicha qidirish..."/></label><select className="select" value={filterRole} onChange={e=>setFilterRole(e.target.value)} style={{maxWidth:160}}><option value="">Barcha rollar</option>{Object.entries(roleLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><select className="select" value={filterBranch} onChange={e=>setFilterBranch(e.target.value)} style={{maxWidth:200}}><option value="">Barcha filiallar</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
  {loading?<div className="employee-loading">Xodimlar yuklanmoqda...</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:filtered.length===0?<Empty title="Xodimlar topilmadi" text="Qidiruv yoki filtrni o'zgartiring."/>:
  <div className="table-wrap"><table className="table"><thead><tr><th>Xodim</th><th>Rol</th><th>Filial</th><th>Yaratilgan</th><th>Holat</th><th>Amal</th></tr></thead><tbody>{filtered.map(row=>{const assigned=row.roles?.[0]||{};return <tr key={row.employee_id} className="clickable-row" onClick={()=>setSelectedEmployee(row)}><td><div style={{display:'flex',alignItems:'center',gap:10}}>{row.avatar_url?<img src={row.avatar_url} alt="" style={{width:34,height:34,borderRadius:'50%',objectFit:'cover',flex:'0 0 34px'}}/>:<div className="avatar" style={{width:34,height:34,fontSize:12}}>{(row.full_name||'N').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()}</div>}<div><b>{row.full_name||'Nomsiz'}</b><small className="muted">{row.email}{row.phone?` · ${row.phone}`:''}</small></div></div></td><td>{(row.roles||[]).map(r=><Status key={`${r.role}-${r.branch_id}`} type="blue">{roleLabels[r.role]||r.role}</Status>)}</td><td>{assigned.branch_name||'Global'}</td><td>{new Date(row.created_at).toLocaleDateString('uz-UZ')}</td><td><Status type={row.is_active?'green':'red'}>{row.is_active?'Faol':'Nofaol'}</Status></td><td><div className="master-actions" onClick={e=>e.stopPropagation()}><button className="icon-btn" title="Tahrirlash" onClick={()=>{setEditing(row);setOpen(true)}}><Pencil size={15}/></button><button className="icon-btn" title="O'chirish" onClick={()=>remove(row)}><Trash2 size={15}/></button><button className={row.is_active?'btn btn-danger':'btn btn-primary'} onClick={()=>toggle(row)}>{row.is_active?'Faolsizlantirish':'Faollashtirish'}</button></div></td></tr>})}</tbody></table></div>}</div>
  <EmployeeModal open={open} close={()=>{setOpen(false);setEditing(null)}} branches={branches} employee={editing} created={async()=>{setOpen(false);setEditing(null);toast(editing?'Xodim yangilandi':'Xodim yaratildi');await load()}}/></>;
}

/* --- Employee Create/Edit Modal --- */
function EmployeeModal({open,close,branches,employee,created}){
  const initial={fullName:'',email:'',phone:'',role:'seller',branchId:'',password:''};
  const[form,setForm]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(open){if(employee){const r=employee.roles?.[0]||{};setForm({fullName:employee.full_name||'',email:employee.email||'',phone:employee.phone||'',role:r.role||'seller',branchId:r.branch_id||'',password:''})}else{setForm({...initial,branchId:branches[0]?.id||''})}setError('')}},[open,branches,employee]);

  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const token=await getAccessToken();if(!token)throw new Error('Sessiya topilmadi.');if(employee){const client=getBrowserClient();const{error:upErr}=await client.from('profiles').update({full_name:form.fullName.trim(),phone:form.phone.trim()||null}).eq('id',employee.employee_id);if(upErr)throw upErr;const currentRole=employee.roles?.[0];if(currentRole&&(currentRole.role!==form.role||currentRole.branch_id!==form.branchId)){await client.from('profile_roles').update({role:form.role,branch_id:form.branchId||null}).eq('id',currentRole.id)}}else{const res=await fetch('/api/employees/create',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(form)}),body=await res.json();if(!res.ok)throw new Error(body.error||'Xodim yaratilmadi')}await created()}catch(err){setError(err.message)}finally{setBusy(false)}};

  return <Modal open={open} onClose={close} title={employee?'Xodimni tahrirlash':'Yangi xodim'}><form onSubmit={submit} className="employee-form-grid">{error&&<div className="employee-error wide">{error}</div>}<label className="wide"><span className="label">To'liq ism</span><input className="input" value={form.fullName} onChange={e=>setForm({...form,fullName:e.target.value})} required minLength="3"/></label><label><span className="label">Email (ixtiyoriy)</span><input className="input" type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label><label><span className="label">Telefon</span><input className="input" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} required/></label><label><span className="label">Rol</span><select className="select" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{['manager','seller','courier'].map(r=><option key={r} value={r}>{roleLabels[r]}</option>)}</select></label><label><span className="label">Filial</span><select className="select" value={form.branchId} onChange={e=>setForm({...form,branchId:e.target.value})} required><option value="">Tanlang</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>{!employee&&<label className="wide"><span className="label">Vaqtinchalik parol</span><input className="input" type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} required minLength="4"/></label>}<button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda...':employee?'Saqlash':'Yaratish'}</button></form></Modal>;
}

/* --- Employee Statistics View (uses RPC instead of direct table access) --- */
function EmployeeStats({employee,back}){
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
    // Use report RPC which has proper security definer access
    const{data:salesRows,error:sErr}=await client.rpc('report_sales_rows',{p_from:from,p_to:to,p_branch_id:null});
    if(sErr)throw sErr;

    // Filter by this employee (seller)
    const mySales=(salesRows||[]).filter(s=>s.seller_name===(employee.full_name));
    const salesCount=mySales.length;
    const totalRevenue=mySales.reduce((sum,s)=>sum+(Number(s.total)||0),0);
    const totalProfit=mySales.reduce((sum,s)=>sum+(Number(s.profit)||0),0);

    setStats({salesCount,totalRevenue,totalProfit,recentSales:mySales.slice(0,15)});
  }catch(e){setError(e.message)}finally{setLoading(false)}};

  const role=employee.roles?.[0];
  return <><div className="page-head between"><div style={{display:'flex',alignItems:'center',gap:12}}><button className="icon-btn" onClick={back}><ArrowLeft/></button>{employee.avatar_url?<img src={employee.avatar_url} alt="" style={{width:42,height:42,borderRadius:'50%',objectFit:'cover'}}/>:null}<div><h2>{employee.full_name||'Nomsiz xodim'}</h2><p>{roleLabels[role?.role]||'Noma\'lum rol'} · {role?.branch_name||'Global'} · {employee.phone||employee.email||''}</p></div></div><div className="period-selector"><button className={period==='week'?'active':''} onClick={()=>setPeriod('week')}>Hafta</button><button className={period==='month'?'active':''} onClick={()=>setPeriod('month')}>Oy</button><button className={period==='year'?'active':''} onClick={()=>setPeriod('year')}>Yil</button></div></div>

  {loading?<div className="employee-loading">Statistika yuklanmoqda...</div>:error?<div className="empty"><AlertTriangle/><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={loadStats}>Qayta urinish</button></div>:<>
  <div className="stats-cards"><div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value">{stats.salesCount}</span><span className="stat-label">Sotuvlar soni</span></div></div><div className="stat-card"><Calendar size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalRevenue)} rate={rate}/></span><span className="stat-label">Umumiy tushum</span></div></div><div className="stat-card"><BarChart3 size={20}/><div><span className="stat-value"><DualPrice value={Number(stats.totalProfit)} rate={rate}/></span><span className="stat-label">Sof foyda</span></div></div></div>

  {stats.recentSales.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem 0'}}>So'nggi sotuvlar</h3><div className="table-wrap"><table className="table"><thead><tr><th>Sotuv #</th><th>Sana</th><th>Summa</th><th>Foyda</th><th>Holat</th></tr></thead><tbody>{stats.recentSales.map((s,i)=><tr key={i}><td><code>{s.sale_no}</code></td><td>{new Date(s.sold_at).toLocaleDateString('uz-UZ')}</td><td><DualPrice value={Number(s.total)} rate={rate}/></td><td><DualPrice value={Number(s.profit)} rate={rate}/></td><td><Status type={s.status==='completed'?'green':'blue'}>{s.status}</Status></td></tr>)}</tbody></table></div></div>}

  {stats.salesCount===0&&<div className="empty" style={{marginTop:'1rem'}}><BarChart3 size={40}/><h3>Statistika yo'q</h3><p>Tanlangan davrda bu xodim sotuvlar amalga oshirmagan.</p></div>}
  </>}</>;
}
