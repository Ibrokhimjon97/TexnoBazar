import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,ArrowDownLeft,ArrowUpRight,Boxes,CalendarDays,ChevronRight,MapPin,Plus,QrCode,Search,Trash2,WalletCards}from'lucide-react';
import{Empty,Modal,QrScanButton,Status,formatMoney}from'@texnobazar/ui';
import{
  approveBranchTransfer,createBranchTransfer,findTransferUnit,getBranchTransfer,getTransferReferences,
  listBranchTransfers,receiveBranchTransfer,recordBranchTransferPayment,editBranchTransfer,searchTransferUnits,shipBranchTransfer,
}from'@texnobazar/data';

const message=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const labels={draft:'Qoralama',requested:'So‘ralgan',approved:'Tasdiqlangan',in_transit:'Yo‘lda',received:'Qabul qilingan',cancelled:'Bekor qilingan'};
const badge={requested:'orange',approved:'blue',in_transit:'blue',received:'green',cancelled:'red',draft:'gray'};
const date=value=>value?new Date(value).toLocaleString('uz-UZ'):'—';
const amount=(value,currency)=>currency==='UZS'?formatMoney(Number(value||0)):`${new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:2}).format(Number(value||0))} ${currency}`;
const localNow=()=>{const now=new Date(Date.now()-new Date().getTimezoneOffset()*60000);return now.toISOString().slice(0,16)};
const paymentEmpty=()=>({amount:'',method:'Naqd',paidAt:localNow(),reference:'',notes:''});
const paymentMethods=['Naqd','Bank o‘tkazmasi','Terminal','Boshqa'];

function State({loading,error,retry,children}){
  if(loading)return <div className="tw-state">Transferlar yuklanmoqda…</div>;
  if(error)return <div className="tw-state tw-error"><AlertTriangle/><b>Xatolik yuz berdi</b><p>{error}</p><button className="btn" onClick={retry}>Qayta urinish</button></div>;
  return children;
}

