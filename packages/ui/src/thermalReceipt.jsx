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
    return { pt: '5.8pt', lh: '1.1', px: '10.5px' };
  }
  if (itemCount > 1 || textLength > 55) {
    return { pt: '6.5pt', lh: '1.14', px: '11.5px' };
  }
  if (textLength > 30) {
    return { pt: '7.2pt', lh: '1.18', px: '12.5px' };
  }
  return { pt: '8pt', lh: '1.2', px: '13.5px' };
}

/**
 * Builds the exact standalone HTML for 40mm x 30mm thermal label sheets.
 */
export function buildThermalReceiptHtml(receipt, { mode = 'per_item' } = {}) {
  const branchName = receipt.branch_name || 'Asosiy filial';
  const sellerName = receipt.seller_name || '—';
  const dateStr = formatReceiptDate(receipt.sold_at || receipt.created_at);
  const shortNo = getReceiptShortNo(receipt.sale_no);
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
        return `<div class="product-name" style="font-size: ${st.pt} !important; line-height: ${st.lh} !important; margin-bottom: 0.2mm !important; text-align: left !important;">${escapeHtml(prefix + item)}</div>`;
      }).join('');
    }

    pages.push(`
      <div class="thermal-receipt-page">
        <div class="header">
          <span class="header-brand">TEXNOBAZAR</span>
          <span class="header-branch">${escapeHtml(branchName)}</span>
        </div>
        <div class="sold-title">SOTILDI</div>
        <div class="seller-line">Sotuvchi: <b>${escapeHtml(sellerName)}</b></div>
        <div class="product-box">
          ${prodHtml}
        </div>
        <div class="footer-section">
          <div class="info-row">
            <span class="time-bold">Sotilgan vaqt: <b>${dateStr}</b></span>
            <span class="short-no">${escapeHtml(shortNo)}</span>
          </div>
        </div>
      </div>
    `);
  } else {
    // Mode: per_item
    lines.forEach((line, index) => {
      const totalNote = lines.length > 1 ? ` (${index + 1}/${lines.length})` : '';
      const name = line.product_name || 'Mahsulot';
      const st = getProductStyle(name.length, 1);

      pages.push(`
        <div class="thermal-receipt-page">
          <div class="header">
            <span class="header-brand">TEXNOBAZAR</span>
            <span class="header-branch">${escapeHtml(branchName)}</span>
          </div>
          <div class="sold-title">SOTILDI</div>
          <div class="seller-line">Sotuvchi: <b>${escapeHtml(sellerName)}</b></div>
          <div class="product-box">
            <div class="product-name" style="font-size: ${st.pt} !important; line-height: ${st.lh} !important;">${escapeHtml(name)}</div>
          </div>
          <div class="footer-section">
            <div class="info-row">
              <span class="time-bold">Sotilgan vaqt: <b>${dateStr}</b></span>
              <span class="short-no">${escapeHtml(shortNo)}${totalNote}</span>
            </div>
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
      font-size: 6.8pt !important;
      font-weight: 800 !important;
      line-height: 1.1 !important;
      border-bottom: 1px dashed #000 !important;
      padding-bottom: 0.2mm !important;
    }
    .header-brand {
      font-weight: 900 !important;
      font-size: 7pt !important;
      letter-spacing: 0.2px !important;
    }
    .header-branch {
      font-size: 5.8pt !important;
      font-weight: 700 !important;
      color: #111 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      max-width: 20mm !important;
      text-transform: uppercase !important;
    }
    .sold-title {
      font-size: 13pt !important;
      font-weight: 900 !important;
      letter-spacing: 0.8px !important;
      text-align: center !important;
      color: #000 !important;
      margin: 0.4mm 0 0.1mm 0 !important;
      line-height: 1.1 !important;
    }
    .seller-line {
      font-size: 7.8pt !important;
      font-weight: 800 !important;
      text-align: center !important;
      color: #000 !important;
      margin-bottom: 0.2mm !important;
      line-height: 1.15 !important;
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
      text-align: center !important;
    }
    .footer-section {
      border-top: 1px dashed #000 !important;
      padding-top: 0.3mm !important;
      margin-top: 0.2mm !important;
    }
    .info-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      font-size: 6.5pt !important;
      line-height: 1.15 !important;
      color: #000 !important;
    }
    .time-bold {
      font-size: 7.2pt !important;
      font-weight: 800 !important;
      color: #000 !important;
    }
    .short-no {
      font-weight: 800 !important;
      font-size: 6.5pt !important;
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
  const dateStr = formatReceiptDate(receipt.sold_at || receipt.created_at);
  const shortNo = getReceiptShortNo(receipt.sale_no);
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

      <div style={{
        fontSize: '18px',
        fontWeight: 900,
        letterSpacing: '1px',
        textAlign: 'center',
        color: '#000',
        margin: '4px 0 2px',
        lineHeight: 1.1
      }}>
        SOTILDI
      </div>

      <div style={{
        fontSize: '12px',
        fontWeight: 800,
        textAlign: 'center',
        color: '#000',
        marginBottom: '3px',
        lineHeight: 1.2
      }}>
        Sotuvchi: <b>{sellerName}</b>
      </div>

      <div style={{ margin: '2px 0', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
        {prodItems.map((item, idx) => {
          const prefix = prodItems.length > 1 && !item.includes('×') ? `${idx + 1}. ` : '';
          return (
            <div
              key={idx}
              style={{
                fontSize: prodItems.length === 1 ? '13px' : style.px,
                fontWeight: 900,
                color: '#000',
                lineHeight: style.lh,
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
                whiteSpace: 'normal',
                textAlign: prodItems.length > 1 ? 'left' : 'center',
                marginBottom: prodItems.length > 1 ? '2px' : '0'
              }}
            >
              {prefix}{item}
            </div>
          );
        })}
      </div>

      <div style={{
        borderTop: '1px dashed #64748b',
        paddingTop: '3px',
        marginTop: '2px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '10.5px',
        color: '#000'
      }}>
        <span>Sotilgan vaqt: <b style={{ color: '#000', fontWeight: 900 }}>{dateStr}</b></span>
        <span style={{ fontSize: '9.5px', fontWeight: 800, color: '#475569' }}>{shortNo}{totalNote}</span>
      </div>
    </div>
  );
}

/**
 * Builds standalone HTML for individual product delivery / sold stickers (40mm x 30mm)
 * Each product unit gets its own label so it can be stuck on the physical item.
 */
export function buildProductDeliveryStickersHtml({
  items = [],
  customer = {},
  sale = {},
  seller_name,
  sellerName: propSellerName,
  branchName = 'TEXNOBAZAR'
} = {}) {
  const dateStr = formatReceiptDate(sale.sold_at || sale.created_at || new Date());
  const shortNo = getReceiptShortNo(sale.sale_no || sale.delivery_no || sale.pending_no);
  const resolvedSeller = (
    propSellerName ||
    seller_name ||
    sale?.seller_name ||
    sale?.sellerName ||
    customer?.seller_name ||
    customer?.sellerName ||
    ''
  );
  const pages = [];

  const rawItems = items && items.length ? items : [{
    product_name: 'Mahsulot',
    unit_price: sale.total || 0,
    line_total: sale.total || 0
  }];

  rawItems.forEach((item, index) => {
    const codAmount = Number(sale?.cod_amount ?? customer?.cod_amount ?? item?.cod_amount ?? 0);
    const codText = codAmount > 0 ? `Kuryerdan ${Number(codAmount).toLocaleString('uz-UZ')} so‘m` : '';
    const prodName = String(item.product_name || 'Mahsulot').trim();
    const batchCode = item.batch_code || item.reference || (item.qr_code ? `QR: ${item.qr_code}` : '');
    const custName = customer?.full_name || customer?.name || 'Mijoz';
    const custPhone = customer?.phone || '';
    const custAddress = customer?.address || customer?.delivery_address || '';
    const itemSeller = item?.seller_name || item?.sellerName || resolvedSeller;
    const counterText = `${index + 1}/${rawItems.length}`;

    // Font styling based on name length
    const st = getProductStyle(prodName.length, 1);

    pages.push(`
      <div class="thermal-receipt-page">
        <div class="header" style="border-bottom: 1px solid #000 !important; padding-bottom: 0.3mm !important;">
          <span class="header-brand" style="font-size: 7.2pt !important; color: #000 !important; letter-spacing: 0.2px !important;">
            TEXNOBAZAR
          </span>
          <span class="header-branch" style="font-size: 6.5pt !important; font-weight: 800 !important; color: #000 !important;">
            ${escapeHtml(shortNo)}
          </span>
        </div>

        <div class="product-box" style="margin: 0.2mm 0 !important; min-height: 7mm !important;">
          <div class="product-name" style="font-size: ${st.pt} !important; font-weight: 900 !important; line-height: ${st.lh} !important; color: #000 !important;">
            ${escapeHtml(prodName)}
          </div>
          ${batchCode ? `
            <div style="font-size: 5.6pt !important; font-weight: 700 !important; color: #111 !important; margin-top: 0.2mm !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;">
              Partiya: <b>${escapeHtml(batchCode)}</b>
            </div>
          ` : ''}
          ${item.qr_code && !batchCode.includes(item.qr_code) ? `
            <div style="font-size: 5pt !important; color: #333 !important;">
              QR: ${escapeHtml(item.qr_code)}
            </div>
          ` : ''}
        </div>

        <div style="border-top: 1px dashed #000 !important; padding-top: 0.3mm !important; margin: 0.2mm 0 !important; font-size: 6.8pt !important; line-height: 1.25 !important;">
          <div style="display: flex !important; justify-content: space-between !important; font-size: 7.5pt !important;">
            <span>Mijoz: <b style="font-weight: 900 !important;">${escapeHtml(custName)}</b></span>
            <span><b style="font-weight: 900 !important;">${escapeHtml(custPhone)}</b></span>
          </div>
          ${custAddress ? `
            <div style="white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; color: #111 !important; margin-top: 0.1mm !important; font-size: 6.2pt !important;">
              Manzil: <b>${escapeHtml(custAddress)}</b>
            </div>
          ` : ''}
        </div>

        <div style="text-align: center !important; margin: 0.6mm 0 0.3mm !important;">
          <span style="display: inline-block !important; border: 1.8px solid #000 !important; padding: 0.3mm 3.5mm !important; font-size: 10pt !important; font-weight: 900 !important; letter-spacing: 1px !important; color: #000 !important; line-height: 1.1 !important;">
            SOTILDI
          </span>
          ${itemSeller ? `
            <div style="font-size: 8.5pt !important; font-weight: 900 !important; color: #000 !important; margin-top: 0.6mm !important; text-align: center !important; letter-spacing: 0.2px !important;">
              Sotuvchi: <b>${escapeHtml(itemSeller)}</b>
            </div>
          ` : ''}
        </div>

        <div class="footer-row" style="border-top: 1px solid #000 !important; padding-top: 0.3mm !important; font-size: 6.2pt !important; display: flex !important; justify-content: space-between !important; align-items: center !important;">
          <span style="font-weight: 900 !important; font-size: 7.5pt !important; color: #000 !important;">${codText ? escapeHtml(codText) : ''}</span>
          <span style="font-weight: 800 !important;">${dateStr} (${counterText})</span>
        </div>
      </div>
    `);
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tovar stikerlari ${escapeHtml(shortNo)}</title>
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
      padding: 0.8mm 1.2mm !important;
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
      line-height: 1.1 !important;
    }
    .header-brand {
      font-weight: 900 !important;
    }
    .header-branch {
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    .product-box {
      flex: 1 !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
    .product-name {
      word-break: break-word !important;
      overflow-wrap: break-word !important;
      white-space: normal !important;
    }
    .footer-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      color: #000 !important;
    }
  </style>
</head>
<body>
  ${pages.join('')}
</body>
</html>`;
}

/**
 * Directly prints product delivery stickers (40x30mm) using hidden iframe
 */
export function printProductDeliveryStickers(payload = {}) {
  const html = buildProductDeliveryStickersHtml(payload);
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
 * Text wrapper helper for Canvas 2D contexts
 */
function wrapCanvasLines(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/);
  if (!words.length || !words[0]) return [];

  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + ' ' + word;
    if (ctx.measureText(testLine).width <= maxWidth) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines) break;
    }
  }
  lines.push(currentLine);
  return lines.slice(0, maxLines);
}

