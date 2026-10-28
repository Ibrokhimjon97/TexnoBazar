export {DualPriceInput, DualPrice, useExchangeRate, formatDualMoney} from './DualPriceInput.jsx';
export {QrScannerModal, QrScanButton} from './QrScannerModal.jsx';
export {AiChat} from './AiChat.jsx';
export {ColorVariantEditor, BASE_COLOR_PALETTE, detectColorFromImageSource, findClosestColor} from './ColorVariantEditor.jsx';
export {ProductExcelImportModal} from './ProductExcelImportModal.jsx';
export {ProductEditor} from './ProductEditor.jsx';
export {ProductComponentEditor} from './ProductComponentEditor.jsx';
export {SearchableCategoryPicker, SearchableBrandPicker, saveStoredRecent, RECENT_CATS_KEY, RECENT_BRANDS_KEY} from './CategoryBrandPickers.jsx';
export * from './thermalReceipt.jsx';
export * from './ProductDeliveryStickersModal.jsx';
export * from './detongerBluetooth.js';
export * from './mhtBluetooth.js';
export * from './DetongerPrintModal.jsx';
export * from './backgroundKeepAlive.js';
export * from './Skeleton.jsx';
import React,{useEffect} from 'react';
export * from './auth.jsx';
import {X,CheckCircle2,Inbox} from 'lucide-react';

