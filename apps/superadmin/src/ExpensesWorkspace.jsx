import React,{useEffect,useState}from'react';
import{AlertTriangle,CheckCircle2,Pencil,Plus,Trash2,Users,Wallet}from'lucide-react';
import{DualPrice,Empty,Modal,Status,useExchangeRate}from'@texnobazar/ui';
import{getBrowserClient,listActiveBranches,listEmployees}from'@texnobazar/data';

const categories={tax:'Soliq',rent:'Ijara',electricity:'Elektr energiya',water:'Suv',gas:'Gaz',llc:'MChJ',sole_trader:'YaTT',salary:'Maosh',transport:'Transport',other:'Boshqa'};
const currentMonth=()=>{const d=new Date();return d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0')};

export default function ExpensesWorkspace({toast}){
  const[tab,setTab]=useState('expenses');
  return <><div className="page-head between"><div><h2>Xarajatlar</h2><p>Oylik harajatlar va xodimlar maoshini boshqaring</p></div></div>
  <div className="master-tabs"><button className={tab==='expenses'?'active':''} onClick={()=>setTab('expenses')}>Harajatlar</button><button className={tab==='salary'?'active':''} onClick={()=>setTab('salary')}>Maoshlar</button></div>
  {tab==='expenses'?<ExpensesPanel toast={toast}/>:<SalaryPanel toast={toast}/>}</>;
}

function ExpensesPanel({toast}){
  const rate=useExchangeRate();
  const[rows,setRows]=useState([]),[loading,setLoading]=useState(true),[month,setMonth]=useState(currentMonth()),[branches,setBranches]=useState([]),[filterBranch,setFilterBranch]=useState('');
  const[open,setOpen]=useState(false),[editing,setEditing]=useState(null),[payModal,setPayModal]=useState(null);
  const[salaryRows,setSalaryRows]=useState([]);

  const load=async()=>{setLoading(true);try{const client=getBrowserClient();const{data:br}=await client.from('branches').select('id,name').eq('is_active',true);setBranches(br||[]);let expQ=client.from('expenses').select('*').eq('period_month',month);let salQ=client.from('salary_payments').select('*').eq('period_month',month);if(filterBranch){expQ=expQ.or(`branch_id.eq.${filterBranch},branch_id.is.null`);salQ=salQ.or(`branch_id.eq.${filterBranch},branch_id.is.null`)}const[{data:exp},{data:sal}]=await Promise.all([expQ.order('created_at',{ascending:false}),salQ]);setRows(exp||[]);setSalaryRows(sal||[])}catch(e){}finally{setLoading(false)}};
  useEffect(()=>{load()},[month,filterBranch]);

  const remove=async row=>{if(!confirm(row.title+" ni ochirasizmi?"))return;try{await getBrowserClient().from('expenses').delete().eq('id',row.id);setRows(r=>r.filter(x=>x.id!==row.id));toast("Harajat ochirildi")}catch(e){alert(e.message)}};

  const totalExpense=rows.reduce((s,r)=>s+Number(r.amount||0),0);
  const totalPaidExpense=rows.reduce((s,r)=>s+Number(r.paid_amount||0),0);
  const expenseDebt=totalExpense-totalPaidExpense;
  const totalSalaryBase=salaryRows.reduce((s,r)=>s+Number(r.base_salary||0)+Number(r.bonus||0),0);
  const totalSalaryPaid=salaryRows.reduce((s,r)=>s+Number(r.salary_paid||0)+Number(r.advance_paid||0),0);
  const salaryDebt=totalSalaryBase-totalSalaryPaid;

  return <><div className="stats-cards" style={{marginBottom:'1rem'}}>
    <div className="stat-card"><Wallet size={20}/><div><span className="stat-value"><DualPrice value={totalExpense+totalSalaryBase} rate={rate}/></span><span className="stat-label">Umumiy harajat</span></div></div>
    <div className="stat-card"><CheckCircle2 size={20}/><div><span className="stat-value"><DualPrice value={totalPaidExpense+totalSalaryPaid} rate={rate}/></span><span className="stat-label">To'langan</span></div></div>
    <div className="stat-card"><AlertTriangle size={20}/><div><span className="stat-value" style={{color:'var(--primary)'}}><DualPrice value={expenseDebt+salaryDebt} rate={rate}/></span><span className="stat-label">Umumiy qarz</span></div></div>
    <div className="stat-card"><Users size={20}/><div><span className="stat-value"><DualPrice value={totalSalaryBase} rate={rate}/></span><span className="stat-label">Maosh hisoblangan</span></div></div>
    <div className="stat-card"><CheckCircle2 size={20}/><div><span className="stat-value"><DualPrice value={totalSalaryPaid} rate={rate}/></span><span className="stat-label">Maosh to'langan</span></div></div>
    <div className="stat-card"><AlertTriangle size={20}/><div><span className="stat-value" style={{color:salaryDebt>0?'var(--primary)':'green'}}><DualPrice value={salaryDebt} rate={rate}/></span><span className="stat-label">Maosh qarz</span></div></div>
  </div>

  <div className="card data-card"><div className="toolbar"><input type="month" className="input" value={month} onChange={e=>setMonth(e.target.value)} style={{maxWidth:180}}/><select className="select" value={filterBranch} onChange={e=>setFilterBranch(e.target.value)} style={{maxWidth:200}}><option value="">Barcha filiallar</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><button className="btn btn-primary" onClick={()=>{setEditing(null);setOpen(true)}}><Plus size={14}/> Harajat qo'shish</button></div>
  {loading?<div className="employee-loading">Yuklanmoqda...</div>:rows.length===0?<Empty title="Harajat topilmadi" text="Bu oyda hali harajat kiritilmagan."/>:
  <div className="table-wrap"><table className="table"><thead><tr><th>Kategoriya</th><th>Nomi</th><th>Summa</th><th>To'langan</th><th>Qoldiq</th><th>Sana</th><th>Amal</th></tr></thead><tbody>{rows.map(r=>{const debt=Number(r.amount)-Number(r.paid_amount||0);return <tr key={r.id}><td><Status type="blue">{categories[r.category]||r.category}</Status></td><td><b>{r.title}</b></td><td><DualPrice value={Number(r.amount)} rate={rate}/></td><td><DualPrice value={Number(r.paid_amount||0)} rate={rate}/></td><td style={{color:debt>0?'var(--primary)':'green'}}><b><DualPrice value={debt} rate={rate}/></b></td><td>{r.paid_at?new Date(r.paid_at).toLocaleDateString('uz-UZ'):'-'}</td><td><div className="master-actions"><button className="btn btn-primary btn-sm" onClick={()=>setPayModal(r)}>To'landi</button><button className="icon-btn" onClick={()=>{setEditing(r);setOpen(true)}}><Pencil size={14}/></button><button className="icon-btn" onClick={()=>remove(r)}><Trash2 size={14}/></button></div></td></tr>})}</tbody></table></div>}</div>
  <ExpenseModal open={open} close={()=>{setOpen(false);setEditing(null)}} expense={editing} month={month} onSaved={async()=>{setOpen(false);setEditing(null);toast(editing?'Harajat yangilandi':'Harajat qo\'shildi');await load()}}/>
  {payModal&&<PayExpenseModal expense={payModal} close={()=>setPayModal(null)} onPaid={async()=>{setPayModal(null);toast("To'lov saqlandi");await load()}} rate={rate}/>}</>;
}

