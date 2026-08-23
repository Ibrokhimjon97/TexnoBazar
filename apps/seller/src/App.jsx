import React,{useEffect,useMemo,useState}from'react';
import{Bell}from'lucide-react';
import{AccountMenu,ThemeToggle,Toast,useAuth}from'@texnobazar/ui';
import PosWorkspace from'./PosWorkspace';

export default function App(){
  const{profile,roles}=useAuth();
  const[toast,setToast]=useState('');
  const[branchId,setBranchId]=useState('');
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
  return <div className="seller-shell"><div className="seller">
    <header><div><span>Xush kelibsiz,</span><b>{profile?.full_name||profile?.email}</b><small>{branch?.name||'Filial tanlanmoqda…'}</small></div>{sellerBranches.length>1&&<select className="select" value={branchId} onChange={event=>selectBranch(event.target.value)} aria-label="Seller filiali">{sellerBranches.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}<ThemeToggle/><button type="button" className="icon-btn" aria-label="Bildirishnomalar"><Bell/></button><AccountMenu compact/></header>
    {branch?<PosWorkspace key={branch.id} branchId={branch.id} profile={profile} toast={setToast}/>:<main className="pos-real-state"><p>Filial tanlanmoqda…</p></main>}
    <Toast message={toast} onClose={()=>setToast('')}/>
  </div></div>;
}
