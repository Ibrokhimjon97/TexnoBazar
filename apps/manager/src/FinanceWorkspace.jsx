import React,{useEffect,useState}from'react';
import{AlertTriangle,CheckCircle2,Pencil,Plus,Trash2,Users,Wallet}from'lucide-react';
import{Empty,Modal,Status}from'@texnobazar/ui';
import{getBrowserClient,getManagerWorkspaceReferences,payExpense,paySalaryExtra}from'@texnobazar/data';

const categories={tax:'Soliq',rent:'Ijara',electricity:'Elektr energiya',water:'Suv',gas:'Gaz',llc:'MChJ',sole_trader:'YaTT',salary:'Maosh',transport:'Transport',other:'Boshqa'};
const currentMonth=()=>{const d=new Date();return d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0')};

export default function FinanceWorkspace({branchId,toast}){
  const[tab,setTab]=useState('expenses');
  if(!branchId)return <div className="ops-state ops-error"><AlertTriangle/><b>Filial tanlanmagan</b></div>;
  return <section className="ops-workspace"><div className="m-page-head between"><div><h2>Xarajatlar</h2><p>Oylik harajatlar va xodimlar maoshini boshqaring</p></div></div>
  <div className="ops-tabs finance-tabs"><button className={tab==='expenses'?'active':''} onClick={()=>setTab('expenses')}>Harajatlar</button><button className={tab==='salary'?'active':''} onClick={()=>setTab('salary')}>Maoshlar</button></div>
  {tab==='expenses'?<ExpensesPanel branchId={branchId} toast={toast}/>:<SalaryPanel branchId={branchId} toast={toast}/>}</section>;
}

function ExpensesPanel({branchId,toast}){
  const[rows,setRows]=useState([]),[loading,setLoading]=useState(true),[month,setMonth]=useState(currentMonth());
  const[open,setOpen]=useState(false),[editing,setEditing]=useState(null),[payModal,setPayModal]=useState(null);
  const[salaryRows,setSalaryRows]=useState([]);

  const load=async()=>{setLoading(true);try{const client=getBrowserClient();const[{data:exp},{data:sal}]=await Promise.all([client.from('expenses').select('*').eq('branch_id',branchId).eq('period_month',month).order('created_at',{ascending:false}),client.from('salary_payments').select('*').eq('branch_id',branchId).eq('period_month',month)]);setRows(exp||[]);setSalaryRows(sal||[])}catch(e){}finally{setLoading(false)}};
  useEffect(()=>{load()},[month,branchId]);

  const remove=async row=>{if(!confirm(row.title+" ni o'chirasizmi?"))return;try{await getBrowserClient().from('expenses').delete().eq('id',row.id);setRows(r=>r.filter(x=>x.id!==row.id));toast?.("Harajat o'chirildi")}catch(e){alert(e.message)}};

  const totalExpense=rows.reduce((s,r)=>s+Number(r.amount||0),0);
  const totalPaidExpense=rows.reduce((s,r)=>s+Number(r.paid_amount||0),0);
  const expenseDebt=totalExpense-totalPaidExpense;
  const totalSalaryBase=salaryRows.reduce((s,r)=>s+Number(r.base_salary||0)+Number(r.bonus||0),0);
  const totalSalaryPaid=salaryRows.reduce((s,r)=>s+Number(r.salary_paid||0)+Number(r.advance_paid||0),0);
  const salaryDebt=totalSalaryBase-totalSalaryPaid;

  return <><div className="finance-pl">
    <div><small>Umumiy harajat</small><b>{Number(totalExpense+totalSalaryBase).toLocaleString('uz-UZ')}</b></div>
    <div><small>To'langan</small><b>{Number(totalPaidExpense+totalSalaryPaid).toLocaleString('uz-UZ')}</b></div>
    <div><small>Umumiy qarz</small><b className={expenseDebt+salaryDebt>0?'negative':''}>{Number(expenseDebt+salaryDebt).toLocaleString('uz-UZ')}</b></div>
    <div><small>Maosh qarz</small><b className={salaryDebt>0?'negative':''}>{Number(salaryDebt).toLocaleString('uz-UZ')}</b></div>
  </div>

  <div className="finance-layout" style={{gridTemplateColumns:'1fr'}}>
    <div className="card" style={{padding:'14px'}}>
      <div className="between" style={{marginBottom:'12px'}}>
        <input type="month" className="input" value={month} onChange={e=>setMonth(e.target.value)} style={{maxWidth:180}}/>
        <button className="btn btn-primary" onClick={()=>{setEditing(null);setOpen(true)}}><Plus/>Harajat qo'shish</button>
      </div>
      {loading?<div className="ops-state">Yuklanmoqda…</div>:rows.length===0?<Empty title="Harajat topilmadi" text="Bu oyda hali harajat kiritilmagan."/>:
      <div className="table-wrap"><table className="table"><thead><tr><th>Kategoriya</th><th>Nomi</th><th>Summa</th><th>To'langan</th><th>Qoldiq</th><th>Sana</th><th>Amal</th></tr></thead><tbody>{rows.map(r=>{const debt=Number(r.amount)-Number(r.paid_amount||0);return <tr key={r.id}><td><Status type="blue">{categories[r.category]||r.category}</Status></td><td><b>{r.title}</b></td><td>{Number(r.amount).toLocaleString('uz-UZ')}</td><td>{Number(r.paid_amount||0).toLocaleString('uz-UZ')}</td><td style={{color:debt>0?'var(--primary)':'green'}}><b>{debt.toLocaleString('uz-UZ')}</b></td><td>{r.paid_at?new Date(r.paid_at).toLocaleDateString('uz-UZ'):'-'}</td><td><div style={{display:'flex',gap:'6px'}}><button className="btn btn-primary" style={{padding:'5px 10px',fontSize:'11px'}} onClick={()=>setPayModal(r)}>To'landi</button><button className="btn" style={{padding:'5px 8px'}} onClick={()=>{setEditing(r);setOpen(true)}}><Pencil size={13}/></button><button className="btn" style={{padding:'5px 8px'}} onClick={()=>remove(r)}><Trash2 size={13}/></button></div></td></tr>})}</tbody></table></div>}
    </div>
  </div>
  <ExpenseModal open={open} close={()=>{setOpen(false);setEditing(null)}} expense={editing} month={month} branchId={branchId} onSaved={async()=>{setOpen(false);setEditing(null);toast?.(editing?'Harajat yangilandi':'Harajat qo\'shildi');await load()}}/>
  {payModal&&<PayExpenseModal expense={payModal} close={()=>setPayModal(null)} onPaid={async()=>{setPayModal(null);toast?.("To'lov saqlandi");await load()}}/>}</>;
}

