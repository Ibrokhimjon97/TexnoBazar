/**
 * MHT-L80G Bluetooth Thermal Label Printer Driver for Texnobazar
 * Designed for 58x40 mm thermal sticker labels via Web Bluetooth API (BLE)
 * Commands: TSPL (TSC Page Language)
 * Supports mobile phones (Android Chrome / iOS Bluefy) and PC (Chrome / Edge)
 */
import QRCode from 'qrcode';

export const MHT_LABEL_WIDTH_MM = 58;
export const MHT_LABEL_HEIGHT_MM = 40;
export const MHT_LABEL_DPI = 203; // 8 dots/mm
export const MHT_CANVAS_WIDTH_PX = 464; // 58mm * 8 dots/mm = 464px
export const MHT_CANVAS_HEIGHT_PX = 320; // 40mm * 8 dots/mm = 320px

export const MHT_PREFIX_PRESETS = [
  { id: 'MHT', label: 'MHT seriyasi (MHT-L80G, MHT-L1091)' },
  { id: 'L80', label: 'L80 / L80G seriyasi' },
  { id: 'Printer', label: 'Printer / Thermal Printer' },
  { id: 'POS', label: 'POS Printer' },
  { id: 'ALL', label: 'Barcha Bluetooth qurilmalar (All Devices)' },
];

// Common Bluetooth BLE Service UUIDs used by thermal printers
export const KNOWN_PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Standard Printer service
  '0000e0ff-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC transparent UART (most common)
  '0000ff00-0000-1000-8000-00805f9b34fb', // MHT / Milestone / Xprinter
  '0000fee7-0000-1000-8000-00805f9b34fb', // Tencent / WeChat BLE
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000af30-0000-1000-8000-00805f9b34fb',
];

import { formatDollarFreeCost } from './detongerBluetooth.js';


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
 * Render a high-contrast 58x40 mm (464x320 px) label onto an HTMLCanvasElement
 * Optimized for MHT-L80G with large QR code and detailed product info
 */
