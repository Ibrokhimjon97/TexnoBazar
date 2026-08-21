import React,{useEffect,useState}from'react';
import{Camera,Check,ChevronLeft,ChevronRight,DollarSign,Pencil,Save,User,Wallet}from'lucide-react';
import{formatMoney,useAuth}from'@texnobazar/ui';
import{getBrowserClient}from'@texnobazar/data';

const msg=e=>String(e?.message||'Xatolik yuz berdi');
const money=v=>formatMoney(Number(v||0));

export default function ProfileWorkspace({toast}){
  const{profile,refresh}=useAuth();
  const[tab,setTab]=useState('info');
  return <section className="profile-workspace">
    <div className="profile-tabs">
      <button className={tab==='info'?'active':''} onClick={()=>setTab('info')}><User size={16}/>Ma'lumotlarim</button>
      <button className={tab==='salary'?'active':''} onClick={()=>setTab('salary')}><Wallet size={16}/>Maoshlarim</button>
    </div>
    {tab==='info'?<ProfileInfo profile={profile} refresh={refresh} toast={toast}/>:<SalaryHistory profile={profile}/>}
  </section>;
}

function ProfileInfo({profile,refresh,toast}){
  const[editing,setEditing]=useState(false);
  const[form,setForm]=useState({full_name:'',phone:''});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[uploading,setUploading]=useState(false);

  useEffect(()=>{if(profile)setForm({full_name:profile.full_name||'',phone:profile.phone||''})},[profile?.id]);

  const save=async()=>{
    if(!form.full_name.trim()){setError('Ism talab qilinadi');return}
    setBusy(true);setError('');
    try{
      const{error:e}=await getBrowserClient().from('profiles').update({full_name:form.full_name.trim(),phone:form.phone.trim()||null}).eq('id',profile.id);
      if(e)throw e;
      setEditing(false);refresh?.();toast?.('Ma\'lumotlar saqlandi');
    }catch(e){setError(msg(e))}finally{setBusy(false)}
  };

  const uploadAvatar=async(e)=>{
    const file=e.target.files?.[0];
    if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)){setError('Faqat JPG, PNG yoki WebP rasm');return}
    if(file.size>5*1024*1024){setError('Rasm 5MB dan kichik bo\'lishi kerak');return}
    setUploading(true);setError('');
    try{
      const client=getBrowserClient();
      const ext=file.name.split('.').pop()||'jpg';
      const path=`avatars/${profile.id}/${Date.now()}.${ext}`;
      const{error:upErr}=await client.storage.from('avatars').upload(path,file,{upsert:true,contentType:file.type});
      if(upErr)throw upErr;
      const{data:{publicUrl}}=client.storage.from('avatars').getPublicUrl(path);
      const{error:updErr}=await client.from('profiles').update({avatar_url:publicUrl}).eq('id',profile.id);
      if(updErr)throw updErr;
      refresh?.();toast?.('Rasm yangilandi');
    }catch(e){setError(msg(e))}finally{setUploading(false)}
  };

  const initials=(profile?.full_name||profile?.email||'U').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();

  return <div className="profile-info">
    <div className="profile-avatar-section">
      <div className="profile-avatar">
        {profile?.avatar_url?<img src={profile.avatar_url} alt="Avatar"/>:<span>{initials}</span>}
        <label className="profile-avatar-upload">
          <Camera size={16}/>{uploading?'...':''}
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={uploadAvatar} disabled={uploading}/>
        </label>
      </div>
      <div className="profile-avatar-name">
        <b>{profile?.full_name||'Noma\'lum'}</b>
        <small>{profile?.email}</small>
      </div>
    </div>

    {error&&<div className="profile-error">{error}</div>}

    {editing?<div className="profile-form">
      <label><span>To'liq ism</span><input className="input" value={form.full_name} onChange={e=>setForm({...form,full_name:e.target.value})} placeholder="Ism Familiya"/></label>
      <label><span>Telefon</span><input className="input" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} placeholder="+998 90 123 45 67"/></label>
      <div className="profile-form-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy}><Save size={15}/>{busy?'Saqlanmoqda...':'Saqlash'}</button>
        <button className="btn" onClick={()=>setEditing(false)}>Bekor</button>
      </div>
    </div>:<div className="profile-details">
      <div className="profile-row"><span>Ism</span><b>{profile?.full_name||'—'}</b></div>
      <div className="profile-row"><span>Telefon</span><b>{profile?.phone||'—'}</b></div>
      <div className="profile-row"><span>Email</span><b>{profile?.email||'—'}</b></div>
      <div className="profile-row"><span>Ro'yxatdan o'tgan</span><b>{profile?.created_at?new Date(profile.created_at).toLocaleDateString('uz-UZ'):'—'}</b></div>
      <button className="btn btn-outline" onClick={()=>setEditing(true)}><Pencil size={14}/>Tahrirlash</button>
    </div>}
  </div>;
}

