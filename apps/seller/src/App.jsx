import React,{useCallback,useEffect,useMemo,useRef,useState}from'react';
import{Bell,Check,X}from'lucide-react';
import{AccountMenu,Status,ThemeToggle,Toast,useAuth}from'@texnobazar/ui';
import{listNotifications,markNotificationsRead,subscribeNotifications}from'@texnobazar/data';
import PosWorkspace from'./PosWorkspace';

function NotificationCenter({profileId,onOpenItem}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const[showAll,setShowAll]=useState(false);
  const wrapRef=useRef(null);

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
  useEffect(()=>{
    if(!profileId)return;
    const tick=()=>{
      if(typeof document === 'undefined' || document.visibilityState === 'visible'){
        load();
      }
    };
    const timer=setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return()=>{
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  },[profileId,load]);

  // Tashqariga bosilganda yopish
  useEffect(()=>{
    if(!open)return;
    const handleOutside=(e)=>{
      if(wrapRef.current&&!wrapRef.current.contains(e.target)){
        setOpen(false);
      }
    };
    document.addEventListener('mousedown',handleOutside);
    document.addEventListener('touchstart',handleOutside);
    return()=>{
      document.removeEventListener('mousedown',handleOutside);
      document.removeEventListener('touchstart',handleOutside);
    };
  },[open]);

  const mark=async ids=>{
    try{
      await markNotificationsRead(ids);
      await load();
      if(!ids){
        setTimeout(()=>setOpen(false),800);
      }
    }catch(e){setError(String(e?.message||e));}
  };

  const openItem=item=>{
    if(!item.read_at)mark([item.id]);
    setOpen(false);
    if(item?.data?.pending_sale_id)onOpenItem?.(item);
  };

  const displayItems=showAll?items:items.filter(item=>!item.read_at);

  return (
    <div className="seller-notifications" ref={wrapRef} style={{position:'relative'}}>
      <button
        type="button"
        className="icon-btn"
        onClick={()=>setOpen(v=>!v)}
        aria-label={`Bildirishnomalar${unread?`: ${unread} ta yangi`:''}`}
      >
        <Bell/>
        {unread>0&&<i className="notif-badge">{unread>99?'99+':unread}</i>}
      </button>
      {open&&(
        <div className="admin-notification-panel" style={{position:'absolute',right:0,top:'100%',zIndex:300}}>
          <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderBottom:'1px solid var(--line)'}}>
            <div>
              <b>Bildirishnomalar</b>
              <small>{unread} ta o'qilmagan</small>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              {items.length>0&&(
                <button
                  type="button"
                  onClick={()=>setShowAll(v=>!v)}
                  style={{
                    border:'1px solid var(--line)',
                    background:showAll?'var(--surface-2, #f1f5f9)':'transparent',
                    borderRadius:6,
                    padding:'3px 8px',
                    fontSize:10,
                    cursor:'pointer',
                    color:'var(--text)',
                    fontWeight:600
                  }}
                >
                  {showAll?'Faqat yangilar':`Barchasi (${items.length})`}
                </button>
              )}
              <button
                type="button"
                disabled={!unread}
                onClick={()=>mark(null)}
                style={{
                  border:0,
                  background:'none',
                  color:unread?'var(--orange)':'var(--muted)',
                  fontSize:11,
                  fontWeight:700,
                  cursor:unread?'pointer':'default'
                }}
              >
                Barchasini o'qish
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={()=>setOpen(false)}
                aria-label="Yopish"
                style={{width:24,height:24,display:'grid',placeItems:'center',borderRadius:'50%',cursor:'pointer',border:0,padding:0,color:'var(--muted)'}}
              >
                <X size={14}/>
              </button>
            </div>
          </header>
          {loading?(
            <p style={{padding:20,textAlign:'center'}}>Yuklanmoqda…</p>
          ):error?(
            <p className="error" style={{padding:20,textAlign:'center'}}>{error}</p>
          ):displayItems.length===0?(
            <div style={{padding:'24px 16px',textAlign:'center'}}>
              <Check size={24} style={{color:'#16a34a',margin:'0 auto 6px',display:'block'}}/>
              <b>{showAll?'Bildirishnoma yo‘q':'O‘qilmagan bildirishnoma yo‘q'}</b>
              <p style={{margin:'4px 0 0',fontSize:11,color:'var(--muted)'}}>
                {showAll?'Hozircha hech qanday bildirishnoma mavjud emas.':'Barcha bildirishnomalar o‘qilgan.'}
              </p>
              {!showAll&&items.length>0&&(
                <button
                  type="button"
                  style={{
                    margin:'10px auto 0',
                    fontSize:11,
                    padding:'4px 10px',
                    border:'1px solid var(--line)',
                    borderRadius:8,
                    background:'var(--surface-2, #f8fafc)',
                    color:'var(--text)',
                    cursor:'pointer',
                    display:'block'
                  }}
                  onClick={()=>setShowAll(true)}
                >
                  O‘qilganlarni ko‘rish ({items.length})
                </button>
              )}
            </div>
          ):(
            <div>
              {displayItems.map(item=>(
                <button key={item.id} className={item.read_at?'':'unread'} onClick={()=>openItem(item)}>
                  <span>
                    <b>{item.title}</b>
                    <small>{item.body}</small>
                    <time>{new Date(item.created_at).toLocaleString('uz-UZ')}</time>
                  </span>
                  {!item.read_at&&<Status type="orange">Yangi</Status>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('Seller App Error Boundary caught:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, margin: '32px auto', maxWidth: 480, background: '#fff', borderRadius: 12, border: '1px solid #fed7aa', boxShadow: '0 4px 16px rgba(0,0,0,0.06)', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h3 style={{ margin: '0 0 8px', color: '#9a3412', fontSize: 18 }}>Kutilmagan xatolik yuz berdi</h3>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 20, lineHeight: 1.5 }}>
            {this.state.error?.message || 'Amal bajarilishida xatolik yuz berdi.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Qaytadan urinish
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Sahifani yangilash (F5)
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App(){
  const{profile,roles}=useAuth();
  const[toast,setToast]=useState('');
  const[branchId,setBranchId]=useState(()=>{
    try {
      const cached = JSON.parse(localStorage.getItem('texnobazar_auth_context') || '{}');
      const pId = cached?.profile?.id;
      if (pId) {
        const stored = localStorage.getItem(`texnobazar:seller-branch:${pId}`);
        if (stored) return stored;
      }
    } catch {}
    return '';
  });
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
    <ErrorBoundary>
      {branch?<PosWorkspace key={branch.id} branchId={branch.id} profile={profile} toast={setToast} focusPendingSaleId={focusPendingSaleId} clearFocus={()=>setFocusPendingSaleId(null)}/>:<main className="pos-real-state"><p>Filial tanlanmoqda…</p></main>}
    </ErrorBoundary>
    <Toast message={toast} onClose={()=>setToast('')}/>
  </div></div>;
}