export async function renderMhtLabelCanvas({
  title = 'Mahsulot',
  color = '',
  date = '',
  code = '',
  costUsd = '',
  qrPayload = '',
  storefrontUrl = '',
  width = MHT_CANVAS_WIDTH_PX,
  height = MHT_CANVAS_HEIGHT_PX,
}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas 2D context mavjud emas");

  // Pure white thermal paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Clean dollar-free cost number string ($ siz toza raqam)
  const costStr = formatDollarFreeCost(costUsd);
  const costParam = costStr ? `?c=${encodeURIComponent(costStr)}` : '';

  // Generate QR code target URL / payload
  const defaultBaseUrl = storefrontUrl || 'https://texnobazar-storefront.netlify.app';
  const qrTarget = qrPayload
    ? (costStr && !qrPayload.includes('c=') ? `${qrPayload}${qrPayload.includes('?') ? '&' : '?'}c=${encodeURIComponent(costStr)}` : qrPayload)
    : `${defaultBaseUrl}/qr/${encodeURIComponent(code || '')}${costParam}`;

  const qrDataUrl = await QRCode.toDataURL(qrTarget, {
    width: 320,
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
  const displayDate = String(date || '').trim() || new Date().toLocaleDateString('uz-UZ');

  // ==========================================
  // 58 x 40 mm (464 x 320 dots) Layout:
  // KATTA QR KOD: 250 x 250 dots (chap tomonda)
  // O'NG TOMON (~190 dots): Tovar nomi, ramkali kod, tannarx ($ siz), sana
  // ==========================================
  const qrSize = 252;
  const qrX = 12;
  const qrY = Math.round((height - qrSize) / 2); // 34
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  // O'ng tomon text maydoni
  const rightX = 276;
  const rightW = width - rightX - 12; // ~176px

  // 1. Tovar nomi + Rangi (1-2 qator)
  const fullTitle = `${title}${color ? ` (${color})` : ''}`.trim();
  ctx.fillStyle = '#000000';
  ctx.font = '800 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  const lines = wrapTextLines(ctx, fullTitle, rightW, 2);

  let curY = 32;
  if (lines.length === 1) {
    ctx.fillText(lines[0], rightX, curY);
    curY += 20;
  } else if (lines.length >= 2) {
    ctx.fillText(lines[0], rightX, curY);
    ctx.fillText(lines[1], rightX, curY + 16);
    curY += 36;
  }

  // 2. Tovar qidiruv kodi (kamera tanimasa terib qidiriladigan kod) - KATTA RAMKALI BADGE
  let codeFontSize = 30;
  if (displayCode.length <= 6) {
    codeFontSize = 30;
  } else if (displayCode.length <= 8) {
    codeFontSize = 26;
  } else if (displayCode.length <= 11) {
    codeFontSize = 22;
  } else if (displayCode.length <= 15) {
    codeFontSize = 18;
  } else {
    codeFontSize = 15;
  }

  ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  while (ctx.measureText(displayCode).width > (rightW - 14) && codeFontSize > 12) {
    codeFontSize -= 1;
    ctx.font = `900 ${codeFontSize}px "Courier New", monospace`;
  }

  const badgeX = rightX;
  const badgeY = curY;
  const badgeW = rightW;
  const badgeH = 52;

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.2;
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

  // 3. Tannarx (dollar belgisisiz, kattaroq USD raqami)
  curY = badgeY + badgeH + 32;
  if (costStr) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000000';
    let costFontSize = 30;
    ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
    while (ctx.measureText(costStr).width > rightW && costFontSize > 18) {
      costFontSize -= 1;
      ctx.font = `900 ${costFontSize}px "Courier New", monospace`;
    }
    ctx.fillText(costStr, rightX, curY);
    curY += 34;
  } else {
    curY += 14;
  }

  // 4. Sana
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000000';
  ctx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Sana: ${displayDate}`, rightX, curY);

  return canvas;
}

/**
 * Convert HTMLCanvasElement into TSPL BITMAP binary stream (MHT format)
 * MHT TSPL command specification:
 * SIZE 58 mm, 40 mm
 * GAP 2 mm, 0 mm
 * DIRECTION 1
 * CLS
 * BITMAP 0,0,width_in_bytes,height_in_dots,0,bitmap_data...
 * PRINT 1,1
 */
export function convertCanvasToTsplData(canvas, copies = 1) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas context mavjud emas");

  const imgData = ctx.getImageData(0, 0, width, height).data;
  const widthBytes = Math.ceil(width / 8);

  // Monochrome binarization: 8 pixels -> 1 byte (bit 0 = black, bit 1 = white)
  const bitmap = new Uint8Array(widthBytes * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const gray = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
      const isBlack = gray <= 128;

      const byteIdx = y * widthBytes + (x >> 3);
      const bitIdx = 7 - (x % 8);

      if (isBlack) {
        // Bit 0 = black in TSPL mode 0
        // (Default Uint8Array is 0, so if black, clear bit; if white, set bit)
      } else {
        bitmap[byteIdx] |= (1 << bitIdx);
      }
    }
  }

  // Build TSPL command stream
  const headerStr = `SIZE 58 mm,40 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,${widthBytes},${height},0,`;
  const footerStr = `\r\nPRINT ${Math.max(1, copies)},1\r\n`;

  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(headerStr);
  const footerBytes = encoder.encode(footerStr);

  const totalLength = headerBytes.length + bitmap.length + footerBytes.length;
  const result = new Uint8Array(totalLength);

  result.set(headerBytes, 0);
  result.set(bitmap, headerBytes.length);
  result.set(footerBytes, headerBytes.length + bitmap.length);

  return result;
}

/**
 * MHT Bluetooth BLE Client
 */
export class MhtBluetoothClient {
  constructor(options = {}) {
    this.namePrefix = options.namePrefix || 'MHT';
    this.device = null;
    this.server = null;
    this.writeCharacteristic = null;
    this.status = 'disconnected';
    this.deviceName = null;
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
        console.error("MHT listener error:", err);
      }
    }
  }

  isConnected() {
    return Boolean(this.device && this.device.gatt && this.device.gatt.connected && this.writeCharacteristic);
  }

  getStatus() {
    return this.status;
  }

  getDeviceName() {
    return this.deviceName;
  }

  /**
   * Connect to MHT printer via Web Bluetooth
   */
  async connect(prefix = this.namePrefix) {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      throw new Error("Ushbu brauzerda Web Bluetooth qo‘llab-quvvatlanmaydi. Google Chrome (Android/PC) yoki Bluefy (iOS) dan foydalaning.");
    }

    this.namePrefix = prefix;
    this.status = 'connecting';
    this.emit({ type: 'status', status: 'connecting' });

    try {
      // Build request options
      const filters = [];
      if (prefix && prefix !== 'ALL') {
        filters.push({ namePrefix: prefix });
      } else {
        // Broad search for thermal printers
        filters.push({ namePrefix: 'MHT' });
        filters.push({ namePrefix: 'L80' });
        filters.push({ namePrefix: 'Printer' });
        filters.push({ namePrefix: 'POS' });
        filters.push({ namePrefix: 'BT' });
        filters.push({ namePrefix: 'Milestone' });
      }

      const requestOptions = {
        optionalServices: KNOWN_PRINTER_SERVICES,
      };

      if (prefix === 'ALL') {
        requestOptions.acceptAllDevices = true;
      } else {
        requestOptions.filters = filters;
      }

      this.device = await navigator.bluetooth.requestDevice(requestOptions);

      this.device.addEventListener('gattserverdisconnected', () => {
        this.status = 'disconnected';
        this.deviceName = null;
        this.writeCharacteristic = null;
        this.emit({ type: 'status', status: 'disconnected', deviceName: null });
      });

      this.server = await this.device.gatt.connect();
      this.deviceName = this.device.name || 'MHT-L80G Termoprinter';

      // Discover writable characteristic among known services
      let foundChar = null;

      for (const serviceUuid of KNOWN_PRINTER_SERVICES) {
        try {
          const service = await this.server.getPrimaryService(serviceUuid);
          const characteristics = await service.getCharacteristics();
          for (const char of characteristics) {
            if (char.properties.write || char.properties.writeWithoutResponse) {
              foundChar = char;
              break;
            }
          }
        } catch {
          // Continue to next service
        }
        if (foundChar) break;
      }

      // Fallback: discover any primary service if known ones failed
      if (!foundChar) {
        const services = await this.server.getPrimaryServices();
        for (const service of services) {
          try {
            const characteristics = await service.getCharacteristics();
            for (const char of characteristics) {
              if (char.properties.write || char.properties.writeWithoutResponse) {
                foundChar = char;
                break;
              }
            }
          } catch {}
          if (foundChar) break;
        }
      }

      if (!foundChar) {
        throw new Error("Printerda yozish (write) xarakteristikasi topilmadi.");
      }

      this.writeCharacteristic = foundChar;
      this.status = 'connected';

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
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      try {
        this.device.gatt.disconnect();
      } catch (err) {
        console.warn("MHT disconnect error:", err);
      }
    }
    this.status = 'disconnected';
    this.deviceName = null;
    this.writeCharacteristic = null;
    this.emit({ type: 'status', status: 'disconnected', deviceName: null });
  }

  /**
   * Write raw binary buffer to Bluetooth characteristic in safe chunks
   */
  async writeDataInChunks(dataBuffer, chunkSize = 128) {
    if (!this.writeCharacteristic) {
      throw new Error("Printer ulanmagan.");
    }

    const total = dataBuffer.length;
    let offset = 0;

    while (offset < total) {
      const end = Math.min(offset + chunkSize, total);
      const chunk = dataBuffer.slice(offset, end);

      if (this.writeCharacteristic.writeValueWithoutResponse) {
        await this.writeCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await this.writeCharacteristic.writeValue(chunk);
      }

      offset = end;
      // Small pause between BLE packets to prevent buffer overflow
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }

  /**
   * Print a single canvas element to MHT printer
   */
  async printCanvas(canvas, copies = 1) {
    if (!this.isConnected()) {
      throw new Error("MHT-L80G printer ulanmagan. Avval Bluetooth orqali ulang.");
    }

    const tsplData = convertCanvasToTsplData(canvas, copies);
    await this.writeDataInChunks(tsplData);
  }

  /**
   * Print a list of labels on MHT-L80G
   */
  async printLabels(labels, options = {}) {
    if (!this.isConnected()) {
      throw new Error("MHT-L80G printer ulanmagan. Avval Bluetooth orqali ulang.");
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

      const canvas = await renderMhtLabelCanvas({
        title: item.title || item.product_name || 'Mahsulot',
        color: item.color || item.variant_color || '',
        date: item.date || item.received_at || '',
        code: item.code || item.qr_code || '',
        costUsd: item.cost_usd || item.unit_cost_usd || item.costUsd || item.cost_price_usd || '',
        qrPayload: item.qrPayload || '',
        storefrontUrl: options.storefrontUrl || '',
      });

      for (let c = 0; c < copies; c++) {
        completed++;
        if (options.onProgress) {
          options.onProgress(completed, totalCount, item);
        }
        this.emit({ type: 'progress', current: completed, total: totalCount, item });

        await this.printCanvas(canvas, 1);

        // Small delay between labels for thermal head gap sensing
        if (completed < totalCount) {
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      }
    }

    this.emit({ type: 'print_complete', total: totalCount });
    return { success: true, printedCount: totalCount };
  }
}

// Global singleton instance for shared MHT connection across workspaces
export const mhtClient = new MhtBluetoothClient();
