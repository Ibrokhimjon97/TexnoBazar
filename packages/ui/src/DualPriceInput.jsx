import React,{useEffect,useState}from'react';
import{getLatestExchangeRate}from'@texnobazar/data';

/**
 * Har bir workspace komponentida oxirgi USD->UZS kursini yuklaydigan umumiy hook.
 * Menejer "Valyuta" bo'limida kiritgan eng so'nggi kursni qaytaradi (1 USD = X UZS).
 */
export function useExchangeRate(){
  const[rate,setRate]=useState(null);
  useEffect(()=>{getLatestExchangeRate().then(r=>setRate(Number(r)||null)).catch(()=>{})},[]);
  return rate;
}

/**
 * Matn ichida (masalan confirm() yoki alert() ichida) ishlatish uchun UZS + USD qatorini qaytaradi.
 * rate bo'lmasa faqat UZS qaytaradi.
 */
export function formatDualMoney(value,rate,usdValue){
  const uzs=Number(value||0);
  const formatted=new Intl.NumberFormat('uz-UZ').format(uzs)+" so'm";
  const usd=usdValue!==undefined&&usdValue!==null&&!isNaN(Number(usdValue))&&Number(usdValue)>0
    ? Number(usdValue)
    : (rate&&rate>0 ? Number((uzs/rate).toFixed(2)) : null);
  if(usd===null)return formatted;
  const usdStr = Number.isInteger(usd) ? usd.toLocaleString('en-US') : usd.toFixed(2);
  return `${formatted} ($${usdStr})`;
}

/**
 * Ikki valyutali narx input — UZS kiritilganda USD avtomatik hisoblanadi va aksincha.
 * Props: label, valueUzs, onChangeUzs, valueUsd, onChangeUsd, rate (1 USD = X UZS), disabled
 */
