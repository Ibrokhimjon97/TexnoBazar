import React,{useCallback,useEffect,useState}from'react';
import{AlertTriangle,ChevronLeft,ChevronRight,ExternalLink,Eye,Mail,Package,RefreshCw,Search,Send,Trash2,Truck,XCircle}from'lucide-react';
import{DualPrice,Modal,Status,useExchangeRate}from'@texnobazar/ui';
import{assignOrderCourier,deleteOnlineOrder,getManagerWorkspaceReferences,getOrderBranchStock,getReceiptDeliveryStatus,listActiveBranches,listAdminOnlineOrders,managerCancelOnlineOrder,queueOrderReceipt,subscribeOrders,transitionOnlineOrder}from'@texnobazar/data';
const STOREFRONT = (import.meta.env?.VITE_STOREFRONT_URL || (typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'http://localhost:5173' : 'https://texnobazar-storefront.netlify.app')).replace(/\/$/, '');
const statuses=['new','confirmed','processing','ready','assigned','shipped','delivered','cancelled','returned'];
const labels={new:'Yangi',confirmed:'Tasdiqlandi',processing:'Yig‘ilmoqda',ready:'Tayyor',assigned:'Kuryer biriktirilgan',shipped:'Yo‘lda',delivered:'Yetkazildi',cancelled:'Bekor qilindi',returned:'Qaytarildi'};
const next={new:'confirmed',confirmed:'processing',processing:'ready'};
export default function AdminOrdersWorkspace({toast,focusOrderId,focusOrderNo,clearFocus}){const rate=useExchangeRate();const[branches,setBranches]=useState([]),[branchId,setBranchId]=useState(''),[status,setStatus]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(1),[result,setResult]=useState({items:[],total:0}),[selected,setSelected]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[deletingOrder,setDeletingOrder]=useState(null),[deleteBusy,setDeleteBusy]=useState(false);const load=useCallback(async(silent=false)=>{if(!silent)setLoading(true);setError('');try{const[data,branchRows]=await Promise.all([listAdminOnlineOrders({branchId:branchId||null,status:status||null,query,page,pageSize:50}),branches.length?Promise.resolve(branches):listActiveBranches()]);setResult(data);setBranches(branchRows);setSelected(current=>current?(data.items||[]).find(row=>row.id===current.id)||null:null)}catch(e){setError(e.message||'Buyurtmalar yuklanmadi.')}finally{if(!silent)setLoading(false)}},[branchId,status,query,page]);useEffect(()=>{load()},[load]);useEffect(()=>{let timer;const refresh=()=>{if(typeof document==='undefined'||document.visibilityState==='visible'){clearTimeout(timer);timer=setTimeout(()=>load(true),300)}};const clean=subscribeOrders(refresh,e=>setError(e.message||String(e)),branchId||null),poll=setInterval(refresh,25000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);return()=>{clearTimeout(timer);clearInterval(poll);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);clean()}},[branchId,load]);
  useEffect(()=>{
    if(!focusOrderId)return;
    const match=(result.items||[]).find(row=>row.id===focusOrderId);
    if(match){setSelected(match);clearFocus?.();return}
    // Not in the currently loaded/filtered page — reset filters and search the order directly so it surfaces regardless of status or branch.
    let active=true;
    setStatus('');setBranchId('');setQuery('');setPage(1);
    listAdminOnlineOrders({page:1,pageSize:50,query:focusOrderNo||''}).then(data=>{
      if(!active)return;
      const found=(data?.items||[]).find(row=>row.id===focusOrderId);
      if(found){setResult(data);setSelected(found)}
      clearFocus?.();
    }).catch(()=>{if(active)clearFocus?.()});
    return()=>{active=false};
    // Only re-run when the focus target itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[focusOrderId]);
  const handleDeleteOrder=async(restoreStock)=>{if(!deletingOrder)return;setDeleteBusy(true);try{const res=await deleteOnlineOrder(deletingOrder.id,restoreStock);toast?.(res?.message||"Buyurtma o‘chirildi");setDeletingOrder(null);await load(true)}catch(e){toast?.(e.message||"Buyurtmani o‘chirib bo‘lmadi")}finally{setDeleteBusy(false)}};
  const pages=Math.max(1,Math.ceil(Number(result.total||0)/50));return <><div className="page-head between"><div><h2>Online buyurtmalar</h2><p>Barcha filiallar va biriktirilmagan yangi buyurtmalar uchun real fulfillment oqimi.</p></div><button className="btn btn-outline" onClick={()=>load()}><RefreshCw/> Yangilash</button></div><form className="admin-filterbar" onSubmit={e=>{e.preventDefault();setPage(1);load()}}><label><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Raqam, mijoz yoki telefon"/></label><select className="select" value={branchId} onChange={e=>{setBranchId(e.target.value);setPage(1)}}><option value="">Barcha filiallar</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select><select className="select" value={status} onChange={e=>{setStatus(e.target.value);setPage(1)}}><option value="">Barcha holatlar</option>{statuses.map(s=><option key={s} value={s}>{labels[s]}</option>)}</select><button className="btn btn-primary">Qidirish</button></form>{loading?<State text="Buyurtmalar yuklanmoqda…"/>:error?<State text={error} error retry={load}/>:<div className="card data-card"><div className="table-wrap"><table className="table"><thead><tr><th>Buyurtma</th><th>Mijoz</th><th>Filial</th><th>Sana</th><th>Summa</th><th>To‘lov</th><th>Holat</th><th>Amal</th></tr></thead><tbody>{(result.items||[]).map(row=><tr key={row.id}><td><b>{row.order_no}</b><small className="muted">{row.order_lines?.length||0} qator</small></td><td>{row.customer_name}<small className="muted">{row.customer_phone}</small></td><td>{row.branch_name||<Status type="orange">Biriktirilmagan</Status>}</td><td>{new Date(row.placed_at).toLocaleString('uz-UZ')}</td><td><b><DualPrice value={Number(row.total)} rate={rate}/></b></td><td>{row.payment_status}</td><td><OrderStatus value={row.status}/></td><td><div style={{display:'flex',alignItems:'center',gap:6}}><button className="icon-btn" title="Ko‘rish" onClick={()=>setSelected(row)}><Eye/></button><button className="icon-btn" title="O‘chirish" onClick={()=>setDeletingOrder(row)}><Trash2 size={16}/></button></div></td></tr>)}</tbody></table></div>{!(result.items||[]).length&&<p className="admin-inline-empty">Buyurtma topilmadi.</p>}<div className="admin-pagination"><span>{result.total||0} ta buyurtma · {page}/{pages}</span><div><button disabled={page<=1} onClick={()=>setPage(p=>p-1)}><ChevronLeft/></button><button disabled={page>=pages} onClick={()=>setPage(p=>p+1)}><ChevronRight/></button></div></div></div>}<OrderModal order={selected} branches={branches} close={()=>setSelected(null)} changed={async message=>{toast(message);await load(true)}} onDelete={ord=>{setSelected(null);setDeletingOrder(ord)}} rate={rate}/>
  <Modal open={!!deletingOrder} onClose={()=>!deleteBusy&&setDeletingOrder(null)} title={`Buyurtmani o‘chirish — ${deletingOrder?.order_no||''}`}>
    <div style={{display:'flex',flexDirection:'column',gap:16}}>
      <p style={{fontSize:15,lineHeight:1.5,margin:0}}>
        <b>Tovar omborga qaytarilsinmi va hisoblangan kirim pul balansdan ayirilsinmi?</b>
      </p>
      <div style={{background:'rgba(241,245,249,0.7)',padding:12,borderRadius:8,fontSize:13,lineHeight:1.6}}>
        <div style={{marginBottom:6}}>• <b>Ha:</b> Sotilgan tovar omborga qaytariladi (+1), sotilgan pul kirimdan ayiriladi va buyurtma o‘chiriladi.</div>
        <div>• <b>Yo‘q:</b> Ombor va kassa balansiga tegmasdan, faqat buyurtmalar tarixidan o‘chiriladi.</div>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:8}}>
        <button className="btn btn-outline" onClick={()=>setDeletingOrder(null)} disabled={deleteBusy}>Bekor qilish</button>
        <button className="btn btn-outline" style={{borderColor:'#ef4444',color:'#ef4444'}} disabled={deleteBusy} onClick={()=>handleDeleteOrder(false)}>
          {deleteBusy?'O‘chirilmoqda…':'Yo‘q (faqat o‘chirish)'}
        </button>
        <button className="btn btn-primary" style={{backgroundColor:'#ef4444',borderColor:'#ef4444'}} disabled={deleteBusy} onClick={()=>handleDeleteOrder(true)}>
          {deleteBusy?'O‘chirilmoqda…':'Ha (tovar va pulni qaytarish)'}
        </button>
      </div>
    </div>
  </Modal></>}