export default function TransferWorkspace({branchId,toast}){
  const[refs,setRefs]=useState({source_locations:[],destination_branches:[]});
  const[rows,setRows]=useState([]);
  const[direction,setDirection]=useState('all');
  const[query,setQuery]=useState('');
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[createOpen,setCreateOpen]=useState(false);
  const[detail,setDetail]=useState(null);
  const[detailBusy,setDetailBusy]=useState(false);

  const load=async()=>{
    if(!branchId){setLoading(false);return}
    setLoading(true);setError('');
    try{
      const list=await listBranchTransfers({branchId,direction,query,pageSize:30});
      setRows(list.items||[]);
    }catch(e){setError(message(e))}finally{setLoading(false)}
  };
  const loadRefs=async()=>{
    if(!branchId)return;
    try{setRefs(await getTransferReferences(branchId)||{source_locations:[],destination_branches:[]})}
    catch(e){setError(message(e))}
  };
  useEffect(()=>{loadRefs()},[branchId]);
  useEffect(()=>{const timer=setTimeout(load,query?300:0);return()=>clearTimeout(timer)},[branchId,direction,query]);

  const openDetail=async id=>{
    setDetailBusy(true);setError('');
    try{setDetail(await getBranchTransfer(id))}catch(e){setError(message(e))}finally{setDetailBusy(false)}
  };
  const editTransfer=async(transferId,lines)=>{
    setDetailBusy(true);setError('');
    try{const updated=await editBranchTransfer(transferId,lines);setDetail(updated);await load();toast?.('Transfer tahrirlandi');return true}
    catch(e){setError(message(e));return false}finally{setDetailBusy(false)}
  };
  const lifecycle=async action=>{
    if(!detail)return;
    const warning=action==='receive'
      ?'Qabul tasdiqlangach mahsulotlar jo‘natuvchi balansidan chiqib, qabul qiluvchi balansiga o‘tadi va ulgurji qarz yakunlanadi. Davom etasizmi?'
      :action==='ship'?'Transfer yo‘lga chiqarilgan deb belgilanadi. Mahsulotlar qabul tasdig‘igacha jo‘natuvchi balansida qoladi. Davom etasizmi?'
      :'Transfer so‘rovini tasdiqlaysizmi?';
    if(!window.confirm(warning))return;
    setDetailBusy(true);setError('');
    try{
      const fn=action==='approve'?approveBranchTransfer:action==='ship'?shipBranchTransfer:receiveBranchTransfer;
      const updated=await fn(detail.id);
      setDetail(updated);await load();
      toast?.(action==='approve'?'Transfer tasdiqlandi':action==='ship'?'Transfer yo‘lga chiqarildi':'Transfer qabul qilindi, balans va qarz yangilandi');
    }catch(e){setError(message(e))}finally{setDetailBusy(false)}
  };
  const savePayment=async(payment,key)=>{
    if(!detail)return;
    setDetailBusy(true);setError('');
    try{
      const updated=await recordBranchTransferPayment({
        transferId:detail.id,amount:Number(payment.amount),currency:detail.currency,
        paidAt:payment.paidAt?new Date(payment.paidAt).toISOString():null,
        method:payment.method,reference:payment.reference,notes:payment.notes,
      },key);
      setDetail(updated);await load();toast?.('Transfer to‘lovi tarixga qo‘shildi');
      return true;
    }catch(e){setError(message(e));return false}finally{setDetailBusy(false)}
  };

  return <section className="tw-workspace">
    <div className="m-page-head between"><div><h2>Filiallararo transferlar</h2><p>Qabul tasdig‘i, ulgurji qarz va to‘lovlar tarixi</p></div><button className="btn btn-primary" onClick={()=>setCreateOpen(true)} disabled={!branchId}><Plus/>Yangi transfer</button></div>
    <div className="tw-toolbar"><div className="tw-tabs">{[['all','Barchasi'],['outgoing','Chiquvchi'],['incoming','Kiruvchi']].map(([key,text])=><button key={key} className={direction===key?'active':''} onClick={()=>setDirection(key)}>{text}</button>)}</div><label className="tw-search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Transfer, QR, SKU yoki mahsulot"/></label></div>
    <State loading={loading} error={error} retry={load}>{rows.length===0?<Empty title="Transferlar topilmadi" text="Filtrni o‘zgartiring yoki yangi transfer yarating."/>:<div className="tw-list">{rows.map(row=><TransferCard key={row.id} row={row} branchId={branchId} open={()=>openDetail(row.id)}/>)}</div>}</State>
    <TransferCreate open={createOpen} close={()=>setCreateOpen(false)} branchId={branchId} refs={refs} toast={toast} completed={async transfer=>{setCreateOpen(false);setDetail(transfer);await load()}}/>
    <TransferDetail transfer={detail} close={()=>setDetail(null)} busy={detailBusy} action={lifecycle} savePayment={savePayment} branchId={branchId} editTransfer={editTransfer} refs={refs}/>
  </section>;
}

function TransferCard({row,branchId,open}){
  const outgoing=row.from_branch_id===branchId;
  return <button className="card tw-card" onClick={open}><div className={`tw-direction ${outgoing?'out':'in'}`}>{outgoing?<ArrowUpRight/>:<ArrowDownLeft/>}</div><div className="tw-card-main"><div className="between"><b>{row.transfer_no}</b><Status type={badge[row.status]}>{labels[row.status]||row.status}</Status></div><strong>{row.from_branch_name} → {row.to_branch_name}</strong><span><MapPin/>{row.from_location_name} → {row.to_location_name}</span><div className="tw-card-meta"><span><Boxes/>{Number(row.unit_count)} dona</span><span><CalendarDays/>{date(row.created_at)}</span><b>{amount(row.total_amount,row.currency)}</b></div></div><ChevronRight/></button>;
}

