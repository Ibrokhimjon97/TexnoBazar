import React,{useState}from'react';
import{BarChart3,Bot,ClipboardList,History,LayoutDashboard,Menu,Package,PanelsTopLeft,Settings2,ShoppingCart,Store,Truck,Users,WalletCards,Warehouse,X}from'lucide-react';
import{AccountMenu,Toast,useAuth}from'@texnobazar/ui';
import MasterData from'./MasterData';
import ProductCatalog from'./ProductCatalog';
import InventoryOverview from'./InventoryOverview';
import AdminDashboardWorkspace from'./AdminDashboardWorkspace';
import AdminOrdersWorkspace from'./AdminOrdersWorkspace';
import AdminReportsWorkspace from'./AdminReportsWorkspace';
import CmsWorkspace from'./CmsWorkspace';
import AuditWorkspace from'./AuditWorkspace';
import EmployeesWorkspace from'./EmployeesWorkspace';
import AdminNotificationCenter from'./AdminNotificationCenter';
import TelegramWorkspace from'./TelegramWorkspace';

const nav=[['Asosiy',LayoutDashboard,'dashboard'],['Ma’lumotnomalar',Settings2,'master-data'],['Mahsulotlar',Package,'products'],['Ombor',Warehouse,'inventory'],['Filiallar',Store,'branches'],['Savdolar',ShoppingCart,'sales'],['Buyurtmalar',ClipboardList,'orders'],['Moliya',WalletCards,'finance'],['Xodimlar',Users,'employees'],['Ta’minotchilar',Truck,'suppliers'],['Hisobotlar',BarChart3,'reports'],['Sayt boshqaruvi',PanelsTopLeft,'cms'],['Telegram bot',Bot,'telegram'],['Audit jurnali',History,'audit']];
const pageNames=Object.fromEntries(nav.map(item=>[item[2],item[0]]));
export default function App(){const{profile}=useAuth(),[page,setPage]=useState('dashboard'),[collapsed,setCollapsed]=useState(false),[mobile,setMobile]=useState(false),[toast,setToast]=useState('');const go=value=>{setPage(value);setMobile(false)};return <div className={'admin '+(collapsed?'collapsed':'')}><Sidebar page={page} go={go} collapsed={collapsed} setCollapsed={setCollapsed} mobile={mobile} setMobile={setMobile}/><div className="admin-main"><Topbar title={pageNames[page]} setMobile={setMobile} profileId={profile?.id}/><div className="admin-content"><Workspace page={page} go={go} toast={setToast}/></div></div><Toast message={toast} onClose={()=>setToast('')}/></div>}
function Workspace({page,go,toast}){if(page==='dashboard')return <AdminDashboardWorkspace go={go}/>;if(page==='master-data')return <MasterData toast={toast}/>;if(page==='products')return <ProductCatalog toast={toast}/>;if(page==='inventory')return <InventoryOverview/>;if(page==='branches')return <MasterData initialTab="branches" toast={toast}/>;if(page==='sales')return <AdminReportsWorkspace initialType="sales"/>;if(page==='orders')return <AdminOrdersWorkspace toast={toast}/>;if(page==='finance')return <AdminReportsWorkspace initialType="finance"/>;if(page==='employees')return <EmployeesWorkspace toast={toast}/>;if(page==='suppliers')return <MasterData initialTab="suppliers" toast={toast}/>;if(page==='reports')return <AdminReportsWorkspace initialType="sales" picker/>;if(page==='cms')return <CmsWorkspace toast={toast}/>;if(page==='telegram')return <TelegramWorkspace toast={toast}/>;if(page==='audit')return <AuditWorkspace/>;return null}
function Sidebar({page,go,collapsed,setCollapsed,mobile,setMobile}){return <aside className={'sidebar '+(mobile?'mobile-open':'')}><div className="side-logo"><span>T</span>{!collapsed&&<b>texnobazar</b>}<button className="side-close" onClick={()=>setMobile(false)}><X/></button></div><nav>{nav.map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)} title={title}><Icon/>{!collapsed&&<span>{title}</span>}</button>)}</nav><button className="collapse" onClick={()=>setCollapsed(!collapsed)}><Menu/>{!collapsed&&'Yon panelni yig‘ish'}</button></aside>}
function Topbar({title,setMobile,profileId}){const today=new Intl.DateTimeFormat('uz-UZ',{day:'numeric',month:'long',year:'numeric',weekday:'long'}).format(new Date());return <header className="topbar"><button className="icon-btn top-menu" onClick={()=>setMobile(true)}><Menu/></button><div><h1>{title}</h1><span>{today}</span></div><div className="topbar-spacer"/><AdminNotificationCenter profileId={profileId}/><AccountMenu/></header>}