function PayExpenseModal({expense,close,onPaid,rate}){
  const[mode,setMode]=useState('full'),[amount,setAmount]=useState(''),[busy,setBusy]=useState(false);
  const debt=Number(expense.amount)-Number(expense.paid_amount||0);
  const submit=async e=>{e.preventDefault();setBusy(true);try{const payAmount=mode==='full'?debt:Number(amount);if(payAmount<=0||payAmount>debt){alert("Noto'g'ri summa");return}const newPaid=Number(expense.paid_amount||0)+payAmount;await getBrowserClient().from('expenses').update({paid_amount:newPaid,paid_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',expense.id);await onPaid()}catch(err){alert(err.message)}finally{setBusy(false)}};
  return <Modal open onClose={close} title={expense.title+" - to'lov"}><form className="employee-form-grid" onSubmit={submit}><div className="wide"><p>Qoldiq: <b><DualPrice value={debt} rate={rate}/></b></p></div><label className="wide"><select className="select" value={mode} onChange={e=>setMode(e.target.value)}><option value="full">To'liq to'landi ({debt.toLocaleString('uz-UZ')} so'm)</option><option value="partial">Qisman to'lov</option></select></label>{mode==='partial'&&<label className="wide"><span className="label">To'langan summa</span><input className="input" type="number" min="1" max={debt} value={amount} onChange={e=>setAmount(e.target.value)} required/></label>}<button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda...':'Saqlash'}</button></form></Modal>;
}

function ExpenseModal({open,close,expense,month,onSaved}){
  const empty={category:'rent',title:'',amount:'',note:'',paid_at:'',branch_id:''};
  const[form,setForm]=useState(empty),[branches,setBranches]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){getBrowserClient().from('branches').select('id,name').eq('is_active',true).then(({data})=>setBranches(data||[]));setForm(expense?{category:expense.category,title:expense.title,amount:String(expense.amount),note:expense.note||'',paid_at:expense.paid_at?expense.paid_at.split('T')[0]:'',branch_id:expense.branch_id||''}:{...empty});setError('')}},[open,expense]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const client=getBrowserClient();const payload={category:form.category,title:form.title.trim(),amount:Number(form.amount),period_month:month,note:form.note.trim()||null,paid_at:form.paid_at||null,branch_id:form.branch_id||null};if(expense){await client.from('expenses').update({...payload,updated_at:new Date().toISOString()}).eq('id',expense.id)}else{const{data:{user}}=await client.auth.getUser();await client.from('expenses').insert({...payload,created_by:user.id})}await onSaved()}catch(err){setError(err.message)}finally{setBusy(false)}};
  return <Modal open={open} onClose={close} title={expense?'Harajatni tahrirlash':'Yangi harajat'}><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label><span className="label">Filial</span><select className="select" value={form.branch_id} onChange={e=>setForm({...form,branch_id:e.target.value})}><option value="">Umumiy (filialsiz)</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label><label><span className="label">Kategoriya</span><select className="select" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label><span className="label">Nomi</span><input className="input" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} required minLength="2"/></label><label><span className="label">Summa (so'm)</span><input className="input" type="number" min="1" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} required/></label><label><span className="label">Muddati</span><input className="input" type="date" value={form.paid_at} onChange={e=>setForm({...form,paid_at:e.target.value})}/></label><label className="wide"><span className="label">Izoh</span><input className="input" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label><button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda...':'Saqlash'}</button></form></Modal>;
}

