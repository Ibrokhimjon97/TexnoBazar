import React,{useCallback,useEffect,useRef,useState}from'react';
import{Bell,Check,X}from'lucide-react';
import{Status}from'@texnobazar/ui';
import{listNotifications,markNotificationsRead,subscribeNotifications}from'@texnobazar/data';
const SOUND_URL='/notification.wav';
function resolveNotificationTarget(data){
  if(!data)return null;
  if(data.order_id)return{page:'orders',orderId:data.order_id,orderNo:data.order_no};
  if(data.type?.startsWith('attendance'))return{page:'attendance'};
  return null;
}
export default function AdminNotificationCenter({profileId,onNavigate}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const[showAll,setShowAll]=useState(false);
  const prevUnread=useRef(-1);
  const audioRef=useRef(null);
  const wrapRef=useRef(null);

  const playSound=()=>{try{if(!audioRef.current)audioRef.current=new Audio(SOUND_URL);audioRef.current.currentTime=0;audioRef.current.play().catch(()=>{})}catch(e){}};

  const showBrowserNotification=(item)=>{if(!item||typeof Notification==='undefined'||Notification.permission!=='granted')return;try{new Notification(item.title||'Yangi bildirishnoma',{body:item.body||'',icon:'/favicon.ico'})}catch(e){}};

  const load=useCallback(async()=>{
    if(!profileId)return;setLoading(true);setError('');
    try{
      const data=await listNotifications({pageSize:30});
      setItems(data.items||[]);
      const count=Number(data.unread_count||0);
      if(prevUnread.current>=0&&count>prevUnread.current){playSound();showBrowserNotification(data.items?.[0])}
      prevUnread.current=count;
      setUnread(count);
    }catch(e){setError(e.message||'Bildirishnomalar yuklanmadi.')}finally{setLoading(false)}
  },[profileId]);

  useEffect(()=>{load()},[load]);
  useEffect(()=>profileId?subscribeNotifications(load,e=>setError(e.message||String(e)),profileId):undefined,[profileId,load]);
  useEffect(()=>{if(typeof Notification!=='undefined'&&Notification.permission==='default')Notification.requestPermission().catch(()=>{})},[]);

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
    }catch(e){setError(e.message||String(e))}
  };

  const openItem=item=>{
    if(!item.read_at)mark([item.id]);
    setOpen(false);
    const target=resolveNotificationTarget(item.data);
    if(target)onNavigate?.(target);
  };

  const displayItems=showAll?items:items.filter(item=>!item.read_at);

  return (
    <div className="admin-notifications" ref={wrapRef} style={{position:'relative'}}>
      <button className="icon-btn" onClick={()=>setOpen(v=>!v)} aria-label="Bildirishnomalar">
        <Bell/>
        {unread>0&&<i className="notif-badge">{unread}</i>}
      </button>
      {open&&(
        <div className="admin-notification-panel" style={{position:'absolute',right:0,top:'100%',zIndex:300}}>
          <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',borderBottom:'1px solid var(--line)'}}>
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
                style={{width:26,height:26,display:'grid',placeItems:'center',borderRadius:'50%',cursor:'pointer',border:0,padding:0,color:'var(--muted)'}}
              >
                <X size={15}/>
              </button>
            </div>
          </header>
          {loading?(
            <p style={{padding:20,textAlign:'center'}}>Yuklanmoqda…</p>
          ):error?(
            <p className="error" style={{padding:20,textAlign:'center'}}>{error}</p>
          ):displayItems.length===0?(
            <div style={{padding:'24px 16px',textAlign:'center'}}>
              <Check size={26} style={{color:'#16a34a',margin:'0 auto 6px',display:'block'}}/>
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
