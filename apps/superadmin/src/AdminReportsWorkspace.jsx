import React,{useEffect,useMemo,useState}from'react';
import{AlertTriangle,BarChart3,Download,FileSpreadsheet,LineChart as LineIcon,PieChart as PieIcon,RefreshCw,Table2,TrendingUp}from'lucide-react';
import{Bar,BarChart,CartesianGrid,Cell,Legend,Line,LineChart,Pie,PieChart,ResponsiveContainer,Tooltip,XAxis,YAxis}from'recharts';
import{DualPrice,formatDualMoney,useExchangeRate}from'@texnobazar/ui';
import{listActiveBranches,reportDebts,reportFinance,reportInventory,reportInventoryCounts,reportProductPerformance,reportProfitLoss,reportSales,reportSellerPerformance,reportSuppliers}from'@texnobazar/data';
import{buildReportVisualization,columnLabels,downloadReportXlsx,reportLabels}from'./reporting';

const key=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const configs={
  sales:{title:'Savdolar',text:'Real savdolar, tannarx va foyda',load:(from,to,branch)=>reportSales(from,to,branch)},
  finance:{title:'Moliya',text:'Daromad va xarajat tranzaksiyalari',load:(from,to,branch)=>reportFinance(from,to,branch)},
  expenses:{title:'Xarajatlar',text:'Operatsion xarajatlar',load:async(from,to,branch)=>(await reportFinance(from,to,branch)).filter(row=>row.transaction_type==='expense')},
  debts:{title:'Filial qarzlari',text:'Debitor va kreditor majburiyatlari',load:(from,to,branch)=>reportDebts(from,to,branch)},
  suppliers:{title:'Yetkazib beruvchilar',text:'Kirim, to‘lov va qaytarishlar ledgeri',load:(from,to,branch)=>reportSuppliers(from,to,branch)},
  inventory:{title:'Ombor qoldig‘i',text:'Joylashuv kesimidagi real qoldiq',load:(_from,_to,branch)=>reportInventory(branch),undated:true},
  profit:{title:'Foyda va zarar',text:'P&L hisoboti',load:async(from,to,branch)=>[await reportProfitLoss(from,to,branch)]},
  sellers:{title:'Sotuvchilar',text:'Sotuvchi kesimidagi savdo samaradorligi',load:(from,to,branch)=>reportSellerPerformance(from,to,branch)},
  products:{title:'Mahsulotlar',text:'Mahsulot kesimidagi savdo va foyda',load:(from,to,branch)=>reportProductPerformance(from,to,branch)},
  counts:{title:'Inventarizatsiya',text:'Inventarizatsiya natijalari va farqlar',load:(from,to,branch)=>reportInventoryCounts(from,to,branch)},
};
const colors=['#f97316','#2563eb','#16a34a','#8b5cf6','#eab308','#dc2626','#0891b2','#64748b','#ec4899','#84cc16','#14b8a6','#a855f7'];
const moneyTick=value=>Math.abs(Number(value))>=1000000?`${(Number(value)/1000000).toFixed(1)} mln`:new Intl.NumberFormat('uz-UZ',{notation:'compact',maximumFractionDigits:1}).format(Number(value)||0);