function PayExpenseModal({expense,close,onPaid}){
  const[mode,setMode]=useState('full'),[amount,setAmount]=useState(''),[busy,setBusy]=useState(false);
  const debt=Number(expense.amount)-Number(expense.paid_amount||0);
  const submit=async e=>{e.preventDefault();setBusy(true);try{const payAmount=mode==='full'?debt:Number(amount);if(payAmount<=0||payAmount>debt){alert("Noto'g'ri summa");return}await payExpense(expense.id,payAmount);await onPaid()}catch(err){alert(err.message)}finally{setBusy(false)}};
  return <Modal open onClose={close} title={expense.title+" - to'lov"}><form className="ops-form" onSubmit={submit}><div><p>Qoldiq: <b>{debt.toLocaleString('uz-UZ')} so'm</b></p></div><label><span>To'lov turi</span><select className="select" value={mode} onChange={e=>setMode(e.target.value)}><option value="full">To'liq to'landi ({debt.toLocaleString('uz-UZ')} so'm)</option><option value="partial">Qisman to'lov</option></select></label>{mode==='partial'&&<label><span>To'langan summa</span><input className="input" type="number" min="1" max={debt} value={amount} onChange={e=>setAmount(e.target.value)} required/></label>}<button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'Saqlash'}</button></form></Modal>;
}

function ExpenseModal({open,close,expense,month,branchId,onSaved}){
  const empty={category:'rent',title:'',amount:'',note:'',paid_at:''};
  const[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){setForm(expense?{category:expense.category,title:expense.title,amount:String(expense.amount),note:expense.note||'',paid_at:expense.paid_at?expense.paid_at.split('T')[0]:''}:{...empty});setError('')}},[open,expense]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const client=getBrowserClient();const payload={category:form.category,title:form.title.trim(),amount:Number(form.amount),period_month:month,branch_id:branchId,note:form.note.trim()||null,paid_at:form.paid_at||null};if(expense){await client.from('expenses').update({...payload,updated_at:new Date().toISOString()}).eq('id',expense.id)}else{const{data:{user}}=await client.auth.getUser();await client.from('expenses').insert({...payload,created_by:user.id})}await onSaved()}catch(err){setError(err.message)}finally{setBusy(false)}};
  return <Modal open={open} onClose={close} title={expense?'Harajatni tahrirlash':'Yangi harajat'}><form className="ops-form" onSubmit={submit}>{error&&<div className="ops-inline-error">{error}</div>}<label><span>Kategoriya</span><select className="select" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label><span>Nomi</span><input className="input" value={form.title} onChange={e=>setForm({...form,title:e.target.value})} required minLength={2}/></label><label><span>Summa (so'm)</span><input className="input" type="number" min="1" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} required/></label><label><span>Muddati</span><input className="input" type="date" value={form.paid_at} onChange={e=>setForm({...form,paid_at:e.target.value})}/></label><label><span>Izoh</span><input className="input" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label><button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'Saqlash'}</button></form></Modal>;
}