function TransferCreate({open,close,branchId,refs,toast,completed}){
  const[form,setForm]=useState({from_location_id:'',to_branch_id:'',to_location_id:'',notes:''});
  const[initialPayment,setInitialPayment]=useState(paymentEmpty);
  const[keys,setKeys]=useState(()=>({transferKey:crypto.randomUUID(),paymentKey:crypto.randomUUID()}));
  const[code,setCode]=useState('');
  const[units,setUnits]=useState([]);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');

  useEffect(()=>{
    if(!open)return;
    const branch=refs.destination_branches?.[0];
    setForm({from_location_id:refs.source_locations?.[0]?.id||'',to_branch_id:branch?.id||'',to_location_id:branch?.locations?.[0]?.id||'',notes:''});
    setInitialPayment(paymentEmpty());setKeys({transferKey:crypto.randomUUID(),paymentKey:crypto.randomUUID()});setCode('');setUnits([]);setError('');
  },[open]);

  const destination=refs.destination_branches?.find(x=>x.id===form.to_branch_id);
  const groupPrices=React.useRef(new Map());
  const[,forcePrice]=useState(0);
  const groups=useMemo(()=>{const map=new Map();units.forEach(u=>{const key=u.product_id;if(!map.has(key))map.set(key,{product_id:key,product_name:u.product_name,sku:u.sku,image:u.image,wholesale_price:u.wholesale_price,latest_batch_price:u.latest_batch_price,latest_batch_date:u.latest_batch_date,available_count:u.available_count,units:[]});map.get(key).units.push(u)});return[...map.values()]},[units]);
  const getGroupPrice=pid=>{const ov=groupPrices.current.get(pid);return(ov!==undefined&&ov!=='')?Number(ov):null};
  const total=useMemo(()=>units.reduce((sum,u)=>{const gp=getGroupPrice(u.product_id);return sum+(gp!==null?gp:Number(u.wholesale_price||0))},0),[units,groups]);
  const addUnit=unit=>{
    if(units.some(x=>x.id===unit.id)){setError('Bu mahsulot avval qo‘shilgan.');return}
    if(!Number(unit.wholesale_price)){setError('Bu mahsulot uchun ulgurji narx belgilanmagan.');return}
    setUnits([...units,unit]);setCode('');setError('');
  };
  const scan=async e=>{
    e.preventDefault();
    if(!form.from_location_id)return setError('Avval jo‘natish joyini tanlang.');
    setBusy(true);setError('');
    try{addUnit(await findTransferUnit(branchId,form.from_location_id,code.trim()))}catch(e){setError(message(e))}finally{setBusy(false)}
  };
  const submit=async e=>{
    e.preventDefault();
    if(!units.length)return setError('Kamida bitta mahsulot qo‘shing.');
    if(units.some(x=>!Number.isFinite(Number(x.wholesale_price))||Number(x.wholesale_price)<=0))return setError('Har bir mahsulotda musbat ulgurji narx bo‘lishi kerak.');
    const hasInitialPayment=initialPayment.amount.trim()!=='';
    const paid=hasInitialPayment?Number(initialPayment.amount):0;
    if(hasInitialPayment&&(!Number.isFinite(paid)||paid<=0))return setError('Boshlang‘ich to‘lov noldan katta bo‘lishi kerak.');
    if(paid>total)return setError('Boshlang‘ich to‘lov transfer qiymatidan oshmasligi kerak.');
    setBusy(true);setError('');
    try{
      const payment=hasInitialPayment?{amount:paid,method:initialPayment.method,paid_at:initialPayment.paidAt?new Date(initialPayment.paidAt).toISOString():null,reference:initialPayment.reference||null,notes:initialPayment.notes||null}:null;
      const transfer=await createBranchTransfer(
        {from_location_id:form.from_location_id,to_location_id:form.to_location_id,currency:'USD',notes:form.notes||null},
        units.map(x=>({unit_id:x.id,unit_price:getGroupPrice(x.product_id)??Number(x.wholesale_price)})),payment,keys,
      );
      toast?.('Transfer so‘rovi va boshlang‘ich hisob-kitob saqlandi');await completed(transfer);
    }catch(e){setError(message(e))}finally{setBusy(false)}
  };

  return <Modal open={open} onClose={close} wide title="Yangi transfer"><form className="tw-create" onSubmit={submit}>
    {error&&<div className="tw-inline-error">{error}</div>}
    <div className="tw-form-grid">
      <label><span>Jo‘natish joyi</span><select className="select" value={form.from_location_id} onChange={e=>{setForm({...form,from_location_id:e.target.value});setUnits([])}} required>{refs.source_locations?.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label><span>Qabul qiluvchi filial</span><select className="select" value={form.to_branch_id} onChange={e=>{const branch=refs.destination_branches.find(x=>x.id===e.target.value);setForm({...form,to_branch_id:e.target.value,to_location_id:branch?.locations?.[0]?.id||''})}} required>{refs.destination_branches?.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label><span>Qabul qilish joyi</span><select className="select" value={form.to_location_id} onChange={e=>setForm({...form,to_location_id:e.target.value})} required>{destination?.locations?.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label><span>Valyuta</span><input className="input" value="USD" readOnly/></label>
      <label className="wide"><span>Izoh</span><textarea className="textarea" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label>
    </div>
    <div className="tw-scan-block"><b>Mahsulotlarni QR, seriya, SKU yoki nom orqali qidiring</b><div className="tw-scan-row"><QrCode/><input className="input" value={code} onChange={e=>setCode(e.target.value)} placeholder="QR, seriya, SKU yoki mahsulot nomi"/><QrScanButton onScan={v=>setCode(v)}/><button type="button" className="btn" onClick={scan} disabled={busy||!code.trim()}>Aniq topish</button></div></div>
    <TransferSearchResults branchId={branchId} locationId={form.from_location_id} query={code} units={units} onAdd={addUnit}/>
    <div className="tw-groups">{groups.map(group=><div className="tw-group card" key={group.product_id}><div className="tw-group-head">{group.image?<img src={group.image} alt=""/>:<span className="tw-image-fallback"><Boxes/></span>}<div><b>{group.product_name}</b><small>{group.sku} · {group.units.length} dona tanlangan{group.available_count?` · Omborda: ${group.available_count} dona`:''}</small>{group.latest_batch_price&&<small className="tw-batch-info">Oxirgi partiya: {amount(group.latest_batch_price,'USD')}{group.latest_batch_date?` (${new Date(group.latest_batch_date).toLocaleDateString('uz-UZ')})`:''}</small>}</div></div><div className="tw-group-price"><label><span>Ulgurji narx (USD) — {group.units.length} dona uchun</span><input className="input" type="number" min="0.01" step="0.01" value={groupPrices.current.get(group.product_id)??''} placeholder={String(group.wholesale_price)} onChange={e=>{groupPrices.current.set(group.product_id,e.target.value);forcePrice(n=>n+1)}}/></label><small>Default: {amount(group.wholesale_price,'USD')} · Jami: {amount((getGroupPrice(group.product_id)??Number(group.wholesale_price||0))*group.units.length,'USD')}</small></div><details className="tw-group-units"><summary>{group.units.length} ta birlik (QR kodlar)</summary><div>{group.units.map(u=><div key={u.id} className="tw-group-unit"><small>{u.qr_code}{u.serial_number?` · ${u.serial_number}`:''}</small><button type="button" onClick={()=>setUnits(units.filter(x=>x.id!==u.id))}><Trash2 size={13}/></button></div>)}</div></details></div>)}</div><div className="tw-total"><span>{units.length} dona · ulgurji qiymat</span><b>{amount(total,'USD')}</b></div>
    <section className="tw-payment-box"><div><WalletCards/><span><b>Boshlang‘ich to‘lov</b><small>To‘liq, qisman yoki oldindan olingan summa. Bo‘sh qoldirish mumkin.</small></span></div><div className="tw-form-grid"><label><span>Olingan summa (USD)</span><input className="input" type="number" min="0" max={total||undefined} step="0.01" value={initialPayment.amount} onChange={e=>setInitialPayment({...initialPayment,amount:e.target.value})}/></label><label><span>To‘lov sanasi</span><input className="input" type="datetime-local" max={localNow()} value={initialPayment.paidAt} onChange={e=>setInitialPayment({...initialPayment,paidAt:e.target.value})}/></label><label><span>To‘lov usuli</span><select className="select" value={initialPayment.method} onChange={e=>setInitialPayment({...initialPayment,method:e.target.value})}>{paymentMethods.map(x=><option key={x}>{x}</option>)}</select></label><label><span>Hujjat / izoh</span><input className="input" value={initialPayment.reference} onChange={e=>setInitialPayment({...initialPayment,reference:e.target.value})} placeholder="Ixtiyoriy"/></label></div></section>
    <button className="btn btn-primary btn-block" disabled={busy||!units.length}>{busy?'Yaratilmoqda…':'Transfer so‘rovini yaratish'}</button>
  </form></Modal>;
}

function TransferDetail({transfer,close,busy,action,savePayment,branchId,editTransfer,refs}){
  const[form,setForm]=useState(paymentEmpty);
  const[editing,setEditing]=useState(false);
  const[editUnits,setEditUnits]=useState([]);
  const[editCode,setEditCode]=useState('');
  const[editBusy,setEditBusy]=useState(false);
  const[editError,setEditError]=useState('');
  const canEdit=transfer&&transfer.from_branch_id===branchId&&['requested','approved'].includes(transfer.status);
  const[key,setKey]=useState(()=>crypto.randomUUID());
  const[error,setError]=useState('');
  useEffect(()=>{setForm(paymentEmpty());setKey(crypto.randomUUID());setError('')},[transfer?.id]);
  const canViewSettlement=transfer?.paid_amount!=null&&transfer?.remaining_amount!=null;
  const remaining=canViewSettlement?Number(transfer.remaining_amount):0;
  const submit=async e=>{
    e.preventDefault();
    const value=Number(form.amount);
    if(!Number.isFinite(value)||value<=0)return setError('To‘lov summasi noldan katta bo‘lishi kerak.');
    if(value>remaining)return setError('To‘lov qoldiq summadan oshmasligi kerak.');
    setError('');
    if(await savePayment(form,key)){setForm(paymentEmpty());setKey(crypto.randomUUID())}
  };
  return <Modal open={Boolean(transfer)} onClose={close} wide title={transfer?.transfer_no||'Transfer'}>{transfer&&<div className="tw-detail">
    <div className="tw-detail-head"><Status type={badge[transfer.status]}>{labels[transfer.status]||transfer.status}</Status><b>{amount(transfer.total_amount,transfer.currency)}</b></div>
    <div className="tw-route"><span><small>Jo‘natuvchi</small><b>{transfer.from_branch_name}</b><em>{transfer.from_location_name}</em></span><i>→</i><span><small>Qabul qiluvchi</small><b>{transfer.to_branch_name}</b><em>{transfer.to_location_name}</em></span></div>
    {transfer.notes&&<p className="tw-notes">{transfer.notes}</p>}
    <div className="tw-timeline">{[['So‘raldi',transfer.requested_at],['Tasdiqlandi',transfer.approved_at],['Yo‘lga chiqarildi',transfer.shipped_at],['Qabul qilindi',transfer.received_at]].map(([name,value])=><span className={value?'done':''} key={name}><i/><b>{name}</b><small>{date(value)}</small></span>)}</div>
    <h3>Mahsulotlar ({transfer.lines?.length||0})</h3><div className="tw-detail-lines">{transfer.lines?.map(line=><div key={line.id}>{line.image?<img src={line.image} alt=""/>:<span className="tw-image-fallback"><Boxes/></span>}<span><b>{line.product_name}</b><small>{line.sku} · QR: {line.qr_code}{line.serial_number?` · S/N: ${line.serial_number}`:''}</small></span><strong>{amount(line.unit_price,transfer.currency)}</strong></div>)}</div>
    {canViewSettlement&&<section className="tw-settlement"><h3>Ulgurji hisob-kitob</h3>{transfer.wholesale_exchange_rate&&transfer.wholesale_rate_date&&<p className="tw-settlement-rate">Hisob kursi: 1 USD = {new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:4}).format(Number(transfer.wholesale_exchange_rate))} UZS · {String(transfer.wholesale_rate_date).split('-').reverse().join('.')}</p>}<div className="dw-detail-total"><span><small>Jami</small><b>{amount(transfer.total_amount,transfer.currency)}</b></span><span><small>Olingan</small><b>{amount(transfer.paid_amount,transfer.currency)}</b></span><span><small>Qoldiq</small><b>{amount(remaining,transfer.currency)}</b></span></div><h3>To‘lovlar tarixi</h3>{transfer.payments?.length?<div className="dw-payments">{transfer.payments.map(payment=><div key={payment.id}><span><b>{amount(payment.amount,payment.currency)}</b><small>{payment.method}{payment.reference?` · ${payment.reference}`:''}</small>{payment.notes&&<em>{payment.notes}</em>}</span><time>{date(payment.paid_at)}</time></div>)}</div>:<p className="dw-no-payments">Hozircha to‘lov kiritilmagan.</p>}</section>}
    {transfer.can_record_payment&&remaining>0&&<form className="dw-payment-form" onSubmit={submit}><h3>Yangi olingan summani qo‘shish</h3>{error&&<div className="tw-inline-error">{error}</div>}<div className="dw-form-grid"><label><span>Summa ({transfer.currency})</span><input className="input" type="number" min="0.01" max={remaining} step="0.01" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} required/></label><label><span>To‘lov sanasi</span><input className="input" type="datetime-local" max={localNow()} value={form.paidAt} onChange={e=>setForm({...form,paidAt:e.target.value})} required/></label><label><span>To‘lov usuli</span><select className="select" value={form.method} onChange={e=>setForm({...form,method:e.target.value})}>{paymentMethods.map(x=><option key={x}>{x}</option>)}</select></label><label><span>Hujjat raqami</span><input className="input" value={form.reference} onChange={e=>setForm({...form,reference:e.target.value})}/></label><label className="wide"><span>Izoh</span><input className="input" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label></div><button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'To‘lovni tarixga qo‘shish'}</button></form>}
    <div className="tw-actions">{transfer.can_approve&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('approve')}>Tasdiqlash</button>}{transfer.can_ship&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('ship')}>Yo‘lga chiqarish</button>}{transfer.can_receive&&<button className="btn btn-primary" disabled={busy} onClick={()=>action('receive')}>Tovarlarni olganimni tasdiqlayman</button>}{canEdit&&<button className="btn" disabled={busy} onClick={()=>{setEditing(true);setEditUnits(transfer.lines?.map(l=>({id:l.unit_id,product_id:l.product_id,product_name:l.product_name,sku:l.sku,qr_code:l.qr_code,serial_number:l.serial_number,image:l.image,wholesale_price:l.unit_price}))||[]);setEditCode('');setEditError('')}}>Tahrirlash</button>}</div>
    {editing&&<div className="tw-edit-panel"><h3>Transfer tahrirlash</h3>{editError&&<div className="tw-inline-error">{editError}</div>}<div className="tw-scan-block"><div className="tw-scan-row"><QrCode/><input className="input" value={editCode} onChange={e=>setEditCode(e.target.value)} placeholder="QR yoki seriya"/><button type="button" className="btn" disabled={editBusy||!editCode.trim()} onClick={async()=>{setEditBusy(true);setEditError('');try{const unit=await findTransferUnit(branchId,transfer.from_location_id,editCode.trim());if(editUnits.some(x=>x.id===unit.id)){setEditError('Avval tanlangan');return}setEditUnits([...editUnits,{id:unit.id,product_id:unit.product_id,product_name:unit.product_name,sku:unit.sku,qr_code:unit.qr_code,serial_number:unit.serial_number,image:unit.image,wholesale_price:unit.wholesale_price}]);setEditCode('')}catch(e){setEditError(message(e))}finally{setEditBusy(false)}}}>+</button></div></div><div className="tw-units">{editUnits.map(u=><div className="tw-unit" key={u.id}><span className="tw-image-fallback"><Boxes/></span><div><b>{u.product_name}</b><small>{u.qr_code}</small></div><button type="button" className="tw-remove" onClick={()=>setEditUnits(editUnits.filter(x=>x.id!==u.id))}><Trash2/></button></div>)}</div><div className="tw-actions"><button className="btn" onClick={()=>setEditing(false)}>Bekor</button><button className="btn btn-primary" disabled={editBusy||!editUnits.length} onClick={async()=>{setEditBusy(true);setEditError('');const ok=await editTransfer(transfer.id,editUnits.map(x=>({unit_id:x.id,unit_price:Number(x.wholesale_price)})));if(ok)setEditing(false);setEditBusy(false)}}>Saqlash</button></div></div>}
  </div>}</Modal>;
}

function TransferSearchResults({branchId,locationId,query,units,onAdd}){
  const[results,setResults]=useState([]);
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState('');
  useEffect(()=>{
    if(!query||query.trim().length<2||!locationId){setResults([]);setError('');return}
    const timer=setTimeout(async()=>{
      setLoading(true);setError('');
      try{const data=await searchTransferUnits(branchId,locationId,query.trim(),20);setResults((data||[]).filter(u=>!units.some(x=>x.id===u.id)))}
      catch(e){setResults([]);setError(message(e))}finally{setLoading(false)}
    },350);
    return()=>clearTimeout(timer);
  },[branchId,locationId,query,units]);
  if(!query||query.trim().length<2)return null;
  return <div className="tw-search-results">{loading&&<small>Qidirilmoqda…</small>}{error&&<small className="tw-search-error">{error}</small>}{results.map(u=><button type="button" key={u.id} className="tw-search-item" onClick={()=>onAdd(u)}><div><b>{u.product_name}</b><small>{u.sku} · QR: {u.qr_code}{u.serial_number?` · ${u.serial_number}`:''}</small><strong>{amount(u.wholesale_price,u.currency||'USD')} ulgurji</strong></div><Plus size={16}/></button>)}</div>;
}