function SalaryPanel({toast}){
  const rate=useExchangeRate();
  const[rows,setRows]=useState([]),[employees,setEmployees]=useState([]),[loading,setLoading]=useState(true);
  const[month,setMonth]=useState(currentMonth()),[branches,setBranches]=useState([]),[filterBranch,setFilterBranch]=useState('');
  const[selected,setSelected]=useState(null),[open,setOpen]=useState(false),[editing,setEditing]=useState(null),[extraModal,setExtraModal]=useState(null),[extraHistory,setExtraHistory]=useState(null);
  const load=async()=>{setLoading(true);try{const client=getBrowserClient();const{data:br}=await client.from('branches').select('id,name').eq('is_active',true);setBranches(br||[]);let salQ=client.from('salary_payments').select('*').eq('period_month',month);if(filterBranch)salQ=salQ.or(`branch_id.eq.${filterBranch},branch_id.is.null`);const{data:sal,error:salErr}=await salQ.order('created_at',{ascending:false});if(salErr)console.error('salary load error:',salErr);const emps=await listEmployees().catch(()=>[]);setRows(sal||[]);setEmployees(emps||[])}catch(e){}finally{setLoading(false)}};
  useEffect(()=>{load()},[month,filterBranch]);
  const remove=async row=>{if(!confirm("Bu yozuvni ochirasizmi?"))return;try{await getBrowserClient().from('salary_payments').delete().eq('id',row.id);setRows(r=>r.filter(x=>x.id!==row.id));toast("Ochirildi")}catch(e){alert(e.message)}};
  const totalPaid=rows.reduce((s,r)=>s+Number(r.salary_paid||0)+Number(r.advance_paid||0)+Number(r.extra_paid||0),0);
  const totalDue=rows.reduce((s,r)=>s+Number(r.base_salary||0)+Number(r.bonus||0)-Number(r.salary_paid||0)-Number(r.advance_paid||0)-Number(r.extra_paid||0),0);

  return <><div className="card data-card"><div className="toolbar"><input type="month" className="input" value={month} onChange={e=>setMonth(e.target.value)} style={{maxWidth:180}}/><select className="select" value={filterBranch} onChange={e=>setFilterBranch(e.target.value)} style={{maxWidth:200}}><option value="">Barcha filiallar</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><span style={{fontWeight:700}}>To'langan: <DualPrice value={totalPaid} rate={rate}/> | Qoldiq: <DualPrice value={totalDue} rate={rate}/></span><button className="btn btn-primary" onClick={()=>{setEditing(null);setOpen(true)}}><Plus size={14}/> Maosh kiritish</button></div>
  {loading?<div className="employee-loading">Yuklanmoqda...</div>:rows.length===0?<Empty title="Maosh yozuvi topilmadi" text="Bu oyda hali maosh kiritilmagan."/>:
  <div className="table-wrap"><table className="table"><thead><tr><th>Xodim</th><th>Oylik</th><th>Ustama</th><th>Avans</th><th>To'langan</th><th>Qo'shimcha</th><th>Qoldiq</th><th>Amal</th></tr></thead><tbody>{rows.map(r=>{const due=Number(r.base_salary)+Number(r.bonus)-Number(r.salary_paid)-Number(r.advance_paid)-Number(r.extra_paid||0);return <tr key={r.id} className="clickable-row" onClick={()=>setSelected(r)}><td><b>{(employees.find(e=>e.employee_id===r.employee_id)?.full_name)||'Nomsiz'}</b></td><td><DualPrice value={Number(r.base_salary)} rate={rate}/></td><td><DualPrice value={Number(r.bonus)} rate={rate}/></td><td><DualPrice value={Number(r.advance_paid)} rate={rate}/></td><td><DualPrice value={Number(r.salary_paid)} rate={rate}/></td><td className="clickable-row" onClick={e=>{e.stopPropagation();setExtraHistory(r)}} style={{cursor:'pointer',textDecoration:'underline'}}><b><DualPrice value={Number(r.extra_paid||0)} rate={rate}/></b></td><td><b style={{color:due>0?'var(--primary)':'green'}}><DualPrice value={due} rate={rate}/></b></td><td><div className="master-actions" onClick={e=>e.stopPropagation()}><button className="btn btn-outline btn-sm" onClick={()=>setExtraModal(r)}>+ Qo'shimcha</button><button className="icon-btn" onClick={()=>{setEditing(r);setOpen(true)}}><Pencil size={14}/></button><button className="icon-btn" onClick={()=>remove(r)}><Trash2 size={14}/></button></div></td></tr>})}</tbody></table></div>}</div>
  <SalaryModal open={open} close={()=>{setOpen(false);setEditing(null)}} salary={editing} month={month} employees={employees} onSaved={async()=>{setOpen(false);setEditing(null);toast(editing?'Yangilandi':'Maosh kiritildi');await load()}} rate={rate}/>
  {extraHistory&&<ExtraHistoryModal salary={extraHistory} close={()=>setExtraHistory(null)} rate={rate}/>}
  {extraModal&&<ExtraPayModal salary={extraModal} close={()=>setExtraModal(null)} onPaid={async()=>{setExtraModal(null);toast("Qo'shimcha to'lov saqlandi");await load()}}/>}
  {selected&&<SalaryHistoryModal employee={selected} close={()=>setSelected(null)} rate={rate}/>}</>;
}

function SalaryModal({open,close,salary,month,employees,onSaved,rate}){
  const empty={employee_id:'',base_salary:'',bonus:'0',advance_paid:'0',advance_paid_at:'',salary_paid:'0',salary_paid_at:'',note:''};
  const[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){setForm(salary?{employee_id:salary.employee_id||'',base_salary:String(salary.base_salary||0),bonus:String(salary.bonus||0),advance_paid:String(salary.advance_paid||0),advance_paid_at:salary.advance_paid_at||'',salary_paid:String(salary.salary_paid||0),salary_paid_at:salary.salary_paid_at||'',note:salary.note||''}:{...empty,employee_id:employees[0]?.employee_id||''});setError('')}},[open,salary,employees]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const client=getBrowserClient();const payload={employee_id:form.employee_id,period_month:month,base_salary:Number(form.base_salary)||0,bonus:Number(form.bonus)||0,advance_paid:Number(form.advance_paid)||0,salary_paid:Number(form.salary_paid)||0,note:form.note.trim()||null,paid_at:form.salary_paid_at||form.advance_paid_at||null};if(form.advance_paid_at)payload.advance_paid_at=form.advance_paid_at;if(form.salary_paid_at)payload.salary_paid_at=form.salary_paid_at;if(salary){await client.from('salary_payments').update({...payload,updated_at:new Date().toISOString()}).eq('id',salary.id)}else{const{data:{user}}=await client.auth.getUser();const{error:insErr}=await client.from('salary_payments').insert({...payload,created_by:user.id});if(insErr)throw insErr}await onSaved()}catch(err){setError(err.message)}finally{setBusy(false)}};
  const due=Number(form.base_salary||0)+Number(form.bonus||0)-Number(form.salary_paid||0)-Number(form.advance_paid||0);
  return <Modal open={open} onClose={close} title={salary?'Maoshni tahrirlash':'Yangi maosh'}><form className="employee-form-grid" onSubmit={submit}>{error&&<div className="employee-error wide">{error}</div>}<label className="wide"><span className="label">Xodim</span><select className="select" value={form.employee_id} onChange={e=>setForm({...form,employee_id:e.target.value})} required disabled={!!salary}><option value="">Tanlang</option>{employees.map(emp=><option key={emp.employee_id} value={emp.employee_id}>{emp.full_name}</option>)}</select></label><label><span className="label">Oylik maosh</span><input className="input" type="number" min="0" value={form.base_salary} onChange={e=>setForm({...form,base_salary:e.target.value})} required/></label><label><span className="label">Ustama (bonus)</span><input className="input" type="number" min="0" value={form.bonus} onChange={e=>setForm({...form,bonus:e.target.value})}/></label><label><span className="label">Avans to'langan</span><input className="input" type="number" min="0" value={form.advance_paid} onChange={e=>setForm({...form,advance_paid:e.target.value})}/></label><label><span className="label">Avans sanasi</span><input className="input" type="date" value={form.advance_paid_at} onChange={e=>setForm({...form,advance_paid_at:e.target.value})}/></label><label><span className="label">Maosh to'langan</span><input className="input" type="number" min="0" value={form.salary_paid} onChange={e=>setForm({...form,salary_paid:e.target.value})}/></label><label><span className="label">Maosh sanasi</span><input className="input" type="date" value={form.salary_paid_at} onChange={e=>setForm({...form,salary_paid_at:e.target.value})}/></label><label className="wide"><span className="label">Izoh</span><input className="input" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label><div className="wide" style={{padding:'8px 0',fontWeight:700,color:due>0?'var(--primary)':'green'}}>To'lanishi kerak: <DualPrice value={due} rate={rate}/></div><button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda...':'Saqlash'}</button></form></Modal>;
}

