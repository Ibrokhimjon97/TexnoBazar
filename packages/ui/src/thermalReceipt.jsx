import React, { useState } from 'react';
import { Printer, ChevronLeft, ChevronRight, Layers, FileText } from 'lucide-react';

export function formatReceiptMoney(num) {
  return new Intl.NumberFormat('uz-UZ').format(Math.round(Number(num || 0))) + " so'm";
}

export function formatReceiptDate(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    const day = String(dt.getDate()).padStart(2, '0');
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const year = dt.getFullYear();
    const hour = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    return `${day}.${month}.${year} ${hour}:${min}`;
  } catch {
    return String(d).slice(0, 16);
  }
}

export function getReceiptShortNo(saleNo) {
  if (!saleNo) return '';
  const str = String(saleNo).trim();
  if (str.includes('-')) {
    const parts = str.split('-');
    return '#' + parts[parts.length - 1];
  }
  return '#' + str.slice(-8);
}

export function getReceiptPaymentText(payments) {
  if (!payments || !payments.length) return 'Naqd';
  return payments.map(p => {
    const name = String(p.method_name || p.method_code || '').trim();
    if (/cash|naqd/i.test(name)) return 'Naqd';
    if (/card|plastik|terminal|humo|uzcard/i.test(name)) return name || 'Plastik';
    return name;
  }).filter(Boolean).join(', ') || 'Naqd';
}

export function getReceiptSummaryItems(lines) {
  if (!lines || !lines.length) return [];
  const map = new Map();
  for (const line of lines) {
    const name = String(line.product_name || 'Mahsulot').trim();
    map.set(name, (map.get(name) || 0) + (Number(line.quantity) || 1));
  }
  const result = [];
  for (const [name, qty] of map.entries()) {
    result.push(qty > 1 ? `${qty}× ${name}` : name);
  }
  return result;
}

export function getProductStyle(textLength, itemCount = 1) {
  if (itemCount > 2 || textLength > 90) {
    return { pt: '5.2pt', lh: '1.08', px: '10px' };
  }
  if (itemCount > 1 || textLength > 55) {
    return { pt: '5.8pt', lh: '1.1', px: '11px' };
  }
  if (textLength > 30) {
    return { pt: '6.5pt', lh: '1.14', px: '12px' };
  }
  return { pt: '7.2pt', lh: '1.16', px: '13px' };
}

/**
 * Builds the exact standalone HTML for 40mm x 30mm thermal label sheets.
 */