function SalaryPanel({branchId,toast}){
  const[rows,setRows]=useState([]),[employees,setEmployees]=useState([]),[loading,setLoading]=useState(true);
  const[month,setMonth]=useState(currentMonth()),[open,setOpen]=useState(false),[editing,setEditing]=useState(null),[extraModal,setExtraModal]=useState(null),[extraHistory,setExtraHistory]=useState(null);
  const load=async()=>{setLoading(true);try{const client=getBrowserClient();const{data:sal}=await client.from('salary_payments').select('*').eq('branch_id',branchId).eq('period_month',month).order('created_at',{ascending:false});const refs=await getManagerWorkspaceReferences(branchId).catch(()=>({employees:[]}));setRows(sal||[]);setEmployees((refs.employees||[]).map(e=>({employee_id:e.id,full_name:e.full_name,...e})))}catch(e){}finally{setLoading(false)}};
  useEffect(()=>{load()},[month,branchId]);
  const remove=async row=>{if(!confirm("Bu yozuvni o'chirasizmi?"))return;try{await getBrowserClient().from('salary_payments').delete().eq('id',row.id);setRows(r=>r.filter(x=>x.id!==row.id));toast?.("O'chirildi")}catch(e){alert(e.message)}};
  const totalPaid=rows.reduce((s,r)=>s+Number(r.salary_paid||0)+Number(r.advance_paid||0)+Number(r.extra_paid||0),0);
  const totalDue=rows.reduce((s,r)=>s+Number(r.base_salary||0)+Number(r.bonus||0)-Number(r.salary_paid||0)-Number(r.advance_paid||0)-Number(r.extra_paid||0),0);

  return <><div className="finance-layout" style={{gridTemplateColumns:'1fr'}}>
    <div className="card" style={{padding:'14px'}}>
      <div className="between" style={{marginBottom:'12px'}}>
        <input type="month" className="input" value={month} onChange={e=>setMonth(e.target.value)} style={{maxWidth:180}}/>
        <span style={{fontWeight:700,fontSize:'12px'}}>To'langan: {totalPaid.toLocaleString('uz-UZ')} | Qoldiq: {totalDue.toLocaleString('uz-UZ')}</span>
        <button className="btn btn-primary" onClick={()=>{setEditing(null);setOpen(true)}}><Plus/>Maosh kiritish</button>
      </div>
      {loading?<div className="ops-state">Yuklanmoqda…</div>:rows.length===0?<Empty title="Maosh yozuvi topilmadi" text="Bu oyda hali maosh kiritilmagan."/>:
      <div className="table-wrap"><table className="table"><thead><tr><th>Xodim</th><th>Oylik</th><th>Ustama</th><th>Avans</th><th>To'langan</th><th>Qo'shimcha</th><th>Qoldiq</th><th>Amal</th></tr></thead><tbody>{rows.map(r=>{const due=Number(r.base_salary)+Number(r.bonus)-Number(r.salary_paid)-Number(r.advance_paid)-Number(r.extra_paid||0);return <tr key={r.id}><td><b>{(employees.find(e=>e.employee_id===r.employee_id)?.full_name)||'Nomsiz'}</b></td><td>{Number(r.base_salary).toLocaleString('uz-UZ')}</td><td>{Number(r.bonus).toLocaleString('uz-UZ')}</td><td>{Number(r.advance_paid).toLocaleString('uz-UZ')}</td><td>{Number(r.salary_paid).toLocaleString('uz-UZ')}</td><td style={{cursor:'pointer',textDecoration:'underline'}} onClick={()=>setExtraHistory(r)}><b>{Number(r.extra_paid||0).toLocaleString('uz-UZ')}</b></td><td><b style={{color:due>0?'var(--primary)':'green'}}>{due.toLocaleString('uz-UZ')}</b></td><td><div style={{display:'flex',gap:'6px'}}><button className="btn" style={{padding:'5px 8px',fontSize:'10px'}} onClick={()=>setExtraModal(r)}>+Qo'shimcha</button><button className="btn" style={{padding:'5px 8px'}} onClick={()=>{setEditing(r);setOpen(true)}}><Pencil size={13}/></button><button className="btn" style={{padding:'5px 8px'}} onClick={()=>remove(r)}><Trash2 size={13}/></button></div></td></tr>})}</tbody></table></div>}
    </div>
  </div>
  <SalaryModal open={open} close={()=>{setOpen(false);setEditing(null)}} salary={editing} month={month} branchId={branchId} employees={employees} onSaved={async()=>{setOpen(false);setEditing(null);toast?.(editing?'Yangilandi':'Maosh kiritildi');await load()}}/>
  {extraHistory&&<ExtraHistoryModal salary={extraHistory} close={()=>setExtraHistory(null)}/>}
  {extraModal&&<ExtraPayModal salary={extraModal} close={()=>setExtraModal(null)} onPaid={async()=>{setExtraModal(null);toast?.("Qo'shimcha to'lov saqlandi");await load()}}/>}</>;
}

function SalaryModal({open,close,salary,month,branchId,employees,onSaved}){
  const empty={employee_id:'',base_salary:'',bonus:'0',advance_paid:'0',advance_paid_at:'',salary_paid:'0',salary_paid_at:'',note:''};
  const[form,setForm]=useState(empty),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){setForm(salary?{employee_id:salary.employee_id||'',base_salary:String(salary.base_salary||0),bonus:String(salary.bonus||0),advance_paid:String(salary.advance_paid||0),advance_paid_at:salary.advance_paid_at||'',salary_paid:String(salary.salary_paid||0),salary_paid_at:salary.salary_paid_at||'',note:salary.note||''}:{...empty,employee_id:employees[0]?.employee_id||''});setError('')}},[open,salary,employees]);
  const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{const client=getBrowserClient();const payload={employee_id:form.employee_id,period_month:month,branch_id:branchId,base_salary:Number(form.base_salary)||0,bonus:Number(form.bonus)||0,advance_paid:Number(form.advance_paid)||0,salary_paid:Number(form.salary_paid)||0,note:form.note.trim()||null,paid_at:form.salary_paid_at||form.advance_paid_at||null};if(form.advance_paid_at)payload.advance_paid_at=form.advance_paid_at;if(form.salary_paid_at)payload.salary_paid_at=form.salary_paid_at;if(salary){await client.from('salary_payments').update({...payload,updated_at:new Date().toISOString()}).eq('id',salary.id)}else{const{data:{user}}=await client.auth.getUser();const{error:insErr}=await client.from('salary_payments').insert({...payload,created_by:user.id});if(insErr)throw insErr}await onSaved()}catch(err){setError(err.message)}finally{setBusy(false)}};
  const due=Number(form.base_salary||0)+Number(form.bonus||0)-Number(form.salary_paid||0)-Number(form.advance_paid||0);
  return <Modal open={open} onClose={close} title={salary?'Maoshni tahrirlash':'Yangi maosh'}><form className="ops-form" onSubmit={submit}>{error&&<div className="ops-inline-error">{error}</div>}<label><span>Xodim</span><select className="select" value={form.employee_id} onChange={e=>setForm({...form,employee_id:e.target.value})} required disabled={!!salary}><option value="">Tanlang</option>{employees.map(emp=><option key={emp.employee_id} value={emp.employee_id}>{emp.full_name}</option>)}</select></label><label><span>Oylik maosh</span><input className="input" type="number" min="0" value={form.base_salary} onChange={e=>setForm({...form,base_salary:e.target.value})} required/></label><label><span>Ustama (bonus)</span><input className="input" type="number" min="0" value={form.bonus} onChange={e=>setForm({...form,bonus:e.target.value})}/></label><label><span>Avans to'langan</span><input className="input" type="number" min="0" value={form.advance_paid} onChange={e=>setForm({...form,advance_paid:e.target.value})}/></label><label><span>Avans sanasi</span><input className="input" type="date" value={form.advance_paid_at} onChange={e=>setForm({...form,advance_paid_at:e.target.value})}/></label><label><span>Maosh to'langan</span><input className="input" type="number" min="0" value={form.salary_paid} onChange={e=>setForm({...form,salary_paid:e.target.value})}/></label><label><span>Maosh sanasi</span><input className="input" type="date" value={form.salary_paid_at} onChange={e=>setForm({...form,salary_paid_at:e.target.value})}/></label><label><span>Izoh</span><input className="input" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label><div style={{padding:'8px 0',fontWeight:700,color:due>0?'var(--primary)':'green'}}>To'lanishi kerak: {due.toLocaleString('uz-UZ')} so'm</div><button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'Saqlash'}</button></form></Modal>;
}