function SalaryHistoryModal({employee,close,rate}){
  const[history,setHistory]=useState([]),[loading,setLoading]=useState(true);
  useEffect(()=>{loadHistory()},[employee]);
  const loadHistory=async()=>{setLoading(true);try{const client=getBrowserClient();const{data}=await client.from('salary_payments').select('*').eq('employee_id',employee.employee_id).order('period_month',{ascending:false}).limit(24);setHistory(data||[])}catch(e){}finally{setLoading(false)}};
  const total=history.reduce((s,r)=>s+Number(r.salary_paid||0)+Number(r.advance_paid||0),0);
  return <Modal open onClose={close} title={(employee.profiles?.full_name||'Xodim')+' - maosh tarixi'}><div className="product-detail-modal">
    <div style={{marginBottom:'1rem',fontWeight:700}}>Jami to'langan: <DualPrice value={total} rate={rate}/> ({history.length} oy)</div>
    {loading?<p>Yuklanmoqda...</p>:history.length===0?<p className="muted">Maosh tarixi topilmadi</p>:
    <div className="table-wrap"><table className="table"><thead><tr><th>Oy</th><th>Oylik</th><th>Ustama</th><th>Avans</th><th>To'langan</th><th>Qo'shimcha</th><th>Qoldiq</th><th>Sana</th></tr></thead><tbody>{history.map(r=>{const due=Number(r.base_salary)+Number(r.bonus)-Number(r.salary_paid)-Number(r.advance_paid)-Number(r.extra_paid||0)-Number(r.extra_paid||0);return <tr key={r.id}><td><b>{r.period_month}</b></td><td><DualPrice value={Number(r.base_salary)} rate={rate}/></td><td><DualPrice value={Number(r.bonus)} rate={rate}/></td><td><DualPrice value={Number(r.advance_paid)} rate={rate}/></td><td><DualPrice value={Number(r.salary_paid)} rate={rate}/></td><td><DualPrice value={Number(r.extra_paid||0)} rate={rate}/></td><td style={{color:due>0?'var(--primary)':'green'}}><b><DualPrice value={due} rate={rate}/></b></td><td>{r.salary_paid_at||r.advance_paid_at||'-'}</td></tr>})}</tbody></table></div>}
  </div></Modal>;
}

