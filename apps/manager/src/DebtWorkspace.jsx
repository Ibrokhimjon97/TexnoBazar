import React,{useEffect,useState}from'react';
import{AlertTriangle,CalendarDays,ChevronRight,Landmark,PackagePlus,ReceiptText,Truck}from'lucide-react';
import{Empty,Modal,Status,formatMoney}from'@texnobazar/ui';
import{getBranchDebt,getBranchDebtSummary,listBranchDebts,listSupplierDebts,recordBranchDebtPayment}from'@texnobazar/data';
const message=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const labels={open:'Ochiq',partially_paid:'Qisman to‘langan',paid:'To‘langan',void:'Bekor qilingan'};
const badge={open:'orange',partially_paid:'blue',paid:'green',void:'gray'};
const amount=(value,currency)=>currency==='UZS'?formatMoney(Number(value||0)):`${new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:2}).format(Number(value||0))} ${currency}`;
const date=value=>value?new Date(value).toLocaleString('uz-UZ'):'—';
export default function DebtWorkspace({branchId,toast}){
  const[section,setSection]=useState('supplier');
  return <section className="dw-workspace">
    <div className="m-page-head"><h2>Qarzdorlik</h2><p>Ta'minotchilar va filiallar bo'yicha hisob-kitoblar</p></div>
    <div className="dw-tabs" style={{marginBottom:16}}>
      <button className={section==='supplier'?'active':''} onClick={()=>setSection('supplier')}><Truck size={15}/>Ta'minotchiga qarzimiz</button>
      <button className={section==='branch'?'active':''} onClick={()=>setSection('branch')}><Landmark size={15}/>Filial qarzlari</button>
    </div>
    {section==='supplier'?<SupplierDebtSection branchId={branchId} toast={toast}/>:<BranchDebtSection branchId={branchId} toast={toast}/>}
  </section>;
}

function SupplierDebtSection({branchId,toast}){
  const[suppliers,setSuppliers]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[detail,setDetail]=useState(null);
  const load=async()=>{if(!branchId){setLoading(false);return}setLoading(true);setError('');try{const data=await listSupplierDebts(branchId);setSuppliers(data||[])}catch(e){setError(message(e))}finally{setLoading(false)}};
  useEffect(()=>{load()},[branchId]);
  const totalBalance=suppliers.reduce((s,x)=>s+Number(x.total_balance||0),0);
  return <>
    <div className="dw-summary"><article className="card"><div><Landmark/><span><small>Ta'minotchilarga jami qarzimiz</small><b>${new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:2}).format(totalBalance)}</b></span></div><dl><div><dt>Ta'minotchilar</dt><dd>{suppliers.length} ta</dd></div><div><dt>Ochiq partiyalar</dt><dd>{suppliers.reduce((s,x)=>s+Number(x.open_receipt_count||0),0)} ta</dd></div></dl></article></div>
    {loading?<div className="dw-state">Yuklanmoqda...</div>:error?<div className="dw-state dw-error"><AlertTriangle/><b>Xatolik</b><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:suppliers.length===0?<Empty title="Qarz mavjud emas" text="Hozirda ta'minotchilarga qarzimiz yo'q."/>:<div className="dw-list">{suppliers.map(s=><button key={s.supplier_id} className="card dw-card" onClick={()=>setDetail(s)}><span className="dw-card-icon" style={{background:'#fff1e7',color:'var(--orange)'}}><PackagePlus/></span><div><div className="between"><b>{s.supplier_name}</b><Status type="orange">{s.total_receipt_count||s.open_receipt_count} partiya</Status></div><strong>Qarzimiz: ${new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:2}).format(Number(s.total_balance||0))}</strong><small>{s.supplier_code}</small></div><ChevronRight/></button>)}</div>}
    <SupplierDebtDetail supplier={detail} close={()=>setDetail(null)}/>
  </>;
}

