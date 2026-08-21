import React,{useEffect,useState}from'react';
import{AlertTriangle,Boxes,Building,Calendar,Package,ShoppingCart,Store,TrendingDown,TrendingUp,Truck,Users,Warehouse}from'lucide-react';
import{Status,formatMoney}from'@texnobazar/ui';
import{getBrowserClient,listEmployees,listMasterRecords}from'@texnobazar/data';

const today=()=>new Date().toISOString().split('T')[0];
const weekAgo=()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString().split('T')[0]};
const monthAgo=()=>{const d=new Date();d.setMonth(d.getMonth()-1);return d.toISOString().split('T')[0]};

export default function AdminDashboardWorkspace({go}){
  const[period,setPeriod]=useState('today');
  const[from,setFrom]=useState(today());
  const[to,setTo]=useState(today());
  const[stats,setStats]=useState(null);
  const[loading,setLoading]=useState(true);

  useEffect(()=>{
    if(period==='today'){setFrom(today());setTo(today())}
    else if(period==='week'){setFrom(weekAgo());setTo(today())}
    else if(period==='month'){setFrom(monthAgo());setTo(today())}
  },[period]);

  useEffect(()=>{loadStats()},[from,to]);

  const loadStats=async()=>{setLoading(true);try{
    const client=getBrowserClient();

    // Basic counts
    const[{data:branches},{data:locations},{data:products}]=await Promise.all([
      client.from('branches').select('id').eq('is_active',true),
      client.from('locations').select('id,type').eq('is_active',true),
      client.from('products').select('id,cost_price,retail_price,is_published')
    ]);
    let orderCount=0;try{const{count}=await client.from('orders').select('id',{count:'exact',head:true});orderCount=count||0}catch(e){}

    const employees=await listEmployees().catch(()=>[]);
    const couriers=employees.filter(e=>(e.roles||[]).some(r=>r.role==='courier'));

    // Inventory
    const{data:units}=await client.from('inventory_units').select('id,product_id,status').eq('status','available').limit(10000);
    const availableUnits=units||[];
    const productTypes=new Set(availableUnits.map(u=>u.product_id)).size;
    const totalUnits=availableUnits.length;

    // Cost/retail totals from products * unit counts
    const unitsByProduct={};availableUnits.forEach(u=>{unitsByProduct[u.product_id]=(unitsByProduct[u.product_id]||0)+1});
    let totalCost=0,totalRetail=0;
    (products||[]).forEach(p=>{const count=unitsByProduct[p.id]||0;totalCost+=count*Number(p.cost_price||0);totalRetail+=count*Number(p.retail_price||0)});

    // Sales in period
    let salesData=[];try{const{data:sd}=await client.rpc('report_sales_rows',{p_from:from,p_to:to,p_branch_id:null});salesData=sd||[]}catch(e){}
    const sales=(salesData||[]).filter(s=>s.status!=='void');
    const salesTotal=sales.reduce((s,r)=>s+Number(r.total||0),0);
    const salesProfit=sales.reduce((s,r)=>s+Number(r.profit||0),0);

    // Expenses in period month
    const monthStr=from.substring(0,7);
    const{data:expenses}=await client.from('expenses').select('amount').eq('period_month',monthStr);
    const expensesTotal=(expenses||[]).reduce((s,r)=>s+Number(r.amount||0),0);

    // Online orders
    const{count:onlineOrders}=await client.from('orders').select('id',{count:'exact',head:true}).limit(0).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59');

    // Top/bottom selling
    const productSales={};sales.forEach(s=>{/* report_sales_rows doesn't have product breakdown */});
    // Use inventory sold units for top/bottom
    const{data:soldUnits}=await client.from('inventory_units').select('product_id,products(name,sku)').eq('status','sold').limit(5000);
    const soldCount={};(soldUnits||[]).forEach(u=>{const name=u.products?.name||'?';if(!soldCount[name])soldCount[name]={name,sku:u.products?.sku||'',count:0};soldCount[name].count++});
    const sortedProducts=Object.values(soldCount).sort((a,b)=>b.count-a.count);
    const topSelling=sortedProducts.slice(0,5);
    const lowSelling=sortedProducts.filter(p=>p.count<=2).slice(-5);

    // Zero stock products
    const allProductIds=new Set((products||[]).map(p=>p.id));
    const hasStockIds=new Set(availableUnits.map(u=>u.product_id));
    const zeroStock=(products||[]).filter(p=>!hasStockIds.has(p.id)).length;

    const warehouses=(locations||[]).filter(l=>l.type==='warehouse').length;

    setStats({
      productTypes,totalUnits,totalCost,totalRetail,
      branchCount:(branches||[]).length,warehouseCount:warehouses,
      employeeCount:employees.length,courierCount:couriers.length,
      orderCount:orderCount||0,onlineOrders:onlineOrders||0,
      salesTotal,salesProfit,salesCount:sales.length,expensesTotal,
      topSelling,lowSelling,zeroStock
    });
  }catch(e){console.error(e)}finally{setLoading(false)}};

  return <><div className="page-head between"><div><h2>Asosiy</h2><p>Umumiy biznes ko'rsatkichlari</p></div><div className="period-selector"><button className={period==='today'?'active':''} onClick={()=>setPeriod('today')}>Bugun</button><button className={period==='week'?'active':''} onClick={()=>setPeriod('week')}>Hafta</button><button className={period==='month'?'active':''} onClick={()=>setPeriod('month')}>Oy</button><button className={period==='custom'?'active':''} onClick={()=>setPeriod('custom')}>Tanlash</button></div></div>
  {period==='custom'&&<div style={{display:'flex',gap:8,marginBottom:'1rem'}}><input type="date" className="input" value={from} onChange={e=>setFrom(e.target.value)} style={{maxWidth:160}}/><input type="date" className="input" value={to} onChange={e=>setTo(e.target.value)} style={{maxWidth:160}}/></div>}

  {loading?<div className="employee-loading">Yuklanmoqda...</div>:!stats?<div className="empty"><AlertTriangle/><h3>Xatolik</h3></div>:<>
  <div className="stats-cards">
    <div className="stat-card"><Package size={20}/><div><span className="stat-value">{stats.productTypes}</span><span className="stat-label">Tovar turlari</span></div></div>
    <div className="stat-card"><Boxes size={20}/><div><span className="stat-value">{stats.totalUnits.toLocaleString('uz-UZ')}</span><span className="stat-label">Tovarlar soni</span></div></div>
    <div className="stat-card"><TrendingDown size={20}/><div><span className="stat-value">{formatMoney(stats.totalCost)}</span><span className="stat-label">Tannarxi</span></div></div>
    <div className="stat-card"><TrendingUp size={20}/><div><span className="stat-value">{formatMoney(stats.totalRetail)}</span><span className="stat-label">Sotish narxi</span></div></div>
    <div className="stat-card"><ShoppingCart size={20}/><div><span className="stat-value">{stats.orderCount}</span><span className="stat-label">Barcha buyurtmalar</span></div></div>
    <div className="stat-card"><Building size={20}/><div><span className="stat-value">{stats.branchCount}</span><span className="stat-label">Filiallar</span></div></div>
    <div className="stat-card"><Warehouse size={20}/><div><span className="stat-value">{stats.warehouseCount}</span><span className="stat-label">Omborlar</span></div></div>
    <div className="stat-card"><Users size={20}/><div><span className="stat-value">{stats.employeeCount}</span><span className="stat-label">Xodimlar</span></div></div>
    <div className="stat-card"><Truck size={20}/><div><span className="stat-value">{stats.courierCount}</span><span className="stat-label">Kuryerlar</span></div></div>
    <div className="stat-card"><Store size={20}/><div><span className="stat-value">{stats.onlineOrders}</span><span className="stat-label">Sayt buyurtmalari</span></div></div>
  </div>

  <div className="dashboard-grid">
    <div className="card"><h3 style={{padding:'1rem 1rem .5rem'}}>Savdo va xarajatlar</h3><div className="product-info-rows" style={{padding:'0 1rem 1rem'}}>
      <div><span>Sotuvlar soni:</span><b>{stats.salesCount}</b></div>
      <div><span>Savdo summasi:</span><b>{formatMoney(stats.salesTotal)}</b></div>
      <div><span>Sof foyda:</span><b style={{color:'green'}}>{formatMoney(stats.salesProfit)}</b></div>
      <div><span>Xarajatlar:</span><b style={{color:'var(--primary)'}}>{formatMoney(stats.expensesTotal)}</b></div>
      <div><span>Qoldiqsiz tovarlar:</span><b style={{color:'red'}}>{stats.zeroStock}</b></div>
    </div></div>

    {stats.topSelling.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem .5rem'}}>Eng ko'p sotilgan</h3><div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>Sotilgan</th></tr></thead><tbody>{stats.topSelling.map((p,i)=><tr key={i}><td><b>{p.name}</b><br/><small className="muted">{p.sku}</small></td><td>{p.count}</td></tr>)}</tbody></table></div></div>}

    {stats.lowSelling.length>0&&<div className="card"><h3 style={{padding:'1rem 1rem .5rem'}}>Eng kam sotilgan</h3><div className="table-wrap"><table className="table"><thead><tr><th>Mahsulot</th><th>Sotilgan</th></tr></thead><tbody>{stats.lowSelling.map((p,i)=><tr key={i}><td><b>{p.name}</b><br/><small className="muted">{p.sku}</small></td><td>{p.count}</td></tr>)}</tbody></table></div></div>}
  </div>
  </>}</>;
}
