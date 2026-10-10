import React,{useEffect,useMemo,useState}from'react';
import{createPortal}from'react-dom';
import{AlertTriangle,ArrowRight,Bluetooth,Boxes,Calendar,CheckCircle2,ChevronLeft,ChevronRight,Clock3,Copy,Eye,EyeOff,ExternalLink,FileArchive,FileSpreadsheet,HardDriveDownload,HardDriveUpload,Loader2,MapPin,PackagePlus,Download,Pencil,Plus,Printer,QrCode,ReceiptText,RotateCcw,Search,Trash2,Upload,UploadCloud,Warehouse,X}from'lucide-react';
import{DualPrice,Empty,Modal,ProductExcelImportModal,ProductEditor,QrScanButton,Status,formatDualMoney,formatMoney,useExchangeRate,DetongerPrintModal}from'@texnobazar/ui';
import QRCode from'qrcode';
import RichTextEditor from'./RichTextEditor';
import{CreateProductInline}from'./InventoryRegisterModal';
import{formatUzDate,getUzMonthName,getBrowserClient,createStockReceipt,deleteStockReceipt,getInventoryReferences,getInventoryUnitPassport,getLatestExchangeRate,getStockReceipt,listInventoryBalances,listReceiptQrLabels,listStockReceipts,placeInventoryUnits,revertUnitSale,updateStockReceipt,uploadProductMedia,exportBatchesBackup,exportReceiptBackup,inspectBatchesBackupFile,restoreBatchesBackupFile}from'@texnobazar/data';
const err=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
// Visual marker only: INV-* kirimlar inventarizatsiya orqali ro‘yxatga olingan,
// qolganlari esa oddiy yetkazib berish partiyasi.
const isInventoryReceipt=receiptNo=>/^INV-/i.test(String(receiptNo||'').trim());
export function InventoryBatches({branchId,onCreate,onCreateBatch,onCreateInventory,toast}){
  const[rows,setRows]=useState([]),[total,setTotal]=useState(0),[query,setQuery]=useState(''),[typeFilter,setTypeFilter]=useState('all'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[detail,setDetail]=useState(null),[detailEdit,setDetailEdit]=useState(false),[deletingId,setDeletingId]=useState(null);
  const[passwordModal,setPasswordModal]=useState(null);
  const[selectedDate,setSelectedDate]=useState(null);
  const[calMonth,setCalMonth]=useState(()=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth(),1)});
  const[rate,setRate]=useState(null);
  const[exportingAll,setExportingAll]=useState(false);
  const[exportingId,setExportingId]=useState(null);
  const[restoreModalOpen,setRestoreModalOpen]=useState(false);

  const handleExportAll=async()=>{
    setExportingAll(true);
    try{
      const res=await exportBatchesBackup(branchId);
      toast?.(`${res.counts.receipts} ta partiya va inventarizatsiya JSON faylga yuklandi`);
    }catch(e){
      alert(err(e));
    }finally{
      setExportingAll(false);
    }
  };

  const handleExportSingle=async(receiptId,receiptNo)=>{
    setExportingId(receiptId);
    try{
      const res=await exportReceiptBackup(receiptId);
      toast?.(`"${receiptNo}" partiyasi (${res.counts.units} dona tovar) JSON zahiraga yuklandi`);
    }catch(e){
      alert(err(e));
    }finally{
      setExportingId(null);
    }
  };
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{})},[]);
  const load=async()=>{if(!branchId)return;setLoading(true);setError('');try{const r=await listStockReceipts({branchId,query,pageSize:100});setRows(r.items||[]);setTotal(Number(r.total)||0)}catch(e){setError(err(e))}finally{setLoading(false)}};
  useEffect(()=>{const t=setTimeout(load,query?250:0);return()=>clearTimeout(t)},[branchId,query]);
  const open=async(id,isEdit=false)=>{try{setDetail(await getStockReceipt(id));setDetailEdit(Boolean(isEdit));}catch(e){setError(err(e))}};
  const deleteBatch=async(id,receiptNo,password=null)=>{
    const cleanPassword = typeof password === 'string' ? password.trim() : null;
    if(deletingId)return;
    if(!cleanPassword&&!confirm(`"${receiptNo}" partiyasini o'chirishni tasdiqlaysizmi?\n\nDIQQAT: Ushbu partiyaga tegishli tovar birliklari o'chiriladi!`))return;
    setDeletingId(id);
    try{
      await deleteStockReceipt(id,cleanPassword);
      setRows(prev=>prev.filter(r=>r.id!==id));
      setPasswordModal(null);
      setError('');
      await load();
    }catch(e){
      const message=err(e);
      if(e?.code==='P0002'||message.includes('Topilmadi')){
        setRows(prev=>prev.filter(r=>r.id!==id));
        setPasswordModal(null);
        setError('');
        await load();
      }else if(message.includes('sotilganlari bor')||e?.code==='P0001'||message.includes('Parol')||message.includes('parol')){
        if(cleanPassword){
          setPasswordModal(prev=>({...(prev||{id,receiptNo,password:''}),error:message||'Noto\'g\'ri parol kiritildi!'}));
        }else{
          setPasswordModal({id,receiptNo,password:'',error:''});
        }
      }else{
        if(passwordModal){
          setPasswordModal(prev=>({...prev,error:message}));
        }else{
          alert(message);
        }
      }
    }finally{
      setDeletingId(null);
    }
  };
  const batchDatesSet=useMemo(()=>{const set=new Set();rows.forEach(x=>{if(x.received_at){const d=new Date(x.received_at);set.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)}});return set},[rows]);
  const batchCount=useMemo(()=>rows.filter(x=>!isInventoryReceipt(x.receipt_no)).length,[rows]);
  const invCount=useMemo(()=>rows.filter(x=>isInventoryReceipt(x.receipt_no)).length,[rows]);
  const displayRows=useMemo(()=>{
    return rows.filter(x=>{
      if(typeFilter==='batch'&&isInventoryReceipt(x.receipt_no))return false;
      if(typeFilter==='inventory'&&!isInventoryReceipt(x.receipt_no))return false;
      if(selectedDate){
        const d=new Date(x.received_at);
        if(d.getFullYear()!==selectedDate.getFullYear()||d.getMonth()!==selectedDate.getMonth()||d.getDate()!==selectedDate.getDate())return false;
      }
      return true;
    });
  },[rows,selectedDate,typeFilter]);
  const handleDateClick=(date)=>{if(selectedDate&&selectedDate.getFullYear()===date.getFullYear()&&selectedDate.getMonth()===date.getMonth()&&selectedDate.getDate()===date.getDate()){setSelectedDate(null)}else{setSelectedDate(date)}};
  const handleCreateBatch=onCreateBatch||onCreate;
  const handleCreateInventory=onCreateInventory||onCreate;

  return <>
  <div className="m-page-head between">
    <div>
      <h2>Partiyalar va Inventarizatsiya</h2>
      <p>Yetkazib beruvchilardan kirimlar va ombordagi tovarlar inventarizatsiyasi</p>
    </div>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <button className="btn btn-primary" onClick={handleCreateBatch}>
        <Plus size={16}/>Yangi partiya
      </button>
      <button className="btn btn-outline" style={{borderColor:'#7c3aed',color:'#7c3aed',background:'#f5f3ff',fontWeight:600}} onClick={handleCreateInventory}>
        <Boxes size={16}/>Inventarizatsiya
      </button>
      <button className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={handleExportAll} disabled={exportingAll} title="Barcha partiya va inventarizatsiyalarni JSON faylga yuklash">
        <Download size={15}/>{exportingAll?'Eksport qilinmoqda…':'Zahira olish'}
      </button>
      <button className="btn btn-outline" style={{borderColor:'#2563eb',color:'#2563eb',background:'#eff6ff',display:'inline-flex',alignItems:'center',gap:6,fontWeight:600}} onClick={()=>setRestoreModalOpen(true)} title="Zahira faylidan partiyalarni qayta tiklash">
        <Upload size={15}/>Zahiradan tiklash
      </button>
    </div>
  </div>
  <div className="batch-stats">
    <div><b>{total}</b><span>Jami yozuvlar</span></div>
    <div><b>{batchCount}</b><span>Kirim partiyalari</span></div>
    <div><b>{invCount}</b><span>Inventarizatsiyalar</span></div>
    <div><b>{rows.reduce((s,x)=>s+Number(x.unit_count),0)}</b><span>Jami birliklar</span></div>
  </div>
  <div className="batch-origin-tabs" style={{display:'flex',gap:8,margin:'14px 0',flexWrap:'wrap'}}>
    <button type="button" className={`btn ${typeFilter==='all'?'btn-primary':'btn-outline'}`} onClick={()=>setTypeFilter('all')}>
      Barchasi ({rows.length})
    </button>
    <button type="button" className={`btn ${typeFilter==='batch'?'btn-primary':'btn-outline'}`} onClick={()=>setTypeFilter('batch')}>
      Partiyalar ({batchCount})
    </button>
    <button type="button" className={`btn ${typeFilter==='inventory'?'btn-primary':'btn-outline'}`} style={typeFilter==='inventory'?{background:'#7c3aed',borderColor:'#7c3aed',color:'#fff'}:{borderColor:'#ddd6fe',color:'#6d28d9'}} onClick={()=>setTypeFilter('inventory')}>
      Inventarizatsiya ({invCount})
    </button>
  </div>
  <BatchCalendar month={calMonth} setMonth={setCalMonth} batchDates={batchDatesSet} selectedDate={selectedDate} onDateClick={handleDateClick}/>
  {selectedDate&&<div className="batch-date-filter"><Calendar size={15}/><span>{formatUzDate(selectedDate, { day: true, month: 'long', year: true })} — {displayRows.length} ta yozuv</span><button className="btn" onClick={()=>setSelectedDate(null)}><X size={14}/>Tozalash</button></div>}
  <div className="mobile-search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Partiya yoki invoice raqami, ta'minotchi..."/></div>
  {loading?<div className="inventory-state">Yuklanmoqda…</div>:error?<ErrorState message={error} retry={load}/>:displayRows.length===0?<Empty title={selectedDate?"Bu kunda partiya yoki inventarizatsiya yo‘q":"Hech narsa topilmadi"} text={selectedDate?"Boshqa kunni tanlang yoki filtrni tozalang.":"Yangi partiya yoki inventarizatsiya yarating."}/>:<div className="batch-list">{displayRows.map(x=>{
    const isInv=isInventoryReceipt(x.receipt_no);
    return <article className="card" key={x.id} style={isInv?{borderLeft:'4px solid #7c3aed'}:{borderLeft:'4px solid var(--orange)'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <span className={'batch-origin '+(isInv?'batch-origin-inventory':'batch-origin-batch')} style={isInv?{background:'#f3e8ff',color:'#6b21a8',border:'1px solid #d8b4fe'}:{}}>
          {isInv?'Inventarizatsiya':'Partiya'}
        </span>
        <Status type={x.payment_status==='paid'?'green':'orange'}>{x.payment_status==='paid'?'To‘langan':x.payment_status==='partial'?'Qisman':'To‘lanmagan'}</Status>
      </div>
      <div className="batch-top">
        <div className="batch-icon" style={isInv?{background:'#f3e8ff',color:'#7c3aed'}:{}}><PackagePlus/></div>
        <div><b>{x.receipt_no}</b><span>{x.supplier_name||(isInv?'Inventarizatsiya ro‘yxati':'Ta’minotchi ko‘rsatilmagan')}</span></div>
      </div>
      <div className="batch-meta">
        <span><Clock3/>{new Date(x.received_at).toLocaleDateString('uz-UZ')}</span>
        <span><Boxes/>{Number(x.unit_count)} dona</span>
        <span><QrCode/>{x.line_count} tur QR</span>
      </div>
      <div className="between small" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8,paddingTop:8,borderTop:'1px solid var(--line,#f1f5f9)',flexWrap:'wrap',gap:8}}>
        <span>{x.line_count} xil tovar · Tan: <DualPrice value={Number(x.total_cost||0)} rate={rate}/> · Sotish: <DualPrice value={Number(x.total_retail||0)} rate={rate}/></span>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,display:'inline-flex',alignItems:'center',gap:4,height:28}} title="Zahiraga yuklab olish (JSON)" disabled={exportingId===x.id} onClick={()=>handleExportSingle(x.id,x.receipt_no)}>
            <Download size={13}/>{exportingId===x.id?'…':'Zahira'}
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,display:'inline-flex',alignItems:'center',gap:4,height:28}} title="Tahrirlash" onClick={()=>open(x.id,true)}>
            <Pencil size={13}/>Tahrirlash
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,color:'#ef4444',borderColor:'#fecaca',background:'#fff5f5',display:'inline-flex',alignItems:'center',gap:4,height:28}} title="O‘chirish" disabled={deletingId===x.id} onClick={()=>deleteBatch(x.id,x.receipt_no)}>
            <Trash2 size={13}/>{deletingId===x.id?'O‘chirilmoqda…':'O‘chirish'}
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 10px',fontSize:12,display:'inline-flex',alignItems:'center',gap:4,height:28}} onClick={()=>open(x.id,false)}>
            Batafsil <ChevronRight size={14}/>
          </button>
        </div>
      </div>
    </article>;
  })}</div>}
  <ReceiptDetail receipt={detail} initialEditing={detailEdit} close={()=>{setDetail(null);setDetailEdit(false);}} onUpdated={()=>{setDetail(null);setDetailEdit(false);load();}} onExportSingle={handleExportSingle}/>
  {passwordModal && (
    <Modal open={Boolean(passwordModal)} onClose={() => setPasswordModal(null)} title="Sotilgan tovarlar mavjud — Parol talab qilinadi">
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!passwordModal.password?.trim()) return;
          deleteBatch(passwordModal.id, passwordModal.receiptNo, passwordModal.password.trim());
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertTriangle size={20} color="#ea580c" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: '#9a3412', lineHeight: 1.5 }}>
            <b>"{passwordModal.receiptNo}"</b> partiyasidan sotilgan tovarlar bor!
            <br />
            Ushbu partiyani va barcha bog‘liq birliklarni butunlay o‘chirish uchun tasdiqlash parolini kiriting.
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Tasdiqlash paroli:
          </label>
          <input
            type="password"
            autoFocus
            className="input"
            style={{ width: '100%', padding: '8px 12px', fontSize: 14 }}
            placeholder="Parolni kiriting..."
            value={passwordModal.password || ''}
            onChange={e => setPasswordModal(prev => ({ ...prev, password: e.target.value, error: '' }))}
          />
        </div>

        {passwordModal.error && (
          <div style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: '8px 12px', borderRadius: 6, border: '1px solid #fecaca' }}>
            {passwordModal.error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setPasswordModal(null)}
            disabled={deletingId === passwordModal.id}
          >
            Bekor qilish
          </button>
          <button
            type="submit"
            className="btn"
            style={{ background: '#dc2626', color: '#fff', borderColor: '#dc2626' }}
            disabled={!passwordModal.password?.trim() || deletingId === passwordModal.id}
          >
            <Trash2 size={15} />
            {deletingId === passwordModal.id ? 'O‘chirilmoqda…' : 'O‘chirish'}
          </button>
        </div>
      </form>
    </Modal>
  )}
  <BatchBackupRestoreModal
    open={restoreModalOpen}
    onClose={()=>setRestoreModalOpen(false)}
    branchId={branchId}
    onRestored={()=>{load();toast?.('Partiyalar va tovarlar muvaffaqiyatli tiklandi');}}
    toast={toast}
  />
  </>;
}
function BatchCalendar({month,setMonth,batchDates,selectedDate,onDateClick}){
  const year=month.getFullYear(),mo=month.getMonth();
  const firstDay=new Date(year,mo,1).getDay();
  const daysInMonth=new Date(year,mo+1,0).getDate();
  const today=new Date();
  const weeks=[];let day=1-firstDay;
  for(let w=0;w<6;w++){const week=[];for(let d=0;d<7;d++,day++){week.push(day<1||day>daysInMonth?null:day)}weeks.push(week);if(day>daysInMonth)break}
  const prevMonth=()=>setMonth(new Date(year,mo-1,1));
  const nextMonth=()=>setMonth(new Date(year,mo+1,1));
  const monthName=getUzMonthName(month, { withYear: true });
  return <div className="batch-calendar card"><div className="batch-cal-header"><button className="btn" onClick={prevMonth}><ChevronLeft size={16}/></button><b>{monthName}</b><button className="btn" onClick={nextMonth}><ChevronRight size={16}/></button></div><div className="batch-cal-grid"><span className="cal-weekday">Ya</span><span className="cal-weekday">Du</span><span className="cal-weekday">Se</span><span className="cal-weekday">Ch</span><span className="cal-weekday">Pa</span><span className="cal-weekday">Ju</span><span className="cal-weekday">Sh</span>{weeks.flat().map((d,i)=>{if(d===null)return <span key={i} className="cal-day empty"/>;const key=`${year}-${mo}-${d}`;const hasBatch=batchDates.has(key);const isSelected=selectedDate&&selectedDate.getFullYear()===year&&selectedDate.getMonth()===mo&&selectedDate.getDate()===d;const isToday=today.getFullYear()===year&&today.getMonth()===mo&&today.getDate()===d;let cls='cal-day';if(hasBatch)cls+=' has-batch';if(isSelected)cls+=' selected';if(isToday)cls+=' today';return <button key={i} className={cls} onClick={()=>onDateClick(new Date(year,mo,d))}>{d}</button>})}</div></div>;
}
export function InventoryStock({branchId,onScan,onRegister,toast}){
  const rate=useExchangeRate();
  const[rows,setRows]=useState([]),[totalRows,setTotalRows]=useState(0),[aggregates,setAggregates]=useState({totalOnHand:0,totalValue:0,totalCost:0}),[refs,setRefs]=useState({locations:[],categories:[],brands:[]}),[colors,setColors]=useState([]),[form,setForm]=useState({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''}),[applied,setApplied]=useState({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''}),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(50),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selectedProduct,setSelectedProduct]=useState(null),[editingProduct,setEditingProduct]=useState(null),[selected,setSelected]=useState([]);
  const[importModal,setImportModal]=useState(false);
  useEffect(()=>{if(branchId){getInventoryReferences(branchId).then(r=>setRefs(prev=>({...prev,...r}))).catch(e=>setError(err(e)));getBrowserClient().from('categories').select('id,name,parent_id').eq('is_active',true).then(({data})=>setRefs(prev=>({...prev,categories:data||[]}))).catch(()=>{});getBrowserClient().from('product_variants').select('product_id,color_name,color_hex').eq('is_active',true).then(({data})=>setColors(data||[])).catch(()=>{})}},[branchId]);
  const load=async()=>{
    if(!branchId)return;
    setLoading(true);
    setError('');
    try{
      const r=await listInventoryBalances({branchId,locationId:applied.location||null,query:applied.query||null,categoryId:applied.category||null,minPrice:applied.minPrice||null,maxPrice:applied.maxPrice||null,availability:applied.availability||null,page,pageSize});
      let items=r.items||[];
      if(applied.color){
        const productIdsWithColor=new Set(colors.filter(v=>v.color_name===applied.color).map(v=>v.product_id));
        items=items.filter(i=>productIdsWithColor.has(i.product_id));
      }
      setRows(items);
      setTotalRows(Number(r.total)||items.length);
      setAggregates({
        totalOnHand: Number(r.total_on_hand ?? 0),
        totalValue: Number(r.total_value ?? 0),
        totalCost: Number(r.total_cost ?? 0)
      });
    }catch(e){
      setError(err(e));
    }finally{
      setLoading(false);
    }
  };
  useEffect(()=>{load()},[branchId,applied,page,pageSize]);
  const apply=e=>{e?.preventDefault();setPage(1);setApplied({...form})};
  const reset=()=>{setForm({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''});setApplied({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''});setPage(1)};
  const distinctColors=useMemo(()=>{const seen=new Map();colors.forEach(v=>{if(!seen.has(v.color_name))seen.set(v.color_name,v.color_hex)});return[...seen.entries()].map(([color_name,color_hex])=>({color_name,color_hex})).sort((a,b)=>a.color_name.localeCompare(b.color_name))},[colors]);
  const toggle=id=>setSelected(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
  const allSelected=rows.length>0&&rows.every(r=>selected.includes(r.product_id));
  const toggleAll=()=>setSelected(allSelected?[]:[...new Set(rows.map(r=>r.product_id))]);
  const selectAllFiltered=async()=>{
    try{
      setLoading(true);
      const client=getBrowserClient();
      let q=client.from('products').select('id').neq('status','archived');
      if(applied.category){
        const subCats=(refs.categories||[]).filter(c=>c.parent_id===applied.category).map(c=>c.id);
        q=q.in('category_id',[applied.category,...subCats]);
      }
      if(applied.query){
        q=q.or(`name.ilike.%${applied.query}%,sku.ilike.%${applied.query}%`);
      }
      const{data,error:qErr}=await q;
      if(qErr)throw qErr;
      setSelected((data||[]).map(p=>p.id));
    }catch(e){
      setError(err(e));
    }finally{
      setLoading(false);
    }
  };
  const bulkDelete=async()=>{
    if(!selected.length||!confirm(`${selected.length} ta mahsulotni butunlay o‘chirishni tasdiqlaysizmi?\n\nDIQQAT: Ushbu mahsulotlar va ularning ombordagi barcha birliklari o‘chiriladi. Bu amalni qaytarib bo‘lmaydi!`))return;
    setLoading(true);
    try{
      const{error:rpcErr}=await getBrowserClient().rpc('delete_products_cascade',{p_product_ids:selected});
      if(rpcErr){
        for(const id of selected){
          await getBrowserClient().rpc('delete_product_cascade',{p_product_id:id});
        }
      }
      setSelected([]);
      await load();
    }catch(e){
      setError(err(e));
      setLoading(false);
    }
  };
  const activeCategory=(refs.categories||[]).find(c=>c.id===(applied.category||form.category));
  const deleteActiveCategory=async()=>{
    const catId=applied.category||form.category;
    if(!catId||!activeCategory)return;
    const client=getBrowserClient();
    const subCats=(refs.categories||[]).filter(c=>c.parent_id===catId).map(c=>c.id);
    const catIds=[catId,...subCats];
    const{count,error:cErr}=await client.from('products').select('id',{count:'exact',head:true}).in('category_id',catIds);
    const prodCount=count||0;
    if(prodCount===0){
      alert(`“${activeCategory.name}” kategoriyasida tovar topilmadi.`);
      return;
    }
    if(!confirm(`DIQQAT!\n\n“${activeCategory.name}” kategoriyasidagi BARCHA (${prodCount} ta) tovarlarni butunlay o‘chirishni tasdiqlaysizmi?\n\nBu amal ushbu tovarlar, ombor qoldiqlari va seriyalarini butunlay o‘chiradi va uni qaytarib bo‘lmaydi!`))return;

    setLoading(true);
    try{
      const{error:rpcErr}=await client.rpc('delete_category_products_cascade',{p_category_id:catId,p_include_children:true});
      if(rpcErr)throw rpcErr;
      setSelected([]);
      await load();
    }catch(e){
      try{
        const{data:prods}=await client.from('products').select('id').in('category_id',catIds);
        for(const p of(prods||[])){
          await client.rpc('delete_product_cascade',{p_product_id:p.id});
        }
        setSelected([]);
        await load();
      }catch(err2){
        setError(err(err2||e));
        setLoading(false);
      }
    }
  };
  const deleteProduct=async item=>{if(!confirm(item.product_name+" mahsulotini o'chirasizmi?"))return;try{const{error:e2}=await getBrowserClient().rpc('delete_product_cascade',{p_product_id:item.product_id});if(e2)throw e2;setRows(prev=>prev.filter(r=>r.product_id!==item.product_id))}catch(e){setError(err(e))}};
  const parents=(refs.categories||[]).filter(c=>!c.parent_id);
  return <><div className="m-page-head between"><div><h2>Tovarlar</h2><p>Filial do'kon va ombor qoldig'i</p></div><div style={{display:'flex',gap:8,alignItems:'center'}}><button type="button" className="btn btn-outline" onClick={()=>setImportModal(true)}><FileSpreadsheet size={16}/>Exceldan import qilish</button><button className="btn btn-primary" onClick={onRegister}><Plus/>Tovar qo'shish</button><button className="btn" onClick={onScan}><QrCode/>QR</button></div></div>
  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:14}}>
    <div className="card" style={{padding:14,textAlign:'center'}}><Boxes size={18}/><div><b style={{fontSize:18}}>{totalRows || 0} ta</b><br/><small style={{color:'var(--muted)'}}>Tovar turlari (jami)</small></div></div>
    <div className="card" style={{padding:14,textAlign:'center'}}><Warehouse size={18}/><div><b style={{fontSize:18}}>{aggregates.totalOnHand} dona</b><br/><small style={{color:'var(--muted)'}}>Mavjud qoldiq</small></div></div>
    <div className="card" style={{padding:14,textAlign:'center'}}><Boxes size={18}/><div><b style={{fontSize:18}}><DualPrice value={aggregates.totalValue} rate={rate}/></b><br/><small style={{color:'var(--muted)'}}>Sotish narxi</small></div></div>
    <div className="card" style={{padding:14,textAlign:'center'}}><Warehouse size={18}/><div><b style={{fontSize:18}}><DualPrice value={aggregates.totalCost} rate={rate}/></b><br/><small style={{color:'var(--muted)'}}>Tannarxi</small></div></div>
  </div>
  <div className="card" style={{padding:14}}>
    <form style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap',alignItems:'flex-end'}} onSubmit={apply}>
      <label style={{flex:'2 1 200px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Qidiruv</small><div style={{display:'flex',alignItems:'center',gap:8,border:'1px solid var(--line)',borderRadius:10,padding:'0 10px',height:38}}><Search size={15}/><input style={{border:0,outline:0,flex:1,minWidth:0}} value={form.query} onChange={e=>setForm({...form,query:e.target.value})} placeholder="Mahsulot, SKU"/></div></label>
      <label style={{flex:'1 1 140px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Joylashuv</small><select className="select" style={{height:38}} value={form.location} onChange={e=>setForm({...form,location:e.target.value})}><option value="">Barchasi</option>{refs.locations?.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label style={{flex:'1 1 140px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Kategoriya</small><select className="select" style={{height:38}} value={form.category} onChange={e=>setForm({...form,category:e.target.value})}><option value="">Barchasi</option>{parents.map(p=><optgroup key={p.id} label={p.name}><option value={p.id}>{p.name}</option>{(refs.categories||[]).filter(c=>c.parent_id===p.id).map(ch=><option key={ch.id} value={ch.id}>&nbsp;{ch.name}</option>)}</optgroup>)}</select></label>
      <label style={{flex:'1 1 130px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Rang</small><select className="select" style={{height:38}} value={form.color} onChange={e=>setForm({...form,color:e.target.value})}><option value="">Barchasi</option>{distinctColors.map(c=><option key={c.color_name} value={c.color_name}>{c.color_name}</option>)}</select></label>
      <label style={{flex:'0 1 100px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Min narx</small><input className="input" type="number" min="0" style={{height:38}} value={form.minPrice} onChange={e=>setForm({...form,minPrice:e.target.value})} placeholder="0"/></label>
      <label style={{flex:'0 1 100px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Max narx</small><input className="input" type="number" min="0" style={{height:38}} value={form.maxPrice} onChange={e=>setForm({...form,maxPrice:e.target.value})} placeholder="~"/></label>
      <label style={{flex:'1 1 120px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Mavjudlik</small><select className="select" style={{height:38}} value={form.availability} onChange={e=>setForm({...form,availability:e.target.value})}><option value="">Barchasi</option><option value="available">Mavjud (&gt;0)</option><option value="empty">Tugagan (0)</option></select></label>
      <button className="btn btn-primary" style={{height:38}}>Qidirish</button>
      <button type="button" className="btn" style={{height:38}} onClick={reset}>Tozalash</button>
    </form>
    {activeCategory&&(
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'8px 12px',marginBottom:10,background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:10,fontSize:12,color:'#9a3412',flexWrap:'wrap'}}>
        <span>Kategoriya: <b>{activeCategory.name}</b> ({totalRows} ta mahsulot)</span>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <button type="button" className="btn" style={{padding:'5px 10px',fontSize:11}} onClick={selectAllFiltered}>Ushbu kategoriyani to‘liq tanlash</button>
          <button type="button" className="btn" style={{background:'#fee2e2',color:'#b91c1c',borderColor:'#fecaca',padding:'5px 10px',fontSize:11}} onClick={deleteActiveCategory}>
            <Trash2 size={13}/> Kategoriyadagi barcha tovarlarni o‘chirish
          </button>
        </div>
      </div>
    )}
    {selected.length>0&&(
      <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 12px',marginBottom:10,background:'#fef2f2',borderRadius:10,flexWrap:'wrap'}}>
        <b style={{fontSize:12}}>
          {selected.length === totalRows && totalRows > rows.length 
            ? `Barcha ${totalRows} ta mahsulot tanlangan`
            : `${selected.length} ta tanlangan ${selected.length === rows.length && totalRows > rows.length ? '(ushbu sahifada)' : ''}`}
        </b>
        {selected.length === rows.length && totalRows > rows.length && (
          <button 
            type="button" 
            className="btn btn-outline" 
            style={{padding:'4px 10px',fontSize:11,background:'#fff',border:'1px solid #fed7aa',color:'#c2410c'}} 
            onClick={selectAllFiltered}
          >
            Barcha {totalRows} ta tovarni tanlash
          </button>
        )}
        <button className="btn" style={{background:'#fee2e2',color:'#b91c1c',borderColor:'#fecaca',padding:'6px 14px',fontSize:11}} onClick={bulkDelete}>
          <Trash2 size={13}/> Tanlanganlarni o‘chirish
        </button>
        <button className="btn" style={{padding:'6px 14px',fontSize:11}} onClick={()=>setSelected([])}>
          Bekor
        </button>
      </div>
    )}
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
      <span style={{fontSize:13,color:'var(--muted)'}}>
        Jami: <b>{totalRows}</b> ta mahsulot {totalRows > pageSize ? `(${page}-sahifa, ${Math.ceil(totalRows/pageSize)} ta sahifadan)` : ''}
      </span>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span style={{fontSize:12,color:'var(--muted)'}}>Har sahifada:</span>
        <select 
          className="select" 
          style={{height:28,padding:'2px 8px',fontSize:12}}
          value={pageSize} 
          onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
        >
          <option value={50}>50 tadan</option>
          <option value={100}>100 tadan</option>
          <option value={200}>200 tadan</option>
          <option value={500}>500 tadan</option>
        </select>
      </div>
    </div>
    {loading?<div className="ops-state">Tovarlar yuklanmoqda…</div>:error?<ErrorState message={error} retry={load}/>:rows.length===0?<Empty title="Tovar topilmadi" text="Partiya qabul qiling yoki filtrni o'zgartiring."/>:<><div className="table-wrap"><table className="table"><thead><tr><th><input type="checkbox" checked={allSelected} onChange={toggleAll}/></th><th>Mahsulot</th><th>Filial</th><th>Joylashuv</th><th>Turi</th><th>Jami</th><th>Mavjud</th><th>Sotish narxi</th><th>Tannarxi</th><th>Amal</th></tr></thead><tbody>{rows.map(item=><tr key={`${item.location_id}-${item.product_id}`} style={{cursor:'pointer',background:selected.includes(item.product_id)?'rgba(249,115,22,0.08)':'inherit'}} onClick={()=>setSelectedProduct(item)}><td onClick={e=>e.stopPropagation()}><input type="checkbox" checked={selected.includes(item.product_id)} onChange={()=>toggle(item.product_id)}/></td><td><div style={{display:'flex',alignItems:'center',gap:10}}>{item.image?<img src={item.image} alt="" style={{width:36,height:36,borderRadius:8,objectFit:'cover'}}/>:<span style={{width:36,height:36,borderRadius:8,background:'#f1f5f9',display:'grid',placeItems:'center'}}><Boxes size={16}/></span>}<div><b>{item.product_name}</b><br/><small style={{color:'var(--muted)'}}>{item.sku}</small></div></div></td><td>{item.branch_name}</td><td>{item.location_name}</td><td><Status type={item.location_type==='warehouse'?'blue':'green'}>{item.location_type}</Status></td><td><b>{Number(item.on_hand)}</b></td><td><b>{Number(item.available)}</b></td><td><DualPrice value={Number(item.on_hand)*Number(item.retail_price)} rate={rate}/></td><td><DualPrice value={Number(item.on_hand)*Number(item.cost_price||0)} rate={rate}/></td><td><div style={{display:'flex',gap:6}} onClick={e=>e.stopPropagation()}><button className="btn" style={{padding:'5px 8px'}} title="Tahrirlash" onClick={()=>setEditingProduct(item)}><Pencil size={13}/></button><button className="btn" style={{padding:'5px 8px'}} title="O‘chirish" onClick={()=>deleteProduct(item)}><Trash2 size={13}/></button></div></td></tr>)}</tbody></table></div>
    {totalRows>pageSize&&<div className="pagination" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14}}><span>{totalRows?`${(page-1)*pageSize+1}–${Math.min(page*pageSize,totalRows)} / ${totalRows} ta`:'0 ta'}</span><div style={{display:'flex',gap:6}}><button className="btn btn-sm" disabled={page===1} onClick={()=>setPage(x=>x-1)}>‹ Oldingi</button><button className="btn btn-sm active" style={{fontWeight:700}}>{page} / {Math.ceil(totalRows/pageSize)}</button><button className="btn btn-sm" disabled={page>=Math.ceil(totalRows/pageSize)} onClick={()=>setPage(x=>x+1)}>Keyingi ›</button></div></div>}</>}
  </div>

  {editingProduct&&<ProductEditor open={Boolean(editingProduct)} close={()=>setEditingProduct(null)} product={editingProduct} refs={refs} toast={toast} saved={load} RichTextEditor={RichTextEditor}/>}
  {selectedProduct&&<ProductDetailModal product={selectedProduct} close={()=>setSelectedProduct(null)} branchId={branchId} rate={rate} onEdit={setEditingProduct}/>}
  <ProductExcelImportModal open={importModal} onClose={()=>setImportModal(false)} onImported={load} branchId={branchId}/>
  </>;
}
function ProductDetailModal({product,close,branchId,rate,onEdit}){
  const[detail,setDetail]=useState(null),[units,setUnits]=useState([]),[media,setMedia]=useState([]),[variants,setVariants]=useState([]),[loading,setLoading]=useState(true),[filterLocation,setFilterLocation]=useState(''),[filterStatus,setFilterStatus]=useState(''),[filterColor,setFilterColor]=useState(''),[unitQuery,setUnitQuery]=useState(''),[editDesc,setEditDesc]=useState(false),[desc,setDesc]=useState(''),[videoUrl,setVideoUrl]=useState(''),[uploading,setUploading]=useState(false);
  useEffect(()=>{loadDetail()},[product]);
  const loadDetail=async()=>{setLoading(true);try{const client=getBrowserClient();const{data:p}=await client.from('products').select('*,categories(name),brands(name)').eq('id',product.product_id).single();const{data:u}=await client.from('inventory_units').select('id,qr_code,serial_number,status,location_id,variant_id,locations(name,type,branch_id)').eq('product_id',product.product_id).order('created_at',{ascending:false}).limit(500);const{data:m}=await client.from('product_media').select('*').eq('product_id',product.product_id).order('is_primary',{ascending:false}).order('sort_order');const{data:v}=await client.from('product_variants').select('id,color_name,color_hex').eq('product_id',product.product_id);setDetail(p);setUnits((u||[]).filter(x=>x.locations?.branch_id===branchId));setMedia(m||[]);setVariants(v||[]);setDesc(p?.description||'');setVideoUrl(p?.seo_image_url||'')}catch(e){}finally{setLoading(false)}};
  const colorById=Object.fromEntries(variants.map(v=>[v.id,v.color_name]));
  const locations=[...new Set(units.map(u=>u.locations?.name).filter(Boolean))];
  const queryLower=unitQuery.trim().toLowerCase();
  const filteredUnits=units.filter(u=>{
    if(filterLocation&&u.locations?.name!==filterLocation)return false;
    if(filterStatus&&u.status!==filterStatus)return false;
    if(filterColor&&colorById[u.variant_id]!==filterColor)return false;
    if(queryLower&&![u.qr_code,u.serial_number,u.locations?.name].some(v=>String(v||'').toLowerCase().includes(queryLower)))return false;
    return true;
  });
  const locationSummary=locations.map(n=>({name:n,count:units.filter(u=>u.locations?.name===n).length,type:units.find(u=>u.locations?.name===n)?.locations?.type}));
  const statusCounts=units.reduce((acc,u)=>{acc[u.status]=(acc[u.status]||0)+1;return acc},{});
  const colorCounts=variants.map(v=>({...v,count:units.filter(u=>u.variant_id===v.id).length})).filter(v=>v.count>0);
  const statusLabels={available:'Sotuvga tayyor',reserved:'Band',sold:'Sotilgan',in_transit:"Yo'lda",returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:"Ta'mirda"};
  const downloadQR=async(unit)=>{const QRCode=await import('qrcode');const url=(import.meta.env.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app')+'/qr/'+encodeURIComponent(unit.qr_code);const qrCanvas=await QRCode.toCanvas(url,{width:220,margin:2,errorCorrectionLevel:'L'});const W=300,H=420;const labeled=document.createElement('canvas');labeled.width=W;labeled.height=H;const ctx=labeled.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);ctx.strokeStyle='#ddd';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(8,8,W-16,H-16);ctx.drawImage(qrCanvas,(W-220)/2,30);const price=detail?.retail_price?formatDualMoney(Number(detail.retail_price),rate):formatMoney(0);ctx.fillStyle='#000';ctx.font='bold 15px sans-serif';ctx.textAlign='center';const name=detail?.name||'';const colorName=colorById[unit.variant_id]||'';let y=290;if(name.length>28){ctx.fillText(name.slice(0,28),W/2,280);ctx.fillText(name.slice(28,56),W/2,298);y=298}else{ctx.fillText(name,W/2,290)};if(colorName){y+=18;ctx.font='bold 12px sans-serif';ctx.fillStyle='#a86b00';ctx.fillText('Rang: '+colorName,W/2,y);ctx.fillStyle='#000'};ctx.font='bold 22px sans-serif';ctx.fillText(price,W/2,y+32);ctx.font='11px sans-serif';ctx.fillStyle='#666';ctx.fillText(unit.qr_code||'',W/2,y+62);ctx.fillText(unit.serial_number||'',W/2,y+80);const link=document.createElement('a');link.download=(unit.qr_code||'qr')+'.png';link.href=labeled.toDataURL();link.click()};
  const saveDesc=async()=>{try{const{updateProductTextFields}=await import('@texnobazar/data');await updateProductTextFields(product.product_id,{description:desc});setEditDesc(false);if(toast)toast('Tavsif saqlandi')}catch(e){alert(e.message)}};
  const saveVideo=async()=>{try{const{updateProductTextFields}=await import('@texnobazar/data');await updateProductTextFields(product.product_id,{seoImageUrl:videoUrl});if(toast)toast('Video URL saqlandi')}catch(e){alert(e.message)}};
  const uploadImage=async(e)=>{const files=[...e.target.files];if(!files.length)return;setUploading(true);try{const{uploadProductMedia}=await import('@texnobazar/data');for(const file of files)await uploadProductMedia(product.product_id,file,detail?.name||'');await loadDetail();if(toast)toast('Rasm yuklandi')}catch(er){alert(er.message)}finally{setUploading(false);e.target.value=''}};
  if(loading)return <Modal open onClose={close} title="Yuklanmoqda..."><div className="ops-state">Yuklanmoqda…</div></Modal>;if(!detail)return null;
  return <Modal open onClose={close} wide title={detail.name+' ('+units.length+' dona filialda)'}><div style={{display:'flex',flexDirection:'column',gap:14}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap'}}><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(130px, 1fr))',gap:8,flex:1}}><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>SKU</small><b>{detail.sku}</b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Kategoriya</small><b>{detail.categories?.name||'-'}</b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Brend</small><b>{detail.brands?.name||'-'}</b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Sotish narxi</small><b><DualPrice value={Number(detail.retail_price)} rate={rate}/></b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Tannarx</small><b><DualPrice value={Number(detail.cost_price)} rate={rate}/></b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Filialda jami</small><b>{units.length} dona</b></span></div><button type="button" className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6,height:38}} onClick={()=>{close();onEdit?.(product);}}><Pencil size={14}/> Tovarni to‘liq tahrirlash</button></div>
  <h4 style={{margin:0}}>Joylashuv bo’yicha</h4>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
  <button className={filterLocation===''?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterLocation('')}>Barcha joy <b>{units.length}</b></button>
  {locationSummary.map(l=><button key={l.name} className={filterLocation===l.name?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterLocation(filterLocation===l.name?'':l.name)}>{l.type==='warehouse'?'Omborda':'Do\'konda'} <b>{l.count}</b></button>)}
  </div>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:4}}>
  <button className={filterStatus===''?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterStatus('')}>Barcha status <b>{units.length}</b></button>
  {Object.entries(statusCounts).map(([status,count])=><button key={status} className={filterStatus===status?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterStatus(filterStatus===status?'':status)}>{statusLabels[status]||status} <b>{count}</b></button>)}
  </div>
  {colorCounts.length>0&&<><h4 style={{margin:0}}>Rang bo’yicha</h4><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
  <button className={filterColor===''?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterColor('')}>Barcha rang <b>{units.length}</b></button>
  {colorCounts.map(c=><button key={c.id} className={filterColor===c.color_name?'btn btn-primary':'btn'} style={{fontSize:11,display:'inline-flex',alignItems:'center',gap:5}} onClick={()=>setFilterColor(filterColor===c.color_name?'':c.color_name)}><span style={{width:11,height:11,borderRadius:'50%',background:c.color_hex||'#ccc',border:'1px solid rgba(0,0,0,.15)',display:'inline-block'}}/>{c.color_name} <b>{c.count}</b></button>)}
  </div></>}
  <div style={{position:'relative',marginTop:6}}><Search size={15} style={{position:'absolute',left:10,top:10,color:'var(--muted)'}}/><input className="input" style={{paddingLeft:32}} value={unitQuery} onChange={e=>setUnitQuery(e.target.value)} placeholder="QR kod, seriya yoki joy bo’yicha qidirish"/></div>
  <h4 style={{margin:0}}>Birliklar ({filteredUnits.length}) — QR yuklab olish</h4><div style={{maxHeight:260,overflow:'auto'}}><table className="table"><thead><tr><th>QR kod</th><th>Seriya</th>{colorCounts.length>0&&<th>Rang</th>}<th>Joy</th><th>Status</th><th>QR</th></tr></thead><tbody>{filteredUnits.map(u=><tr key={u.id}><td><code style={{fontSize:10}}>{u.qr_code}</code></td><td>{u.serial_number||'—'}</td>{colorCounts.length>0&&<td>{colorById[u.variant_id]||'—'}</td>}<td>{u.locations?.name}</td><td><Status type={u.status==='available'?'green':u.status==='sold'?'blue':'orange'}>{u.status}</Status></td><td><button className="btn" style={{padding:'4px 8px'}} onClick={()=>downloadQR(u)}><Download size={13}/></button></td></tr>)}</tbody></table></div>
  {media.length>0&&<><h4 style={{margin:0}}>Rasmlar ({media.length})</h4><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{media.map(m=><img key={m.id} src={m.public_url} alt="" style={{width:56,height:56,borderRadius:8,objectFit:'cover'}}/>)}</div></>}
  <label className="btn btn-outline" style={{alignSelf:'flex-start',fontSize:12}}><Upload size={14}/> {uploading?'Yuklanmoqda…':'Rasm yuklash'}<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={uploadImage} disabled={uploading}/></label>
  <h4 style={{margin:0}}>Video (YouTube)</h4><div style={{display:'flex',gap:8}}><input className="input" value={videoUrl} onChange={e=>setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."/><button className="btn btn-primary" style={{whiteSpace:'nowrap'}} onClick={saveVideo}>Saqlash</button></div>
  <h4 style={{margin:0}}>Tavsif</h4>{editDesc?<><RichTextEditor value={desc} onChange={v=>setDesc(v)}/><div style={{display:'flex',gap:8}}><button className="btn btn-primary" onClick={saveDesc}>Saqlash</button><button className="btn" onClick={()=>setEditDesc(false)}>Bekor</button></div></>:<><div style={{color:'var(--muted)',margin:0}} dangerouslySetInnerHTML={{__html:desc||'Tavsif kiritilmagan'}}/><button className="btn" style={{alignSelf:'flex-start',fontSize:12}} onClick={()=>setEditDesc(true)}>Tahrirlash</button></>}
  </div></Modal>;
}

function ErrorState({message,retry}){return <div className="inventory-error"><AlertTriangle/><b>Xatolik</b><p>{message}</p><div style={{display:'flex',gap:8,justifyContent:'center',marginTop:8}}><button className="btn btn-primary" onClick={retry}>Qayta urinish (Ro‘yxatni ko‘rish)</button></div></div>}

function BatchBackupRestoreModal({ open, onClose, branchId, onRestored, toast }) {
  const [file, setFile] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspected, setInspected] = useState(null);
  const [inspectError, setInspectError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState(null);
  const [restoreSuccess, setRestoreSuccess] = useState(null);

  const reset = () => {
    setFile(null);
    setInspecting(false);
    setInspected(null);
    setInspectError('');
    setRestoring(false);
    setProgress(null);
    setRestoreSuccess(null);
  };

  const handleClose = () => {
    if (restoring) return;
    reset();
    onClose();
  };

  const handleFileChange = async (selectedFile) => {
    if (!selectedFile) return;
    reset();
    setFile(selectedFile);
    setInspecting(true);
    try {
      const info = await inspectBatchesBackupFile(selectedFile);
      setInspected(info);
    } catch (e) {
      setInspectError(e.message || 'Faylni tahlil qilib bo‘lmadi');
    } finally {
      setInspecting(false);
    }
  };

  const handleStartRestore = async () => {
    if (!file || !inspected) return;
    setRestoring(true);
    setInspectError('');
    try {
      const res = await restoreBatchesBackupFile(file, {
        onProgress: setProgress,
      });
      setRestoreSuccess(res);
      toast?.(`${res.counts?.receipts || inspected.counts.receipts} ta partiya va inventarizatsiya muvaffaqiyatli tiklandi!`);
      setTimeout(() => {
        onRestored?.();
        handleClose();
      }, 1500);
    } catch (e) {
      setInspectError(e.message || 'Tiklashda xatolik yuz berdi');
      setRestoring(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Partiyalar va Inventarizatsiyani tiklash">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted, #64748b)', lineHeight: 1.5 }}>
          Ushbu bo‘lim orqali avval eksport qilingan <b>.json</b> yoki <b>.zip</b> formatidagi zahira fayllaridan o‘chirilgan yoki saqlangan partiyalar, ularning qabul sanalari, narxlari va tovar birliklarini to‘liq qayta tiklashingiz mumkin.
        </p>

        {!inspected && !restoring && !restoreSuccess && (
          <div
            style={{
              border: '2px dashed #cbd5e1',
              borderRadius: 12,
              padding: '28px 16px',
              textAlign: 'center',
              background: '#f8fafc',
              cursor: 'pointer',
              transition: 'border-color 0.2s',
            }}
            onClick={() => document.getElementById('batch-restore-file-input')?.click()}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) handleFileChange(dropped);
            }}
          >
            <input
              id="batch-restore-file-input"
              type="file"
              accept=".json,.zip"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleFileChange(f);
              }}
            />
            <div style={{ display: 'inline-flex', padding: 12, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', marginBottom: 10 }}>
              <UploadCloud size={30} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 4 }}>
              Zahira faylini tanlang yoki shu yerga tashlang
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Qo‘llab-quvvatlanadi: <b>.json</b> (partiyalar zahirasi) va <b>.zip</b> (tizim arxivi)
            </div>
          </div>
        )}

        {inspecting && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted, #64748b)' }}>
            <Loader2 size={24} className="spin" style={{ marginBottom: 8, display: 'inline-block' }} />
            <div>Zahira fayli tahlil qilinmoqda…</div>
          </div>
        )}

        {inspectError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 14px', color: '#dc2626', fontSize: 13, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <b>Xatolik:</b> {inspectError}
            </div>
          </div>
        )}

        {inspected && !restoring && !restoreSuccess && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <b style={{ fontSize: 14, color: '#0f172a' }}>{inspected.fileName}</b>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    Formati: <span style={{ textTransform: 'uppercase', fontWeight: 600 }}>{inspected.fileType}</span>
                    {inspected.exported_at && ` · Eksport sanasi: ${new Date(inspected.exported_at).toLocaleString('uz-UZ')}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={reset}
                >
                  Boshqa fayl
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 12 }}>
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Partiyalar</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{inspected.counts.receipts} ta</div>
                </div>
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Tovar turlari</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{inspected.counts.products || inspected.counts.batches} xil</div>
                </div>
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Birliklar (soni)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{inspected.counts.units} dona</div>
                </div>
              </div>

              {inspected.receiptsList?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                    Fayldagi partiya va inventarizatsiyalar ({inspected.receiptsList.length} ta):
                  </div>
                  <div style={{ maxHeight: 150, overflowY: 'auto', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}>
                    {inspected.receiptsList.slice(0, 20).map((r, idx) => (
                      <div
                        key={r.id || idx}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          borderBottom: idx < inspected.receiptsList.length - 1 ? '1px solid #f1f5f9' : 'none',
                        }}
                      >
                        <b style={{ color: '#1e293b' }}>{r.receipt_no}</b>
                        <span style={{ color: '#64748b' }}>
                          {r.received_at ? new Date(r.received_at).toLocaleDateString('uz-UZ') : '—'}
                        </span>
                      </div>
                    ))}
                    {inspected.receiptsList.length > 20 && (
                      <div style={{ padding: '6px 10px', textAlign: 'center', color: '#64748b', fontSize: 11 }}>
                        ... va yana {inspected.receiptsList.length - 20} ta
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#1e40af', lineHeight: 1.5 }}>
              <b>Eslatma:</b> Tiklash jarayonida fayldagi barcha partiyalar, narxlar va birliklar bazaga kiritiladi. Mavjud yozuvlar yangilanadi, o‘chirilganlari esa qayta tiklanadi.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn btn-outline" onClick={handleClose}>
                Bekor qilish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: '#2563eb', borderColor: '#2563eb' }}
                onClick={handleStartRestore}
              >
                <Upload size={15} style={{ marginRight: 6 }} />
                Tiklashni boshlash
              </button>
            </div>
          </div>
        )}

        {restoring && (
          <div style={{ padding: '24px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Loader2 size={32} className="spin" color="#2563eb" />
            <div>
              <b style={{ fontSize: 15, color: '#0f172a' }}>Ma’lumotlar tiklanmoqda…</b>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                {progress?.message || 'Partiyalar va tovarlar bazaga yozilmoqda…'}
              </div>
            </div>
            <div style={{ width: '100%', height: 6, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden', marginTop: 8 }}>
              <div
                style={{
                  height: '100%',
                  background: '#2563eb',
                  width: `${progress?.percent || 50}%`,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        )}

        {restoreSuccess && (
          <div style={{ padding: '24px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#dcfce7', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <CheckCircle2 size={28} />
            </div>
            <b style={{ fontSize: 16, color: '#15803d' }}>Zahiradan tiklash muvaffaqiyatli yakunlandi!</b>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              Barcha partiyalar, kirimlar va tovar qoldiqlari to‘liq o‘z holatiga keltirildi.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReceiptDetail({receipt,close,onUpdated,initialEditing=false,onExportSingle}){
  const[rate,setRate2]=useState(null);
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate2(Number(r)||null)).catch(()=>{})},[]);
  const[labels,setLabels]=useState([]),[printPending,setPrintPending]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(Boolean(initialEditing)),[editForm,setEditForm]=useState({}),[saving,setSaving]=useState(false),[deleting,setDeleting]=useState(false),[expandedLine,setExpandedLine]=useState(null),[lineUnits,setLineUnits]=useState([]),[lineProduct,setLineProduct]=useState(null),[loadingLine,setLoadingLine]=useState(false),[editingLine,setEditingLine]=useState(false),[linePrices,setLinePrices]=useState({}),[savingLine,setSavingLine]=useState(false);
  const[bluetoothModalOpen,setBluetoothModalOpen]=useState(false);
  const[singlePrintLabel,setSinglePrintLabel]=useState(null);

  useEffect(()=>{
    setLabels([]);setPrintPending(false);document.body.classList.remove('printing-qr-labels');setError('');setEditing(Boolean(initialEditing));
    if(receipt)setEditForm({invoice_number:receipt.invoice_number||'',payment_status:receipt.payment_status||'unpaid',received_at:receipt.received_at?receipt.received_at.split('T')[0]:'',notes:receipt.notes||''});
  },[receipt?.id,initialEditing]);

  const loadLabelsData=async()=>{
    setLoading(true);setError('');
    try{
      const items=[];let page=1,total=1;
      while(items.length<total){
        const result=await listReceiptQrLabels(receipt.id,page,200);
        items.push(...(result.items||[]));
        total=Number(result.total||0);
        page+=1;
        if(!result.items?.length)break;
      }

      // Har bir partiya qatori / tovar va rangi uchun aynan 1 ta umumiy QR kodni kafolatlaymiz
      const groupQrMap = new Map();
      items.forEach(item => {
        const matchedLine = (receipt?.lines || []).find(l => 
          (item.line_no && l.line_no === item.line_no) ||
          (item.product_id && l.product_id === item.product_id && (l.variant_id || null) === (item.variant_id || null)) ||
          (l.product_name === item.product_name && (l.variant_color || null) === (item.variant_color || null))
        );
        const color = String(item.variant_color || item.price_label?.color || matchedLine?.variant_color || '').trim().toLowerCase();
        const lineKey = item.line_no || matchedLine?.line_no || matchedLine?.id || '0';
        const key = `${lineKey}___${item.product_name || matchedLine?.product_name || ''}___${color}`;
        if (!groupQrMap.has(key) && item.qr_code) {
          groupQrMap.set(key, item.qr_code);
        }
      });

      // Har bir partiya qatori (tovar turi va rangi) uchun 1 ta umumiy yorliq (quantity = line.quantity)
      let distinctLabels = [];
      if (receipt?.lines?.length) {
        distinctLabels = receipt.lines.map(line => {
          const color = String(line.variant_color || '').trim().toLowerCase();
          const lineKey = line.line_no || line.id || '0';
          const key = `${lineKey}___${line.product_name || ''}___${color}`;
          const matchingItem = items.find(it => 
            (it.line_no && it.line_no === line.line_no) ||
            (it.product_id && it.product_id === line.product_id && (it.variant_id || null) === (line.variant_id || null)) ||
            (it.product_name === line.product_name && (it.variant_color || null) === (line.variant_color || null))
          );
          const canonicalQr = groupQrMap.get(key) || matchingItem?.qr_code || line.qr_code || '';
          return {
            id: line.id,
            line_no: line.line_no,
            product_id: line.product_id,
            product_name: line.product_name,
            title: matchingItem?.price_label?.title || line.product_name,
            variant_color: line.variant_color || '',
            color: line.variant_color || '',
            quantity: Number(line.quantity) || 1,
            code: canonicalQr,
            qr_code: canonicalQr,
            date: receipt?.received_at ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ'),
          };
        });
      } else {
        const seenKeys = new Set();
        items.forEach(item => {
          const color = String(item.variant_color || item.price_label?.color || '').trim().toLowerCase();
          const lineKey = item.line_no || '0';
          const key = `${lineKey}___${item.product_name || ''}___${color}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const canonicalQr = groupQrMap.get(key) || item.qr_code;
            const sameGroupItems = items.filter(it => {
              const c = String(it.variant_color || it.price_label?.color || '').trim().toLowerCase();
              const lk = it.line_no || '0';
              return `${lk}___${it.product_name || ''}___${c}` === key;
            });
            distinctLabels.push({
              id: item.id,
              line_no: item.line_no,
              product_id: item.product_id,
              product_name: item.product_name,
              title: item.price_label?.title || item.product_name,
              variant_color: item.variant_color || '',
              color: item.variant_color || '',
              quantity: sameGroupItems.length || 1,
              code: canonicalQr,
              qr_code: canonicalQr,
              date: receipt?.received_at ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ'),
            });
          }
        });
      }

      const generated = await Promise.all(distinctLabels.map(async item => ({
        ...item,
        qrImage: await QRCode.toDataURL(
          (import.meta.env.VITE_STOREFRONT_URL || 'https://texnobazar-storefront.netlify.app') + '/qr/' + encodeURIComponent(item.qr_code),
          { width: 480, margin: 2, errorCorrectionLevel: 'L' }
        )
      })));
      setLabels(generated);
      return generated;
    }catch(currentError){
      setError(err(currentError));
      return [];
    }finally{
      setLoading(false);
    }
  };

  const openBluetoothPrint=async(targetLabel=null)=>{
    let currentLabels = labels;
    if(!currentLabels.length){
      currentLabels = await loadLabelsData();
    }
    setSinglePrintLabel(targetLabel);
    if(currentLabels.length || targetLabel){
      setBluetoothModalOpen(true);
    }
  };

  const handleClassicPrint=async()=>{
    if(!labels.length){
      await loadLabelsData();
    }
    setPrintPending(true);
  };

  const prepare = handleClassicPrint;

  useEffect(()=>{
    if(!printPending||!labels.length)return;
    let cancelled=false;
    const print=async()=>{
      const receiptDate = receipt?.received_at 
        ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') 
        : new Date().toLocaleDateString('uz-UZ');

      const escapeHtml = (str) => String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      const pagesHtml = labels.flatMap(x => {
        const count = Math.max(1, Number(x.quantity) || 1);
        const label = x.price_label || {};
        const matchedLine = (receipt?.lines || []).find(l => 
          (x.line_no && l.line_no === x.line_no) ||
          (x.product_id && l.product_id === x.product_id && (l.variant_id || null) === (x.variant_id || null)) ||
          (l.product_name === x.product_name && (l.variant_color || null) === (x.variant_color || null))
        );
        const prodTitle = label.title || x.product_name || matchedLine?.product_name || 'Mahsulot';
        const colorName = label.color || x.variant_color || matchedLine?.variant_color || '';
        const fullTitle = `${prodTitle}${colorName ? ` (${colorName})` : ''}`;
        const code = x.qr_code || label.qr || '';

        const singlePage = `
          <div class="qr-page">
            <div class="qr-img-wrap">
              <img class="qr-img" src="${x.qrImage}" alt="QR" />
            </div>
            <div class="qr-info">
              <div class="qr-title">${escapeHtml(fullTitle)}</div>
              <div class="qr-meta-clean">
                <span class="qr-meta-date-val">Sana: ${escapeHtml(receiptDate)}</span>
                <span class="qr-meta-code-val">${escapeHtml(code)}</span>
              </div>
            </div>
          </div>
        `;
        return Array(count).fill(singlePage);
      }).join('');

      try {
        const oldIframe = document.getElementById('qr-thermal-print-iframe');
        if (oldIframe) oldIframe.remove();

        const iframe = document.createElement('iframe');
        iframe.id = 'qr-thermal-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>QR Yorliqlar</title>
  <style>
    @page {
      size: 40mm 30mm;
      margin: 0 !important;
      padding: 0 !important;
    }
    @media print {
      html, body {
        width: 40mm !important;
        margin: 0 !important;
        padding: 0 !important;
        background: #fff !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      @page {
        size: 40mm 30mm;
        margin: 0 !important;
      }
    }
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 40mm;
      margin: 0;
      padding: 0;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 0;
      line-height: 0;
    }
    .qr-page {
      width: 40mm;
      height: 29.2mm;
      max-width: 40mm;
      max-height: 29.2mm;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      text-align: center;
      overflow: hidden;
      background: #fff;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
      margin: 0;
      padding: 0.5mm 1mm;
      position: relative;
    }
    .qr-page:last-child {
      page-break-after: avoid !important;
      break-after: avoid !important;
    }
    .qr-img-wrap {
      width: 100%;
      height: 18mm;
      max-height: 18mm;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      flex: 0 0 18mm;
    }
    .qr-img {
      width: 18mm;
      height: 18mm;
      max-width: 18mm;
      max-height: 18mm;
      object-fit: contain;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
      display: block;
      margin: 0 auto;
    }
    .qr-info {
      width: 100%;
      max-width: 38mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.2mm;
      margin: 0 auto;
      padding: 0;
    }
    .qr-title {
      font-size: 6.5pt;
      font-weight: 900;
      color: #000;
      line-height: 1.1;
      text-align: center;
      width: 100%;
      max-width: 38mm;
      max-height: 5mm;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      letter-spacing: -0.2px;
      margin: 0;
    }
    .qr-meta-clean {
      width: 100%;
      max-width: 38mm;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.4mm;
      padding: 0 0.5mm;
      box-sizing: border-box;
    }
    .qr-meta-date-val {
      font-size: 6.2pt;
      font-weight: 800;
      color: #000;
      line-height: 1;
    }
    .qr-meta-code-val {
      font-size: 9pt;
      font-weight: 900;
      font-family: 'Courier New', monospace;
      color: #000;
      letter-spacing: 0.4px;
      line-height: 1;
      border: 0.3mm solid #000;
      border-radius: 0.8mm;
      padding: 0.3mm 1mm;
    }
  </style>
</head>
<body>
  ${pagesHtml}
</body>
</html>`);
        doc.close();

        const images = [...doc.images];
        await Promise.all(images.map(image => image.decode ? image.decode().catch(() => {}) : Promise.resolve()));
        await new Promise(resolve => setTimeout(resolve, 250));
        if (cancelled) return;

        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setPrintPending(false);
        setTimeout(() => {
          iframe.remove();
        }, 3000);
      } catch (e) {
        document.body.classList.add('printing-qr-labels');
        const cleanup = () => { document.body.classList.remove('printing-qr-labels'); setPrintPending(false); };
        window.addEventListener('afterprint', cleanup, { once: true });
        window.print();
        setTimeout(cleanup, 1000);
      }
    };
    print();
    return()=>{cancelled=true};
  },[labels,printPending,receipt]);

  const expandLine=async(line)=>{
    if(expandedLine===line.id){setExpandedLine(null);return}
    setExpandedLine(line.id);setLoadingLine(true);
    try{
      const client=getBrowserClient();
      const batchIds=(receipt.lines||[]).filter(x=>x.product_name===line.product_name&&(x.variant_id||null)===(line.variant_id||null)).map(x=>x.id);
      const{data:units}=await client.from('inventory_units').select('id,qr_code,serial_number,status').in('batch_id',batchIds).order('unit_sequence');
      const{data:prod}=await client.from('products').select('*').eq('id',line.product_id||units?.[0]?.product_id).single();
      const canonicalQr = units?.[0]?.qr_code || '';
      const normalizedUnits = (units||[]).map(u => ({
        ...u,
        qr_code: canonicalQr || u.qr_code
      }));
      setLineUnits(normalizedUnits);setLineProduct(prod?{...prod,variant_color:line.variant_color}:prod);
    }catch(e){}finally{setLoadingLine(false)}
  };

  const startEditLine=(line,prod)=>{
    setEditingLine(true);
    setLinePrices({
      unit_cost:rate?String(Math.round(Number(line.unit_cost||0)/rate)):String(line.unit_cost||0),
      retail_price:rate?String(Math.round(Number(prod.retail_price||0)/rate)):String(prod.retail_price||0),
      wholesale_price:rate?String(Math.round(Number(prod.wholesale_price||0)/rate)):String(prod.wholesale_price||0),
      minimum_sale_price:rate?String(Math.round(Number(prod.minimum_sale_price||0)/rate)):String(prod.minimum_sale_price||0)
    });
  };

  const saveLinePrices2=async(batchId,productId)=>{
    setSavingLine(true);setError('');
    try{
      const client=getBrowserClient();
      const uc=rate?Math.round(Number(linePrices.unit_cost||0)*rate):Number(linePrices.unit_cost||0);
      const rp=rate?Math.round(Number(linePrices.retail_price||0)*rate):Number(linePrices.retail_price||0);
      const wp=rate?Math.round(Number(linePrices.wholesale_price||0)*rate):Number(linePrices.wholesale_price||0);
      const mp=rate?Math.round(Number(linePrices.minimum_sale_price||0)*rate):Number(linePrices.minimum_sale_price||0);
      const{error:e}=await client.rpc('update_batch_prices',{p_batch_id:batchId,p_unit_cost:uc,p_retail_price:rp,p_wholesale_price:wp||null,p_minimum_sale_price:mp});
      if(e)throw e;
      setLineProduct(prev=>({...prev,retail_price:rp,wholesale_price:wp,minimum_sale_price:mp,cost_price:uc}));
      setEditingLine(false);
      onUpdated?.();
    }catch(e){setError(err(e))}finally{setSavingLine(false)}
  };

  const downloadLineQR=async(unit)=>{
    const QRCode=await import('qrcode');
    const canvas=await QRCode.toCanvas((import.meta.env.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app')+'/qr/'+encodeURIComponent(unit.qr_code),{width:300,margin:2,errorCorrectionLevel:'L'});
    const labeled=document.createElement('canvas');labeled.width=300;labeled.height=356;
    const ctx=labeled.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,300,356);ctx.drawImage(canvas,0,0);
    ctx.fillStyle='#000';ctx.font='bold 11px sans-serif';ctx.textAlign='center';
    ctx.fillText(unit.qr_code||'',150,318);
    ctx.font='10px sans-serif';ctx.fillStyle='#555';
    const label=lineProduct?.variant_color?`${lineProduct.name} (${lineProduct.variant_color})`:(lineProduct?.name||'');
    ctx.fillText(label,150,333);
    const link=document.createElement('a');link.download=(unit.qr_code||'qr')+'.png';link.href=labeled.toDataURL();link.click();
  };

  const saveEdit=async()=>{
    setSaving(true);setError('');
    try{
      await updateStockReceipt(receipt.id,{...editForm,received_at:editForm.received_at?new Date(editForm.received_at+'T12:00:00').toISOString():null});
      setEditing(false);onUpdated?.();
    }catch(e){setError(err(e))}finally{setSaving(false)}
  };

  const [passwordModal, setPasswordModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const removeReceipt=async(password=null)=>{
    const cleanPassword = typeof password === 'string' ? password.trim() : null;
    if(!cleanPassword&&!confirm("Bu partiyani o'chirasizmi? Sotilmagan birliklar ham o'chiriladi!"))return;
    setDeleting(true);setError('');
    try{
      await deleteStockReceipt(receipt.id,cleanPassword);
      setPasswordModal(false);
      close();
      onUpdated?.();
    }catch(e){
      const message=err(e);
      if(e?.code==='P0002'||message.includes('Topilmadi')){
        setPasswordModal(false);
        close();
        onUpdated?.();
      }else if(message.includes('sotilganlari bor')||e?.code==='P0001'||message.includes('Parol')||message.includes('parol')){
        if(cleanPassword){
          setPasswordError(message||'Noto\'g\'ri parol kiritildi!');
        }else{
          setPasswordInput('');
          setPasswordError('');
          setPasswordModal(true);
        }
      }else{
        if(passwordModal){
          setPasswordError(message);
        }else{
          setError(message);
        }
      }
    }finally{
      setDeleting(false);
    }
  };

  return <>
    <Modal open={Boolean(receipt)} onClose={close} title={receipt?.receipt_no||'Partiya'}>
      {receipt&&<div className="stack">
        <div className="receipt-info">
          <span><small>Ta’minotchi</small><b>{receipt.supplier_name}</b></span>
          <span><small>Qabul joyi</small><b>{receipt.location_name}</b></span>
          <span><small>Invoice</small><b>{receipt.invoice_number||'—'}</b></span>
          <span><small>Valyuta</small><b>{receipt.currency}</b></span>
          {rate&&<span><small>Kurs</small><b>1$ = {new Intl.NumberFormat('uz-UZ').format(rate)} so'm</b></span>}
        </div>
        {editing?(
          <div className="ops-form" style={{marginBottom:12}}>
            <label><span>Invoice</span><input className="input" value={editForm.invoice_number} onChange={e=>setEditForm({...editForm,invoice_number:e.target.value})}/></label>
            <label><span>To'lov holati</span><select className="select" value={editForm.payment_status} onChange={e=>setEditForm({...editForm,payment_status:e.target.value})}><option value="unpaid">To'lanmagan</option><option value="partial">Qisman</option><option value="paid">To'langan</option></select></label>
            <label><span>Sana</span><input className="input" type="date" value={editForm.received_at} onChange={e=>setEditForm({...editForm,received_at:e.target.value})}/></label>
            <label><span>Izoh</span><input className="input" value={editForm.notes} onChange={e=>setEditForm({...editForm,notes:e.target.value})}/></label>
            <div style={{display:'flex',gap:8}}>
              <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>{saving?'Saqlanmoqda…':'Saqlash'}</button>
              <button className="btn" onClick={()=>setEditing(false)}>Bekor</button>
            </div>
          </div>
        ):(
          <div style={{display:'flex',gap:8,margin:'8px 0',flexWrap:'wrap'}}>
            <button className="btn" onClick={()=>setEditing(true)}>Tahrirlash</button>
            <button className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={()=>onExportSingle?.(receipt.id,receipt.receipt_no)} title="Ushbu partiyani JSON zahiraga saqlash">
              <Download size={14}/>Zahira (JSON)
            </button>
            <button className="btn" style={{background:'#fee2e2',color:'#b91c1c',borderColor:'#fecaca'}} onClick={()=>removeReceipt()} disabled={deleting}>{deleting?'O‘chirilmoqda…':'O‘chirish'}</button>
          </div>
        )}
        {receipt.lines.map(x=>(
          <div key={x.id}>
            <div className="receipt-line" style={{cursor:'pointer'}} onClick={()=>expandLine(x)}>
              <div><b>{x.product_name}</b>{x.variant_color&&<span className="receipt-line-color">{x.variant_color}</span>}<span>{x.sku}</span></div>
              <strong>{Number(x.quantity)} dona</strong>
              <small><DualPrice value={Number(x.unit_cost||0)} rate={rate}/> · {Number(x.quantity)} dona</small>
            </div>
            {expandedLine===x.id&&<div style={{padding:12,border:'1px solid var(--line)',borderRadius:10,marginTop:6,marginBottom:8}}>
              {loadingLine?<p style={{color:'var(--muted)'}}>Yuklanmoqda…</p>:(
                <>
                  {lineProduct&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10,fontSize:11}}>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Sana</small><b>{receipt.received_at?new Date(receipt.received_at).toLocaleDateString('uz-UZ'):'—'}</b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Soni</small><b>{Number(x.quantity)} dona</b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Tannarx</small><b><DualPrice value={Number(x.unit_cost||0)} rate={rate}/></b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Sotish narxi</small><b><DualPrice value={Number(lineProduct.retail_price||0)} rate={rate}/></b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Ulgurji</small><b><DualPrice value={Number(lineProduct.wholesale_price||0)} rate={rate}/></b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Min narx</small><b><DualPrice value={Number(lineProduct.minimum_sale_price||0)} rate={rate}/></b></span>
                  </div>}
                  {editingLine?(
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10,fontSize:12}}>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Tannarx (USD)</span><input className="input" type="number" min="0" step="1" value={linePrices.unit_cost} onChange={e=>setLinePrices({...linePrices,unit_cost:e.target.value})}/></label>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Sotish narxi (USD)</span><input className="input" type="number" min="0" step="1" value={linePrices.retail_price} onChange={e=>setLinePrices({...linePrices,retail_price:e.target.value})}/></label>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Ulgurji (USD)</span><input className="input" type="number" min="0" step="1" value={linePrices.wholesale_price} onChange={e=>setLinePrices({...linePrices,wholesale_price:e.target.value})}/></label>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Min narx (USD)</span><input className="input" type="number" min="0" step="1" value={linePrices.minimum_sale_price} onChange={e=>setLinePrices({...linePrices,minimum_sale_price:e.target.value})}/></label>
                      <div style={{gridColumn:'1/-1',display:'flex',gap:8}}>
                        <button className="btn btn-primary" style={{fontSize:12}} onClick={()=>saveLinePrices2(x.id,lineProduct.id)} disabled={savingLine}>{savingLine?'Saqlanmoqda…':'Saqlash'}</button>
                        <button className="btn" style={{fontSize:12}} onClick={()=>setEditingLine(false)}>Bekor</button>
                      </div>
                    </div>
                  ):(
                    <button type="button" className="btn" style={{fontSize:11,marginBottom:8}} onClick={()=>startEditLine(x,lineProduct)}>Narxlarni tahrirlash</button>
                  )}
                  {(() => {
                    const canonicalQr = lineUnits?.[0]?.qr_code || x.qr_code || '';
                    const hasSerials = lineUnits.some(u => u.serial_number);
                    return (
                      <div style={{
                        background: '#f8fafc',
                        border: '1.5px solid #e2e8f0',
                        borderRadius: 12,
                        padding: '12px 14px',
                        marginTop: 4
                      }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 10,
                          marginBottom: 8
                        }}>
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
                              Partiya umumiy QR kodi ({Number(x.quantity)} dona uchun):
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <code style={{
                                fontSize: 15,
                                fontWeight: 900,
                                color: '#0f172a',
                                background: '#ffffff',
                                border: '1.5px solid #cbd5e1',
                                padding: '3px 10px',
                                borderRadius: 6,
                                letterSpacing: '0.5px'
                              }}>
                                {canonicalQr || '—'}
                              </code>
                              {canonicalQr && (
                                <button
                                  type="button"
                                  className="btn btn-outline"
                                  style={{ padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                  onClick={() => {
                                    navigator.clipboard?.writeText(canonicalQr);
                                  }}
                                  title="QR kodni nusxalash"
                                >
                                  <Copy size={12} />
                                  Nusxa
                                </button>
                              )}
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{
                                background: 'linear-gradient(135deg, #f97316, #ea580c)',
                                borderColor: '#ea580c',
                                padding: '6px 12px',
                                fontSize: 12,
                                fontWeight: 700,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                boxShadow: '0 2px 6px rgba(249,115,22,0.25)'
                              }}
                              onClick={() => openBluetoothPrint({
                                id: x.id,
                                product_name: lineProduct?.name || x.product_name || 'Mahsulot',
                                title: lineProduct?.name || x.product_name || 'Mahsulot',
                                variant_color: lineProduct?.variant_color || x.variant_color || '',
                                color: lineProduct?.variant_color || x.variant_color || '',
                                qr_code: canonicalQr,
                                code: canonicalQr,
                                quantity: Number(x.quantity) || 1,
                                date: receipt?.received_at ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ')
                              })}
                            >
                              <Bluetooth size={14} />
                              <Printer size={14} />
                              Chop etish ({Number(x.quantity)} dona)
                            </button>

                            <button
                              type="button"
                              className="btn btn-outline"
                              style={{ padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                              onClick={() => downloadLineQR({ qr_code: canonicalQr })}
                            >
                              <Download size={13} />
                              QR yuklab olish
                            </button>
                          </div>
                        </div>

                        {hasSerials && (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e2e8f0', fontSize: 11 }}>
                            <span style={{ fontWeight: 600, color: 'var(--muted)' }}>Seriya raqamlari: </span>
                            <span style={{ color: 'var(--navy)' }}>
                              {lineUnits.filter(u => u.serial_number).map(u => u.serial_number).join(', ')}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>}
          </div>
        ))}
        {error&&<div className="employee-error">{error}</div>}
        <div style={{fontSize:11,color:'var(--muted)',display:'flex',alignItems:'center',gap:6,background:'#f8fafc',padding:'8px 12px',borderRadius:8,marginBottom:10}}>
          <Printer size={14} style={{color:'var(--orange)',flexShrink:0}}/>
          <span><b>Detonger portativ termoprinter (40×30 mm)</b> uchun moslangan. Telefonda Bluetooth orqali yoki kompyuterda klassik chop etish mumkin.</span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          <button
            type="button"
            className="btn btn-primary btn-block"
            style={{
              padding:'12px',
              fontSize:13,
              fontWeight:700,
              background:'linear-gradient(135deg, #f97316, #ea580c)',
              boxShadow:'0 4px 14px rgba(249,115,22,0.3)',
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              gap:8
            }}
            onClick={()=>openBluetoothPrint()}
            disabled={loading}
          >
            <Bluetooth size={16}/>
            <Printer size={16}/>
            {loading ? 'Yorliqlar tayyorlanmoqda…' : 'Detonger Bluetooth orqali chop etish (Telefondan)'}
          </button>
          <button
            type="button"
            className="btn btn-outline btn-block"
            style={{padding:'9px',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}
            onClick={handleClassicPrint}
            disabled={loading}
          >
            <QrCode size={14}/>
            Kompyuter / Tizim orqali klassik chop etish
          </button>
        </div>
      </div>}
    </Modal>
    <DetongerPrintModal
      open={bluetoothModalOpen}
      onClose={()=>{setBluetoothModalOpen(false);setSinglePrintLabel(null);}}
      labels={singlePrintLabel?[singlePrintLabel]:labels}
      batchTitle={receipt?.receipt_no?(isInventoryReceipt(receipt.receipt_no)?`Inventarizatsiya #${receipt.receipt_no}`:`Partiya #${receipt.receipt_no}`):''}
      receiptDate={receipt?.received_at?new Date(receipt.received_at).toLocaleDateString('uz-UZ'):''}
      onClassicPrint={()=>{
        setBluetoothModalOpen(false);
        setPrintPending(true);
      }}
    />
    {labels.length>0&&createPortal(
      <div className="qr-print-sheet">
        {labels.map((x, idx)=>{
          const label=x.price_label||{};
          const matchedLine = (receipt?.lines || []).find(l => 
            (x.line_no && l.line_no === x.line_no) ||
            (x.product_id && l.product_id === x.product_id && (l.variant_id || null) === (x.variant_id || null)) ||
            (l.product_name === x.product_name && (l.variant_color || null) === (x.variant_color || null))
          );
          const prodTitle=label.title||x.product_name||matchedLine?.product_name||'Mahsulot';
          const colorName=label.color||x.variant_color||matchedLine?.variant_color||'';
          const receiptDate = receipt?.received_at 
            ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') 
            : new Date().toLocaleDateString('uz-UZ');

          return (
            <article className="qr-print-label" key={x.id || idx}>
              <div className="qr-print-body">
                <div className="qr-print-image-wrap">
                  <img className="qr-print-img" src={x.qrImage} alt="QR"/>
                </div>

                <div className="qr-print-details">
                  <div className="qr-print-name-color">
                    {prodTitle} {colorName ? `(${colorName})` : ''}
                  </div>
                  <div className="qr-print-meta">
                    <span className="qr-print-date">Sana: {receiptDate}</span>
                    <span className="qr-print-code">{x.qr_code||label.qr}</span>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>,
      document.body
    )}
    {passwordModal && (
      <Modal open={passwordModal} onClose={() => setPasswordModal(false)} title="Sotilgan tovarlar mavjud — Parol talab qilinadi">
        <form
          onSubmit={e => {
            e.preventDefault();
            if (!passwordInput.trim()) return;
            removeReceipt(passwordInput.trim());
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={20} color="#ea580c" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, color: '#9a3412', lineHeight: 1.5 }}>
              <b>"{receipt.receipt_no}"</b> partiyasidan sotilgan tovarlar bor!
              <br />
              Ushbu partiyani va unga bog‘liq barcha birliklarni butunlay o‘chirish uchun tasdiqlash parolini kiriting.
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Tasdiqlash paroli:
            </label>
            <input
              type="password"
              autoFocus
              className="input"
              style={{ width: '100%', padding: '8px 12px', fontSize: 14 }}
              placeholder="Parolni kiriting..."
              value={passwordInput}
              onChange={e => { setPasswordInput(e.target.value); setPasswordError(''); }}
            />
          </div>

          {passwordError && (
            <div style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: '8px 12px', borderRadius: 6, border: '1px solid #fecaca' }}>
              {passwordError}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setPasswordModal(false)}
              disabled={deleting}
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              className="btn"
              style={{ background: '#dc2626', color: '#fff', borderColor: '#dc2626' }}
              disabled={!passwordInput.trim() || deleting}
            >
              <Trash2 size={15} />
              {deleting ? 'O‘chirilmoqda…' : 'O‘chirish'}
            </button>
          </div>
        </form>
      </Modal>
    )}
  </>;
}
export function ReceiptModal({open,close,branchId,created,mode='batch'}){
  const isInventory = mode === 'inventory';
  const[refs,setRefs]=useState({locations:[],suppliers:[],products:[]});
  const[form,setForm]=useState(()=>{
    const n=new Date();
    const prefix = isInventory ? 'INV-' : 'PT-';
    const rno=prefix+n.toISOString().slice(0,10).replace(/-/g,'')+'-'+String(n.getHours()).padStart(2,'0')+String(n.getMinutes()).padStart(2,'0')+String(n.getSeconds()).padStart(2,'0');
    return{receipt_no:rno,supplier_id:'',receiving_location_id:'',invoice_number:'',currency:isInventory?'UZS':'USD',payment_status:'paid',received_at:n.toISOString().slice(0,10),notes:isInventory?'Do‘konda/skladda mavjud tovarlar inventarizatsiyasi':'',paid_amount:''};
  });
  const[lines,setLines]=useState([{
    product_id:'',
    color_name:'',
    variant_id:'',
    quantity:1,
    unit_cost:'',
    serials:'',
    retail_price:'',
    wholesale_price:'',
    minimum_sale_price:'',
    priceConfirmed:false,
    variants:[],
    variantConfigs:{}
  }]);
  const[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[showCreateProduct,setShowCreateProduct]=useState(false);
  const[createForLineIdx,setCreateForLineIdx]=useState(null);
  const[showCreateSupplier,setShowCreateSupplier]=useState(false);
  const[newSupplierName,setNewSupplierName]=useState('');
  const[newSupplierBusy,setNewSupplierBusy]=useState(false);
  const[rate,setRate]=useState(null);
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{})},[]);

  useEffect(()=>{
    if(open&&branchId){
      const n=new Date();
      const prefix = isInventory ? 'INV-' : 'PT-';
      const rno=prefix+n.toISOString().slice(0,10).replace(/-/g,'')+'-'+String(n.getHours()).padStart(2,'0')+String(n.getMinutes()).padStart(2,'0')+String(n.getSeconds()).padStart(2,'0');
      setForm(f=>({
        ...f,
        receipt_no:rno,
        currency:isInventory?'UZS':f.currency||'USD',
        notes:isInventory?'Do‘konda/skladda mavjud tovarlar inventarizatsiyasi':f.notes
      }));
      getInventoryReferences(branchId).then(async r=>{
        const{data:prods}=await getBrowserClient().from('products').select('id,name,sku,cost_price,retail_price,wholesale_price,minimum_sale_price').neq('status','archived');
        const{data:cats}=await getBrowserClient().from('categories').select('id,name,slug,parent_id').eq('is_active',true).order('sort_order');
        const{data:brands}=await getBrowserClient().from('brands').select('id,name').eq('is_active',true).order('name');
        const fullProducts=(prods||[]).map(p=>{const ref=(r.products||[]).find(x=>x.id===p.id);return{...p,image:ref?.image||null,track_individual_units:ref?.track_individual_units??true}});
        setRefs({...r,products:fullProducts,categories:cats||[],brands:brands||[]});
        
        let initialSupplierId = isInventory ? '' : (r.suppliers[0]?.id || '');

        setForm(f=>({
          ...f,
          supplier_id:f.supplier_id||initialSupplierId,
          receiving_location_id:f.receiving_location_id||r.locations.find(x=>x.type==='warehouse')?.id||r.locations[0]?.id||''
        }));
      }).catch(e=>setError(err(e)));
    }
  },[open,branchId,isInventory]);

  const setLine = (i, keyOrPatch, value) => {
    setLines(prev => prev.map((x, j) => {
      if (j !== i) return x;
      if (typeof keyOrPatch === 'object' && keyOrPatch !== null) {
        return { ...x, ...keyOrPatch };
      }
      return { ...x, [keyOrPatch]: value };
    }));
  };

  const handleProductSelect=async(i,productId)=>{
    const product=refs.products.find(p=>p.id===productId);
    const initialLine = {
      ...lines[i],
      product_id:productId,
      color_name:'',
      variant_id:'',
      unit_cost:String(product?.cost_price||''),
      retail_price:String(product?.retail_price||''),
      wholesale_price:String(product?.wholesale_price||''),
      minimum_sale_price:String(product?.minimum_sale_price||''),
      priceConfirmed:false,
      variants:[],
      variantConfigs:{}
    };
    setLines(lines.map((x,j)=>j===i?initialLine:x));
    if(!productId)return;
    try{
      const{data}=await getBrowserClient().from('product_variants').select('*').eq('product_id',productId).eq('is_active',true).order('sort_order');
      const loadedVariants = data || [];
      setLines(current=>current.map((x,j)=>j===i?{...x,variants:loadedVariants}:x));
    }catch{/* variantsiz mahsulot */}
  };

  const handleAddColorToLastProduct = () => {
    const lastLineWithProduct = [...lines].reverse().find(l => l.product_id);
    if (!lastLineWithProduct) {
      setError("Avval tovar tanlang");
      return;
    }
    const product = refs.products.find(p => p.id === lastLineWithProduct.product_id);
    setLines([
      ...lines,
      {
        product_id: lastLineWithProduct.product_id,
        color_name: '',
        variant_id: '',
        quantity: 1,
        unit_cost: lastLineWithProduct.unit_cost || String(product?.cost_price || ''),
        retail_price: lastLineWithProduct.retail_price || String(product?.retail_price || ''),
        wholesale_price: lastLineWithProduct.wholesale_price || String(product?.wholesale_price || ''),
        minimum_sale_price: lastLineWithProduct.minimum_sale_price || String(product?.minimum_sale_price || ''),
        priceConfirmed: lastLineWithProduct.priceConfirmed || false,
        serials: '',
        variants: lastLineWithProduct.variants || [],
        variantConfigs: {}
      }
    ]);
  };

  const handleAddNewProductLine = () => {
    setLines([
      ...lines,
      {
        product_id: '',
        color_name: '',
        variant_id: '',
        quantity: 1,
        unit_cost: '',
        serials: '',
        retail_price: '',
        wholesale_price: '',
        minimum_sale_price: '',
        priceConfirmed: false,
        variants: [],
        variantConfigs: {}
      }
    ]);
  };

  const confirmPrice=(i,updatePrices)=>{
    setLine(i,'priceConfirmed',true);
  };

  const submit=async e=>{
    e.preventDefault();
    let supplierId = isInventory ? (form.supplier_id || null) : form.supplier_id;
    if(!isInventory && !supplierId){setError('Ta\'minotchini tanlang');return}
    if(!form.receiving_location_id){setError('Qabul joyini tanlang');return}
    if(lines.some(x=>!x.product_id)){setError('Barcha qatorlarda mahsulot tanlang');return}
    
    // Validatsiya
    for(let idx=0; idx<lines.length; idx++){
      const x = lines[idx];
      if(Number(x.quantity) < 1){
        setError(`${idx+1}-qatordagi mahsulot miqdorini kiriting`);
        return;
      }
    }

    // Ranglar tekshiruvi: agar bir xil mahsulot 2 yoki undan ortiq qatorda bo'lsa, har biriga rang kiritilgan bo'lishi kerak
    const prodCounts = {};
    for (const l of lines) {
      if (l.product_id) prodCounts[l.product_id] = (prodCounts[l.product_id] || 0) + 1;
    }
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (l.product_id && prodCounts[l.product_id] > 1 && !l.color_name?.trim()) {
        setError(`${idx + 1}-qatordagi tovar uchun rang nomini kiriting (masalan: Oq yoki Qora)`);
        return;
      }
    }

    setBusy(true);
    setError('');
    try{
      const payloadLines = [];

      for(const line of lines){
        const product = refs.products.find(p=>p.id===line.product_id);
        const baseCost = Number(line.unit_cost) || 0;
        const baseRetail = Number(line.retail_price) || Number(product?.retail_price) || 0;
        const baseWholesale = Number(line.wholesale_price) || Number(product?.wholesale_price) || 0;
        const baseMin = Number(line.minimum_sale_price) || Number(product?.minimum_sale_price) || 0;

        let variantId = line.variant_id || null;
        const colorName = (line.color_name || '').trim();

        if(colorName){
          const existingVar = (line.variants || []).find(v => v.color_name?.trim().toLowerCase() === colorName.toLowerCase());
          if(existingVar && existingVar.id && !String(existingVar.id).startsWith('temp_')){
            variantId = existingVar.id;
          } else {
            try{
              const { data: dbVars } = await getBrowserClient()
                .from('product_variants')
                .select('id, color_name')
                .eq('product_id', line.product_id);
              const foundInDb = (dbVars || []).find(v => v.color_name?.trim().toLowerCase() === colorName.toLowerCase());
              if(foundInDb){
                variantId = foundInDb.id;
              } else {
                const { data: newVar } = await getBrowserClient()
                  .from('product_variants')
                  .insert({
                    product_id: line.product_id,
                    color_name: colorName,
                    retail_price: baseRetail || null,
                    wholesale_price: baseWholesale || null,
                    minimum_sale_price: baseMin || null,
                    is_active: true
                  })
                  .select('id')
                  .single();
                if(newVar?.id){
                  variantId = newVar.id;
                }
              }
            }catch(varErr){
              console.warn('Variant resolution error:', varErr);
            }
          }
        }

        const serials = (line.serials || '').split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean);
        const priceOverride = line.priceConfirmed && baseRetail > 0 ? {
          retail_price: baseRetail,
          wholesale_price: baseWholesale,
          minimum_sale_price: baseMin
        } : {};

        payloadLines.push({
          product_id: line.product_id,
          variant_id: variantId || null,
          quantity: Number(line.quantity) || 1,
          unit_cost: baseCost,
          serial_numbers: serials,
          ...priceOverride
        });
      }

      await createStockReceipt({
        ...form,
        supplier_id: isInventory ? (supplierId || null) : supplierId,
        branch_id: branchId,
        received_at: new Date(`${form.received_at}T12:00:00`).toISOString(),
        paid_amount: isInventory ? 0 : (Number(form.paid_amount) || 0)
      }, payloadLines);

      setLines([{
        product_id:'',color_name:'',variant_id:'',quantity:1,unit_cost:'',serials:'',retail_price:'',wholesale_price:'',minimum_sale_price:'',priceConfirmed:false,variants:[],variantConfigs:{}
      }]);
      await created();
    }catch(e){
      setError(err(e));
    }finally{
      setBusy(false);
    }
  };

  const onProductCreatedFromForm=async(newProdForm,images=[],variants=[])=>{
    const client=getBrowserClient();
    const slug=newProdForm.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+Date.now().toString(36);
    const{data,error:insertErr}=await client.from('products').insert({
      name:newProdForm.name.trim(),
      sku:newProdForm.sku?.trim().toUpperCase()||('TB-'+Date.now().toString(36).toUpperCase()),
      slug,
      category_id:newProdForm.category_id||null,
      brand_id:newProdForm.brand_id||null,
      cost_price:Number(newProdForm.cost_price)||0,
      retail_price:Number(newProdForm.retail_price)||0,
      wholesale_price:Number(newProdForm.wholesale_price)||null,
      minimum_sale_price:Number(newProdForm.minimum_sale_price)||0,
      status:'active',
      is_published:true,
      track_individual_units:true,
      tax_rate:0,
      description:newProdForm.description||null
    }).select('id,name,sku,cost_price,retail_price,wholesale_price,minimum_sale_price').single();
    if(insertErr)throw insertErr;
    for(const file of images){
      try{await uploadProductMedia(data.id,file,newProdForm.name.trim())}catch{}
    }
    const namedVariants=(variants||[]).filter(v=>v.color_name?.trim());
    if(namedVariants.length){
      try{
        const variantsPayload=namedVariants.map(v=>({color_name:v.color_name.trim(),color_hex:v.color_hex||null,retail_price:v.retail_price===''?null:Number(v.retail_price),wholesale_price:v.wholesale_price===''?null:Number(v.wholesale_price),is_active:true}));
        const{saveProductVariants}=await import('@texnobazar/data');
        const createdVariants=await saveProductVariants(data.id,variantsPayload);
        data.variants=createdVariants;
      }catch{}
    }
    setRefs(prev=>({...prev,products:[...prev.products,data]}));
    if(createForLineIdx!==null){
      handleProductSelect(createForLineIdx, data.id);
    }
    setShowCreateProduct(false);
    setCreateForLineIdx(null);
  };

  const createSupplier=async()=>{
    if(!newSupplierName.trim())return;
    setNewSupplierBusy(true);
    try{
      const{data,error:e}=await getBrowserClient().rpc('create_supplier_quick',{p_name:newSupplierName.trim()});
      if(e)throw e;
      setRefs(prev=>({...prev,suppliers:[...prev.suppliers,data]}));
      setForm(f=>({...f,supplier_id:data.id}));
      setShowCreateSupplier(false);setNewSupplierName('');
    }catch(e){setError(err(e))}finally{setNewSupplierBusy(false)}
  };

  const totalUnitsCount = lines.reduce((sum, line) => {
    return sum + (Number(line.quantity) || 0);
  }, 0);

  return <Modal open={open} onClose={close} wide title={isInventory ? "Inventarizatsiya — mavjud tovarlarni kiritish" : "Yangi partiya qabul qilish"}>
    <form className="receipt-form" onSubmit={submit}>
      {error&&<div className="employee-error">{error}</div>}
      <div className="receipt-form-grid">
        <label>
          <span>{isInventory ? 'Hujjat raqami' : 'Partiya raqami'}</span>
          <input className="input" value={form.receipt_no} onChange={e=>setForm({...form,receipt_no:e.target.value.toUpperCase()})} required placeholder="PT-... yoki INV-..."/>
        </label>
        
        {isInventory ? (
          <label>
            <span>Ro‘yxat turi</span>
            <div style={{padding:'9px 12px',background:'#f5f3ff',borderRadius:10,border:'1px solid #ddd6fe',color:'#6d28d9',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:6}}>
              <Boxes size={16}/> Skladdagi/do‘kondagi mavjud tovarlar (Ichki inventarizatsiya)
            </div>
          </label>
        ) : (
          <label>
            <span>Ta'minotchi *</span>
            {showCreateSupplier ? (
              <div style={{display:'flex',gap:6}}>
                <input className="input" value={newSupplierName} onChange={e=>setNewSupplierName(e.target.value)} placeholder="Yangi ta'minotchi nomi" autoFocus/>
                <button type="button" className="btn btn-primary" style={{whiteSpace:'nowrap',padding:'0 10px'}} onClick={createSupplier} disabled={newSupplierBusy}>{newSupplierBusy?'...':'OK'}</button>
                <button type="button" className="btn" style={{padding:'0 8px'}} onClick={()=>setShowCreateSupplier(false)}><X size={14}/></button>
              </div>
            ) : (
              <div style={{display:'flex',gap:6}}>
                <select className="select" value={form.supplier_id} onChange={e=>setForm({...form,supplier_id:e.target.value})} required style={{flex:1}}>
                  {refs.suppliers.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button type="button" className="btn" style={{padding:'0 10px',whiteSpace:'nowrap',fontSize:11}} onClick={()=>setShowCreateSupplier(true)}><Plus size={13}/>Yangi</button>
              </div>
            )}
          </label>
        )}

        <label>
          <span>Qabul joylashuvi *</span>
          <select className="select" value={form.receiving_location_id} onChange={e=>setForm({...form,receiving_location_id:e.target.value})} required>
            {refs.locations.map(x=><option key={x.id} value={x.id}>{x.name} {x.type==='warehouse'?'(Ombor)':'(Do‘kon)'}</option>)}
          </select>
        </label>

        {!isInventory && <label><span>Invoice / Hisob raqami</span><input className="input" value={form.invoice_number} onChange={e=>setForm({...form,invoice_number:e.target.value})} placeholder="Ixtiyoriy"/></label>}
        
        <label>
          <span>Qabul sanasi</span>
          <input className="input" type="date" value={form.received_at} onChange={e=>setForm({...form,received_at:e.target.value})} required/>
        </label>

        <label>
          <span>Valyuta</span>
          <select className="select" value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})}>
            <option>USD</option>
            <option>UZS</option>
            <option>EUR</option>
          </select>
        </label>

        {!isInventory && (
          <>
            <label>
              <span>To'lov holati</span>
              <select className="select" value={form.payment_status} onChange={e=>setForm({...form,payment_status:e.target.value})}>
                <option value="paid">To'langan</option>
                <option value="partial">Qisman</option>
                <option value="unpaid">To'lanmagan</option>
              </select>
            </label>
            {form.payment_status==='partial'&&<label><span>To'langan summa ({form.currency})</span><input className="input" type="number" min="0" step="0.01" value={form.paid_amount} onChange={e=>setForm({...form,paid_amount:e.target.value})} placeholder="Summa"/></label>}
          </>
        )}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14}}>
        <h3 style={{margin:0,fontSize:16}}>Mahsulot qatorlari</h3>
        <span style={{fontSize:12,color:'var(--muted)'}}>Har bir tovar rangi uchun 1 ta umumiy QR kod beriladi</span>
      </div>

      {lines.map((line,i)=>(
        <ReceiptProductLine
          key={i}
          line={line}
          index={i}
          totalLines={lines.length}
          products={refs.products}
          setLine={setLine}
          removeLine={lines.length>1?()=>setLines(lines.filter((_,j)=>j!==i)):null}
          onSelect={handleProductSelect}
          confirmPrice={confirmPrice}
          openCreateProduct={()=>{setCreateForLineIdx(i);setShowCreateProduct(true)}}
          rate={rate}
          currency={form.currency}
        />
      ))}

      {/* Rang yoki yangi tovar qo'shish tugmalari - tartibli va aniq joylashuv */}
      <div style={{display:'flex',flexDirection:'column',gap:8,marginTop:6}}>
        <button
          type="button"
          className="btn"
          style={{
            borderColor:'#0284c7',
            color:'#0284c7',
            background:'#f0f9ff',
            fontWeight:700,
            justifyContent:'center',
            padding:'10px 16px',
            fontSize:13,
            borderRadius:10
          }}
          onClick={handleAddColorToLastProduct}
        >
          <Plus size={16}/> Shu tovarni boshqa rangini qo'shish
        </button>

        <button
          type="button"
          className="btn btn-outline"
          style={{
            justifyContent:'center',
            padding:'10px 16px',
            fontSize:13,
            borderRadius:10
          }}
          onClick={handleAddNewProductLine}
        >
          <Plus size={16}/> Boshqa tovar qo'shish
        </button>
      </div>

      <div className="qr-summary" style={{background:isInventory?'#f5f3ff':'#fff7ed',borderColor:isInventory?'#ddd6fe':'#fdba74'}}>
        <QrCode size={26} color={isInventory?'#7c3aed':'var(--orange)'}/>
        <div style={{flex:1}}>
          <b style={{fontSize:14}}>
            Jami: {totalUnitsCount} dona mahsulot ({lines.filter(l=>l.product_id).length} xil tovar/rang turi)
          </b>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:6}}>
            {lines.filter(l=>l.product_id).map((l, idx)=>{
              const p = refs.products.find(prod=>prod.id===l.product_id);
              return (
                <span key={idx} style={{padding:'3px 8px',borderRadius:6,background:'#fff',border:'1px solid rgba(0,0,0,0.1)',fontSize:11,fontWeight:600}}>
                  #{idx+1} {p?.name?.slice(0, 22)}... {l.color_name ? `(${l.color_name})` : ''}: <b>{l.quantity || 0} dona</b>
                </span>
              );
            })}
          </div>
          <span style={{display:'block',fontSize:12,color:'var(--muted)',marginTop:4}}>
            Partiya saqlangach, har bir tovar (va uning rangi) uchun alohida umumiy QR kod yaratiladi va narx yorlig‘ida chop etiladi.
          </span>
        </div>
      </div>

      <button className="btn btn-primary btn-block" disabled={busy} style={isInventory?{background:'#7c3aed',borderColor:'#7c3aed'}:{}}>
        {busy ? 'Saqlanmoqda…' : isInventory ? 'Inventarizatsiyani saqlash va QR kodlar yaratish' : 'Partiyani qabul qilish va QR kodlar yaratish'}
      </button>
    </form>

    {showCreateProduct&&<div className="receipt-create-overlay"><div className="receipt-create-form card" style={{width:"min(780px,95vw)",padding:20,maxHeight:"90vh",overflow:"auto",borderRadius:16}}><CreateProductInline categories={refs.categories||[]} brands={refs.brands||[]} categoryId="" onCreated={onProductCreatedFromForm} onCancel={()=>{setShowCreateProduct(false);setCreateForLineIdx(null)}} rate={rate}/></div></div>}
  </Modal>;
}