export function buildThermalReceiptHtml(receipt, { mode = 'per_item' } = {}) {
  const branchName = receipt.branch_name || 'Asosiy filial';
  const sellerName = receipt.seller_name || '—';
  const dateStr = formatReceiptDate(receipt.sold_at);
  const shortNo = getReceiptShortNo(receipt.sale_no);
  const paymentText = getReceiptPaymentText(receipt.payments);
  const lines = receipt.lines && receipt.lines.length ? receipt.lines : [
    {
      product_name: receipt.product_name || 'Mahsulot',
      line_total: receipt.total || 0,
      unit_price: receipt.total || 0
    }
  ];

  let pages = [];

  if (mode === 'summary' || lines.length === 1) {
    const isSingle = lines.length === 1;
    let prodHtml = '';
    if (isSingle) {
      const name = lines[0].product_name || 'Mahsulot';
      const st = getProductStyle(name.length, 1);
      prodHtml = `<div class="product-name" style="font-size: ${st.pt} !important; line-height: ${st.lh} !important;">${escapeHtml(name)}</div>`;
    } else {
      const summaryItems = getReceiptSummaryItems(lines);
      const totalLen = summaryItems.join(' ').length;
      const st = getProductStyle(totalLen, summaryItems.length);
      prodHtml = summaryItems.map((item, idx) => {
        const prefix = summaryItems.length > 1 && !item.includes('×') ? `${idx + 1}. ` : '';
        return `<div class="product-name" style="font-size: ${st.pt} !important; line-height: ${st.lh} !important; margin-bottom: 0.2mm !important;">${escapeHtml(prefix + item)}</div>`;
      }).join('');
    }

    const priceText = formatReceiptMoney(receipt.total || lines[0].line_total || lines[0].unit_price);

    pages.push(`
      <div class="thermal-receipt-page">
        <div class="header">
          <span class="header-brand">TEXNOBAZAR</span>
          <span class="header-branch">${escapeHtml(branchName)}</span>
        </div>
        <div class="product-box">
          ${prodHtml}
        </div>
        <div class="price-row">
          <span class="price-label">Jami:</span>
          <span class="price-value">${priceText}</span>
        </div>
        <div class="info-row">
          <span>To'lov: <b>${escapeHtml(paymentText)}</b></span>
          <span>Sotuvchi: <b>${escapeHtml(sellerName)}</b></span>
        </div>
        <div class="footer-row">
          <span>${dateStr}</span>
          <span>${escapeHtml(shortNo)}</span>
        </div>
      </div>
    `);
  } else {
    // Mode: per_item
    lines.forEach((line, index) => {
      const itemPrice = formatReceiptMoney(line.line_total || line.unit_price);
      const totalNote = lines.length > 1 ? ` (${index + 1}/${lines.length})` : '';
      const name = line.product_name || 'Mahsulot';
      const st = getProductStyle(name.length, 1);

      pages.push(`
        <div class="thermal-receipt-page">
          <div class="header">
            <span class="header-brand">TEXNOBAZAR</span>
            <span class="header-branch">${escapeHtml(branchName)}</span>
          </div>
          <div class="product-box">
            <div class="product-name" style="font-size: ${st.pt} !important; line-height: ${st.lh} !important;">${escapeHtml(name)}</div>
          </div>
          <div class="price-row">
            <span class="price-label">Narxi:</span>
            <span class="price-value">${itemPrice}</span>
          </div>
          <div class="info-row">
            <span>To'lov: <b>${escapeHtml(paymentText)}</b></span>
            <span>Sotuvchi: <b>${escapeHtml(sellerName)}</b></span>
          </div>
          <div class="footer-row">
            <span>${dateStr}</span>
            <span>${escapeHtml(shortNo)}${totalNote}</span>
          </div>
        </div>
      `);
    });
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Chek ${escapeHtml(shortNo)}</title>
  <style>
    @page {
      size: 40mm 30mm;
      margin: 0 !important;
    }
    * {
      box-sizing: border-box !important;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 40mm;
      background: #fff;
      margin: 0 !important;
      padding: 0 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #000;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .thermal-receipt-page {
      width: 40mm !important;
      height: 29.2mm !important;
      max-height: 29.2mm !important;
      min-height: 29.2mm !important;
      overflow: hidden !important;
      padding: 1mm 1.2mm !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: space-between !important;
      background: #fff !important;
      page-break-after: always !important;
      break-after: page !important;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      border: 0 !important;
    }
    .thermal-receipt-page:last-child {
      page-break-after: avoid !important;
      break-after: avoid !important;
    }
    .header {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      font-size: 7pt !important;
      font-weight: 800 !important;
      line-height: 1.1 !important;
      border-bottom: 1px dashed #000 !important;
      padding-bottom: 0.2mm !important;
    }
    .header-brand {
      font-weight: 900 !important;
      font-size: 7.2pt !important;
      letter-spacing: 0.2px !important;
    }
    .header-branch {
      font-size: 6pt !important;
      font-weight: 700 !important;
      color: #111 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      max-width: 20mm !important;
      text-transform: uppercase !important;
    }
    .product-box {
      margin: 0.2mm 0 !important;
      flex: 1 !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
    .product-name {
      font-weight: 800 !important;
      color: #000 !important;
      word-break: break-word !important;
      overflow-wrap: break-word !important;
      white-space: normal !important;
    }
    .price-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: baseline !important;
      margin: 0.1mm 0 !important;
    }
    .price-label {
      font-size: 6.8pt !important;
      font-weight: 700 !important;
    }
    .price-value {
      font-size: 8.2pt !important;
      font-weight: 900 !important;
      color: #000 !important;
    }
    .info-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      font-size: 6.2pt !important;
      line-height: 1.1 !important;
      color: #111 !important;
      margin: 0.1mm 0 !important;
    }
    .footer-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      font-size: 6pt !important;
      font-weight: 700 !important;
      border-top: 1px dashed #000 !important;
      padding-top: 0.2mm !important;
      margin-top: 0.1mm !important;
      color: #222 !important;
    }
  </style>
