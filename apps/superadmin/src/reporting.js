const formulaPattern=/^[\u0000-\u0020]*[=+\-@]/;
const dateKeys=new Set(['sold_at','occurred_at','created_at','started_at','posted_at','counted_at','from','to']);
const numberFormats={money:'#,##0.00',quantity:'#,##0.000',integer:'0'};

export const reportLabels={sales:'Savdo',finance:'Moliya',expenses:'Xarajatlar',debts:'Filial qarzlari',suppliers:'Yetkazib beruvchilar',inventory:'Ombor qoldig‘i',profit:'Foyda va zarar',sellers:'Sotuvchilar',products:'Mahsulotlar',counts:'Inventarizatsiya'};
export const columnLabels={sale_no:'Chek raqami',sold_at:'Sotilgan sana',branch_code:'Filial',seller_name:'Sotuvchi',status:'Holat',subtotal:'Oraliq jami',discount:'Chegirma',tax:'Soliq',total:'Jami',cost:'Tannarx',profit:'Foyda',payments:'To‘lovlar',transaction_id:'Tranzaksiya ID',occurred_at:'Sana',account_code:'Hisob',transaction_type:'Turi',category:'Kategoriya',amount:'Summa',description:'Izoh',reference_type:'Havola turi',reference_id:'Havola ID',debt_id:'Qarz ID',created_at:'Yaratilgan sana',debtor_branch:'Qarzdor filial',creditor_branch:'Kreditor filial',transfer_no:'Transfer',currency:'Valyuta',paid_amount:'To‘langan',remaining_amount:'Qoldiq',event_type:'Hodisa',event_id:'Hodisa ID',supplier_code:'Ta’minotchi kodi',supplier_name:'Ta’minotchi',balance_effect:'Balans ta’siri',reference:'Havola',location_code:'Joy kodi',location_name:'Joylashuv',sku:'SKU',product_name:'Mahsulot',on_hand:'Jami qoldiq',reserved:'Rezerv',available:'Mavjud',stock_cost:'Qoldiq tannarxi',retail_value:'Chakana qiymat',sales_revenue:'Savdo tushumi',tax_collected:'Yig‘ilgan soliq',refunds:'Qaytarishlar',net_sales:'Sof savdo',cost_of_goods:'Sotilgan tannarx',gross_profit:'Yalpi foyda',other_income:'Boshqa daromad',operating_expenses:'Operatsion xarajat',net_profit:'Sof foyda',seller_id:'Sotuvchi ID',sales_count:'Cheklar',units_sold:'Sotilgan birlik',product_id:'Mahsulot ID',count_id:'Inventarizatsiya ID',count_no:'Inventarizatsiya raqami',expected_quantity:'Kutilgan',counted_quantity:'Sanalgan',variance:'Farq',started_at:'Boshlangan',posted_at:'Post qilingan'};

const numericKeys=new Set(['subtotal','discount','tax','total','cost','profit','amount','paid_amount','remaining_amount','balance_effect','on_hand','reserved','available','stock_cost','retail_value','sales_revenue','tax_collected','refunds','net_sales','cost_of_goods','gross_profit','other_income','operating_expenses','net_profit','sales_count','units_sold','expected_quantity','counted_quantity','variance','revenue']);
const safeText=value=>{let text=String(value??'');if(formulaPattern.test(text))text=`'${text}`;return text};
const flatValue=value=>value==null?'':typeof value==='object'?safeText(JSON.stringify(value)):safeText(value);
const asDate=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?safeText(value):date};
const localDate=value=>new Intl.DateTimeFormat('uz-UZ',{year:'numeric',month:'short',day:'2-digit'}).format(new Date(value));
const monthKey=value=>String(value||'').slice(0,7);
const dayKey=value=>String(value||'').slice(0,10);
const reportDate=row=>row.sold_at||row.occurred_at||row.created_at||row.started_at||row.posted_at;
const metricFor=(type,row)=>type==='finance'||type==='expenses'?Number(row.amount||0):type==='debts'?Number(row.remaining_amount||0):type==='suppliers'?Math.abs(Number(row.balance_effect||0)):type==='inventory'?Number(row.retail_value||0):type==='profit'?Number(row.net_profit||0):type==='sellers'||type==='products'?Number(row.revenue||0):type==='counts'?Math.abs(Number(row.variance||0)):Number(row.total||0);
const breakdownFor=(type,row)=>type==='sales'?row.branch_code:type==='finance'||type==='expenses'?row.category:type==='debts'?row.debtor_branch:type==='suppliers'?row.supplier_name:type==='inventory'?row.location_name:type==='sellers'?row.seller_name:type==='products'?row.product_name:type==='counts'?row.status:'Natija';