function CurrencyNumberInput({
  valueUzs,
  onChangeUzs,
  currency = 'USD',
  rate,
  placeholder,
  className = 'input',
  style,
  required = false,
  min = 0,
  step = '0.01'
}) {
  const [text, setText] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (isFocused) return;
    if (valueUzs === '' || valueUzs === null || valueUzs === undefined) {
      setText('');
      return;
    }
    const num = Number(valueUzs);
    if (isNaN(num) || num === 0) {
      setText('');
      return;
    }
    if (currency === 'USD' && rate) {
      const usdVal = num / rate;
      setText(Number(usdVal.toFixed(2)).toString());
    } else {
      setText(String(num));
    }
  }, [valueUzs, currency, rate, isFocused]);

  const handleChange = (e) => {
    const val = e.target.value;
    setText(val);
    if (val.trim() === '') {
      onChangeUzs('');
      return;
    }
    const clean = val.replace(',', '.');
    const num = parseFloat(clean);
    if (!isNaN(num)) {
      const uzs = currency === 'USD' && rate ? Math.round(num * rate) : Math.round(num);
      onChangeUzs(String(uzs));
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (text.trim() === '') {
      onChangeUzs('');
      return;
    }
    const clean = text.replace(',', '.');
    const num = parseFloat(clean);
    if (!isNaN(num) && num > 0) {
      if (currency === 'USD') {
        setText(num.toFixed(2));
      } else {
        setText(String(Math.round(num)));
      }
    } else {
      setText('');
      onChangeUzs('');
    }
  };

  return (
    <input
      className={className}
      style={style}
      type="number"
      min={min}
      step={step}
      value={text}
      onChange={handleChange}
      onFocus={() => setIsFocused(true)}
      onBlur={handleBlur}
      placeholder={placeholder || (currency === 'USD' ? '0.00' : '0')}
      required={required}
    />
  );
}

