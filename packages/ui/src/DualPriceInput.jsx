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
export function formatDualMoney(value,rate){
  const uzs=Number(value||0);
  const formatted=new Intl.NumberFormat('uz-UZ').format(uzs)+" so'm";
  if(!rate||rate<=0)return formatted;
  const usd=Math.round(uzs/rate);
  return `${formatted} ($${usd.toLocaleString('en-US')})`;
}

/**
 * Ikki valyutali narx input — UZS kiritilganda USD avtomatik hisoblanadi va aksincha.
 * Props: label, valueUzs, onChangeUzs, rate (1 USD = X UZS), disabled
 */
export function DualPriceInput({label,valueUzs='',onChangeUzs,rate,disabled=false}){
  const[usd,setUsd]=useState('');
  const[source,setSource]=useState('uzs');

  useEffect(()=>{
    if(source==='uzs'&&rate&&Number(valueUzs)>0){
      setUsd((Number(valueUzs)/rate).toFixed(2));
    }
  },[valueUzs,rate]);

  const handleUzs=e=>{
    const v=e.target.value;
    onChangeUzs(v);
    setSource('uzs');
    if(rate&&Number(v)>0)setUsd((Number(v)/rate).toFixed(2));
    else setUsd('');
  };

  const handleUsd=e=>{
    const v=e.target.value;
    setUsd(v);
    setSource('usd');
    if(rate&&Number(v)>0)onChangeUzs(String(Math.round(Number(v)*rate)));
    else onChangeUzs('');
  };

  return <div className="dual-price">
    <span className="dual-price-label">{label}</span>
    <div className="dual-price-row">
      <label className="dual-price-field">
        <input className="input" type="number" min="0" step="1" value={valueUzs} onChange={handleUzs} disabled={disabled} placeholder="0"/>
        <small>UZS</small>
      </label>
      <span className="dual-price-sep">=</span>
      <label className="dual-price-field">
        <input className="input" type="number" min="0" step="0.01" value={usd} onChange={handleUsd} disabled={disabled||!rate} placeholder={rate?'0.00':'Kurs yo\'q'}/>
        <small>USD</small>
      </label>
    </div>
  </div>;
}


/**
 * Ikki valyutali narx display — UZS asosiy, USD kursga qarab yonida ko'rsatiladi.
 * Props: value (UZS son), rate (1 USD = X UZS), className, style, bold
 * rate null yoki 0 bo'lsa faqat UZS ko'rsatiladi.
 */
export function DualPrice({value,rate,className='',style,bold=false}){
  const uzs=Number(value||0);
  const usd=rate&&rate>0?Math.round(uzs/rate):null;
  const formatted=new Intl.NumberFormat('uz-UZ').format(uzs);
  return <span className={`dual-price ${className}`} style={style}>
    {bold?<b>{formatted} so'm</b>:<>{formatted} so'm</>}
    {usd!==null&&<em className="dual-price-usd">${usd.toLocaleString('en-US')}</em>}
  </span>;
}
