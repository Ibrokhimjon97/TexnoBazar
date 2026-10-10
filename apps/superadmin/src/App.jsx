import React,{useState}from'react';
import{Archive,BarChart3,Bot,CalendarCheck,Sparkles,ClipboardList,History,LayoutDashboard,Menu,Package,PanelsTopLeft,Settings2,ShoppingCart,Star,Store,Truck,Users,WalletCards,Warehouse,X}from'lucide-react';
import{AccountMenu,AiChat,ThemeToggle,Toast,useAuth}from'@texnobazar/ui';
import{formatUzDate}from'@texnobazar/data';
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
import BackupWorkspace from'./BackupWorkspace';
import AdminAttendanceWorkspace from'./AdminAttendanceWorkspace';

const nav=[['Asosiy',LayoutDashboard,'dashboard'],['Filiallar',Store,'branches'],['Tovarlar',Warehouse,'inventory'],['Zahira va Tiklash',Archive,'backup'],['Sotuvlar tarixi',ShoppingCart,'sales-history'],['Buyurtmalar',ClipboardList,'orders'],['Xarajatlar',WalletCards,'expenses'],['Xodimlar',Users,'employees'],['Xodimlar davomati',CalendarCheck,'attendance'],['Hisobotlar',BarChart3,'reports'],['Ma’lumotnomalar',Settings2,'master-data'],['Sayt boshqaruvi',PanelsTopLeft,'cms'],['AI yordamchi',Sparkles,'ai-chat'],['AI sozlamalari',Bot,'ai-settings'],['Telegram bot',Bot,'telegram'],['Sharhlar',Star,'reviews'],['Audit jurnali',History,'audit']];
const pageNames=Object.fromEntries(nav.map(item=>[item[2],item[0]]));
export default function App(){const{profile}=useAuth(),[page,setPage]=useState(()=>localStorage.getItem('tb_admin_page')||'dashboard'),[collapsed,setCollapsed]=useState(false),[mobile,setMobile]=useState(false),[toast,setToast]=useState(''),[focusTarget,setFocusTarget]=useState(null);const go=value=>{setPage(value);setMobile(false);localStorage.setItem('tb_admin_page',value)};const onNavigate=target=>{if(!target)return;go(target.page);setFocusTarget(target)};return <div className={'admin '+(collapsed?'collapsed':'')}><Sidebar page={page} go={go} collapsed={collapsed} setCollapsed={setCollapsed} mobile={mobile} setMobile={setMobile}/><div className="admin-main"><Topbar title={pageNames[page]} setMobile={setMobile} profileId={profile?.id} onNavigate={onNavigate}/><div className="admin-content"><Workspace page={page} go={go} toast={setToast} focusTarget={focusTarget} clearFocusTarget={()=>setFocusTarget(null)}/></div></div><Toast message={toast} onClose={()=>setToast('')}/></div>}
function Workspace({page,go,toast,focusTarget,clearFocusTarget}){if(page==='dashboard')return <AdminDashboardWorkspace go={go}/>;if(page==='master-data')return <MasterData toast={toast}/>;if(page==='inventory')return <InventoryOverview toast={toast}/>;if(page==='backup')return <BackupWorkspace toast={toast}/>;if(page==='branches')return <BranchesWorkspace toast={toast}/>;if(page==='sales-history')return <SalesHistoryWorkspace/>;if(page==='orders')return <AdminOrdersWorkspace toast={toast} focusOrderId={focusTarget?.page==='orders'?focusTarget.orderId:null} focusOrderNo={focusTarget?.page==='orders'?focusTarget.orderNo:null} clearFocus={clearFocusTarget}/>;if(page==='expenses')return <ExpensesWorkspace toast={toast}/>;if(page==='employees')return <EmployeesWorkspace toast={toast}/>;if(page==='attendance')return <AdminAttendanceWorkspace toast={toast}/>;if(page==='reports')return <AdminReportsWorkspace initialType="sales" picker toast={toast}/>;if(page==='cms')return <CmsWorkspace toast={toast}/>;if(page==='telegram')return <TelegramWorkspace toast={toast}/>;if(page==='ai-chat')return <AiChat/>;if(page==='ai-settings')return <AiSettingsWorkspace toast={toast}/>;if(page==='audit')return <AuditWorkspace/>;if(page==='reviews')return <ReviewsWorkspace toast={toast}/>;return null}
function Sidebar({page,go,collapsed,setCollapsed,mobile,setMobile}){return <aside className={'sidebar '+(mobile?'mobile-open':'')}><div className="side-logo"><span>T</span>{!collapsed&&<b>texnobazar</b>}<button className="side-close" onClick={()=>setMobile(false)}><X/></button></div><nav>{nav.map(([title,Icon,key])=><button key={key} className={page===key?'active':''} onClick={()=>go(key)} title={title}><Icon/>{!collapsed&&<span>{title}</span>}</button>)}</nav><button className="collapse" onClick={()=>setCollapsed(!collapsed)}><Menu/>{!collapsed&&'Yon panelni yig’ish'}</button></aside>}
function Topbar({title,setMobile,profileId,onNavigate}){const today=formatUzDate(new Date(),{day:true,month:'long',year:true,weekday:'long'});return <header className="topbar"><button className="icon-btn top-menu" onClick={()=>setMobile(true)}><Menu/></button><div><h1>{title}</h1><span>{today}</span></div><div className="topbar-spacer"/><ThemeToggle/><AdminNotificationCenter profileId={profileId} onNavigate={onNavigate}/><AccountMenu/></header>}
