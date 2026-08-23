import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,Boxes,CalendarDays,FileX2,Landmark,MapPin,QrCode,Search,Trash2,User,X}from'lucide-react';
import{DualPrice,Empty,QrScanButton,formatDualMoney,useExchangeRate}from'@texnobazar/ui';
import{WRITEOFF_EXPENSE_CATEGORY,WRITEOFF_REASONS,executeWriteoff,findWriteoffUnit,listWriteoffHistory,searchWriteoffUnits}from'@texnobazar/data';

const message=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const stamp=value=>value?new Date(value).toLocaleString('uz-UZ',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>`${today().slice(0,7)}-01`;
const reasonLabel=code=>WRITEOFF_REASONS.find(([key])=>key===code)?.[1]||code||'—';

export default function WriteoffWorkspace({branchId,toast}){
  const[tab,setTab]=useState('new');
  const[historyKey,setHistoryKey]=useState(0);
  if(!branchId)return <div className="wo-state wo-error"><AlertTriangle/><b>Filial tanlanmagan</b><p>Hisobdan chiqarish uchun filial tanlang.</p></div>;
  return <section className="wo-workspace">
    <div className="m-page-head">
      <h2>Hisobdan chiqarish</h2>
      <p>Buzuq, yaroqsiz yoki yo‘qolgan tovar birligini chiqarish. Tannarx avtomatik ravishda “{WRITEOFF_EXPENSE_CATEGORY}” xarajatiga yoziladi.</p>
    </div>
    <div className="wo-tabs">
      <button className={tab==='new'?'active':''} onClick={()=>setTab('new')}>Yangi chiqarish</button>
      <button className={tab==='history'?'active':''} onClick={()=>setTab('history')}>Tarix</button>
    </div>
    {tab==='new'
      ?<WriteoffForm branchId={branchId} toast={toast} done={()=>{setHistoryKey(x=>x+1);setTab('history');}}/>
      :<WriteoffHistory branchId={branchId} refreshKey={historyKey}/>}
  </section>;
}

function WriteoffForm({branchId,toast,done}){
  const rate=useExchangeRate();
  const[code,setCode]=useState('');
  const[query,setQuery]=useState('');
  const[results,setResults]=useState([]);
  const[searching,setSearching]=useState(false);
  const[units,setUnits]=useState([]);
  const[reasonCode,setReasonCode]=useState('damaged');
  const[note,setNote]=useState('');
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const[scanError,setScanError]=useState('');

  const total=useMemo(()=>units.reduce((sum,x)=>sum+Number(x.cost_price||0),0),[units]);
  const locationName=units[0]?.location_name||'';

  useEffect(()=>{
    if(!query.trim()){setResults([]);return;}
    let alive=true;
    setSearching(true);
    const timer=setTimeout(async()=>{
      try{
        const result=await searchWriteoffUnits({branchId,query:query.trim(),limit:25});
        if(alive)setResults(result?.items||[]);
      }catch(e){if(alive){setError(message(e));setResults([]);}}
      finally{if(alive)setSearching(false);}
    },300);
    return()=>{alive=false;clearTimeout(timer);};
  },[branchId,query]);

  const add=unit=>{
    setScanError('');setError('');
    if(units.some(x=>x.id===unit.id)){setScanError('Bu birlik allaqachon tanlangan.');return;}
    if(units.length&&units[0].location_id!==unit.location_id){
      setScanError('Barcha birliklar bitta joylashuvdan bo‘lishi kerak.');return;
    }
    setUnits(current=>[...current,unit]);
  };

  const scan=async e=>{
    e.preventDefault();
    const value=code.trim();
    if(!value)return;
    setScanError('');setBusy(true);
    try{
      const unit=await findWriteoffUnit(branchId,value);
      add(unit);
      setCode('');
    }catch(e){setScanError(message(e));}
    finally{setBusy(false);}
  };

  const submit=async e=>{
    e.preventDefault();
    setError('');
    if(!units.length){setError('Kamida bitta tovar birligini tanlang.');return;}
    if(note.trim().length<3){setError('Izoh kamida 3 belgidan iborat bo‘lishi kerak.');return;}
    if(!window.confirm(`${units.length} dona tovar hisobdan chiqariladi va ${formatDualMoney(total,rate)} do‘kon xarajatiga yoziladi. Davom etasizmi?`))return;
    setBusy(true);
    try{
      const result=await executeWriteoff({branchId,unitIds:units.map(x=>x.id),reasonCode,note:note.trim()});
      setUnits([]);setNote('');setCode('');setQuery('');setResults([]);
      toast?.(`${result?.writeoff_no||'Hujjat'} — ${units.length} dona hisobdan chiqarildi (${formatDualMoney(total,rate)})`);
      done?.();
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  };

  return <div className="wo-compose">
    <div className="wo-pick card">
      <h3>1. Tovar birligini tanlang</h3>
      <form className="wo-scan-row" onSubmit={scan}>
        <QrCode/>
        <input className="input" value={code} onChange={e=>setCode(e.target.value)} placeholder="QR yoki seriya raqamini skanerlang" autoFocus/>
        <QrScanButton onScan={v=>setCode(v)}/>
        <button className="btn btn-primary" disabled={busy||!code.trim()}>Qo‘shish</button>
      </form>
      {scanError&&<InlineError text={scanError}/>}
      <label className="wo-search">
        <Search/>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Yoki tovar nomi, SKU yoki QR bo‘yicha qidiring"/>
        {query&&<button type="button" className="wo-search-clear" onClick={()=>setQuery('')} aria-label="Qidiruvni tozalash"><X/></button>}
      </label>
      {query.trim()&&<div className="wo-results">
        {searching?<div className="wo-results-state">Qidirilmoqda…</div>
          :results.length===0?<div className="wo-results-state">Erkin birlik topilmadi.</div>
          :results.map(unit=>{
            const picked=units.some(x=>x.id===unit.id);
            return <button type="button" key={unit.id} className={picked?'picked':''} disabled={picked} onClick={()=>add(unit)}>
              {unit.image?<img src={unit.image} alt=""/>:<span className="wo-thumb"><Boxes/></span>}
              <span className="wo-result-info">
                <b>{unit.product_name}</b>
                <small>{unit.sku} · QR: {unit.qr_code}{unit.serial_number?` · S/N: ${unit.serial_number}`:''}</small>
                <small><MapPin/>{unit.location_name}</small>
              </span>
              <strong><DualPrice value={Number(unit.cost_price)} rate={rate}/></strong>
            </button>;
          })}
      </div>}
    </div>

    <form className="wo-confirm card" onSubmit={submit}>
      <h3>2. Sabab va izoh</h3>
      <label>
        <span>Sabab</span>
        <select className="select" value={reasonCode} onChange={e=>setReasonCode(e.target.value)} required>
          {WRITEOFF_REASONS.map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label>
        <span>Izoh (majburiy)</span>
        <textarea className="textarea" value={note} onChange={e=>setNote(e.target.value)} required minLength={3}
          placeholder="Masalan: ekran sinib, ta’mirlash iqtisodiy jihatdan foydasiz"/>
      </label>

      <div className="wo-selected">
        <div className="between">
          <b>Tanlangan birliklar ({units.length})</b>
          {locationName&&<small><MapPin/>{locationName}</small>}
        </div>
        {units.length===0
          ?<div className="wo-lines-empty"><Boxes/><span>Skanerlang yoki qidiruvdan tanlang</span></div>
          :<div className="wo-lines">{units.map(unit=><div className="wo-line" key={unit.id}>
            <span className="wo-line-icon"><Boxes/></span>
            <div className="wo-line-info">
              <b>{unit.product_name}</b>
              <small>{unit.sku} · QR: {unit.qr_code}</small>
            </div>
            <strong><DualPrice value={Number(unit.cost_price)} rate={rate}/></strong>
            <button type="button" className="wo-remove" onClick={()=>setUnits(units.filter(x=>x.id!==unit.id))} aria-label="Olib tashlash"><Trash2/></button>
          </div>)}</div>}
      </div>

      <div className="wo-total">
        <span>Hisobdan chiqadigan tannarx</span>
        <b><DualPrice value={total} rate={rate}/></b>
      </div>
      <div className="wo-form-hint">
        <Landmark/>
        <small><DualPrice value={total} rate={rate}/> “{WRITEOFF_EXPENSE_CATEGORY}” kategoriyasi bilan moliya chiqimiga yoziladi va oylik xarajatga qo‘shiladi.</small>
      </div>
      {error&&<InlineError text={error}/>}
      <button className="btn btn-primary btn-block" disabled={busy||!units.length||note.trim().length<3}>
        {busy?'Bajarilmoqda…':'Hisobdan chiqarish'}
      </button>
    </form>
  </div>;
}

function WriteoffHistory({branchId,refreshKey}){
  const rate=useExchangeRate();
  const[data,setData]=useState(null);
  const[filters,setFilters]=useState({from:monthStart(),to:today(),reasonCode:'',query:''});
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');

  const load=async()=>{
    setLoading(true);setError('');
    try{
      setData(await listWriteoffHistory({branchId,from:filters.from||null,to:filters.to||null,
        reasonCode:filters.reasonCode||null,query:filters.query||'',pageSize:200}));
    }catch(e){setError(message(e));}
    finally{setLoading(false);}
  };

  useEffect(()=>{
    const timer=setTimeout(load,filters.query?300:0);
    return()=>clearTimeout(timer);
  },[branchId,refreshKey,filters.from,filters.to,filters.reasonCode,filters.query]);

  const items=data?.items||[];
  const set=(key,value)=>setFilters(current=>({...current,[key]:value}));

  return <div className="wo-history">
    <div className="wo-stats">
      <div className="wo-stat"><span>Tanlangan davr</span><b><DualPrice value={Number(data?.total_cost)} rate={rate}/></b><small>{Number(data?.total||0)} dona · {Number(data?.document_count||0)} hujjat</small></div>
      <div className="wo-stat posted"><span>Joriy oy xarajati</span><b><DualPrice value={Number(data?.month_cost)} rate={rate}/></b><small>{Number(data?.month_units||0)} dona</small></div>
      <div className="wo-stat draft"><span>Xarajat kategoriyasi</span><b className="wo-stat-text">{WRITEOFF_EXPENSE_CATEGORY}</b><small>Moliya → Xarajatlar</small></div>
    </div>

    {(data?.by_reason||[]).length>0&&<div className="wo-reason-summary">
      {data.by_reason.map(row=><span key={row.reason_code||'none'}>
        <small>{row.label||reasonLabel(row.reason_code)}</small>
        <b><DualPrice value={Number(row.cost)} rate={rate}/></b>
        <em>{Number(row.units||0)} dona</em>
      </span>)}
    </div>}

    <div className="wo-filters">
      <label><span>Dan</span><input className="input" type="date" value={filters.from} onChange={e=>set('from',e.target.value)}/></label>
      <label><span>Gacha</span><input className="input" type="date" value={filters.to} onChange={e=>set('to',e.target.value)}/></label>
      <label><span>Sabab</span>
        <select className="select" value={filters.reasonCode} onChange={e=>set('reasonCode',e.target.value)}>
          <option value="">Barchasi</option>
          {WRITEOFF_REASONS.map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label className="wo-filter-search"><span>Qidiruv</span>
        <input className="input" value={filters.query} onChange={e=>set('query',e.target.value)} placeholder="Tovar, SKU, QR, hujjat yoki izoh"/>
      </label>
    </div>

    {loading?<div className="wo-state">Tarix yuklanmoqda…</div>
      :error?<div className="wo-state wo-error"><AlertTriangle/><b>Xatolik</b><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>
      :items.length===0?<Empty title="Yozuv topilmadi" text="Tanlangan davr yoki filtr bo‘yicha hisobdan chiqarilgan tovar yo‘q."/>
      :<>
        <div className="wo-table-wrap">
          <table className="table wo-table">
            <thead><tr>
              <th>Sana / vaqt</th><th>Tovar</th><th>QR / seriya</th><th>Sabab</th><th>Izoh</th><th>Hujjat</th><th className="right">Tannarx</th>
            </tr></thead>
            <tbody>
              {items.map(row=><tr key={row.line_id}>
                <td><b>{stamp(row.occurred_at)}</b><small>{row.location_name}</small></td>
                <td><b>{row.product_name}</b><small>{row.sku}</small></td>
                <td><code>{row.qr_code||'—'}</code>{row.serial_number&&<small>S/N: {row.serial_number}</small>}</td>
                <td><span className="wo-reason-chip">{row.reason_label||reasonLabel(row.reason_code)}</span></td>
                <td><span className="wo-note-cell">{row.note||'—'}</span></td>
                <td><small>{row.writeoff_no}</small>{row.actor_name&&<small><User/>{row.actor_name}</small>}</td>
                <td className="right"><strong><DualPrice value={Number(row.line_cost)} rate={rate}/></strong></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="wo-cards">
          {items.map(row=><article className="card wo-history-card" key={row.line_id}>
            <div className="wo-card-icon"><FileX2/></div>
            <div className="wo-card-main">
              <div className="between"><b>{row.product_name}</b><strong><DualPrice value={Number(row.line_cost)} rate={rate}/></strong></div>
              <small>{row.sku} · QR: {row.qr_code||'—'}</small>
              <div className="wo-card-meta">
                <span><CalendarDays/>{stamp(row.occurred_at)}</span>
                <span className="wo-reason-chip">{row.reason_label||reasonLabel(row.reason_code)}</span>
              </div>
              <p className="wo-card-reason">{row.note||'—'}</p>
              <small>{row.writeoff_no} · {row.location_name}</small>
            </div>
          </article>)}
        </div>
      </>}
  </div>;
}

function InlineError({text}){
  return <div className="wo-inline-error"><AlertTriangle/><span>{text}</span></div>;
}
