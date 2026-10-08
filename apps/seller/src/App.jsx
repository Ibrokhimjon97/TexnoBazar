import React,{useCallback,useEffect,useMemo,useState}from'react';
import{Bell}from'lucide-react';
import{AccountMenu,ThemeToggle,Toast,useAuth}from'@texnobazar/ui';
import{listNotifications,markNotificationsRead,subscribeNotifications}from'@texnobazar/data';
import PosWorkspace from'./PosWorkspace';

function NotificationCenter({profileId,onOpenItem}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const load=useCallback(async()=>{
    if(!profileId)return;
    setLoading(true);setError('');
    try{
      const result=await listNotifications({pageSize:30});
      setItems(result?.items||[]);setUnread(Number(result?.unread_count||0));
    }catch(e){setError(String(e?.message||'Bildirishnomalar yuklanmadi.'));}
    finally{setLoading(false);}
  },[profileId]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{if(!profileId)return;return subscribeNotifications(load,e=>setError(String(e?.message||e)),profileId);},[profileId,load]);
  useEffect(()=>{if(!profileId)return;const timer=setInterval(load,20000);return()=>clearInterval(timer);},[profileId,load]);
  const mark=async ids=>{try{await markNotificationsRead(ids);await load();}catch(e){setError(String(e?.message||e));}};
  const openItem=item=>{
    if(!item.read_at)mark([item.id]);
    setOpen(false);
    if(item?.data?.pending_sale_id)onOpenItem?.(item);
  };
  return <div className="seller-notifications" style={{position:'relative'}}>
    <button type="button" className="icon-btn" onClick={()=>setOpen(v=>!v)} aria-label={`Bildirishnomalar${unread?`: ${unread} ta yangi`:''}`}><Bell/>{unread>0&&<i className="notif-badge">{unread>99?'99+':unread}</i>}</button>
    {open&&<div className="admin-notification-panel" style={{position:'absolute',right:0,top:'100%'}}>
      <header><div><b>Bildirishnomalar</b><small>{unread} ta o'qilmagan</small></div><button disabled={!unread} onClick={()=>mark(null)}>Barchasini o'qish</button></header>
      {loading?<p>Yuklanmoqda…</p>:error?<p className="error">{error}</p>:items.length===0?<p>Bildirishnoma yo'q.</p>:<div>{items.map(item=><button key={item.id} className={item.read_at?'':'unread'} onClick={()=>openItem(item)}><span><b>{item.title}</b><small>{item.body}</small><time>{new Date(item.created_at).toLocaleString('uz-UZ')}</time></span></button>)}</div>}
    </div>}
  </div>;
}

export default function App(){
  const{profile,roles}=useAuth();
  const[toast,setToast]=useState('');
  const[branchId,setBranchId]=useState('');
  const[focusPendingSaleId,setFocusPendingSaleId]=useState(null);
  const sellerBranches=useMemo(()=>{
    const unique=new Map();
    for(const role of roles||[])if(role.role==='seller'&&role.branch_id&&!unique.has(role.branch_id))unique.set(role.branch_id,{id:role.branch_id,name:role.branch_name||'Filial',code:role.branch_code||''});
    return[...unique.values()];
  },[roles]);
  const branchSignature=sellerBranches.map(branch=>`${branch.id}:${branch.code}`).join('|');
  useEffect(()=>{
    const key=profile?.id?`texnobazar:seller-branch:${profile.id}`:null;
    const allowed=sellerBranches.map(branch=>branch.id);
    const stored=key?localStorage.getItem(key):null;
    const main=sellerBranches.find(branch=>branch.code==='MAIN');
    const next=stored&&allowed.includes(stored)?stored:(main?.id||allowed[0]||'');
    setBranchId(next);
    if(key&&next)localStorage.setItem(key,next);
  },[profile?.id,branchSignature]);
  const selectBranch=value=>{setBranchId(value);if(profile?.id)localStorage.setItem(`texnobazar:seller-branch:${profile.id}`,value)};
  const branch=sellerBranches.find(item=>item.id===branchId)||null;

  if(!sellerBranches.length)return <div className="seller-shell"><div className="seller"><main className="pos-real-state error"><p>Seller hisobiga faol filial biriktirilmagan. Administratorga murojaat qiling.</p></main></div></div>;
  const onNotificationNavigate=item=>{
    const id=item?.data?.pending_sale_id;
    if(id)setFocusPendingSaleId(id);
  };
  return <div className="seller-shell"><div className="seller">
    <header><div><span>Xush kelibsiz,</span><b>{profile?.full_name||profile?.email}</b><small>{branch?.name||'Filial tanlanmoqda…'}</small></div>{sellerBranches.length>1&&<select className="select" value={branchId} onChange={event=>selectBranch(event.target.value)} aria-label="Seller filiali">{sellerBranches.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}<ThemeToggle/><NotificationCenter profileId={profile?.id} onOpenItem={onNotificationNavigate}/><AccountMenu compact/></header>
    {branch?<PosWorkspace key={branch.id} branchId={branch.id} profile={profile} toast={setToast} focusPendingSaleId={focusPendingSaleId} clearFocus={()=>setFocusPendingSaleId(null)}/>:<main className="pos-real-state"><p>Filial tanlanmoqda…</p></main>}
    <Toast message={toast} onClose={()=>setToast('')}/>
  </div></div>;
}