</head>
<body>
  ${pages.join('')}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Triggers printing using an invisible iframe configured for 40mm x 30mm.
 */
export function printThermalReceipt(receipt, options = {}) {
  const html = buildThermalReceiptHtml(receipt, options);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.error('Print iframe error:', e);
    }
    setTimeout(() => {
      try {
        iframe.remove();
      } catch {}
    }, 4000);
  }, 250);
}

/**
 * Visual on-screen preview of the 40mm x 30mm thermal receipt(s).
 */
export function ThermalReceiptPreview({ receipt, mode = 'per_item', activeIndex = 0 }) {
  if (!receipt) return null;
  const branchName = receipt.branch_name || 'Asosiy filial';
  const sellerName = receipt.seller_name || '—';
  const dateStr = formatReceiptDate(receipt.sold_at);
  const shortNo = getReceiptShortNo(receipt.sale_no);
  const paymentText = getReceiptPaymentText(receipt.payments);
  const lines = receipt.lines && receipt.lines.length ? receipt.lines : [
    {
      product_name: receipt.product_name || 'Mahsulot',
      line_total: receipt.total || 0,
      unit_price: receipt.total || 0
    }
  ];

  const isSummary = mode === 'summary' || lines.length === 1;
  const currentLine = lines[Math.min(activeIndex, lines.length - 1)] || lines[0];

  let prodItems = [];
  if (isSummary) {
    if (lines.length === 1) {
      prodItems = [lines[0].product_name || 'Mahsulot'];
    } else {
      prodItems = getReceiptSummaryItems(lines);
    }
  } else {
    prodItems = [currentLine.product_name || 'Mahsulot'];
  }

  const totalChars = prodItems.join(' ').length;
  const style = getProductStyle(totalChars, prodItems.length);

  const priceText = isSummary
    ? formatReceiptMoney(receipt.total || currentLine.line_total || currentLine.unit_price)
    : formatReceiptMoney(currentLine.line_total || currentLine.unit_price);

  const totalNote = (!isSummary && lines.length > 1) ? ` (${activeIndex + 1}/${lines.length})` : '';

  return (
    <div style={{
      width: '260px',
      aspectRatio: '40 / 30',
      background: '#fff',
      color: '#000',
      border: '2px solid #0f172a',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
      padding: '7px 9px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      margin: '0 auto',
      boxSizing: 'border-box',
      userSelect: 'none'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px dashed #64748b',
        paddingBottom: '2px'
      }}>
        <span style={{ fontWeight: 900, fontSize: '11px', letterSpacing: '0.2px', color: '#000' }}>TEXNOBAZAR</span>
        <span style={{ fontSize: '9.5px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {branchName}
        </span>
      </div>

      <div style={{ margin: '3px 0', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
        {prodItems.map((item, idx) => {
          const prefix = prodItems.length > 1 && !item.includes('×') ? `${idx + 1}. ` : '';
          return (
            <div
              key={idx}
              style={{
                fontSize: style.px,
                fontWeight: 800,
                color: '#000',
                lineHeight: style.lh,
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
                whiteSpace: 'normal',
                marginBottom: prodItems.length > 1 ? '2px' : '0'
              }}
            >
              {prefix}{item}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '1px 0' }}>
        <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#334155' }}>Narxi:</span>
        <span style={{ fontSize: '13px', fontWeight: 900, color: '#000' }}>{priceText}</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '9.5px', color: '#334155', margin: '1px 0' }}>
        <span>To‘lov: <b style={{ color: '#000' }}>{paymentText}</b></span>
        <span>Sotuvchi: <b style={{ color: '#000' }}>{sellerName}</b></span>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '9px',
        fontWeight: 700,
        color: '#64748b',
        borderTop: '1px dashed #64748b',
        paddingTop: '2px'
      }}>
        <span>{dateStr}</span>
        <span>{shortNo}{totalNote}</span>
      </div>
    </div>
  );
}