export function DualPriceInput({label,valueUzs='',onChangeUzs,valueUsd,onChangeUsd,rate,disabled=false,currency,onCurrencyChange,onDualChange}){
  const[usd,setUsd]=useState(()=>{
    if(valueUsd!==undefined&&valueUsd!==null&&valueUsd!=='')return String(valueUsd);
    if(rate&&Number(valueUzs)>0)return (Number(valueUzs)/rate).toFixed(2);
    return '';
  });
  const[source,setSource]=useState(() => {
    if (currency) return currency.toLowerCase();
    return (valueUsd !== undefined && valueUsd !== '' && Number(valueUsd) > 0) ? 'usd' : 'uzs';
  });

  useEffect(() => {
    if (currency) {
      setSource(currency.toLowerCase());
    }
  }, [currency]);

  useEffect(()=>{
    if(valueUsd!==undefined&&valueUsd!==null&&valueUsd!==''){
      setUsd(String(valueUsd));
    }else if(source==='uzs'&&rate&&Number(valueUzs)>0){
      setUsd((Number(valueUzs)/rate).toFixed(2));
    }
  },[valueUsd,valueUzs,rate,source]);

  const handleUzs=e=>{
    const v=e.target.value;
    setSource('uzs');
    const calculatedUsd=(rate&&Number(v)>0)?(Number(v)/rate).toFixed(2):'';
    setUsd(calculatedUsd);
    if(onDualChange){
      onDualChange({uzs:v,usd:calculatedUsd,currency:'UZS'});
    }else{
      onCurrencyChange?.('UZS');
      onChangeUzs?.(v);
      onChangeUsd?.(calculatedUsd);
    }
  };

  const handleUsd=e=>{
    const v=e.target.value;
    setUsd(v);
    setSource('usd');
    const calculatedUzs=(rate&&Number(v)>0)?String(Math.round(Number(v)*rate)):'';
    if(onDualChange){
      onDualChange({uzs:calculatedUzs,usd:v,currency:'USD'});
    }else{
      onCurrencyChange?.('USD');
      onChangeUsd?.(v);
      onChangeUzs?.(calculatedUzs);
    }
  };

  const setCurrencyBase = (curr) => {
    const isUsd = curr === 'USD';
    setSource(isUsd ? 'usd' : 'uzs');
    if (onDualChange) {
      onDualChange({ uzs: valueUzs, usd, currency: isUsd ? 'USD' : 'UZS' });
    } else {
      onCurrencyChange?.(isUsd ? 'USD' : 'UZS');
    }
  };

  const isUzsActive = source !== 'usd';

  return <div className="dual-price" style={{marginBottom: 8}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
      <span className="dual-price-label" style={{fontWeight:600}}>{label}</span>
      <div style={{display:'inline-flex',alignItems:'center',gap:4,background:'#f1f5f9',borderRadius:6,padding:2}}>
        <button
          type="button"
          onClick={() => setCurrencyBase('UZS')}
          style={{
            border:0,
            background: isUzsActive ? '#0284c7' : 'transparent',
            color: isUzsActive ? '#fff' : '#64748b',
            fontSize:10,
            fontWeight:700,
            padding:'2px 6px',
            borderRadius:4,
            cursor:'pointer'
          }}
          title="Tannarx va sotish narxi so'mda belgilanadi (kurs o'zgarsa ham so'm narxi o'zgarmaydi)"
        >
          UZS (so'm)
        </button>
        <button
          type="button"
          onClick={() => setCurrencyBase('USD')}
          style={{
            border:0,
            background: !isUzsActive ? '#0284c7' : 'transparent',
            color: !isUzsActive ? '#fff' : '#64748b',
            fontSize:10,
            fontWeight:700,
            padding:'2px 6px',
            borderRadius:4,
            cursor:'pointer'
          }}
          title="Tannarx va sotish narxi dollarda belgilanadi (kurs o'zgarsa so'mdagi narxi avtomatik yangilanadi)"
        >
          USD ($)
        </button>
      </div>
    </div>
    <div className="dual-price-row">
      <label className="dual-price-field" style={{flex:1, position:'relative'}}>
        <input
          className="input"
          type="number"
          min="0"
          step="1"
          value={valueUzs}
          onChange={handleUzs}
          disabled={disabled}
          placeholder="0"
          style={{
            borderColor: isUzsActive ? '#0284c7' : undefined,
            background: isUzsActive ? '#f8fafc' : undefined,
            fontWeight: isUzsActive ? 600 : 400
          }}
        />
        <small style={{fontWeight: isUzsActive ? 700 : 400, color: isUzsActive ? '#0284c7' : undefined}}>UZS</small>
      </label>
      <span className="dual-price-sep" style={{color:'#94a3b8'}}>=</span>
      <label className="dual-price-field" style={{flex:1, position:'relative'}}>
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          value={usd}
          onChange={handleUsd}
          disabled={disabled||!rate}
          placeholder={rate?'0.00':'Kurs yo\'q'}
          style={{
            borderColor: !isUzsActive ? '#0284c7' : undefined,
            background: !isUzsActive ? '#f8fafc' : undefined,
            fontWeight: !isUzsActive ? 600 : 400
          }}
        />
        <small style={{fontWeight: !isUzsActive ? 700 : 400, color: !isUzsActive ? '#0284c7' : undefined}}>USD</small>
      </label>
    </div>
  </div>;
}


/**
 * Ikki valyutali narx display — UZS asosiy, USD kursga qarab yonida ko'rsatiladi.
 * Props: value (UZS son), rate (1 USD = X UZS), usdValue (ixtiyoriy, aniq USD son), className, style, bold
 * rate null yoki 0 bo'lsa faqat UZS ko'rsatiladi.
 */
export function DualPrice({value,rate,usdValue,className='',style,bold=false}){
  const uzs=Number(value||0);
  let usd=null;
  if(usdValue!==undefined&&usdValue!==null&&!isNaN(Number(usdValue))&&Number(usdValue)>0){
    usd=Number(usdValue);
  }else if(rate&&rate>0){
    usd=Number((uzs/rate).toFixed(2));
  }
  const formatted=new Intl.NumberFormat('uz-UZ').format(uzs);
  const usdStr = usd !== null ? (Number.isInteger(usd) ? usd.toLocaleString('en-US') : usd.toFixed(2)) : null;
  return <span className={`dual-price ${className}`} style={style}>
    {bold?<b>{formatted} so'm</b>:<>{formatted} so'm</>}
    {usdStr!==null&&<em className="dual-price-usd">${usdStr}</em>}
  </span>;
}
