/**
 * Detonger & DothanTech Bluetooth Thermal Label Printer Driver for Texnobazar
 * Designed for 40x30 mm thermal sticker labels via Web Bluetooth API (BLE)
 * Supports mobile phones (Android Chrome / iOS Bluefy) and PC (Chrome / Edge)
 */
import QRCode from 'qrcode';
import { DothanTechPrinter, ConnectionStatus } from 'detonger-web-bt';

export const LABEL_WIDTH_MM = 40;
export const LABEL_HEIGHT_MM = 30;
export const LABEL_DPI = 203; // Standard for Detonger DP23/DP30S/DP26 (8 dots/mm)
export const CANVAS_WIDTH_PX = 320; // 40mm * 8 dots/mm
export const CANVAS_HEIGHT_PX = 240; // 30mm * 8 dots/mm

export const LABEL_SIZES = {
  '40x20': {
    id: '40x20',
    label: '40 x 20 mm (Kichik qog‘oz)',
    widthMm: 40,
    heightMm: 20,
    widthPx: 320,
    heightPx: 160,
  },
  '40x30': {
    id: '40x30',
    label: '40 x 30 mm (Standart qog‘oz)',
    widthMm: 40,
    heightMm: 30,
    widthPx: 320,
    heightPx: 240,
  },
};

export const DETONGER_PREFIX_PRESETS = [
  { id: 'P', label: 'Detonger P seriyasi (P1, P2) - Standart' },
  { id: 'DP', label: 'Detonger DP seriyasi (DP23, DP26, DP30, DP30S)' },
  { id: 'DT', label: 'Detonger DT seriyasi (DT20, DT30)' },
  { id: 'DeTong', label: 'DeTong / Detonger' },
  { id: 'ALL', label: 'Barcha Bluetooth qurilmalar (All Devices)' },
];

/**
 * Check if the current browser environment supports the Web Bluetooth API
 */
export function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth && navigator.bluetooth.requestDevice);
}

/**
 * Get device & browser diagnostic information for Bluetooth printing
 */
export function getBluetoothEnvironmentInfo() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, isSecure: false, isMobile: false, isAndroid: false, isIOS: false, tip: '' };
  }

  const supported = isWebBluetoothSupported();
  const isSecure = Boolean(window.isSecureContext);
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMobile = isAndroid || isIOS;

  let tip = '';
  if (!supported) {
    if (isIOS) {
      tip = "iOS (iPhone/iPad) da Safari Web Bluetooth'ni qo‘llamaydi. To‘g‘ridan-to‘g‘ri chop etish uchun App Store'dan bepul 'Bluefy' yoki 'WebBLE' brauzerini yuklab oling va loyihani unda oching.";
    } else if (isAndroid) {
      tip = "Android telefoningizda Google Chrome yoki Samsung Internet brauzeridan foydalaning hamda Bluetooth ruxsatnomasi yoqilganligini tekshiring.";
    } else {
      tip = "Kompyuterda Google Chrome, Microsoft Edge yoki Opera brauzeridan foydalaning va kompyuter Bluetooth adapteri yoqilganligini tekshiring.";
    }
  } else if (!isSecure && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    tip = "Web Bluetooth xavfsiz ulanish (HTTPS) talab qiladi. Agar telefonda lokal IP (192.168.x.x) orqali ochayotgan bo‘lsangiz, HTTPS domen yoki Chrome 'chrome://flags/#unsafely-treat-insecure-origin-as-secure' sozlamasidan foydalaning.";
  }

  return {
    supported,
    isSecure,
    isMobile,
    isAndroid,
    isIOS,
    tip,
  };
}

/**
 * Helper to split text into lines matching a max pixel width
 */