function ExtraPayModal({salary,close,onPaid}){
  const[amount,setAmount]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  const submit=async e=>{e.preventDefault();setBusy(true);try{
    const extra=Number(amount);if(extra<=0){alert("Summa musbat bo'lishi kerak");return}
    const newExtra=Number(salary.extra_paid||0)+extra;
    const newNote=(salary.extra_note||'')+(salary.extra_note?'; ':'')+new Date().toLocaleDateString('uz-UZ')+': '+extra.toLocaleString('uz-UZ')+(note?' ('+note+')':'');
    await getBrowserClient().from('salary_payments').update({extra_paid:newExtra,extra_note:newNote,updated_at:new Date().toISOString()}).eq('id',salary.id);
    await onPaid();
  }catch(err){alert(err.message)}finally{setBusy(false)}};
  return <Modal open onClose={close} title={(salary.profiles?.full_name||'Xodim')+" - qo'shimcha to'lov"}><form className="employee-form-grid" onSubmit={submit}><label className="wide"><span className="label">Summa (so'm)</span><input className="input" type="number" min="1" value={amount} onChange={e=>setAmount(e.target.value)} required autoFocus/></label><label className="wide"><span className="label">Sabab/izoh</span><input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Masalan: transport uchun"/></label>{salary.extra_note&&<div className="wide muted" style={{fontSize:'.8rem',whiteSpace:'pre-wrap'}}>Oldingi: {salary.extra_note}</div>}<button className="btn btn-primary wide" disabled={busy}>{busy?'Saqlanmoqda...':'Saqlash'}</button></form></Modal>;
}

function ExtraHistoryModal({salary,close,rate}){
  const entries=(salary.extra_note||'').split(';').map(s=>s.trim()).filter(Boolean);
  const name=salary.profiles?.full_name||(salary.employee_id?'Xodim':'');
  return <Modal open onClose={close} title={name+" - qo'shimcha to'lovlar"}><div className="product-detail-modal">
    <div style={{marginBottom:'1rem'}}><b>Jami qo'shimcha:</b> <DualPrice value={Number(salary.extra_paid||0)} rate={rate}/></div>
    {entries.length===0?<p className="muted">Hali qo'shimcha to'lov yo'q</p>:
    <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>Sana va summa</th></tr></thead><tbody>{entries.map((entry,i)=><tr key={i}><td>{i+1}</td><td>{entry}</td></tr>)}</tbody></table></div>}
  </div></Modal>;
}