/**
 * Renders high-contrast "TOVAR SOTILDI" sticker canvas for Bluetooth thermal printers
 * Compatible with Detonger (40x30mm · 320x240px) and MHT-L80G (58x40mm · 464x320px)
 */
export async function renderProductDeliveryStickerCanvas({
  item = {},
  customer = {},
  sale = {},
  branchName = 'TEXNOBAZAR',
  seller_name,
  sellerName: propSellerName,
  printer = 'detonger',
  labelSize = '40x30',
  width = 320,
  height = 240,
  index = 0,
  total = 1
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas 2D context mavjud emas");

  // Pure white thermal paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const isMht = printer === 'mht' || width >= 400;
  const scale = isMht ? 1.45 : 1.0;
  const padX = isMht ? 16 : 10;
  const contentW = width - padX * 2;

  const dateStr = formatReceiptDate(sale.sold_at || sale.created_at || new Date());
  const shortNo = getReceiptShortNo(sale.sale_no || sale.delivery_no || sale.pending_no);
  const prodName = String(item.product_name || 'Mahsulot').trim();
  const batchCode = item.batch_code || item.reference || (item.qr_code ? `QR: ${item.qr_code}` : '');
  const custName = customer?.full_name || customer?.name || 'Mijoz';
  const custPhone = customer?.phone || '';
  const custAddress = customer?.address || customer?.delivery_address || '';
  const codAmount = Number(sale?.cod_amount ?? customer?.cod_amount ?? item?.cod_amount ?? 0);
  const codText = codAmount > 0 ? `Kuryerdan ${Number(codAmount).toLocaleString('uz-UZ')} so'm` : '';
  const counterText = `${index + 1}/${total || 1}`;
  const resolvedSeller = (
    propSellerName ||
    seller_name ||
    sale?.seller_name ||
    sale?.sellerName ||
    customer?.seller_name ||
    customer?.sellerName ||
    item?.seller_name ||
    item?.sellerName ||
    ''
  );

  // 1. Header: "TEXNOBAZAR" (left) and shortNo (right)
  let curY = isMht ? 22 : 16;
  ctx.fillStyle = '#000000';
  ctx.font = `900 ${Math.round(12 * scale)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('TEXNOBAZAR', padX, curY);

  ctx.textAlign = 'right';
  ctx.font = `800 ${Math.round(11 * scale)}px "Courier New", monospace`;
  ctx.fillText(shortNo, width - padX, curY);

  // Line below header
  curY += isMht ? 8 : 6;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padX, curY);
  ctx.lineTo(width - padX, curY);
  ctx.stroke();

  // 2. Product name (wrapped to 1 or 2 lines)
  curY += isMht ? 18 : 13;
  ctx.textAlign = 'left';
  const prodFontSize = prodName.length > 40 ? Math.round(11 * scale) : Math.round(13 * scale);
  ctx.font = `900 ${prodFontSize}px system-ui, -apple-system, sans-serif`;
  const prodLines = wrapCanvasLines(ctx, prodName, contentW, 2);
  for (const line of prodLines) {
    ctx.fillText(line, padX, curY);
    curY += prodFontSize + (isMht ? 4 : 2);
  }

  // Partiya / QR line
  if (batchCode) {
    curY += isMht ? 2 : 1;
    ctx.font = `700 ${Math.round(9.5 * scale)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(`Partiya: ${batchCode}`, padX, curY);
    curY += isMht ? 14 : 10;
  }

  // 3. Dashed separator
  curY += isMht ? 4 : 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padX, curY);
  ctx.lineTo(width - padX, curY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 4. Customer info (Mijoz ismi va tel raqami kattaroq shriftda)
  curY += isMht ? 18 : 13;
  const custFontSize = Math.round(12 * scale);
  ctx.font = `900 ${custFontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(`Mijoz: ${custName}`, padX, curY);

  if (custPhone) {
    ctx.textAlign = 'right';
    ctx.font = `900 ${custFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(custPhone, width - padX, curY);
  }

  if (custAddress) {
    curY += isMht ? 16 : 11;
    ctx.textAlign = 'left';
    ctx.font = `700 ${Math.round(9.5 * scale)}px system-ui, -apple-system, sans-serif`;
    const addrLines = wrapCanvasLines(ctx, `Manzil: ${custAddress}`, contentW, 1);
    if (addrLines[0]) ctx.fillText(addrLines[0], padX, curY);
  }

  // 5. Solid separator before footer
  const footerH = isMht ? 32 : 24;
  const footerSepY = height - footerH;

  // 5a. SOTILDI and Sotuvchi in the middle (large font, dynamically sized and centered)
  const midTop = curY + (isMht ? 8 : 4);
  const midBottom = footerSepY - (isMht ? 8 : 4);
  const availableMidSpace = Math.max(16, midBottom - midTop);

  // Adapt font size dynamically: SOTILDI stamp
  let soldFontSize = isMht ? (resolvedSeller ? 28 : 36) : (resolvedSeller ? 18 : 24);
  if (soldFontSize > availableMidSpace * 0.45 && resolvedSeller) {
    soldFontSize = Math.max(12, Math.floor(availableMidSpace * 0.38));
  } else if (soldFontSize > availableMidSpace * 0.65) {
    soldFontSize = Math.max(13, Math.floor(availableMidSpace * 0.65));
  }

  ctx.font = `900 ${soldFontSize}px system-ui, -apple-system, sans-serif`;
  const textW = ctx.measureText('SOTILDI').width;
  const boxPadX = isMht ? 20 : 12;
  const boxPadY = Math.max(2, Math.round(soldFontSize * 0.2));
  const boxW = textW + boxPadX * 2;
  const boxH = soldFontSize + boxPadY * 2;

  // Determine seller text font size (kattaroq shriftda: 18px on MHT 58mm, 13px on Detonger 40mm)
  let sellerFontSize = isMht ? 18 : 13;
  let sellerGap = isMht ? 7 : 4;
  if (resolvedSeller) {
    ctx.font = `900 ${sellerFontSize}px system-ui, -apple-system, sans-serif`;
    const sWidth = ctx.measureText(`Sotuvchi: ${resolvedSeller}`).width;
    if (sWidth > contentW) {
      sellerFontSize = Math.max(10, Math.floor(sellerFontSize * (contentW / sWidth)));
    }
  }

  const totalBlockH = boxH + (resolvedSeller ? (sellerGap + sellerFontSize) : 0);
  const blockStartY = Math.max(midTop, (midTop + midBottom - totalBlockH) / 2);

  const boxX = (width - boxW) / 2;
  const boxY = blockStartY;
  const soldCenterY = boxY + boxH / 2;

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = isMht ? 2.6 : 1.8;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.fillStyle = '#000000';
  ctx.font = `900 ${soldFontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SOTILDI', width / 2, soldCenterY);
  ctx.textBaseline = 'alphabetic';

  if (resolvedSeller) {
    const sellerY = boxY + boxH + sellerGap + sellerFontSize * 0.85;
    ctx.font = `900 ${sellerFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`Sotuvchi: ${resolvedSeller}`, width / 2, sellerY);
  }

  // 6. Solid line above footer
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padX, footerSepY);
  ctx.lineTo(width - padX, footerSepY);
  ctx.stroke();

  // 7. Footer: Agar kuryer olishi kerak bo'lgan summa bo'lsa: "Kuryerdan n so'm" (mahsulot narxi ko'rinmasin!)
  const footerTextY = height - (isMht ? 10 : 8);
  if (codText) {
    ctx.textAlign = 'left';
    ctx.font = `900 ${Math.round(11 * scale)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(codText, padX, footerTextY);
  }

  ctx.textAlign = 'right';
  ctx.font = `700 ${Math.round(9.5 * scale)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${dateStr} (${counterText})`, width - padX, footerTextY);

  return canvas;
}

/**
 * Renders high-contrast receipt canvas for Bluetooth thermal printers
 * Compatible with Detonger (40x30mm · 320x240px) and MHT-L80G (58x40mm · 464x320px)
 */
export async function renderThermalReceiptCanvas({
  receipt = {},
  mode = 'per_item',
  activeIndex = 0,
  printer = 'detonger',
  labelSize = '40x30',
  width = 320,
  height = 240
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas 2D context mavjud emas");

  // Pure white thermal paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const isMht = printer === 'mht' || width >= 400;
  const scale = isMht ? 1.45 : 1.0;
  const padX = isMht ? 16 : 10;
  const contentW = width - padX * 2;

  const branchName = receipt.branch_name || 'Asosiy filial';
  const sellerName = receipt.seller_name || '—';
  const dateStr = formatReceiptDate(receipt.sold_at || receipt.created_at);
  const shortNo = getReceiptShortNo(receipt.sale_no);
  const lines = receipt.lines && receipt.lines.length ? receipt.lines : [
    {
      product_name: receipt.product_name || 'Mahsulot',
      line_total: receipt.total || 0,
      unit_price: receipt.total || 0
    }
  ];

  const currentLine = lines[Math.min(activeIndex, lines.length - 1)] || lines[0];
  const isSummary = mode === 'summary';

  // 1. Header: "TEXNOBAZAR" (left) and Branch Name (right)
  let curY = isMht ? 22 : 16;
  ctx.fillStyle = '#000000';
  ctx.font = `900 ${Math.round(13 * scale)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('TEXNOBAZAR', padX, curY);

  ctx.textAlign = 'right';
  ctx.font = `800 ${Math.round(10 * scale)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(String(branchName).toUpperCase(), width - padX, curY);

  // Dashed line below header
  curY += isMht ? 8 : 6;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.0;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padX, curY);
  ctx.lineTo(width - padX, curY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. H1: SOTILDI Title (katta H1 shriftda markazda)
  curY += isMht ? 34 : 24;
  ctx.font = `900 ${isMht ? 36 : 25}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('SOTILDI', width / 2, curY);

  // 3. H2: Sotuvchi ismi (uning pastida H2 shriftda)
  curY += isMht ? 26 : 19;
  ctx.font = `800 ${isMht ? 20 : 14.5}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`Sotuvchi: ${sellerName}`, width / 2, curY);

  // 4. H2: Mahsulot nomi to'liq (uning pastida yana H2 shriftda to'liq)
  curY += isMht ? 26 : 19;

  if (!isSummary) {
    const prodName = currentLine.product_name || 'Mahsulot';
    const prodFontSize = prodName.length > 45 ? (isMht ? 17 : 12.5) : (isMht ? 19.5 : 14);
    ctx.font = `800 ${prodFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    const prodLines = wrapCanvasLines(ctx, prodName, contentW, 4);
    for (const l of prodLines) {
      ctx.fillText(l, width / 2, curY);
      curY += prodFontSize + (isMht ? 5 : 3);
    }
  } else {
    const summaryItems = getReceiptSummaryItems(lines);
    const sumFontSize = isMht ? 17 : 12;
    ctx.font = `800 ${sumFontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'left';
    const maxItems = isMht ? 3 : 2;
    for (let i = 0; i < Math.min(summaryItems.length, maxItems); i++) {
      ctx.fillText(summaryItems[i], padX, curY);
      curY += sumFontSize + (isMht ? 4 : 2);
    }
    if (summaryItems.length > maxItems) {
      ctx.font = `700 ${Math.round(sumFontSize * 0.85)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(`... va yana ${summaryItems.length - maxItems} ta tovar`, padX, curY);
      curY += Math.round(11 * scale);
    }
  }

  // 5. Dashed separator before footer
  const footerH = isMht ? 36 : 26;
  const footerSepY = height - footerH;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padX, footerSepY);
  ctx.lineTo(width - padX, footerSepY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 6. Footer: Sotilgan vaqt biroz kattaroq shriftda!
  const totalNote = lines.length > 1 ? (isSummary ? ` (${lines.length} ta)` : ` (${activeIndex + 1}/${lines.length})`) : '';
  const footerTextY = height - (isMht ? 12 : 9);
  const timeFontSize = isMht ? 16 : 11.5;

  ctx.textAlign = 'left';
  ctx.font = `800 ${timeFontSize}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`Sotilgan vaqt: ${dateStr}`, padX, footerTextY);

  ctx.textAlign = 'right';
  ctx.font = `900 ${timeFontSize}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${shortNo}${totalNote}`, width - padX, footerTextY);

  return canvas;
}