export default function AdminReportsWorkspace({initialType='sales',picker=false,toast}){
  const rate=useExchangeRate();
  const[type,setType]=useState(initialType),[view,setView]=useState('table'),[branches,setBranches]=useState([]),[branchId,setBranchId]=useState(''),[from,setFrom]=useState(()=>{const date=new Date();date.setDate(date.getDate()-29);return key(date)}),[to,setTo]=useState(()=>key(new Date())),[rows,setRows]=useState([]),[loading,setLoading]=useState(true),[exporting,setExporting]=useState(false),[error,setError]=useState('');
  const config=configs[type]||configs.sales;
  const load=async()=>{setLoading(true);setError('');try{if(!config.undated&&(new Date(`${to}T00:00:00`)-new Date(`${from}T00:00:00`))/86400000>366)throw new Error('Brauzer eksporti uchun sana oralig‘i 366 kundan oshmasligi kerak.');const[result,branchRows]=await Promise.all([config.load(from,to,branchId||null),branches.length?Promise.resolve(branches):listActiveBranches()]);setRows(Array.isArray(result)?result:result?[result]:[]);setBranches(branchRows||[])}catch(currentError){setRows([]);setError(currentError.message||'Hisobot yuklanmadi.')}finally{setLoading(false)}};
  useEffect(()=>{load()},[type,branchId,from,to]);
  const totals=useMemo(()=>type==='finance'||type==='expenses'?{income:rows.filter(row=>row.transaction_type==='income').reduce((sum,row)=>sum+Number(row.amount),0),expense:rows.filter(row=>row.transaction_type==='expense').reduce((sum,row)=>sum+Number(row.amount),0)}:type==='sales'?{total:rows.reduce((sum,row)=>sum+Number(row.total),0),profit:rows.reduce((sum,row)=>sum+Number(row.profit),0)}:null,[rows,type]);
  const visualization=useMemo(()=>buildReportVisualization(type,rows),[type,rows]);
  const exportXlsx=async()=>{
    setExporting(true);
    try{
      const branch=branches.find(item=>item.id===branchId);
      await downloadReportXlsx({type,rows,branchName:branch?.code||branch?.name,branchId,from:config.undated?null:from,to:config.undated?null:to});
      toast?.('Excel hisobot yuklab olindi');
    }catch(currentError){
      console.error('Excel export error:', currentError);
      const isChunkError = currentError?.message?.includes('dynamically imported module') || 
                           currentError?.message?.includes('MIME type');
      if (isChunkError) {
        if (confirm('Ilovaning yangi versiyasi chiqdi. Excel faylni yuklab olish uchun sahifani yangilashni (refresh) xohlaysizmi?')) {
          window.location.reload();
          return;
        }
      }
      toast?.(currentError.message || 'Excel eksport yaratilmadi.') || alert(currentError.message || 'Excel eksport yaratilmadi.');
    }finally{
      setExporting(false);
    }
  };
  return <>
    <div className="page-head between"><div><h2>{picker?'Hisobotlar':config.title}</h2><p>{picker?'Biznes ma’lumotlarini jadval, grafik va haqiqiy XLSX ko‘rinishida oling.':config.text}</p></div><button className="btn btn-outline" disabled={!rows.length||exporting} onClick={exportXlsx}><Download/> {exporting?'XLSX tayyorlanmoqda…':'Excel XLSX'}</button></div>
    <div className="admin-filterbar">{picker&&<select className="select" value={type} onChange={event=>{setType(event.target.value);setView('table')}}>{Object.entries(configs).map(([value,item])=><option key={value} value={value}>{item.title}</option>)}</select>}<select className="select" value={branchId} onChange={event=>setBranchId(event.target.value)}><option value="">Barcha filiallar</option>{branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>{!config.undated&&<><input className="input" type="date" value={from} max={to} onChange={event=>setFrom(event.target.value)}/><input className="input" type="date" value={to} min={from} onChange={event=>setTo(event.target.value)}/></>}<button className="btn btn-outline" onClick={load}><RefreshCw/> Yangilash</button></div>
    {totals&&<div className="admin-report-kpis"><div><FileSpreadsheet/><span><small>Qatorlar</small><b>{rows.length}</b></span></div>{type==='sales'?<><div><TrendingUp/><span><small>Savdo</small><b><DualPrice value={totals.total} rate={rate}/></b></span></div><div><TrendingUp/><span><small>Foyda</small><b><DualPrice value={totals.profit} rate={rate}/></b></span></div></>:<><div><TrendingUp/><span><small>Daromad</small><b><DualPrice value={totals.income} rate={rate}/></b></span></div><div><AlertTriangle/><span><small>Xarajat</small><b><DualPrice value={totals.expense} rate={rate}/></b></span></div></>}</div>}
    <div className="report-view-tabs" role="tablist" aria-label="Hisobot ko‘rinishi">{[['table',Table2,'Jadval'],['bar',BarChart3,'Ustun'],['line',LineIcon,'Chiziq'],['pie',PieIcon,'Doira']].map(([value,Icon,label])=><button role="tab" aria-selected={view===value} key={value} className={view===value?'active':''} onClick={()=>setView(value)} disabled={(value==='line'&&!visualization.lineAvailable)||(value==='pie'&&!visualization.pieAvailable)}><Icon/>{label}</button>)}</div>
    {loading?<State text="Hisobot yuklanmoqda…"/>:error?<State text={error} error retry={load}/>:view==='table'?<DataTable rows={rows} rate={rate}/>:<ChartView type={type} view={view} data={visualization} rate={rate}/>} 
  </>
}

function ChartView({type,view,data,rate}){const source=view==='pie'?data.breakdown:data.series;if(view==='pie'&&!data.pieAvailable)return <State text="Bu hisobot uchun doiraviy ulush matematik jihatdan qo‘llanmaydi."/>;if(!source.length)return <State text="Grafik uchun ma’lumot yo‘q."/>;if(view==='line'&&!data.lineAvailable)return <State text="Chiziqli grafik uchun kamida ikki taqqoslash nuqtasi kerak."/>;return <section className="card report-chart" role="img" aria-label={`${reportLabels[type]||type} — ${view} grafik`}><header><div><h3>{reportLabels[type]||type}</h3><small>{view==='pie'?'Asosiy guruhlar ulushi':data.categorical?'Kategoriya bo‘yicha taqqoslash':'Vaqt bo‘yicha dinamika'}</small></div><b>{source.length} nuqta</b></header><div className="report-chart-canvas"><ResponsiveContainer width="100%" height="100%">{view==='bar'?<BarChart data={source}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="label" minTickGap={24}/><YAxis tickFormatter={moneyTick}/><Tooltip formatter={value=>formatDualMoney(Number(value),rate)}/><Legend/><Bar dataKey="value" name={data.metricLabel} fill="#f97316" radius={[6,6,0,0]}/>{source.some(item=>item.profit)&&<Bar dataKey="profit" name="Foyda" fill="#2563eb" radius={[6,6,0,0]}/>}</BarChart>:view==='line'?<LineChart data={source}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="label" minTickGap={24}/><YAxis tickFormatter={moneyTick}/><Tooltip formatter={value=>formatDualMoney(Number(value),rate)}/><Legend/><Line type="monotone" dataKey="value" name={data.metricLabel} stroke="#f97316" strokeWidth={3}/>{source.some(item=>item.profit)&&<Line type="monotone" dataKey="profit" name="Foyda" stroke="#2563eb" strokeWidth={3}/>}</LineChart>:<PieChart><Pie data={source} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius="76%" label={({label,percent})=>`${label} ${(percent*100).toFixed(0)}%`}>{source.map((item,index)=><Cell key={item.key} fill={colors[index%colors.length]}/>)}</Pie><Tooltip formatter={value=>formatDualMoney(Number(value),rate)}/><Legend/></PieChart>}</ResponsiveContainer></div></section>}
function DataTable({rows,rate}){const keys=useMemo(()=>[...new Set(rows.flatMap(row=>Object.keys(row||{})))],[rows]);if(!rows.length)return <State text="Tanlangan filtr bo‘yicha ma’lumot yo‘q."/>;return <div className="card data-card"><div className="table-wrap"><table className="table admin-dynamic-table"><thead><tr>{keys.map(column=><th key={column}>{columnLabels[column]||column.replaceAll('_',' ')}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={row.id||row.transaction_id||row.sale_no||row.count_id||index}>{keys.map(column=><td key={column}>{cell(row[column],rate)}</td>)}</tr>)}</tbody></table></div></div>}
function cell(value,rate){if(value==null)return'—';if(typeof value==='object')return <code title={JSON.stringify(value)}>{JSON.stringify(value)}</code>;if(typeof value==='number'&&Math.abs(value)>=1000)return <DualPrice value={value} rate={rate}/>;return String(value)}
function State({text,error,retry}){return <div className={'admin-workspace-state '+(error?'error':'')}>{error?<AlertTriangle/>:<FileSpreadsheet/>}<b>{text}</b>{retry&&<button className="btn" onClick={retry}>Qayta urinish</button>}</div>}