function ExtraPayModal({salary,close,onPaid}){
  const[amount,setAmount]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  const submit=async e=>{e.preventDefault();setBusy(true);try{
    const extra=Number(amount);if(extra<=0){alert("Summa musbat bo'lishi kerak");return}
    await paySalaryExtra(salary.id,extra,note||null);
    await onPaid();
  }catch(err){alert(err.message)}finally{setBusy(false)}};
  return <Modal open onClose={close} title="Qo'shimcha to'lov"><form className="ops-form" onSubmit={submit}><label><span>Summa (so'm)</span><input className="input" type="number" min="1" value={amount} onChange={e=>setAmount(e.target.value)} required autoFocus/></label><label><span>Sabab/izoh</span><input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Masalan: transport uchun"/></label>{salary.extra_note&&<div style={{fontSize:'.75rem',color:'var(--muted)',whiteSpace:'pre-wrap'}}>Oldingi: {salary.extra_note}</div>}<button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'Saqlash'}</button></form></Modal>;
}

function ExtraHistoryModal({salary,close}){
  const entries=(salary.extra_note||'').split(';').map(s=>s.trim()).filter(Boolean);
  return <Modal open onClose={close} title="Qo'shimcha to'lovlar tarixi"><div className="ops-detail">
    <div style={{marginBottom:'12px'}}><b>Jami qo'shimcha:</b> {Number(salary.extra_paid||0).toLocaleString('uz-UZ')} so'm</div>
    {entries.length===0?<p style={{color:'var(--muted)'}}>Hali qo'shimcha to'lov yo'q</p>:
    <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>Sana va summa</th></tr></thead><tbody>{entries.map((entry,i)=><tr key={i}><td>{i+1}</td><td>{entry}</td></tr>)}</tbody></table></div>}
  </div></Modal>;
}
