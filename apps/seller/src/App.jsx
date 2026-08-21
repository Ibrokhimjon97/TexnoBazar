import React,{useState}from'react';
import{Bell}from'lucide-react';
import{AccountMenu,ThemeToggle,Toast,useAuth}from'@texnobazar/ui';
import PosWorkspace from'./PosWorkspace';

export default function App(){
  const{profile,branch}=useAuth();
  const[toast,setToast]=useState('');
  return <div className="seller-shell"><div className="seller">
    <header><div><span>Xush kelibsiz,</span><b>{profile?.full_name||profile?.email}</b></div><ThemeToggle/><button type="button" className="icon-btn" aria-label="Bildirishnomalar"><Bell/></button><AccountMenu compact/></header>
    <PosWorkspace branchId={branch?.id} profile={profile} toast={setToast}/>
    <Toast message={toast} onClose={()=>setToast('')}/>
  </div></div>;
}