function wrapTextLines(ctx, text, maxWidth, maxLines = 2) {
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
 * Tovar nomi va rangini qatorlarga bo'lish - rang nomi HECH QACHON tushib qolmasligini kafolatlaydi
 */
export function wrapTextWithColor(ctx, title = '', color = '', maxWidth, maxLines = 2) {
  const cleanTitle = String(title || 'Mahsulot').trim();
  const cleanColor = String(color || '').trim();

  // Agar title ichida allaqachon rang yozilgan bo'lsa, qayta qo'shmaymiz
  const hasColorInTitle = cleanColor && (
    cleanTitle.toLowerCase().includes(`(${cleanColor.toLowerCase()})`) ||
    cleanTitle.toLowerCase().endsWith(cleanColor.toLowerCase())
  );
  const colorSuffix = (cleanColor && !hasColorInTitle) ? ` (${cleanColor})` : '';
  const fullText = `${cleanTitle}${colorSuffix}`.trim();

  // Agar to'liq matn 1 qatorga sig'sa:
  if (ctx.measureText(fullText).width <= maxWidth) {
    return [fullText];
  }

  // Standart qatorlarga bo'lish
  const lines = wrapTextLines(ctx, fullText, maxWidth, maxLines);

  // Agar rang ko'rsatilgan bo'lsa va u hosil bo'lgan qatorlarda tushib qolgan bo'lsa (kesilib ketgan):
  if (colorSuffix && !lines.some(l => l.includes(colorSuffix.trim()))) {
    const targetIdx = Math.max(0, Math.min(lines.length, maxLines) - 1);
    let base = lines[targetIdx] || cleanTitle;
    const suffix = colorSuffix.trim();

    // Qatordan joy ochish uchun so'zlarni oxiridan qisqartirib rangni joylashtiramiz
    while (ctx.measureText(base + ' ' + suffix).width > maxWidth && base.length > 3) {
      const words = base.split(/\s+/);
      if (words.length > 1) {
        words.pop();
        base = words.join(' ');
      } else {
        base = base.slice(0, -2);
      }
    }
    lines[targetIdx] = base ? `${base} ${suffix}` : suffix;
  }

  return lines.slice(0, maxLines);
}


/**
 * Format secret obfuscated cost code for thermal labels (haridor bilmasligi, faqat sotuvchi bilishi uchun):
 * 1) USD bo'lsa: T{narx}M (masalan: 90$ -> T90M, 94$ -> T94M)
 * 2) UZS bo'lsa: M{narx/1000}T (0 lari qisqartirilgan ming so'm, masalan: 478 000 so'm -> M478T)
 */
export function formatSecretCostCode(costOrObj, currencyParam, costUsdParam) {
  let cost = costOrObj;
  let currency = currencyParam;
  let costUsd = costUsdParam;

  if (costOrObj && typeof costOrObj === 'object') {
    cost = costOrObj.cost ?? costOrObj.unit_cost ?? costOrObj.unitCost;
    currency = costOrObj.currency || costOrObj.receiptCurrency;
    costUsd = costOrObj.costUsd ?? costOrObj.cost_usd ?? costOrObj.unit_cost_usd;
  }

  // Agar allaqachon T...M yoki M...T formatida kodlangan bo'lsa
  const rawStr = String(costUsd ?? cost ?? '').trim();
  if (/^[Tt]\d+(\.\d+)?[Mm]$/.test(rawStr) || /^[Mm]\d+(\.\d+)?[Tt]$/.test(rawStr)) {
    return rawStr.toUpperCase();
  }

  const rawCostStr = String(cost ?? '').trim();
  if (/^[Tt]\d+(\.\d+)?[Mm]$/.test(rawCostStr) || /^[Mm]\d+(\.\d+)?[Tt]$/.test(rawCostStr)) {
    return rawCostStr.toUpperCase();
  }

  const cleanCurr = String(currency || '').trim().toUpperCase();

  // UZS tekshiruvi:
  // Agar valyuta UZS bo'lsa, yoki cost qiymati >= 1000 bo'lsa (va valyuta aniq USD qilib ko'rsatilmagan bo'lsa)
  const isExplicitUzs = cleanCurr === 'UZS';
  const numericCost = Number(String(cost || '').replace(/\s+/g, ''));
  const isHeuristicUzs = cleanCurr !== 'USD' && !isNaN(numericCost) && numericCost >= 1000;

  if (isExplicitUzs || isHeuristicUzs) {
    const uzsVal = !isNaN(numericCost) && numericCost > 0 ? numericCost : 0;
    if (uzsVal <= 0) return '';

    // 0 larni qirqib, ming so'mda yozish (masalan: 478 000 -> 478, 1 200 000 -> 1200)
    let compactVal;
    if (uzsVal >= 1000) {
      const thousands = uzsVal / 1000;
      compactVal = thousands % 1 === 0 ? String(thousands) : String(Number(thousands.toFixed(1)));
    } else {
      compactVal = uzsVal % 1 === 0 ? String(uzsVal) : String(Number(uzsVal.toFixed(1)));
    }
    return `M${compactVal}T`;
  }

  // USD tekshiruvi:
  const numericUsd = Number(costUsd != null && costUsd !== '' ? costUsd : (cost || ''));
  if (!isNaN(numericUsd) && numericUsd > 0) {
    let usdFormatted;
    if (numericUsd % 1 === 0) {
      usdFormatted = String(numericUsd);
    } else {
      usdFormatted = numericUsd.toFixed(2);
      if (usdFormatted.endsWith('.00')) usdFormatted = usdFormatted.slice(0, -3);
      else if (usdFormatted.endsWith('0')) usdFormatted = usdFormatted.slice(0, -1);
    }
    return `T${usdFormatted}M`;
  }

  return '';
}

/**
 * Format USD cost into clean number string with NO dollar symbol ($)
 */
export function formatDollarFreeCost(value, currency = 'USD') {
  return formatSecretCostCode(value, currency);
}


/**
 * Render a high-contrast label onto an HTMLCanvasElement
 * Supports '40x20' (320x160 px) and '40x30' (320x240 px)
 */
export async function renderDetongerLabelCanvas({
  title = 'Mahsulot',
  color = '',
  date = '',
  code = '',
  costUsd = '',
  cost = '',
  currency = 'USD',
  qrPayload = '',
  storefrontUrl = '',
  labelSize = '40x20',
  width,
  height,
}) {
  const sizeConfig = LABEL_SIZES[labelSize] || LABEL_SIZES['40x20'];
  const canvasWidth = width || sizeConfig.widthPx;
  const canvasHeight = height || sizeConfig.heightPx;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas 2D context mavjud emas");

  // Pure white thermal paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Chalg'ituvchi maxfiy narx kodi: masalan, USD da T90M, UZS da M478T (faqat sotuvchi tushunadi)
  const costStr = formatSecretCostCode({ cost, costUsd, currency });
  const costParam = costStr ? `?c=${encodeURIComponent(costStr)}` : '';

  // Generate QR code target URL / payload
  const defaultBaseUrl = storefrontUrl || 'https://texnobazar-storefront.netlify.app';
  const qrTarget = qrPayload
    ? (costStr && !qrPayload.includes('c=') ? `${qrPayload}${qrPayload.includes('?') ? '&' : '?'}c=${encodeURIComponent(costStr)}` : qrPayload)
    : `${defaultBaseUrl}/qr/${encodeURIComponent(code || '')}${costParam}`;

  const qrDataUrl = await QRCode.toDataURL(qrTarget, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });

  // Load QR image
  const qrImg = new Image();
  await new Promise((resolve, reject) => {
    qrImg.onload = resolve;
    qrImg.onerror = reject;
    qrImg.src = qrDataUrl;
  });

  const displayCode = String(code || '').trim();
  const displayDate = String(date || '').trim() || new Date().toLocaleDateSt  // ==========================================
  // LAYOUT 1: 40x20 mm (320 x 160 px)
  // 60% qismi (chap): Katta QR kod (~144 px)
  // 40% qismi (o'ng): Tovar kodi badge, tannarx ($ siz), sana
  // ==========================================
  if (labelSize === '40x20') {
    // 60% qismga QR kod (144x144 px, o'lchami o'zgarmaydi)
    const qrSize = 144;
    const qrX = 10;
    const qrY = 8;
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

    // O'ng tomon text maydoni: x = 160 dan 312 gacha (kenglik ~152 px)
    const rightX = 160;
    const rightW = canvasWidth - rightX - 8;

    // 1. Tovar nomi va Rangi (shrift kattaroq, pastga surilgan badge evaziga keng bo'sh joy)
    const cleanTitle = String(title || 'Mahsulot').trim();
    const cleanColor = String(color || '').trim();
    const hasColorInTitle = cleanColor && (
      cleanTitle.toLowerCase().includes(`(${cleanColor.toLowerCase()})`) ||
      cleanTitle.toLowerCase().endsWith(cleanColor.toLowerCase())
    );
    const colorSuffix = (cleanColor && !hasColorInTitle) ? ` (${cleanColor})` : '';
    const fullTitle = `${cleanTitle}${colorSuffix}`.trim();

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const badgeY = costStr ? 60 : 72;
    const badgeH = 34;

    let titleFontSize = 13;
    ctx.font = `800 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

    let lines = [];
    if (ctx.measureText(fullTitle).width <= rightW) {
      lines = [fullTitle];
    } else {
      // 2 qatorga sig'dirishga harakat qilamiz (shrift 12.5px dan 10.5px gacha)
      titleFontSize = 12;
      let fitsIn2 = false;
      while (titleFontSize >= 10.5) {
        ctx.font = `800 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        const testLines = wrapTextWithColor(ctx, cleanTitle, cleanColor, rightW, 2);
        const allFit = testLines.every(l => ctx.measureText(l).width <= rightW);
        const hasColorIncluded = !cleanColor || testLines.some(l => l.toLowerCase().includes(cleanColor.toLowerCase()));
        if (allFit && hasColorIncluded && testLines.length <= 2) {
          lines = testLines;
          fitsIn2 = true;
          break;
        }
        titleFontSize -= 0.5;
      }

      // Agar 10.5px da ham 2 qatorga sig'masa, 3 qatorga chiqaramiz (rang va uzun nom to'liq sig'ishi uchun)
      if (!fitsIn2) {
        titleFontSize = 10.5;
        ctx.font = `800 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        lines = wrapTextWithColor(ctx, cleanTitle, cleanColor, rightW, 3);
        while (lines.some(l => ctx.measureText(l).width > rightW) && titleFontSize > 8.5) {
          titleFontSize -= 0.5;
          ctx.font = `800 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          lines = wrapTextWithColor(ctx, cleanTitle, cleanColor, rightW, 3);
        }
      }
    }

    const lineH = Math.round(titleFontSize * 1.34);
    let startY = 8;
    if (lines.length === 1) {
      startY = Math.max(14, Math.round((badgeY - lineH) / 2));
    } else if (lines.length === 2) {
      startY = Math.max(8, Math.round((badgeY - lineH * 2) / 2));
    } else {
      startY = 6;
    }

    lines.forEach((lineText, idx) => {
      ctx.fillText(lineText, rightX, startY + idx * lineH);
    });

    // 2. Tovar kodi badge (pastroqqa surilgan)
    let codeFontSize = 21;
    if (displayCode.length <= 6) {
      codeFontSize = 21;
    } else if (displayCode.length <= 8) {
      codeFontSize = 19;
    } else if (displayCode.length <= 10) {
      codeFontSize = 16;
    } else if (displayCode.length <= 13) {
      codeFontSize = 14;
    } else {
      codeFontSize = 12;
    }

    ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
    while (ctx.measureText(displayCode).width > (rightW - 12) && codeFontSize > 11) {
      codeFontSize -= 1;
      ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
    }

    const badgeX = rightX;
    const badgeW = rightW;

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.0;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 5);
      ctx.stroke();
    } else {
      ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000000';
    ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
    ctx.fillText(displayCode, badgeX + badgeW / 2, badgeY + badgeH / 2);

    // 3. Tannarx (chalg'ituvchi maxfiy kod: T90M yoki M478T - pastroqqa surilgan)
    if (costStr) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000000';
      let costFontSize = 22;
      ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
      while (ctx.measureText(costStr).width > rightW && costFontSize > 15) {
        costFontSize -= 1;
        ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
      }
      ctx.fillText(costStr, rightX, 118);
    }

    // 4. Sana (pastki qismda)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000000';
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(displayDate, rightX, 148);

    return canvas;
  }

  // ==========================================
  // LAYOUT 2: 40x30 mm (320 x 240 px)
  // Yuqorida: Katta QR kod (142x142 px)
  // O'rtada: Tovar nomi (1-2 qator)
  // Pastda: Qidiruv kodi badge, sana va dollar belgisisiz kattaroq tannarx
  // ==========================================
  const qrSize = 142;
  const qrX = Math.round((canvasWidth - qrSize) / 2);
  const qrY = 2;
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // Tovar nomi + Rangi
  const cleanTitle = String(title || 'Mahsulot').trim();
  const cleanColor = String(color || '').trim();
  const hasColorInTitle = cleanColor && (
    cleanTitle.toLowerCase().includes(`(${cleanColor.toLowerCase()})`) ||
    cleanTitle.toLowerCase().endsWith(cleanColor.toLowerCase())
  );
  const colorSuffix = (cleanColor && !hasColorInTitle) ? ` (${cleanColor})` : '';
  const fullTitle = `${cleanTitle}${colorSuffix}`.trim();

  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const titleMaxWidth = canvasWidth - 16;
  let titleFontSize = 13;
  ctx.font = `800 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  while (ctx.measureText(fullTitle).width > titleMaxWidth && titleFontSize > 9.5) {
    titleFontSize -= 0.5;
    ctx.font = `800 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  }

  const lines = wrapTextWithColor(ctx, cleanTitle, cleanColor, titleMaxWidth, 2);

  if (lines.length === 1) {
    ctx.fillText(lines[0], canvasWidth / 2, 165);
  } else if (lines.length >= 2) {
    ctx.fillText(lines[0], canvasWidth / 2, 155);
    ctx.fillText(lines[1], canvasWidth / 2, 170);
  }

  // Pastki qator: Qidiruv kodi badge (o'ngda)
  let codeFontSize = 26;
  if (displayCode.length <= 6) {
    codeFontSize = 26;
  } else if (displayCode.length <= 8) {
    codeFontSize = 23;
  } else if (displayCode.length <= 11) {
    codeFontSize = 20;
  } else if (displayCode.length <= 15) {
    codeFontSize = 17;
  } else {
    codeFontSize = 14;
  }

  ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  while (ctx.measureText(displayCode).width > 125 && codeFontSize > 11) {
    codeFontSize -= 1;
    ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  }

  const codeTextWidth = ctx.measureText(displayCode).width;
  const badgeW = Math.min(145, Math.max(90, Math.round(codeTextWidth + 24)));
  const badgeH = 46;
  const badgeX = canvasWidth - badgeW - 10;
  const badgeY = 180;

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.0;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    ctx.stroke();
  } else {
    ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000000';
  ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  ctx.fillText(displayCode, badgeX + badgeW / 2, badgeY + badgeH / 2);

  // Sana va Tannarx ($ siz) chap tomonda
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Sana: ${displayDate}`, 12, badgeY + 16);

  if (costStr) {
    let costFontSize = 22;
    ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
    ctx.fillText(costStr, 12, badgeY + 41);
  }

  return canvas;
}

/**
 * Detonger Bluetooth Printer Controller
 */
export class DetongerBluetoothClient {
  constructor(options = {}) {
    this.namePrefix = options.namePrefix || 'P';
    this.paperWidth = options.paperWidth || LABEL_WIDTH_MM;
    this.printer = null;
    this.status = 'disconnected';
    this.deviceName = null;
    this.battery = null;
    this.listeners = new Set();
    this._cancelled = false;
  }

  cancelPrint() {
    this._cancelled = true;
    this.emit({ type: 'print_cancelled' });
  }

  isCancelled() {
    return Boolean(this._cancelled);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(data) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (err) {
        console.error("Detonger listener error:", err);
      }
    }
  }

  isConnected() {
    return this.printer ? this.printer.isConnected() : false;
  }

  getStatus() {
    return this.status;
  }

  getDeviceName() {
    return this.deviceName;
  }

  /**
   * Connect to Detonger printer via Web Bluetooth
   */
  async connect(prefix = this.namePrefix) {
    if (!isWebBluetoothSupported()) {
      throw new Error("Ushbu brauzerda Web Bluetooth qo‘llab-quvvatlanmaydi. Google Chrome (Android/PC) yoki Bluefy (iOS) dan foydalaning.");
    }

    this.namePrefix = prefix;
    this.status = 'connecting';
    this.emit({ type: 'status', status: 'connecting' });

    try {
      // Initialize DothanTechPrinter
      const config = {
        namePrefix: prefix === 'ALL' ? '' : prefix,
        paperWidth: this.paperWidth,
        debug: false,
      };

      this.printer = new DothanTechPrinter(config);

      // Listen for status changes
      this.printer.onStatusChange((newStatus) => {
        this.status = newStatus;
        this.emit({ type: 'status', status: newStatus, deviceName: this.deviceName });
      });

      this.printer.onError((err) => {
        this.emit({ type: 'error', error: err?.message || String(err) });
      });

      await this.printer.connect();

      this.deviceName = this.printer.getDeviceName() || 'Detonger Termoprinter';
      this.status = 'connected';

      // Query printer parameters (DPI, battery, density)
      try {
        await this.printer.refreshPrinterStatus({ minimal: true });
        const st = this.printer.getPrinterStatus();
        if (st) {
          this.deviceName = st.deviceName || this.deviceName;
        }
      } catch {
        // Parameter refresh is non-blocking
      }

      this.emit({
        type: 'connected',
        status: 'connected',
        deviceName: this.deviceName,
      });

      return { success: true, deviceName: this.deviceName };
    } catch (error) {
      this.status = 'error';
      this.emit({ type: 'status', status: 'error', error: error?.message || 'Ulanishda xatolik' });
      throw error;
    }
  }

  /**
   * Disconnect from printer
   */
  async disconnect() {
    if (this.printer) {
      try {
        await this.printer.disconnect();
      } catch (err) {
        console.warn("Disconnect error:", err);
      }
    }
    this.status = 'disconnected';
    this.deviceName = null;
    this.emit({ type: 'status', status: 'disconnected', deviceName: null });
  }

  /**
   * Print a single canvas element to the printer
   */
  async printCanvas(canvas) {
    if (!this.printer || !this.isConnected()) {
      throw new Error("Printer ulanmagan. Avval Bluetooth orqali ulang.");
    }

    return await this.printer.printCanvas(canvas, {
      maxWidth: this.paperWidth,
      ditherMethod: 'none',
      threshold: 128,
    });
  }

  /**
   * Print a list of labels with progress tracking
   * @param {Array} labels - Array of label objects
   * @param {Object} options - { copies: 1, onProgress: (current, total, label) => {}, signal: AbortSignal }
   */
  async printLabels(labels, options = {}) {
    if (!this.printer || !this.isConnected()) {
      throw new Error("Printer ulanmagan. Avval Bluetooth orqali ulang.");
    }

    if (!labels || !labels.length) {
      throw new Error("Chop etish uchun yorliqlar topilmadi.");
    }

    this._cancelled = false;
    const copies = Math.max(1, Math.min(1000, Number(options.copies || 1)));
    const totalCount = labels.length * copies;
    let completed = 0;

    this.emit({ type: 'print_start', total: totalCount });

    for (let i = 0; i < labels.length; i++) {
      if (this._cancelled || options.signal?.aborted) {
        this.emit({ type: 'print_cancelled', completed, total: totalCount });
        return { success: false, cancelled: true, printedCount: completed };
      }

      const item = labels[i];

      const labelSize = options.labelSize || item.labelSize || '40x20';
      const costUsd = item.cost_usd || item.unit_cost_usd || item.costUsd || item.cost_price_usd || '';
      const cost = item.cost || item.unit_cost || item.cost_price || '';
      const currency = item.currency || '';

      // Render label on canvas
      const canvas = await renderDetongerLabelCanvas({
        title: item.title || item.product_name || 'Mahsulot',
        color: item.color || item.variant_color || '',
        date: item.date || item.received_at || '',
        code: item.code || item.qr_code || '',
        costUsd,
        cost,
        currency,
        qrPayload: item.qrPayload || '',
        storefrontUrl: options.storefrontUrl || '',
        labelSize,
      });

      for (let c = 0; c < copies; c++) {
        if (this._cancelled || options.signal?.aborted) {
          this.emit({ type: 'print_cancelled', completed, total: totalCount });
          return { success: false, cancelled: true, printedCount: completed };
        }

        completed++;
        if (options.onProgress) {
          options.onProgress(completed, totalCount, item);
        }
        this.emit({ type: 'progress', current: completed, total: totalCount, item });

        await this.printCanvas(canvas);

        // Small interruptible delay between labels for thermal head gap sensing & cooling
        if (completed < totalCount) {
          const delayMs = 350;
          const start = Date.now();
          while (Date.now() - start < delayMs) {
            if (this._cancelled || options.signal?.aborted) {
              this.emit({ type: 'print_cancelled', completed, total: totalCount });
              return { success: false, cancelled: true, printedCount: completed };
            }
            await new Promise(r => setTimeout(r, 35));
          }
        }
      }
    }

    if (this._cancelled || options.signal?.aborted) {
      this.emit({ type: 'print_cancelled', completed, total: totalCount });
      return { success: false, cancelled: true, printedCount: completed };
    }

    this.emit({ type: 'print_complete', total: totalCount });
    return { success: true, printedCount: totalCount };
  }

  /**
   * Feed paper lines
   */
  async feedLines(n = 2) {
    if (this.printer && this.isConnected()) {
      await this.printer.feedLines(n);
    }
  }
}

// Global singleton instance for shared connection across workspaces
export const detongerClient = new DetongerBluetoothClient();
