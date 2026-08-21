import React,{useEffect,useState}from'react';
import{AlertTriangle,DollarSign,Trash2}from'lucide-react';
import{getBrowserClient}from'@texnobazar/data';
import{formatMoney}from'@texnobazar/ui';

const currentMonth=()=>{const d=new Date();return d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0')};
const monthStart=m=>m+'-01';
const monthEnd=m=>{const[y,mo]=m.split('-').map(Number);const last=new Date(y,mo,0).getDate();return `${y}-${String(mo).padStart(2,'0')}-${String(last).padStart(2,'0')}`};

export default function ExchangeRateWorkspace({toast}){
  const[rates,setRates]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[month,setMonth]=useState(currentMonth());
  const[form,setForm]=useState({rate_date:new Date().toISOString().slice(0,10),rate:''});
  const[saving,setSaving]=useState(false);

  const load=async()=>{
    setLoading(true);setError('');
    try{
      const{data,error:err}=await getBrowserClient().from('exchange_rates')
        .select('*').eq('currency_from','USD').eq('currency_to','UZS')
        .gte('rate_date',monthStart(month))
        .lte('rate_date',monthEnd(month))
        .order('rate_date',{ascending:false});
      if(err)throw err;
      setRates(data||[]);
    }catch(e){setError(e.message||'Kurslar yuklanmadi')}
    finally{setLoading(false)}
  };

  useEffect(()=>{load()},[month]);

  const save=async e=>{
    e.preventDefault();
    if(!form.rate||Number(form.rate)<=0){setError('Kurs musbat son bo\'lishi kerak');return}
    setSaving(true);setError('');
    try{
      const{error:err}=await getBrowserClient().from('exchange_rates')
        .upsert({
          rate_date:form.rate_date,
          currency_from:'USD',
          currency_to:'UZS',
          rate:Number(form.rate)
        },{onConflict:'rate_date,currency_from,currency_to'});
      if(err)throw err;
      toast?.('Valyuta kursi saqlandi');
      setForm(f=>({...f,rate:''}));
      await load();
    }catch(e){setError(e.message||'Kurs saqlanmadi')}
    finally{setSaving(false)}
  };

  const remove=async(id)=>{
    if(!confirm('Bu kursni o\'chirasizmi?'))return;
    try{
      const{error:err}=await getBrowserClient().from('exchange_rates').delete().eq('id',id);
      if(err)throw err;
      toast?.('Kurs o\'chirildi');
      await load();
    }catch(e){setError(e.message)}
  };

  const latest=rates[0];

  return <div className="workspace-section">
    <div className="workspace-head">
      <div><h2>Valyuta kurslari</h2><p>Kunlik USD/UZS kursini kiriting. Tovar pasportida va narx konversiyasida ishlatiladi.</p></div>
    </div>

    {latest&&<div className="exchange-current card">
      <DollarSign size={28}/>
      <div>
        <small>Joriy kurs ({latest.rate_date})</small>
        <b>1 USD = {formatMoney(Number(latest.rate))} so'm</b>
      </div>
    </div>}

    <form className="exchange-form card" onSubmit={save}>
      <label><span>Sana</span><input type="date" className="input" value={form.rate_date} onChange={e=>setForm({...form,rate_date:e.target.value})} required/></label>
      <label><span>1 USD = (so'm)</span><input type="number" className="input" min="1" step="0.01" value={form.rate} onChange={e=>setForm({...form,rate:e.target.value})} placeholder="Masalan: 12750" required/></label>
      <button className="btn btn-primary" disabled={saving}>{saving?'Saqlanmoqda...':'Kursni saqlash'}</button>
    </form>

    {error&&<div className="workspace-error"><AlertTriangle size={16}/>{error}</div>}

    <div className="card" style={{padding:'14px'}}>
      <div className="between" style={{marginBottom:'12px'}}>
        <input type="month" className="input" value={month} onChange={e=>setMonth(e.target.value)} style={{maxWidth:180}}/>
        <small style={{color:'var(--muted)'}}>{rates.length} kun kiritilgan</small>
      </div>

      {loading?<p style={{textAlign:'center',padding:'24px',color:'#888'}}>Yuklanmoqda...</p>:
      <table className="table">
        <thead><tr><th>Sana</th><th>Kurs (UZS)</th><th>Amal</th></tr></thead>
        <tbody>
          {rates.map(r=><tr key={r.id}>
            <td>{r.rate_date}</td>
            <td><b>{formatMoney(Number(r.rate))}</b></td>
            <td><button className="icon-btn danger-icon" onClick={()=>remove(r.id)} title="O'chirish"><Trash2 size={14}/></button></td>
          </tr>)}
          {rates.length===0&&<tr><td colSpan="3" style={{textAlign:'center',padding:'24px',color:'#888'}}>Bu oyda kurs kiritilmagan</td></tr>}
        </tbody>
      </table>}
    </div>
  </div>;
}