function ReceiptProductLine({line,index,totalLines,products,setLine,removeLine,onSelect,confirmPrice,openCreateProduct,rate,currency='USD'}){
  const[search,setSearch]=useState('');
  const[dropdownOpen,setDropdownOpen]=useState(false);
  const[priceCurrency,setPriceCurrency]=useState(currency);

  useEffect(()=>{
    if(currency) setPriceCurrency(currency);
  },[currency]);

  const selectedProduct=products.find(p=>p.id===line.product_id);
  const filtered=search?products.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())||p.sku.toLowerCase().includes(search.toLowerCase())).slice(0,15):products.slice(0,15);

  return <div className="receipt-product card" style={{padding:16,marginBottom:14,border:'1px solid var(--line)',borderRadius:14,background:index%2===1?'#fcfdfd':'#fff'}}>
    {/* Qator sarlavhasi va o'chirish tugmasi */}
    <div className="wide" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,paddingBottom:8,borderBottom:'1px solid var(--line,#e2e8f0)'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
        <span style={{background:'#f1f5f9',color:'#334155',fontSize:12,fontWeight:700,padding:'2px 8px',borderRadius:6}}>
          #{index + 1}-qator
        </span>
        {selectedProduct && (
          <b style={{fontSize:13,color:'var(--text)'}}>
            {selectedProduct.name}
          </b>
        )}
        {line.color_name ? (
          <span style={{background:'#dbeafe',color:'#1d4ed8',padding:'2px 10px',borderRadius:20,fontSize:12,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
            🎨 {line.color_name} rangi
          </span>
        ) : (
          <span style={{fontSize:11,color:'var(--muted)'}}>
            (Rangi kiritilmagan)
          </span>
        )}
      </div>
      {removeLine && (
        <button
          type="button"
          className="receipt-line-delete-btn"
          onClick={removeLine}
          title="Ushbu qatorni o'chirish"
          style={{position:'static',width:28,height:28}}
        >
          <Trash2 size={14}/>
        </button>
      )}
    </div>
    
    <label className="wide">
      <span>Mahsulot *</span>
      {selectedProduct ? (
        <div className="receipt-selected-product">
          <div>
            <b>{selectedProduct.name}</b>
            <small>{selectedProduct.sku} · Baza narxi: <DualPrice value={Number(selectedProduct.retail_price)} rate={rate}/></small>
          </div>
          <button type="button" className="btn btn-sm" style={{padding:'4px 10px',fontSize:11}} onClick={()=>{onSelect(index,'');setSearch('')}}>O'zgartirish</button>
        </div>
      ) : (
        <div className="receipt-product-search">
          <div className="receipt-search-input">
            <Search size={14}/>
            <input value={search} onChange={e=>{setSearch(e.target.value);setDropdownOpen(true)}} onFocus={()=>setDropdownOpen(true)} placeholder="Tovar nomi yoki SKU bo‘yicha qidiring..."/>
          </div>
          {dropdownOpen&&<div className="receipt-product-dropdown">
            {filtered.map(p=><button type="button" key={p.id} onClick={()=>{onSelect(index,p.id);setDropdownOpen(false);setSearch('')}}><b>{p.name}</b><small>{p.sku}</small></button>)}
            {filtered.length===0&&<span className="receipt-dropdown-empty">Tovar topilmadi</span>}
            <button type="button" className="receipt-dropdown-create" onClick={()=>{setDropdownOpen(false);openCreateProduct()}}><Plus size={13}/>Yangi tovar yaratish</button>
          </div>}
        </div>
      )}
    </label>

    {selectedProduct && (
      <>
        {/* Asosiy narxlar - 3 ustun (Rangi, Miqdor, Tannarx) */}
        <label>
          <span>Rangi {line.color_name ? `(${line.color_name})` : '(masalan: Oq, Qora)'}</span>
          <input
            className="input"
            value={line.color_name || ''}
            onChange={e=>{
              const val = e.target.value;
              const matched = (line.variants||[]).find(v => v.color_name?.trim().toLowerCase() === val.trim().toLowerCase());
              if(matched){
                setLine(index, {
                  color_name: val,
                  variant_id: matched.id,
                  retail_price: matched.retail_price ? String(matched.retail_price) : line.retail_price
                });
              } else {
                setLine(index, {
                  color_name: val,
                  variant_id: ''
                });
              }
            }}
            list={`colors-list-${index}`}
            placeholder="Masalan: Oq, Qora..."
          />
          <datalist id={`colors-list-${index}`}>
            {(line.variants||[]).map(v => (
              <option key={v.id} value={v.color_name} />
            ))}
          </datalist>
          {line.variants?.length > 0 && (
            <div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:4}}>
              <small style={{fontSize:10,color:'var(--muted)',width:'100%'}}>Mavjud ranglar:</small>
              {line.variants.map(v => (
                <button
                  key={v.id}
                  type="button"
                  className="btn btn-sm"
                  style={{
                    padding:'1px 6px',
                    fontSize:10,
                    background: line.color_name?.toLowerCase() === v.color_name?.toLowerCase() ? '#0284c7' : '#f1f5f9',
                    color: line.color_name?.toLowerCase() === v.color_name?.toLowerCase() ? '#fff' : '#334155',
                    border: 0,
                    borderRadius: 4
                  }}
                  onClick={()=>{
                    setLine(index, {
                      color_name: v.color_name,
                      variant_id: v.id,
                      retail_price: v.retail_price ? String(v.retail_price) : line.retail_price
                    });
                  }}
                >
                  {v.color_name}
                </button>
              ))}
            </div>
          )}
        </label>

        <label>
          <span>Miqdor {line.color_name ? `(${line.color_name} soni, dona) *` : '(dona) *'}</span>
          <input
            className="input"
            type="number"
            min="1"
            max="10000"
            value={line.quantity === 0 ? '' : (line.quantity ?? '')}
            onChange={e=>{
              const v = e.target.value;
              setLine(index, 'quantity', v === '' ? '' : v);
            }}
            placeholder="1"
            required
          />
        </label>

        <label>
          <span>Tannarx {line.color_name ? `(${line.color_name} uchun, ${priceCurrency}) *` : `(${priceCurrency}) *`}</span>
          <CurrencyNumberInput
            valueUzs={line.unit_cost}
            onChangeUzs={v=>setLine(index,'unit_cost',v)}
            currency={priceCurrency}
            rate={rate}
            placeholder={priceCurrency==='USD'?'0.00':'0'}
            required
          />
        </label>

        {/* Asosiy narxlarni o'zgartirish bloki */}
        {!line.priceConfirmed && (
          <div className="receipt-price-confirm wide">
            <p><b>{line.color_name ? `"${line.color_name}" rangi` : 'Ushbu qator'} uchun asosiy sotish narxlarini o'zgartirish</b></p>
            <div className="receipt-price-current">
              <span>Sotish: <b><DualPrice value={Number(line.retail_price || selectedProduct.retail_price)} rate={rate}/></b></span>
              <span>Ulgurji: <b><DualPrice value={Number(line.wholesale_price || selectedProduct.wholesale_price || 0)} rate={rate}/></b></span>
              <span>Minimal: <b><DualPrice value={Number(line.minimum_sale_price || selectedProduct.minimum_sale_price || 0)} rate={rate}/></b></span>
              <span>Tannarx: <b><DualPrice value={Number(line.unit_cost || selectedProduct.cost_price || 0)} rate={rate}/></b></span>
            </div>
            <div className="receipt-price-buttons">
              <button type="button" className="btn btn-primary btn-sm" onClick={()=>confirmPrice(index,true)}>
                Ha, {line.color_name ? `"${line.color_name}" narxini` : 'yangi narx'} kiritaman
              </button>
              <button type="button" className="btn btn-sm" onClick={()=>confirmPrice(index,false)}>
                Yo'q, bazadagi narxda
              </button>
            </div>
          </div>
        )}

        {line.priceConfirmed && (
          <div className="receipt-price-fields wide">
            <div className="receipt-price-toggle" style={{gridColumn:'1/-1',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <b>{line.color_name ? `"${line.color_name}" rangi sotish narxlari:` : 'Sotish narxlari:'}</b>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <small>Valyuta:</small>
                <button type="button" className={priceCurrency==='USD'?'btn btn-primary':'btn'} style={{padding:'2px 8px',fontSize:11}} onClick={()=>setPriceCurrency('USD')}>USD</button>
                <button type="button" className={priceCurrency==='UZS'?'btn btn-primary':'btn'} style={{padding:'2px 8px',fontSize:11}} onClick={()=>setPriceCurrency('UZS')}>UZS</button>
              </div>
            </div>
            <label>
              <span>Sotish narxi {line.color_name ? `(${line.color_name}, ${priceCurrency}) *` : `(${priceCurrency}) *`}</span>
              <CurrencyNumberInput
                valueUzs={line.retail_price}
                onChangeUzs={v=>setLine(index,'retail_price',v)}
                currency={priceCurrency}
                rate={rate}
                placeholder={priceCurrency==='USD'?'0.00':'0'}
                required
              />
            </label>
            <label>
              <span>Ulgurji narx {line.color_name ? `(${line.color_name}, ${priceCurrency})` : `(${priceCurrency})`}</span>
              <CurrencyNumberInput
                valueUzs={line.wholesale_price}
                onChangeUzs={v=>setLine(index,'wholesale_price',v)}
                currency={priceCurrency}
                rate={rate}
                placeholder={priceCurrency==='USD'?'0.00':'0'}
              />
            </label>
            <label>
              <span>Minimal narx {line.color_name ? `(${line.color_name}, ${priceCurrency})` : `(${priceCurrency})`}</span>
              <CurrencyNumberInput
                valueUzs={line.minimum_sale_price}
                onChangeUzs={v=>setLine(index,'minimum_sale_price',v)}
                currency={priceCurrency}
                rate={rate}
                placeholder={priceCurrency==='USD'?'0.00':'0'}
              />
            </label>
          </div>
        )}

        <label className="wide">
          <span>Seriya raqamlari (ixtiyoriy, har satrda bittadan)</span>
          <textarea className="textarea" value={line.serials} onChange={e=>setLine(index,'serials',e.target.value)} placeholder={`Agar kiritilsa, aynan ${line.quantity} ta bo'lishi kerak`}/>
        </label>
      </>
    )}
  </div>;
}

export function InventoryScanner({open,close,branchId,toast}){
  const rate=useExchangeRate();
  const[code,setCode]=useState(''),[unit,setUnit]=useState(null),[refs,setRefs]=useState({locations:[]}),[target,setTarget]=useState('');
  const[busy,setBusy]=useState(false),[placing,setPlacing]=useState(false),[error,setError]=useState('');
  const[showCost,setShowCost]=useState(false);
  const[revertOpen,setRevertOpen]=useState(false),[revertLocation,setRevertLocation]=useState(''),[revertReason,setRevertReason]=useState(''),[reverting,setReverting]=useState(false);
  const[scannerBtPrint,setScannerBtPrint]=useState(false);
  useEffect(()=>{if(open&&branchId)getInventoryReferences(branchId).then(r=>{setRefs(r);setTarget(r.locations[0]?.id||'');setRevertLocation(r.locations.find(x=>x.type==='store')?.id||r.locations[0]?.id||'')}).catch(e=>setError(err(e)))},[open,branchId]);
  useEffect(()=>{setShowCost(false);setRevertOpen(false);setRevertReason('')},[unit?.id]);
  const extractQr=v=>{const raw=String(v||'').trim();try{const u=new URL(raw);const m=u.pathname.match(/^\/qr\/([^/]+)\/?$/i);return m?decodeURIComponent(m[1]).trim():raw}catch{return raw}};
  const reload=async qr=>{try{setUnit(await getInventoryUnitPassport(qr))}catch(e){setError(err(e))}};
  const scan=async e=>{e.preventDefault();setBusy(true);setError('');try{setUnit(await getInventoryUnitPassport(extractQr(code)))}catch(e){setUnit(null);setError(err(e))}finally{setBusy(false)}};
  const place=async()=>{
    setPlacing(true);setError('');
    try{
      await placeInventoryUnits(target,[unit.qr_code]);
      toast?.('Mahsulot yangi joyga joylashtirildi');
      await reload(unit.qr_code);
    }catch(e){setError(err(e))}finally{setPlacing(false)}
  };
  const revert=async()=>{
    if(!revertLocation){setError('Qaytarish joyini tanlang');return}
    if(!window.confirm('Ushbu tovarni sotuvdan qaytarasizmi? Sotuv summasi hisobdan chiqariladi.'))return;
    setReverting(true);setError('');
    try{
      const result=await revertUnitSale(unit.id,revertLocation,revertReason||null);
      toast?.(`${result.location_name}ga qaytarildi · ${formatDualMoney(Number(result.reverted_amount),rate)} hisobdan chiqarildi`);
      setRevertOpen(false);setRevertReason('');
      await reload(unit.qr_code);
    }catch(e){setError(err(e))}finally{setReverting(false)}
  };
  if(!open)return null;
  const availableCount = unit?.available_count ?? (unit?.status === 'available' ? 1 : 0);
  const storefrontBase=(import.meta.env?.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app').replace(/\/$/,'');
  return <div className="passport-scanner">
    <header><button onClick={close}><X/></button><b>QR / seriya skaneri</b><span/></header>
    <form onSubmit={scan}><QrCode/><input autoFocus value={code} onChange={e=>setCode(e.target.value)} placeholder="TNB1-... yoki seriya raqami" required/><QrScanButton onScan={v=>setCode(extractQr(v))}/><button disabled={busy}>{busy?'…':'Topish'}</button></form>
    {error&&<div className="inventory-error"><AlertTriangle/><p>{error}</p></div>}
    {unit&&<div className="unit-passport">
      <div className="passport-product">
        {unit.product.image?<img src={unit.product.image}/>:<span><Boxes/></span>}
        <div>
          <small>Elektron pasport</small>
          <h2>{unit.product.name}</h2>
          <p>{unit.product.sku} · {unit.product.brand_name||'Brendsiz'}</p>
          {unit.variant_color&&<span className="passport-variant-badge"><i style={{background:unit.variant_color_hex||'#ccc'}}/>{unit.variant_color}</span>}
        </div>
        <Status type={availableCount > 0 ? 'green' : 'orange'}>
          {availableCount > 0 ? `Mavjud: ${availableCount} dona` : 'Qolmagan'}
        </Status>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:10}}>
        <button
          type="button"
          className="btn btn-outline"
          style={{padding:'7px 12px',fontSize:12,display:'inline-flex',alignItems:'center',gap:6,borderColor:'#f97316',color:'#ea580c',background:'#fff7ed',fontWeight:600}}
          onClick={()=>setScannerBtPrint(true)}
        >
          <Bluetooth size={14}/>
          <Printer size={14}/>
          Detonger yorliq chop etish (40×30 mm)
        </button>
      </div>
      <div className="passport-grid">
        <span><small>QR kod</small><b>{unit.qr_code}</b></span>
        <span><small>Mavjud qoldiq</small><b>{availableCount} dona {unit.total_count ? `(jami ${unit.total_count} ta)` : ''}</b></span>
        <span><small>Zavod seriyasi</small><b>{unit.serial_number||'—'}</b></span>
        <span><small>Partiya</small><b>{unit.batch.receipt_no||'—'}</b></span>
        <span><small>Ta’minotchi</small><b>{unit.batch.supplier_name||'—'}</b></span>
        <span><small>Tannarx</small><button type="button" className="masked-value" onClick={()=>setShowCost(v=>!v)} title={showCost?'Yashirish':'Ko‘rsatish'}>{showCost?<><b><DualPrice value={Number(unit.batch.unit_cost)} rate={rate}/></b><EyeOff size={13}/></>:<><b>******</b><Eye size={13}/></>}</button></span>
        <span><small>Sotish narxi</small><b><DualPrice value={Number(unit.batch.retail_price||unit.product.retail_price)} rate={rate}/></b></span>
        {unit.product.slug&&<span><small>Sayt sahifasi</small><a className="passport-link" href={`${storefrontBase}/product/${unit.product.slug}`} target="_blank" rel="noopener"><ExternalLink size={12}/>{unit.product.is_published?'Saytda ko‘rish':'Ko‘rish (nashr qilinmagan)'}</a></span>}
        {unit.latest_batch_prices&&<span><small>Eng yangi partiya narxi</small><b><DualPrice value={Number(unit.latest_batch_prices.retail_price)} rate={rate}/></b></span>}
        <span><small>Hozirgi joyi</small><b>{unit.location.name}</b></span>
      </div>

      <section>
        <h3>Filial ichida joylashtirish</h3>
        <div className="place-row">
          <select className="select" value={target} onChange={e=>setTarget(e.target.value)}>
            {refs.locations.map(x=><option key={x.id} value={x.id}>{x.name} {x.type==='warehouse'?'(Ombor)':'(Do‘kon)'}</option>)}
          </select>
          <button className="btn btn-primary" onClick={place} disabled={placing||busy||target===unit.location.id}>
            {placing?<><span className="btn-spinner"/>Joylashtirilmoqda…</>:<><MapPin/>Joylashtirish</>}
          </button>
        </div>
      </section>

      <section><h3>Harakatlar tarixi</h3><div className="movement-list">{unit.movements.map(m=><div key={m.id}><i/><span><b>{movementLabel(m.type)}</b><small>{new Date(m.occurred_at).toLocaleString('uz-UZ')} · {m.actor_name||'Tizim'}</small><em>{m.from_location?`${m.from_location} → `:''}{m.to_location||''}</em></span></div>)}</div></section>
    </div>}
    {unit&&<DetongerPrintModal
      open={scannerBtPrint}
      onClose={()=>setScannerBtPrint(false)}
      labels={[{
        id: unit.id,
        title: unit.product.name,
        product_name: unit.product.name,
        color: unit.variant_color,
        variant_color: unit.variant_color,
        code: unit.qr_code,
        qr_code: unit.qr_code,
        quantity: availableCount || 1,
        date: unit.batch?.received_at ? new Date(unit.batch.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ'),
      }]}
      batchTitle={unit?.batch?.receipt_no ? `Partiya #${unit.batch.receipt_no}` : ''}
    />}
  </div>;
}
const unitStatusLabel=status=>({available:'Sotuvga tayyor',reserved:'Band',in_transit:'Yo‘lda',sold:'Sotilgan',returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:'Ta’mirda'}[status]||status);
const movementLabel=t=>({received:'Yetkazib beruvchidan qabul qilindi',adjustment:'Joylashtirildi',transfer_out:'Transferga jo‘natildi',transfer_in:'Transferdan qabul qilindi',reserved:'Rezerv qilindi',sold:'Sotildi',returned:'Qaytarildi',writeoff:'Hisobdan chiqarildi'}[t]||t);
