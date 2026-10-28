import React, { useState, useRef } from 'react';
import { Printer, X, CheckCircle, Table, LayoutGrid, FileText } from 'lucide-react';

const paymentMethodLabels = {
  cash: 'Naqd pul',
  card: 'Bank kartasi / terminal',
  click: 'Click',
  payme: 'Payme',
  uzum: 'Uzum Bank',
  bank_transfer: 'Bank o‘tkazmasi',
  installment: 'Nasiya',
  cod: 'Kuryerga to‘lov (Naqd)',
  split: 'Aralash to‘lov'
};

export function getPaymentLabel(delivery) {
  if (delivery.payment_status === 'pending_courier' || Number(delivery.cod_amount) > 0) {
    return 'Kuryerga to‘lov (COD)';
  }
  return paymentMethodLabels[delivery.payment_type] || delivery.payment_type || 'Kassada to‘langan';
}

export function formatDateTime(val) {
  if (!val) return '—';
  const d = new Date(val);
  return d.toLocaleString('uz-UZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates an official delivery registry TABLE on A4 portrait paper.
 * Product names are 100% full text without truncation or ellipsis.
 */
export function generateDeliveryTableHtml(deliveries = [], branchName = 'TEXNOBAZAR') {
  const dateFormatted = new Date().toLocaleDateString('uz-UZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

  const totalCod = deliveries.reduce((acc, d) => {
    if (d.payment_status === 'pending_courier' || Number(d.cod_amount) > 0) {
      return acc + Number(d.cod_amount || 0);
    }
    return acc;
  }, 0);

  const rowsHtml = deliveries.map((d, index) => {
    const isCod = d.payment_status === 'pending_courier' || Number(d.cod_amount) > 0;
    const codSum = Number(d.cod_amount || 0);
    let items = [];
    if (Array.isArray(d.items)) {
      items = d.items;
    } else if (typeof d.items === 'string') {
      try { items = JSON.parse(d.items); } catch { items = []; }
    }
    const paymentLabel = getPaymentLabel(d);

    const itemsHtml = items.map((it, idx) => {
      const pName = it.product_name || it.name || it.product_title || it.product?.name || 'Mahsulot';
      const qty = it.quantity || 1;
      const serial = it.serial_number ? ` (S/N: ${escapeHtml(it.serial_number)})` : (it.qr_code ? ` (QR: ${escapeHtml(it.qr_code)})` : '');
      return `<div class="tbl-item-line">
        <span class="tbl-item-bullet">${items.length > 1 ? `<b>${idx + 1}.</b> ` : ''}</span>
        <span class="tbl-item-name"><b>${escapeHtml(pName)}</b> — <b class="qty-badge">${qty} dona</b></span>
        ${serial ? `<span class="tbl-item-serial">${serial}</span>` : ''}
      </div>`;
    }).join('');

    return `
      <tr class="${isCod ? 'row-cod' : 'row-paid'}">
        <td class="col-num">${index + 1}</td>
        <td class="col-doc">
          <b class="doc-code">${escapeHtml(d.delivery_no || 'DOST-000')}</b>
          <small class="doc-time">${formatDateTime(d.created_at)}</small>
        </td>
        <td class="col-client">
          <b class="client-name">${escapeHtml(d.customer_name || '—')}</b>
          <a class="client-tel">${escapeHtml(d.customer_phone || '—')}</a>
        </td>
        <td class="col-addr">${escapeHtml(d.delivery_address || '—')}</td>
        <td class="col-items">
          <div class="items-cell">${itemsHtml || '—'}</div>
          ${d.notes ? `<div class="cell-notes"><b>Izoh:</b> ${escapeHtml(d.notes)}</div>` : ''}
        </td>
        <td class="col-seller">${escapeHtml(d.seller_name || 'Sotuvchi')}</td>
        <td class="col-payment">
          <span class="pay-badge">${escapeHtml(paymentLabel)}</span>
        </td>
        <td class="col-cod">
          ${isCod ? `
            <div class="cod-due-box">
              <span class="cod-due-title">Kuryerga:</span>
              <b class="cod-due-val">${new Intl.NumberFormat('uz-UZ').format(codSum)} so‘m</b>
            </div>
          ` : `
            <div class="cod-paid-box">
              <b>0 so‘m</b>
              <small>(To‘langan)</small>
            </div>
          `}
        </td>
        <td class="col-sign">
          <div class="sign-line"></div>
        </td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dostavka_Qaydnomasi_${new Date().toISOString().slice(0, 10)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 8mm 7mm 10mm 7mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      margin: 0;
      padding: 0;
      background: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 8.5pt;
      color: #0f172a;
    }
    .page-container {
      width: 196mm;
      margin: 0 auto;
      background: #ffffff;
      padding: 2mm 0;
    }

    /* Report Header */
    .report-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 2.5mm;
      margin-bottom: 3.5mm;
    }
    .brand-block h1 {
      margin: 0;
      font-size: 13pt;
      font-weight: 900;
      color: #0f172a;
      letter-spacing: 0.5px;
      line-height: 1.1;
    }
    .brand-block span {
      display: block;
      font-size: 9pt;
      font-weight: 700;
      color: #0284c7;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-top: 1px;
    }
    .meta-block {
      text-align: right;
      font-size: 8.5pt;
      color: #334155;
      line-height: 1.35;
    }
    .meta-block b {
      color: #0f172a;
    }

    /* Master Table */
    .delivery-table {
      width: 100%;
      border-collapse: collapse;
      page-break-inside: auto;
      font-size: 8pt;
      line-height: 1.25;
    }
    .delivery-table th {
      background: #0f172a !important;
      color: #ffffff !important;
      font-weight: 800;
      font-size: 7.8pt;
      padding: 6px 4px;
      border: 1px solid #0f172a;
      text-align: center;
      vertical-align: middle;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }
    .delivery-table td {
      border: 1px solid #cbd5e1;
      padding: 5px 5px;
      vertical-align: top;
      color: #0f172a;
    }
    .delivery-table tr {
      page-break-inside: avoid;
      page-break-after: auto;
    }
    .delivery-table tbody tr:nth-child(even) {
      background-color: #f8fafc;
    }

    /* Column Widths & Alignments */
    .col-num {
      width: 3%;
      text-align: center;
      font-weight: 700;
      color: #64748b;
    }
    .col-doc {
      width: 9%;
      white-space: nowrap;
    }
    .doc-code {
      display: block;
      color: #0284c7;
      font-size: 8.5pt;
    }
    .doc-time {
      display: block;
      color: #64748b;
      font-size: 7pt;
      margin-top: 1px;
    }
    .col-client {
      width: 13%;
    }
    .client-name {
      display: block;
      font-size: 8.2pt;
      color: #0f172a;
    }
    .client-tel {
      display: block;
      color: #0284c7;
      font-weight: 700;
      font-size: 8pt;
      margin-top: 1px;
    }
    .col-addr {
      width: 15%;
      font-size: 7.8pt;
      line-height: 1.2;
      word-break: break-word;
    }
    .col-items {
      width: 32%;
    }
    .items-cell {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .tbl-item-line {
      display: block;
      font-size: 8pt;
      line-height: 1.25;
      /* FULL TEXT VISIBILITY - NO CLIPPING */
      white-space: normal !important;
      word-break: break-word !important;
      overflow-wrap: break-word !important;
      text-overflow: clip !important;
      overflow: visible !important;
    }
    .tbl-item-name {
      color: #0f172a;
    }
    .qty-badge {
      color: #0369a1;
      white-space: nowrap;
    }
    .tbl-item-serial {
      display: block;
      font-size: 6.8pt;
      color: #64748b;
      margin-left: 2px;
    }
    .cell-notes {
      font-size: 7pt;
      color: #64748b;
      background: #f1f5f9;
      padding: 2px 4px;
      border-radius: 3px;
      margin-top: 3px;
      border: 1px solid #e2e8f0;
      line-height: 1.15;
    }
    .col-seller {
      width: 7%;
      font-size: 7.8pt;
      color: #334155;
    }
    .col-payment {
      width: 7%;
      font-size: 7.5pt;
      text-align: center;
    }
    .pay-badge {
      display: inline-block;
      font-weight: 700;
      color: #334155;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 7.2pt;
      line-height: 1.1;
    }
    .col-cod {
      width: 9%;
      text-align: center;
      vertical-align: middle !important;
    }
    .cod-due-box {
      background: #fef2f2 !important;
      border: 1.5px solid #f87171 !important;
      border-radius: 4px;
      padding: 3px 2px;
    }
    .cod-due-title {
      display: block;
      font-size: 6.5pt;
      font-weight: 800;
      color: #991b1b;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }
    .cod-due-val {
      display: block;
      font-size: 9.5pt;
      font-weight: 900;
      color: #b91c1c;
      margin-top: 1px;
      white-space: nowrap;
    }
    .cod-paid-box {
      background: #f0fdf4 !important;
      border: 1px solid #86efac !important;
      border-radius: 4px;
      padding: 3px 2px;
      color: #15803d;
    }
    .cod-paid-box b {
      display: block;
      font-size: 8.5pt;
      font-weight: 800;
    }
    .cod-paid-box small {
      display: block;
      font-size: 6.8pt;
      font-weight: 600;
    }
    .col-sign {
      width: 5%;
      text-align: center;
      vertical-align: middle !important;
    }
    .sign-line {
      height: 22px;
      border-bottom: 1px dashed #94a3b8;
      width: 85%;
      margin: 0 auto;
    }

    /* Summary Footer Row */
    .summary-row td {
      background: #f8fafc !important;
      border-top: 2px solid #0f172a !important;
      padding: 6px 8px;
      font-size: 8.5pt;
      font-weight: 800;
    }
    .summary-title {
      text-align: right;
      color: #0f172a;
    }
    .summary-total {
      text-align: center;
      color: #b91c1c;
      font-size: 10pt;
      font-weight: 900;
      background: #fef2f2 !important;
      border: 1.5px solid #f87171 !important;
    }

    /* Signatures Footer */
    .report-signatures {
      margin-top: 8mm;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 8pt;
      font-weight: 700;
      color: #334155;
      padding-top: 4mm;
      border-top: 1px solid #cbd5e1;
    }
    .sig-field {
      display: inline-block;
      width: 45mm;
      border-bottom: 1px solid #0f172a;
      margin-left: 4px;
    }

    @media print {
      body {
        background: #ffffff !important;
      }
      .page-container {
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      thead {
        display: table-header-group !important;
      }
      tfoot {
        display: table-footer-group !important;
      }
      .delivery-table tr {
        page-break-inside: avoid !important;
      }
    }
  </style>
</head>
<body>
  <div class="page-container">
    <!-- Header -->
    <div class="report-header">
      <div class="brand-block">
        <h1>${escapeHtml(branchName)}</h1>
        <span>DOSTAVKA VA YETKAZIB BERISH QAYDNOMASI</span>
      </div>
      <div class="meta-block">
        <div>Sana: <b>${dateFormatted}</b></div>
        <div>Jami dostavkalar: <b>${deliveries.length} ta buyurtma</b></div>
      </div>
    </div>

    <!-- Master Table -->
    <table class="delivery-table">
      <thead>
        <tr>
          <th>№</th>
          <th>Buyurtma</th>
          <th>Mijoz / Tel</th>
          <th>Yetkazish manzili</th>
          <th>Mahsulotlar nomi va Soni</th>
          <th>Sotuvchi</th>
          <th>To‘lov</th>
          <th>Kuryerga to‘lov</th>
          <th>Imzo</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
      <tfoot>
        <tr class="summary-row">
          <td colspan="7" class="summary-title">JAMI KURYERDAN KASSAGA TOPHIRILADIGAN NAQD SUMMA:</td>
          <td class="summary-total">${new Intl.NumberFormat('uz-UZ').format(totalCod)} so‘m</td>
          <td></td>
        </tr>
      </tfoot>
    </table>

    <!-- Signatures -->
    <div class="report-signatures">
      <div>Topshirdi (Menejer): <span class="sig-field"></span></div>
      <div>Qabul qildi (Kuryer): <span class="sig-field"></span></div>
      <div>Sana va vaqt: <b>${dateFormatted}</b></div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Generates the horizontal voucher cards (5 per page portrait) format.
 * Product names are also 100% fully visible without truncation.
 */
export function generateDeliveryCardsHtml(deliveries = [], branchName = 'TEXNOBAZAR') {
  const PAGE_SIZE = 5;
  const pages = [];
  for (let i = 0; i < deliveries.length; i += PAGE_SIZE) {
    pages.push(deliveries.slice(i, i + PAGE_SIZE));
  }

  const renderCard = (d) => {
    if (!d) return '';
    const isCod = d.payment_status === 'pending_courier' || Number(d.cod_amount) > 0;
    const codSum = Number(d.cod_amount || 0);
    let items = [];
    if (Array.isArray(d.items)) {
      items = d.items;
    } else if (typeof d.items === 'string') {
      try { items = JSON.parse(d.items); } catch { items = []; }
    }
    const paymentLabel = getPaymentLabel(d);
    const dateFormatted = formatDateTime(d.created_at);

    const itemsHtml = items.map((it, idx) => {
      const pName = it.product_name || it.name || it.product_title || it.product?.name || 'Mahsulot';
      const qty = it.quantity || 1;
      const serial = it.serial_number ? ` (S/N: ${escapeHtml(it.serial_number)})` : (it.qr_code ? ` (QR: ${escapeHtml(it.qr_code)})` : '');
      return `<span class="item-badge">
        <b>${idx + 1}.</b> ${escapeHtml(pName)} — <b>${qty} dona</b>${serial}
      </span>`;
    }).join(' ');

    return `
      <div class="delivery-card">
        <!-- Top header row -->
        <div class="card-header">
          <div class="header-left">
            <span class="brand-title">${escapeHtml(branchName)}</span>
            <span class="badge-title">DOSTAVKA VAUCHERI</span>
          </div>
          <div class="header-right">
            <span class="doc-no">${escapeHtml(d.delivery_no || 'DOST-000')}</span>
            <span class="doc-date">${dateFormatted}</span>
          </div>
        </div>

        <!-- Middle table + right COD box -->
        <div class="card-body">
          <table class="card-table">
            <tbody>
              <tr>
                <td class="td-lbl" style="width: 14%;">Mijoz:</td>
                <td class="td-val" style="width: 38%;"><b>${escapeHtml(d.customer_name || '—')}</b></td>
                <td class="td-lbl" style="width: 10%;">Tel:</td>
                <td class="td-val tel-text" style="width: 38%;"><b>${escapeHtml(d.customer_phone || '—')}</b></td>
              </tr>
              <tr>
                <td class="td-lbl">Manzil:</td>
                <td class="td-val" colspan="3" style="font-size: 7.8pt;"><b>${escapeHtml(d.delivery_address || '—')}</b></td>
              </tr>
              <tr>
                <td class="td-lbl">Sotuvchi:</td>
                <td class="td-val">${escapeHtml(d.seller_name || 'Sotuvchi')}</td>
                <td class="td-lbl">To‘lov:</td>
                <td class="td-val"><b>${escapeHtml(paymentLabel)}</b></td>
              </tr>
              <tr>
                <td class="td-lbl" style="vertical-align: top;">Mahsulot:</td>
                <td class="td-val" colspan="3">
                  <div class="items-wrap">${itemsHtml || '—'}</div>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Right side block: COD & Signature -->
          <div class="card-side">
            <div class="cod-banner ${isCod ? 'cod-pending' : 'cod-paid'}">
              <span class="cod-caption">KURYERGA TO‘LASH:</span>
              <span class="cod-price">
                ${isCod ? `${new Intl.NumberFormat('uz-UZ').format(codSum)} so‘m` : '0 so‘m (To‘langan)'}
              </span>
            </div>

            <div class="sign-block">
              <div>Mijoz: _______________</div>
              <div>Kuryer: _______________</div>
            </div>
          </div>
        </div>

        ${d.notes ? `<div class="card-notes"><b>Izoh:</b> ${escapeHtml(d.notes)}</div>` : ''}
      </div>
    `;
  };

  const pagesHtml = pages.map((pageDeliveries) => {
    const cards = pageDeliveries.map(renderCard).join('');
    return `<div class="a4-page">${cards}</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dostavka_Kardlar_${new Date().toISOString().slice(0, 10)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 5mm 6mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      margin: 0;
      padding: 0;
      background: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 10px;
      color: #0f172a;
    }
    .a4-page {
      width: 198mm;
      height: 287mm;
      margin: 0 auto 10mm auto;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      gap: 2.2mm;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
      box-sizing: border-box;
    }
    .a4-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .delivery-card {
      width: 100%;
      min-height: 54.5mm;
      border: 1.5px dashed #475569;
      border-radius: 5px;
      padding: 2.5mm 3.5mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-sizing: border-box;
      background: #ffffff;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #0f172a;
      padding-bottom: 1.2mm;
      margin-bottom: 1.2mm;
    }
    .header-left {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .brand-title {
      font-size: 9.5pt;
      font-weight: 900;
      color: #0f172a;
      letter-spacing: 0.3px;
    }
    .badge-title {
      font-size: 7pt;
      font-weight: 700;
      color: #64748b;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .header-right {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .doc-no {
      font-size: 10pt;
      font-weight: 900;
      color: #0284c7;
      letter-spacing: 0.3px;
    }
    .doc-date {
      font-size: 7.5pt;
      font-weight: 600;
      color: #64748b;
    }
    .card-body {
      display: flex;
      gap: 2.5mm;
      flex: 1;
      align-items: stretch;
    }
    .card-table {
      flex: 1;
      border-collapse: collapse;
      font-size: 8pt;
      line-height: 1.25;
      height: 100%;
    }
    .card-table td {
      padding: 1.5mm 1.5mm;
      border: 1px solid #cbd5e1;
      vertical-align: middle;
    }
    .td-lbl {
      font-weight: 600;
      color: #475569;
      background: #f8fafc;
      font-size: 7.5pt;
      white-space: nowrap;
    }
    .td-val {
      color: #0f172a;
    }
    .tel-text {
      color: #0284c7;
      font-size: 8.5pt;
    }
    .items-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      font-size: 7.8pt;
      line-height: 1.25;
      white-space: normal !important;
      word-break: break-word !important;
    }
    .item-badge {
      display: inline-block;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 3px;
      padding: 1mm 2mm;
      white-space: normal !important;
      word-break: break-word !important;
    }
    .card-side {
      width: 62mm;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 1.5mm;
    }
    .cod-banner {
      flex: 1;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 1.5mm;
      text-align: center;
      border: 1.5px solid transparent;
    }
    .cod-pending {
      background: #fef2f2 !important;
      border-color: #ef4444 !important;
    }
    .cod-pending .cod-caption {
      color: #991b1b;
      font-size: 6.8pt;
      font-weight: 800;
      letter-spacing: 0.3px;
    }
    .cod-pending .cod-price {
      color: #b91c1c;
      font-size: 11pt;
      font-weight: 900;
      margin-top: 1px;
    }
    .cod-paid {
      background: #f0fdf4 !important;
      border-color: #22c55e !important;
    }
    .cod-paid .cod-caption {
      color: #166534;
      font-size: 6.8pt;
      font-weight: 800;
      letter-spacing: 0.3px;
    }
    .cod-paid .cod-price {
      color: #15803d;
      font-size: 9.5pt;
      font-weight: 900;
      margin-top: 1px;
    }
    .sign-block {
      display: flex;
      justify-content: space-between;
      font-size: 6.8pt;
      color: #64748b;
      font-weight: 600;
      border-top: 1px dashed #cbd5e1;
      padding-top: 1mm;
      white-space: nowrap;
    }
    .card-notes {
      font-size: 6.8pt;
      color: #64748b;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 3px;
      padding: 1mm 2mm;
      margin-top: 1mm;
      line-height: 1.15;
    }

    @media print {
      body {
        background: #ffffff !important;
      }
      .a4-page {
        margin: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
      }
      .a4-page:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
    }
  </style>
</head>
<body>
  ${pagesHtml}
</body>
</html>`;
}

/**
 * Triggers standard A4 print or Save to PDF dialog via a clean hidden iframe.
 */
export function printDeliveryA4Vouchers(deliveries = [], branchName = 'TEXNOBAZAR', mode = 'table') {
  return new Promise((resolve) => {
    const html = mode === 'cards' 
      ? generateDeliveryCardsHtml(deliveries, branchName)
      : generateDeliveryTableHtml(deliveries, branchName);

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

    iframe.contentWindow.focus();
    setTimeout(() => {
      try {
        iframe.contentWindow.print();
      } catch (err) {
        console.error('Print failed:', err);
      }
      setTimeout(() => {
        try {
          document.body.removeChild(iframe);
        } catch {}
        resolve(true);
      }, 1500);
    }, 350);
  });
}

/**
 * Modal to preview A4 Delivery Registry (Table by default or Cards) before printing or exporting to PDF.
 */
export function DeliveryA4PrintModal({
  open,
  onClose,
  deliveries = [],
  branchName = 'TEXNOBAZAR',
  onPrinted
}) {
  const iframeRef = useRef(null);
  const [viewMode, setViewMode] = useState('table'); // 'table' (Jadval) by default

  if (!open || !deliveries || !deliveries.length) return null;

  const count = deliveries.length;

  const handlePrint = async () => {
    await printDeliveryA4Vouchers(deliveries, branchName, viewMode);
    onPrinted?.(deliveries.map(d => d.id));
    onClose?.();
  };

  const previewHtml = viewMode === 'cards'
    ? generateDeliveryCardsHtml(deliveries, branchName)
    : generateDeliveryTableHtml(deliveries, branchName);

  return (
    <div
      className="overlay"
      style={{ zIndex: 1250 }}
      onMouseDown={e => e.target === e.currentTarget && onClose?.()}
    >
      <div
        className="modal"
        style={{
          maxWidth: 1000,
          width: '96vw',
          height: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          borderRadius: 14,
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 20px',
          background: 'linear-gradient(135deg, #0f172a, #1e293b)',
          color: '#ffffff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Printer size={18} style={{ color: '#38bdf8' }} />
              Dostavka qaydnomasi (A4 Chop etish / PDF)
            </h3>
            <small style={{ color: '#94a3b8', fontSize: 12 }}>
              Jami <b>{count} ta</b> dostavka tanlandi · Mahsulot nomlari to‘liq ko‘rsatiladi
            </small>
          </div>

          {/* View Mode Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.1)',
              padding: '3px',
              borderRadius: 8,
              border: '1px solid rgba(255, 255, 255, 0.15)'
            }}>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: viewMode === 'table' ? '#0284c7' : 'transparent',
                  color: '#ffffff',
                  transition: 'background 0.2s'
                }}
              >
                <Table size={14} />
                Jadval shaklida (Standart)
              </button>
              <button
                type="button"
                onClick={() => setViewMode('cards')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: viewMode === 'cards' ? '#0284c7' : 'transparent',
                  color: '#ffffff',
                  transition: 'background 0.2s'
                }}
              >
                <LayoutGrid size={14} />
                Kardlar shaklida
              </button>
            </div>

            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              style={{ color: '#cbd5e1' }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Info Banner */}
        <div style={{
          padding: '8px 18px',
          background: '#f0fdf4',
          borderBottom: '1px solid #bbf7d0',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 12,
          color: '#166534',
          flexShrink: 0
        }}>
          <CheckCircle size={15} style={{ flexShrink: 0, color: '#16a34a' }} />
          <span>
            <b>A4 Portret Jadval:</b> Barcha mahsulot nomlari to‘liq va qisqartirishsiz ko‘rsatiladi. Printerga chiqarish yoki <b>"PDF sifatida saqlash"</b> (Save as PDF) orqali saqlab olishingiz mumkin.
          </span>
        </div>

        {/* Live Preview Iframe */}
        <div style={{ flex: 1, background: '#cbd5e1', padding: '16px', overflow: 'auto', display: 'flex', justifyContent: 'center' }}>
          <iframe
            ref={iframeRef}
            srcDoc={previewHtml}
            title="A4 Delivery Table Preview"
            style={{
              width: '210mm',
              height: '100%',
              minHeight: '297mm',
              background: '#ffffff',
              border: 'none',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              borderRadius: 4
            }}
          />
        </div>

        {/* Actions Footer */}
        <div style={{
          padding: '12px 20px',
          background: '#ffffff',
          borderTop: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          flexShrink: 0
        }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Chop etilgandan so‘ng ushbu dostavkalarga <b>"Chop etildi"</b> belgisi biriktiriladi.
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              style={{ padding: '8px 16px', fontSize: 13 }}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePrint}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 20px',
                fontSize: 13,
                fontWeight: 700,
                background: 'linear-gradient(135deg, #0284c7, #0369a1)',
                boxShadow: '0 3px 12px rgba(2, 132, 199, 0.3)'
              }}
            >
              <Printer size={16} />
              A4 {viewMode === 'table' ? 'Jadvalni chop etish / PDF' : 'Kardlarni chop etish / PDF'} ({count} ta)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
