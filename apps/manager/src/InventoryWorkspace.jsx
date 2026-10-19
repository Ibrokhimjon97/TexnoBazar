import React,{useEffect,useMemo,useRef,useState}from'react';
import{createPortal}from'react-dom';
import{AlertTriangle,ArrowRight,ArrowUpDown,Bluetooth,Boxes,Calendar,Camera,CheckCircle2,ChevronDown,ChevronLeft,ChevronRight,Clock3,Copy,Eye,EyeOff,ExternalLink,FileArchive,FileSpreadsheet,HardDriveDownload,HardDriveUpload,Layers,Loader2,MapPin,PackagePlus,Download,Pencil,Plus,Printer,QrCode,ReceiptText,RotateCcw,Search,Tag,Trash2,Upload,UploadCloud,Warehouse,X}from'lucide-react';
import{DualPrice,Empty,Modal,ProductExcelImportModal,ProductEditor,ProductComponentEditor,QrScanButton,Status,formatDualMoney,formatMoney,useExchangeRate,DetongerPrintModal,formatSecretCostCode,BASE_COLOR_PALETTE,detectColorFromImageSource}from'@texnobazar/ui';
import QRCode from'qrcode';
import RichTextEditor from'./RichTextEditor';
import{CreateProductInline}from'./InventoryRegisterModal';
import InventoryExcelImportModal from'./InventoryExcelImportModal';
import BatchPriceExcelModal from'./BatchPriceExcelModal';
import{formatUzDate,getUzMonthName,getBrowserClient,createStockReceipt,deleteStockReceipt,convertStockReceiptsCurrency,getInventoryReferences,getInventoryUnitPassport,getLatestExchangeRate,getStockReceipt,listInventoryBalances,listReceiptQrLabels,listStockReceipts,placeInventoryUnits,revertUnitSale,updateStockReceipt,uploadProductMedia,exportBatchesBackup,exportReceiptBackup,inspectBatchesBackupFile,restoreBatchesBackupFile,saveProductComponents,getProductComponents}from'@texnobazar/data';
const err=e=>String(e?.message||'Amalni bajarib bo‘lmadi.');
// Visual marker only: INV-* kirimlar inventarizatsiya orqali ro‘yxatga olingan,
// qolganlari esa oddiy yetkazib berish partiyasi.
const isInventoryReceipt=receiptNo=>/^INV-/i.test(String(receiptNo||'').trim());
export function InventoryBatches({branchId,onCreate,onCreateBatch,onCreateInventory,toast,autoOpenReceiptId,onAutoOpenReceiptHandled,refreshTrigger}){
  const getTodayDate=()=>{const d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate());};
  const isSameDay=(d1,d2)=>{if(!d1||!d2)return false;return d1.getFullYear()===d2.getFullYear()&&d1.getMonth()===d2.getMonth()&&d1.getDate()===d2.getDate();};
  const[rows,setRows]=useState([]),[total,setTotal]=useState(0),[aggregates,setAggregates]=useState({totalUnits:0,totalCost:0,totalMinPrice:0,batchCount:0,invCount:0}),[query,setQuery]=useState(''),[typeFilter,setTypeFilter]=useState('all'),[currencyFilter,setCurrencyFilter]=useState('all'),[locationFilter,setLocationFilter]=useState('all'),[locations,setLocations]=useState([]),[sortBy,setSortBy]=useState('newest'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[detail,setDetail]=useState(null),[detailEdit,setDetailEdit]=useState(false),[deletingId,setDeletingId]=useState(null);
  const[selectedIds,setSelectedIds]=useState([]),[convertingCurrency,setConvertingCurrency]=useState(false);
  const[passwordModal,setPasswordModal]=useState(null);
  const[selectedDate,setSelectedDate]=useState(()=>getTodayDate());
  const[visibleCount,setVisibleCount]=useState(30);
  const[calMonth,setCalMonth]=useState(()=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth(),1)});
  const[rate,setRate]=useState(null);
  const[serverBatchDates,setServerBatchDates]=useState([]);
  const[exportingAll,setExportingAll]=useState(false);
  const[exportingExcel,setExportingExcel]=useState(false);
  const[exportingId,setExportingId]=useState(null);
  const[restoreModalOpen,setRestoreModalOpen]=useState(false);
  const[excelImportOpen,setExcelImportOpen]=useState(false);
  const[batchPriceModalOpen,setBatchPriceModalOpen]=useState(false);
  const reqIdRef=useRef(0);

  useEffect(()=>{
    if(!branchId)return;
    getInventoryReferences(branchId).then(r=>setLocations(r.locations||[])).catch(()=>{});
  },[branchId]);

  const downloadExcelWorkbook=async(wb,fileName)=>{
    const buffer=await wb.xlsx.writeBuffer();
    const blob=new Blob([buffer],{
      type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url=window.URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.style.display='none';
    a.href=url;
    a.download=fileName.endsWith('.xlsx')?fileName:`${fileName}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>{
      window.URL.revokeObjectURL(url);
    },20000);
  };

  const handleExportExcel=async(specificReceipt=null)=>{
    const listToExport=specificReceipt?[specificReceipt]:displayRows;
    if(!listToExport.length){
      toast?.('Eksport qilish uchun ma’lumot mavjud emas');
      return;
    }
    setExportingExcel(true);
    try{
      const ExcelJS=(await import('exceljs')).default||(await import('exceljs'));
      const wb=new ExcelJS.Workbook();
      wb.creator='Texnobazar';
      wb.created=new Date();

      const ws=wb.addWorksheet('Partiyalar tovarlari',{
        views:[{state:'frozen',ySplit:1}]
      });

      // 19 ta ustun: Tovarlar izohi hamda UZS va USD alohida ustunlarda
      ws.columns=[
        {header:'№',key:'idx',width:8},
        {header:'Mahsulot nomi',key:'product_name',width:38},
        {header:'Mahsulot kategoriyasi',key:'category_name',width:28},
        {header:'Mahsulot brendi',key:'brand_name',width:18},
        {header:'Tovarlar izohi',key:'description',width:28},
        {header:'Tan narxi (UZS)',key:'unit_cost_uzs',width:20},
        {header:'Tan narxi (USD)',key:'unit_cost_usd',width:18},
        {header:'Sotish narxi (UZS)',key:'retail_price_uzs',width:20},
        {header:'Sotish narxi (USD)',key:'retail_price_usd',width:18},
        {header:'Ulgurji narxi (UZS)',key:'wholesale_price_uzs',width:20},
        {header:'Ulgurji narxi (USD)',key:'wholesale_price_usd',width:18},
        {header:'Minimal sotish narxi (UZS)',key:'minimum_sale_price_uzs',width:24},
        {header:'Minimal sotish narxi (USD)',key:'minimum_sale_price_usd',width:22},
        {header:'Valyuta',key:'currency',width:12},
        {header:'Miqdori (soni)',key:'quantity',width:16},
        {header:'Partiya umumiy kodi',key:'qr_code',width:22},
        {header:'Partiya raqami',key:'receipt_no',width:24},
        {header:'Qabul qilingan sana',key:'received_at',width:18},
        {header:'Joylashuv',key:'location_name',width:24},
      ];

      // Header row styling
      const headerRow=ws.getRow(1);
      headerRow.height=32;
      headerRow.eachCell(cell=>{
        cell.fill={
          type:'pattern',
          pattern:'solid',
          fgColor:{argb:'FF0F172A'}
        };
        cell.font={
          name:'Calibri',
          size:11,
          bold:true,
          color:{argb:'FFFFFFFF'}
        };
        cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};
        cell.border={
          top:{style:'thin',color:{argb:'FF334155'}},
          bottom:{style:'medium',color:{argb:'FF334155'}},
          left:{style:'thin',color:{argb:'FF334155'}},
          right:{style:'thin',color:{argb:'FF334155'}}
        };
      });

      let rowIdx=1;
      let totalUnitsSum=0;

      listToExport.forEach(receipt=>{
        const receiptNo=receipt.receipt_no||'—';
        const locationName=`${receipt.location_name||'—'}${receipt.location_type==='warehouse'?' (Ombor)':' (Do‘kon)'}`;
        const receivedDate=receipt.received_at?new Date(receipt.received_at).toLocaleDateString('uz-UZ'):'—';
        const receiptCurrency=String(receipt.currency||'').trim().toUpperCase()||'USD';
        const exchangeRate=Number(receipt.exchange_rate)||rate||12800;
        const items=Array.isArray(receipt.items)?receipt.items:[];

        if(items.length>0){
          items.forEach(it=>{
            const qty=Number(it.quantity)||1;

            // Tannarx
            let costUzs=Number(it.unit_cost)||0;
            let costUsd=Number(it.unit_cost_usd)||0;
            if(costUsd>0&&costUzs<=0&&exchangeRate>0){
              costUzs=Math.round(costUsd*exchangeRate);
            }else if(costUzs>0&&costUsd<=0&&exchangeRate>0){
              costUsd=Number((costUzs/exchangeRate).toFixed(2));
            }

            // Sotish narxi
            let retailUzs=Number(it.retail_price)||0;
            let retailUsd=Number(it.retail_price_usd)||0;
            if(retailUsd>0&&retailUzs<=0&&exchangeRate>0){
              retailUzs=Math.round(retailUsd*exchangeRate);
            }else if(retailUzs>0&&retailUsd<=0&&exchangeRate>0){
              retailUsd=Number((retailUzs/exchangeRate).toFixed(2));
            }

            // Ulgurji narxi
            let wholesaleUzs=Number(it.wholesale_price)||0;
            let wholesaleUsd=Number(it.wholesale_price_usd)||0;
            if(wholesaleUsd>0&&wholesaleUzs<=0&&exchangeRate>0){
              wholesaleUzs=Math.round(wholesaleUsd*exchangeRate);
            }else if(wholesaleUzs>0&&wholesaleUsd<=0&&exchangeRate>0){
              wholesaleUsd=Number((wholesaleUzs/exchangeRate).toFixed(2));
            }

            // Minimal sotish narxi
            let minPriceUzs=Number(it.minimum_sale_price)||0;
            let minPriceUsd=Number(it.minimum_sale_price_usd)||0;
            if(minPriceUsd>0&&minPriceUzs<=0&&exchangeRate>0){
              minPriceUzs=Math.round(minPriceUsd*exchangeRate);
            }else if(minPriceUzs>0&&minPriceUsd<=0&&exchangeRate>0){
              minPriceUsd=Number((minPriceUzs/exchangeRate).toFixed(2));
            }

            totalUnitsSum+=qty;

            const fullName=it.variant_color
              ?`${it.product_name||'Nomsiz tovar'} (${it.variant_color})`
              :(it.product_name||'Nomsiz tovar');

            const itemCurrency=receiptCurrency;

            const addedRow=ws.addRow({
              idx:rowIdx,
              product_name:fullName,
              category_name:it.category_name||'—',
              brand_name:it.brand_name||'—',
              description:it.description||'',
              unit_cost_uzs:costUzs,
              unit_cost_usd:costUsd,
              retail_price_uzs:retailUzs,
              retail_price_usd:retailUsd,
              wholesale_price_uzs:wholesaleUzs,
              wholesale_price_usd:wholesaleUsd,
              minimum_sale_price_uzs:minPriceUzs,
              minimum_sale_price_usd:minPriceUsd,
              currency:itemCurrency,
              quantity:qty,
              qr_code:it.qr_code||'—',
              receipt_no:receiptNo,
              received_at:receivedDate,
              location_name:locationName
            });

            addedRow.height=22;
            const isEven=rowIdx%2===0;

            addedRow.eachCell((cell,colNumber)=>{
              cell.font={name:'Calibri',size:10};
              cell.border={
                top:{style:'thin',color:{argb:'FFE2E8F0'}},
                bottom:{style:'thin',color:{argb:'FFE2E8F0'}},
                left:{style:'thin',color:{argb:'FFE2E8F0'}},
                right:{style:'thin',color:{argb:'FFE2E8F0'}}
              };
              if(isEven){
                cell.fill={
                  type:'pattern',
                  pattern:'solid',
                  fgColor:{argb:'FFF8FAFC'}
                };
              }

              if(colNumber===1){
                cell.alignment={horizontal:'center',vertical:'middle'};
              }else if(colNumber===5){
                // Tovarlar izohi
                cell.alignment={horizontal:'left',vertical:'middle'};
                cell.font={name:'Calibri',size:10,italic:true};
              }else if(colNumber===6||colNumber===8||colNumber===10||colNumber===12){
                // UZS ustunlar
                cell.numFmt='#,##0';
                cell.alignment={horizontal:'right',vertical:'middle'};
              }else if(colNumber===7||colNumber===9||colNumber===11||colNumber===13){
                // USD ustunlar
                cell.numFmt='$#,##0.00';
                cell.alignment={horizontal:'right',vertical:'middle'};
                cell.font={name:'Calibri',size:10,color:{argb:'FF0369A1'}};
              }else if(colNumber===14){
                // Valyuta
                cell.alignment={horizontal:'center',vertical:'middle'};
                cell.font={name:'Calibri',size:10,bold:true,color:{argb:itemCurrency==='USD'?'FF0284C7':'FF16A34A'}};
              }else if(colNumber===15){
                // Miqdori
                cell.numFmt='#,##0';
                cell.alignment={horizontal:'right',vertical:'middle'};
                cell.font={name:'Calibri',size:10,bold:true};
              }else if(colNumber===16){
                // QR kod
                cell.alignment={horizontal:'center',vertical:'middle'};
                cell.font={name:'Consolas',size:10,bold:true,color:{argb:'FF0369A1'}};
              }else if(colNumber===18){
                cell.alignment={horizontal:'center',vertical:'middle'};
              }else{
                cell.alignment={horizontal:'left',vertical:'middle'};
              }
            });

            rowIdx++;
          });
        }
      });

      // Total summary row at bottom
      const summaryRow=ws.addRow({
        idx:'',
        product_name:'JAMI',
        category_name:'',
        brand_name:'',
        description:'',
        unit_cost_uzs:'',
        unit_cost_usd:'',
        retail_price_uzs:'',
        retail_price_usd:'',
        wholesale_price_uzs:'',
        wholesale_price_usd:'',
        minimum_sale_price_uzs:'',
        minimum_sale_price_usd:'',
        currency:'',
        quantity:totalUnitsSum,
        qr_code:'',
        receipt_no:'',
        received_at:'',
        location_name:''
      });
      summaryRow.height=26;
      summaryRow.eachCell((cell,colNumber)=>{
        cell.font={name:'Calibri',size:11,bold:true,color:{argb:'FF0F172A'}};
        cell.fill={
          type:'pattern',
          pattern:'solid',
          fgColor:{argb:'FFFEF3C7'}
        };
        cell.border={
          top:{style:'medium',color:{argb:'FFCBD5E1'}},
          bottom:{style:'medium',color:{argb:'FFCBD5E1'}},
          left:{style:'thin',color:{argb:'FFCBD5E1'}},
          right:{style:'thin',color:{argb:'FFCBD5E1'}}
        };
        if(colNumber===15){
          cell.numFmt='#,##0';
          cell.alignment={horizontal:'right',vertical:'middle'};
        }else if(colNumber===2){
          cell.alignment={horizontal:'left',vertical:'middle'};
        }
      });

      let fileName;
      if(specificReceipt){
        fileName=`partiya_${specificReceipt.receipt_no||'tovarlar'}.xlsx`;
      }else{
        const dateTag=selectedDate
          ?`${selectedDate.getFullYear()}-${String(selectedDate.getMonth()+1).padStart(2,'0')}-${String(selectedDate.getDate()).padStart(2,'0')}`
          :'barcha_davrlar';
        fileName=`partiyalar_tovarlar_${dateTag}.xlsx`;
      }

      await downloadExcelWorkbook(wb,fileName);
      toast?.(`${rowIdx-1} ta tovar yozuvi "${fileName}" Excel fayliga yuklandi`);
    }catch(e){
      console.error(e);
      alert('Excel faylni yaratishda xatolik: '+err(e));
    }finally{
      setExportingExcel(false);
    }
  };

  const handleExportAll=async()=>{
    setExportingAll(true);
    try{
      const res=await exportBatchesBackup(branchId);
      toast?.(`${res.counts.receipts} ta partiya va inventarizatsiya JSON faylga yuklandi`);
    }catch(e){
      alert(err(e));
    }finally{
      setExportingAll(false);
    }
  };

  const handleExportSingle=async(receiptId,receiptNo)=>{
    setExportingId(receiptId);
    try{
      const res=await exportReceiptBackup(receiptId);
      toast?.(`"${receiptNo}" partiyasi (${res.counts.units} dona tovar) JSON zahiraga yuklandi`);
    }catch(e){
      alert(err(e));
    }finally{
      setExportingId(null);
    }
  };
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{})},[]);
  const load=async(dateParam=selectedDate)=>{
    if(!branchId)return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    try{
      const locId = locationFilter === 'all' ? null : locationFilter;
      const cleanQ = query ? query.trim() : null;
      // Agar qidiruv kiritilgan bo'lsa, avvalgi kunlardagi partiyalar ham topilishi uchun sana filtrini bekor qilamiz!
      const effectiveDate = cleanQ ? null : dateParam;
      const formattedDate = effectiveDate 
        ? `${effectiveDate.getFullYear()}-${String(effectiveDate.getMonth() + 1).padStart(2, '0')}-${String(effectiveDate.getDate()).padStart(2, '0')}` 
        : null;
      const r = await listStockReceipts({
        branchId, 
        locationId: locId, 
        query: cleanQ, 
        date: formattedDate,
        pageSize: 1000
      });
      if(reqId !== reqIdRef.current) return;
      const items = r.items || [];
      setRows(items);
      setTotal(Number(r.total) || 0);
      if (Array.isArray(r.batch_dates)) {
        setServerBatchDates(r.batch_dates);
      }
      setAggregates({
        totalUnits: Number(r.total_units ?? items.reduce((s, x) => s + Number(x.unit_count || 0), 0)),
        totalCost: Number(r.total_cost ?? items.reduce((s, x) => s + Number(x.total_cost || 0), 0)),
        totalMinPrice: Number(r.total_min_price ?? items.reduce((s, x) => s + Number(x.total_min_price || 0), 0)),
        batchCount: Number(r.batch_count ?? items.filter(x => !isInventoryReceipt(x.receipt_no)).length),
        invCount: Number(r.inv_count ?? items.filter(x => isInventoryReceipt(x.receipt_no)).length),
      });
    }catch(e){
      if(reqId === reqIdRef.current){
        setError(err(e));
      }
    }finally{
      if(reqId === reqIdRef.current){
        setLoading(false);
      }
    }
  };
  useEffect(()=>{const t=setTimeout(()=>load(selectedDate),query?350:0);return()=>clearTimeout(t)},[branchId,query,locationFilter,selectedDate]);
  useEffect(()=>{setVisibleCount(30);},[selectedDate,query,typeFilter,currencyFilter,locationFilter,sortBy]);
  const open=async(id,isEdit=false)=>{try{setDetail(await getStockReceipt(id));setDetailEdit(Boolean(isEdit));}catch(e){setError(err(e))}};

  const handleNewlyCreatedReceipt=async(receiptId)=>{
    if(!receiptId)return;
    try{
      setSelectedDate(getTodayDate());
      setTypeFilter('all');
      setLocationFilter('all');
      setQuery('');
      setSortBy('newest');

      const fullReceipt=await getStockReceipt(receiptId);
      if(fullReceipt){
        setDetail(fullReceipt);
        setDetailEdit(false);

        setRows(prev=>{
          if(prev.some(r=>r.id===receiptId))return prev;
          const isInv=isInventoryReceipt(fullReceipt.receipt_no);
          const lines=fullReceipt.lines||[];
          const summaryRow={
            id:fullReceipt.id,
            receipt_no:fullReceipt.receipt_no,
            branch_id:fullReceipt.branch_id,
            supplier_id:fullReceipt.supplier_id,
            supplier_name:fullReceipt.supplier?.name||(isInv?'Inventarizatsiya':'Noma’lum ta’minotchi'),
            receiving_location_id:fullReceipt.receiving_location_id,
            location_name:fullReceipt.receiving_location?.name||'Do‘kon',
            location_type:fullReceipt.receiving_location?.type||'store',
            invoice_number:fullReceipt.invoice_number||'',
            currency:fullReceipt.currency||'USD',
            payment_status:fullReceipt.payment_status||'paid',
            received_at:fullReceipt.received_at||new Date().toISOString(),
            created_at:fullReceipt.created_at||new Date().toISOString(),
            line_count:lines.length,
            unit_count:lines.reduce((s,l)=>s+Number(l.quantity||0),0),
            total_cost:fullReceipt.total_cost||lines.reduce((s,l)=>s+(Number(l.quantity||0)*Number(l.unit_cost||0)),0),
            total_retail:lines.reduce((s,l)=>s+(Number(l.quantity||0)*Number(l.retail_price||0)),0),
            total_min_price:lines.reduce((s,l)=>s+(Number(l.quantity||0)*Number(l.minimum_sale_price||l.retail_price||0)),0),
            items:lines.slice(0,5).map(l=>({
              batch_id:l.id,
              product_id:l.product_id,
              product_name:l.product_name,
              sku:l.sku,
              variant_id:l.variant_id,
              variant_color:l.variant_color,
              quantity:l.quantity,
              unit_cost:l.unit_cost,
              unit_cost_usd:l.unit_cost_usd,
              retail_price:l.retail_price,
              wholesale_price:l.wholesale_price,
              minimum_sale_price:l.minimum_sale_price,
              qr_code:l.qr_code
            }))
          };
          return [summaryRow,...prev];
        });
      }

      await load(getTodayDate());
    }catch(errLoad){
      console.error('Yangi partiyani ochishda xatolik:',errLoad);
      await load(getTodayDate());
    }
  };

  useEffect(()=>{
    if(autoOpenReceiptId){
      handleNewlyCreatedReceipt(autoOpenReceiptId);
      onAutoOpenReceiptHandled?.();
    }else if(refreshTrigger){
      setSelectedDate(getTodayDate());
      setTypeFilter('all');
      setQuery('');
      load(getTodayDate());
    }
  },[autoOpenReceiptId,refreshTrigger]);
  const deleteBatch=async(id,receiptNo,password=null)=>{
    const cleanPassword = typeof password === 'string' ? password.trim() : null;
    if(deletingId)return;
    if(!cleanPassword&&!confirm(`"${receiptNo}" partiyasini o'chirishni tasdiqlaysizmi?\n\nDIQQAT: Ushbu partiyaga tegishli tovar birliklari o'chiriladi!`))return;
    setDeletingId(id);
    try{
      await deleteStockReceipt(id,cleanPassword);
      setRows(prev=>prev.filter(r=>r.id!==id));
      setPasswordModal(null);
      setError('');
      await load();
    }catch(e){
      const message=err(e);
      if(e?.code==='P0002'||message.includes('Topilmadi')){
        setRows(prev=>prev.filter(r=>r.id!==id));
        setPasswordModal(null);
        setError('');
        await load();
      }else if(message.includes('sotilganlari bor')||e?.code==='P0001'||message.includes('Parol')||message.includes('parol')){
        if(cleanPassword){
          setPasswordModal(prev=>({...(prev||{id,receiptNo,password:''}),error:message||'Noto\'g\'ri parol kiritildi!'}));
        }else{
          setPasswordModal({id,receiptNo,password:'',error:''});
        }
      }else{
        if(passwordModal){
          setPasswordModal(prev=>({...prev,error:message}));
        }else{
          alert(message);
        }
      }
    }finally{
      setDeletingId(null);
    }
  };
  const batchDatesSet=useMemo(()=>{
    const set=new Set();
    serverBatchDates.forEach(dateStr=>{
      const parts=String(dateStr).split('-');
      if(parts.length===3){
        const y=parseInt(parts[0],10);
        const m=parseInt(parts[1],10)-1;
        const d=parseInt(parts[2],10);
        set.add(`${y}-${m}-${d}`);
      }
    });
    rows.forEach(x=>{
      if(x.received_at){
        const d=new Date(x.received_at);
        set.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
      }
    });
    return set;
  },[serverBatchDates,rows]);
  const batchCount=useMemo(()=>rows.filter(x=>!isInventoryReceipt(x.receipt_no)).length,[rows]);
  const invCount=useMemo(()=>rows.filter(x=>isInventoryReceipt(x.receipt_no)).length,[rows]);
  const uzsCount=useMemo(()=>rows.filter(x=>String(x.currency||'USD').toUpperCase()==='UZS').length,[rows]);
  const usdCount=useMemo(()=>rows.filter(x=>String(x.currency||'USD').toUpperCase()==='USD').length,[rows]);
  const totalCostAll=useMemo(()=>rows.reduce((s,x)=>s+Number(x.total_cost||0),0),[rows]);
  const totalMinAll=useMemo(()=>rows.reduce((s,x)=>s+Number(x.total_min_price||0),0),[rows]);
  const cleanQ = query ? query.trim() : '';
  const displayRows=useMemo(()=>{
    return rows.filter(x=>{
      if(typeFilter==='batch'&&isInventoryReceipt(x.receipt_no))return false;
      if(typeFilter==='inventory'&&!isInventoryReceipt(x.receipt_no))return false;
      if(currencyFilter!=='all'&&String(x.currency||'USD').toUpperCase()!==currencyFilter)return false;
      if(locationFilter!=='all'&&x.receiving_location_id!==locationFilter)return false;
      // Faqat qidiruv bo'lmagandagina tanlangan sana bo'yicha cheklaymiz. Qidiruv paytida barcha kunlardagi yozuvlar chiqadi!
      if(selectedDate && !cleanQ){
        const d=new Date(x.received_at);
        const cd=new Date(x.created_at||x.received_at);
        const matchRec=d.getFullYear()===selectedDate.getFullYear()&&d.getMonth()===selectedDate.getMonth()&&d.getDate()===selectedDate.getDate();
        const matchCre=cd.getFullYear()===selectedDate.getFullYear()&&cd.getMonth()===selectedDate.getMonth()&&cd.getDate()===selectedDate.getDate();
        if(!matchRec&&!matchCre)return false;
      }
      return true;
    });
  },[rows,selectedDate,typeFilter,currencyFilter,locationFilter,cleanQ]);

  const allVisibleSelected = displayRows.length > 0 && displayRows.every(r => selectedIds.includes(r.id));
  const someVisibleSelected = displayRows.some(r => selectedIds.includes(r.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      const displaySet = new Set(displayRows.map(r => r.id));
      setSelectedIds(prev => prev.filter(id => !displaySet.has(id)));
    } else {
      const next = new Set([...selectedIds, ...displayRows.map(r => r.id)]);
      setSelectedIds([...next]);
    }
  };

  const toggleSelectOne = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleConvertSelected = async (targetCurrency, specificIds = null) => {
    const idsToConvert = specificIds || selectedIds;
    if (!idsToConvert || idsToConvert.length === 0) return;
    const targetName = targetCurrency === 'USD' ? 'USD ($ - Dollar)' : 'UZS (So‘m)';
    const count = idsToConvert.length;
    const currentRate = Number(rate || 12800);

    const msg = count === 1
      ? `Tanlangan partiya / inventarizatsiya valyutasini ${targetName} ga o‘tkazishni tasdiqlaysizmi?\n\n` +
        `• Joriy valyuta kursi: 1 USD = ${currentRate.toLocaleString('uz-UZ')} UZS\n` +
        (targetCurrency === 'USD'
          ? `• Tovarlarning UZS da saqlangan tannarxi bugungi kursda USD ga o‘zgaradi va USD da KONSTANTA bo‘lib qoladi (kelgusida kurs o‘zgarsa, so‘mdagi qiymat avtomatik qayta hisoblanadi).`
          : `• Tovarlarning USD dagi tannarxi bugungi kursda UZS ga o‘zgaradi va UZS da KONSTANTA bo‘lib qoladi.`)
      : `${count} ta partiya / inventarizatsiya valyutasini ${targetName} ga o‘tkazishni tasdiqlaysizmi?\n\n` +
        `• Joriy valyuta kursi: 1 USD = ${currentRate.toLocaleString('uz-UZ')} UZS\n` +
        (targetCurrency === 'USD'
          ? `• Barcha tanlangan partiyalardagi tovarlar tannarxi bugungi kursda USD ga aylanadi va USD da KONSTANTA bo‘ladi.`
          : `• Barcha tanlangan partiyalardagi tovarlar tannarxi bugungi kursda UZS ga aylanadi va UZS da KONSTANTA bo‘ladi.`);

    if (!confirm(msg)) return;

    setConvertingCurrency(true);
    try {
      const res = await convertStockReceiptsCurrency(idsToConvert, targetCurrency);
      toast?.(`${res.updated_receipts} ta partiya (${res.updated_products} ta tovar) valyutasi muvaffaqiyatli ${targetName} ga o‘tkazildi! (Kurs: ${res.rate})`);
      setSelectedIds(prev => prev.filter(id => !idsToConvert.includes(id)));
      await load(selectedDate);
    } catch (e) {
      alert('Valyutani o‘tkazishda xatolik: ' + err(e));
    } finally {
      setConvertingCurrency(false);
    }
  };

  const sortedRows=useMemo(()=>{
    const list=[...displayRows];
    list.sort((a,b)=>{
      if(sortBy==='newest'){
        const tA=new Date(a.created_at||a.received_at||0).getTime();
        const tB=new Date(b.created_at||b.received_at||0).getTime();
        if(tB!==tA)return tB-tA;
        return String(b.receipt_no||'').localeCompare(String(a.receipt_no||''));
      }
      if(sortBy==='oldest'){
        const tA=new Date(a.created_at||a.received_at||0).getTime();
        const tB=new Date(b.created_at||b.received_at||0).getTime();
        if(tA!==tB)return tA-tB;
        return String(a.receipt_no||'').localeCompare(String(b.receipt_no||''));
      }
      if(sortBy==='units_desc'){
        return(Number(b.unit_count)||0)-(Number(a.unit_count)||0);
      }
      if(sortBy==='cost_desc'){
        return(Number(b.total_cost)||0)-(Number(a.total_cost)||0);
      }
      if(sortBy==='receipt_no'){
        return String(a.receipt_no||'').localeCompare(String(b.receipt_no||''));
      }
      return 0;
    });
    return list;
  },[displayRows,sortBy]);

  const visibleRows=useMemo(()=>{
    return sortedRows.slice(0,visibleCount);
  },[sortedRows,visibleCount]);

  const handleDateClick=(date)=>{if(selectedDate&&selectedDate.getFullYear()===date.getFullYear()&&selectedDate.getMonth()===date.getMonth()&&selectedDate.getDate()===date.getDate()){setSelectedDate(null)}else{setSelectedDate(date)}};
  const handleCreateBatch=onCreateBatch||onCreate;
  const handleCreateInventory=onCreateInventory||onCreate;

  return <>
  <div className="m-page-head between">
    <div>
      <h2>Partiyalar va Inventarizatsiya</h2>
      <p>Yetkazib beruvchilardan kirimlar va ombordagi tovarlar inventarizatsiyasi</p>
    </div>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <button className="btn btn-primary" onClick={handleCreateBatch}>
        <Plus size={16}/>Yangi partiya
      </button>
      <button className="btn btn-outline" style={{borderColor:'#7c3aed',color:'#7c3aed',background:'#f5f3ff',fontWeight:600}} onClick={handleCreateInventory}>
        <Boxes size={16}/>Inventarizatsiya
      </button>
      <button
        type="button"
        className="btn"
        style={{background:'#16a34a',color:'#fff',borderColor:'#16a34a',display:'inline-flex',alignItems:'center',gap:6,fontWeight:700,boxShadow:'0 2px 8px rgba(22,163,74,0.25)'}}
        onClick={()=>handleExportExcel()}
        disabled={exportingExcel}
        title="Sahifadagi barcha partiyalarning tovarlarini Excel (.xlsx) formatida yuklab olish"
      >
        <FileSpreadsheet size={16}/>{exportingExcel?'Excel yuklanmoqda…':'Excel (.xlsx) yuklash'}
      </button>
      <button
        type="button"
        className="btn"
        style={{background:'#0284c7',color:'#fff',borderColor:'#0284c7',display:'inline-flex',alignItems:'center',gap:6,fontWeight:700,boxShadow:'0 2px 8px rgba(2,132,199,0.25)'}}
        onClick={()=>setExcelImportOpen(true)}
        title="Excel (.xlsx) orqali yangi partiya yoki inventarizatsiyani import qilish"
      >
        <Upload size={16}/>Exceldan import
      </button>
      <button
        type="button"
        className="btn"
        style={{background:'#7c3aed',color:'#fff',borderColor:'#7c3aed',display:'inline-flex',alignItems:'center',gap:6,fontWeight:700,boxShadow:'0 2px 8px rgba(124,58,237,0.25)'}}
        onClick={()=>setBatchPriceModalOpen(true)}
        title="Partiyalar va inventarizatsiyadagi tovarlar narxlarini Excel (.xlsx) orqali ommaviy yangilash (UZS va USD)"
      >
        <Tag size={16}/>Narxlarni yangilash (Excel)
      </button>
      <button className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:13,color:'#64748b'}} onClick={handleExportAll} disabled={exportingAll} title="Barcha partiyalarni dasturiy JSON zahira fayliga yuklash">
        <Download size={14}/>{exportingAll?'Eksport…':'Zahira (JSON)'}
      </button>
      <button className="btn btn-outline" style={{borderColor:'#2563eb',color:'#2563eb',background:'#eff6ff',display:'inline-flex',alignItems:'center',gap:6,fontWeight:600}} onClick={()=>setRestoreModalOpen(true)} title="Zahira faylidan partiyalarni qayta tiklash">
        <Upload size={14}/>Zahiradan tiklash
      </button>
    </div>
  </div>

  {/* Yuqori qismdagi sarlavha ostidagi asosiy tezkor qidiruv paneli */}
  <div style={{margin:'14px 0 16px',position:'relative'}}>
    <Search size={18} style={{position:'absolute',left:14,top:'50%',transform:'translateY(-50%)',color:'#0284c7'}}/>
    <input
      type="text"
      className="input"
      style={{
        width:'100%',
        paddingLeft:44,
        paddingRight:query?90:14,
        height:48,
        fontSize:14,
        borderRadius:12,
        border:cleanQ?'2px solid #0284c7':'1.5px solid #cbd5e1',
        boxShadow:cleanQ?'0 0 0 3px rgba(2,132,199,0.15)':'0 2px 6px rgba(0,0,0,0.04)',
        background:'#fff',
        fontWeight:500,
        outline:'none'
      }}
      placeholder="Tovar nomi, SKU, umumiy QR kod, partiya raqami yoki ta'minotchi bo'yicha qidirish (barcha kunlar bo'yicha)..."
      value={query}
      onChange={e=>setQuery(e.target.value)}
    />
    {query && (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'#64748b',padding:'4px 8px',height:30}}
        onClick={()=>setQuery('')}
        title="Qidiruvni tozalash"
      >
        <X size={15}/> Tozalash
      </button>
    )}
  </div>

  {cleanQ && (
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',background:'#eff6ff',color:'#1e40af',border:'1px solid #bfdbfe',borderRadius:10,padding:'8px 14px',fontSize:13,fontWeight:600,marginBottom:14,flexWrap:'wrap',gap:8}}>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <Search size={16}/>
        <span>Barcha kunlar bo‘yicha qidirilmoqda: "<b>{cleanQ}</b>" — <b>{displayRows.length} ta</b> partiya/inventarizatsiya topildi</span>
      </div>
      <button
        type="button"
        className="btn btn-sm btn-outline"
        style={{background:'#fff',borderColor:'#bfdbfe',color:'#1e40af',fontSize:12,height:28,padding:'2px 10px'}}
        onClick={()=>setQuery('')}
      >
        <RotateCcw size={13}/> Qidiruvni bekor qilish
      </button>
    </div>
  )}
  <div className="batch-stats">
    <div><b>{total}</b><span>Jami yozuvlar</span></div>
    <div><b>{aggregates.batchCount ?? batchCount}</b><span>Kirim partiyalari</span></div>
    <div><b>{aggregates.invCount ?? invCount}</b><span>Inventarizatsiyalar</span></div>
    <div><b>{aggregates.totalUnits ?? rows.reduce((s,x)=>s+Number(x.unit_count),0)}</b><span>Jami birliklar</span></div>
    <div><b><DualPrice value={aggregates.totalCost || totalCostAll} rate={rate}/></b><span>Barcha tovarlar tan narxi</span></div>
    <div><b><DualPrice value={aggregates.totalMinPrice || totalMinAll} rate={rate}/></b><span>Barcha tovarlar min. sotish</span></div>
  </div>
  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10,marginBottom:12}}>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <div className="batch-origin-tabs" style={{margin:0}}>
        <button type="button" className={`btn ${typeFilter==='all'?'btn-primary':'btn-outline'}`} onClick={()=>setTypeFilter('all')}>
          Barchasi ({rows.length})
        </button>
        <button type="button" className={`btn ${typeFilter==='batch'?'btn-primary':'btn-outline'}`} onClick={()=>setTypeFilter('batch')}>
          Partiyalar ({batchCount})
        </button>
        <button type="button" className={`btn ${typeFilter==='inventory'?'btn-primary':'btn-outline'}`} style={typeFilter==='inventory'?{background:'#7c3aed',borderColor:'#7c3aed',color:'#fff'}:{borderColor:'#ddd6fe',color:'#6d28d9'}} onClick={()=>setTypeFilter('inventory')}>
          Inventarizatsiya ({invCount})
        </button>
      </div>
      <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
        <button
          type="button"
          className="btn btn-sm"
          style={{
            borderRadius: 20,
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 700,
            background: currencyFilter==='UZS' ? '#16a34a' : '#f0fdf4',
            color: currencyFilter==='UZS' ? '#fff' : '#15803d',
            border: '1px solid ' + (currencyFilter==='UZS' ? '#16a34a' : '#bbf7d0'),
            cursor:'pointer'
          }}
          onClick={()=>setCurrencyFilter(currencyFilter==='UZS' ? 'all' : 'UZS')}
          title="Faqat UZS (so‘m) da yaratilgan partiya va inventarizatsiyalarni ko‘rsatish"
        >
          🇺🇿 UZS da yaratilgan ({uzsCount})
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={{
            borderRadius: 20,
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 700,
            background: currencyFilter==='USD' ? '#0284c7' : '#f0f9ff',
            color: currencyFilter==='USD' ? '#fff' : '#0369a1',
            border: '1px solid ' + (currencyFilter==='USD' ? '#0284c7' : '#bae6fd'),
            cursor:'pointer'
          }}
          onClick={()=>setCurrencyFilter(currencyFilter==='USD' ? 'all' : 'USD')}
          title="Faqat USD ($) da yaratilgan partiya va inventarizatsiyalarni ko‘rsatish"
        >
          💵 USD ($) da yaratilgan ({usdCount})
        </button>
      </div>
    </div>
    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
      <button
        type="button"
        className={`btn ${selectedDate&&isSameDay(selectedDate,new Date())?'btn-primary':'btn-outline'}`}
        style={selectedDate&&isSameDay(selectedDate,new Date())?{fontWeight:700}:{background:'#fff'}}
        onClick={()=>setSelectedDate(getTodayDate())}
      >
        <Calendar size={15}/> Faqat bugun
      </button>
      <button
        type="button"
        className={`btn ${selectedDate===null?'btn-primary':'btn-outline'}`}
        style={selectedDate===null?{fontWeight:700}:{background:'#fff'}}
        onClick={()=>setSelectedDate(null)}
      >
        🌐 Barchasini ko‘rsatish
      </button>
    </div>
  </div>
  <BatchCalendar month={calMonth} setMonth={setCalMonth} batchDates={batchDatesSet} selectedDate={selectedDate} onDateClick={handleDateClick}/>
  {selectedDate ? (
    <div className="batch-date-filter">
      <Calendar size={15}/>
      <span>
        {isSameDay(selectedDate, new Date()) ? 'Bugungi kiritilgan yozuvlar' : formatUzDate(selectedDate, { day: true, month: 'long', year: true })}
        {' '}— {displayRows.length} ta yozuv
      </span>
      <button className="btn" onClick={()=>setSelectedDate(null)} title="Barcha davrlarni ko‘rish">
        <RotateCcw size={14}/> Barchasini ko‘rsatish
      </button>
    </div>
  ) : (
    <div className="batch-date-filter" style={{background:'#f8fafc',borderColor:'#e2e8f0',color:'#475569'}}>
      <Boxes size={15} style={{color:'var(--orange)'}}/>
      <span>Barcha davrlardagi yozuvlar ko‘rsatilmoqda — {displayRows.length} ta yozuv</span>
      <button className="btn" onClick={()=>setSelectedDate(getTodayDate())} style={{background:'#fff',borderColor:'#cbd5e1'}}>
        <Calendar size={14}/> Faqat bugunni ko‘rsatish
      </button>
    </div>
  )}
  <div className="batch-filters-row" style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginBottom:12}}>
    <div className="mobile-search batch-filter-search" style={{flex:1,minWidth:220,margin:0}}>
      <Search/>
      <input
        value={query}
        onChange={e=>setQuery(e.target.value)}
        placeholder="Tovar nomi, SKU, umumiy QR kod, partiya raqami, ta'minotchi..."
      />
    </div>
    <div className="batch-filter-pill" style={{display:'flex',alignItems:'center',gap:6,background:'#fff',padding:'5px 12px',borderRadius:12,border:currencyFilter!=='all'?'1.5px solid #0284c7':'1px solid var(--line,#e2e8f0)',fontSize:13}}>
      <Tag size={15} style={{color:currencyFilter==='USD'?'#0284c7':currencyFilter==='UZS'?'#16a34a':'var(--muted)'}}/>
      <span style={{fontSize:12,color:currencyFilter!=='all'?'#0f172a':'var(--muted)',fontWeight:600}}>Valyuta:</span>
      <select
        className="select"
        style={{border:'none',padding:'3px 6px',fontSize:13,background:'transparent',cursor:'pointer',fontWeight:700,color:currencyFilter==='USD'?'#0284c7':currencyFilter==='UZS'?'#16a34a':'var(--navy,#0f172a)'}}
        value={currencyFilter}
        onChange={e=>setCurrencyFilter(e.target.value)}
      >
        <option value="all">Barcha valyutalar ({rows.length})</option>
        <option value="UZS">UZS (So‘m) ({uzsCount})</option>
        <option value="USD">USD (Dollar $) ({usdCount})</option>
      </select>
    </div>
    <div className="batch-filter-pill" style={{display:'flex',alignItems:'center',gap:6,background:'#fff',padding:'5px 12px',borderRadius:12,border:'1px solid var(--line,#e2e8f0)',fontSize:13}}>
      <MapPin size={15} style={{color:'var(--orange,#ea580c)'}}/>
      <span style={{fontSize:12,color:'var(--muted)',fontWeight:600}}>Joylashuv:</span>
      <select
        className="select"
        style={{border:'none',padding:'3px 6px',fontSize:13,background:'transparent',cursor:'pointer',fontWeight:700,color:'var(--navy,#0f172a)'}}
        value={locationFilter}
        onChange={e=>setLocationFilter(e.target.value)}
      >
        <option value="all">Barcha joylashuvlar ({rows.length})</option>
        {locations.map(loc=>{
          const count = rows.filter(r => r.receiving_location_id === loc.id).length;
          return (
            <option key={loc.id} value={loc.id}>
              {loc.name} {loc.type === 'warehouse' ? '(Ombor)' : '(Do‘kon)'} ({count})
            </option>
          );
        })}
      </select>
    </div>
    <div className="batch-filter-pill" style={{display:'flex',alignItems:'center',gap:6,background:'#fff',padding:'5px 12px',borderRadius:12,border:'1px solid var(--line,#e2e8f0)',fontSize:13}}>
      <ArrowUpDown size={15} style={{color:'var(--muted)'}}/>
      <span style={{fontSize:12,color:'var(--muted)',fontWeight:600}}>Saralash:</span>
      <select className="select" style={{border:'none',padding:'3px 6px',fontSize:13,background:'transparent',cursor:'pointer',fontWeight:700,color:'var(--navy,#0f172a)'}} value={sortBy} onChange={e=>setSortBy(e.target.value)}>
        <option value="newest">Eng yangi (oxirgi yaratilgan)</option>
        <option value="oldest">Eng avvalgi</option>
        <option value="units_desc">Birliklar (ko‘pdan ozga)</option>
        <option value="cost_desc">Tan narxi (yuqoridan pastga)</option>
        <option value="receipt_no">Hujjat raqami bo‘yicha</option>
      </select>
    </div>
  </div>

  {/* Ommaviy valyutani konvertatsiya qilish paneli (kamida 1 ta partiya tanlanganda ochiladi) */}
  {selectedIds.length > 0 && (
    <div style={{
      position: 'sticky',
      top: 10,
      zIndex: 60,
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
      color: '#fff',
      borderRadius: 14,
      padding: '12px 18px',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 14,
      boxShadow: '0 12px 28px -6px rgba(15,23,42,0.45), 0 0 0 1px rgba(255,255,255,0.1)',
      flexWrap: 'wrap'
    }}>
      <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <label style={{display:'inline-flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none'}}>
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleSelectAll}
            style={{width:19,height:19,cursor:'pointer',accentColor:'#ea580c'}}
          />
          <span style={{fontSize:14,fontWeight:700}}>
            <b>{selectedIds.length} ta</b> tanlandi
          </span>
        </label>
        <button
          type="button"
          onClick={toggleSelectAll}
          style={{background:'none',border:'none',color:'#38bdf8',fontSize:13,fontWeight:600,cursor:'pointer',textDecoration:'underline',padding:0}}
        >
          {allVisibleSelected ? 'Tanlovni bekor qilish' : `Filtrdagi barcha (${displayRows.length} ta) yozuvni tanlash`}
        </button>
      </div>

      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <div style={{fontSize:12,background:'rgba(255,255,255,0.12)',padding:'4px 10px',borderRadius:8,color:'#e2e8f0'}}>
          Bugungi kurs: <b>1$ = {Number(rate || 12800).toLocaleString('uz-UZ')} so‘m</b>
        </div>
        <button
          type="button"
          className="btn"
          style={{
            background:'#0284c7',
            color:'#fff',
            borderColor:'#0284c7',
            display:'inline-flex',
            alignItems:'center',
            gap:6,
            fontWeight:700,
            fontSize:13,
            padding:'7px 14px',
            boxShadow:'0 2px 8px rgba(2,132,199,0.35)'
          }}
          disabled={convertingCurrency}
          onClick={() => handleConvertSelected('USD')}
          title="Tanlangan partiyalarning tannarxini bugungi kursda USD ($) ga o'tkazish (USD da konstanta bo'ladi)"
        >
          {convertingCurrency ? <Loader2 size={15} className="spinner"/> : <ArrowRight size={15}/>}
          USD ($) ga o‘tkazish
        </button>
        <button
          type="button"
          className="btn"
          style={{
            background:'#16a34a',
            color:'#fff',
            borderColor:'#16a34a',
            display:'inline-flex',
            alignItems:'center',
            gap:6,
            fontWeight:700,
            fontSize:13,
            padding:'7px 14px',
            boxShadow:'0 2px 8px rgba(22,163,74,0.35)'
          }}
          disabled={convertingCurrency}
          onClick={() => handleConvertSelected('UZS')}
          title="Tanlangan partiyalarning tannarxini bugungi kursda UZS (so'm) ga o'tkazish"
        >
          {convertingCurrency ? <Loader2 size={15} className="spinner"/> : <ArrowRight size={15}/>}
          UZS (so‘m) ga o‘tkazish
        </button>
        <button
          type="button"
          className="btn btn-outline"
          style={{color:'#cbd5e1',borderColor:'#475569',fontSize:13,padding:'7px 12px'}}
          onClick={() => setSelectedIds([])}
          disabled={convertingCurrency}
        >
          Bekor qilish
        </button>
      </div>
    </div>
  )}

  {/* Tezkor "Barchasini tanlash" va filtr ko'rsatkichi qatori */}
  {sortedRows.length > 0 && (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',margin:'6px 2px 12px',flexWrap:'wrap',gap:8}}>
      <label style={{display:'inline-flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13,fontWeight:600,color:'#334155',userSelect:'none'}}>
        <input
          type="checkbox"
          checked={allVisibleSelected}
          onChange={toggleSelectAll}
          style={{width:17,height:17,cursor:'pointer',accentColor:'#ea580c'}}
        />
        <span>
          {allVisibleSelected ? 'Filtrdagi barcha yozuvlar tanlandi' : 'Barchasini tanlash'} ({displayRows.length} ta yozuv)
        </span>
      </label>
      <div style={{display:'flex',alignItems:'center',gap:12,fontSize:12,color:'#64748b',fontWeight:500}}>
        {currencyFilter !== 'all' && (
          <span>
            Filtr: <b style={{color:currencyFilter==='USD'?'#0284c7':'#16a34a'}}>{currencyFilter==='USD'?'USD ($) da yaratilganlar':'UZS da yaratilganlar'}</b>
          </span>
        )}
        {selectedIds.length > 0 && (
          <span style={{color:'#0284c7',fontWeight:700}}>
            Tanlangan: {selectedIds.length} ta
          </span>
        )}
      </div>
    </div>
  )}

  {loading?<div className="inventory-state">Yuklanmoqda…</div>:error?<ErrorState message={error} retry={load}/>:sortedRows.length===0?(
    <div>
      <Empty
        title={selectedDate?(isSameDay(selectedDate,new Date())?"Bugun kiritilgan partiya yoki inventarizatsiya yo‘q":"Bu kunda partiya yoki inventarizatsiya yo‘q"):"Hech narsa topilmadi"}
        text={selectedDate?"Barcha davrlarni ko‘rish uchun 'Barchasini ko‘rsatish' tugmasini bosing yoki yangi yozuv yarating.":"Yangi partiya yoki inventarizatsiya yarating."}
      />
      {selectedDate&&(
        <div style={{display:'flex',justifyContent:'center',marginTop:12}}>
          <button className="btn btn-primary" onClick={()=>setSelectedDate(null)} style={{display:'inline-flex',alignItems:'center',gap:6}}>
            🌐 Barchasini ko‘rsatish (barcha davrlar)
          </button>
        </div>
      )}
    </div>
  ):(
    <>
      <div className="batch-list">{visibleRows.map(x=>{
    const isInv=isInventoryReceipt(x.receipt_no);
    const itemCurrency=String(x.currency||'USD').toUpperCase();
    const isSelected=selectedIds.includes(x.id);
    return <article className="card" key={x.id} style={{
      ...(isInv?{borderLeft:'4px solid #7c3aed'}:{borderLeft:'4px solid var(--orange)'}),
      ...(isSelected?{background:'#f8fafc',outline:'2px solid #0284c7',outlineOffset:1}:{})
    }}>
      <div className="batch-card-header">
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={()=>toggleSelectOne(x.id)}
            style={{width:18,height:18,cursor:'pointer',accentColor:'#ea580c'}}
            title="Tanlash"
          />
          <span className={'batch-origin '+(isInv?'batch-origin-inventory':'batch-origin-batch')} style={isInv?{background:'#f3e8ff',color:'#6b21a8',border:'1px solid #d8b4fe'}:{}}>
            {isInv?'Inventarizatsiya':'Partiya'}
          </span>
          <span style={{
            display:'inline-flex',
            alignItems:'center',
            gap:4,
            background: itemCurrency === 'USD' ? '#f0f9ff' : '#f0fdf4',
            color: itemCurrency === 'USD' ? '#0369a1' : '#15803d',
            border: `1px solid ${itemCurrency === 'USD' ? '#bae6fd' : '#bbf7d0'}`,
            padding:'2px 8px',
            borderRadius:6,
            fontSize:11,
            fontWeight:800
          }} title={`Yaratilgan valyutasi: ${itemCurrency}`}>
            {itemCurrency === 'USD' ? '$ USD (Dollar)' : 'UZS (So‘m)'}
          </span>
          <span style={{
            display:'inline-flex',
            alignItems:'center',
            gap:4,
            background: x.location_type === 'warehouse' ? '#ecfdf5' : '#eff6ff',
            color: x.location_type === 'warehouse' ? '#047857' : '#1d4ed8',
            border: `1px solid ${x.location_type === 'warehouse' ? '#a7f3d0' : '#bfdbfe'}`,
            padding:'2px 8px',
            borderRadius:6,
            fontSize:11,
            fontWeight:700
          }} title={`Joylashuvi: ${x.location_name || 'Aniqlanmagan'}`}>
            <MapPin size={11}/>
            {x.location_name || 'Joylashuv'} {x.location_type === 'warehouse' ? '(Omborda)' : '(Do‘konda)'}
          </span>
        </div>
        <Status type={x.payment_status==='paid'?'green':'orange'}>{x.payment_status==='paid'?'To‘langan':x.payment_status==='partial'?'Qisman':'To‘lanmagan'}</Status>
      </div>
      <div className="batch-top">
        <div className="batch-icon" style={isInv?{background:'#f3e8ff',color:'#7c3aed'}:{}}><PackagePlus/></div>
        <div><b>{x.receipt_no}</b><span>{x.supplier_name||(isInv?'Inventarizatsiya ro‘yxati':'Ta’minotchi ko‘rsatilmagan')}</span></div>
      </div>
      <div className="batch-meta">
        <span><Clock3/>{new Date(x.received_at).toLocaleDateString('uz-UZ')}</span>
        <span><Boxes/>{Number(x.unit_count)} dona</span>
        <span><QrCode/>{x.line_count} tur QR</span>
        <span title={`Joylashuvi: ${x.location_name || '—'}`}><Warehouse size={13}/>{x.location_name || '—'}</span>
      </div>
      {Array.isArray(x.items) && x.items.length > 0 && (
        <div className="batch-card-items-preview" style={{
          margin: '10px 0 6px',
          padding: '8px 10px',
          background: 'rgba(248, 250, 252, 0.9)',
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          gap: 6
        }}>
          <div style={{fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'flex', justifyContent: 'space-between'}}>
            <span>Ichidagi tovarlar:</span>
            <span>{x.items.length} xil</span>
          </div>
          <div style={{display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 110, overflowY: 'auto'}}>
            {x.items.slice(0, 4).map((it, idx) => (
              <div key={it.batch_id || idx} style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1}}>
                  {it.image_url ? (
                    <img src={it.image_url} alt="" style={{width: 26, height: 26, objectFit: 'cover', borderRadius: 5, border: '1px solid #cbd5e1', flexShrink: 0}} />
                  ) : (
                    <div style={{width: 26, height: 26, borderRadius: 5, background: '#e2e8f0', display: 'grid', placeItems: 'center', color: '#94a3b8', fontSize: 10, flexShrink: 0}}>
                      <Boxes size={13}/>
                    </div>
                  )}
                  <span style={{whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600, color: '#0f172a'}} title={it.product_name}>
                    {it.product_name || 'Nomsiz tovar'}
                  </span>
                  {it.variant_color && (
                    <span style={{fontSize: 10, background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, color: '#475569', flexShrink: 0}}>
                      {it.variant_color}
                    </span>
                  )}
                </div>
                {it.qr_code && (
                  <code style={{fontSize: 10, padding: '1px 5px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 4, fontWeight: 700, color: '#334155'}} title="Partiya umumiy QR kodi">
                    {it.qr_code}
                  </code>
                )}
                <span style={{fontSize: 11, fontWeight: 700, color: '#0369a1', background: '#e0f2fe', padding: '1px 6px', borderRadius: 4, flexShrink: 0}}>
                  {it.quantity} dona
                </span>
              </div>
            ))}
            {x.items.length > 4 && (
              <div style={{fontSize: 11, color: 'var(--muted)', textAlign: 'center', fontStyle: 'italic', paddingTop: 2}}>
                + yana {x.items.length - 4} ta tovar
              </div>
            )}
          </div>
        </div>
      )}
      <div className="batch-card-bottom">
        <span>{x.line_count} xil tovar · Tan: <DualPrice value={Number(x.total_cost||0)} rate={rate}/> · Sotish: <DualPrice value={Number(x.total_retail||0)} rate={rate}/></span>
        <div className="batch-card-actions">
          <button
            type="button"
            className="btn btn-outline"
            style={{
              padding:'4px 8px',
              fontSize:12,
              color: itemCurrency==='USD' ? '#16a34a' : '#0284c7',
              borderColor: itemCurrency==='USD' ? '#86efac' : '#7dd3fc',
              background: itemCurrency==='USD' ? '#f0fdf4' : '#f0f9ff',
              display:'inline-flex',
              alignItems:'center',
              gap:4,
              height:28,
              fontWeight:700
            }}
            title={itemCurrency==='USD' ? "Valyutani UZS (so‘m) ga o‘tkazish" : "Valyutani bugungi kursda USD ($) ga o‘tkazish (tannarx USD da konstanta bo‘ladi)"}
            disabled={convertingCurrency}
            onClick={()=>handleConvertSelected(itemCurrency==='USD'?'UZS':'USD', [x.id])}
          >
            <ArrowRight size={13}/>{itemCurrency==='USD' ? 'UZS ga' : 'USD ($) ga'}
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,color:'#16a34a',borderColor:'#86efac',background:'#f0fdf4',display:'inline-flex',alignItems:'center',gap:4,height:28,fontWeight:600}} title="Ushbu partiyadagi tovarlarni Excel (.xlsx) formatida yuklash" disabled={exportingExcel} onClick={()=>handleExportExcel(x)}>
            <FileSpreadsheet size={13}/>Excel
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,display:'inline-flex',alignItems:'center',gap:4,height:28}} title="Zahiraga yuklab olish (JSON)" disabled={exportingId===x.id} onClick={()=>handleExportSingle(x.id,x.receipt_no)}>
            <Download size={13}/>{exportingId===x.id?'…':'JSON'}
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,display:'inline-flex',alignItems:'center',gap:4,height:28}} title="Tahrirlash" onClick={()=>open(x.id,true)}>
            <Pencil size={13}/>Tahrirlash
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 8px',fontSize:12,color:'#ef4444',borderColor:'#fecaca',background:'#fff5f5',display:'inline-flex',alignItems:'center',gap:4,height:28}} title="O‘chirish" disabled={deletingId===x.id} onClick={()=>deleteBatch(x.id,x.receipt_no)}>
            <Trash2 size={13}/>{deletingId===x.id?'O‘chirilmoqda…':'O‘chirish'}
          </button>
          <button type="button" className="btn btn-outline" style={{padding:'4px 10px',fontSize:12,display:'inline-flex',alignItems:'center',gap:4,height:28}} onClick={()=>open(x.id,false)}>
            Batafsil <ChevronRight size={14}/>
          </button>
        </div>
      </div>
    </article>;
  })}</div>
  {sortedRows.length > visibleCount && (
    <div className="batch-load-more-container" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: '24px 16px',
      margin: '20px 0 32px',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(248,250,252,0.98) 100%)',
      borderRadius: 14,
      border: '1px dashed #cbd5e1'
    }}>
      <div style={{fontSize: 13, color: '#64748b', fontWeight: 600}}>
        Ko‘rsatilmoqda: <b style={{color: '#0f172a'}}>{visibleCount}</b> / {sortedRows.length} ta yozuv
      </div>
      <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center'}}>
        <button
          type="button"
          className="btn btn-primary"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 22px',
            fontSize: 14,
            fontWeight: 700,
            boxShadow: '0 4px 12px rgba(234, 88, 12, 0.25)'
          }}
          onClick={() => setVisibleCount(prev => prev + 30)}
        >
          <ChevronDown size={17}/>
          Yana 30 ta yuklash (Load more)
          <span style={{
            background: 'rgba(255,255,255,0.25)',
            padding: '2px 8px',
            borderRadius: 12,
            fontSize: 12,
            fontWeight: 800
          }}>
            +{Math.min(30, sortedRows.length - visibleCount)}
          </span>
        </button>
        <button
          type="button"
          className="btn btn-outline"
          style={{fontSize: 13, height: 38, padding: '0 16px', color: '#475569', background: '#fff'}}
          onClick={() => setVisibleCount(sortedRows.length)}
        >
          Barchasini ochish ({sortedRows.length} ta)
        </button>
      </div>
      <div style={{fontSize: 12, color: '#94a3b8'}}>
        Qolgan: {sortedRows.length - visibleCount} ta yozuv
      </div>
    </div>
  )}
  {sortedRows.length > 30 && visibleCount >= sortedRows.length && (
    <div style={{textAlign: 'center', padding: '16px', color: '#16a34a', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, margin: '12px 0 24px'}}>
      <CheckCircle2 size={16}/>
      Barcha {sortedRows.length} ta yozuv to‘liq ko‘rsatildi
    </div>
  )}
  </>
  )}
  <ReceiptDetail receipt={detail} locations={locations} toast={toast} initialEditing={detailEdit} close={()=>{setDetail(null);setDetailEdit(false);}} onUpdated={(updated)=>{if(updated){setDetail(updated);setDetailEdit(false);}else{setDetail(null);setDetailEdit(false);}load();}} onExportSingle={handleExportSingle}/>
  {passwordModal && (
    <Modal open={Boolean(passwordModal)} onClose={() => setPasswordModal(null)} title="Sotilgan tovarlar mavjud — Parol talab qilinadi">
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!passwordModal.password?.trim()) return;
          deleteBatch(passwordModal.id, passwordModal.receiptNo, passwordModal.password.trim());
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertTriangle size={20} color="#ea580c" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: '#9a3412', lineHeight: 1.5 }}>
            <b>"{passwordModal.receiptNo}"</b> partiyasidan sotilgan tovarlar bor!
            <br />
            Ushbu partiyani va barcha bog‘liq birliklarni butunlay o‘chirish uchun tasdiqlash parolini kiriting.
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Tasdiqlash paroli:
          </label>
          <input
            type="password"
            autoFocus
            className="input"
            style={{ width: '100%', padding: '8px 12px', fontSize: 14 }}
            placeholder="Parolni kiriting..."
            value={passwordModal.password || ''}
            onChange={e => setPasswordModal(prev => ({ ...prev, password: e.target.value, error: '' }))}
          />
        </div>

        {passwordModal.error && (
          <div style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: '8px 12px', borderRadius: 6, border: '1px solid #fecaca' }}>
            {passwordModal.error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setPasswordModal(null)}
            disabled={deletingId === passwordModal.id}
          >
            Bekor qilish
          </button>
          <button
            type="submit"
            className="btn"
            style={{ background: '#dc2626', color: '#fff', borderColor: '#dc2626' }}
            disabled={!passwordModal.password?.trim() || deletingId === passwordModal.id}
          >
            <Trash2 size={15} />
            {deletingId === passwordModal.id ? 'O‘chirilmoqda…' : 'O‘chirish'}
          </button>
        </div>
      </form>
    </Modal>
  )}
  <BatchBackupRestoreModal
    open={restoreModalOpen}
    onClose={()=>setRestoreModalOpen(false)}
    branchId={branchId}
    onRestored={()=>{load();toast?.('Partiyalar va tovarlar muvaffaqiyatli tiklandi');}}
    toast={toast}
  />
  <InventoryExcelImportModal
    open={excelImportOpen}
    onClose={()=>setExcelImportOpen(false)}
    branchId={branchId}
    locations={locations}
    rate={rate}
    toast={toast}
    onImported={()=>{
      setSelectedDate(getTodayDate());
      setTypeFilter('all');
      setQuery('');
      load(getTodayDate());
      toast?.('Excel fayldagi tovarlar muvaffaqiyatli qabul qilindi');
    }}
  />
  <BatchPriceExcelModal
    open={batchPriceModalOpen}
    onClose={()=>setBatchPriceModalOpen(false)}
    branchId={branchId}
    receipts={rows}
    rate={rate}
    toast={toast}
    onUpdated={()=>{
      load(selectedDate);
      toast?.('Tovarlar narxlari muvaffaqiyatli yangilandi');
    }}
  />
  </>;
}
function BatchCalendar({month,setMonth,batchDates,selectedDate,onDateClick}){
  const year=month.getFullYear(),mo=month.getMonth();
  const firstDay=new Date(year,mo,1).getDay();
  const daysInMonth=new Date(year,mo+1,0).getDate();
  const today=new Date();
  const weeks=[];let day=1-firstDay;
  for(let w=0;w<6;w++){const week=[];for(let d=0;d<7;d++,day++){week.push(day<1||day>daysInMonth?null:day)}weeks.push(week);if(day>daysInMonth)break}
  const prevMonth=()=>setMonth(new Date(year,mo-1,1));
  const nextMonth=()=>setMonth(new Date(year,mo+1,1));
  const monthName=getUzMonthName(month, { withYear: true });
  return <div className="batch-calendar card"><div className="batch-cal-header"><button className="btn" onClick={prevMonth}><ChevronLeft size={16}/></button><b>{monthName}</b><button className="btn" onClick={nextMonth}><ChevronRight size={16}/></button></div><div className="batch-cal-grid"><span className="cal-weekday">Ya</span><span className="cal-weekday">Du</span><span className="cal-weekday">Se</span><span className="cal-weekday">Ch</span><span className="cal-weekday">Pa</span><span className="cal-weekday">Ju</span><span className="cal-weekday">Sh</span>{weeks.flat().map((d,i)=>{if(d===null)return <span key={i} className="cal-day empty"/>;const key=`${year}-${mo}-${d}`;const hasBatch=batchDates.has(key);const isSelected=selectedDate&&selectedDate.getFullYear()===year&&selectedDate.getMonth()===mo&&selectedDate.getDate()===d;const isToday=today.getFullYear()===year&&today.getMonth()===mo&&today.getDate()===d;let cls='cal-day';if(hasBatch)cls+=' has-batch';if(isSelected)cls+=' selected';if(isToday)cls+=' today';return <button key={i} className={cls} onClick={()=>onDateClick(new Date(year,mo,d))}>{d}</button>})}</div></div>;
}
export function InventoryStock({branchId,onScan,onRegister,toast}){
  const rate=useExchangeRate();
  const[rows,setRows]=useState([]),[totalRows,setTotalRows]=useState(0),[aggregates,setAggregates]=useState({totalOnHand:0,totalValue:0,totalCost:0}),[refs,setRefs]=useState({locations:[],categories:[],brands:[]}),[colors,setColors]=useState([]),[form,setForm]=useState({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''}),[applied,setApplied]=useState({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''}),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(50),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selectedProduct,setSelectedProduct]=useState(null),[editingProduct,setEditingProduct]=useState(null),[selected,setSelected]=useState([]);
  const[importModal,setImportModal]=useState(false);
  useEffect(()=>{if(branchId){getInventoryReferences(branchId).then(r=>setRefs(prev=>({...prev,...r}))).catch(e=>setError(err(e)));getBrowserClient().from('categories').select('id,name,parent_id').eq('is_active',true).then(({data})=>setRefs(prev=>({...prev,categories:data||[]}))).catch(()=>{});getBrowserClient().from('product_variants').select('product_id,color_name,color_hex').eq('is_active',true).then(({data})=>setColors(data||[])).catch(()=>{})}},[branchId]);
  const load=async()=>{
    if(!branchId)return;
    setLoading(true);
    setError('');
    try{
      const r=await listInventoryBalances({branchId,locationId:applied.location||null,query:applied.query||null,categoryId:applied.category||null,minPrice:applied.minPrice||null,maxPrice:applied.maxPrice||null,availability:applied.availability||null,page,pageSize});
      let items=r.items||[];
      if(applied.color){
        const productIdsWithColor=new Set(colors.filter(v=>v.color_name===applied.color).map(v=>v.product_id));
        items=items.filter(i=>productIdsWithColor.has(i.product_id));
      }
      setRows(items);
      setTotalRows(Number(r.total)||items.length);
      setAggregates({
        totalOnHand: Number(r.total_on_hand ?? 0),
        totalValue: Number(r.total_value ?? 0),
        totalCost: Number(r.total_cost ?? 0)
      });
    }catch(e){
      setError(err(e));
    }finally{
      setLoading(false);
    }
  };
  useEffect(()=>{load()},[branchId,applied,page,pageSize]);
  const apply=e=>{e?.preventDefault();setPage(1);setApplied({...form})};
  const reset=()=>{setForm({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''});setApplied({query:'',location:'',category:'',color:'',minPrice:'',maxPrice:'',availability:''});setPage(1)};
  const distinctColors=useMemo(()=>{const seen=new Map();colors.forEach(v=>{if(!seen.has(v.color_name))seen.set(v.color_name,v.color_hex)});return[...seen.entries()].map(([color_name,color_hex])=>({color_name,color_hex})).sort((a,b)=>a.color_name.localeCompare(b.color_name))},[colors]);
  const toggle=id=>setSelected(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
  const allSelected=rows.length>0&&rows.every(r=>selected.includes(r.product_id));
  const toggleAll=()=>setSelected(allSelected?[]:[...new Set(rows.map(r=>r.product_id))]);
  const selectAllFiltered=async()=>{
    try{
      setLoading(true);
      const r=await listInventoryBalances({
        branchId,
        locationId: applied.location || null,
        query: applied.query || null,
        categoryId: applied.category || null,
        minPrice: applied.minPrice || null,
        maxPrice: applied.maxPrice || null,
        availability: applied.availability || null,
        page: 1,
        pageSize: 5000
      });
      let items = r?.items || [];
      if (applied.color) {
        const productIdsWithColor = new Set(colors.filter(v => v.color_name === applied.color).map(v => v.product_id));
        items = items.filter(i => productIdsWithColor.has(i.product_id));
      }
      const ids = [...new Set(items.map(p => p.product_id).filter(Boolean))];
      setSelected(ids);
    }catch(e){
      setError(err(e));
    }finally{
      setLoading(false);
    }
  };
  const bulkDelete=async()=>{
    if(!selected.length||!confirm(`${selected.length} ta mahsulotni butunlay o‘chirishni tasdiqlaysizmi?\n\nDIQQAT: Ushbu mahsulotlar va ularning ombordagi barcha birliklari o‘chiriladi. Bu amalni qaytarib bo‘lmaydi!`))return;
    setLoading(true);
    try{
      const client=getBrowserClient();
      const chunkSize=150;
      for(let i=0;i<selected.length;i+=chunkSize){
        const chunk=selected.slice(i,i+chunkSize);
        const{error:rpcErr}=await client.rpc('delete_products_cascade',{p_product_ids:chunk});
        if(rpcErr)throw rpcErr;
      }
      toast?.(`${selected.length} ta mahsulot muvaffaqiyatli o‘chirildi`);
      setSelected([]);
      await load();
    }catch(e){
      setError(err(e));
      setLoading(false);
    }
  };
  const activeCategory=(refs.categories||[]).find(c=>c.id===(applied.category||form.category));
  const deleteActiveCategory=async()=>{
    const catId=applied.category||form.category;
    if(!catId||!activeCategory)return;
    const client=getBrowserClient();
    const subCats=(refs.categories||[]).filter(c=>c.parent_id===catId).map(c=>c.id);
    const catIds=[catId,...subCats];
    const{count,error:cErr}=await client.from('products').select('id',{count:'exact',head:true}).in('category_id',catIds);
    const prodCount=count||0;
    if(prodCount===0){
      alert(`“${activeCategory.name}” kategoriyasida tovar topilmadi.`);
      return;
    }
    if(!confirm(`DIQQAT!\n\n“${activeCategory.name}” kategoriyasidagi BARCHA (${prodCount} ta) tovarlarni butunlay o‘chirishni tasdiqlaysizmi?\n\nBu amal ushbu tovarlar, ombor qoldiqlari va seriyalarini butunlay o‘chiradi va uni qaytarib bo‘lmaydi!`))return;

    setLoading(true);
    try{
      const{error:rpcErr}=await client.rpc('delete_category_products_cascade',{p_category_id:catId,p_include_children:true});
      if(rpcErr)throw rpcErr;
      setSelected([]);
      await load();
    }catch(e){
      try{
        const{data:prods}=await client.from('products').select('id').in('category_id',catIds);
        for(const p of(prods||[])){
          await client.rpc('delete_product_cascade',{p_product_id:p.id});
        }
        setSelected([]);
        await load();
      }catch(err2){
        setError(err(err2||e));
        setLoading(false);
      }
    }
  };
  const deleteProduct=async item=>{if(!confirm(item.product_name+" mahsulotini o'chirasizmi?"))return;try{const{error:e2}=await getBrowserClient().rpc('delete_product_cascade',{p_product_id:item.product_id});if(e2)throw e2;setRows(prev=>prev.filter(r=>r.product_id!==item.product_id))}catch(e){setError(err(e))}};
  const parents=(refs.categories||[]).filter(c=>!c.parent_id);
  return <><div className="m-page-head between"><div><h2>Tovarlar</h2><p>Filial do'kon va ombor qoldig'i</p></div><div style={{display:'flex',gap:8,alignItems:'center'}}><button type="button" className="btn btn-outline" onClick={()=>setImportModal(true)}><FileSpreadsheet size={16}/>Exceldan import qilish</button><button className="btn btn-primary" onClick={onRegister}><Plus/>Tovar qo'shish</button><button className="btn" onClick={onScan}><QrCode/>QR</button></div></div>
  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:14}}>
    <div className="card" style={{padding:14,textAlign:'center'}}><Boxes size={18}/><div><b style={{fontSize:18}}>{totalRows || 0} ta</b><br/><small style={{color:'var(--muted)'}}>Tovar turlari (jami)</small></div></div>
    <div className="card" style={{padding:14,textAlign:'center'}}><Warehouse size={18}/><div><b style={{fontSize:18}}>{aggregates.totalOnHand} dona</b><br/><small style={{color:'var(--muted)'}}>Mavjud qoldiq</small></div></div>
    <div className="card" style={{padding:14,textAlign:'center'}}><Boxes size={18}/><div><b style={{fontSize:18}}><DualPrice value={aggregates.totalValue} rate={rate}/></b><br/><small style={{color:'var(--muted)'}}>Sotish narxi</small></div></div>
    <div className="card" style={{padding:14,textAlign:'center'}}><Warehouse size={18}/><div><b style={{fontSize:18}}><DualPrice value={aggregates.totalCost} rate={rate}/></b><br/><small style={{color:'var(--muted)'}}>Tannarxi</small></div></div>
  </div>
  <div className="card" style={{padding:14}}>
    <form style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap',alignItems:'flex-end'}} onSubmit={apply}>
      <label style={{flex:'2 1 200px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Qidiruv</small><div style={{display:'flex',alignItems:'center',gap:8,border:'1px solid var(--line)',borderRadius:10,padding:'0 10px',height:38}}><Search size={15}/><input style={{border:0,outline:0,flex:1,minWidth:0}} value={form.query} onChange={e=>setForm({...form,query:e.target.value})} placeholder="Mahsulot, SKU"/></div></label>
      <label style={{flex:'1 1 140px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Joylashuv</small><select className="select" style={{height:38}} value={form.location} onChange={e=>setForm({...form,location:e.target.value})}><option value="">Barchasi</option>{refs.locations?.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label style={{flex:'1 1 140px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Kategoriya</small><select className="select" style={{height:38}} value={form.category} onChange={e=>setForm({...form,category:e.target.value})}><option value="">Barchasi</option>{parents.map(p=><optgroup key={p.id} label={p.name}><option value={p.id}>{p.name}</option>{(refs.categories||[]).filter(c=>c.parent_id===p.id).map(ch=><option key={ch.id} value={ch.id}>&nbsp;{ch.name}</option>)}</optgroup>)}</select></label>
      <label style={{flex:'1 1 130px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Rang</small><select className="select" style={{height:38}} value={form.color} onChange={e=>setForm({...form,color:e.target.value})}><option value="">Barchasi</option>{distinctColors.map(c=><option key={c.color_name} value={c.color_name}>{c.color_name}</option>)}</select></label>
      <label style={{flex:'0 1 100px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Min narx</small><input className="input" type="number" min="0" style={{height:38}} value={form.minPrice} onChange={e=>setForm({...form,minPrice:e.target.value})} placeholder="0"/></label>
      <label style={{flex:'0 1 100px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Max narx</small><input className="input" type="number" min="0" style={{height:38}} value={form.maxPrice} onChange={e=>setForm({...form,maxPrice:e.target.value})} placeholder="~"/></label>
      <label style={{flex:'1 1 120px'}}><small style={{display:'block',fontWeight:700,marginBottom:4,color:'#475467'}}>Mavjudlik</small><select className="select" style={{height:38}} value={form.availability} onChange={e=>setForm({...form,availability:e.target.value})}><option value="">Barchasi</option><option value="available">Mavjud (&gt;0)</option><option value="empty">Tugagan (0)</option></select></label>
      <button className="btn btn-primary" style={{height:38}}>Qidirish</button>
      <button type="button" className="btn" style={{height:38}} onClick={reset}>Tozalash</button>
    </form>
    {activeCategory&&(
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'8px 12px',marginBottom:10,background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:10,fontSize:12,color:'#9a3412',flexWrap:'wrap'}}>
        <span>Kategoriya: <b>{activeCategory.name}</b> ({totalRows} ta mahsulot)</span>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <button type="button" className="btn" style={{padding:'5px 10px',fontSize:11}} onClick={selectAllFiltered}>Ushbu kategoriyani to‘liq tanlash</button>
          <button type="button" className="btn" style={{background:'#fee2e2',color:'#b91c1c',borderColor:'#fecaca',padding:'5px 10px',fontSize:11}} onClick={deleteActiveCategory}>
            <Trash2 size={13}/> Kategoriyadagi barcha tovarlarni o‘chirish
          </button>
        </div>
      </div>
    )}
    {selected.length>0&&(
      <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 12px',marginBottom:10,background:'#fef2f2',borderRadius:10,flexWrap:'wrap'}}>
        <b style={{fontSize:12}}>
          {selected.length === totalRows && totalRows > rows.length 
            ? `Barcha ${totalRows} ta mahsulot tanlangan`
            : `${selected.length} ta tanlangan ${selected.length === rows.length && totalRows > rows.length ? '(ushbu sahifada)' : ''}`}
        </b>
        {selected.length === rows.length && totalRows > rows.length && (
          <button 
            type="button" 
            className="btn btn-outline" 
            style={{padding:'4px 10px',fontSize:11,background:'#fff',border:'1px solid #fed7aa',color:'#c2410c'}} 
            onClick={selectAllFiltered}
          >
            Barcha {totalRows} ta tovarni tanlash
          </button>
        )}
        <button className="btn" style={{background:'#fee2e2',color:'#b91c1c',borderColor:'#fecaca',padding:'6px 14px',fontSize:11}} onClick={bulkDelete}>
          <Trash2 size={13}/> Tanlanganlarni o‘chirish
        </button>
        <button className="btn" style={{padding:'6px 14px',fontSize:11}} onClick={()=>setSelected([])}>
          Bekor
        </button>
      </div>
    )}
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
      <span style={{fontSize:13,color:'var(--muted)'}}>
        Jami: <b>{totalRows}</b> ta mahsulot {totalRows > pageSize ? `(${page}-sahifa, ${Math.ceil(totalRows/pageSize)} ta sahifadan)` : ''}
      </span>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span style={{fontSize:12,color:'var(--muted)'}}>Har sahifada:</span>
        <select 
          className="select" 
          style={{height:28,padding:'2px 8px',fontSize:12}}
          value={pageSize} 
          onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
        >
          <option value={50}>50 tadan</option>
          <option value={100}>100 tadan</option>
          <option value={200}>200 tadan</option>
          <option value={500}>500 tadan</option>
        </select>
      </div>
    </div>
    {loading ? (
      <div className="ops-state">Tovarlar yuklanmoqda…</div>
    ) : error ? (
      <ErrorState message={error} retry={load} />
    ) : rows.length === 0 ? (
      <Empty title="Tovar topilmadi" text="Partiya qabul qiling yoki filtrni o'zgartiring." />
    ) : (
      <>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th>Mahsulot</th>
                <th>Filial</th>
                <th>Joylashuv</th>
                <th>Turi</th>
                <th>Jami</th>
                <th>Mavjud</th>
                <th>Sotish narxi</th>
                <th>Tannarxi</th>
                <th>Amal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(item => (
                <tr
                  key={`${item.location_id}-${item.product_id}`}
                  style={{ cursor: 'pointer', background: selected.includes(item.product_id) ? 'rgba(249,115,22,0.08)' : 'inherit' }}
                  onClick={() => setSelectedProduct(item)}
                >
                  <td onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.includes(item.product_id)} onChange={() => toggle(item.product_id)} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {item.image ? (
                        <img src={item.image} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover' }} />
                      ) : (
                        <span style={{ width: 36, height: 36, borderRadius: 8, background: '#f1f5f9', display: 'grid', placeItems: 'center' }}>
                          <Boxes size={16} />
                        </span>
                      )}
                      <div>
                        <b>{item.product_name}</b><br />
                        <small style={{ color: 'var(--muted)' }}>{item.sku}</small>
                      </div>
                    </div>
                  </td>
                  <td>{item.branch_name}</td>
                  <td>{item.location_name}</td>
                  <td>
                    <Status type={item.location_type === 'warehouse' ? 'blue' : 'green'}>{item.location_type}</Status>
                  </td>
                  <td><b>{Number(item.on_hand)}</b></td>
                  <td><b>{Number(item.available)}</b></td>
                  <td>
                    <DualPrice
                      value={Number(item.retail_price || 0)}
                      usdValue={item.retail_price_usd != null ? Number(item.retail_price_usd) : undefined}
                      rate={rate}
                    />
                  </td>
                  <td>
                    <DualPrice
                      value={Number(item.cost_price || 0)}
                      usdValue={item.cost_price_usd != null ? Number(item.cost_price_usd) : undefined}
                      rate={rate}
                    />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                      <button className="btn" style={{ padding: '5px 8px' }} title="Tahrirlash" onClick={() => setEditingProduct(item)}>
                        <Pencil size={13} />
                      </button>
                      <button className="btn" style={{ padding: '5px 8px' }} title="O‘chirish" onClick={() => deleteProduct(item)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalRows > pageSize && (
          <div className="pagination" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <span>{totalRows ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalRows)} / ${totalRows} ta` : '0 ta'}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" disabled={page === 1} onClick={() => setPage(x => x - 1)}>‹ Oldingi</button>
              <button className="btn btn-sm active" style={{ fontWeight: 700 }}>{page} / {Math.ceil(totalRows / pageSize)}</button>
              <button className="btn btn-sm" disabled={page >= Math.ceil(totalRows / pageSize)} onClick={() => setPage(x => x + 1)}>Keyingi ›</button>
            </div>
          </div>
        )}
      </>
    )}
  </div>

  {editingProduct&&<ProductEditor open={Boolean(editingProduct)} close={()=>setEditingProduct(null)} product={editingProduct} refs={refs} toast={toast} saved={load} RichTextEditor={RichTextEditor}/>}
  {selectedProduct&&<ProductDetailModal product={selectedProduct} close={()=>setSelectedProduct(null)} branchId={branchId} rate={rate} onEdit={setEditingProduct}/>}
  <ProductExcelImportModal open={importModal} onClose={()=>setImportModal(false)} onImported={load} branchId={branchId}/>
  </>;
}
function ProductDetailModal({product,close,branchId,rate,onEdit}){
  const[detail,setDetail]=useState(null),[units,setUnits]=useState([]),[media,setMedia]=useState([]),[variants,setVariants]=useState([]),[loading,setLoading]=useState(true),[filterLocation,setFilterLocation]=useState(''),[filterStatus,setFilterStatus]=useState(''),[filterColor,setFilterColor]=useState(''),[unitQuery,setUnitQuery]=useState(''),[editDesc,setEditDesc]=useState(false),[desc,setDesc]=useState(''),[videoUrl,setVideoUrl]=useState(''),[uploading,setUploading]=useState(false);
  useEffect(()=>{loadDetail()},[product]);
  const loadDetail=async()=>{setLoading(true);try{const client=getBrowserClient();const{data:p}=await client.from('products').select('*,categories(name),brands(name)').eq('id',product.product_id).single();const{data:u}=await client.from('inventory_units').select('id,qr_code,serial_number,status,location_id,variant_id,locations(name,type,branch_id)').eq('product_id',product.product_id).order('created_at',{ascending:false}).limit(500);const{data:m}=await client.from('product_media').select('*').eq('product_id',product.product_id).order('is_primary',{ascending:false}).order('sort_order');const{data:v}=await client.from('product_variants').select('id,color_name,color_hex,cost_price,cost_price_usd,retail_price,retail_price_usd').eq('product_id',product.product_id);setDetail(p);setUnits((u||[]).filter(x=>x.locations?.branch_id===branchId));setMedia(m||[]);setVariants(v||[]);setDesc(p?.description||'');setVideoUrl(p?.video_url||'')}catch(e){}finally{setLoading(false)}};
  const colorById=Object.fromEntries(variants.map(v=>[v.id,v.color_name]));
  const locations=[...new Set(units.map(u=>u.locations?.name).filter(Boolean))];
  const queryLower=unitQuery.trim().toLowerCase();
  const filteredUnits=units.filter(u=>{
    if(filterLocation&&u.locations?.name!==filterLocation)return false;
    if(filterStatus&&u.status!==filterStatus)return false;
    if(filterColor&&colorById[u.variant_id]!==filterColor)return false;
    if(queryLower&&![u.qr_code,u.serial_number,u.locations?.name].some(v=>String(v||'').toLowerCase().includes(queryLower)))return false;
    return true;
  });
  const locationSummary=locations.map(n=>({name:n,count:units.filter(u=>u.locations?.name===n).length,type:units.find(u=>u.locations?.name===n)?.locations?.type}));
  const statusCounts=units.reduce((acc,u)=>{acc[u.status]=(acc[u.status]||0)+1;return acc},{});
  const colorCounts=variants.map(v=>({...v,count:units.filter(u=>u.variant_id===v.id).length})).filter(v=>v.count>0);
  const statusLabels={available:'Sotuvga tayyor',reserved:'Band',sold:'Sotilgan',in_transit:"Yo'lda",returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:"Ta'mirda"};
  const downloadQR=async(unit)=>{
    const QRCode=await import('qrcode');
    const matchedVar = variants.find(v => v.id === unit.variant_id);
    const costNumStr = formatSecretCostCode({
      cost: matchedVar?.cost_price || detail?.cost_price || unit.unit_cost || '',
      costUsd: matchedVar?.cost_price_usd || unit.unit_cost_usd || detail?.cost_price_usd || '',
      currency: detail?.currency || 'USD'
    });
    const costParam = costNumStr ? '?c=' + encodeURIComponent(costNumStr) : '';
    const url=(import.meta.env.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app')+'/qr/'+encodeURIComponent(unit.qr_code)+costParam;
    const qrCanvas=await QRCode.toCanvas(url,{width:220,margin:2,errorCorrectionLevel:'L'});
    const W=300,H=420;
    const labeled=document.createElement('canvas');labeled.width=W;labeled.height=H;
    const ctx=labeled.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#ddd';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(8,8,W-16,H-16);
    ctx.drawImage(qrCanvas,(W-220)/2,30);
    const varRetailUzs = matchedVar?.retail_price ?? detail?.retail_price;
    const varRetailUsd = matchedVar?.retail_price_usd ?? detail?.retail_price_usd;
    const price=varRetailUzs?formatDualMoney(Number(varRetailUzs),rate,varRetailUsd):formatMoney(0);
    ctx.fillStyle='#000';ctx.font='bold 15px sans-serif';ctx.textAlign='center';
    const name=detail?.name||'';
    const colorName=colorById[unit.variant_id]||'';
    let y=290;
    if(name.length>28){ctx.fillText(name.slice(0,28),W/2,280);ctx.fillText(name.slice(28,56),W/2,298);y=298}else{ctx.fillText(name,W/2,290)};
    if(colorName){y+=18;ctx.font='bold 12px sans-serif';ctx.fillStyle='#a86b00';ctx.fillText('Rang: '+colorName,W/2,y);ctx.fillStyle='#000'};
    ctx.font='bold 22px sans-serif';ctx.fillText(price,W/2,y+32);
    ctx.font='11px sans-serif';ctx.fillStyle='#666';
    ctx.fillText(unit.qr_code||'',W/2,y+62);
    if(costNumStr){
      ctx.font='bold 13px monospace';
      ctx.fillStyle='#333';
      ctx.fillText(costNumStr,W/2,y+78);
      ctx.font='11px sans-serif';ctx.fillStyle='#666';
      ctx.fillText(unit.serial_number||'',W/2,y+94);
    } else {
      ctx.fillText(unit.serial_number||'',W/2,y+80);
    }
    const link=document.createElement('a');link.download=(unit.qr_code||'qr')+'.png';link.href=labeled.toDataURL();link.click();
  };
  const saveDesc=async()=>{try{const{updateProductTextFields}=await import('@texnobazar/data');await updateProductTextFields(product.product_id,{description:desc});setEditDesc(false);if(toast)toast('Tavsif saqlandi')}catch(e){alert(e.message)}};
  const saveVideo=async()=>{try{const{updateProductTextFields}=await import('@texnobazar/data');await updateProductTextFields(product.product_id,{videoUrl});if(toast)toast('Video URL saqlandi')}catch(e){alert(e.message)}};
  const onMakePrimary=async(mediaId)=>{try{const{setPrimaryProductMedia}=await import('@texnobazar/data');await setPrimaryProductMedia(product.product_id,mediaId);await loadDetail();if(toast)toast('Asosiy rasm belgilandi')}catch(e){alert(e.message)}};
  const onDeleteMedia=async(mediaId)=>{if(!confirm('Bu rasmni o‘chirasizmi?'))return;try{const{deleteProductMedia}=await import('@texnobazar/data');await deleteProductMedia(mediaId);await loadDetail();if(toast)toast('Rasm o‘chirildi')}catch(e){alert(e.message)}};
  const uploadImage=async(e)=>{const files=[...e.target.files];if(!files.length)return;setUploading(true);try{const{uploadProductMedia}=await import('@texnobazar/data');for(const file of files)await uploadProductMedia(product.product_id,file,detail?.name||'');await loadDetail();if(toast)toast('Rasm yuklandi')}catch(er){alert(er.message)}finally{setUploading(false);e.target.value=''}};
  if(loading)return <Modal open onClose={close} title="Yuklanmoqda..."><div className="ops-state">Yuklanmoqda…</div></Modal>;if(!detail)return null;
  return <Modal open onClose={close} wide title={detail.name+' ('+units.length+' dona filialda)'}><div style={{display:'flex',flexDirection:'column',gap:14}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap'}}><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(130px, 1fr))',gap:8,flex:1}}><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>SKU</small><b>{detail.sku}</b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Kategoriya</small><b>{detail.categories?.name||'-'}</b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Brend</small><b>{detail.brands?.name||'-'}</b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Sotish narxi</small><b><DualPrice value={Number(detail.retail_price)} usdValue={detail.retail_price_usd != null ? Number(detail.retail_price_usd) : undefined} rate={rate}/></b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Tannarx</small><b><DualPrice value={Number(detail.cost_price)} usdValue={detail.cost_price_usd != null ? Number(detail.cost_price_usd) : undefined} rate={rate}/></b></span><span style={{background:'#f8fafc',padding:10,borderRadius:9}}><small style={{display:'block',color:'var(--muted)'}}>Filialda jami</small><b>{units.length} dona</b></span></div><button type="button" className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6,height:38}} onClick={()=>{close();onEdit?.(product);}}><Pencil size={14}/> Tovarni to‘liq tahrirlash</button></div>
  <h4 style={{margin:0}}>Joylashuv bo’yicha</h4>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
  <button className={filterLocation===''?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterLocation('')}>Barcha joy <b>{units.length}</b></button>
  {locationSummary.map(l=><button key={l.name} className={filterLocation===l.name?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterLocation(filterLocation===l.name?'':l.name)}>{l.type==='warehouse'?'Omborda':'Do\'konda'} <b>{l.count}</b></button>)}
  </div>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:4}}>
  <button className={filterStatus===''?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterStatus('')}>Barcha status <b>{units.length}</b></button>
  {Object.entries(statusCounts).map(([status,count])=><button key={status} className={filterStatus===status?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterStatus(filterStatus===status?'':status)}>{statusLabels[status]||status} <b>{count}</b></button>)}
  </div>
  {colorCounts.length>0&&<><h4 style={{margin:0}}>Rang bo’yicha</h4><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
  <button className={filterColor===''?'btn btn-primary':'btn'} style={{fontSize:11}} onClick={()=>setFilterColor('')}>Barcha rang <b>{units.length}</b></button>
  {colorCounts.map(c=><button key={c.id} className={filterColor===c.color_name?'btn btn-primary':'btn'} style={{fontSize:11,display:'inline-flex',alignItems:'center',gap:5}} onClick={()=>setFilterColor(filterColor===c.color_name?'':c.color_name)}><span style={{width:11,height:11,borderRadius:'50%',background:c.color_hex||'#ccc',border:'1px solid rgba(0,0,0,.15)',display:'inline-block'}}/>{c.color_name} <b>{c.count}</b></button>)}
  </div></>}
  <div style={{position:'relative',marginTop:6}}><Search size={15} style={{position:'absolute',left:10,top:10,color:'var(--muted)'}}/><input className="input" style={{paddingLeft:32}} value={unitQuery} onChange={e=>setUnitQuery(e.target.value)} placeholder="QR kod, seriya yoki joy bo’yicha qidirish"/></div>
  <h4 style={{margin:0}}>Birliklar ({filteredUnits.length}) — QR yuklab olish</h4><div style={{maxHeight:260,overflow:'auto'}}><table className="table"><thead><tr><th>QR kod</th><th>Seriya</th>{colorCounts.length>0&&<th>Rang</th>}<th>Joy</th><th>Status</th><th>QR</th></tr></thead><tbody>{filteredUnits.map(u=><tr key={u.id}><td><code style={{fontSize:10}}>{u.qr_code}</code></td><td>{u.serial_number||'—'}</td>{colorCounts.length>0&&<td>{colorById[u.variant_id]||'—'}</td>}<td>{u.locations?.name}</td><td><Status type={u.status==='available'?'green':u.status==='sold'?'blue':'orange'}>{u.status}</Status></td><td><button className="btn" style={{padding:'4px 8px'}} onClick={()=>downloadQR(u)}><Download size={13}/></button></td></tr>)}</tbody></table></div>
  {media.length>0&&<><h4 style={{margin:0}}>Rasmlar ({media.length})</h4><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{media.map(m=><div key={m.id} style={{width:68,height:68,borderRadius:8,overflow:'hidden',position:'relative',border:m.is_primary?'2.5px solid var(--orange,#ea580c)':'1px solid var(--line)',boxShadow:m.is_primary?'0 0 0 2px rgba(234, 88, 12, 0.25)':'none'}}><img src={m.public_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} onError={e=>{e.target.style.display='none'}}/>{m.is_primary?<span style={{position:'absolute',bottom:2,left:2,right:2,background:'var(--orange,#ea580c)',color:'#fff',fontSize:8,padding:'1px 3px',borderRadius:3,fontWeight:700,textAlign:'center',display:'block'}}>✓ Asosiy</span>:<button type="button" title="Asosiy qilish" style={{position:'absolute',bottom:2,left:2,right:2,background:'rgba(0,0,0,.75)',color:'#fdba74',fontSize:8,border:0,borderRadius:3,padding:'1px 3px',cursor:'pointer',fontWeight:600,textAlign:'center'}} onClick={()=>onMakePrimary(m.id)}>★ Asosiy</button>}<button type="button" title="O‘chirish" style={{position:'absolute',top:2,right:2,width:16,height:16,border:0,borderRadius:3,background:'rgba(0,0,0,.65)',color:'#fff',fontSize:9,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>onDeleteMedia(m.id)}>✕</button></div>)}</div></>}
  <label className="btn btn-outline" style={{alignSelf:'flex-start',fontSize:12}}><Upload size={14}/> {uploading?'Yuklanmoqda…':'Rasm yuklash'}<input type="file" accept="image/*" multiple hidden onChange={uploadImage} disabled={uploading}/></label>
  <h4 style={{margin:0}}>Video (YouTube)</h4><div style={{display:'flex',gap:8}}><input className="input" value={videoUrl} onChange={e=>setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."/><button className="btn btn-primary" style={{whiteSpace:'nowrap'}} onClick={saveVideo}>Saqlash</button></div>
  <h4 style={{margin:0}}>Tavsif</h4>{editDesc?<><RichTextEditor value={desc} onChange={v=>setDesc(v)}/><div style={{display:'flex',gap:8}}><button className="btn btn-primary" onClick={saveDesc}>Saqlash</button><button className="btn" onClick={()=>setEditDesc(false)}>Bekor</button></div></>:<><div style={{color:'var(--muted)',margin:0}} dangerouslySetInnerHTML={{__html:desc||'Tavsif kiritilmagan'}}/><button className="btn" style={{alignSelf:'flex-start',fontSize:12}} onClick={()=>setEditDesc(true)}>Tahrirlash</button></>}
  </div></Modal>;
}

function ErrorState({message,retry}){return <div className="inventory-error"><AlertTriangle/><b>Xatolik</b><p>{message}</p><div style={{display:'flex',gap:8,justifyContent:'center',marginTop:8}}><button className="btn btn-primary" onClick={retry}>Qayta urinish (Ro‘yxatni ko‘rish)</button></div></div>}

function BatchBackupRestoreModal({ open, onClose, branchId, onRestored, toast }) {
  const [file, setFile] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspected, setInspected] = useState(null);
  const [inspectError, setInspectError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState(null);
  const [restoreSuccess, setRestoreSuccess] = useState(null);

  const reset = () => {
    setFile(null);
    setInspecting(false);
    setInspected(null);
    setInspectError('');
    setRestoring(false);
    setProgress(null);
    setRestoreSuccess(null);
  };

  const handleClose = () => {
    if (restoring) return;
    reset();
    onClose();
  };

  const handleFileChange = async (selectedFile) => {
    if (!selectedFile) return;
    reset();
    setFile(selectedFile);
    setInspecting(true);
    try {
      const info = await inspectBatchesBackupFile(selectedFile);
      setInspected(info);
    } catch (e) {
      setInspectError(e.message || 'Faylni tahlil qilib bo‘lmadi');
    } finally {
      setInspecting(false);
    }
  };

  const handleStartRestore = async () => {
    if (!file || !inspected) return;
    setRestoring(true);
    setInspectError('');
    try {
      const res = await restoreBatchesBackupFile(file, {
        onProgress: setProgress,
      });
      setRestoreSuccess(res);
      toast?.(`${res.counts?.receipts || inspected.counts.receipts} ta partiya va inventarizatsiya muvaffaqiyatli tiklandi!`);
      setTimeout(() => {
        onRestored?.();
        handleClose();
      }, 1500);
    } catch (e) {
      setInspectError(e.message || 'Tiklashda xatolik yuz berdi');
      setRestoring(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Partiyalar va Inventarizatsiyani tiklash">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted, #64748b)', lineHeight: 1.5 }}>
          Ushbu bo‘lim orqali avval eksport qilingan <b>.json</b> yoki <b>.zip</b> formatidagi zahira fayllaridan o‘chirilgan yoki saqlangan partiyalar, ularning qabul sanalari, narxlari va tovar birliklarini to‘liq qayta tiklashingiz mumkin.
        </p>

        {!inspected && !restoring && !restoreSuccess && (
          <div
            style={{
              border: '2px dashed #cbd5e1',
              borderRadius: 12,
              padding: '28px 16px',
              textAlign: 'center',
              background: '#f8fafc',
              cursor: 'pointer',
              transition: 'border-color 0.2s',
            }}
            onClick={() => document.getElementById('batch-restore-file-input')?.click()}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={e => {
              e.preventDefault();
              e.stopPropagation();
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) handleFileChange(dropped);
            }}
          >
            <input
              id="batch-restore-file-input"
              type="file"
              accept=".json,.zip"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleFileChange(f);
              }}
            />
            <div style={{ display: 'inline-flex', padding: 12, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', marginBottom: 10 }}>
              <UploadCloud size={30} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 4 }}>
              Zahira faylini tanlang yoki shu yerga tashlang
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Qo‘llab-quvvatlanadi: <b>.json</b> (partiyalar zahirasi) va <b>.zip</b> (tizim arxivi)
            </div>
          </div>
        )}

        {inspecting && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted, #64748b)' }}>
            <Loader2 size={24} className="spin" style={{ marginBottom: 8, display: 'inline-block' }} />
            <div>Zahira fayli tahlil qilinmoqda…</div>
          </div>
        )}

        {inspectError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 14px', color: '#dc2626', fontSize: 13, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <b>Xatolik:</b> {inspectError}
            </div>
          </div>
        )}

        {inspected && !restoring && !restoreSuccess && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <b style={{ fontSize: 14, color: '#0f172a' }}>{inspected.fileName}</b>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    Formati: <span style={{ textTransform: 'uppercase', fontWeight: 600 }}>{inspected.fileType}</span>
                    {inspected.exported_at && ` · Eksport sanasi: ${new Date(inspected.exported_at).toLocaleString('uz-UZ')}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={reset}
                >
                  Boshqa fayl
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 12 }}>
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Partiyalar</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{inspected.counts.receipts} ta</div>
                </div>
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Tovar turlari</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{inspected.counts.products || inspected.counts.batches} xil</div>
                </div>
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Birliklar (soni)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{inspected.counts.units} dona</div>
                </div>
              </div>

              {inspected.receiptsList?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                    Fayldagi partiya va inventarizatsiyalar ({inspected.receiptsList.length} ta):
                  </div>
                  <div style={{ maxHeight: 150, overflowY: 'auto', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}>
                    {inspected.receiptsList.slice(0, 20).map((r, idx) => (
                      <div
                        key={r.id || idx}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          borderBottom: idx < inspected.receiptsList.length - 1 ? '1px solid #f1f5f9' : 'none',
                        }}
                      >
                        <b style={{ color: '#1e293b' }}>{r.receipt_no}</b>
                        <span style={{ color: '#64748b' }}>
                          {r.received_at ? new Date(r.received_at).toLocaleDateString('uz-UZ') : '—'}
                        </span>
                      </div>
                    ))}
                    {inspected.receiptsList.length > 20 && (
                      <div style={{ padding: '6px 10px', textAlign: 'center', color: '#64748b', fontSize: 11 }}>
                        ... va yana {inspected.receiptsList.length - 20} ta
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#1e40af', lineHeight: 1.5 }}>
              <b>Eslatma:</b> Tiklash jarayonida fayldagi barcha partiyalar, narxlar va birliklar bazaga kiritiladi. Mavjud yozuvlar yangilanadi, o‘chirilganlari esa qayta tiklanadi.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn btn-outline" onClick={handleClose}>
                Bekor qilish
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: '#2563eb', borderColor: '#2563eb' }}
                onClick={handleStartRestore}
              >
                <Upload size={15} style={{ marginRight: 6 }} />
                Tiklashni boshlash
              </button>
            </div>
          </div>
        )}

        {restoring && (
          <div style={{ padding: '24px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Loader2 size={32} className="spin" color="#2563eb" />
            <div>
              <b style={{ fontSize: 15, color: '#0f172a' }}>Ma’lumotlar tiklanmoqda…</b>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                {progress?.message || 'Partiyalar va tovarlar bazaga yozilmoqda…'}
              </div>
            </div>
            <div style={{ width: '100%', height: 6, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden', marginTop: 8 }}>
              <div
                style={{
                  height: '100%',
                  background: '#2563eb',
                  width: `${progress?.percent || 50}%`,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        )}

        {restoreSuccess && (
          <div style={{ padding: '24px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#dcfce7', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <CheckCircle2 size={28} />
            </div>
            <b style={{ fontSize: 16, color: '#15803d' }}>Zahiradan tiklash muvaffaqiyatli yakunlandi!</b>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              Barcha partiyalar, kirimlar va tovar qoldiqlari to‘liq o‘z holatiga keltirildi.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReceiptDetail({receipt,locations:propLocations=[],toast,close,onUpdated,initialEditing=false,onExportSingle}){
  const[rate,setRate2]=useState(null);
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate2(Number(r)||null)).catch(()=>{})},[]);
  const[locations,setLocations]=useState(propLocations||[]);
  useEffect(()=>{
    if(propLocations?.length){
      setLocations(propLocations);
    }else if(receipt?.branch_id){
      getInventoryReferences(receipt.branch_id).then(r=>setLocations(r.locations||[])).catch(()=>{});
    }
  },[receipt?.branch_id,propLocations]);
  const[labels,setLabels]=useState([]),[printPending,setPrintPending]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(Boolean(initialEditing)),[editForm,setEditForm]=useState({}),[saving,setSaving]=useState(false),[deleting,setDeleting]=useState(false),[expandedLine,setExpandedLine]=useState(null),[lineUnits,setLineUnits]=useState([]),[lineProduct,setLineProduct]=useState(null),[loadingLine,setLoadingLine]=useState(false),[editingLine,setEditingLine]=useState(false),[linePrices,setLinePrices]=useState({}),[savingLine,setSavingLine]=useState(false);
  const[bluetoothModalOpen,setBluetoothModalOpen]=useState(false);
  const[singlePrintLabel,setSinglePrintLabel]=useState(null);
  const[deletedBatchIds,setDeletedBatchIds]=useState([]);

  useEffect(()=>{
    setLabels([]);setPrintPending(false);document.body.classList.remove('printing-qr-labels');setError('');setEditing(Boolean(initialEditing));setDeletedBatchIds([]);
    if(receipt){
      const isReceiptUsd = (receipt.currency || 'USD') === 'USD';
      setEditForm({
        invoice_number:receipt.invoice_number||'',
        payment_status:receipt.payment_status||'unpaid',
        received_at:receipt.received_at?receipt.received_at.split('T')[0]:'',
        notes:receipt.notes||'',
        receiving_location_id:receipt.receiving_location_id||'',
        currency:receipt.currency||'USD',
        lines:(receipt.lines||[]).map(l=>{
          const rawUc = l.unit_cost !== undefined && l.unit_cost !== null && l.unit_cost !== '' ? Number(l.unit_cost) : null;
          const rawUcUsd = l.unit_cost_usd !== undefined && l.unit_cost_usd !== null && l.unit_cost_usd !== '' ? Number(l.unit_cost_usd) : null;
          const ucUsd = rawUcUsd != null ? rawUcUsd : (isReceiptUsd ? rawUc : (rate && rawUc ? Number((rawUc / rate).toFixed(2)) : null));
          const ucUzs = !isReceiptUsd && rawUc != null ? rawUc : (ucUsd != null && rate ? Math.round(ucUsd * rate) : rawUc);

          const rawRp = l.retail_price !== undefined && l.retail_price !== null && l.retail_price !== '' ? Number(l.retail_price) : null;
          const rawRpUsd = l.retail_price_usd !== undefined && l.retail_price_usd !== null && l.retail_price_usd !== '' ? Number(l.retail_price_usd) : null;
          const rpUsd = rawRpUsd != null ? rawRpUsd : (isReceiptUsd ? rawRp : (rate && rawRp ? Number((rawRp / rate).toFixed(2)) : null));
          const rpUzs = !isReceiptUsd && rawRp != null ? rawRp : (rpUsd != null && rate ? Math.round(rpUsd * rate) : rawRp);

          const rawWp = l.wholesale_price !== undefined && l.wholesale_price !== null && l.wholesale_price !== '' ? Number(l.wholesale_price) : null;
          const rawWpUsd = l.wholesale_price_usd !== undefined && l.wholesale_price_usd !== null && l.wholesale_price_usd !== '' ? Number(l.wholesale_price_usd) : null;
          const wpUsd = rawWpUsd != null ? rawWpUsd : (isReceiptUsd ? rawWp : (rate && rawWp ? Number((rawWp / rate).toFixed(2)) : null));
          const wpUzs = !isReceiptUsd && rawWp != null ? rawWp : (wpUsd != null && rate ? Math.round(wpUsd * rate) : rawWp);

          const rawMp = l.minimum_sale_price !== undefined && l.minimum_sale_price !== null && l.minimum_sale_price !== '' ? Number(l.minimum_sale_price) : null;
          const rawMpUsd = l.minimum_sale_price_usd !== undefined && l.minimum_sale_price_usd !== null && l.minimum_sale_price_usd !== '' ? Number(l.minimum_sale_price_usd) : null;
          const mpUsd = rawMpUsd != null ? rawMpUsd : (isReceiptUsd ? rawMp : (rate && rawMp ? Number((rawMp / rate).toFixed(2)) : null));
          const mpUzs = !isReceiptUsd && rawMp != null ? rawMp : (mpUsd != null && rate ? Math.round(mpUsd * rate) : rawMp);

          return {
            id:l.id,
            batch_id:l.id,
            line_no:l.line_no,
            product_id:l.product_id,
            product_name:l.product_name,
            sku:l.sku,
            quantity:Number(l.quantity)||1,
            unit_cost: isReceiptUsd ? (ucUsd != null ? String(ucUsd) : '') : (ucUzs != null ? String(ucUzs) : ''),
            unit_cost_usd: ucUsd != null ? String(ucUsd) : '',
            unit_cost_uzs: ucUzs != null ? String(ucUzs) : '',
            retail_price: isReceiptUsd ? (rpUsd != null ? String(rpUsd) : '') : (rpUzs != null ? String(rpUzs) : ''),
            retail_price_usd: rpUsd != null ? String(rpUsd) : '',
            retail_price_uzs: rpUzs != null ? String(rpUzs) : '',
            wholesale_price: isReceiptUsd ? (wpUsd != null ? String(wpUsd) : '') : (wpUzs != null ? String(wpUzs) : ''),
            wholesale_price_usd: wpUsd != null ? String(wpUsd) : '',
            wholesale_price_uzs: wpUzs != null ? String(wpUzs) : '',
            minimum_sale_price: isReceiptUsd ? (mpUsd != null ? String(mpUsd) : '') : (mpUzs != null ? String(mpUzs) : ''),
            minimum_sale_price_usd: mpUsd != null ? String(mpUsd) : '',
            minimum_sale_price_uzs: mpUzs != null ? String(mpUzs) : '',
            variant_color:l.variant_color||'',
            qr_count:l.qr_count,
            components:[],
            _hadComponents:false
          };
        })
      });

      const productIds = [...new Set((receipt.lines || []).map(l => l.product_id).filter(Boolean))];
      if (productIds.length > 0) {
        getBrowserClient()
          .from('product_components')
          .select('*')
          .in('product_id', productIds)
          .eq('is_active', true)
          .order('sort_order')
          .then(({ data: comps, error: compErr }) => {
            if (compErr) {
              console.warn('Receipt components fetch error:', compErr);
              return;
            }
            if (comps && comps.length > 0) {
              const compsByProd = {};
              comps.forEach(c => {
                if (!compsByProd[c.product_id]) compsByProd[c.product_id] = [];
                compsByProd[c.product_id].push({
                  ...c,
                  quantity: c.quantity || 1,
                  cost_price: c.cost_price != null ? String(c.cost_price) : '',
                  cost_price_uzs: c.cost_price != null ? String(c.cost_price) : '',
                  cost_price_usd: c.cost_price_usd != null ? String(c.cost_price_usd) : '',
                  retail_price: c.retail_price != null ? String(c.retail_price) : '',
                  retail_price_uzs: c.retail_price != null ? String(c.retail_price) : '',
                  retail_price_usd: c.retail_price_usd != null ? String(c.retail_price_usd) : '',
                  wholesale_price: c.wholesale_price != null ? String(c.wholesale_price) : '',
                  wholesale_price_uzs: c.wholesale_price != null ? String(c.wholesale_price) : '',
                  wholesale_price_usd: c.wholesale_price_usd != null ? String(c.wholesale_price_usd) : '',
                  image_url: c.image_url || null,
                  imageFile: null,
                  previewUrl: c.image_url || null
                });
              });
              setEditForm(prev => {
                if (!prev.lines) return prev;
                return {
                  ...prev,
                  lines: prev.lines.map(l => {
                    const prodComps = compsByProd[l.product_id];
                    if (prodComps && prodComps.length > 0) {
                      return {
                        ...l,
                        components: prodComps.map(c => ({ ...c })),
                        _hadComponents: true
                      };
                    }
                    return l;
                  })
                };
              });
            }
          })
          .catch(err => console.warn('Components query failed:', err));
      }
    }
  },[receipt?.id,initialEditing]);

  const loadLabelsData=async()=>{
    setLoading(true);setError('');
    try{
      const items=[];let page=1,total=1;
      while(items.length<total){
        const result=await listReceiptQrLabels(receipt.id,page,200);
        items.push(...(result.items||[]));
        total=Number(result.total||0);
        page+=1;
        if(!result.items?.length)break;
      }

      // Har bir partiya qatori / tovar va rangi uchun aynan 1 ta umumiy QR kodni kafolatlaymiz
      const groupQrMap = new Map();
      items.forEach(item => {
        const matchedLine = (receipt?.lines || []).find(l => 
          (item.line_no && l.line_no === item.line_no) ||
          (item.product_id && l.product_id === item.product_id && (l.variant_id || null) === (item.variant_id || null)) ||
          (l.product_name === item.product_name && (l.variant_color || null) === (item.variant_color || null))
        );
        const color = String(item.variant_color || item.price_label?.color || matchedLine?.variant_color || '').trim().toLowerCase();
        const lineKey = item.line_no || matchedLine?.line_no || matchedLine?.id || '0';
        const key = `${lineKey}___${item.product_name || matchedLine?.product_name || ''}___${color}`;
        if (!groupQrMap.has(key) && item.qr_code) {
          groupQrMap.set(key, item.qr_code);
        }
      });

      // Har bir partiya qatori (tovar turi va rangi) uchun 1 ta umumiy yorliq (quantity = line.quantity)
      let distinctLabels = [];
      if (receipt?.lines?.length) {
        distinctLabels = receipt.lines.map(line => {
          const color = String(line.variant_color || '').trim().toLowerCase();
          const lineKey = line.line_no || line.id || '0';
          const key = `${lineKey}___${line.product_name || ''}___${color}`;
          const matchingItem = items.find(it => 
            (it.line_no && it.line_no === line.line_no) ||
            (it.product_id && it.product_id === line.product_id && (it.variant_id || null) === (line.variant_id || null)) ||
            (it.product_name === line.product_name && (it.variant_color || null) === (line.variant_color || null))
          );
          const canonicalQr = groupQrMap.get(key) || matchingItem?.qr_code || line.qr_code || '';
          const lineCostUsd = line.unit_cost_usd || matchingItem?.unit_cost_usd || matchingItem?.cost_usd || matchingItem?.price_label?.cost_usd || matchingItem?.cost_price_usd || '';
          const lineCost = line.unit_cost || matchingItem?.unit_cost || '';
          const lineCurrency = receipt?.currency || matchingItem?.currency || 'USD';
          const secretCost = formatSecretCostCode({
            cost: lineCost,
            costUsd: lineCostUsd,
            currency: lineCurrency
          });
          return {
            id: line.id,
            line_no: line.line_no,
            product_id: line.product_id,
            product_name: line.product_name,
            title: line.product_name || matchingItem?.price_label?.title || 'Mahsulot',
            variant_color: line.variant_color || matchingItem?.variant_color || matchingItem?.price_label?.color || '',
            color: line.variant_color || matchingItem?.variant_color || matchingItem?.price_label?.color || '',
            quantity: Number(line.quantity) || 1,
            code: canonicalQr,
            qr_code: canonicalQr,
            cost_usd: secretCost || lineCostUsd,
            costUsd: secretCost || lineCostUsd,
            cost: lineCost,
            currency: lineCurrency,
            secret_cost: secretCost,
            date: receipt?.received_at ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ'),
          };
        });
      } else {
        const seenKeys = new Set();
        items.forEach(item => {
          const color = String(item.variant_color || item.price_label?.color || '').trim().toLowerCase();
          const lineKey = item.line_no || '0';
          const key = `${lineKey}___${item.product_name || ''}___${color}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const canonicalQr = groupQrMap.get(key) || item.qr_code;
            const sameGroupItems = items.filter(it => {
              const c = String(it.variant_color || it.price_label?.color || '').trim().toLowerCase();
              const lk = it.line_no || '0';
              return `${lk}___${it.product_name || ''}___${c}` === key;
            });
            const itemCostUsd = item.unit_cost_usd || item.cost_usd || item.price_label?.cost_usd || item.cost_price_usd || '';
            const itemCost = item.unit_cost || item.cost || '';
            const itemCurrency = item.currency || receipt?.currency || 'USD';
            const secretCost = formatSecretCostCode({
              cost: itemCost,
              costUsd: itemCostUsd,
              currency: itemCurrency
            });
            distinctLabels.push({
              id: item.id,
              line_no: item.line_no,
              product_id: item.product_id,
              product_name: item.product_name,
              title: item.price_label?.title || item.product_name,
              variant_color: item.variant_color || '',
              color: item.variant_color || '',
              quantity: sameGroupItems.length || 1,
              code: canonicalQr,
              qr_code: canonicalQr,
              cost_usd: secretCost || itemCostUsd,
              costUsd: secretCost || itemCostUsd,
              cost: itemCost,
              currency: itemCurrency,
              secret_cost: secretCost,
              date: receipt?.received_at ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ'),
            });
          }
        });
      }

      const generated = await Promise.all(distinctLabels.map(async item => {
        const costStr = item.secret_cost || formatSecretCostCode({
          cost: item.cost,
          costUsd: item.cost_usd,
          currency: item.currency || receipt?.currency || 'USD'
        });
        const costParam = costStr ? '?c=' + encodeURIComponent(costStr) : '';
        const url = (import.meta.env.VITE_STOREFRONT_URL || 'https://texnobazar-storefront.netlify.app') + '/qr/' + encodeURIComponent(item.qr_code) + costParam;
        return {
          ...item,
          cost_usd: costStr,
          costUsd: costStr,
          secret_cost: costStr,
          qrImage: await QRCode.toDataURL(url, { width: 480, margin: 2, errorCorrectionLevel: 'L' })
        };
      }));
      setLabels(generated);
      return generated;
    }catch(currentError){
      setError(err(currentError));
      return [];
    }finally{
      setLoading(false);
    }
  };

  const [preferredPrinter, setPreferredPrinter] = useState('detonger');

  const openBluetoothPrint=async(targetLabel=null, printerType=null)=>{
    if(printerType){
      setPreferredPrinter(printerType);
      try {
        localStorage.setItem('texnobazar_selected_thermal_printer', printerType);
      } catch {}
    }
    let currentLabels = labels;
    if(!currentLabels.length){
      currentLabels = await loadLabelsData();
    }
    setSinglePrintLabel(targetLabel);
    if(currentLabels.length || targetLabel){
      setBluetoothModalOpen(true);
    }
  };

  const handleClassicPrint=async()=>{
    if(!labels.length){
      await loadLabelsData();
    }
    setPrintPending(true);
  };

  const prepare = handleClassicPrint;

  useEffect(()=>{
    if(!printPending||!labels.length)return;
    let cancelled=false;
    const print=async()=>{
      const receiptDate = receipt?.received_at 
        ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') 
        : new Date().toLocaleDateString('uz-UZ');

      const escapeHtml = (str) => String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      const pagesHtml = labels.flatMap(x => {
        const count = Math.max(1, Number(x.quantity) || 1);
        const label = x.price_label || {};
        const matchedLine = (receipt?.lines || []).find(l => 
          (x.line_no && l.line_no === x.line_no) ||
          (x.product_id && l.product_id === x.product_id && (l.variant_id || null) === (x.variant_id || null)) ||
          (l.product_name === x.product_name && (l.variant_color || null) === (x.variant_color || null))
        );
        const prodTitle = label.title || x.product_name || matchedLine?.product_name || 'Mahsulot';
        const colorName = label.color || x.variant_color || matchedLine?.variant_color || '';
        const fullTitle = `${prodTitle}${colorName ? ` (${colorName})` : ''}`;
        const code = x.qr_code || label.qr || '';

        const singlePage = `
          <div class="qr-page">
            <div class="qr-img-wrap">
              <img class="qr-img" src="${x.qrImage}" alt="QR" />
            </div>
            <div class="qr-info">
              <div class="qr-title">${escapeHtml(fullTitle)}</div>
              <div class="qr-meta-clean">
                <span class="qr-meta-date-val">Sana: ${escapeHtml(receiptDate)}</span>
                <span class="qr-meta-code-val">${escapeHtml(code)}</span>
              </div>
            </div>
          </div>
        `;
        return Array(count).fill(singlePage);
      }).join('');

      try {
        const oldIframe = document.getElementById('qr-thermal-print-iframe');
        if (oldIframe) oldIframe.remove();

        const iframe = document.createElement('iframe');
        iframe.id = 'qr-thermal-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>QR Yorliqlar</title>
  <style>
    @page {
      size: 40mm 30mm;
      margin: 0 !important;
      padding: 0 !important;
    }
    @media print {
      html, body {
        width: 40mm !important;
        margin: 0 !important;
        padding: 0 !important;
        background: #fff !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      @page {
        size: 40mm 30mm;
        margin: 0 !important;
      }
    }
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 40mm;
      margin: 0;
      padding: 0;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 0;
      line-height: 0;
    }
    .qr-page {
      width: 40mm;
      height: 29.2mm;
      max-width: 40mm;
      max-height: 29.2mm;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      text-align: center;
      overflow: hidden;
      background: #fff;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
      margin: 0;
      padding: 0.5mm 1mm;
      position: relative;
    }
    .qr-page:last-child {
      page-break-after: avoid !important;
      break-after: avoid !important;
    }
    .qr-img-wrap {
      width: 100%;
      height: 18mm;
      max-height: 18mm;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0;
      flex: 0 0 18mm;
    }
    .qr-img {
      width: 18mm;
      height: 18mm;
      max-width: 18mm;
      max-height: 18mm;
      object-fit: contain;
      image-rendering: pixelated;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
      display: block;
      margin: 0 auto;
    }
    .qr-info {
      width: 100%;
      max-width: 38mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.2mm;
      margin: 0 auto;
      padding: 0;
    }
    .qr-title {
      font-size: 6.5pt;
      font-weight: 900;
      color: #000;
      line-height: 1.1;
      text-align: center;
      width: 100%;
      max-width: 38mm;
      max-height: 5mm;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      letter-spacing: -0.2px;
      margin: 0;
    }
    .qr-meta-clean {
      width: 100%;
      max-width: 38mm;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.4mm;
      padding: 0 0.5mm;
      box-sizing: border-box;
    }
    .qr-meta-date-val {
      font-size: 6.2pt;
      font-weight: 800;
      color: #000;
      line-height: 1;
    }
    .qr-meta-code-val {
      font-size: 9pt;
      font-weight: 900;
      font-family: 'Courier New', monospace;
      color: #000;
      letter-spacing: 0.4px;
      line-height: 1;
      border: 0.3mm solid #000;
      border-radius: 0.8mm;
      padding: 0.3mm 1mm;
    }
  </style>
</head>
<body>
  ${pagesHtml}
</body>
</html>`);
        doc.close();

        const images = [...doc.images];
        await Promise.all(images.map(image => image.decode ? image.decode().catch(() => {}) : Promise.resolve()));
        await new Promise(resolve => setTimeout(resolve, 250));
        if (cancelled) return;

        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setPrintPending(false);
        setTimeout(() => {
          iframe.remove();
        }, 3000);
      } catch (e) {
        document.body.classList.add('printing-qr-labels');
        const cleanup = () => { document.body.classList.remove('printing-qr-labels'); setPrintPending(false); };
        window.addEventListener('afterprint', cleanup, { once: true });
        window.print();
        setTimeout(cleanup, 1000);
      }
    };
    print();
    return()=>{cancelled=true};
  },[labels,printPending,receipt]);

  const expandLine=async(line)=>{
    if(expandedLine===line.id){setExpandedLine(null);return}
    setExpandedLine(line.id);setLoadingLine(true);
    try{
      const client=getBrowserClient();
      const batchIds=(receipt.lines||[]).filter(x=>x.product_name===line.product_name&&(x.variant_id||null)===(line.variant_id||null)).map(x=>x.id);
      const{data:units}=await client.from('inventory_units').select('id,qr_code,serial_number,status').in('batch_id',batchIds).order('unit_sequence');
      const prodId = line.product_id||units?.[0]?.product_id;
      const{data:prod}=await client.from('products').select('*').eq('id',prodId).single();
      const canonicalQr = units?.[0]?.qr_code || '';
      const normalizedUnits = (units||[]).map(u => ({
        ...u,
        qr_code: canonicalQr || u.qr_code
      }));
      let comps = [];
      if (prodId) {
        const { data: cData } = await client.from('product_components').select('*').eq('product_id', prodId).eq('is_active', true).order('sort_order');
        comps = cData || [];
      }
      setLineUnits(normalizedUnits);setLineProduct(prod?{...prod,variant_color:line.variant_color,components:comps}:prod);
    }catch(e){}finally{setLoadingLine(false)}
  };

  const startEditLine=(line,prod)=>{
    setEditingLine(true);
    const isUsd = (receipt?.currency || 'USD') === 'USD';
    setLinePrices({
      unit_cost: isUsd ? (line.unit_cost_usd != null && line.unit_cost_usd !== '' ? String(line.unit_cost_usd) : (rate && line.unit_cost ? String(Number((Number(line.unit_cost)/rate).toFixed(2))) : String(line.unit_cost||0))) : String(line.unit_cost || (line.unit_cost_usd && rate ? Math.round(Number(line.unit_cost_usd)*rate) : 0)),
      retail_price: isUsd ? (prod.retail_price_usd != null && prod.retail_price_usd !== '' ? String(prod.retail_price_usd) : (rate && prod.retail_price ? String(Number((Number(prod.retail_price)/rate).toFixed(2))) : String(prod.retail_price||0))) : String(prod.retail_price || (prod.retail_price_usd && rate ? Math.round(Number(prod.retail_price_usd)*rate) : 0)),
      wholesale_price: isUsd ? (prod.wholesale_price_usd != null && prod.wholesale_price_usd !== '' ? String(prod.wholesale_price_usd) : (rate && prod.wholesale_price ? String(Number((Number(prod.wholesale_price)/rate).toFixed(2))) : '')) : String(prod.wholesale_price || (prod.wholesale_price_usd && rate ? Math.round(Number(prod.wholesale_price_usd)*rate) : '')),
      minimum_sale_price: isUsd ? (prod.minimum_sale_price_usd != null && prod.minimum_sale_price_usd !== '' ? String(prod.minimum_sale_price_usd) : (rate && prod.minimum_sale_price ? String(Number((Number(prod.minimum_sale_price)/rate).toFixed(2))) : '0')) : String(prod.minimum_sale_price || (prod.minimum_sale_price_usd && rate ? Math.round(Number(prod.minimum_sale_price_usd)*rate) : 0))
    });
  };

  const saveLinePrices2=async(batchId,productId)=>{
    setSavingLine(true);setError('');
    try{
      const client=getBrowserClient();
      const isUsd = (receipt?.currency || 'USD') === 'USD';
      const ucNum = Number(linePrices.unit_cost||0);
      const rpNum = Number(linePrices.retail_price||0);
      const wpNum = Number(linePrices.wholesale_price||0);
      const mpNum = Number(linePrices.minimum_sale_price||0);

      const uc = isUsd && rate ? Math.round(ucNum * rate) : ucNum;
      const rp = isUsd && rate ? Math.round(rpNum * rate) : rpNum;
      const wp = isUsd && rate ? Math.round(wpNum * rate) : wpNum;
      const mp = isUsd && rate ? Math.round(mpNum * rate) : mpNum;

      const ucUsd = isUsd ? ucNum : (rate && uc ? Number((uc / rate).toFixed(2)) : null);
      const rpUsd = isUsd ? rpNum : (rate && rp ? Number((rp / rate).toFixed(2)) : null);
      const wpUsd = isUsd ? wpNum : (rate && wp ? Number((wp / rate).toFixed(2)) : null);
      const mpUsd = isUsd ? mpNum : (rate && mp ? Number((mp / rate).toFixed(2)) : null);

      const{error:e}=await client.rpc('update_batch_prices',{
        p_batch_id:batchId,
        p_unit_cost:uc,
        p_retail_price:rp,
        p_wholesale_price:wp||null,
        p_minimum_sale_price:mp,
        p_unit_cost_usd:ucUsd,
        p_retail_price_usd:rpUsd,
        p_wholesale_price_usd:wpUsd||null,
        p_minimum_sale_price_usd:mpUsd
      });
      if(e)throw e;
      setLineProduct(prev=>({...prev,retail_price:rp,wholesale_price:wp,minimum_sale_price:mp,cost_price:uc,cost_price_usd:ucUsd,retail_price_usd:rpUsd,wholesale_price_usd:wpUsd,minimum_sale_price_usd:mpUsd}));
      setEditingLine(false);
      onUpdated?.();
    }catch(e){setError(err(e))}finally{setSavingLine(false)}
  };

  const downloadLineQR=async(unit)=>{
    const QRCode=await import('qrcode');
    const costNumStr = formatSecretCostCode({
      cost: unit.unit_cost || lineProduct?.cost_price || '',
      costUsd: unit.unit_cost_usd || lineProduct?.unit_cost_usd || lineProduct?.cost_price_usd || '',
      currency: receipt?.currency || 'USD'
    });
    const costParam = costNumStr ? '?c=' + encodeURIComponent(costNumStr) : '';
    const canvas=await QRCode.toCanvas((import.meta.env.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app')+'/qr/'+encodeURIComponent(unit.qr_code)+costParam,{width:300,margin:2,errorCorrectionLevel:'L'});
    const labeled=document.createElement('canvas');labeled.width=300;labeled.height=370;
    const ctx=labeled.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,300,370);ctx.drawImage(canvas,0,0);
    ctx.fillStyle='#000';ctx.font='bold 14px monospace';ctx.textAlign='center';
    ctx.fillText(unit.qr_code||'',150,318);
    if(costNumStr){
      ctx.font='bold 13px monospace';
      ctx.fillStyle='#333';
      ctx.fillText(costNumStr,150,336);
    }
    ctx.font='10px sans-serif';ctx.fillStyle='#555';
    const label=lineProduct?.variant_color?`${lineProduct.name} (${lineProduct.variant_color})`:(lineProduct?.name||'');
    ctx.fillText(label,150,costNumStr?354:336);
    const link=document.createElement('a');link.download=(unit.qr_code||'qr')+'.png';link.href=labeled.toDataURL();link.click();
  };

  const handleCurrencyChange = (newCurrency) => {
    const prevCurrency = editForm.currency || 'USD';
    if (newCurrency === prevCurrency) return;

    setEditForm(prev => {
      const nextLines = (prev.lines || []).map(line => {
        const updated = { ...line };
        if (newCurrency === 'UZS') {
          // USD dan UZS ga o'tish: USD qiymatlarini saqlab, UZS ga ko'paytiramiz
          if (line.unit_cost !== '' && line.unit_cost != null) {
            const usdVal = Number(line.unit_cost_usd || line.unit_cost);
            updated.unit_cost_usd = String(usdVal);
            updated.unit_cost = rate ? String(Math.round(usdVal * rate)) : String(usdVal);
            updated.unit_cost_uzs = updated.unit_cost;
          }
          if (line.retail_price !== '' && line.retail_price != null) {
            const usdVal = Number(line.retail_price_usd || line.retail_price);
            updated.retail_price_usd = String(usdVal);
            updated.retail_price = rate ? String(Math.round(usdVal * rate)) : String(usdVal);
            updated.retail_price_uzs = updated.retail_price;
          }
          if (line.wholesale_price !== '' && line.wholesale_price != null) {
            const usdVal = Number(line.wholesale_price_usd || line.wholesale_price);
            updated.wholesale_price_usd = String(usdVal);
            updated.wholesale_price = rate ? String(Math.round(usdVal * rate)) : String(usdVal);
            updated.wholesale_price_uzs = updated.wholesale_price;
          }
          if (line.minimum_sale_price !== '' && line.minimum_sale_price != null) {
            const usdVal = Number(line.minimum_sale_price_usd || line.minimum_sale_price);
            updated.minimum_sale_price_usd = String(usdVal);
            updated.minimum_sale_price = rate ? String(Math.round(usdVal * rate)) : String(usdVal);
            updated.minimum_sale_price_uzs = updated.minimum_sale_price;
          }
        } else if (newCurrency === 'USD') {
          // UZS dan USD ga o'tish: avvalgi USD qiymatini tiklaymiz, yo'q bo'lsa rate ga bo'lamiz
          if (line.unit_cost !== '' && line.unit_cost != null) {
            updated.unit_cost_uzs = line.unit_cost;
            const restoredUsd = line.unit_cost_usd !== '' && line.unit_cost_usd != null && Number(line.unit_cost_usd) > 0
              ? String(line.unit_cost_usd)
              : (rate && Number(line.unit_cost) > 0 ? String(Number((Number(line.unit_cost) / rate).toFixed(2))) : line.unit_cost);
            updated.unit_cost = restoredUsd;
            updated.unit_cost_usd = restoredUsd;
          }
          if (line.retail_price !== '' && line.retail_price != null) {
            updated.retail_price_uzs = line.retail_price;
            const restoredUsd = line.retail_price_usd !== '' && line.retail_price_usd != null && Number(line.retail_price_usd) > 0
              ? String(line.retail_price_usd)
              : (rate && Number(line.retail_price) > 0 ? String(Number((Number(line.retail_price) / rate).toFixed(2))) : line.retail_price);
            updated.retail_price = restoredUsd;
            updated.retail_price_usd = restoredUsd;
          }
          if (line.wholesale_price !== '' && line.wholesale_price != null) {
            updated.wholesale_price_uzs = line.wholesale_price;
            const restoredUsd = line.wholesale_price_usd !== '' && line.wholesale_price_usd != null && Number(line.wholesale_price_usd) > 0
              ? String(line.wholesale_price_usd)
              : (rate && Number(line.wholesale_price) > 0 ? String(Number((Number(line.wholesale_price) / rate).toFixed(2))) : line.wholesale_price);
            updated.wholesale_price = restoredUsd;
            updated.wholesale_price_usd = restoredUsd;
          }
          if (line.minimum_sale_price !== '' && line.minimum_sale_price != null) {
            updated.minimum_sale_price_uzs = line.minimum_sale_price;
            const restoredUsd = line.minimum_sale_price_usd !== '' && line.minimum_sale_price_usd != null && Number(line.minimum_sale_price_usd) > 0
              ? String(line.minimum_sale_price_usd)
              : (rate && Number(line.minimum_sale_price) > 0 ? String(Number((Number(line.minimum_sale_price) / rate).toFixed(2))) : line.minimum_sale_price);
            updated.minimum_sale_price = restoredUsd;
            updated.minimum_sale_price_usd = restoredUsd;
          }
        }
        return updated;
      });
      return { ...prev, currency: newCurrency, lines: nextLines };
    });
  };

  const updateLineField=(idx,field,val)=>{
    setEditForm(prev=>{
      const lines=[...(prev.lines||[])];
      if (!lines[idx]) return prev;
      const currentVal = lines[idx][field];
      const resolvedVal = typeof val === 'function' ? val(currentVal) : val;
      const cur = { ...lines[idx], [field]: resolvedVal };
      const isUsd = (prev.currency || 'USD') === 'USD';
      const num = Number(resolvedVal);
      if (isUsd) {
        if (field === 'unit_cost') {
          cur.unit_cost_usd = resolvedVal;
          cur.unit_cost_uzs = rate && num > 0 ? String(Math.round(num * rate)) : '';
        } else if (field === 'retail_price') {
          cur.retail_price_usd = resolvedVal;
          cur.retail_price_uzs = rate && num > 0 ? String(Math.round(num * rate)) : '';
        } else if (field === 'wholesale_price') {
          cur.wholesale_price_usd = resolvedVal;
          cur.wholesale_price_uzs = rate && num > 0 ? String(Math.round(num * rate)) : '';
        } else if (field === 'minimum_sale_price') {
          cur.minimum_sale_price_usd = resolvedVal;
          cur.minimum_sale_price_uzs = rate && num > 0 ? String(Math.round(num * rate)) : '';
        }
      } else {
        if (field === 'unit_cost') {
          cur.unit_cost_uzs = resolvedVal;
          cur.unit_cost_usd = rate && num > 0 ? String(Number((num / rate).toFixed(2))) : '';
        } else if (field === 'retail_price') {
          cur.retail_price_uzs = resolvedVal;
          cur.retail_price_usd = rate && num > 0 ? String(Number((num / rate).toFixed(2))) : '';
        } else if (field === 'wholesale_price') {
          cur.wholesale_price_uzs = resolvedVal;
          cur.wholesale_price_usd = rate && num > 0 ? String(Number((num / rate).toFixed(2))) : '';
        } else if (field === 'minimum_sale_price') {
          cur.minimum_sale_price_uzs = resolvedVal;
          cur.minimum_sale_price_usd = rate && num > 0 ? String(Number((num / rate).toFixed(2))) : '';
        }
      }
      if (field === 'components' && cur.product_id) {
        for (let j = 0; j < lines.length; j++) {
          if (j !== idx && lines[j].product_id === cur.product_id) {
            lines[j] = { ...lines[j], components: resolvedVal };
          }
        }
      }
      lines[idx] = cur;
      return{...prev,lines};
    });
  };

  const removeReceiptLine = (idx) => {
    const line = editForm.lines?.[idx];
    if (!line) return;
    if ((editForm.lines?.length || 0) <= 1) {
      alert("Partiyada kamida 1 ta tovar qolishi kerak. Butun partiyani o'chirmoqchi bo'lsangiz, 'O'chirish' tugmasidan foydalaning.");
      return;
    }
    const colorText = line.variant_color ? ` (${line.variant_color})` : '';
    if (!window.confirm(`Haqiqatan ham "${line.product_name}"${colorText} tovarini ushbu partiyadan o'chirmoqchimisiz? Agar sotilmagan bo'lsa, zaxiradan ham o'chiriladi.`)) {
      return;
    }
    const batchId = line.id || line.batch_id;
    if (batchId) {
      setDeletedBatchIds(prev => [...new Set([...prev, batchId])]);
    }
    setEditForm(prev => ({
      ...prev,
      lines: (prev.lines || []).filter((_, i) => i !== idx)
    }));
  };

  const saveEdit=async()=>{
    setSaving(true);setError('');
    try{
      const isUsd = (editForm.currency || receipt.currency || 'USD') === 'USD';

      const zeroLines = (editForm.lines || []).filter(l => l.quantity !== '' && Number(l.quantity) <= 0);
      let activeLines = editForm.lines || [];
      let toDeleteIds = [...deletedBatchIds];

      if (zeroLines.length > 0) {
        if (activeLines.length === zeroLines.length) {
          setError("Barcha tovarlar miqdori 0 qilib kiritilgan. Partiyani to'liq o'chirish uchun 'O'chirish' tugmasidan foydalaning.");
          setSaving(false);
          return;
        }
        const names = zeroLines.map(l => `"${l.product_name}"${l.variant_color ? ` (${l.variant_color})` : ''}`).join(', ');
        if (!window.confirm(`${names} tovarining soni 0 deb kiritilgan. Ushbu tovar(lar) partiyadan butunlay o'chirilsinmi?`)) {
          setSaving(false);
          return;
        }
        zeroLines.forEach(zl => {
          const bId = zl.id || zl.batch_id;
          if (bId) toDeleteIds.push(bId);
        });
        activeLines = activeLines.filter(l => Number(l.quantity) > 0);
      }

      if (activeLines.length === 0) {
        setError("Partiyada kamida 1 ta tovar qolishi kerak.");
        setSaving(false);
        return;
      }

      // Save components for modular products if any
      const processedProductIds = new Set();
      for (const line of activeLines) {
        if (!line.product_id || processedProductIds.has(line.product_id)) continue;
        if (!line._hadComponents && (!line.components || line.components.length === 0)) continue;

        processedProductIds.add(line.product_id);

        try {
          const compsPayload = [];
          const compsList = line.components || [];
          for (let cIdx = 0; cIdx < compsList.length; cIdx++) {
            const c = compsList[cIdx];
            let cImageUrl = c.image_url || null;

            if (c.imageFile) {
              try {
                const compLabel = `${line.product_name || 'Mahsulot'} qismi: ${c.name || 'Qism'}`;
                const uploadRes = await uploadProductMedia(line.product_id, c.imageFile, compLabel, null);
                if (uploadRes?.publicUrl || uploadRes?.url) {
                  cImageUrl = uploadRes.publicUrl || uploadRes.url;
                }
              } catch (cImgErr) {
                console.warn('Modul qismi rasmini yuklashda xatolik:', cImgErr);
              }
            }

            let cCost = Number(c.cost_price) || 0;
            let cRetail = Number(c.retail_price) || 0;
            let cWholesale = Number(c.wholesale_price) || 0;
            let cCostUsd = c.cost_price_usd !== undefined && c.cost_price_usd !== '' && c.cost_price_usd !== null ? Number(c.cost_price_usd) : null;
            let cRetailUsd = c.retail_price_usd !== undefined && c.retail_price_usd !== '' && c.retail_price_usd !== null ? Number(c.retail_price_usd) : null;
            let cWholesaleUsd = c.wholesale_price_usd !== undefined && c.wholesale_price_usd !== '' && c.wholesale_price_usd !== null ? Number(c.wholesale_price_usd) : null;

            if (isUsd) {
              if (cCostUsd == null && cCost > 0) cCostUsd = cCost < 20000 ? cCost : (rate ? Number((cCost / rate).toFixed(2)) : cCost);
              if (cRetailUsd == null && cRetail > 0) cRetailUsd = cRetail < 20000 ? cRetail : (rate ? Number((cRetail / rate).toFixed(2)) : cRetail);
              if (cWholesaleUsd == null && cWholesale > 0) cWholesaleUsd = cWholesale < 20000 ? cWholesale : (rate ? Number((cWholesale / rate).toFixed(2)) : cWholesale);
              if (rate && cCostUsd != null && cCostUsd > 0) cCost = Math.round(cCostUsd * rate);
              if (rate && cRetailUsd != null && cRetailUsd > 0) cRetail = Math.round(cRetailUsd * rate);
              if (rate && cWholesaleUsd != null && cWholesaleUsd > 0) cWholesale = Math.round(cWholesaleUsd * rate);
            } else {
              cCost = Math.round(cCost);
              cRetail = Math.round(cRetail);
              cWholesale = Math.round(cWholesale);
              if (rate && cCost > 0 && cCostUsd == null) cCostUsd = Number((cCost / rate).toFixed(2));
              if (rate && cRetail > 0 && cRetailUsd == null) cRetailUsd = Number((cRetail / rate).toFixed(2));
              if (rate && cWholesale > 0 && cWholesaleUsd == null) cWholesaleUsd = Number((cWholesale / rate).toFixed(2));
            }

            compsPayload.push({
              ...(c.id && !String(c.id).startsWith('temp_') ? { id: c.id } : {}),
              name: c.name?.trim() || `Qism ${cIdx + 1}`,
              color_name: c.color_name || null,
              color_hex: c.color_hex || null,
              quantity: Math.max(1, Number(c.quantity) || 1),
              cost_price: cCost,
              cost_price_usd: cCostUsd,
              retail_price: cRetail,
              retail_price_usd: cRetailUsd,
              wholesale_price: cWholesale,
              wholesale_price_usd: cWholesaleUsd,
              is_default: c.is_default !== false,
              is_required: Boolean(c.is_required),
              can_buy_standalone: c.can_buy_standalone !== false,
              sort_order: cIdx,
              image_url: cImageUrl
            });
          }

          await saveProductComponents(line.product_id, compsPayload);
        } catch (compErr) {
          console.warn('Partiya tahrirlashda qismlarni saqlash xatoligi:', compErr);
        }
      }

      const payload={
        invoice_number:editForm.invoice_number,
        payment_status:editForm.payment_status,
        received_at:editForm.received_at?new Date(editForm.received_at+'T12:00:00').toISOString():null,
        notes:editForm.notes,
        receiving_location_id:editForm.receiving_location_id||null,
        currency:editForm.currency,
        deleted_batch_ids:[...new Set(toDeleteIds)],
        lines:activeLines.map(l=>{
          const uc = l.unit_cost===''?null:Number(l.unit_cost);
          const rp = l.retail_price===''?null:Number(l.retail_price);
          const wp = l.wholesale_price===''?null:Number(l.wholesale_price);
          const mp = l.minimum_sale_price===''?null:Number(l.minimum_sale_price);

          let ucUsd = l.unit_cost_usd !== undefined && l.unit_cost_usd !== '' && l.unit_cost_usd !== null ? Number(l.unit_cost_usd) : null;
          let rpUsd = l.retail_price_usd !== undefined && l.retail_price_usd !== '' && l.retail_price_usd !== null ? Number(l.retail_price_usd) : null;
          let wpUsd = l.wholesale_price_usd !== undefined && l.wholesale_price_usd !== '' && l.wholesale_price_usd !== null ? Number(l.wholesale_price_usd) : null;
          let mpUsd = l.minimum_sale_price_usd !== undefined && l.minimum_sale_price_usd !== '' && l.minimum_sale_price_usd !== null ? Number(l.minimum_sale_price_usd) : null;

          if (isUsd) {
            if (uc != null) ucUsd = uc;
            if (rp != null) rpUsd = rp;
            if (wp != null) wpUsd = wp;
            if (mp != null) mpUsd = mp;
          } else {
            if (ucUsd == null && uc != null && rate) ucUsd = Number((uc / rate).toFixed(2));
            if (rpUsd == null && rp != null && rate) rpUsd = Number((rp / rate).toFixed(2));
            if (wpUsd == null && wp != null && rate) wpUsd = Number((wp / rate).toFixed(2));
            if (mpUsd == null && mp != null && rate) mpUsd = Number((mp / rate).toFixed(2));
          }

          return {
            id:l.id||l.batch_id,
            batch_id:l.id||l.batch_id,
            quantity:Math.max(1,parseInt(l.quantity,10)||1),
            unit_cost: isUsd && rate && uc != null ? Math.round(uc * rate) : uc,
            unit_cost_usd: ucUsd,
            retail_price: isUsd && rate && rp != null ? Math.round(rp * rate) : rp,
            retail_price_usd: rpUsd,
            wholesale_price: isUsd && rate && wp != null ? Math.round(wp * rate) : wp,
            wholesale_price_usd: wpUsd,
            minimum_sale_price: isUsd && rate && mp != null ? Math.round(mp * rate) : mp,
            minimum_sale_price_usd: mpUsd,
            variant_color:l.variant_color?.trim()||null
          };
        })
      };
      const updatedReceipt = await updateStockReceipt(receipt.id,payload);
      setDeletedBatchIds([]);
      setEditing(false);
      toast?.('Partiya va tovarlar joylashuvi muvaffaqiyatli saqlandi!');
      onUpdated?.(updatedReceipt);
    }catch(e){setError(err(e))}finally{setSaving(false)}
  };

  const [passwordModal, setPasswordModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const removeReceipt=async(password=null)=>{
    const cleanPassword = typeof password === 'string' ? password.trim() : null;
    if(!cleanPassword&&!confirm("Bu partiyani o'chirasizmi? Sotilmagan birliklar ham o'chiriladi!"))return;
    setDeleting(true);setError('');
    try{
      await deleteStockReceipt(receipt.id,cleanPassword);
      setPasswordModal(false);
      close();
      onUpdated?.();
    }catch(e){
      const message=err(e);
      if(e?.code==='P0002'||message.includes('Topilmadi')){
        setPasswordModal(false);
        close();
        onUpdated?.();
      }else if(message.includes('sotilganlari bor')||e?.code==='P0001'||message.includes('Parol')||message.includes('parol')){
        if(cleanPassword){
          setPasswordError(message||'Noto\'g\'ri parol kiritildi!');
        }else{
          setPasswordInput('');
          setPasswordError('');
          setPasswordModal(true);
        }
      }else{
        if(passwordModal){
          setPasswordError(message);
        }else{
          setError(message);
        }
      }
    }finally{
      setDeleting(false);
    }
  };

  return <>
    <Modal open={Boolean(receipt)} onClose={close} title={receipt?.receipt_no||'Partiya'}>
      {receipt&&<div className="stack">
        <div className="receipt-info">
          <span><small>Ta’minotchi</small><b>{receipt.supplier_name}</b></span>
          <span><small>Qabul joyi</small><b>{receipt.location_name} {receipt.location_type==='warehouse'?'(Omborda)':receipt.location_type==='store'?'(Do‘konda)':''}</b></span>
          <span><small>Invoice</small><b>{receipt.invoice_number||'—'}</b></span>
          <span style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <div>
              <small>Valyuta</small>
              <b style={{color:String(receipt.currency||'USD').toUpperCase()==='USD'?'#0284c7':'#16a34a'}}>
                {String(receipt.currency||'USD').toUpperCase()==='USD'?'USD ($ - Dollar)':'UZS (So‘m)'}
              </b>
            </div>
            {!editing && (
              <button
                type="button"
                className="btn btn-sm btn-outline"
                style={{
                  fontSize:11,
                  padding:'3px 9px',
                  height:26,
                  fontWeight:700,
                  color:String(receipt.currency||'USD').toUpperCase()==='USD'?'#16a34a':'#0284c7',
                  borderColor:String(receipt.currency||'USD').toUpperCase()==='USD'?'#86efac':'#7dd3fc',
                  background:String(receipt.currency||'USD').toUpperCase()==='USD'?'#f0fdf4':'#f0f9ff',
                  cursor:'pointer',
                  display:'inline-flex',
                  alignItems:'center',
                  gap:4
                }}
                title={String(receipt.currency||'USD').toUpperCase()==='USD' ? "Valyutani UZS ga o'tkazish" : "Valyutani bugungi kursda USD ($) ga o'tkazish (tannarx USD da konstanta bo'ladi)"}
                onClick={async()=>{
                  const targetCurr = String(receipt.currency||'USD').toUpperCase()==='USD' ? 'UZS' : 'USD';
                  const targetName = targetCurr==='USD' ? 'USD ($)' : 'UZS (So‘m)';
                  const currentRate = Number(rate || 12800);
                  if(!confirm(`"${receipt.receipt_no}" partiyasi valyutasini ${targetName} ga o‘tkazishni tasdiqlaysizmi?\n\nBugungi kurs: 1 USD = ${currentRate.toLocaleString('uz-UZ')} UZS\n` + (targetCurr==='USD' ? 'UZS dagi tannarx bugungi kursda USD ga aylanadi va konstanta bo‘ladi.' : 'USD dagi tannarx bugungi kursda UZS ga aylanadi va konstanta bo‘ladi.'))) return;
                  try{
                    const res = await convertStockReceiptsCurrency([receipt.id], targetCurr);
                    toast?.(`Partiya valyutasi ${targetName} ga muvaffaqiyatli o‘tkazildi! (${res.updated_products} ta tovar yangilandi)`);
                    const updated = await getStockReceipt(receipt.id);
                    onUpdated?.(updated);
                  }catch(e){
                    alert('Valyutani o‘tkazishda xatolik: '+err(e));
                  }
                }}
              >
                <ArrowRight size={12}/>{String(receipt.currency||'USD').toUpperCase()==='USD' ? 'UZS ga o‘tkazish' : 'USD ($) ga o‘tkazish'}
              </button>
            )}
          </span>
          {rate&&<span><small>Kurs</small><b>1$ = {new Intl.NumberFormat('uz-UZ').format(rate)} so'm</b></span>}
        </div>
        {editing?(
          <div className="receipt-edit-section" style={{marginBottom:16,background:'#f8fafc',border:'1.5px solid #e2e8f0',borderRadius:12,padding:16}}>
            <h4 style={{margin:'0 0 12px',fontSize:15,color:'#0f172a',display:'flex',alignItems:'center',gap:6}}>
              <Pencil size={16} color="var(--orange)"/> Partiya ma'lumotlarini tahrirlash
            </h4>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))',gap:10,marginBottom:14}}>
              <label>
                <span style={{fontSize:12,fontWeight:700,color:'#0f172a',display:'flex',alignItems:'center',gap:4,marginBottom:4}}>
                  <MapPin size={13} color="var(--orange)"/> Qabul joylashuvi (Tovarlar joyi) *
                </span>
                <select className="select" style={{width:'100%',fontWeight:600}} value={editForm.receiving_location_id||''} onChange={e=>setEditForm({...editForm,receiving_location_id:e.target.value})}>
                  {locations.map(loc=>(
                    <option key={loc.id} value={loc.id}>{loc.name} {loc.type==='warehouse'?'(Ombor)':'(Do‘kon)'}</option>
                  ))}
                </select>
              </label>
              <label>
                <span style={{fontSize:12,fontWeight:600,color:'#475569',display:'block',marginBottom:4}}>Valyuta</span>
                <select className="select" style={{width:'100%'}} value={editForm.currency} onChange={e=>handleCurrencyChange(e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="UZS">UZS</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
              <label>
                <span style={{fontSize:12,fontWeight:600,color:'#475569',display:'block',marginBottom:4}}>Qabul sanasi</span>
                <input className="input" style={{width:'100%'}} type="date" value={editForm.received_at} onChange={e=>setEditForm({...editForm,received_at:e.target.value})}/>
              </label>
              <label>
                <span style={{fontSize:12,fontWeight:600,color:'#475569',display:'block',marginBottom:4}}>Invoice raqami</span>
                <input className="input" style={{width:'100%'}} value={editForm.invoice_number} onChange={e=>setEditForm({...editForm,invoice_number:e.target.value})} placeholder="Ixtiyoriy"/>
              </label>
              <label>
                <span style={{fontSize:12,fontWeight:600,color:'#475569',display:'block',marginBottom:4}}>To'lov holati</span>
                <select className="select" style={{width:'100%'}} value={editForm.payment_status} onChange={e=>setEditForm({...editForm,payment_status:e.target.value})}>
                  <option value="unpaid">To'lanmagan</option>
                  <option value="partial">Qisman</option>
                  <option value="paid">To'langan</option>
                </select>
              </label>
              <label style={{gridColumn:'1 / -1'}}>
                <span style={{fontSize:12,fontWeight:600,color:'#475569',display:'block',marginBottom:4}}>Izoh</span>
                <input className="input" style={{width:'100%'}} value={editForm.notes} onChange={e=>setEditForm({...editForm,notes:e.target.value})} placeholder="Qo‘shimcha izoh"/>
              </label>
            </div>

            <h5 style={{margin:'14px 0 8px',fontSize:13,fontWeight:700,color:'#1e293b'}}>
              Tovarlar ro'yxati ({editForm.lines?.length||0} ta):
            </h5>
            <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
              {(editForm.lines||[]).map((l,idx)=>(
                <div key={l.id||idx} style={{background:'#fff',border:'1px solid #cbd5e1',borderRadius:10,padding:12}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,gap:8,flexWrap:'wrap'}}>
                    <div>
                      <b style={{fontSize:14,color:'#0f172a'}}>{l.product_name}</b>
                      <span style={{fontSize:11,color:'#64748b',marginLeft:8}}>SKU: {l.sku||'—'}</span>
                    </div>
                    {(editForm.lines||[]).length > 1 && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{
                          display:'inline-flex',
                          alignItems:'center',
                          gap:4,
                          color:'#dc2626',
                          borderColor:'#fecaca',
                          background:'#fff1f2',
                          padding:'4px 8px',
                          fontSize:11,
                          fontWeight:600,
                          cursor:'pointer'
                        }}
                        onClick={()=>removeReceiptLine(idx)}
                        title="Ushbu tovarni partiyadan o'chirish"
                      >
                        <Trash2 size={13}/> O'chirish
                      </button>
                    )}
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))',gap:8,fontSize:12}}>
                    <label>
                      <span style={{fontSize:11,color:'var(--muted)',display:'block',marginBottom:2}}>Soni (dona) *</span>
                      <input className="input" style={{width:'100%',padding:'6px 8px'}} type="number" min="0" value={l.quantity} onChange={e=>updateLineField(idx,'quantity',e.target.value)}/>
                    </label>
                    <label>
                      <span style={{fontSize:11,color:'var(--muted)',display:'block',marginBottom:2}}>Mahsulot rangi / varianti</span>
                      <input className="input" style={{width:'100%',padding:'6px 8px'}} value={l.variant_color} placeholder="Masalan: Qora" onChange={e=>updateLineField(idx,'variant_color',e.target.value)}/>
                    </label>
                    <label>
                      <span style={{fontSize:11,color:'var(--muted)',display:'block',marginBottom:2}}>Tan narxi ({editForm.currency})</span>
                      <input className="input" style={{width:'100%',padding:'6px 8px'}} type="number" min="0" step="any" value={l.unit_cost} onChange={e=>updateLineField(idx,'unit_cost',e.target.value)}/>
                    </label>
                    <label>
                      <span style={{fontSize:11,color:'var(--muted)',display:'block',marginBottom:2}}>Sotish narxi ({editForm.currency})</span>
                      <input className="input" style={{width:'100%',padding:'6px 8px'}} type="number" min="0" step="any" value={l.retail_price} onChange={e=>updateLineField(idx,'retail_price',e.target.value)}/>
                    </label>
                    <label>
                      <span style={{fontSize:11,color:'var(--muted)',display:'block',marginBottom:2}}>Ulgurji narx ({editForm.currency})</span>
                      <input className="input" style={{width:'100%',padding:'6px 8px'}} type="number" min="0" step="any" value={l.wholesale_price} onChange={e=>updateLineField(idx,'wholesale_price',e.target.value)}/>
                    </label>
                    <label>
                      <span style={{fontSize:11,color:'var(--muted)',display:'block',marginBottom:2}}>Min sotuv narxi ({editForm.currency})</span>
                      <input className="input" style={{width:'100%',padding:'6px 8px'}} type="number" min="0" step="any" value={l.minimum_sale_price} onChange={e=>updateLineField(idx,'minimum_sale_price',e.target.value)}/>
                    </label>
                  </div>

                  {/* Tarkibiy va qo'shimcha qismlar (Modulli tovar) tahrirlash */}
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #cbd5e1' }}>
                    <ProductComponentEditor
                      components={l.components || []}
                      onChange={updated => {
                        updateLineField(idx, 'components', updated);
                      }}
                      rate={rate}
                      showQuantity={true}
                    />
                    {Array.isArray(l.components) && l.components.length > 0 && (
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', background: '#f8fafc', padding: '8px 12px', borderRadius: 8, fontSize: 12, color: 'var(--muted, #64748b)', marginTop: 8, border: '1px solid #e2e8f0' }}>
                        <span>Jami tarkibiy qismlar: <b style={{ color: '#1e293b' }}>{l.components.reduce((sum, c) => sum + (Number(c.quantity) || 1), 0)} dona</b> ({l.components.length} xil qism)</span>
                        <span>Qismlar umumiy tannarxi: <b style={{ color: '#1e293b' }}>{formatDualMoney(l.components.reduce((sum, c) => sum + ((Number(c.cost_price) || 0) * (Number(c.quantity) || 1)), 0), rate)}</b></span>
                        <span>Qismlar umumiy sotish narxi: <b style={{ color: '#1e293b' }}>{formatDualMoney(l.components.reduce((sum, c) => sum + ((Number(c.retail_price) || 0) * (Number(c.quantity) || 1)), 0), rate)}</b></span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
              <button type="button" className="btn btn-outline" onClick={()=>setEditing(false)}>Bekor qilish</button>
              <button type="button" className="btn btn-primary" onClick={saveEdit} disabled={saving}>
                {saving?'Saqlanmoqda…':'O‘zgarishlarni saqlash'}
              </button>
            </div>
          </div>
        ):(
          <div style={{display:'flex',gap:8,margin:'8px 0',flexWrap:'wrap'}}>
            <button className="btn" onClick={()=>setEditing(true)}>Tahrirlash</button>
            <button className="btn btn-outline" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={()=>onExportSingle?.(receipt.id,receipt.receipt_no)} title="Ushbu partiyani JSON zahiraga saqlash">
              <Download size={14}/>Zahira (JSON)
            </button>
            <button className="btn" style={{background:'#fee2e2',color:'#b91c1c',borderColor:'#fecaca'}} onClick={()=>removeReceipt()} disabled={deleting}>{deleting?'O‘chirilmoqda…':'O‘chirish'}</button>
          </div>
        )}
        {receipt.lines.map(x=>(
          <div key={x.id}>
            <div className="receipt-line" style={{cursor:'pointer'}} onClick={()=>expandLine(x)}>
              <div><b>{x.product_name}</b>{x.variant_color&&<span className="receipt-line-color">{x.variant_color}</span>}<span>{x.sku}</span></div>
              <strong>{Number(x.quantity)} dona</strong>
              <small><DualPrice value={Number(x.unit_cost||0)} usdValue={x.unit_cost_usd != null ? Number(x.unit_cost_usd) : undefined} rate={rate}/> · {Number(x.quantity)} dona</small>
            </div>
            {expandedLine===x.id&&<div style={{padding:12,border:'1px solid var(--line)',borderRadius:10,marginTop:6,marginBottom:8}}>
              {loadingLine?<p style={{color:'var(--muted)'}}>Yuklanmoqda…</p>:(
                <>
                  {lineProduct&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10,fontSize:11}}>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Sana</small><b>{receipt.received_at?new Date(receipt.received_at).toLocaleDateString('uz-UZ'):'—'}</b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Soni</small><b>{Number(x.quantity)} dona</b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Tannarx</small><b><DualPrice value={Number(x.unit_cost||0)} usdValue={x.unit_cost_usd != null ? Number(x.unit_cost_usd) : undefined} rate={rate}/></b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Sotish narxi</small><b><DualPrice value={Number(lineProduct.retail_price||0)} usdValue={lineProduct.retail_price_usd != null ? Number(lineProduct.retail_price_usd) : undefined} rate={rate}/></b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Ulgurji</small><b><DualPrice value={Number(lineProduct.wholesale_price||0)} usdValue={lineProduct.wholesale_price_usd != null ? Number(lineProduct.wholesale_price_usd) : undefined} rate={rate}/></b></span>
                    <span style={{background:'#f8fafc',padding:8,borderRadius:8}}><small style={{display:'block',color:'var(--muted)'}}>Min narx</small><b><DualPrice value={Number(lineProduct.minimum_sale_price||0)} usdValue={lineProduct.minimum_sale_price_usd != null ? Number(lineProduct.minimum_sale_price_usd) : undefined} rate={rate}/></b></span>
                  </div>}
                  {editingLine?(
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10,fontSize:12}}>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Tannarx ({receipt?.currency || 'USD'})</span><input className="input" type="number" min="0" step="any" value={linePrices.unit_cost} onChange={e=>setLinePrices({...linePrices,unit_cost:e.target.value})}/></label>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Sotish narxi ({receipt?.currency || 'USD'})</span><input className="input" type="number" min="0" step="any" value={linePrices.retail_price} onChange={e=>setLinePrices({...linePrices,retail_price:e.target.value})}/></label>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Ulgurji ({receipt?.currency || 'USD'})</span><input className="input" type="number" min="0" step="any" value={linePrices.wholesale_price} onChange={e=>setLinePrices({...linePrices,wholesale_price:e.target.value})}/></label>
                      <label><span style={{fontSize:11,color:'var(--muted)'}}>Min narx ({receipt?.currency || 'USD'})</span><input className="input" type="number" min="0" step="any" value={linePrices.minimum_sale_price} onChange={e=>setLinePrices({...linePrices,minimum_sale_price:e.target.value})}/></label>
                      <div style={{gridColumn:'1/-1',display:'flex',gap:8}}>
                        <button className="btn btn-primary" style={{fontSize:12}} onClick={()=>saveLinePrices2(x.id,lineProduct.id)} disabled={savingLine}>{savingLine?'Saqlanmoqda…':'Saqlash'}</button>
                        <button className="btn" style={{fontSize:12}} onClick={()=>setEditingLine(false)}>Bekor</button>
                      </div>
                    </div>
                  ):(
                    <button type="button" className="btn" style={{fontSize:11,marginBottom:8}} onClick={()=>startEditLine(x,lineProduct)}>Narxlarni tahrirlash</button>
                  )}
                  {Array.isArray(lineProduct?.components) && lineProduct.components.length > 0 && (
                    <div style={{
                      background: '#ffffff',
                      border: '1px solid #e2e8f0',
                      borderRadius: 10,
                      padding: '10px 12px',
                      marginBottom: 10
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Layers size={14} color="#f97316" />
                          <b style={{ fontSize: 12, color: '#0f172a' }}>Tarkibiy qismlar ({lineProduct.components.length} xil)</b>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                          Jami: <b style={{ color: '#1e293b' }}>{lineProduct.components.reduce((sum, c) => sum + (Number(c.quantity) || 1), 0)} dona</b>
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                        {lineProduct.components.map((c, cIdx) => (
                          <div key={c.id || cIdx} style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 8,
                            padding: '6px 8px',
                            fontSize: 11
                          }}>
                            {c.image_url ? (
                              <img src={c.image_url} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                            ) : (
                              <div style={{ width: 28, height: 28, borderRadius: 6, background: c.color_hex || '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Layers size={12} color="#fff" />
                              </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, color: '#1e293b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {c.name}
                              </div>
                              <div style={{ color: 'var(--muted)', fontSize: 10 }}>
                                {c.color_name ? `${c.color_name} · ` : ''}{c.quantity || 1} dona
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontWeight: 700, color: 'var(--navy)' }}>
                                <DualPrice value={Number(c.retail_price || 0)} usdValue={c.retail_price_usd != null ? Number(c.retail_price_usd) : undefined} rate={rate} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(() => {
                    const canonicalQr = lineUnits?.[0]?.qr_code || x.qr_code || '';
                    const hasSerials = lineUnits.some(u => u.serial_number);
                    return (
                      <div style={{
                        background: '#f8fafc',
                        border: '1.5px solid #e2e8f0',
                        borderRadius: 12,
                        padding: '12px 14px',
                        marginTop: 4
                      }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 10,
                          marginBottom: 8
                        }}>
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 3 }}>
                              Partiya umumiy QR kodi ({Number(x.quantity)} dona uchun):
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <code style={{
                                fontSize: 15,
                                fontWeight: 900,
                                color: '#0f172a',
                                background: '#ffffff',
                                border: '1.5px solid #cbd5e1',
                                padding: '3px 10px',
                                borderRadius: 6,
                                letterSpacing: '0.5px'
                              }}>
                                {canonicalQr || '—'}
                              </code>
                              {canonicalQr && (
                                <button
                                  type="button"
                                  className="btn btn-outline"
                                  style={{ padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                  onClick={() => {
                                    navigator.clipboard?.writeText(canonicalQr);
                                  }}
                                  title="QR kodni nusxalash"
                                >
                                  <Copy size={12} />
                                  Nusxa
                                </button>
                              )}
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{
                                background: 'linear-gradient(135deg, #f97316, #ea580c)',
                                borderColor: '#ea580c',
                                padding: '6px 12px',
                                fontSize: 12,
                                fontWeight: 700,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                boxShadow: '0 2px 6px rgba(249,115,22,0.25)'
                              }}
                              onClick={() => {
                                const secretCode = formatSecretCostCode({
                                  cost: x.unit_cost || lineProduct?.cost_price || '',
                                  costUsd: x.unit_cost_usd || lineProduct?.unit_cost_usd || lineProduct?.cost_price_usd || '',
                                  currency: receipt?.currency || 'USD'
                                });
                                openBluetoothPrint({
                                  id: x.id,
                                  product_name: lineProduct?.name || x.product_name || 'Mahsulot',
                                  title: lineProduct?.name || x.product_name || 'Mahsulot',
                                  variant_color: lineProduct?.variant_color || x.variant_color || '',
                                  color: lineProduct?.variant_color || x.variant_color || '',
                                  qr_code: canonicalQr,
                                  code: canonicalQr,
                                  cost_usd: secretCode,
                                  costUsd: secretCode,
                                  cost: x.unit_cost || lineProduct?.cost_price || '',
                                  currency: receipt?.currency || 'USD',
                                  quantity: Number(x.quantity) || 1,
                                  date: receipt?.received_at ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ')
                                });
                              }}
                            >
                              <Bluetooth size={14} />
                              <Printer size={14} />
                              Chop etish ({Number(x.quantity)} dona)
                            </button>

                            <button
                              type="button"
                              className="btn btn-outline"
                              style={{ padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                              onClick={() => downloadLineQR({ qr_code: canonicalQr })}
                            >
                              <Download size={13} />
                              QR yuklab olish
                            </button>
                          </div>
                        </div>

                        {hasSerials && (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e2e8f0', fontSize: 11 }}>
                            <span style={{ fontWeight: 600, color: 'var(--muted)' }}>Seriya raqamlari: </span>
                            <span style={{ color: 'var(--navy)' }}>
                              {lineUnits.filter(u => u.serial_number).map(u => u.serial_number).join(', ')}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>}
          </div>
        ))}
        {error&&<div className="employee-error">{error}</div>}
        <div style={{
          fontSize: 11,
          color: 'var(--muted)',
          background: '#f8fafc',
          border: '1.5px solid #e2e8f0',
          padding: '10px 14px',
          borderRadius: 12,
          marginBottom: 10
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--navy)', marginBottom: 3 }}>
            <Printer size={15} color="#ea580c" />
            <span>Bluetooth Termoprinterlar (Detonger & MHT-L80G):</span>
          </div>
          <div style={{ lineHeight: 1.4 }}>
            Telefonda Bluetooth yoki kompyuterda ulanib, <b>Detonger (40 mm)</b> yoki yangi <b>MHT-L80G (58 mm)</b> termoprinterida chop eting:
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{
                padding: '12px 8px',
                fontSize: 12,
                fontWeight: 700,
                background: 'linear-gradient(135deg, #f97316, #ea580c)',
                boxShadow: '0 4px 14px rgba(249,115,22,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6
              }}
              onClick={() => openBluetoothPrint(null, 'detonger')}
              disabled={loading}
              title="Detonger printerida chop etish"
            >
              <Bluetooth size={15} />
              <span>Detonger (40 mm)</span>
            </button>

            <button
              type="button"
              className="btn btn-primary"
              style={{
                padding: '12px 8px',
                fontSize: 12,
                fontWeight: 700,
                background: 'linear-gradient(135deg, #0284c7, #0369a1)',
                boxShadow: '0 4px 14px rgba(2,132,199,0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6
              }}
              onClick={() => openBluetoothPrint(null, 'mht')}
              disabled={loading}
              title="MHT-L80G printerida 58x40 mm o‘lchamda chop etish"
            >
              <Bluetooth size={15} />
              <span>MHT-L80G (58 mm)</span>
            </button>
          </div>

          <button
            type="button"
            className="btn btn-outline btn-block"
            style={{ padding: '9px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            onClick={handleClassicPrint}
            disabled={loading}
          >
            <QrCode size={14} />
            Kompyuter / Tizim orqali klassik chop etish
          </button>
        </div>
      </div>}
    </Modal>
    <DetongerPrintModal
      open={bluetoothModalOpen}
      onClose={()=>{setBluetoothModalOpen(false);setSinglePrintLabel(null);}}
      labels={singlePrintLabel?[singlePrintLabel]:labels}
      batchTitle={receipt?.receipt_no?(isInventoryReceipt(receipt.receipt_no)?`Inventarizatsiya #${receipt.receipt_no}`:`Partiya #${receipt.receipt_no}`):''}
      receiptDate={receipt?.received_at?new Date(receipt.received_at).toLocaleDateString('uz-UZ'):''}
      initialPrinter={preferredPrinter}
      onClassicPrint={()=>{
        setBluetoothModalOpen(false);
        setPrintPending(true);
      }}
    />
    {labels.length>0&&createPortal(
      <div className="qr-print-sheet">
        {labels.map((x, idx)=>{
          const label=x.price_label||{};
          const matchedLine = (receipt?.lines || []).find(l => 
            (x.line_no && l.line_no === x.line_no) ||
            (x.product_id && l.product_id === x.product_id && (l.variant_id || null) === (x.variant_id || null)) ||
            (l.product_name === x.product_name && (l.variant_color || null) === (x.variant_color || null))
          );
          const prodTitle=label.title||x.product_name||matchedLine?.product_name||'Mahsulot';
          const colorName=label.color||x.variant_color||matchedLine?.variant_color||'';
          const receiptDate = receipt?.received_at 
            ? new Date(receipt.received_at).toLocaleDateString('uz-UZ') 
            : new Date().toLocaleDateString('uz-UZ');
          const rawCost = x.cost_usd || x.unit_cost_usd || x.cost_price_usd || matchedLine?.unit_cost_usd || '';
          const costStr = formatSecretCostCode({
            cost: x.cost || matchedLine?.unit_cost || '',
            costUsd: rawCost,
            currency: x.currency || receipt?.currency || 'USD'
          });

          return (
            <article className="qr-print-label" key={x.id || idx}>
              <div className="qr-print-body">
                <div className="qr-print-image-wrap">
                  <img className="qr-print-img" src={x.qrImage} alt="QR"/>
                </div>

                <div className="qr-print-details">
                  <div className="qr-print-name-color">
                    {prodTitle} {colorName ? `(${colorName})` : ''}
                  </div>
                  <div className="qr-print-meta">
                    <span className="qr-print-date">Sana: {receiptDate}</span>
                    {costStr && <span className="qr-print-cost">{costStr}</span>}
                    <span className="qr-print-code">{x.qr_code||label.qr}</span>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>,
      document.body
    )}
    {passwordModal && (
      <Modal open={passwordModal} onClose={() => setPasswordModal(false)} title="Sotilgan tovarlar mavjud — Parol talab qilinadi">
        <form
          onSubmit={e => {
            e.preventDefault();
            if (!passwordInput.trim()) return;
            removeReceipt(passwordInput.trim());
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={20} color="#ea580c" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, color: '#9a3412', lineHeight: 1.5 }}>
              <b>"{receipt.receipt_no}"</b> partiyasidan sotilgan tovarlar bor!
              <br />
              Ushbu partiyani va unga bog‘liq barcha birliklarni butunlay o‘chirish uchun tasdiqlash parolini kiriting.
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Tasdiqlash paroli:
            </label>
            <input
              type="password"
              autoFocus
              className="input"
              style={{ width: '100%', padding: '8px 12px', fontSize: 14 }}
              placeholder="Parolni kiriting..."
              value={passwordInput}
              onChange={e => { setPasswordInput(e.target.value); setPasswordError(''); }}
            />
          </div>

          {passwordError && (
            <div style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: '8px 12px', borderRadius: 6, border: '1px solid #fecaca' }}>
              {passwordError}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setPasswordModal(false)}
              disabled={deleting}
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              className="btn"
              style={{ background: '#dc2626', color: '#fff', borderColor: '#dc2626' }}
              disabled={!passwordInput.trim() || deleting}
            >
              <Trash2 size={15} />
              {deleting ? 'O‘chirilmoqda…' : 'O‘chirish'}
            </button>
          </div>
        </form>
      </Modal>
    )}
  </>;
}
export function ReceiptModal({open,close,branchId,created,mode='batch',toast}){
  const isInventory = mode === 'inventory';
  const makeUniqueReceiptNo = (isInv) => {
    const n = new Date();
    const prefix = isInv ? 'INV-' : 'PT-';
    const pad = num => String(num).padStart(2, '0');
    const dateNumStr = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`;
    const timeNumStr = `${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}${dateNumStr}-${timeNumStr}-${rand}`;
  };

  const[refs,setRefs]=useState({locations:[],suppliers:[],products:[]});
  const[form,setForm]=useState(()=>{
    const n=new Date();
    const localDateStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const rno = makeUniqueReceiptNo(isInventory);
    const savedLoc = isInventory && typeof window !== 'undefined'
      ? (localStorage.getItem('tb_last_inventory_loc_' + (branchId || '')) || localStorage.getItem('tb_last_inventory_loc') || '')
      : '';
    return{receipt_no:rno,supplier_id:'',receiving_location_id:savedLoc,invoice_number:'',currency:isInventory?'UZS':'USD',payment_status:'paid',received_at:localDateStr,notes:isInventory?'Do‘konda/skladda mavjud tovarlar inventarizatsiyasi':'',paid_amount:''};
  });
  const[lines,setLines]=useState([{
    product_id:'',
    color_name:'',
    variant_id:'',
    quantity:1,
    currency:isInventory?'UZS':'USD',
    unit_cost:'',
    unit_cost_usd:'',
    serials:'',
    retail_price:'',
    retail_price_usd:'',
    wholesale_price:'',
    wholesale_price_usd:'',
    minimum_sale_price:'',
    minimum_sale_price_usd:'',
    priceConfirmed:false,
    variants:[],
    variantConfigs:{},
    variantImageFiles:[],
    components:[]
  }]);
  const[busy,setBusy]=useState(false),[error,setError]=useState('');
  const[showCreateProduct,setShowCreateProduct]=useState(false);
  const[createForLineIdx,setCreateForLineIdx]=useState(null);
  const[showCreateSupplier,setShowCreateSupplier]=useState(false);
  const[newSupplierName,setNewSupplierName]=useState('');
  const[newSupplierBusy,setNewSupplierBusy]=useState(false);
  const[rate,setRate]=useState(null);
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{})},[]);

  const draftKey = `tb_draft_receipt_${branchId || ''}_${mode}`;
  const [draftRestored, setDraftRestored] = useState(false);

  useEffect(() => {
    if (open && branchId) {
      try {
        const raw = localStorage.getItem(draftKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.lines) && parsed.lines.some(l => l.product_id || (l.quantity && l.quantity > 1) || l.unit_cost || l.retail_price || l.serials)) {
            setLines(parsed.lines);
            if (parsed.form) {
              const { receipt_no: _staleNo, ...restForm } = parsed.form;
              setForm(prev => ({
                ...prev,
                ...restForm,
                receipt_no: makeUniqueReceiptNo(isInventory)
              }));
            }
            setDraftRestored(true);
          }
        }
      } catch {}
    } else {
      setDraftRestored(false);
    }
  }, [open, branchId, draftKey, isInventory]);

  useEffect(() => {
    if (!open || !branchId) return;
    const timer = setTimeout(() => {
      const hasContent = lines.some(l => l.product_id || (l.quantity && l.quantity > 1) || l.unit_cost || l.retail_price || l.serials);
      if (hasContent) {
        try {
          localStorage.setItem(draftKey, JSON.stringify({ form, lines, updatedAt: Date.now() }));
        } catch {}
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [open, branchId, draftKey, form, lines]);

  useEffect(()=>{
    if(open&&branchId){
      const n=new Date();
      const localDateStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
      setForm(f=>{
        const prefixOk = isInventory ? /^INV-/i.test(f.receipt_no || '') : /^PT-/i.test(f.receipt_no || '');
        const validReceiptNo = (f.receipt_no && f.receipt_no.length > 5 && prefixOk)
          ? f.receipt_no
          : makeUniqueReceiptNo(isInventory);

        return {
          ...f,
          receipt_no: validReceiptNo,
          received_at: f.received_at || localDateStr,
          currency: isInventory ? (f.currency || 'UZS') : (f.currency || 'USD'),
          notes: isInventory
            ? (f.notes || 'Do‘konda/skladda mavjud tovarlar inventarizatsiyasi')
            : (f.notes === 'Do‘konda/skladda mavjud tovarlar inventarizatsiyasi' ? '' : f.notes)
        };
      });
      if (isInventory) {
        setLines(prev => {
          if (Array.isArray(prev) && prev.length === 1 && !prev[0]?.product_id && !prev[0]?.unit_cost && prev[0]?.currency === 'USD') {
            return [{ ...prev[0], currency: 'UZS' }];
          }
          return prev;
        });
      }
      getInventoryReferences(branchId).then(async r=>{
        // Barcha tovarlarni (1000 dan ortiq bo'lsa ham) to'liq yuklab olamiz
        let allProds = [];
        let chunkOffset = 0;
        const chunkSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data: chunk, error: pErr } = await getBrowserClient()
            .from('products')
            .select('id,name,sku,cost_price,retail_price,wholesale_price,minimum_sale_price,cost_price_usd,retail_price_usd,wholesale_price_usd,minimum_sale_price_usd,currency')
            .neq('status', 'archived')
            .order('name')
            .range(chunkOffset, chunkOffset + chunkSize - 1);
          if (pErr) break;
          if (chunk && chunk.length > 0) {
            allProds = allProds.concat(chunk);
            if (chunk.length < chunkSize) hasMore = false;
            else chunkOffset += chunkSize;
          } else {
            hasMore = false;
          }
        }
        const{data:cats}=await getBrowserClient().from('categories').select('id,name,slug,parent_id').eq('is_active',true).order('sort_order');
        const{data:brands}=await getBrowserClient().from('brands').select('id,name').eq('is_active',true).order('name');
        const fullProducts=(allProds||[]).map(p=>{const ref=(r.products||[]).find(x=>x.id===p.id);return{...p,image:ref?.image||null,track_individual_units:ref?.track_individual_units??true}});
        setRefs({...r,products:fullProducts,categories:cats||[],brands:brands||[]});
        
        let initialSupplierId = isInventory ? '' : (r.suppliers[0]?.id || '');

        let initialLocationId = '';
        if (isInventory) {
          const locKey = 'tb_last_inventory_loc_' + branchId;
          const savedLoc = (typeof window !== 'undefined' && (localStorage.getItem(locKey) || localStorage.getItem('tb_last_inventory_loc'))) || '';
          if (savedLoc && r.locations.some(x => x.id === savedLoc)) {
            initialLocationId = savedLoc;
          } else {
            try {
              const { data: lastInv } = await getBrowserClient()
                .from('stock_receipts')
                .select('receiving_location_id')
                .eq('branch_id', branchId)
                .like('receipt_no', 'INV-%')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
              if (lastInv?.receiving_location_id && r.locations.some(x => x.id === lastInv.receiving_location_id)) {
                initialLocationId = lastInv.receiving_location_id;
                try {
                  localStorage.setItem(locKey, initialLocationId);
                  localStorage.setItem('tb_last_inventory_loc', initialLocationId);
                } catch {}
              }
            } catch {}
          }
        }
        if (!initialLocationId) {
          initialLocationId = r.locations.find(x => x.type === 'warehouse')?.id || r.locations[0]?.id || '';
        }

        setForm(f=>({
          ...f,
          supplier_id:f.supplier_id||initialSupplierId,
          receiving_location_id: isInventory ? initialLocationId : (f.receiving_location_id || initialLocationId)
        }));
      }).catch(e=>setError(err(e)));
    }
  },[open,branchId,isInventory]);

  const setLine = (i, keyOrPatch, value) => {
    setLines(prev => prev.map((x, j) => {
      if (j !== i) return x;
      if (typeof keyOrPatch === 'function') {
        return keyOrPatch(x);
      }
      if (typeof keyOrPatch === 'object' && keyOrPatch !== null) {
        return { ...x, ...keyOrPatch };
      }
      const resolvedVal = typeof value === 'function' ? value(x[keyOrPatch]) : value;
      return { ...x, [keyOrPatch]: resolvedVal };
    }));
  };

  const handleProductSelect=async(i,productId,productOverride=null)=>{
    const product=productOverride || refs.products.find(p=>p.id===productId);
    const prodCurrency = product?.currency || form.currency || 'USD';
    const initialLine = {
      ...lines[i],
      product_id:productId,
      color_name:'',
      variant_id:'',
      currency: prodCurrency,
      unit_cost:String(product?.cost_price!=null?product.cost_price:''),
      unit_cost_usd:product?.cost_price_usd!=null?Number(product.cost_price_usd):(product?.cost_price&&rate?Number((Number(product.cost_price)/rate).toFixed(2)):''),
      retail_price:String(product?.retail_price!=null?product.retail_price:''),
      retail_price_usd:product?.retail_price_usd!=null?Number(product.retail_price_usd):(product?.retail_price&&rate?Number((Number(product.retail_price)/rate).toFixed(2)):''),
      wholesale_price:String(product?.wholesale_price!=null?product.wholesale_price:''),
      wholesale_price_usd:product?.wholesale_price_usd!=null?Number(product.wholesale_price_usd):(product?.wholesale_price&&rate?Number((Number(product.wholesale_price)/rate).toFixed(2)):''),
      minimum_sale_price:String(product?.minimum_sale_price!=null?product.minimum_sale_price:''),
      minimum_sale_price_usd:product?.minimum_sale_price_usd!=null?Number(product.minimum_sale_price_usd):(product?.minimum_sale_price&&rate?Number((Number(product.minimum_sale_price)/rate).toFixed(2)):''),
      priceConfirmed:false,
      variants:product?.variants || [],
      variantConfigs:{},
      variantImageFiles:[],
      components:[]
    };
    setLines(lines.map((x,j)=>j===i?initialLine:x));
    if(!productId)return;
    try{
      const{data}=await getBrowserClient().from('product_variants').select('*, product_media(id, public_url, is_primary, sort_order)').eq('product_id',productId).eq('is_active',true).order('sort_order');
      const loadedVariants = (data || []).map(v => {
        const sortedMedia = (v.product_media || []).sort((a,b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));
        return {
          ...v,
          image_url: sortedMedia[0]?.public_url || null,
          media: sortedMedia
        };
      });

      let loadedComps = [];
      try {
        const { data: dbComps } = await getBrowserClient()
          .from('product_components')
          .select('*')
          .eq('product_id', productId)
          .eq('is_active', true)
          .order('sort_order');
        loadedComps = (dbComps || []).map(c => ({
          ...c,
          quantity: c.quantity || 1,
          cost_price: c.cost_price != null ? String(c.cost_price) : '',
          cost_price_usd: c.cost_price_usd != null ? Number(c.cost_price_usd) : '',
          retail_price: c.retail_price != null ? String(c.retail_price) : '',
          retail_price_usd: c.retail_price_usd != null ? Number(c.retail_price_usd) : '',
          wholesale_price: c.wholesale_price != null ? String(c.wholesale_price) : '',
          wholesale_price_usd: c.wholesale_price_usd != null ? Number(c.wholesale_price_usd) : '',
          image_url: c.image_url || null,
          imageFile: null,
          previewUrl: c.image_url || null
        }));
      } catch (cErr) {
        console.warn('Components load error:', cErr);
      }

      setLines(current=>current.map((x,j)=>{
        if (x.product_id === productId) {
          return { ...x, variants: loadedVariants, components: loadedComps };
        }
        return j===i ? { ...x, variants: loadedVariants, components: loadedComps } : x;
      }));
    }catch{/* variantsiz mahsulot */}
  };

  const handleAddColorToLastProduct = () => {
    const lastLineWithProduct = [...lines].reverse().find(l => l.product_id);
    if (!lastLineWithProduct) {
      setError("Avval tovar tanlang");
      return;
    }
    const product = refs.products.find(p => p.id === lastLineWithProduct.product_id);
    setLines([
      ...lines,
      {
        product_id: lastLineWithProduct.product_id,
        color_name: '',
        variant_id: '',
        quantity: 1,
        currency: lastLineWithProduct.currency || product?.currency || form.currency || 'USD',
        unit_cost: lastLineWithProduct.unit_cost || String(product?.cost_price || ''),
        unit_cost_usd: lastLineWithProduct.unit_cost_usd ?? (product?.cost_price_usd != null ? Number(product.cost_price_usd) : ''),
        retail_price: lastLineWithProduct.retail_price || String(product?.retail_price || ''),
        retail_price_usd: lastLineWithProduct.retail_price_usd ?? (product?.retail_price_usd != null ? Number(product.retail_price_usd) : ''),
        wholesale_price: lastLineWithProduct.wholesale_price || String(product?.wholesale_price || ''),
        wholesale_price_usd: lastLineWithProduct.wholesale_price_usd ?? (product?.wholesale_price_usd != null ? Number(product.wholesale_price_usd) : ''),
        minimum_sale_price: lastLineWithProduct.minimum_sale_price || String(product?.minimum_sale_price || ''),
        minimum_sale_price_usd: lastLineWithProduct.minimum_sale_price_usd ?? (product?.minimum_sale_price_usd != null ? Number(product.minimum_sale_price_usd) : ''),
        priceConfirmed: lastLineWithProduct.priceConfirmed || false,
        serials: '',
        variants: lastLineWithProduct.variants || [],
        variantConfigs: {},
        variantImageFiles: [],
        components: (lastLineWithProduct.components || []).map(c => ({ ...c }))
      }
    ]);
  };

  const handleAddNewProductLine = () => {
    setLines([
      ...lines,
      {
        product_id: '',
        color_name: '',
        variant_id: '',
        quantity: 1,
        currency: form.currency || 'USD',
        unit_cost: '',
        unit_cost_usd: '',
        serials: '',
        retail_price: '',
        retail_price_usd: '',
        wholesale_price: '',
        wholesale_price_usd: '',
        minimum_sale_price: '',
        minimum_sale_price_usd: '',
        priceConfirmed: false,
        variants: [],
        variantConfigs: {},
        variantImageFiles: [],
        components: []
      }
    ]);
  };

  const confirmPrice=(i,updatePrices)=>{
    const line = lines[i];
    const product = refs.products.find(p => p.id === line?.product_id);
    const rUzs = line?.retail_price || String(product?.retail_price != null ? product.retail_price : '');
    const rUsd = line?.retail_price_usd !== undefined && line?.retail_price_usd !== '' ? line.retail_price_usd : (product?.retail_price_usd != null ? Number(product.retail_price_usd) : (product?.retail_price && rate ? Number((Number(product.retail_price) / rate).toFixed(2)) : ''));
    const wUzs = line?.wholesale_price || String(product?.wholesale_price != null ? product.wholesale_price : '');
    const wUsd = line?.wholesale_price_usd !== undefined && line?.wholesale_price_usd !== '' ? line.wholesale_price_usd : (product?.wholesale_price_usd != null ? Number(product.wholesale_price_usd) : (product?.wholesale_price && rate ? Number((Number(product.wholesale_price) / rate).toFixed(2)) : ''));
    const mUzs = line?.minimum_sale_price || String(product?.minimum_sale_price != null ? product.minimum_sale_price : '');
    const mUsd = line?.minimum_sale_price_usd !== undefined && line?.minimum_sale_price_usd !== '' ? line.minimum_sale_price_usd : (product?.minimum_sale_price_usd != null ? Number(product.minimum_sale_price_usd) : (product?.minimum_sale_price && rate ? Number((Number(product.minimum_sale_price) / rate).toFixed(2)) : ''));
    const cUzs = line?.unit_cost || String(product?.cost_price != null ? product.cost_price : '');
    const cUsd = line?.unit_cost_usd !== undefined && line?.unit_cost_usd !== '' ? line.unit_cost_usd : (product?.cost_price_usd != null ? Number(product.cost_price_usd) : (product?.cost_price && rate ? Number((Number(product.cost_price) / rate).toFixed(2)) : ''));

    setLine(i, {
      priceConfirmed: true,
      currency: line?.currency || product?.currency || form.currency || 'USD',
      retail_price: rUzs,
      retail_price_usd: rUsd,
      wholesale_price: wUzs,
      wholesale_price_usd: wUsd,
      minimum_sale_price: mUzs,
      minimum_sale_price_usd: mUsd,
      unit_cost: cUzs,
      unit_cost_usd: cUsd
    });
  };

  const handleCreateCurrencyChange = (newCurrency) => {
    const prevCurrency = form.currency || 'USD';
    if (newCurrency === prevCurrency) return;
    setForm(f => ({ ...f, currency: newCurrency }));
    setLines(prevLines => prevLines.map(line => ({ ...line, currency: newCurrency })));
  };

  const submit=async e=>{
    e.preventDefault();
    let supplierId = isInventory ? (form.supplier_id || null) : form.supplier_id;
    if(!isInventory && !supplierId){setError('Ta\'minotchini tanlang');return}
    if(!form.receiving_location_id){setError('Qabul joyini tanlang');return}
    if(lines.some(x=>!x.product_id)){setError('Barcha qatorlarda mahsulot tanlang');return}
    
    // Validatsiya
    for(let idx=0; idx<lines.length; idx++){
      const x = lines[idx];
      if(Number(x.quantity) < 1){
        setError(`${idx+1}-qatordagi mahsulot miqdorini kiriting`);
        return;
      }
    }

    // Ranglar tekshiruvi: agar bir xil mahsulot 2 yoki undan ortiq qatorda bo'lsa, har biriga rang kiritilgan bo'lishi kerak
    const prodCounts = {};
    for (const l of lines) {
      if (l.product_id) prodCounts[l.product_id] = (prodCounts[l.product_id] || 0) + 1;
    }
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      if (l.product_id && prodCounts[l.product_id] > 1 && !l.color_name?.trim()) {
        setError(`${idx + 1}-qatordagi tovar uchun rang nomini kiriting (masalan: Oq yoki Qora)`);
        return;
      }
    }

    setBusy(true);
    setError('');
    try{
      const payloadLines = [];

      for(const line of lines){
        const product = refs.products.find(p=>p.id===line.product_id);
        const lineCurrency = line.currency || product?.currency || form.currency || 'USD';
        const isLineUsd = lineCurrency === 'USD';

        let baseCost = Number(line.unit_cost) || 0;
        let baseRetail = Number(line.retail_price) || Number(product?.retail_price) || 0;
        let baseWholesale = Number(line.wholesale_price) || Number(product?.wholesale_price) || 0;
        let baseMin = Number(line.minimum_sale_price) || Number(product?.minimum_sale_price) || 0;

        let baseCostUsd = line.unit_cost_usd !== undefined && line.unit_cost_usd !== '' && line.unit_cost_usd !== null 
          ? Number(line.unit_cost_usd) 
          : null;
        let baseRetailUsd = line.retail_price_usd !== undefined && line.retail_price_usd !== '' && line.retail_price_usd !== null
          ? Number(line.retail_price_usd)
          : null;
        let baseWholesaleUsd = line.wholesale_price_usd !== undefined && line.wholesale_price_usd !== '' && line.wholesale_price_usd !== null
          ? Number(line.wholesale_price_usd)
          : null;
        let baseMinUsd = line.minimum_sale_price_usd !== undefined && line.minimum_sale_price_usd !== '' && line.minimum_sale_price_usd !== null
          ? Number(line.minimum_sale_price_usd)
          : null;

        if (isLineUsd) {
          if (baseCostUsd == null && baseCost > 0) {
            baseCostUsd = baseCost < 20000 ? baseCost : (rate ? Number((baseCost / rate).toFixed(2)) : baseCost);
          }
          if (baseRetailUsd == null && baseRetail > 0) {
            baseRetailUsd = baseRetail < 20000 ? baseRetail : (rate ? Number((baseRetail / rate).toFixed(2)) : baseRetail);
          }
          if (baseWholesaleUsd == null && baseWholesale > 0) {
            baseWholesaleUsd = baseWholesale < 20000 ? baseWholesale : (rate ? Number((baseWholesale / rate).toFixed(2)) : baseWholesale);
          }
          if (baseMinUsd == null && baseMin > 0) {
            baseMinUsd = baseMin < 20000 ? baseMin : (rate ? Number((baseMin / rate).toFixed(2)) : baseMin);
          }
          if (rate && baseCostUsd != null && baseCostUsd > 0) baseCost = Math.round(baseCostUsd * rate);
          if (rate && baseRetailUsd != null && baseRetailUsd > 0) baseRetail = Math.round(baseRetailUsd * rate);
          if (rate && baseWholesaleUsd != null && baseWholesaleUsd > 0) baseWholesale = Math.round(baseWholesaleUsd * rate);
          if (rate && baseMinUsd != null && baseMinUsd > 0) baseMin = Math.round(baseMinUsd * rate);
        } else {
          // UZS konstanta: so'm narxini aynan saqlaymiz, faqat USD ekvivalentini hisoblaymiz
          baseCost = Math.round(baseCost);
          baseRetail = Math.round(baseRetail);
          baseWholesale = Math.round(baseWholesale);
          baseMin = Math.round(baseMin);

          if (rate && baseCost > 0) baseCostUsd = Number((baseCost / rate).toFixed(2));
          if (rate && baseRetail > 0) baseRetailUsd = Number((baseRetail / rate).toFixed(2));
          if (rate && baseWholesale > 0) baseWholesaleUsd = Number((baseWholesale / rate).toFixed(2));
          if (rate && baseMin > 0) baseMinUsd = Number((baseMin / rate).toFixed(2));
        }

        let variantId = line.variant_id || null;
        const colorName = (line.color_name || '').trim();

        if(colorName){
          const existingVar = (line.variants || []).find(v => v.color_name?.trim().toLowerCase() === colorName.toLowerCase());
          if(existingVar && existingVar.id && !String(existingVar.id).startsWith('temp_')){
            variantId = existingVar.id;
          } else {
            try{
              const { data: dbVars } = await getBrowserClient()
                .from('product_variants')
                .select('id, color_name')
                .eq('product_id', line.product_id);
              const foundInDb = (dbVars || []).find(v => v.color_name?.trim().toLowerCase() === colorName.toLowerCase());
              if(foundInDb){
                variantId = foundInDb.id;
              } else {
                const { data: newVar } = await getBrowserClient()
                  .from('product_variants')
                  .insert({
                    product_id: line.product_id,
                    color_name: colorName,
                    cost_price: baseCost || null,
                    cost_price_usd: baseCostUsd || null,
                    retail_price: baseRetail || null,
                    retail_price_usd: baseRetailUsd || null,
                    wholesale_price: baseWholesale || null,
                    wholesale_price_usd: baseWholesaleUsd || null,
                    minimum_sale_price: baseMin || null,
                    minimum_sale_price_usd: baseMinUsd || null,
                    is_active: true
                  })
                  .select('id')
                  .single();
                if(newVar?.id){
                  variantId = newVar.id;
                }
              }
            }catch(varErr){
              console.warn('Variant resolution error:', varErr);
            }
          }
        }

        // Agar ushbu qator/rang uchun rasm yuklangan bo'lsa, variantga bog'lab saqlaymiz
        if (Array.isArray(line.variantImageFiles) && line.variantImageFiles.length > 0) {
          for (const file of line.variantImageFiles) {
            try {
              const label = colorName
                ? `${product?.name || 'Mahsulot'} (${colorName})`
                : (product?.name || 'Mahsulot');
              await uploadProductMedia(line.product_id, file, label, variantId || null);
            } catch (vImgErr) {
              console.warn('Rang rasmini yuklashda xatolik:', vImgErr);
            }
          }
        }

        const serials = (line.serials || '').split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean);
        const shouldOverridePrice = line.priceConfirmed || isInventory || Boolean(line.retail_price && Number(line.retail_price) > 0) || Boolean(line.retail_price_usd && Number(line.retail_price_usd) > 0);
        const priceOverride = shouldOverridePrice && (baseRetail > 0 || (baseRetailUsd && baseRetailUsd > 0)) ? {
          retail_price: baseRetail,
          retail_price_usd: baseRetailUsd,
          wholesale_price: baseWholesale,
          wholesale_price_usd: baseWholesaleUsd,
          minimum_sale_price: baseMin,
          minimum_sale_price_usd: baseMinUsd
        } : {};

        payloadLines.push({
          product_id: line.product_id,
          variant_id: variantId || null,
          currency: lineCurrency,
          quantity: Number(line.quantity) || 1,
          unit_cost: baseCost,
          unit_cost_usd: baseCostUsd,
          serial_numbers: serials,
          ...priceOverride
        });
      }

      // Agar qatorlardagi tovarlar modulli / tarkibiy qismlarga ega bo'lsa, ularni saqlaymiz
      const savedCompProductIds = new Set();
      for (const line of lines) {
        if (!line.product_id || savedCompProductIds.has(line.product_id)) continue;
        savedCompProductIds.add(line.product_id);

        if (Array.isArray(line.components)) {
          try {
            const compsPayload = [];
            for (let cIdx = 0; cIdx < line.components.length; cIdx++) {
              const c = line.components[cIdx];
              let cImageUrl = c.image_url || null;
              if (c.imageFile) {
                try {
                  const product = refs.products.find(p => p.id === line.product_id);
                  const compLabel = `${product?.name || 'Mahsulot'} qismi: ${c.name || 'Qism'}`;
                  const uploadRes = await uploadProductMedia(line.product_id, c.imageFile, compLabel, null);
                  if (uploadRes?.publicUrl || uploadRes?.url) {
                    cImageUrl = uploadRes.publicUrl || uploadRes.url;
                  }
                } catch (cImgErr) {
                  console.warn('Modul qismi rasmini yuklashda xatolik:', cImgErr);
                }
              }

              let cCost = Number(c.cost_price) || 0;
              let cRetail = Number(c.retail_price) || 0;
              let cWholesale = Number(c.wholesale_price) || 0;
              let cCostUsd = c.cost_price_usd !== undefined && c.cost_price_usd !== '' && c.cost_price_usd !== null ? Number(c.cost_price_usd) : null;
              let cRetailUsd = c.retail_price_usd !== undefined && c.retail_price_usd !== '' && c.retail_price_usd !== null ? Number(c.retail_price_usd) : null;
              let cWholesaleUsd = c.wholesale_price_usd !== undefined && c.wholesale_price_usd !== '' && c.wholesale_price_usd !== null ? Number(c.wholesale_price_usd) : null;

              if (line.currency === 'USD') {
                if (cCostUsd == null && cCost > 0) cCostUsd = cCost < 20000 ? cCost : (rate ? Number((cCost / rate).toFixed(2)) : cCost);
                if (cRetailUsd == null && cRetail > 0) cRetailUsd = cRetail < 20000 ? cRetail : (rate ? Number((cRetail / rate).toFixed(2)) : cRetail);
                if (cWholesaleUsd == null && cWholesale > 0) cWholesaleUsd = cWholesale < 20000 ? cWholesale : (rate ? Number((cWholesale / rate).toFixed(2)) : cWholesale);
                if (rate && cCostUsd != null && cCostUsd > 0) cCost = Math.round(cCostUsd * rate);
                if (rate && cRetailUsd != null && cRetailUsd > 0) cRetail = Math.round(cRetailUsd * rate);
                if (rate && cWholesaleUsd != null && cWholesaleUsd > 0) cWholesale = Math.round(cWholesaleUsd * rate);
              } else {
                cCost = Math.round(cCost);
                cRetail = Math.round(cRetail);
                cWholesale = Math.round(cWholesale);
                if (rate && cCost > 0 && cCostUsd == null) cCostUsd = Number((cCost / rate).toFixed(2));
                if (rate && cRetail > 0 && cRetailUsd == null) cRetailUsd = Number((cRetail / rate).toFixed(2));
                if (rate && cWholesale > 0 && cWholesaleUsd == null) cWholesaleUsd = Number((cWholesale / rate).toFixed(2));
              }

              compsPayload.push({
                ...(c.id && !String(c.id).startsWith('temp_') ? { id: c.id } : {}),
                name: c.name?.trim() || `Qism ${cIdx + 1}`,
                color_name: c.color_name || null,
                color_hex: c.color_hex || null,
                quantity: Math.max(1, Number(c.quantity) || 1),
                cost_price: cCost,
                cost_price_usd: cCostUsd,
                retail_price: cRetail,
                retail_price_usd: cRetailUsd,
                wholesale_price: cWholesale,
                wholesale_price_usd: cWholesaleUsd,
                is_default: c.is_default !== false,
                is_required: Boolean(c.is_required),
                can_buy_standalone: c.can_buy_standalone !== false,
                sort_order: cIdx,
                image_url: cImageUrl
              });
            }
            if (compsPayload.length > 0) {
              await saveProductComponents(line.product_id, compsPayload);
            }
          } catch (compErr) {
            console.warn('Inventarizatsiyada qismlarni saqlash xatoligi:', compErr);
          }
        }
      }

      if (isInventory && form.receiving_location_id) {
        try {
          localStorage.setItem('tb_last_inventory_loc_' + branchId, form.receiving_location_id);
          localStorage.setItem('tb_last_inventory_loc', form.receiving_location_id);
        } catch {}
      }

      const createdRes = await createStockReceipt({
        ...form,
        currency: form.currency || 'USD',
        exchange_rate: rate || 12800,
        supplier_id: isInventory ? (supplierId || null) : supplierId,
        branch_id: branchId,
        received_at: new Date(`${form.received_at}T12:00:00`).toISOString(),
        paid_amount: isInventory ? 0 : (Number(form.paid_amount) || 0)
      }, payloadLines);

      try { localStorage.removeItem(draftKey); } catch {}
      setDraftRestored(false);
      setLines([{
        product_id:'',color_name:'',variant_id:'',quantity:1,unit_cost:'',unit_cost_usd:'',serials:'',retail_price:'',retail_price_usd:'',wholesale_price:'',wholesale_price_usd:'',minimum_sale_price:'',minimum_sale_price_usd:'',priceConfirmed:false,variants:[],variantConfigs:{},variantImageFiles:[],components:[]
      }]);
      const nextRno = makeUniqueReceiptNo(isInventory);
      setForm(f => ({
        ...f,
        receipt_no: nextRno,
        invoice_number: '',
        paid_amount: '',
        notes: isInventory ? 'Do‘konda/skladda mavjud tovarlar inventarizatsiyasi' : ''
      }));
      await created(createdRes);
    }catch(e){
      setError(err(e));
    }finally{
      setBusy(false);
    }
  };

  const onProductCreatedFromForm=async(newProdForm,images=[],variants=[],components=[])=>{
    const client=getBrowserClient();
    const slug=newProdForm.name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+Date.now().toString(36);
    const prodCurrency = newProdForm.currency || (newProdForm.cost_price_usd && Number(newProdForm.cost_price_usd) > 0 ? 'USD' : (newProdForm.retail_price_usd && Number(newProdForm.retail_price_usd) > 0 ? 'USD' : (form.currency || 'USD')));
    const{data,error:insertErr}=await client.from('products').insert({
      name:newProdForm.name.trim(),
      sku:newProdForm.sku?.trim().toUpperCase()||('TB-'+Date.now().toString(36).toUpperCase()),
      slug,
      category_id:newProdForm.category_id||null,
      brand_id:newProdForm.brand_id||null,
      cost_price:Number(newProdForm.cost_price)||0,
      cost_price_usd:newProdForm.cost_price_usd!=null?Number(newProdForm.cost_price_usd):(rate&&newProdForm.cost_price?Number((Number(newProdForm.cost_price)/rate).toFixed(2)):null),
      retail_price:Number(newProdForm.retail_price)||0,
      retail_price_usd:newProdForm.retail_price_usd!=null?Number(newProdForm.retail_price_usd):(rate&&newProdForm.retail_price?Number((Number(newProdForm.retail_price)/rate).toFixed(2)):null),
      wholesale_price:Number(newProdForm.wholesale_price)||null,
      wholesale_price_usd:newProdForm.wholesale_price_usd!=null?Number(newProdForm.wholesale_price_usd):(rate&&newProdForm.wholesale_price?Number((Number(newProdForm.wholesale_price)/rate).toFixed(2)):null),
      minimum_sale_price:Number(newProdForm.minimum_sale_price)||0,
      minimum_sale_price_usd:newProdForm.minimum_sale_price_usd!=null?Number(newProdForm.minimum_sale_price_usd):(rate&&newProdForm.minimum_sale_price?Number((Number(newProdForm.minimum_sale_price)/rate).toFixed(2)):null),
      status:'active',
      currency:prodCurrency,
      is_published:true,
      track_individual_units:true,
      tax_rate:0,
      description:newProdForm.description||null
    }).select('id,name,sku,cost_price,retail_price,wholesale_price,minimum_sale_price,cost_price_usd,retail_price_usd,wholesale_price_usd,minimum_sale_price_usd,currency').single();
    if(insertErr)throw insertErr;
    let primaryUrl=null;
    for(const file of images){
      try{
        const uploaded = await uploadProductMedia(data.id,file,newProdForm.name.trim());
        if(!primaryUrl && (uploaded?.publicUrl || uploaded?.url)){
          primaryUrl = uploaded.publicUrl || uploaded.url;
        }
      }catch(imgErr){
        console.warn('Image upload error:', imgErr);
      }
    }
    if(primaryUrl){
      data.image = primaryUrl;
      data.seo_image_url = primaryUrl;
      try{
        await client.from('products').update({ seo_image_url: primaryUrl }).eq('id', data.id);
      }catch{}
    }
    const namedVariants=(variants||[]).filter(v=>v.color_name?.trim());
    if(namedVariants.length){
      try{
        const variantsPayload=namedVariants.map(v=>({
          color_name:v.color_name.trim(),
          color_hex:v.color_hex||null,
          cost_price:v.cost_price===''||v.cost_price==null?null:Number(v.cost_price),
          cost_price_usd:v.cost_price_usd===''||v.cost_price_usd==null?null:Number(v.cost_price_usd),
          retail_price:v.retail_price===''||v.retail_price==null?null:Number(v.retail_price),
          retail_price_usd:v.retail_price_usd===''||v.retail_price_usd==null?null:Number(v.retail_price_usd),
          wholesale_price:v.wholesale_price===''||v.wholesale_price==null?null:Number(v.wholesale_price),
          wholesale_price_usd:v.wholesale_price_usd===''||v.wholesale_price_usd==null?null:Number(v.wholesale_price_usd),
          is_active:true
        }));
        const{saveProductVariants}=await import('@texnobazar/data');
        const createdVariants=await saveProductVariants(data.id,variantsPayload);
        data.variants=createdVariants;
        for (let i = 0; i < createdVariants.length && i < namedVariants.length; i++) {
          for (const file of namedVariants[i].imageFiles || []) {
            try {
              await uploadProductMedia(data.id, file, `${newProdForm.name.trim()} (${namedVariants[i].color_name})`, createdVariants[i].id);
            } catch (vImgErr) {
              console.warn('Inline new variant image upload error:', vImgErr);
            }
          }
        }

        // Retroaktiv bog'lash: agar tovarning eski variant_id=NULL bo'lgan birliklari
        // yoki partiyalari bo'lsa, ularni 1-variant (asosiy rang)ga biriktiramiz
        if (createdVariants && createdVariants.length > 0 && createdVariants[0]?.id) {
          const firstVarId = createdVariants[0].id;
          try {
            await client.from('inventory_units').update({ variant_id: firstVarId }).eq('product_id', data.id).is('variant_id', null);
            await client.from('stock_batches').update({ variant_id: firstVarId }).eq('product_id', data.id).is('variant_id', null);
            await client.from('order_lines').update({
              variant_id: firstVarId,
              variant_color: createdVariants[0].color_name
            }).eq('product_id', data.id).is('variant_id', null);
          } catch (syncErr) {
            console.warn('Orphan stock sync notice:', syncErr);
          }
        }
      }catch{}
    }
    if (Array.isArray(components) && components.length > 0) {
      try {
        const compsPayload = [];
        for (let cIdx = 0; cIdx < components.length; cIdx++) {
          const c = components[cIdx];
          let cImageUrl = c.image_url || null;
          if (c.imageFile) {
            try {
              const compLabel = `${newProdForm.name.trim()} qismi: ${c.name || 'Qism'}`;
              const uploadRes = await uploadProductMedia(data.id, c.imageFile, compLabel, null);
              if (uploadRes?.publicUrl || uploadRes?.url) {
                cImageUrl = uploadRes.publicUrl || uploadRes.url;
              }
            } catch (cImgErr) {
              console.warn('Inline new component image upload error:', cImgErr);
            }
          }
          compsPayload.push({
            name: c.name?.trim() || `Qism ${cIdx + 1}`,
            color_name: c.color_name || null,
            color_hex: c.color_hex || null,
            quantity: Math.max(1, Number(c.quantity) || 1),
            cost_price: Number(c.cost_price) || 0,
            cost_price_usd: c.cost_price_usd !== undefined && c.cost_price_usd !== '' && c.cost_price_usd !== null ? Number(c.cost_price_usd) : null,
            retail_price: Number(c.retail_price) || 0,
            retail_price_usd: c.retail_price_usd !== undefined && c.retail_price_usd !== '' && c.retail_price_usd !== null ? Number(c.retail_price_usd) : null,
            wholesale_price: Number(c.wholesale_price) || 0,
            wholesale_price_usd: c.wholesale_price_usd !== undefined && c.wholesale_price_usd !== '' && c.wholesale_price_usd !== null ? Number(c.wholesale_price_usd) : null,
            is_default: c.is_default !== false,
            is_required: Boolean(c.is_required),
            can_buy_standalone: c.can_buy_standalone !== false,
            sort_order: cIdx,
            image_url: cImageUrl
          });
        }
        await saveProductComponents(data.id, compsPayload);
      } catch (compErr) {
        console.warn('Inline new product components save error:', compErr);
      }
    }
    setRefs(prev=>({...prev,products:[...prev.products,data]}));
    setShowCreateProduct(false);
    const targetIdx = createForLineIdx;
    setCreateForLineIdx(null);
    toast?.('Yangi tovar muvaffaqiyatli saqlandi va ro‘yxatga qo‘shildi');
    if(targetIdx!==null){
      handleProductSelect(targetIdx, data.id, data);
    }
  };

  const createSupplier=async()=>{
    if(!newSupplierName.trim())return;
    setNewSupplierBusy(true);
    try{
      const{data,error:e}=await getBrowserClient().rpc('create_supplier_quick',{p_name:newSupplierName.trim()});
      if(e)throw e;
      setRefs(prev=>({...prev,suppliers:[...prev.suppliers,data]}));
      setForm(f=>({...f,supplier_id:data.id}));
      setShowCreateSupplier(false);setNewSupplierName('');
    }catch(e){setError(err(e))}finally{setNewSupplierBusy(false)}
  };

  const totalUnitsCount = lines.reduce((sum, line) => {
    return sum + (Number(line.quantity) || 0);
  }, 0);

  const handleClose = () => {
    const hasContent = lines.some(l => l.product_id || (l.quantity && l.quantity > 1) || l.unit_cost || l.retail_price || l.serials);
    if (hasContent) {
      if (window.confirm('Kiritilgan ma’lumotlar qoralama sifatida saqlanib qoladi. Oynani yopasizmi?')) {
        close();
      }
    } else {
      close();
    }
  };

  return <Modal open={open} onClose={handleClose} wide title={isInventory ? "Inventarizatsiya — mavjud tovarlarni kiritish" : "Yangi partiya qabul qilish"}>
    <form className="receipt-form" onSubmit={submit}>
      {draftRestored && (
        <div style={{
          background: '#eff6ff',
          border: '1px solid #bfdbfe',
          borderRadius: 10,
          padding: '10px 14px',
          marginBottom: 14,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          fontSize: 13,
          color: '#1e40af'
        }}>
          <span>ℹ️ Avval kiritilgan inventarizatsiya qoralamasi tiklandi.</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ fontSize: 12, color: '#dc2626', cursor: 'pointer', padding: '3px 8px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff' }}
            onClick={() => {
              if (window.confirm('Qoralamani tozalab, bo‘sh shakl ochilsinmi?')) {
                try { localStorage.removeItem(draftKey); } catch {}
                setDraftRestored(false);
                setLines([{
                  product_id:'',color_name:'',variant_id:'',quantity:1,currency:isInventory?'UZS':'USD',unit_cost:'',unit_cost_usd:'',serials:'',retail_price:'',retail_price_usd:'',wholesale_price:'',wholesale_price_usd:'',minimum_sale_price:'',minimum_sale_price_usd:'',priceConfirmed:false,variants:[],variantConfigs:{},variantImageFiles:[],components:[]
                }]);
              }
            }}
          >
            Qoralamani tozalash
          </button>
        </div>
      )}
      {error&&<div className="employee-error">{error}</div>}
      <div className="receipt-form-grid">
        <label>
          <span>{isInventory ? 'Hujjat raqami' : 'Partiya raqami'}</span>
          <input className="input" value={form.receipt_no} onChange={e=>setForm({...form,receipt_no:e.target.value.toUpperCase()})} required placeholder="PT-... yoki INV-..."/>
        </label>
        
        {isInventory ? (
          <label>
            <span>Ro‘yxat turi</span>
            <div style={{padding:'9px 12px',background:'#f5f3ff',borderRadius:10,border:'1px solid #ddd6fe',color:'#6d28d9',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:6}}>
              <Boxes size={16}/> Skladdagi/do‘kondagi mavjud tovarlar (Ichki inventarizatsiya)
            </div>
          </label>
        ) : (
          <label>
            <span>Ta'minotchi *</span>
            {showCreateSupplier ? (
              <div style={{display:'flex',gap:6}}>
                <input className="input" value={newSupplierName} onChange={e=>setNewSupplierName(e.target.value)} placeholder="Yangi ta'minotchi nomi" autoFocus/>
                <button type="button" className="btn btn-primary" style={{whiteSpace:'nowrap',padding:'0 10px'}} onClick={createSupplier} disabled={newSupplierBusy}>{newSupplierBusy?'...':'OK'}</button>
                <button type="button" className="btn" style={{padding:'0 8px'}} onClick={()=>setShowCreateSupplier(false)}><X size={14}/></button>
              </div>
            ) : (
              <div style={{display:'flex',gap:6}}>
                <select className="select" value={form.supplier_id} onChange={e=>setForm({...form,supplier_id:e.target.value})} required style={{flex:1}}>
                  {refs.suppliers.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button type="button" className="btn" style={{padding:'0 10px',whiteSpace:'nowrap',fontSize:11}} onClick={()=>setShowCreateSupplier(true)}><Plus size={13}/>Yangi</button>
              </div>
            )}
          </label>
        )}

        <label>
          <span>Qabul joylashuvi *</span>
          <select
            className="select"
            value={form.receiving_location_id}
            onChange={e => {
              const locId = e.target.value;
              setForm(f => ({ ...f, receiving_location_id: locId }));
              if (isInventory && locId) {
                try {
                  localStorage.setItem('tb_last_inventory_loc_' + branchId, locId);
                  localStorage.setItem('tb_last_inventory_loc', locId);
                } catch {}
              }
            }}
            required
          >
            {refs.locations.map(x => (
              <option key={x.id} value={x.id}>
                {x.name} {x.type === 'warehouse' ? '(Ombor)' : '(Do‘kon)'}
              </option>
            ))}
          </select>
        </label>

        {!isInventory && <label><span>Invoice / Hisob raqami</span><input className="input" value={form.invoice_number} onChange={e=>setForm({...form,invoice_number:e.target.value})} placeholder="Ixtiyoriy"/></label>}
        
        <label>
          <span>Qabul sanasi</span>
          <input className="input" type="date" value={form.received_at} onChange={e=>setForm({...form,received_at:e.target.value})} required/>
        </label>

        <label>
          <span>Valyuta</span>
          <select className="select" value={form.currency} onChange={e=>handleCreateCurrencyChange(e.target.value)}>
            <option>USD</option>
            <option>UZS</option>
            <option>EUR</option>
          </select>
        </label>

        {!isInventory && (
          <>
            <label>
              <span>To'lov holati</span>
              <select className="select" value={form.payment_status} onChange={e=>setForm({...form,payment_status:e.target.value})}>
                <option value="paid">To'langan</option>
                <option value="partial">Qisman</option>
                <option value="unpaid">To'lanmagan</option>
              </select>
            </label>
            {form.payment_status==='partial'&&<label><span>To'langan summa ({form.currency})</span><input className="input" type="number" min="0" step="0.01" value={form.paid_amount} onChange={e=>setForm({...form,paid_amount:e.target.value})} placeholder="Summa"/></label>}
          </>
        )}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:14}}>
        <h3 style={{margin:0,fontSize:16}}>Mahsulot qatorlari</h3>
        <span style={{fontSize:12,color:'var(--muted)'}}>Har bir tovar rangi uchun 1 ta umumiy QR kod beriladi</span>
      </div>

      {lines.map((line,i)=>(
        <ReceiptProductLine
          key={i}
          line={line}
          index={i}
          totalLines={lines.length}
          products={refs.products}
          setLine={setLine}
          removeLine={lines.length>1?()=>setLines(lines.filter((_,j)=>j!==i)):null}
          onSelect={handleProductSelect}
          confirmPrice={confirmPrice}
          openCreateProduct={()=>{setCreateForLineIdx(i);setShowCreateProduct(true)}}
          rate={rate}
          currency={form.currency || 'USD'}
        />
      ))}

      {/* Rang yoki yangi tovar qo'shish tugmalari - tartibli va aniq joylashuv */}
      <div style={{display:'flex',flexDirection:'column',gap:8,marginTop:6}}>
        <button
          type="button"
          className="btn"
          style={{
            borderColor:'#0284c7',
            color:'#0284c7',
            background:'#f0f9ff',
            fontWeight:700,
            justifyContent:'center',
            padding:'10px 16px',
            fontSize:13,
            borderRadius:10
          }}
          onClick={handleAddColorToLastProduct}
        >
          <Plus size={16}/> Shu tovarni boshqa rangini qo'shish
        </button>

        <button
          type="button"
          className="btn btn-outline"
          style={{
            justifyContent:'center',
            padding:'10px 16px',
            fontSize:13,
            borderRadius:10
          }}
          onClick={handleAddNewProductLine}
        >
          <Plus size={16}/> Boshqa tovar qo'shish
        </button>
      </div>

      <div className="qr-summary" style={{background:isInventory?'#f5f3ff':'#fff7ed',borderColor:isInventory?'#ddd6fe':'#fdba74'}}>
        <QrCode size={26} color={isInventory?'#7c3aed':'var(--orange)'}/>
        <div style={{flex:1}}>
          <b style={{fontSize:14}}>
            Jami: {totalUnitsCount} dona mahsulot ({lines.filter(l=>l.product_id).length} xil tovar/rang turi)
          </b>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:6}}>
            {lines.filter(l=>l.product_id).map((l, idx)=>{
              const p = refs.products.find(prod=>prod.id===l.product_id);
              return (
                <span key={idx} style={{padding:'3px 8px',borderRadius:6,background:'#fff',border:'1px solid rgba(0,0,0,0.1)',fontSize:11,fontWeight:600}}>
                  #{idx+1} {p?.name?.slice(0, 22)}... {l.color_name ? `(${l.color_name})` : ''}: <b>{l.quantity || 0} dona</b>
                </span>
              );
            })}
          </div>
          <span style={{display:'block',fontSize:12,color:'var(--muted)',marginTop:4}}>
            Partiya saqlangach, har bir tovar (va uning rangi) uchun alohida umumiy QR kod yaratiladi va narx yorlig‘ida chop etiladi.
          </span>
        </div>
      </div>

      <button className="btn btn-primary btn-block" disabled={busy} style={isInventory?{background:'#7c3aed',borderColor:'#7c3aed'}:{}}>
        {busy ? 'Saqlanmoqda…' : isInventory ? 'Inventarizatsiyani saqlash va QR kodlar yaratish' : 'Partiyani qabul qilish va QR kodlar yaratish'}
      </button>
    </form>

    {showCreateProduct&&<div className="receipt-create-overlay"><div className="receipt-create-form card"><CreateProductInline categories={refs.categories||[]} brands={refs.brands||[]} categoryId="" onCreated={onProductCreatedFromForm} onCancel={()=>{setShowCreateProduct(false);setCreateForLineIdx(null)}} rate={rate} onCategoryCreated={cat => setRefs(prev => ({ ...prev, categories: [...(prev.categories || []).filter(c => c.id !== cat.id), cat] }))} onBrandCreated={b => setRefs(prev => ({ ...prev, brands: [...(prev.brands || []).filter(x => x.id !== b.id), b] }))}/></div></div>}
  </Modal>;
}

function CurrencyNumberInput({
  valueUzs,
  onChangeUzs,
  valueUsd,
  onChangeUsd,
  currency = 'USD',
  baseCurrency,
  onBaseCurrencyChange,
  rate,
  placeholder,
  className = 'input',
  style,
  required = false,
  min = 0,
  step = '0.01'
}) {
  const [text, setText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const userTypedRef = useRef(false);

  useEffect(() => {
    if (isFocused) return;
    userTypedRef.current = false;
    const effectiveBase = baseCurrency || (currency === 'UZS' ? 'UZS' : 'USD');

    if (currency === 'USD') {
      if (effectiveBase === 'USD') {
        if (valueUsd !== undefined && valueUsd !== '' && valueUsd !== null) {
          const num = Number(valueUsd);
          setText(isNaN(num) || num === 0 ? '' : String(num));
          return;
        }
      }
      if (valueUzs !== '' && valueUzs !== null && valueUzs !== undefined) {
        const num = Number(valueUzs);
        if (!isNaN(num) && num > 0 && rate) {
          setText(Number((num / rate).toFixed(2)).toString());
          return;
        }
      }
      if (valueUsd !== undefined && valueUsd !== '' && valueUsd !== null) {
        const num = Number(valueUsd);
        setText(isNaN(num) || num === 0 ? '' : String(num));
        return;
      }
      setText('');
    } else {
      if (effectiveBase === 'UZS') {
        if (valueUzs !== '' && valueUzs !== null && valueUzs !== undefined) {
          const num = Number(valueUzs);
          setText(isNaN(num) || num === 0 ? '' : String(num));
          return;
        }
      }
      if (valueUsd !== undefined && valueUsd !== '' && valueUsd !== null) {
        const num = Number(valueUsd);
        if (!isNaN(num) && num > 0 && rate) {
          setText(String(Math.round(num * rate)));
          return;
        }
      }
      if (valueUzs !== '' && valueUzs !== null && valueUzs !== undefined) {
        const num = Number(valueUzs);
        setText(isNaN(num) || num === 0 ? '' : String(num));
        return;
      }
      setText('');
    }
  }, [valueUzs, valueUsd, currency, baseCurrency, rate, isFocused]);

  const handleChange = (e) => {
    userTypedRef.current = true;
    const val = e.target.value;
    setText(val);
    if (val.trim() === '') {
      onChangeUzs?.('');
      onChangeUsd?.('');
      return;
    }
    const clean = val.replace(',', '.');
    const num = parseFloat(clean);
    if (!isNaN(num)) {
      if (currency === 'USD') {
        onBaseCurrencyChange?.('USD');
        onChangeUsd?.(num);
        const derivedUzs = rate ? Math.round(num * rate) : Math.round(num);
        onChangeUzs?.(String(derivedUzs));
      } else {
        onBaseCurrencyChange?.('UZS');
        onChangeUzs?.(String(Math.round(num)));
        if (rate) {
          onChangeUsd?.(Number((num / rate).toFixed(2)));
        }
      }
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (!userTypedRef.current) {
      return;
    }
    userTypedRef.current = false;
    if (text.trim() === '') {
      onChangeUzs?.('');
      onChangeUsd?.('');
      return;
    }
    const clean = text.replace(',', '.');
    const num = parseFloat(clean);
    if (!isNaN(num) && num > 0) {
      if (currency === 'USD') {
        setText(Number(num.toFixed(2)).toString());
        onBaseCurrencyChange?.('USD');
        onChangeUsd?.(num);
        if (rate) onChangeUzs?.(String(Math.round(num * rate)));
      } else {
        setText(String(Math.round(num)));
        onBaseCurrencyChange?.('UZS');
        onChangeUzs?.(String(Math.round(num)));
        if (rate) onChangeUsd?.(Number((num / rate).toFixed(2)));
      }
    } else {
      setText('');
      onChangeUzs?.('');
      onChangeUsd?.('');
    }
  };

  return (
    <input
      className={className}
      style={style}
      type="number"
      min={min}
      step={currency === 'USD' ? '0.01' : '1'}
      value={text}
      onChange={handleChange}
      onFocus={() => setIsFocused(true)}
      onBlur={handleBlur}
      placeholder={placeholder || (currency === 'USD' ? '0.00' : '0')}
      required={required}
    />
  );
}

function normalizeSearchText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['‘’ʻʼ`]/g, '')
    .replace(/а/g, 'a').replace(/б/g, 'b').replace(/в/g, 'v').replace(/г/g, 'g')
    .replace(/д/g, 'd').replace(/е/g, 'e').replace(/ё/g, 'yo').replace(/ж/g, 'j')
    .replace(/з/g, 'z').replace(/и/g, 'i').replace(/й/g, 'y').replace(/к/g, 'k')
    .replace(/л/g, 'l').replace(/м/g, 'm').replace(/н/g, 'n').replace(/о/g, 'o')
    .replace(/п/g, 'p').replace(/р/g, 'r').replace(/с/g, 's').replace(/т/g, 't')
    .replace(/у/g, 'u').replace(/ф/g, 'f').replace(/х/g, 'x').replace(/ц/g, 'ts')
    .replace(/ч/g, 'ch').replace(/ш/g, 'sh').replace(/щ/g, 'sh').replace(/ъ/g, '')
    .replace(/ы/g, 'i').replace(/ь/g, '').replace(/э/g, 'e').replace(/ю/g, 'yu')
    .replace(/я/g, 'ya').replace(/ў/g, 'o').replace(/қ/g, 'q').replace(/ғ/g, 'g').replace(/ҳ/g, 'h')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatchProduct(product, rawQuery) {
  if (!rawQuery || !rawQuery.trim()) return true;
  const qClean = normalizeSearchText(rawQuery);
  if (!qClean) return true;

  const nameClean = normalizeSearchText(product.name);
  const skuClean = normalizeSearchText(product.sku);

  // 1. Direct normalized substring
  if (nameClean.includes(qClean) || skuClean.includes(qClean)) return true;

  // 2. Direct raw lowercase substring (handles partial and exact casing)
  const rawQ = rawQuery.trim().toLowerCase();
  const rawName = String(product.name || '').toLowerCase();
  const rawSku = String(product.sku || '').toLowerCase();
  if (rawName.includes(rawQ) || rawSku.includes(rawQ)) return true;

  // 3. Multi-word tokens: "dazm eva" -> all tokens must match
  const tokens = qClean.split(' ').filter(Boolean);
  if (tokens.length > 1) {
    const allTokensMatch = tokens.every(tok => nameClean.includes(tok) || skuClean.includes(tok));
    if (allTokensMatch) return true;
  }

  // 4. 3-character substring matches
  if (qClean.length >= 3 && (nameClean.includes(qClean) || skuClean.includes(qClean))) {
    return true;
  }

  return false;
}

function ReceiptProductLine({line,index,totalLines,products,setLine,removeLine,onSelect,confirmPrice,openCreateProduct,rate,currency='USD'}){
  const[search,setSearch]=useState('');
  const[dropdownOpen,setDropdownOpen]=useState(false);
  const[priceCurrency,setPriceCurrency]=useState(() => line.currency || currency || 'USD');
  const[serverResults,setServerResults]=useState([]);
  const[isSearchingServer,setIsSearchingServer]=useState(false);
  const searchContainerRef = useRef(null);

  useEffect(()=>{
    if(line.currency) {
      setPriceCurrency(line.currency);
    } else if(currency) {
      setPriceCurrency(currency);
    }
  },[line.currency, currency]);

  // Click outside listener to close dropdown
  useEffect(() => {
    function handleClickOutside(e) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Async debounced server-side search fallback if query has 2+ characters
  useEffect(() => {
    const q = search.trim();
    if (!q || q.length < 2) {
      setServerResults([]);
      setIsSearchingServer(false);
      return;
    }

    setIsSearchingServer(true);
    const timer = setTimeout(async () => {
      try {
        const { data } = await getBrowserClient()
          .from('products')
          .select('id,name,sku,cost_price,retail_price,wholesale_price,minimum_sale_price,cost_price_usd,retail_price_usd,wholesale_price_usd,minimum_sale_price_usd,currency')
          .neq('status', 'archived')
          .or(`name.ilike.%${q}%,sku.ilike.%${q}%`)
          .limit(40);
        setServerResults(data || []);
      } catch (err) {
        setServerResults([]);
      } finally {
        setIsSearchingServer(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [search]);

  const selectedProduct=products.find(p=>p.id===line.product_id);
  const matchedVariant = (line.variants || []).find(v =>
    (line.variant_id && v.id === line.variant_id) ||
    (line.color_name && v.color_name?.trim().toLowerCase() === line.color_name.trim().toLowerCase())
  );
  const existingVariantImage = matchedVariant?.image_url || matchedVariant?.media?.[0]?.public_url || null;

  // Merge client fuzzy matches and server results (deduplicated)
  const filtered = useMemo(() => {
    const localMatches = search.trim()
      ? products.filter(p => fuzzyMatchProduct(p, search)).slice(0, 50)
      : products.slice(0, 30);

    if (!serverResults.length) return localMatches;

    const seenIds = new Set(localMatches.map(p => p.id));
    const merged = [...localMatches];
    for (const sp of serverResults) {
      if (!seenIds.has(sp.id)) {
        seenIds.add(sp.id);
        merged.push(sp);
      }
    }
    return merged.slice(0, 60);
  }, [products, search, serverResults]);

  return <div className="receipt-product card" style={{padding:16,marginBottom:14,border:'1px solid var(--line)',borderRadius:14,background:index%2===1?'#fcfdfd':'#fff'}}>
    {/* Qator sarlavhasi va o'chirish tugmasi */}
    <div className="wide" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,paddingBottom:8,borderBottom:'1px solid var(--line,#e2e8f0)',gap:8}}>
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',minWidth:0,flex:1}}>
        <span style={{background:'#f1f5f9',color:'#334155',fontSize:12,fontWeight:700,padding:'2px 8px',borderRadius:6,flexShrink:0}}>
          #{index + 1}-qator
        </span>
        {selectedProduct && (
          <b style={{fontSize:13,color:'var(--text)',overflowWrap:'anywhere',wordBreak:'break-word'}}>
            {selectedProduct.name}
          </b>
        )}
        {line.color_name ? (
          <span style={{background:'#dbeafe',color:'#1d4ed8',padding:'2px 10px',borderRadius:20,fontSize:12,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4,flexShrink:0}}>
            🎨 {line.color_name} rangi
          </span>
        ) : (
          <span style={{fontSize:11,color:'var(--muted)',flexShrink:0}}>
            (Rangi kiritilmagan)
          </span>
        )}
        {(line.variantImageFiles?.length > 0 || existingVariantImage) && (
          <span style={{background:'#ecfdf5',color:'#047857',border:'1px solid #a7f3d0',padding:'1px 8px',borderRadius:12,fontSize:11,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
            <Camera size={12}/> {line.variantImageFiles?.length > 0 ? `${line.variantImageFiles.length} ta yangi rasm` : 'Rasmi bor'}
          </span>
        )}
        {Array.isArray(line.components) && line.components.length > 0 && (
          <span style={{background:'#fef3c7',color:'#92400e',border:'1px solid #fde68a',padding:'1px 8px',borderRadius:12,fontSize:11,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
            <Layers size={12}/> {line.components.length} ta tarkibiy qism ({line.components.reduce((sum, c) => sum + (Number(c.quantity) || 1), 0)} dona)
          </span>
        )}
      </div>
      {removeLine && (
        <button
          type="button"
          className="receipt-line-delete-btn"
          onClick={removeLine}
          title="Ushbu qatorni o'chirish"
          style={{position:'static',width:28,height:28}}
        >
          <Trash2 size={14}/>
        </button>
      )}
    </div>
    
    <label className="wide">
      <span>Mahsulot *</span>
      {selectedProduct ? (
        <div className="receipt-selected-product">
          <div>
            <b>{selectedProduct.name}</b>
            <small>{selectedProduct.sku} · Baza narxi: <DualPrice value={Number(selectedProduct.retail_price)} usdValue={selectedProduct.retail_price_usd != null ? Number(selectedProduct.retail_price_usd) : undefined} rate={rate}/></small>
          </div>
          <button type="button" className="btn btn-sm" style={{padding:'4px 10px',fontSize:11}} onClick={()=>{onSelect(index,'');setSearch('')}}>O'zgartirish</button>
        </div>
      ) : (
        <div className="receipt-product-search" ref={searchContainerRef}>
          <div className="receipt-search-input">
            <Search size={14}/>
            <input
              value={search}
              onChange={e=>{setSearch(e.target.value);setDropdownOpen(true)}}
              onFocus={()=>setDropdownOpen(true)}
              placeholder="Tovar nomi, SKU yoki ixtiyoriy 3 ta harf bo‘yicha qidiring..."
            />
            {isSearchingServer && <Loader2 size={13} className="tw-animate-spin" style={{color:'#64748b'}}/>}
          </div>
          {dropdownOpen&&<div className="receipt-product-dropdown" style={{maxHeight:320,overflowY:'auto'}}>
            {search.trim() && (
              <div style={{padding:'6px 12px',background:'#f8fafc',fontSize:11,fontWeight:600,color:'#64748b',borderBottom:'1px solid #f1f5f9',display:'flex',justifyContent:'space-between'}}>
                <span>Qidiruv natijasi: {filtered.length} ta tovar</span>
                {isSearchingServer && <span style={{fontSize:10,color:'#0284c7'}}>Serverdan qidirilmoqda…</span>}
              </div>
            )}
            {filtered.map(p=>(
              <button
                type="button"
                key={p.id}
                onClick={()=>{onSelect(index,p.id,p);setDropdownOpen(false);setSearch('')}}
                style={{display:'flex',flexDirection:'column',gap:2,padding:'8px 12px',borderBottom:'1px solid #f8fafc',textAlign:'left'}}
              >
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',width:'100%'}}>
                  <b style={{fontSize:13,color:'#0f172a'}}>{p.name}</b>
                  <span style={{fontSize:11,color:'#16a34a',fontWeight:700,marginLeft:8}}>
                    {p.currency === 'USD' ? `$${Number(p.cost_price_usd||0).toFixed(2)}` : `${new Intl.NumberFormat('uz-UZ').format(p.cost_price||0)} so'm`}
                  </span>
                </div>
                <small style={{color:'#64748b',fontSize:11}}>
                  {p.sku || 'SKUsiz'} · Sotish: {p.currency === 'USD' ? `$${Number(p.retail_price_usd||0).toFixed(2)}` : `${new Intl.NumberFormat('uz-UZ').format(p.retail_price||0)} so'm`}
                </small>
              </button>
            ))}
            {filtered.length===0&&<span className="receipt-dropdown-empty">"{search}" bo‘yicha tovar topilmadi</span>}
            <button type="button" className="receipt-dropdown-create" onClick={()=>{setDropdownOpen(false);openCreateProduct()}}><Plus size={13}/>Yangi tovar yaratish</button>
          </div>}
        </div>
      )}
    </label>

    {selectedProduct && (
      <>
        {/* Asosiy narxlar - 3 ustun (Rangi, Miqdor, Tannarx) */}
        <label>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>Rangi {line.color_name ? `(${line.color_name})` : '(masalan: Oq, Qora)'}</span>
            <label className="btn btn-ghost btn-xs" style={{cursor:'pointer',display:'inline-flex',alignItems:'center',gap:4,padding:'1px 6px',fontSize:10,color:'var(--orange,#ea580c)'}} title="Rasmdan rangni aniqlash">
              <Camera size={12}/> <span>Rasmdan aniqlash</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={async e=>{
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const currentFiles = line.variantImageFiles || [];
                  setLine(index, 'variantImageFiles', [...currentFiles, file]);
                  try {
                    const detected = await detectColorFromImageSource(file);
                    if (detected?.name) {
                      const matched = (line.variants||[]).find(v => v.color_name?.trim().toLowerCase() === detected.name.toLowerCase());
                      if (matched) {
                        setLine(index, { color_name: detected.name, variant_id: matched.id });
                      } else {
                        setLine(index, { color_name: detected.name, variant_id: '' });
                      }
                    }
                  } catch {}
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <input
            className="input"
            value={line.color_name || ''}
            onChange={e=>{
              const val = e.target.value;
              const matched = (line.variants||[]).find(v => v.color_name?.trim().toLowerCase() === val.trim().toLowerCase());
              if(matched){
                setLine(index, {
                  color_name: val,
                  variant_id: matched.id,
                  unit_cost: matched.cost_price ? String(matched.cost_price) : line.unit_cost,
                  unit_cost_usd: matched.cost_price_usd ?? line.unit_cost_usd,
                  retail_price: matched.retail_price ? String(matched.retail_price) : line.retail_price,
                  retail_price_usd: matched.retail_price_usd ?? line.retail_price_usd,
                  wholesale_price: matched.wholesale_price ? String(matched.wholesale_price) : line.wholesale_price,
                  wholesale_price_usd: matched.wholesale_price_usd ?? line.wholesale_price_usd
                });
              } else {
                setLine(index, {
                  color_name: val,
                  variant_id: ''
                });
              }
            }}
            list={`colors-list-${index}`}
            placeholder="Masalan: Oq, Qora..."
          />
          <datalist id={`colors-list-${index}`}>
            {(line.variants||[]).map(v => (
              <option key={v.id} value={v.color_name} />
            ))}
          </datalist>
          {line.variants?.length > 0 && (
            <div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:4}}>
              <small style={{fontSize:10,color:'var(--muted)',width:'100%'}}>Mavjud ranglar:</small>
              {line.variants.map(v => (
                <button
                  key={v.id}
                  type="button"
                  className="btn btn-sm"
                  style={{
                    padding:'2px 7px',
                    fontSize:11,
                    display:'inline-flex',
                    alignItems:'center',
                    gap:5,
                    background: line.color_name?.toLowerCase() === v.color_name?.toLowerCase() ? '#0284c7' : '#f1f5f9',
                    color: line.color_name?.toLowerCase() === v.color_name?.toLowerCase() ? '#fff' : '#334155',
                    border: '1px solid ' + (line.color_name?.toLowerCase() === v.color_name?.toLowerCase() ? '#0284c7' : '#e2e8f0'),
                    borderRadius: 6
                  }}
                  onClick={()=>{
                    setLine(index, {
                      color_name: v.color_name,
                      variant_id: v.id,
                      unit_cost: v.cost_price ? String(v.cost_price) : line.unit_cost,
                      unit_cost_usd: v.cost_price_usd ?? line.unit_cost_usd,
                      retail_price: v.retail_price ? String(v.retail_price) : line.retail_price,
                      retail_price_usd: v.retail_price_usd ?? line.retail_price_usd,
                      wholesale_price: v.wholesale_price ? String(v.wholesale_price) : line.wholesale_price,
                      wholesale_price_usd: v.wholesale_price_usd ?? line.wholesale_price_usd
                    });
                  }}
                >
                  {v.image_url ? (
                    <img src={v.image_url} alt="" style={{width:13,height:13,borderRadius:2,objectFit:'cover'}}/>
                  ) : v.color_hex ? (
                    <span style={{width:9,height:9,borderRadius:'50%',background:v.color_hex,display:'inline-block'}}/>
                  ) : null}
                  {v.color_name}
                </button>
              ))}
            </div>
          )}
          <div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:5}}>
            <small style={{fontSize:10,color:'var(--muted)',width:'100%'}}>Tezkor 12 ta rang:</small>
            {BASE_COLOR_PALETTE.map(c => {
              const active = (line.color_name || '').trim().toLowerCase() === c.name.toLowerCase();
              return (
                <button
                  key={c.name}
                  type="button"
                  style={{
                    padding:'2px 7px',
                    fontSize:10,
                    display:'inline-flex',
                    alignItems:'center',
                    gap:4,
                    background: active ? '#f97316' : '#ffffff',
                    color: active ? '#ffffff' : '#334155',
                    border: '1px solid ' + (active ? '#ea580c' : '#cbd5e1'),
                    borderRadius: 14,
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    const val = c.name;
                    const matched = (line.variants || []).find(v => v.color_name?.trim().toLowerCase() === val.toLowerCase());
                    if (matched) {
                      setLine(index, {
                        color_name: val,
                        variant_id: matched.id,
                        unit_cost: matched.cost_price ? String(matched.cost_price) : line.unit_cost,
                        unit_cost_usd: matched.cost_price_usd ?? line.unit_cost_usd,
                        retail_price: matched.retail_price ? String(matched.retail_price) : line.retail_price,
                        retail_price_usd: matched.retail_price_usd ?? line.retail_price_usd,
                        wholesale_price: matched.wholesale_price ? String(matched.wholesale_price) : line.wholesale_price,
                        wholesale_price_usd: matched.wholesale_price_usd ?? line.wholesale_price_usd
                      });
                    } else {
                      setLine(index, { color_name: val, variant_id: '' });
                    }
                  }}
                >
                  <span style={{width:7,height:7,borderRadius:'50%',background:c.hex,border:c.border?'1px solid #94a3b8':'none'}}/>
                  {c.name}
                </button>
              );
            })}
          </div>
        </label>

        {/* Tanlangan rang uchun alohida rasm yuklash bloki */}
        <div className="wide" style={{
          background: '#f8fafc',
          border: '1px dashed #cbd5e1',
          borderRadius: 12,
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          marginBottom: 4
        }}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <Camera size={15} style={{color:'var(--orange,#ea580c)'}}/>
              <span style={{fontSize:12,fontWeight:700,color:'var(--navy,#0f172a)'}}>
                {line.color_name ? `"${line.color_name}" rangi uchun rasm:` : 'Ushbu tovar / rang uchun rasm:'}
              </span>
              {line.color_name ? (
                <small style={{fontSize:11,color:'var(--muted)'}}>
                  (saytda mijoz "{line.color_name}" rangini tanlaganda aynan shu rasm ko‘rinadi)
                </small>
              ) : (
                <small style={{fontSize:11,color:'var(--muted)'}}>
                  (ixtiyoriy, har bir rang uchun alohida rasm yuklash mumkin)
                </small>
              )}
            </div>

            <label
              className="btn btn-outline btn-sm"
              style={{
                cursor:'pointer',
                display:'inline-flex',
                alignItems:'center',
                gap:5,
                background:'#fff',
                borderColor:'#94a3b8',
                fontWeight:600,
                fontSize:11,
                padding:'4px 10px'
              }}
            >
              <Upload size={13}/>
              <span>{(line.variantImageFiles?.length || 0) > 0 ? 'Yana rasm qo‘shish' : 'Rasm yuklash'}</span>
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={e=>{
                  const files = [...e.target.files];
                  if(!files.length)return;
                  const valid = files.filter(f => f.type.startsWith('image/'));
                  const currentFiles = line.variantImageFiles || [];
                  setLine(index, 'variantImageFiles', [...currentFiles, ...valid]);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            {/* Bazada allaqachon mavjud bo'lgan rasm */}
            {existingVariantImage && (
              <div
                style={{
                  width:58,
                  height:58,
                  borderRadius:8,
                  overflow:'hidden',
                  position:'relative',
                  border:'2px solid #0284c7',
                  background:'#fff',
                  flexShrink:0
                }}
                title={`Ushbu rang uchun bazadagi mavjud rasm (${matchedVariant?.color_name || ''})`}
              >
                <img src={existingVariantImage} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                <span style={{position:'absolute',bottom:0,left:0,right:0,background:'rgba(2,132,199,0.9)',color:'#fff',fontSize:8,textAlign:'center',fontWeight:700,padding:'1px 0'}}>
                  Mavjud
                </span>
              </div>
            )}

            {/* Yangi tanlangan rasmlar (pending upload) */}
            {(line.variantImageFiles || []).map((file, fIdx)=>(
              <div
                key={fIdx}
                style={{
                  width:58,
                  height:58,
                  borderRadius:8,
                  overflow:'hidden',
                  position:'relative',
                  border:'2px solid #16a34a',
                  background:'#fff',
                  flexShrink:0
                }}
                title={file.name || 'Yangi rasm'}
              >
                <img src={URL.createObjectURL(file)} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                <span style={{position:'absolute',bottom:0,left:0,right:0,background:'rgba(22,163,74,0.9)',color:'#fff',fontSize:8,textAlign:'center',fontWeight:700,padding:'1px 0'}}>
                  Yangi
                </span>
                <button
                  type="button"
                  style={{
                    position:'absolute',
                    top:2,
                    right:2,
                    width:18,
                    height:18,
                    borderRadius:'50%',
                    background:'rgba(0,0,0,0.7)',
                    color:'#fff',
                    border:0,
                    cursor:'pointer',
                    display:'grid',
                    placeItems:'center',
                    fontSize:10,
                    lineHeight:1
                  }}
                  onClick={()=>{
                    const updated = (line.variantImageFiles || []).filter((_, i) => i !== fIdx);
                    setLine(index, 'variantImageFiles', updated);
                  }}
                  title="Ushbu rasmni olib tashlash"
                >
                  ✕
                </button>
              </div>
            ))}

            {!existingVariantImage && (!line.variantImageFiles || line.variantImageFiles.length === 0) && (
              <span style={{fontSize:11,color:'#94a3b8',fontStyle:'italic'}}>
                Rasm yuklanmagan. Ixtiyoriy ravishda ushbu rang uchun fotosurat tanlashingiz mumkin.
              </span>
            )}
          </div>
        </div>

        <label>
          <span>Miqdor {line.color_name ? `(${line.color_name} soni, dona) *` : '(dona) *'}</span>
          <input
            className="input"
            type="number"
            min="1"
            max="10000"
            value={line.quantity === 0 ? '' : (line.quantity ?? '')}
            onChange={e=>{
              const v = e.target.value;
              setLine(index, 'quantity', v === '' ? '' : v);
            }}
            placeholder="1"
            required
          />
        </label>

        <label>
          <span>Tannarx {line.color_name ? `(${line.color_name} uchun, ${priceCurrency}) *` : `(${priceCurrency}) *`}</span>
          <CurrencyNumberInput
            valueUzs={line.unit_cost}
            onChangeUzs={v=>setLine(index,'unit_cost',v)}
            valueUsd={line.unit_cost_usd}
            onChangeUsd={v=>setLine(index,'unit_cost_usd',v)}
            currency={priceCurrency}
            baseCurrency={line.currency}
            onBaseCurrencyChange={c=>setLine(index,'currency',c)}
            rate={rate}
            placeholder={priceCurrency==='USD'?'0.00':'0'}
            required
          />
        </label>

        {/* Asosiy narxlarni o'zgartirish bloki */}
        {!line.priceConfirmed && (
          <div className="receipt-price-confirm wide">
            <p><b>{line.color_name ? `"${line.color_name}" rangi` : 'Ushbu qator'} uchun asosiy sotish narxlarini o'zgartirish</b></p>
            <div className="receipt-price-current">
              <span>Sotish: <b><DualPrice value={Number(line.retail_price || selectedProduct.retail_price)} usdValue={Number(line.retail_price_usd || selectedProduct.retail_price_usd) || undefined} rate={rate}/></b></span>
              <span>Ulgurji: <b><DualPrice value={Number(line.wholesale_price || selectedProduct.wholesale_price || 0)} usdValue={Number(line.wholesale_price_usd || selectedProduct.wholesale_price_usd) || undefined} rate={rate}/></b></span>
              <span>Minimal: <b><DualPrice value={Number(line.minimum_sale_price || selectedProduct.minimum_sale_price || 0)} usdValue={Number(line.minimum_sale_price_usd || selectedProduct.minimum_sale_price_usd) || undefined} rate={rate}/></b></span>
              <span>Tannarx: <b><DualPrice value={Number(line.unit_cost || selectedProduct.cost_price || 0)} usdValue={Number(line.unit_cost_usd || selectedProduct.cost_price_usd) || undefined} rate={rate}/></b></span>
            </div>
            <div className="receipt-price-buttons">
              <button type="button" className="btn btn-primary btn-sm" onClick={()=>confirmPrice(index,true)}>
                Ha, {line.color_name ? `"${line.color_name}" narxini` : 'yangi narx'} kiritaman
              </button>
              <button type="button" className="btn btn-sm" onClick={()=>confirmPrice(index,false)}>
                Yo'q, bazadagi narxda
              </button>
            </div>
          </div>
        )}

        {line.priceConfirmed && (
          <div className="receipt-price-fields wide">
            <div className="receipt-price-toggle" style={{gridColumn:'1/-1',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <b>{line.color_name ? `"${line.color_name}" rangi sotish narxlari:` : 'Sotish narxlari:'}</b>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <small>Valyuta:</small>
                <button type="button" className={priceCurrency==='USD'?'btn btn-primary':'btn'} style={{padding:'2px 8px',fontSize:11}} onClick={()=>{setPriceCurrency('USD');setLine(index,'currency','USD');}}>USD</button>
                <button type="button" className={priceCurrency==='UZS'?'btn btn-primary':'btn'} style={{padding:'2px 8px',fontSize:11}} onClick={()=>{setPriceCurrency('UZS');setLine(index,'currency','UZS');}}>UZS</button>
              </div>
            </div>
            <label>
              <span>Sotish narxi {line.color_name ? `(${line.color_name}, ${priceCurrency}) *` : `(${priceCurrency}) *`}</span>
              <CurrencyNumberInput
                valueUzs={line.retail_price}
                onChangeUzs={v=>setLine(index,'retail_price',v)}
                valueUsd={line.retail_price_usd}
                onChangeUsd={v=>setLine(index,'retail_price_usd',v)}
                currency={priceCurrency}
                baseCurrency={line.currency}
                onBaseCurrencyChange={c=>setLine(index,'currency',c)}
                rate={rate}
                placeholder={priceCurrency==='USD'?'0.00':'0'}
                required
              />
            </label>
            <label>
              <span>Ulgurji narx {line.color_name ? `(${line.color_name}, ${priceCurrency})` : `(${priceCurrency})`}</span>
              <CurrencyNumberInput
                valueUzs={line.wholesale_price}
                onChangeUzs={v=>setLine(index,'wholesale_price',v)}
                valueUsd={line.wholesale_price_usd}
                onChangeUsd={v=>setLine(index,'wholesale_price_usd',v)}
                currency={priceCurrency}
                baseCurrency={line.currency}
                onBaseCurrencyChange={c=>setLine(index,'currency',c)}
                rate={rate}
                placeholder={priceCurrency==='USD'?'0.00':'0'}
              />
            </label>
            <label>
              <span>Minimal narx {line.color_name ? `(${line.color_name}, ${priceCurrency})` : `(${priceCurrency})`}</span>
              <CurrencyNumberInput
                valueUzs={line.minimum_sale_price}
                onChangeUzs={v=>setLine(index,'minimum_sale_price',v)}
                valueUsd={line.minimum_sale_price_usd}
                onChangeUsd={v=>setLine(index,'minimum_sale_price_usd',v)}
                currency={priceCurrency}
                baseCurrency={line.currency}
                onBaseCurrencyChange={c=>setLine(index,'currency',c)}
                rate={rate}
                placeholder={priceCurrency==='USD'?'0.00':'0'}
              />
            </label>
          </div>
        )}

        <label className="wide">
          <span>Seriya raqamlari (ixtiyoriy, har satrda bittadan)</span>
          <textarea className="textarea" value={line.serials} onChange={e=>setLine(index,'serials',e.target.value)} placeholder={`Agar kiritilsa, aynan ${line.quantity} ta bo'lishi kerak`}/>
        </label>

        {/* Ko'p qismli tovar / Tarkibiy va qo'shimcha qismlar (Modulli tovar) */}
        <div className="wide" style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--line, #cbd5e1)' }}>
          <ProductComponentEditor
            components={line.components || []}
            onChange={updated => {
              setLine(index, 'components', updated);
            }}
            rate={rate}
            showQuantity={true}
          />
          {Array.isArray(line.components) && line.components.length > 0 && (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', background: '#f8fafc', padding: '10px 14px', borderRadius: 8, fontSize: 12, color: 'var(--muted, #64748b)', marginTop: 8, border: '1px solid #e2e8f0' }}>
              <span>Jami tarkibiy qismlar: <b style={{ color: '#1e293b' }}>{line.components.reduce((sum, c) => sum + (Number(c.quantity) || 1), 0)} dona</b> ({line.components.length} xil qism)</span>
              <span>Qismlar umumiy tannarxi: <b style={{ color: '#1e293b' }}>{formatDualMoney(line.components.reduce((sum, c) => sum + ((Number(c.cost_price) || 0) * (Number(c.quantity) || 1)), 0), rate)}</b></span>
              <span>Qismlar umumiy sotish narxi: <b style={{ color: '#1e293b' }}>{formatDualMoney(line.components.reduce((sum, c) => sum + ((Number(c.retail_price) || 0) * (Number(c.quantity) || 1)), 0), rate)}</b></span>
            </div>
          )}
        </div>
      </>
    )}
  </div>;
}

export function InventoryScanner({open,close,branchId,toast}){
  const rate=useExchangeRate();
  const[code,setCode]=useState(''),[unit,setUnit]=useState(null),[refs,setRefs]=useState({locations:[]}),[target,setTarget]=useState('');
  const[busy,setBusy]=useState(false),[placing,setPlacing]=useState(false),[error,setError]=useState('');
  const[showCost,setShowCost]=useState(false);
  const[revertOpen,setRevertOpen]=useState(false),[revertLocation,setRevertLocation]=useState(''),[revertReason,setRevertReason]=useState(''),[reverting,setReverting]=useState(false);
  const[scannerBtPrint,setScannerBtPrint]=useState(false);
  useEffect(()=>{if(open&&branchId)getInventoryReferences(branchId).then(r=>{setRefs(r);setTarget(r.locations[0]?.id||'');setRevertLocation(r.locations.find(x=>x.type==='store')?.id||r.locations[0]?.id||'')}).catch(e=>setError(err(e)))},[open,branchId]);
  useEffect(()=>{setShowCost(false);setRevertOpen(false);setRevertReason('')},[unit?.id]);
  const extractQr=v=>{const raw=String(v||'').trim();try{const u=new URL(raw);const m=u.pathname.match(/^\/qr\/([^/]+)\/?$/i);return m?decodeURIComponent(m[1]).trim():raw}catch{return raw}};
  const reload=async qr=>{try{setUnit(await getInventoryUnitPassport(qr))}catch(e){setError(err(e))}};
  const scan=async e=>{e.preventDefault();setBusy(true);setError('');try{setUnit(await getInventoryUnitPassport(extractQr(code)))}catch(e){setUnit(null);setError(err(e))}finally{setBusy(false)}};
  const place=async()=>{
    setPlacing(true);setError('');
    try{
      await placeInventoryUnits(target,[unit.qr_code]);
      toast?.('Mahsulot yangi joyga joylashtirildi');
      await reload(unit.qr_code);
    }catch(e){setError(err(e))}finally{setPlacing(false)}
  };
  const revert=async()=>{
    if(!revertLocation){setError('Qaytarish joyini tanlang');return}
    if(!window.confirm('Ushbu tovarni sotuvdan qaytarasizmi? Sotuv summasi hisobdan chiqariladi.'))return;
    setReverting(true);setError('');
    try{
      const result=await revertUnitSale(unit.id,revertLocation,revertReason||null);
      toast?.(`${result.location_name}ga qaytarildi · ${formatDualMoney(Number(result.reverted_amount),rate)} hisobdan chiqarildi`);
      setRevertOpen(false);setRevertReason('');
      await reload(unit.qr_code);
    }catch(e){setError(err(e))}finally{setReverting(false)}
  };
  if(!open)return null;
  const availableCount = unit?.available_count ?? (unit?.status === 'available' ? 1 : 0);
  const storefrontBase=(import.meta.env?.VITE_STOREFRONT_URL||'https://texnobazar-storefront.netlify.app').replace(/\/$/,'');
  return <div className="passport-scanner">
    <header><button onClick={close}><X/></button><b>QR / seriya skaneri</b><span/></header>
    <form onSubmit={scan}><QrCode/><input autoFocus value={code} onChange={e=>setCode(e.target.value)} placeholder="TNB1-... yoki seriya raqami" required/><QrScanButton onScan={v=>setCode(extractQr(v))}/><button disabled={busy}>{busy?'…':'Topish'}</button></form>
    {error&&<div className="inventory-error"><AlertTriangle/><p>{error}</p></div>}
    {unit&&<div className="unit-passport">
      <div className="passport-product">
        {unit.product.image?<img src={unit.product.image}/>:<span><Boxes/></span>}
        <div>
          <small>Elektron pasport</small>
          <h2>{unit.product.name}</h2>
          <p>{unit.product.sku} · {unit.product.brand_name||'Brendsiz'}</p>
          {unit.variant_color&&<span className="passport-variant-badge"><i style={{background:unit.variant_color_hex||'#ccc'}}/>{unit.variant_color}</span>}
        </div>
        <Status type={availableCount > 0 ? 'green' : 'orange'}>
          {availableCount > 0 ? `Mavjud: ${availableCount} dona` : 'Qolmagan'}
        </Status>
      </div>
      {unit.variants_stock?.length > 1 && (
        <div style={{margin:'8px 0 12px',padding:'8px 12px',background:'#fff7ed',borderRadius:8,border:'1px solid #fed7aa'}}>
          <div style={{fontSize:11,fontWeight:700,color:'#c2410c',marginBottom:4}}>
            Filialdagi ranglar bo‘yicha qoldiq ({unit.available_count || availableCount} dona):
          </div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {unit.variants_stock.map((vs, idx) => (
              <span key={idx} style={{
                display:'inline-flex',alignItems:'center',gap:5,padding:'3px 8px',borderRadius:6,
                background: vs.is_current ? '#ea580c' : '#ffffff',
                color: vs.is_current ? '#ffffff' : '#334155',
                border: vs.is_current ? '1px solid #c2410c' : '1px solid #cbd5e1',
                fontSize: 11, fontWeight: vs.is_current ? 700 : 500
              }}>
                {vs.color_hex && <i style={{width:8,height:8,borderRadius:'50%',background:vs.color_hex,display:'inline-block',border:'1px solid rgba(0,0,0,0.2)'}}/>}
                <b>{vs.color_name}</b>: {vs.total_quantity} dona {vs.is_current ? '(ushbu tovar)' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:10}}>
        <button
          type="button"
          className="btn btn-outline"
          style={{padding:'7px 12px',fontSize:12,display:'inline-flex',alignItems:'center',gap:6,borderColor:'#f97316',color:'#ea580c',background:'#fff7ed',fontWeight:600}}
          onClick={()=>setScannerBtPrint(true)}
        >
          <Bluetooth size={14}/>
          <Printer size={14}/>
          Termoprinterda chop etish (Detonger / MHT-L80G)
        </button>
      </div>
      <div className="passport-grid">
        <span><small>QR kod</small><b>{unit.qr_code}</b></span>
        <span>
          <small>Mavjud qoldiq</small>
          <b>{availableCount} dona {unit.total_count ? `(jami ${unit.total_count} ta)` : ''}</b>
          {unit.variants_summary_text ? (
            <small style={{display:'block',color:'#ea580c',fontWeight:600,fontSize:11,marginTop:3}}>
              Ranglar: {unit.variants_summary_text}
            </small>
          ) : null}
          {unit.branch_stock && (unit.branch_stock.store > 0 || unit.branch_stock.warehouse > 0) && (
            <small style={{display:'block',color:'var(--muted)',fontSize:10.5,marginTop:2}}>
              Filialda: Do‘konda {unit.branch_stock.store} · Omborda {unit.branch_stock.warehouse}
            </small>
          )}
        </span>
        <span><small>Zavod seriyasi</small><b>{unit.serial_number||'—'}</b></span>
        <span><small>Partiya</small><b>{unit.batch?.receipt_no||'—'}</b></span>
        <span><small>Ta’minotchi</small><b>{unit.batch?.supplier_name||'—'}</b></span>
        <span><small>Tannarx</small><button type="button" className="masked-value" onClick={()=>setShowCost(v=>!v)} title={showCost?'Yashirish':'Ko‘rsatish'}>{showCost?<><b><DualPrice value={Number(unit.batch?.unit_cost||unit.product?.cost_price||0)} usdValue={unit.cost_price_usd ?? unit.batch?.unit_cost_usd ?? unit.product?.cost_price_usd} rate={rate}/></b><EyeOff size={13}/></>:<><b>******</b><Eye size={13}/></>}</button></span>
        <span><small>Sotish narxi</small><b><DualPrice value={Number(unit.batch?.retail_price||unit.product?.retail_price||0)} usdValue={unit.product?.retail_price_usd ?? unit.batch?.retail_price_usd} rate={rate}/></b></span>
        {unit.product?.slug&&<span><small>Sayt sahifasi</small><a className="passport-link" href={`${storefrontBase}/product/${unit.product.slug}`} target="_blank" rel="noopener"><ExternalLink size={12}/>{unit.product.is_published?'Saytda ko‘rish':'Ko‘rish (nashr qilinmagan)'}</a></span>}
        {unit.latest_batch_prices&&<span><small>Eng yangi partiya narxi</small><b><DualPrice value={Number(unit.latest_batch_prices.retail_price||0)} rate={rate}/></b></span>}
        <span><small>Hozirgi joyi</small><b>{unit.location?.name||'—'}</b></span>
      </div>

      <section>
        <h3>Filial ichida joylashtirish</h3>
        <div className="place-row">
          <select className="select" value={target} onChange={e=>setTarget(e.target.value)}>
            {refs.locations.map(x=><option key={x.id} value={x.id}>{x.name} {x.type==='warehouse'?'(Ombor)':'(Do‘kon)'}</option>)}
          </select>
          <button className="btn btn-primary" onClick={place} disabled={placing||busy||!unit.location||target===unit.location?.id}>
            {placing?<><span className="btn-spinner"/>Joylashtirilmoqda…</>:<><MapPin/>Joylashtirish</>}
          </button>
        </div>
      </section>

      <section><h3>Harakatlar tarixi</h3><div className="movement-list">{(unit.movements||[]).length>0?(unit.movements||[]).map(m=><div key={m.id}><i/><span><b>{movementLabel(m.type)}</b><small>{new Date(m.occurred_at).toLocaleString('uz-UZ')} · {m.actor_name||'Tizim'}</small><em>{m.from_location?`${m.from_location} → `:''}{m.to_location||''}</em></span></div>):<small style={{color:'#64748b',padding:'8px 0',display:'block'}}>Harakatlar tarixi mavjud emas</small>}</div></section>
    </div>}
    {unit&&<DetongerPrintModal
      open={scannerBtPrint}
      onClose={()=>setScannerBtPrint(false)}
      labels={[{
        id: unit.id,
        title: unit.product.name,
        product_name: unit.product.name,
        color: unit.variant_color,
        variant_color: unit.variant_color,
        code: unit.qr_code,
        qr_code: unit.qr_code,
        cost_usd: unit.cost_price_usd || unit.batch?.unit_cost_usd || unit.product?.cost_price_usd || '',
        quantity: availableCount || 1,
        date: unit.batch?.received_at ? new Date(unit.batch.received_at).toLocaleDateString('uz-UZ') : new Date().toLocaleDateString('uz-UZ'),
      }]}
      batchTitle={unit?.batch?.receipt_no ? `Partiya #${unit.batch.receipt_no}` : ''}
    />}
  </div>;
}
const unitStatusLabel=status=>({available:'Sotuvga tayyor',reserved:'Band',in_transit:'Yo‘lda',sold:'Sotilgan',returned:'Qaytarilgan',written_off:'Hisobdan chiqarilgan',in_repair:'Ta’mirda'}[status]||status);
const movementLabel=t=>({received:'Yetkazib beruvchidan qabul qilindi',adjustment:'Joylashtirildi',transfer_out:'Transferga jo‘natildi',transfer_in:'Transferdan qabul qilindi',reserved:'Rezerv qilindi',sold:'Sotildi',returned:'Qaytarildi',writeoff:'Hisobdan chiqarildi'}[t]||t);
