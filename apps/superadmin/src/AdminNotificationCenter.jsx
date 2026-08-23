import React,{useCallback,useEffect,useRef,useState}from'react';
import{Bell}from'lucide-react';
import{Status}from'@texnobazar/ui';
import{listNotifications,markNotificationsRead,subscribeNotifications}from'@texnobazar/data';
const SOUND_URL='/notification.wav';
export default function AdminNotificationCenter({profileId}){
  const[open,setOpen]=useState(false),[items,setItems]=useState([]),[unread,setUnread]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const prevUnread=useRef(-1);
  const audioRef=useRef(null);

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

  const mark=async ids=>{try{await markNotificationsRead(ids);await load()}catch(e){setError(e.message||String(e))}};

  return <div className="admin-notifications">
    <button className="icon-btn" onClick={()=>setOpen(v=>!v)} aria-label="Bildirishnomalar"><Bell/>{unread>0&&<i className="notif-badge">{unread}</i>}</button>
    {open&&<div className="admin-notification-panel">
      <header><div><b>Bildirishnomalar</b><small>{unread} ta o'qilmagan</small></div><button disabled={!unread} onClick={()=>mark(null)}>Barchasini o'qish</button></header>
      {loading?<p>Yuklanmoqda\u2026</p>:error?<p className="error">{error}</p>:items.length===0?<p>Bildirishnoma yo'q.</p>:<div>{items.map(item=><button key={item.id} className={item.read_at?'':'unread'} onClick={()=>!item.read_at&&mark([item.id])}><span><b>{item.title}</b><small>{item.body}</small><time>{new Date(item.created_at).toLocaleString('uz-UZ')}</time></span>{!item.read_at&&<Status type="orange">Yangi</Status>}</button>)}</div>}
    </div>}
  </div>;
}
