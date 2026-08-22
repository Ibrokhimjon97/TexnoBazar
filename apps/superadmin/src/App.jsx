import React,{useState}from'react';
import{BarChart3,Bot,Sparkles,ClipboardList,History,LayoutDashboard,Menu,Package,PanelsTopLeft,Settings2,ShoppingCart,Star,Store,Truck,Users,WalletCards,Warehouse,X}from'lucide-react';
import{AccountMenu,AiChat,ThemeToggle,Toast,useAuth}from'@texnobazar/ui';
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
import BranchesWorkspace from'./BranchesWorkspace';
import ExpensesWorkspace from'./ExpensesWorkspace';
import SalesHistoryWorkspace from'./SalesHistoryWorkspace';
import AiSettingsWorkspace from'./AiSettingsWorkspace';
import ReviewsWorkspace from'./ReviewsWorkspace';

const nav=[['Asosiy',LayoutDashboard,'dashboard'],['Filiallar',Store,'branches'],['Tovarlar',Warehouse,'inventory'],['Savdolar',ShoppingCart,'sales'],['Sotuvlar tarixi',ShoppingCart,'sales-history'],['Buyurtmalar',ClipboardList,'orders'],['Moliya',WalletCards,'finance'],['Xarajatlar',WalletCards,'expenses'],['Xodimlar',Users,'employees'],['Hisobotlar',BarChart3,'reports'],['Ma’lumotnomalar',Settings2,'master-data'],['Sayt boshqaruvi',PanelsTopLeft,'cms'],['AI yordamchi',Sparkles,'ai-chat'],['AI sozlamalari',Bot,'ai-settings'],['Telegram bot',Bot,'telegram'],['Sharhlar',Star,'reviews'],['Audit jurnali',History,'audit']];
const pageNames=Object.fromEntries(nav.map(item=>[item[2],item[0]]));
export default function App(){const{profile}=useAuth(),[page,setPage]=useState(()=>localStorage.getItem('tb_admin_page')||'dashboard'),[collapsed,setCollapsed]=useState(false),[mobile,setMobile]=useState(false),[toast,setToast]=useState('');const go=value=>{setPage(value);setMobile(false);localStorage.setItem('tb_admin_page',value)};return <div className={'admin '+(collapsed?'collapsed':'')}><Sidebar page={page} go={go} collapsed={collapsed} setCollapsed={setCollapsed} mobile={mobile} setMobile={setMobile}/><div className="admin-main"><Topbar title={pageNames[page]} setMobile={setMobile} profileId={profile?.id}/><div className="admin-content"><Workspace page={page} go={go} toast={setToast}/></div></div><Toast message={toast} onClose={()=>setToast('')}/></div>}
function Workspace({page,go,toast}){if(page==='dashboard')return <AdminDashboardWorkspace go={go}/>;if(page==='master-data')return <MasterData toast={toast}/>;if(page==='inventory')return <InventoryOverview toast={toast}/>;if(page==='branches')return <BranchesWorkspace toast={toast}/>;if(page==='sales')return <AdminReportsWorkspace initialType="sales"/>;if(page==='sales-history')return <SalesHistoryWorkspace/>;if(page==='orders')return <AdminOrdersWorkspace toast={toast}/>;if(page==='finance')return <AdminReportsWorkspace initialType="finance"/>;if(page==='expenses')return <ExpensesWorkspace toast={toast}/>;if(page==='employees')return <EmployeesWorkspace toast={toast}/>;if(page==='reports')return <AdminReportsWorkspace initialType="sales" picker/>;if(page==='cms')return <CmsWorkspace toast={toast}/>;if(page==='telegram')return <TelegramWorkspace toast={toast}/>;if(page==='ai-chat')return <AiChat/>;if(page==='ai-settings')return <AiSettingsWorkspace toast={toast}/>;if(page==='audit')return <AuditWorkspace/>;if(page==='reviews')return <ReviewsWorkspace toast={toast}/>;return null}
function Sidebar({page,go,collapsed,setCollapsed,mobile,setMobile}){return <aside className={'sidebar '+(mobile?'mobile-open':'')}><div className="side-logo"><span>T</span>{!collapsed&&<b>texnobazar</b>}<button className="side-close" onClick={()=>setMobile(false)}><X/></button></div><nav>{nav.map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)} title={title}><Icon/>{!collapsed&&<span>{title}</span>}</button>)}</nav><button className="collapse" onClick={()=>setCollapsed(!collapsed)}><Menu/>{!collapsed&&'Yon panelni yig’ish'}</button></aside>}
function Topbar({title,setMobile,profileId}){const today=new Intl.DateTimeFormat('uz-UZ',{day:'numeric',month:'long',year:'numeric',weekday:'long'}).format(new Date());return <header className="topbar"><button className="icon-btn top-menu" onClick={()=>setMobile(true)}><Menu/></button><div><h1>{title}</h1><span>{today}</span></div><div className="topbar-spacer"/><ThemeToggle/><AdminNotificationCenter profileId={profileId}/><AccountMenu/></header>}