export const products=[
{id:1,name:'Samsung Crystal UHD 55" 4K Smart TV',category:'Televizorlar',brand:'Samsung',price:6999000,old:7899000,monthly:583250,rating:4.9,reviews:128,stock:18,badge:'−11%',color:'#e7eef9',image:'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?auto=format&fit=crop&w=700&q=80',specs:['55 dyuym Crystal UHD','4K 3840×2160','Tizen Smart TV','Wi-Fi, Bluetooth']},
{id:2,name:'Apple iPhone 15 Pro 256 GB',category:'Smartfonlar',brand:'Apple',price:14999000,old:16200000,monthly:1249917,rating:4.8,reviews:91,stock:7,badge:'Top',color:'#eee9e4',image:'https://images.unsplash.com/photo-1695048133142-1a20484d2569?auto=format&fit=crop&w=700&q=80',specs:['6.1 dyuym Super Retina','A17 Pro chip','48 MP kamera','Titan korpus']},
{id:3,name:'LG inverter muzlatgichi 341 litr',category:'Muzlatgichlar',brand:'LG',price:8299000,old:8999000,monthly:691583,rating:4.7,reviews:64,stock:12,badge:'Aksiya',color:'#ecf3f6',image:'https://images.unsplash.com/photo-1571175443880-49e1d25b2bc5?auto=format&fit=crop&w=700&q=80',specs:['341 litr sig‘im','Door Cooling+','Inverter kompressor','A++ energiya klassi']},
{id:4,name:'Dyson V12 Detect Slim changyutgich',category:'Changyutgichlar',brand:'Dyson',price:7199000,old:7850000,monthly:599917,rating:4.9,reviews:39,stock:5,badge:'Yangi',color:'#f3eee8',image:'https://images.unsplash.com/photo-1558317374-067fb5f30001?auto=format&fit=crop&w=700&q=80',specs:['Lazer aniqlash','60 daqiqa ishlash','HEPA filtr','2.2 kg']},
{id:5,name:'Bosch kir yuvish mashinasi 9 kg',category:'Kir yuvish',brand:'Bosch',price:7599000,old:8299000,monthly:633250,rating:4.8,reviews:76,stock:9,badge:'−8%',color:'#ebf0f5',image:'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?auto=format&fit=crop&w=700&q=80',specs:['9 kg yuklama','1200 ayl/min','EcoSilence Drive','A+++ klass']},
{id:6,name:'MacBook Air M2 13" 256 GB',category:'Noutbuklar',brand:'Apple',price:12999000,old:13999000,monthly:1083250,rating:4.9,reviews:112,stock:14,badge:'Bestseller',color:'#edf0f2',image:'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=700&q=80',specs:['Apple M2 chip','8 GB unified memory','256 GB SSD','18 soat batareya']},
{id:7,name:'Artel konditsioner Everest 12',category:'Konditsionerlar',brand:'Artel',price:4799000,old:5299000,monthly:399917,rating:4.6,reviews:54,stock:21,badge:'Mahalliy',color:'#e8f5f6',image:'https://images.unsplash.com/photo-1631545806609-72d1ec6a96ab?auto=format&fit=crop&w=700&q=80',specs:['35 m² gacha','Inverter','Wi-Fi boshqaruv','Issiq/sovuq']},
{id:8,name:'JBL Charge 5 portativ akustika',category:'Audio',brand:'JBL',price:1899000,old:2199000,monthly:158250,rating:4.8,reviews:143,stock:28,badge:'−14%',color:'#fff0e8',image:'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=700&q=80',specs:['20 soat musiqa','IP67 himoya','Bluetooth 5.1','Powerbank']}
];
export const formatMoney=n=>new Intl.NumberFormat('uz-UZ').format(n)+' so‘m';
export function Toast({message,onClose}){useEffect(()=>{const t=setTimeout(onClose,2600);return()=>clearTimeout(t)},[message]);return message?<div className="toast"><CheckCircle2 size={19} color="#4ade80"/>{message}<button onClick={onClose} style={{background:'none',border:0,color:'#fff',marginLeft:8}}><X size={17}/></button></div>:null}
export function Modal({open,onClose,title,children,wide=false}){useEffect(()=>{if(!open)return;const handler=e=>{if(e.key==='Escape')onClose?.()};document.addEventListener('keydown',handler);return()=>document.removeEventListener('keydown',handler)},[open,onClose]);if(!open)return null;return <div className="overlay" onMouseDown={e=>e.target===e.currentTarget&&onClose?.()}><div className={"modal"+(wide?' modal-wide':'')}><div className="modal-header between"><h2 className="section-title">{title}</h2><button type="button" className="icon-btn modal-close-btn" onClick={onClose} aria-label="Yopish"><X size={19}/></button></div><div className="modal-body-scroll">{children}</div></div></div>}
export function Empty({title='Ma’lumot topilmadi',text='Bu bo‘limda hozircha yozuvlar mavjud emas.'}){return <div className="empty"><Inbox size={42} strokeWidth={1.5}/><h3>{title}</h3><p>{text}</p></div>}
export function Status({children,type='gray'}){return <span className={'badge '+type}>{children}</span>}
export function KpiCard({icon:Icon,label,value,change,color='orange'}){return <div className="card pad kpi"><div className={'kpi-icon '+color}><Icon size={21}/></div><div><div className="muted small">{label}</div><div className="kpi-value">{value}</div>{change&&<div className="small" style={{color:change.startsWith('+')?'var(--green)':'var(--muted)'}}>{change}</div>}</div></div>}
export function MiniBars({values=[30,55,42,70,62,88,76],height=130}){return <div className="mini-bars" style={{height}}>{values.map((v,i)=><div key={i} className="bar" style={{height:v+'%'}}><span/></div>)}</div>}
export function Sparkline({values=[20,34,28,56,48,75,67,89]}){const max=Math.max(...values),points=values.map((v,i)=>`${i*(240/(values.length-1))},${90-v/max*72}`).join(' ');return <svg viewBox="0 0 240 100" preserveAspectRatio="none" className="spark"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f97316" stopOpacity=".3"/><stop offset="1" stopColor="#f97316" stopOpacity="0"/></linearGradient></defs><polyline points={`0,100 ${points} 240,100`} fill="url(#area)"/><polyline points={points} fill="none" stroke="#f97316" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>}

const THEME_STORAGE_KEY='tb_theme';
const preferredTheme=()=>{if(typeof window==='undefined')return'light';const saved=window.localStorage?.getItem(THEME_STORAGE_KEY);return saved==='dark'||saved==='light'?saved:'light'};
const applyTheme=theme=>{if(typeof document!=='undefined'){document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;}};
applyTheme(preferredTheme());
export function ThemeToggle({className=''}){const[theme,setTheme]=React.useState(preferredTheme);React.useEffect(()=>applyTheme(theme),[theme]);const toggle=()=>setTheme(current=>{const next=current==='dark'?'light':'dark';try{window.localStorage.setItem(THEME_STORAGE_KEY,next)}catch{}return next});const dark=theme==='dark';return <button type="button" className={`theme-toggle ${className}`.trim()} onClick={toggle} aria-label={dark?'Yorug‘ rejimni yoqish':'Tungi rejimni yoqish'} title={dark?'Yorug‘ rejim':'Tungi rejim'}><span className="theme-toggle-icon" aria-hidden="true">{dark?<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>:<svg viewBox="0 0 24 24"><path d="M20.3 15.7A9 9 0 0 1 8.3 3.7 9 9 0 1 0 20.3 15.7Z"/></svg>}</span></button>}