const profitMetrics=[['sales_revenue','Savdo tushumi'],['refunds','Qaytarishlar'],['net_sales','Sof savdo'],['cost_of_goods','Sotilgan tannarx'],['gross_profit','Yalpi foyda'],['other_income','Boshqa daromad'],['operating_expenses','Operatsion xarajat'],['net_profit','Sof foyda']];
export function buildReportVisualization(type,rows=[]){
  const dated=rows.filter(row=>reportDate(row));
  const useMonth=dated.length>0&&(()=>{const dates=dated.map(row=>new Date(reportDate(row))).filter(date=>!Number.isNaN(date.getTime()));if(!dates.length)return false;return (Math.max(...dates)-Math.min(...dates))/86400000>62})();
  const buckets=new Map();
  for(const row of dated){const raw=reportDate(row),key=useMonth?monthKey(raw):dayKey(raw);if(!key)continue;const item=buckets.get(key)||{key,label:useMonth?key:localDate(raw),value:0,profit:0,count:0};item.value+=metricFor(type,row);item.profit+=Number(row.profit||row.net_profit||0);item.count+=1;buckets.set(key,item)}
  const groups=new Map();
  if(type==='profit')for(const[key,label]of profitMetrics){const value=rows.reduce((sum,row)=>sum+Number(row[key]||0),0);if(value!==0)groups.set(key,{key,label,value,count:rows.length})}
  else for(const row of rows){const label=String(breakdownFor(type,row)||'Noma’lum'),item=groups.get(label)||{key:label,label,value:0,profit:0,count:0};item.value+=metricFor(type,row);item.profit+=Number(row.profit||0);item.count+=1;groups.set(label,item)}
  const temporal=[...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key));
  const categorical=[...groups.values()].filter(item=>item.value!==0).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)).slice(0,12);
  const series=temporal.length>1?temporal:categorical;
  const breakdown=categorical.map(item=>({...item,value:Math.abs(item.value),profit:Math.abs(item.profit||0)}));
  return {series,breakdown,categorical:temporal.length<=1,lineAvailable:series.length>1,pieAvailable:type!=='profit',metricLabel:type==='counts'?'Farq':type==='expenses'?'Xarajat':'Summa'};
}

function filenamePart(value,fallback){const text=String(value||fallback).normalize('NFKD').replace(/[^\p{L}\p{N}._-]+/gu,'-').replace(/^-+|-+$/g,'');return(text||fallback).slice(0,80)}
function keysFor(rows){return[...new Set(rows.flatMap(row=>Object.keys(row||{})))]}
function cellValue(key,value){if(value==null)return'';if(dateKeys.has(key))return asDate(value);if(numericKeys.has(key)&&Number.isFinite(Number(value)))return Number(value);return flatValue(value)}
function downloadBlob(blob,filename){const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),0)}

export async function downloadReportXlsx({type,rows,branchName,branchId,from,to}){
  const imported=await import('exceljs');const ExcelJS=imported.default||imported;const workbook=new ExcelJS.Workbook();
  workbook.creator='Texnobazar';workbook.created=new Date();workbook.modified=new Date();
  const sheet=workbook.addWorksheet('Hisobot',{views:[{state:'frozen',ySplit:1}]});const keys=keysFor(rows);
  sheet.columns=keys.map(key=>({header:columnLabels[key]||key.replaceAll('_',' '),key,width:Math.min(45,Math.max(12,(columnLabels[key]||key).length+4))}));
  for(const row of rows)sheet.addRow(Object.fromEntries(keys.map(key=>[key,cellValue(key,row[key])])));
  const header=sheet.getRow(1);header.font={bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF97316'}};header.alignment={vertical:'middle'};header.height=24;sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:Math.max(1,keys.length)}};
  keys.forEach((key,index)=>{const column=sheet.getColumn(index+1);if(dateKeys.has(key))column.numFmt='yyyy-mm-dd hh:mm';else if(numericKeys.has(key))column.numFmt=['sales_count'].includes(key)?numberFormats.integer:['units_sold','on_hand','reserved','available','expected_quantity','counted_quantity','variance'].includes(key)?numberFormats.quantity:numberFormats.money;column.eachCell({includeEmpty:false},cell=>{cell.alignment={vertical:'top',wrapText:true}})});
  const meta=workbook.addWorksheet('Meta');meta.columns=[{header:'Maydon',key:'key',width:24},{header:'Qiymat',key:'value',width:48}];
  [['Hisobot turi',reportLabels[type]||type],['Filial',branchName||branchId||'Barcha filiallar'],['Boshlanish',from||'—'],['Tugash',to||'—'],['Eksport vaqti',new Date().toISOString()],['Qatorlar',rows.length]].forEach(([key,value])=>meta.addRow({key,value:safeText(value)}));meta.getRow(1).font={bold:true};
  const buffer=await workbook.xlsx.writeBuffer();downloadBlob(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),`${filenamePart(type,'hisobot')}-${filenamePart(branchName||branchId,'barcha')}-${filenamePart(from,'joriy')}-${filenamePart(to,'joriy')}.xlsx`);
}