function OrderModal({order,branches,close,changed,onDelete,rate}){
  const[fulfillmentBranch,setFulfillmentBranch]=useState(''),[couriers,setCouriers]=useState([]),[courierId,setCourierId]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[branchStock,setBranchStock]=useState([]),[stockLoading,setStockLoading]=useState(false);
  useEffect(()=>{if(!order)return;const id=order.branch_id||'';setFulfillmentBranch(id);setReason('');setError('');setBranchStock([]);if(order.status==='new'&&!order.branch_id){setStockLoading(true);getOrderBranchStock(order.id).then(data=>setBranchStock(data||[])).catch(()=>{}).finally(()=>setStockLoading(false))}},[order?.id,branches]);
  useEffect(()=>{if(!order||!fulfillmentBranch){setCouriers([]);return}getManagerWorkspaceReferences(fulfillmentBranch).then(x=>setCouriers(x.couriers||[])).catch(e=>setError(e.message))},[order?.id,fulfillmentBranch]);
  if(!order)return <Modal open={false}/>;
  const run=async(fn,message)=>{setBusy(true);setError('');try{await fn();await changed(message);close()}catch(e){setError(e.message||'Amal bajarilmadi.')}finally{setBusy(false)}};
  return <Modal open onClose={close} title={order.order_no}><div className="admin-order-detail">
    {error&&<div className="employee-error">{error}</div>}
    <div className="between"><div><b>{order.customer_name}</b><span>{order.customer_phone}</span></div><OrderStatus value={order.status}/></div>
    <p><b>Manzil:</b> {address(order.shipping_address)}</p>
    <p><b>Filial:</b> {order.branch_name||'Biriktirilmagan'}</p>
    <div className="admin-order-lines">
      {(order.order_lines || []).map(line => {
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
              <div style={{ width: 52, height: 52, borderRadius: 10, background: 'var(--bg-subtle, #f1f5f9)', display: 'grid', placeItems: 'center', flexShrink: 0, border: '1px solid var(--line, #e2e8f0)', color: 'var(--muted, #64748b)' }}>
                <Package size={22} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <b style={{ fontSize: 14, color: 'var(--ink, #0f172a)', wordBreak: 'break-word' }}>{line.product_name}</b>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted, #64748b)' }}>
                <span>SKU: {line.sku || '—'}</span>
                {line.variant_color && (
                  <span style={{ background: '#fef3c7', color: '#b45309', padding: '1px 6px', borderRadius: 4, fontWeight: 600, fontSize: 11 }}>
                    🎨 {line.variant_color}
                  </span>
                )}
                <span>·</span>
                <span>{Number(line.quantity)} dona × <DualPrice value={Number(line.unit_price || 0)} rate={rate} /></span>
              </div>
              {storefrontUrl ? (
                <a
                  href={storefrontUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 3, color: 'var(--orange, #ea580c)', fontSize: 12, fontWeight: 700, textDecoration: 'none', width: 'fit-content' }}
                >
                  <ExternalLink size={13} /> Mijoz ilovasida ko‘rish
                </a>
              ) : (
                <small style={{ color: 'var(--muted, #94a3b8)', fontStyle: 'italic', fontSize: 11 }}>Havola mavjud emas</small>
              )}
            </div>
            <strong style={{ flexShrink: 0 }}><DualPrice value={Number(line.line_total)} rate={rate} /></strong>
          </div>
        );
      })}
    </div>
    <div className="between admin-order-total"><span>Jami</span><b><DualPrice value={Number(order.total)} rate={rate}/></b></div>
    {next[order.status]&&<div className="admin-order-action">
      <label><span className="label">Fulfillment filiali {stockLoading&&'(qoldiq tekshirilmoqda...)'}</span>
        {!order.branch_id?<div className="order-branch-selector">
          {branchStock.length>0?branchStock.map(b=><button key={b.branch_id} type="button" className={'order-branch-option'+(fulfillmentBranch===b.branch_id?' active':'')} onClick={()=>setFulfillmentBranch(b.branch_id)}>
            <div className="order-branch-option-head"><b>{b.branch_name}</b>{b.can_fulfill?<Status type="green">Barchasi bor</Status>:<Status type="orange">Qisman</Status>}</div>
            <div className="order-branch-stock-list">{(b.products||[]).map(p=><span key={p.product_id} className={p.available>=p.needed?'stock-ok':'stock-low'}>{p.product_name}: <b>{p.available}</b>/{p.needed}</span>)}</div>
          </button>):branches.map(b=><button key={b.id} type="button" className={'order-branch-option'+(fulfillmentBranch===b.id?' active':'')} onClick={()=>setFulfillmentBranch(b.id)}><b>{b.name}</b></button>)}
        </div>:<select className="select" value={fulfillmentBranch} disabled><option>{order.branch_name}</option></select>}
      </label>
      <button className="btn btn-primary" disabled={busy||!fulfillmentBranch} onClick={()=>run(()=>transitionOnlineOrder(order.id,next[order.status],fulfillmentBranch,'Superadmin panelidan yangilandi'),`Buyurtma "${labels[next[order.status]]}" holatiga o'tkazildi`)}>{busy?'Bajarilmoqda\u2026':`${labels[next[order.status]]} holatiga o'tkazish`}</button>
    </div>}
    {order.status==='ready'&&<div className="admin-order-action"><label><span className="label">Kuryer</span><select className="select" value={courierId} onChange={e=>setCourierId(e.target.value)}><option value="">Kuryerni tanlang</option>{couriers.map(c=><option key={c.id} value={c.id}>{c.full_name}</option>)}</select></label><button className="btn btn-primary" disabled={busy||!courierId} onClick={()=>run(()=>assignOrderCourier(order.id,courierId),'Kuryer biriktirildi')}><Truck/> Kuryerga berish</button></div>}
    {['new','confirmed','processing','ready','assigned'].includes(order.status)&&<div className="admin-order-cancel"><textarea className="textarea" value={reason} onChange={e=>setReason(e.target.value)} placeholder="Bekor qilish sababi"/><button className="btn btn-danger" disabled={busy||!reason.trim()||!fulfillmentBranch} onClick={()=>run(()=>managerCancelOnlineOrder(order.id,fulfillmentBranch,reason.trim()),'Buyurtma bekor qilindi')}><XCircle/> Bekor qilish</button></div>}
    {order.delivery&&<div className="admin-delivery-info"><Truck/><span><b>{order.delivery.tracking_code}</b><small>{order.delivery.status}</small></span></div>}
    <AdminOrderReceiptDelivery order={order}/>
    <div style={{marginTop:16,paddingTop:12,borderTop:'1px solid rgba(226,232,240,0.8)',display:'flex',justifyContent:'flex-end'}}>
      <button type="button" className="btn btn-outline" style={{borderColor:'#ef4444',color:'#ef4444'}} onClick={()=>onDelete?.(order)}>
        <Trash2 size={15}/> Buyurtmani o‘chirish
      </button>
    </div>
  </div></Modal>;
}
function AdminOrderReceiptDelivery({order}){const[delivery,setDelivery]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[idempotencyKey,setIdempotencyKey]=useState(()=>crypto.randomUUID());useEffect(()=>{let active=true;setDelivery(null);setError('');setIdempotencyKey(crypto.randomUUID());if(order?.status==='delivered')getReceiptDeliveryStatus({orderId:order.id}).then(value=>active&&setDelivery(value)).catch(current=>active&&setError(current.message||String(current)));return()=>{active=false}},[order?.id,order?.status]);useEffect(()=>{if(!delivery?.id||!['pending','processing'].includes(delivery.status))return;const timer=setInterval(()=>getReceiptDeliveryStatus({deliveryId:delivery.id}).then(setDelivery).catch(()=>{}),4000);return()=>clearInterval(timer)},[delivery?.id,delivery?.status]);if(order?.status!=='delivered')return null;const queue=async()=>{setBusy(true);setError('');try{const key=delivery?.status==='dead'?crypto.randomUUID():idempotencyKey;if(key!==idempotencyKey)setIdempotencyKey(key);setDelivery(await queueOrderReceipt({orderId:order.id,idempotencyKey:key}))}catch(current){setError(current.message||'Elektron chek navbatga qo‘yilmadi.')}finally{setBusy(false)}};const locked=['pending','processing','sent','ambiguous'].includes(delivery?.status);return <div className="admin-receipt-delivery"><div><Mail/><span><b>Elektron chek</b><small className={delivery?.status==='ambiguous'?'receipt-ambiguous':''}>{delivery?.message||'Buyurtmadagi mijoz emailiga yuborish'}</small></span><button type="button" className="btn btn-primary" disabled={busy||locked} onClick={queue}><Send/>{busy?'Navbatga…':delivery?.status==='dead'?'Qayta urinish':delivery?'Holati saqlandi':'Yuborish'}</button></div>{delivery?.recipient_hint&&<small>{delivery.recipient_hint}</small>}{error&&<small className="receipt-error">{error}</small>}</div>}
function OrderStatus({value}){return <Status type={value==='delivered'?'green':value==='cancelled'||value==='returned'?'red':value==='new'?'orange':'blue'}>{labels[value]||value}</Status>}
function State({text,error,retry}){return <div className={'admin-workspace-state '+(error?'error':'')}>{error?<AlertTriangle/>:<Package/>}<b>{text}</b>{retry&&<button className="btn" onClick={retry}>Qayta urinish</button>}</div>}
function address(value){if(typeof value==='string')return value;if(value?.address)return value.address;if(!value)return'—';return Object.values(value).filter(v=>typeof v==='string'||typeof v==='number').join(', ')||'—'}