function SalaryHistory({profile}){
  const now=new Date();
  const[month,setMonth]=useState(()=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`);
  const[data,setData]=useState(null);
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState('');

  const load=async()=>{
    setLoading(true);setError('');
    try{
      const client=getBrowserClient();
      // Try RPC first, fallback to direct query
      let result=null;
      try{
        const{data,error:e}=await client.rpc('get_my_salary_history',{p_month:month+'-01'});
        if(!e)result=data;
      }catch(e){}
      if(!result){
        // Fallback: direct query from salary_payments using RLS
        const{data:rows,error:e2}=await client.from('salary_payments').select('*').eq('period_month',month).eq('employee_id',profile.id).order('created_at',{ascending:false});
        if(e2)throw e2;
        const items=(rows||[]).map(sp=>({...sp,remaining:Number(sp.base_salary||0)+Number(sp.bonus||0)-Number(sp.salary_paid||0)-Number(sp.advance_paid||0)-Number(sp.extra_paid||0)}));
        const totals={gross:items.reduce((s,r)=>s+Number(r.base_salary||0),0),bonus:items.reduce((s,r)=>s+Number(r.bonus||0),0),advance:items.reduce((s,r)=>s+Number(r.advance_paid||0),0),salary_paid:items.reduce((s,r)=>s+Number(r.salary_paid||0),0),extra:items.reduce((s,r)=>s+Number(r.extra_paid||0),0),net:items.reduce((s,r)=>s+Number(r.salary_paid||0)+Number(r.advance_paid||0)+Number(r.extra_paid||0),0),remaining:items.reduce((s,r)=>s+r.remaining,0)};
        result={items,totals};
      }
      setData(result);
    }catch(e){setError(msg(e))}finally{setLoading(false)}
  };
  useEffect(()=>{if(profile?.id)load()},[month,profile?.id]);

  const prevMonth=()=>{const d=new Date(month+'-01');d.setMonth(d.getMonth()-1);setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)};
  const nextMonth=()=>{const d=new Date(month+'-01');d.setMonth(d.getMonth()+1);if(d<=now)setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)};
  const monthLabel=new Date(month+'-01').toLocaleDateString('uz-UZ',{year:'numeric',month:'long'});

  const items=data?.items||[];
  const totals=data?.totals||{gross:0,bonus:0,advance:0,salary_paid:0,extra:0,net:0,remaining:0};

  return <div className="salary-history">
    <div className="salary-month-picker">
      <button onClick={prevMonth}><ChevronLeft size={18}/></button>
      <b>{monthLabel}</b>
      <button onClick={nextMonth} disabled={new Date(month+'-01')>=new Date(now.getFullYear(),now.getMonth(),1)}><ChevronRight size={18}/></button>
    </div>

    {loading?<p className="salary-loading">Yuklanmoqda...</p>:error?<div className="profile-error">{error}</div>:<>
      <div className="salary-summary">
        <div className="salary-card"><small>Oylik maosh</small><b>{money(totals.gross)}</b></div>
        {Number(totals.bonus)>0&&<div className="salary-card"><small>Ustama</small><b>{money(totals.bonus)}</b></div>}
        {Number(totals.advance)>0&&<div className="salary-card"><small>Avans</small><b>{money(totals.advance)}</b></div>}
        <div className="salary-card"><small>To'langan</small><b>{money(totals.salary_paid)}</b></div>
        {Number(totals.extra)>0&&<div className="salary-card"><small>Qo'shimcha</small><b>{money(totals.extra)}</b></div>}
        <div className="salary-card highlight"><small>Jami olgan</small><b>{money(totals.net)}</b></div>
        {Number(totals.remaining)>0&&<div className="salary-card"><small>Qoldiq</small><b style={{color:'#b91c1c'}}>{money(totals.remaining)}</b></div>}
      </div>

      {items.length>0?<div className="salary-items">
        <h4>Tafsilotlar</h4>
        {items.map((item,i)=><div className="salary-item" key={i}>
          <div className="salary-item-header">
            <span>{item.period_month}</span>
            {Number(item.remaining)<=0?<span className="salary-status salary-status-paid">To'liq to'langan</span>:<span className="salary-status salary-status-draft">Qoldiq bor</span>}
          </div>
          <div className="salary-item-grid">
            <span>Oylik: <b>{money(item.base_salary)}</b></span>
            <span>Ustama: <b>{money(item.bonus)}</b></span>
            <span>Avans: <b>{money(item.advance_paid)}</b></span>
            <span>To'langan: <b>{money(item.salary_paid)}</b></span>
            {Number(item.extra_paid)>0&&<span>Qo'shimcha: <b>{money(item.extra_paid)}</b></span>}
            <span>Qoldiq: <b style={{color:Number(item.remaining)>0?'#b91c1c':'green'}}>{money(item.remaining)}</b></span>
          </div>
          {item.salary_paid_at&&<small className="salary-paid-date">Maosh sanasi: {new Date(item.salary_paid_at).toLocaleDateString('uz-UZ')}</small>}
          {item.advance_paid_at&&<small className="salary-paid-date">Avans sanasi: {new Date(item.advance_paid_at).toLocaleDateString('uz-UZ')}</small>}
          {item.note&&<small className="salary-paid-date">Izoh: {item.note}</small>}
        </div>)}
      </div>:<p className="salary-empty">Bu oyda maosh ma'lumoti yo'q</p>}
    </>}
  </div>;
}