function SupplierDebtDetail({supplier,close}){
  if(!supplier)return null;
  const receipts=supplier.receipts||[];
  const amt=(v,c)=>c==='UZS'?formatMoney(Number(v||0)):'$'+new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:2}).format(Number(v||0));
  const statusLabel={unpaid:'To`lanmagan',partial:'Qisman',paid:'To`langan'};
  const statusBadge={unpaid:'orange',partial:'blue',paid:'green'};
  return <Modal open={Boolean(supplier)} onClose={close} wide title={`${supplier.supplier_name} \u2014 qarzdorlik`}>
    <div className="dw-detail">
      <div className="dw-detail-total">
        <span><small>Ta'minotchiga qarzimiz</small><b>{'$'+new Intl.NumberFormat('uz-UZ',{maximumFractionDigits:2}).format(Number(supplier.total_balance||0))}</b></span>
        <span><small>Jami partiyalar</small><b>{supplier.total_receipt_count||0} ta</b></span>
        <span><small>To`lanmagan</small><b>{supplier.open_receipt_count||0} ta</b></span>
      </div>
      <h3>Barcha partiyalar</h3>
      {receipts.length?receipts.map(r=><div key={r.id} className="supplier-receipt-card card" style={{padding:14,marginBottom:10}}>
        <div className="between" style={{marginBottom:8}}>
          <div><b>{r.receipt_no}</b><br/><small><CalendarDays size={11}/> {new Date(r.received_at).toLocaleDateString('uz-UZ',{day:'numeric',month:'long',year:'numeric'})}</small></div>
          <div style={{textAlign:'right'}}><Status type={statusBadge[r.payment_status]||'gray'}>{statusLabel[r.payment_status]||r.payment_status}</Status><br/><b>{amt(r.total_cost,r.currency)}</b></div>
        </div>
        {r.products&&r.products.length>0&&<div className="table-wrap"><table className="table" style={{minWidth:'auto'}}><thead><tr><th>Tovar</th><th>SKU</th><th>Miqdor</th><th>Birlik narxi</th><th>Jami</th></tr></thead><tbody>{r.products.map((p,i)=><tr key={i}><td><b>{p.product_name}</b></td><td>{p.sku}</td><td>{Number(p.quantity)} dona</td><td>{amt(p.unit_cost,r.currency)}</td><td><b>{amt(p.line_total,r.currency)}</b></td></tr>)}</tbody></table></div>}
        <div style={{display:'flex',gap:16,marginTop:8,fontSize:11,color:'var(--muted)'}}>
          <span>To`langan: <b style={{color:'var(--green)'}}>{amt(r.paid_amount,r.currency)}</b></span>
          <span>Qoldiq: <b style={{color:'var(--red)'}}>{amt(Number(r.total_cost)-Number(r.paid_amount),r.currency)}</b></span>
        </div>
      </div>):<p className="dw-no-payments">Partiyalar topilmadi.</p>}
      <p style={{marginTop:16,padding:12,background:'#fff7ed',borderRadius:10,fontSize:12,color:'#9a3412'}}>
        <AlertTriangle size={14} style={{verticalAlign:'middle'}}/> Qarz miqdorini faqat superadmin tahrirlashi mumkin.
      </p>
    </div>
  </Modal>;
}
function BranchDebtSection({branchId,toast}){const[direction,setDirection]=useState('debtor'),[rows,setRows]=useState([]),[summary,setSummary]=useState({debtor:[],creditor:[]}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[detail,setDetail]=useState(null);const load=async()=>{if(!branchId){setLoading(false);return}setLoading(true);setError('');try{const[list,totals]=await Promise.all([listBranchDebts({branchId,direction,pageSize:50}),getBranchDebtSummary(branchId)]);setRows(list.items||[]);setSummary(totals||{debtor:[],creditor:[]})}catch(e){setError(message(e))}finally{setLoading(false)}};useEffect(()=>{load()},[branchId,direction]);const open=async id=>{setError('');try{setDetail(await getBranchDebt(id))}catch(e){setError(message(e))}};const refreshed=async debt=>{setDetail(debt);await load()};const displayedSummary=direction==='all'?[...(summary.debtor||[]).map(x=>({...x,side:'Bizning qarzimiz'})),...(summary.creditor||[]).map(x=>({...x,side:'Bizga qarz'}))]:summary[direction]||[];return <section className="dw-workspace"><div className="m-page-head"><h2>Filial qarzdorligi</h2><p>Qabul qilingan transferlar bo‘yicha hisob-kitoblar</p></div><div className="dw-tabs">{[['debtor','Bizning qarzlarimiz'],['creditor','Bizga qarzlar'],['all','Barchasi']].map(([key,text])=><button key={key} className={direction===key?'active':''} onClick={()=>setDirection(key)}>{text}</button>)}</div><div className="dw-summary">{displayedSummary.map((item,index)=><article className="card" key={`${item.currency}-${item.side||direction}-${index}`}><div><Landmark/><span><small>{item.side||'Valyuta'}</small><b>{item.currency}</b></span></div><dl><div><dt>Jami</dt><dd>{amount(item.amount,item.currency)}</dd></div><div><dt>To‘langan</dt><dd>{amount(item.paid_amount,item.currency)}</dd></div><div><dt>Qoldiq</dt><dd>{amount(item.remaining_amount,item.currency)}</dd></div></dl></article>)}</div>{loading?<div className="dw-state">Qarzlar yuklanmoqda…</div>:error?<div className="dw-state dw-error"><AlertTriangle/><b>Xatolik yuz berdi</b><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>:rows.length===0?<Empty title="Qarzlar topilmadi" text="Bu yo‘nalishda filial qarzi mavjud emas."/>:<div className="dw-list">{rows.map(row=><DebtCard key={row.id} debt={row} branchId={branchId} open={()=>open(row.id)}/>)}</div>}<DebtDetail debt={detail} close={()=>setDetail(null)} toast={toast} refreshed={refreshed}/></section>}
function DebtCard({debt,branchId,open}){const debtor=debt.debtor_branch_id===branchId;return <button className="card dw-card" onClick={open}><span className="dw-card-icon"><ReceiptText/></span><div><div className="between"><b>{debt.transfer_no}</b><Status type={badge[debt.status]}>{labels[debt.status]||debt.status}</Status></div><strong>{debtor?debt.creditor_branch_name:debt.debtor_branch_name}</strong><small>{debtor?'Kreditor filial':'Qarzdor filial'}</small><div className="dw-amounts"><span>Jami <b>{amount(debt.amount,debt.currency)}</b></span><span>To‘langan <b>{amount(debt.paid_amount,debt.currency)}</b></span><span>Qoldiq <b>{amount(debt.remaining_amount,debt.currency)}</b></span></div><span className="dw-date"><CalendarDays/>{date(debt.created_at)}</span></div><ChevronRight/></button>}
function DebtDetail({debt,close,toast,refreshed}){
  const[form,setForm]=useState({amount:'',method:'Naqd',reference:'',notes:''}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setForm({amount:'',method:'Naqd',reference:'',notes:''});setError('')},[debt?.id]);
  const remaining=Number(debt?.remaining_amount||0),transfer=debt?.transfer;
  const pay=async e=>{e.preventDefault();const value=Number(form.amount);if(!Number.isFinite(value)||value<=0)return setError('To‘lov summasi noldan katta bo‘lishi kerak.');if(value>remaining)return setError('To‘lov qoldiq qarzdan oshmasligi kerak.');setBusy(true);setError('');try{const updated=await recordBranchDebtPayment({debtId:debt.id,amount:value,currency:debt.currency,method:form.method,reference:form.reference,notes:form.notes});toast?.('Qarz to‘lovi muvaffaqiyatli qayd etildi');await refreshed(updated);setForm({amount:'',method:'Naqd',reference:'',notes:''})}catch(e){setError(message(e))}finally{setBusy(false)}};
  return <Modal open={Boolean(debt)} onClose={close} wide title={debt?.transfer_no||'Qarz'}>{debt&&<div className="dw-detail">
    <div className="dw-detail-status"><Status type={badge[debt.status]}>{labels[debt.status]||debt.status}</Status><small>Qarz yaratildi: {date(debt.created_at)}</small></div>
    <div className="dw-parties"><span><small>Qarzdor filial</small><b>{debt.debtor_branch_name}</b></span><i>→</i><span><small>Kreditor filial</small><b>{debt.creditor_branch_name}</b></span></div>
    <div className="dw-detail-total"><span><small>Ulgurji jami</small><b>{amount(debt.amount,debt.currency)}</b></span><span><small>Berilgan summa</small><b>{amount(debt.paid_amount,debt.currency)}</b></span><span><small>Qoldiq qarz</small><b>{amount(debt.remaining_amount,debt.currency)}</b></span></div>
    {transfer&&<section className="dw-transfer-detail"><h3>Transfer va qabul tafsilotlari</h3><div className="dw-transfer-dates"><span><small>So‘rov sanasi</small><b>{date(transfer.requested_at)}</b></span><span><small>Jo‘natilgan sana</small><b>{date(transfer.shipped_at)}</b></span><span><small>Qabul qilingan sana</small><b>{date(transfer.received_at)}</b></span></div><div className="dw-transfer-route"><span>{transfer.from_location_name}</span><i>→</i><span>{transfer.to_location_name}</span></div>{transfer.notes&&<p className="tw-notes">{transfer.notes}</p>}<h3>Qabul qilingan mahsulotlar ({transfer.lines?.length||0})</h3><div className="tw-detail-lines">{transfer.lines?.map(line=><div key={line.id}>{line.image?<img src={line.image} alt=""/>:<span className="tw-image-fallback"><PackagePlus/></span>}<span><b>{line.product_name}</b><small>{line.sku} · QR: {line.qr_code}{line.serial_number?` · S/N: ${line.serial_number}`:''}</small></span><strong>{amount(line.line_amount,debt.currency)}</strong></div>)}</div></section>}
    <h3>To‘lovlar tarixi</h3>{debt.payments?.length?<div className="dw-payments">{debt.payments.map(payment=><div key={payment.id}><span><b>{amount(payment.amount,payment.currency)}</b><small>{payment.method}{payment.reference?` · ${payment.reference}`:''}</small>{payment.notes&&<em>{payment.notes}</em>}</span><time>{date(payment.paid_at)}</time></div>)}</div>:<p className="dw-no-payments">Hozircha to‘lov kiritilmagan.</p>}
    {debt.can_record_payment&&remaining>0&&<form className="dw-payment-form" onSubmit={pay}><h3>Yangi to‘lovni tarixga qo‘shish</h3>{error&&<div className="tw-inline-error">{error}</div>}<div className="dw-form-grid"><label><span>Summa ({debt.currency})</span><input className="input" type="number" min="0.01" max={remaining} step="0.01" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} required/></label><label><span>To‘lov usuli</span><select className="select" value={form.method} onChange={e=>setForm({...form,method:e.target.value})}><option>Naqd</option><option>Bank o‘tkazmasi</option><option>Terminal</option><option>Boshqa</option></select></label><label><span>Havola yoki hujjat raqami</span><input className="input" value={form.reference} onChange={e=>setForm({...form,reference:e.target.value})}/></label><label><span>Izoh</span><input className="input" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label></div><button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'To‘lovni tarixga qo‘shish'}</button></form>}
  </div>}</Modal>;
}
