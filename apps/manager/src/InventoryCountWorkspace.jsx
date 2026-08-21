import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,Boxes,ClipboardCheck,Plus,QrCode,Trash2}from'lucide-react';
import{Empty,Modal,Status}from'@texnobazar/ui';
import{cancelInventoryCount,createInventoryCount,getBrowserClient,getInventoryReferences,listInventoryCounts,postInventoryCount,reviewInventoryCount,scanInventoryCountUnit,startInventoryCount}from'@texnobazar/data';

const message=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const labels={draft:'Qoralama',counting:'Sanalyapti',review:'Tekshiruvda',posted:'Post qilindi',cancelled:'Bekor qilindi'};
const colors={draft:'gray',counting:'blue',review:'orange',posted:'green',cancelled:'red'};
const metrics=count=>{const lines=count?.inventory_count_lines||[];return{expected:lines.reduce((s,x)=>s+Number(x.expected_quantity||0),0),counted:lines.reduce((s,x)=>s+Number(x.counted_quantity||0),0),variance:lines.filter(x=>Number(x.variance)!==0).length};};

export default function InventoryCountWorkspace({branchId,toast,onRegister}){
  const[refs,setRefs]=useState({locations:[],products:[]});
  const[rows,setRows]=useState([]);
  const[detail,setDetail]=useState(null);
  const[createOpen,setCreateOpen]=useState(false);
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const load=async focusId=>{
    if(!branchId){setLoading(false);return;}
    setLoading(true);setError('');
    try{
      const reference=await getInventoryReferences(branchId);
      const all=await listInventoryCounts();
      const locationIds=new Set((reference.locations||[]).map(x=>x.id));
      const filtered=(all||[]).filter(x=>locationIds.has(x.location_id));
      setRefs(reference||{locations:[],products:[]});setRows(filtered);
      if(focusId)setDetail(filtered.find(x=>x.id===focusId)||null);
    }catch(e){setError(message(e));}finally{setLoading(false);}
  };
  useEffect(()=>{load();},[branchId]);
  const lifecycle=async type=>{
    if(!detail)return;
    const warning={start:'Hisob boshlanganda joriy qoldiq snapshot qilinadi. Davom etasizmi?',review:'Sanashni tekshiruvga yuborasizmi?',post:'Farqlar qoldiqqa qo‘llanadi. Post qilasizmi?',cancel:'Hisobni bekor qilasizmi?'}[type];
    if(!window.confirm(warning))return;
    let reason='';if(type==='cancel'){reason=window.prompt('Bekor qilish sababi:','')||'';if(!reason.trim())return;}
    setBusy(true);setError('');
    try{
      const fn=type==='start'?()=>startInventoryCount(detail.id):type==='review'?()=>reviewInventoryCount(detail.id):type==='post'?()=>postInventoryCount(detail.id):()=>cancelInventoryCount(detail.id,reason);
      await fn();await load(detail.id);toast?.({start:'Inventarizatsiya boshlandi',review:'Tekshiruvga yuborildi',post:'Inventarizatsiya post qilindi',cancel:'Inventarizatsiya bekor qilindi'}[type]);
    }catch(e){setError(message(e));}finally{setBusy(false);}
  };
  const deleteCount=async(row)=>{if(!confirm(`"${row.count_no}" inventarizatsiyani o'chirasizmi?`))return;try{const{error:delErr}=await getBrowserClient().from('inventory_counts').delete().eq('id',row.id);if(delErr)throw delErr;toast('Inventarizatsiya o\'chirildi');await load();}catch(e){setError(message(e));}};
  if(!branchId)return <Guard/>;
  return <section className="ops-workspace"><div className="m-page-head between"><div><h2>Inventarizatsiya</h2><p>Filial joylaridagi real birliklarni to‘liq yoki tanlangan mahsulotlar bo‘yicha sanash</p></div><div className="row">{onRegister&&<button className="btn btn-outline" onClick={onRegister}><Boxes/>Tovar ro'yxatga olish</button>}</div></div><WorkspaceState loading={loading} error={error} retry={()=>load()}>{rows.length===0?<Empty title="Inventarizatsiyalar yo‘q" text="Birinchi real sanashni yarating."/>:<div className="ops-grid">{rows.map(row=><CountCard key={row.id} row={row} refs={refs} open={()=>setDetail(row)} onDelete={deleteCount}/>)}</div>}</WorkspaceState><CountCreate open={createOpen} close={()=>setCreateOpen(false)} refs={refs} busy={busy} setBusy={setBusy} setError={setError} completed={async row=>{setCreateOpen(false);toast?.('Inventarizatsiya yaratildi');await load(row.id);}}/><CountDetail count={detail} refs={refs} close={()=>setDetail(null)} busy={busy} error={error} action={lifecycle} reload={()=>load(detail?.id)}/></section>;
}

function CountCard({row,refs,open,onDelete}){const m=metrics(row),location=refs.locations?.find(x=>x.id===row.location_id);return <div className="card ops-card" onClick={open} role="button" tabIndex={0}><span className="ops-icon"><ClipboardCheck/></span><div><div className="between"><b>{row.count_no}</b><Status type={colors[row.status]}>{labels[row.status]||row.status}</Status><button className="ops-delete" onClick={e=>{e.stopPropagation();onDelete(row)}} title="O'chirish"><Trash2 size={14}/></button></div><strong>{location?.name||'Joylashuv'}</strong><small>{row.scope?.mode==='scoped'?'Tanlangan mahsulotlar':'To‘liq hisob'} · {new Date(row.created_at).toLocaleString('uz-UZ')}</small><div className="ops-progress"><i style={{width:`${m.expected?Math.min(100,m.counted/m.expected*100):0}%`}}/></div><small>{m.counted} / {m.expected} sanaldi · {m.variance} farq</small></div></div>;}

function CountCreate({open,close,refs,busy,setBusy,setError,completed}){const[locationId,setLocationId]=useState(''),[mode,setMode]=useState('full'),[productIds,setProductIds]=useState([]),[notes,setNotes]=useState(''),[localError,setLocalError]=useState('');useEffect(()=>{if(open)setLocationId(x=>x||refs.locations?.[0]?.id||'');},[open,refs]);const submit=async e=>{e.preventDefault();if(mode==='scoped'&&!productIds.length)return setLocalError('Kamida bitta mahsulot tanlang.');setBusy(true);setLocalError('');setError('');try{const row=await createInventoryCount({locationId,scope:mode==='full'?{mode:'full'}:{mode:'scoped',product_ids:productIds},notes:notes||null});setNotes('');setProductIds([]);setMode('full');await completed(row);}catch(e){setLocalError(message(e));}finally{setBusy(false);}};return <Modal open={open} onClose={close} title="Yangi inventarizatsiya"><form className="ops-form" onSubmit={submit}>{localError&&<InlineError text={localError}/>}<label><span>Hisob joyi</span><select className="select" value={locationId} onChange={e=>setLocationId(e.target.value)} required>{refs.locations?.map(x=><option value={x.id} key={x.id}>{x.name} · {x.type}</option>)}</select></label><label><span>Qamrov</span><select className="select" value={mode} onChange={e=>setMode(e.target.value)}><option value="full">To‘liq joylashuv</option><option value="scoped">Tanlangan mahsulotlar</option></select></label>{mode==='scoped'&&<label><span>Mahsulotlar (Ctrl/Cmd bilan bir nechta)</span><select className="select ops-multi" multiple value={productIds} onChange={e=>setProductIds([...e.target.selectedOptions].map(x=>x.value))}>{refs.products?.map(x=><option value={x.id} key={x.id}>{x.name} ({x.sku})</option>)}</select></label>}<label><span>Izoh</span><textarea className="textarea" value={notes} onChange={e=>setNotes(e.target.value)}/></label><button className="btn btn-primary btn-block" disabled={busy}>{busy?'Yaratilmoqda…':'Hisob yaratish'}</button></form></Modal>;}

function CountDetail({count,refs,close,busy,error,action,reload}){const[code,setCode]=useState(''),[scanError,setScanError]=useState('');const m=useMemo(()=>metrics(count),[count]);const scan=async e=>{e.preventDefault();if(!code.trim())return;setScanError('');try{await scanInventoryCountUnit(count.id,code.trim());setCode('');await reload();}catch(e){setScanError(message(e));}};return <Modal open={Boolean(count)} onClose={close} title={count?.count_no||'Inventarizatsiya'}>{count&&<div className="ops-detail"><div className="between"><Status type={colors[count.status]}>{labels[count.status]}</Status><b>{refs.locations?.find(x=>x.id===count.location_id)?.name||'Joylashuv'}</b></div>{error&&<InlineError text={error}/>}<div className="ops-metrics"><span><small>Kutilgan</small><b>{m.expected}</b></span><span><small>Sanalgan</small><b>{m.counted}</b></span><span><small>Farq</small><b>{m.variance}</b></span></div><div className="ops-progress"><i style={{width:`${m.expected?Math.min(100,m.counted/m.expected*100):0}%`}}/></div>{count.status==='counting'&&<form className="ops-scan" onSubmit={scan}><QrCode/><input className="input" autoFocus value={code} onChange={e=>setCode(e.target.value)} placeholder="QR yoki seriyani ketma-ket skanerlang"/><button className="btn btn-primary">Sanash</button></form>}{scanError&&<InlineError text={scanError}/>}<h3>Hisob qatorlari ({count.inventory_count_lines?.length||0})</h3><div className="ops-lines">{count.inventory_count_lines?.map(line=><div key={line.id}><Boxes/><span><b>{refs.products?.find(x=>x.id===line.product_id)?.name||line.product_id}</b><small>{line.unit_id}</small></span><strong className={Number(line.variance)!==0?'negative':''}>{Number(line.counted_quantity)} / {Number(line.expected_quantity)} ({Number(line.variance)>0?'+':''}{Number(line.variance)})</strong></div>)}</div><div className="ops-actions">{count.status==='draft'&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('start')}>Boshlash</button>}{count.status==='counting'&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('review')}>Tekshiruvga yuborish</button>}{count.status==='review'&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('post')}>Post qilish</button>}{!['posted','cancelled'].includes(count.status)&&<button className="btn ops-danger" disabled={busy} onClick={()=>action('cancel')}>Bekor qilish</button>}</div></div>}</Modal>;}

function WorkspaceState({loading,error,retry,children}){if(loading)return <div className="ops-state">Yuklanmoqda…</div>;if(error)return <div className="ops-state ops-error"><AlertTriangle/><b>Xatolik</b><p>{error}</p><button className="btn" onClick={retry}>Qayta urinish</button></div>;return children;}
function InlineError({text}){return <div className="ops-inline-error">{text}</div>;}
function Guard(){return <div className="ops-state ops-error"><AlertTriangle/><b>Filial tanlanmagan</b><p>Workspace uchun filial konteksti talab qilinadi.</p></div>;}
