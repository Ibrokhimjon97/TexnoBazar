import React,{useEffect,useState}from'react';
import{AlertTriangle,CheckCircle2,ChevronRight,ExternalLink,Mail,MapPin,Package,QrCode,Search,Send,Trash2,Truck}from'lucide-react';
import{DualPrice,Empty,Modal,Status,useExchangeRate}from'@texnobazar/ui';
import{assignOrderCourier,deleteOnlineOrder,getManagerWorkspaceReferences,getOrderUnitAssignments,getReceiptDeliveryStatus,listManagerOnlineOrders,managerCancelOnlineOrder,managerReassignOrderUnit,queueOrderReceipt,subscribeOrders,transitionOnlineOrder}from'@texnobazar/data';

const STOREFRONT = (import.meta.env?.VITE_STOREFRONT_URL || (typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'http://localhost:5173' : 'https://texnobazar-storefront.netlify.app')).replace(/\/$/, '');
const message=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
const labels={new:'Yangi',confirmed:'Tasdiqlangan',processing:'Tayyorlanmoqda',ready:'Tayyor',assigned:'Kuryer biriktirilgan',shipped:'Yo‘lda',delivered:'Yetkazilgan',cancelled:'Bekor qilingan',returned:'Qaytarilgan'};
const colors={new:'blue',confirmed:'orange',processing:'orange',ready:'green',assigned:'green',shipped:'blue',delivered:'green',cancelled:'red',returned:'gray'};
const next={new:'confirmed',confirmed:'processing',processing:'ready'};
export default function OnlineOrderWorkspace({branchId,toast,focusOrderId,clearFocus}){
  const rate=useExchangeRate();
  const[refs,setRefs]=useState({couriers:[]}),[rows,setRows]=useState([]),[detail,setDetail]=useState(null),[status,setStatus]=useState(''),[query,setQuery]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[deletingOrder,setDeletingOrder]=useState(null),[deleteBusy,setDeleteBusy]=useState(false);
  const load=async(focusId,silent=false)=>{if(!branchId){setLoading(false);return;}if(!silent)setLoading(true);setError('');try{const[result,reference]=await Promise.all([listManagerOnlineOrders({branchId,status:status||null,query,pageSize:60}),getManagerWorkspaceReferences(branchId)]);setRows(result.items||[]);setRefs(reference||{couriers:[]});if(focusId)setDetail((result.items||[]).find(x=>x.id===focusId)||null);}catch(e){setError(message(e));}finally{if(!silent)setLoading(false);}};
  useEffect(()=>{const t=setTimeout(()=>load(),query?250:0);return()=>clearTimeout(t);},[branchId,status,query]);
  useEffect(()=>{if(!branchId)return;return subscribeOrders(()=>load(detail?.id,true),e=>setError(message(e)),branchId);},[branchId,status,query,detail?.id]);
  // Unassigned new orders have no branch_id and cannot match a branch-filtered realtime channel.
  useEffect(()=>{if(!branchId)return;const timer=setInterval(()=>load(detail?.id,true),20000);return()=>clearInterval(timer);},[branchId,status,query,detail?.id]);
  useEffect(()=>{
    if(!focusOrderId||!branchId)return;
    setStatus('');setQuery('');
    load(focusOrderId).then(()=>clearFocus?.()).catch(()=>clearFocus?.());
    // Only re-run when the focus target itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[focusOrderId,branchId]);
  const transition=async target=>{if(!detail||!window.confirm(target==='confirmed'?'Buyurtma uchun real birliklar rezerv qilinadi. Tasdiqlaysizmi?':`Buyurtmani “${labels[target]}” holatiga o‘tkazasizmi?`))return;setBusy(true);setError('');try{await transitionOnlineOrder(detail.id,target,branchId);await load(detail.id);toast?.(target==='confirmed'?'Buyurtma tasdiqlandi va zaxira rezerv qilindi':`Buyurtma: ${labels[target]}`);}catch(e){setError(message(e));}finally{setBusy(false);}};
  const cancel=async()=>{if(!detail)return;const isDelivery=['assigned','shipped','delivered'].includes(detail.status);if(!window.confirm(isDelivery?'Dostavka qaytganligi sababli buyurtmani bekor qilib, tovarni omborga qaytarasizmi?':'Buyurtmani bekor qilib rezervlarni bo‘shatasizmi?'))return;const reason=window.prompt(isDelivery?'Tovar qaytish sababi (masalan: Mijoz rad etdi):':'Bekor qilish sababi:','')||'';if(!reason.trim())return;setBusy(true);setError('');try{await managerCancelOnlineOrder(detail.id,branchId,reason);await load(detail.id);toast?.(isDelivery?'Dostavka bekor qilindi va tovar omborga qaytarildi':'Buyurtma bekor qilindi');}catch(e){setError(message(e));}finally{setBusy(false);}};
  const assign=async courierId=>{if(!courierId)return;setBusy(true);setError('');try{await assignOrderCourier(detail.id,courierId);await load(detail.id);toast?.('Kuryer biriktirildi');}catch(e){setError(message(e));}finally{setBusy(false);}};
  const handleDeleteOrder=async(restoreStock=true)=>{if(!deletingOrder)return;setDeleteBusy(true);try{const res=await deleteOnlineOrder(deletingOrder.id,restoreStock);toast?.(res?.message||'Buyurtma o‘chirildi');setDeletingOrder(null);if(detail?.id===deletingOrder.id)setDetail(null);await load();}catch(e){toast?.(message(e));}finally{setDeleteBusy(false);}};
  if(!branchId)return <State error="Filial tanlanmagan."/>;
  return <section className="ops-workspace"><div className="m-page-head"><h2>Online buyurtmalar va kuryer</h2><p>Yangi buyurtmani rezervlashdan kuryer biriktirishgacha boshqarish</p></div><div className="order-toolbar"><div className="ops-tabs">{[['','Barchasi'],['new','Yangi'],['confirmed','Tasdiqlangan'],['processing','Jarayonda'],['ready','Tayyor'],['assigned','Kuryerda']].map(([key,text])=><button key={key} className={status===key?'active':''} onClick={()=>setStatus(key)}>{text}</button>)}</div><label className="ops-search"><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buyurtma, mijoz yoki telefon"/></label></div><State loading={loading} error={error} retry={()=>load()}>{rows.length===0?<Empty title="Buyurtmalar topilmadi" text="Filtrni o‘zgartiring yoki yangi online buyurtmani kuting."/>:<div className="ops-grid">{rows.map(row=><button className="card ops-card order-card" key={row.id} onClick={()=>setDetail(row)}><span className="ops-icon"><Truck/></span><div><div className="between"><b>{row.order_no}</b><Status type={colors[row.status]}>{labels[row.status]||row.status}</Status></div><strong>{row.customer_name} · <DualPrice value={Number(row.total||0)} rate={rate}/></strong><small>{row.customer_phone}</small><small><MapPin/>{address(row.shipping_address)} · {new Date(row.placed_at).toLocaleString('uz-UZ')}</small>{!row.branch_id&&<em>Yangi, hali filialga biriktirilmagan</em>}<div style={{display:'flex',justifyContent:'flex-end',marginTop:6,paddingTop:6,borderTop:'1px dashed var(--line)'}}><span role="button" tabIndex={0} className="btn btn-sm" style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:11,fontWeight:600,padding:'3px 8px',background:'#fff1f2',color:'#e11d48',border:'1px solid #fecdd3'}} onClick={e=>{e.stopPropagation();setDeletingOrder(row);}}><Trash2 size={12}/> O‘chirish</span></div></div><ChevronRight/></button>)}</div>}</State><OrderDetail order={detail} refs={refs} close={()=>setDetail(null)} busy={busy} error={error} transition={transition} cancel={cancel} assign={assign} onDelete={setDeletingOrder} rate={rate}/><Modal open={Boolean(deletingOrder)} onClose={()=>!deleteBusy&&setDeletingOrder(null)} title="Buyurtmani o‘chirish"><div style={{display:'flex',flexDirection:'column',gap:14}}><p style={{margin:0,fontSize:14,color:'var(--navy)'}}>Haqiqatan ham <b>{deletingOrder?.order_no}</b> online buyurtmasini tizimdan o‘chirmoqchimisiz?</p><div style={{padding:'10px 14px',background:'#fff1f2',border:'1px solid #fecdd3',borderRadius:8,fontSize:13,color:'#be123c'}}>Ushbu buyurtma va unga bog‘liq barcha kuryer hamda kassa yozuvlari o‘chiriladi.</div><div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:6}}><button type="button" className="btn" disabled={deleteBusy} onClick={()=>setDeletingOrder(null)}>Bekor qilish</button><button type="button" className="btn" style={{background:'#e11d48',color:'#fff'}} disabled={deleteBusy} onClick={()=>handleDeleteOrder(true)}>{deleteBusy?'O‘chirilmoqda…':'Ha, o‘chirish'}</button></div></div></Modal></section>;
}
function OrderDetail({order,refs,close,busy,error,transition,cancel,assign,onDelete,rate}){
  const[courierId,setCourierId]=useState('');
  useEffect(()=>{if(order)setCourierId(order.delivery?.courier_id||refs.couriers?.[0]?.id||'');},[order,refs]);
  return (
    <Modal open={Boolean(order)} onClose={close} title={order?.order_no||'Buyurtma'}>
      {order && (
        <div className="ops-detail">
          <div className="between"><Status type={colors[order.status]}>{labels[order.status]}</Status><b><DualPrice value={Number(order.total||0)} rate={rate}/></b></div>
          {error && <div className="ops-inline-error">{error}{/zaxirasi yetarli emas/i.test(error)&&<small> Boshqa filial yoki qoldiqni tekshiring.</small>}</div>}
          <div className="order-customer">
            <span><small>Mijoz</small><b>{order.customer_name}</b><em>{order.customer_phone}</em></span>
            <span><small>Manzil</small><b>{address(order.shipping_address)}</b></span>
            <span><small>To‘lov</small><b>{order.payment_status}</b></span>
          </div>
          {order.notes && <p className="ops-note">{order.notes}</p>}
          <h3>Mahsulotlar</h3>
          <div className="ops-lines">
            {order.order_lines?.map(line => {
              const storefrontUrl = line.slug ? `${STOREFRONT}/product/${line.slug}` : null;
              return (
                <div key={line.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0' }}>
                  {line.image ? (
                    <img
                      src={line.image}
                      alt={line.product_name || 'Mahsulot'}
                      style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--line, #e2e8f0)' }}
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : (
                    <div style={{ width: 52, height: 52, borderRadius: 10, background: '#f1f5f9', display: 'grid', placeItems: 'center', flexShrink: 0, border: '1px solid var(--line, #e2e8f0)', color: '#64748b' }}>
                      <Package size={22} />
                    </div>
                  )}
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <b style={{ fontSize: 14, color: 'var(--ink, #0f172a)', wordBreak: 'break-word' }}>{line.product_name}</b>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted, #64748b)' }}>
                      <span>SKU: {line.sku || '—'}</span>
                      {line.variant_color && (
                        <span style={{ background: '#fef3c7', color: '#b45309', padding: '1px 6px', borderRadius: 4, fontWeight: 600, fontSize: 11 }}>
                          🎨 {line.variant_color}
                        </span>
                      )}
                      {line.selected_components?.length > 0 && (
                        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                          {line.selected_components.map((c, i) => (
                            <span key={i} style={{ background: '#f1f5f9', color: '#334155', padding: '1px 6px', borderRadius: 4, fontWeight: 600, fontSize: 11 }}>
                              + {c.name || c.name_uz}{c.color ? ` (${c.color})` : ''}
                            </span>
                          ))}
                        </span>
                      )}
                      <span>·</span>
                      <span>{Number(line.quantity)} dona × <DualPrice value={Number(line.unit_price || 0)} rate={rate} /></span>
                    </div>
                    {storefrontUrl ? (
                      <a href={storefrontUrl} target="_blank" rel="noopener noreferrer" className="order-product-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 3, color: 'var(--orange, #ea580c)', fontSize: 12, fontWeight: 700, textDecoration: 'none', width: 'fit-content' }}>
                        <ExternalLink size={13} /> Mijoz ilovasida ko‘rish
                      </a>
                    ) : (
                      <small style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: 11 }}>Havola mavjud emas</small>
                    )}
                  </span>
                  <strong style={{ flexShrink: 0 }}><DualPrice value={Number(line.line_total || 0)} rate={rate} /></strong>
                </div>
              );
            })}
          </div>
          {['new','confirmed','processing','ready'].includes(order.status) && <OrderUnitAssignments orderId={order.id} onChanged={()=>transition&&null}/>}
          {order.status==='ready' && <div className="order-assign"><select className="select" value={courierId} onChange={e=>setCourierId(e.target.value)}><option value="">Kuryer tanlang</option>{refs.couriers?.map(x=><option key={x.id} value={x.id}>{x.full_name}</option>)}</select><button className="btn btn-primary" disabled={busy||!courierId} onClick={()=>assign(courierId)}>Biriktirish</button></div>}
          {order.delivery && <p className="ops-note">Kuryer: {refs.couriers?.find(x=>x.id===order.delivery.courier_id)?.full_name||order.delivery.courier_id} · {order.delivery.tracking_code}</p>}
          <OrderReceiptDelivery order={order}/>
          <div className="ops-actions">
            {next[order.status] && <button className="btn btn-primary" disabled={busy} onClick={()=>transition(next[order.status])}>{labels[next[order.status]]}</button>}
            {!['cancelled','returned'].includes(order.status) && <button className="btn ops-danger" disabled={busy} onClick={cancel}>{['assigned','shipped','delivered'].includes(order.status)?'Dostavka qaytdi (Bekor qilish)':'Bekor qilish'}</button>}
          </div>
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-sm"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#fff1f2',
                color: '#e11d48',
                border: '1px solid #fecdd3',
                padding: '7px 12px',
                fontSize: 12,
                fontWeight: 600
              }}
              disabled={busy}
              onClick={() => {
                close();
                onDelete?.(order);
              }}
            >
              <Trash2 size={13} /> Buyurtmani o‘chirish
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
function OrderUnitAssignments({orderId}){
  const[items,setItems]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[scanningFor,setScanningFor]=useState(null),[qrInput,setQrInput]=useState(''),[busy,setBusy]=useState(false);
  const load=async()=>{setLoading(true);setError('');try{const data=await getOrderUnitAssignments(orderId);setItems(data||[])}catch(e){setError(message(e))}finally{setLoading(false)}};
  useEffect(()=>{load()},[orderId]);
  const startScan=lineId=>{setScanningFor(lineId);setQrInput('')};
  const submitScan=async(lineId)=>{if(!qrInput.trim())return;setBusy(true);setError('');try{await managerReassignOrderUnit(lineId,qrInput.trim());setScanningFor(null);setQrInput('');await load()}catch(e){setError(message(e))}finally{setBusy(false)}};
  if(loading)return <div className="ops-note">QR biriktirishlar yuklanmoqda\u2026</div>;
  return <div className="order-unit-assignments">
    <h3><QrCode size={16}/> Mahsulot QR biriktirish</h3>
    {error&&<div className="ops-inline-error">{error}</div>}
    <div className="order-unit-list">{items.map(item=><div key={item.order_line_id} className="order-unit-row">
      <div className="order-unit-info"><b>{item.product_name}</b><small>{item.sku}</small></div>
      {item.qr_code?<div className="order-unit-qr"><code>{item.qr_code}</code>{item.courier_confirmed?<Status type="green"><CheckCircle2 size={12}/> Kuryer tasdiqladi</Status>:<Status type="orange">Kutilmoqda</Status>}</div>:<Status type="red">Biriktirilmagan</Status>}
      {scanningFor===item.order_line_id?<div className="order-unit-scan"><input className="input" autoFocus value={qrInput} onChange={e=>setQrInput(e.target.value)} placeholder="QR kod yoki seriya" onKeyDown={e=>e.key==='Enter'&&submitScan(item.order_line_id)}/><button className="btn btn-primary" style={{fontSize:11,padding:'6px 10px'}} disabled={busy} onClick={()=>submitScan(item.order_line_id)}>Saqlash</button><button className="btn" style={{fontSize:11,padding:'6px 10px'}} onClick={()=>setScanningFor(null)}>Bekor</button></div>:<button className="btn btn-outline" style={{fontSize:11,padding:'6px 10px'}} onClick={()=>startScan(item.order_line_id)}>{item.qr_code?'Almashtirish':'QR kiritish'}</button>}
    </div>)}</div>
  </div>;
}
function OrderReceiptDelivery({order}){const[delivery,setDelivery]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[idempotencyKey,setIdempotencyKey]=useState(()=>crypto.randomUUID());useEffect(()=>{let active=true;setDelivery(null);setError('');setIdempotencyKey(crypto.randomUUID());if(order?.status==='delivered')getReceiptDeliveryStatus({orderId:order.id}).then(value=>active&&setDelivery(value)).catch(current=>active&&setError(message(current)));return()=>{active=false}},[order?.id,order?.status]);useEffect(()=>{if(!delivery?.id||!['pending','processing'].includes(delivery.status))return;const timer=setInterval(()=>getReceiptDeliveryStatus({deliveryId:delivery.id}).then(setDelivery).catch(()=>{}),4000);return()=>clearInterval(timer)},[delivery?.id,delivery?.status]);if(order?.status!=='delivered')return null;const queue=async()=>{setBusy(true);setError('');try{const key=delivery?.status==='dead'?crypto.randomUUID():idempotencyKey;if(key!==idempotencyKey)setIdempotencyKey(key);setDelivery(await queueOrderReceipt({orderId:order.id,idempotencyKey:key}))}catch(current){setError(message(current))}finally{setBusy(false)}};const locked=['pending','processing','sent','ambiguous'].includes(delivery?.status);return <div className="order-receipt-delivery"><div><Mail/><span><b>Elektron chek</b><small className={delivery?.status==='ambiguous'?'receipt-ambiguous':''}>{delivery?.message||'Buyurtmadagi mijoz emailiga yuborish'}</small></span><button type="button" className="btn btn-primary" disabled={busy||locked} onClick={queue}><Send/>{busy?'Navbatga…':delivery?.status==='dead'?'Qayta urinish':delivery?'Holati saqlandi':'Yuborish'}</button></div>{delivery?.recipient_hint&&<small>{delivery.recipient_hint}</small>}{error&&<small className="receipt-error">{error}</small>}</div>}
const address=value=>{if(!value)return'—';if(typeof value==='string')return value;return[value.city,value.district,value.street,value.address,value.line1].filter(Boolean).join(', ')||JSON.stringify(value);};
function State({loading,error,retry,children}){if(loading)return <div className="ops-state">Buyurtmalar yuklanmoqda…</div>;if(error)return <div className="ops-state ops-error"><AlertTriangle/><b>Xatolik</b><p>{error}</p>{retry&&<button className="btn" onClick={retry}>Qayta urinish</button>}</div>;return children;}
