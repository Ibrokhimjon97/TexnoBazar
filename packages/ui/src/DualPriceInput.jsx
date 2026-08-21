import React,{useEffect,useState}from'react';

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
