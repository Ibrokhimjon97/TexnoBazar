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
function wrapTextLines(ctx, text, maxWidth) {
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
      if (lines.length >= 2) break; // Limit to 2 lines max
    }
  }
  lines.push(currentLine);
  return lines.slice(0, 2);
}

/**
 * Render a high-contrast 40x30 mm (320x240 px) label onto an HTMLCanvasElement
 */
export async function renderDetongerLabelCanvas({
  title = 'Mahsulot',
  color = '',
  date = '',
  code = '',
  qrPayload = '',
  storefrontUrl = '',
  width = CANVAS_WIDTH_PX,
  height = CANVAS_HEIGHT_PX,
}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas 2D context mavjud emas");

  // Pure white thermal paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Generate QR code data URL
  const qrTarget = qrPayload || (
    (storefrontUrl || 'https://texnobazar-storefront.netlify.app') + '/qr/' + encodeURIComponent(code || '')
  );

  const qrDataUrl = await QRCode.toDataURL(qrTarget, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });

  // Load and draw QR code onto canvas
  const qrImg = new Image();
  await new Promise((resolve, reject) => {
    qrImg.onload = resolve;
    qrImg.onerror = reject;
    qrImg.src = qrDataUrl;
  });

  // Layout for 40x30 mm (320x240 dots)
  // Large QR Code: 142x142 dots, centered horizontally at top
  const qrSize = 142;
  const qrX = Math.round((width - qrSize) / 2);
  const qrY = 2;
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // Product title + Color (large, positioned comfortably lower)
  const fullTitle = `${title}${color ? ` (${color})` : ''}`.trim();
  ctx.fillStyle = '#000000';
  ctx.font = '800 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';

  const titleMaxWidth = width - 16;
  const lines = wrapTextLines(ctx, fullTitle, titleMaxWidth);

  if (lines.length === 1) {
    ctx.fillText(lines[0], width / 2, 165);
  } else if (lines.length >= 2) {
    ctx.fillText(lines[0], width / 2, 155);
    ctx.fillText(lines[1], width / 2, 170);
  }

  // Bottom row: Sana (Date on left) and Maxsus Kod (Search Code on right in bold badge)
  const displayCode = String(code || '').trim();
  let codeFontSize = 24;
  if (displayCode.length <= 6) {
    codeFontSize = 24;
  } else if (displayCode.length <= 8) {
    codeFontSize = 21;
  } else if (displayCode.length <= 11) {
    codeFontSize = 18;
  } else if (displayCode.length <= 15) {
    codeFontSize = 15;
  } else {
    codeFontSize = 12;
  }

  ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  while (ctx.measureText(displayCode).width > 125 && codeFontSize > 10) {
    codeFontSize -= 1;
    ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  }

  const codeTextWidth = ctx.measureText(displayCode).width;
  const badgeW = Math.min(145, Math.max(90, Math.round(codeTextWidth + 24)));
  const badgeH = 44;
  const badgeX = width - badgeW - 10;
  const badgeY = 182;

  // Crisp rounded border badge for the manual search code
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.8;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    ctx.stroke();
  } else {
    ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
  }

  // Draw the manual search code inside badge
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000000';
  ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  ctx.fillText(displayCode, badgeX + badgeW / 2, badgeY + 29);

  // Sana (Date) on the left
  ctx.textAlign = 'left';
  ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const displayDate = String(date || '').trim() || new Date().toLocaleDateString('uz-UZ');
  ctx.fillText(`Sana: ${displayDate}`, 12, badgeY + 27);

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

      // Render 40x30 mm label on canvas
      const canvas = await renderDetongerLabelCanvas({
        title: item.title || item.product_name || 'Mahsulot',
        color: item.color || item.variant_color || '',
        date: item.date || item.received_at || '',
        code: item.code || item.qr_code || '',
        qrPayload: item.qrPayload || '',
        storefrontUrl: options.storefrontUrl || '',
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
