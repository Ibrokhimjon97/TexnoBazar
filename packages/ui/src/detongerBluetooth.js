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
 * Format USD cost into clean number string with NO dollar symbol ($)
 */
export function formatDollarFreeCost(value) {
  if (value == null || value === '') return '';
  const num = Number(value);
  if (isNaN(num) || num <= 0) return '';
  return num % 1 === 0 ? String(num) : num.toFixed(2);
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

  // Clean dollar-free cost number string (hech qanday $ yoki USD belgisi bo'lmaydi)
  const costStr = formatDollarFreeCost(costUsd);
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

    // 1. Tovar nomi (1 qator ixcham)
    const fullTitle = `${title}${color ? ` (${color})` : ''}`.trim();
    ctx.fillStyle = '#000000';
    ctx.font = '800 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lines = wrapTextLines(ctx, fullTitle, rightW, 1);
    if (lines.length > 0) {
      ctx.fillText(lines[0], rightX, 10);
    }

    // 2. Tovar kodi (QR o'qilmasa terib izlanadigan kod) - kattaroq shriftli ramka
    let codeFontSize = 24;
    if (displayCode.length <= 6) {
      codeFontSize = 24;
    } else if (displayCode.length <= 8) {
      codeFontSize = 21;
    } else if (displayCode.length <= 10) {
      codeFontSize = 19;
    } else if (displayCode.length <= 13) {
      codeFontSize = 16;
    } else {
      codeFontSize = 13;
    }

    ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
    while (ctx.measureText(displayCode).width > (rightW - 12) && codeFontSize > 11) {
      codeFontSize -= 1;
      ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
    }

    const badgeX = rightX;
    const badgeY = 26;
    const badgeW = rightW;
    const badgeH = 36;

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

    // 3. Tannarx (dollar belgisisiz, bo'sh joyga mos kattaroq va ko'rinarli raqam)
    if (costStr) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000000';
      let costFontSize = 24;
      ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
      while (ctx.measureText(costStr).width > rightW && costFontSize > 15) {
        costFontSize -= 1;
        ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
      }
      ctx.fillText(costStr, rightX, 98);
    }

    // 4. Sana (pastki qismda)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000000';
    ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(displayDate, rightX, 146);

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
  const fullTitle = `${title}${color ? ` (${color})` : ''}`.trim();
  ctx.fillStyle = '#000000';
  ctx.font = '800 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const titleMaxWidth = canvasWidth - 16;
  const lines = wrapTextLines(ctx, fullTitle, titleMaxWidth, 2);

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
   * @param {Object} options - { copies: 1, onProgress: (current, total, label) => {} }
   */
  async printLabels(labels, options = {}) {
    if (!this.printer || !this.isConnected()) {
      throw new Error("Printer ulanmagan. Avval Bluetooth orqali ulang.");
    }

    if (!labels || !labels.length) {
      throw new Error("Chop etish uchun yorliqlar topilmadi.");
    }

    const copies = Math.max(1, Math.min(1000, Number(options.copies || 1)));
    const totalCount = labels.length * copies;
    let completed = 0;

    this.emit({ type: 'print_start', total: totalCount });

    for (let i = 0; i < labels.length; i++) {
      const item = labels[i];

      const labelSize = options.labelSize || item.labelSize || '40x20';
      const costUsd = item.cost_usd || item.unit_cost_usd || item.costUsd || item.cost_price_usd || '';

      // Render label on canvas
      const canvas = await renderDetongerLabelCanvas({
        title: item.title || item.product_name || 'Mahsulot',
        color: item.color || item.variant_color || '',
        date: item.date || item.received_at || '',
        code: item.code || item.qr_code || '',
        costUsd,
        qrPayload: item.qrPayload || '',
        storefrontUrl: options.storefrontUrl || '',
        labelSize,
      });

      for (let c = 0; c < copies; c++) {
        completed++;
        if (options.onProgress) {
          options.onProgress(completed, totalCount, item);
        }
        this.emit({ type: 'progress', current: completed, total: totalCount, item });

        await this.printCanvas(canvas);

        // Small delay between labels for thermal head gap sensing & cooling
        if (completed < totalCount) {
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      }
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
