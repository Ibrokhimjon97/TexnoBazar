import React, { useState, useEffect, useRef } from 'react';
import {
  Printer,
  Bluetooth,
  BluetoothOff,
  BluetoothConnected,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Settings2,
  Smartphone,
  Copy,
  Layers,
  X,
  FileText,
  Sliders,
  Sparkles
} from 'lucide-react';
import {
  detongerClient,
  isWebBluetoothSupported,
  getBluetoothEnvironmentInfo,
  renderDetongerLabelCanvas,
  DETONGER_PREFIX_PRESETS,
  LABEL_SIZES,
  CANVAS_WIDTH_PX,
  CANVAS_HEIGHT_PX,
} from './detongerBluetooth';
import {
  mhtClient,
  renderMhtLabelCanvas,
  MHT_PREFIX_PRESETS,
  MHT_LABEL_WIDTH_MM,
  MHT_LABEL_HEIGHT_MM,
  MHT_CANVAS_WIDTH_PX,
  MHT_CANVAS_HEIGHT_PX,
} from './mhtBluetooth';

export function DetongerPrintModal({
  open,
  onClose,
  labels = [],
  batchTitle = '',
  receiptDate = '',
  onClassicPrint,
  initialPrinter,
}) {
  const [envInfo, setEnvInfo] = useState(() => getBluetoothEnvironmentInfo());

  // Active printer selection: 'detonger' | 'mht'
  const [selectedPrinter, setSelectedPrinter] = useState(() => {
    if (initialPrinter) return initialPrinter;
    try {
      return localStorage.getItem('texnobazar_selected_thermal_printer') || 'detonger';
    } catch {
      return 'detonger';
    }
  });

  useEffect(() => {
    if (open && initialPrinter) {
      setSelectedPrinter(initialPrinter);
    }
  }, [open, initialPrinter]);

  const handlePrinterChange = (printer) => {
    setSelectedPrinter(printer);
    try {
      localStorage.setItem('texnobazar_selected_thermal_printer', printer);
    } catch {}
    setError('');
    setSuccessMsg('');
  };

  // Detonger status
  const [detongerStatus, setDetongerStatus] = useState(() => detongerClient.getStatus());
  const [detongerDeviceName, setDetongerDeviceName] = useState(() => detongerClient.getDeviceName());
  const [detongerPrefix, setDetongerPrefix] = useState('P');

  // MHT-L80G status
  const [mhtStatus, setMhtStatus] = useState(() => mhtClient.getStatus());
  const [mhtDeviceName, setMhtDeviceName] = useState(() => mhtClient.getDeviceName());
  const [mhtPrefix, setMhtPrefix] = useState('MHT');

  const [connecting, setConnecting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Detonger Paper Size: '40x20' (default 40x20 mm) | '40x30' (40x30 mm)
  const [labelSize, setLabelSize] = useState(() => {
    try {
      return localStorage.getItem('texnobazar_detonger_label_size') || '40x20';
    } catch {
      return '40x20';
    }
  });

  const handleSizeChange = (newSize) => {
    setLabelSize(newSize);
    try {
      localStorage.setItem('texnobazar_detonger_label_size', newSize);
    } catch {}
  };

  // Selection & Copies
  const [printScope, setPrintScope] = useState('all'); // 'all' | 'single'
  const [currentIndex, setCurrentIndex] = useState(0);
  const [copies, setCopies] = useState(1);

  // Sync initial copies and scope when modal opens
  useEffect(() => {
    if (open) {
      setCurrentIndex(0);
      const first = labels[0];
      const initialCopies = Number(first?.quantity) || 1;
      setCopies(initialCopies > 0 ? initialCopies : 1);
      if (labels.length === 1) {
        setPrintScope('single');
      } else {
        setPrintScope('all');
      }
    }
  }, [open]);

  useEffect(() => {
    if (open && printScope === 'single' && labels[currentIndex]?.quantity) {
      setCopies(Math.max(1, Number(labels[currentIndex].quantity) || 1));
    }
  }, [currentIndex, printScope]);

  // Printing state
  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: null });

  // Canvas preview ref
  const previewCanvasRef = useRef(null);

  // Sync Detonger client events
  useEffect(() => {
    setEnvInfo(getBluetoothEnvironmentInfo());
    setDetongerStatus(detongerClient.getStatus());
    setDetongerDeviceName(detongerClient.getDeviceName());

    const unsubDetonger = detongerClient.subscribe((event) => {
      if (event.type === 'status') {
        setDetongerStatus(event.status);
        if (event.deviceName) setDetongerDeviceName(event.deviceName);
        if (event.error && selectedPrinter === 'detonger') setError(event.error);
      } else if (event.type === 'connected') {
        setDetongerStatus('connected');
        setDetongerDeviceName(event.deviceName);
        if (selectedPrinter === 'detonger') {
          setError('');
          setSuccessMsg(`"${event.deviceName}" ga muvaffaqiyatli ulandi!`);
        }
      } else if (event.type === 'progress' && selectedPrinter === 'detonger') {
        setProgress({ current: event.current, total: event.total, label: event.item });
      } else if (event.type === 'print_complete' && selectedPrinter === 'detonger') {
        setPrinting(false);
        setSuccessMsg(`${event.total} ta yorliq muvaffaqiyatli chop etildi!`);
      } else if (event.type === 'error' && selectedPrinter === 'detonger') {
        setError(event.error);
        setPrinting(false);
      }
    });

    // Sync MHT-L80G client events
    setMhtStatus(mhtClient.getStatus());
    setMhtDeviceName(mhtClient.getDeviceName());

    const unsubMht = mhtClient.subscribe((event) => {
      if (event.type === 'status') {
        setMhtStatus(event.status);
        if (event.deviceName) setMhtDeviceName(event.deviceName);
        if (event.error && selectedPrinter === 'mht') setError(event.error);
      } else if (event.type === 'connected') {
        setMhtStatus('connected');
        setMhtDeviceName(event.deviceName);
        if (selectedPrinter === 'mht') {
          setError('');
          setSuccessMsg(`"${event.deviceName}" ga muvaffaqiyatli ulandi!`);
        }
      } else if (event.type === 'progress' && selectedPrinter === 'mht') {
        setProgress({ current: event.current, total: event.total, label: event.item });
      } else if (event.type === 'print_complete' && selectedPrinter === 'mht') {
        setPrinting(false);
        setSuccessMsg(`${event.total} ta yorliq muvaffaqiyatli chop etildi!`);
      } else if (event.type === 'error' && selectedPrinter === 'mht') {
        setError(event.error);
        setPrinting(false);
      }
    });

    return () => {
      unsubDetonger();
      unsubMht();
    };
  }, [open, selectedPrinter]);

  // Update canvas preview when currentIndex, labels, receiptDate, printer or labelSize change
  useEffect(() => {
    if (!open || !labels.length) return;
    const item = labels[currentIndex] || labels[0];
    if (!item) return;

    let isMounted = true;
    const title = item.title || item.product_name || 'Mahsulot';
    const color = item.color || item.variant_color || '';
    const date = item.date || item.received_at || receiptDate || new Date().toLocaleDateString('uz-UZ');
    const code = item.code || item.qr_code || '';
    const costUsd = item.cost_usd || item.unit_cost_usd || item.costUsd || item.cost_price_usd || '';
    const qrPayload = item.qrPayload || '';

    if (selectedPrinter === 'mht') {
      // MHT-L80G: 58x40 mm (464x320 px)
      renderMhtLabelCanvas({
        title,
        color,
        date,
        code,
        costUsd,
        qrPayload,
        width: MHT_CANVAS_WIDTH_PX,
        height: MHT_CANVAS_HEIGHT_PX,
      }).then((canvas) => {
        if (!isMounted || !previewCanvasRef.current) return;
        const targetCanvas = previewCanvasRef.current;
        targetCanvas.width = MHT_CANVAS_WIDTH_PX;
        targetCanvas.height = MHT_CANVAS_HEIGHT_PX;
        const ctx = targetCanvas.getContext('2d');
        ctx.clearRect(0, 0, MHT_CANVAS_WIDTH_PX, MHT_CANVAS_HEIGHT_PX);
        ctx.drawImage(canvas, 0, 0);
      }).catch((err) => {
        console.error("MHT preview render error:", err);
      });
    } else {
      // Detonger: 40x20 or 40x30 mm
      const sizeConfig = LABEL_SIZES[labelSize] || LABEL_SIZES['40x20'];
      renderDetongerLabelCanvas({
        title,
        color,
        date,
        code,
        costUsd,
        qrPayload,
        labelSize,
        width: sizeConfig.widthPx,
        height: sizeConfig.heightPx,
      }).then((canvas) => {
        if (!isMounted || !previewCanvasRef.current) return;
        const targetCanvas = previewCanvasRef.current;
        targetCanvas.width = sizeConfig.widthPx;
        targetCanvas.height = sizeConfig.heightPx;
        const ctx = targetCanvas.getContext('2d');
        ctx.clearRect(0, 0, sizeConfig.widthPx, sizeConfig.heightPx);
        ctx.drawImage(canvas, 0, 0);
      }).catch((err) => {
        console.error("Detonger preview render error:", err);
      });
    }

    return () => { isMounted = false; };
  }, [open, currentIndex, labels, receiptDate, selectedPrinter, labelSize]);

  if (!open) return null;

  const currentItem = labels[currentIndex] || labels[0] || {};
  const activeClient = selectedPrinter === 'mht' ? mhtClient : detongerClient;
  const isConnected = selectedPrinter === 'mht' ? mhtStatus === 'connected' : detongerStatus === 'connected';
  const currentDeviceName = selectedPrinter === 'mht' ? mhtDeviceName : detongerDeviceName;

  // Handle Bluetooth connect
  const handleConnect = async () => {
    setError('');
    setSuccessMsg('');
    setConnecting(true);
    try {
      if (selectedPrinter === 'mht') {
        await mhtClient.connect(mhtPrefix);
      } else {
        await detongerClient.connect(detongerPrefix);
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') { // User didn't just cancel picker
        setError(err.message || 'Printerga ulanib bo‘lmadi.');
      }
    } finally {
      setConnecting(false);
    }
  };

  // Handle Bluetooth disconnect
  const handleDisconnect = async () => {
    setError('');
    setSuccessMsg('');
    if (selectedPrinter === 'mht') {
      await mhtClient.disconnect();
    } else {
      await detongerClient.disconnect();
    }
  };

  const totalPrintCount = printScope === 'all'
    ? labels.reduce((acc, l) => acc + (Math.max(1, Number(l.quantity) || 1) * copies), 0)
    : copies;

  // Handle printing
  const handlePrint = async () => {
    setError('');
    setSuccessMsg('');

    if (!isConnected) {
      setError(`Avval ${selectedPrinter === 'mht' ? 'MHT-L80G' : 'Detonger'} printerni Bluetooth orqali ulang.`);
      return;
    }

    const targets = [];
    if (printScope === 'all') {
      labels.forEach(l => {
        const count = Math.max(1, Number(l.quantity) || 1) * copies;
        for (let k = 0; k < count; k++) {
          targets.push(l);
        }
      });
    } else {
      for (let k = 0; k < copies; k++) {
        targets.push(currentItem);
      }
    }

    if (!targets.length) {
      setError("Chop etish uchun yorliqlar mavjud emas.");
      return;
    }

    setPrinting(true);
    setProgress({ current: 0, total: targets.length, label: targets[0] });

    try {
      if (selectedPrinter === 'mht') {
        await mhtClient.printLabels(targets, {
          copies: 1,
          onProgress: (current, total, label) => {
            setProgress({ current, total, label });
          }
        });
      } else {
        await detongerClient.printLabels(targets, {
          copies: 1,
          labelSize,
          onProgress: (current, total, label) => {
            setProgress({ current, total, label });
          }
        });
      }
    } catch (err) {
      setError(err.message || 'Chop etish jarayonida xatolik yuz berdi.');
    } finally {
      setPrinting(false);
    }
  };

  // Test feed line
  const handleFeed = async () => {
    try {
      await activeClient.feedLines(2);
    } catch (err) {
      setError("Lenta chiqarishda xatolik: " + err.message);
    }
  };

  return (
    <div className="overlay" style={{ zIndex: 1100 }} onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ maxWidth: 540, padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          background: 'linear-gradient(135deg, #0f172a, #1e293b)',
          color: '#fff',
          borderBottom: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: selectedPrinter === 'mht'
                ? 'linear-gradient(135deg, #0ea5e9, #0284c7)'
                : 'linear-gradient(135deg, #f97316, #ea580c)',
              display: 'grid',
              placeItems: 'center',
              boxShadow: selectedPrinter === 'mht'
                ? '0 4px 12px rgba(14,165,233,0.4)'
                : '0 4px 12px rgba(249,115,22,0.4)'
            }}>
              <Printer size={20} color="#fff" />
            </div>
            <div>
              <b style={{ fontSize: 15, display: 'block', lineHeight: 1.2 }}>
                {selectedPrinter === 'mht' ? 'MHT-L80G Termoprinter' : 'Detonger Termoprinter'}
              </b>
              <small style={{ color: '#94a3b8', fontSize: 11 }}>
                {selectedPrinter === 'mht'
                  ? 'Katta QR kod yorliqlari (58 × 40 mm · TSPL)'
                  : `Kichik yorliqlar (${labelSize === '40x20' ? '40 × 20 mm' : '40 × 30 mm'})`}
              </small>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            style={{ width: 34, height: 34, background: 'rgba(255,255,255,0.1)', borderColor: 'rgba(255,255,255,0.15)', color: '#fff' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', maxHeight: 'calc(88vh - 75px)', overflowY: 'auto' }}>
          {/* PRINTER SELECTOR TABS */}
          <div style={{
            background: '#f1f5f9',
            padding: 4,
            borderRadius: 12,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
            marginBottom: 14,
            border: '1px solid #e2e8f0'
          }}>
            <button
              type="button"
              onClick={() => handlePrinterChange('detonger')}
              style={{
                border: 'none',
                padding: '9px 12px',
                borderRadius: 9,
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                background: selectedPrinter === 'detonger' ? '#ffffff' : 'transparent',
                color: selectedPrinter === 'detonger' ? '#ea580c' : '#64748b',
                boxShadow: selectedPrinter === 'detonger' ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.15s ease'
              }}
            >
              <Printer size={15} />
              <span>Detonger (40 mm)</span>
              {detongerStatus === 'connected' && (
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a' }} />
              )}
            </button>

            <button
              type="button"
              onClick={() => handlePrinterChange('mht')}
              style={{
                border: 'none',
                padding: '9px 12px',
                borderRadius: 9,
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                background: selectedPrinter === 'mht' ? '#ffffff' : 'transparent',
                color: selectedPrinter === 'mht' ? '#0284c7' : '#64748b',
                boxShadow: selectedPrinter === 'mht' ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.15s ease'
              }}
            >
              <Sparkles size={15} />
              <span>MHT-L80G (58 mm)</span>
              {mhtStatus === 'connected' && (
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a' }} />
              )}
            </button>
          </div>

          {/* Tip / Environment warning */}
          {envInfo.tip && (
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              background: envInfo.supported ? '#f0fdf4' : '#fffbeb',
              border: `1px solid ${envInfo.supported ? '#bbf7d0' : '#fde68a'}`,
              color: envInfo.supported ? '#166534' : '#92400e',
              padding: '10px 12px',
              borderRadius: 12,
              marginBottom: 14,
              fontSize: 12,
              lineHeight: 1.45
            }}>
              <Smartphone size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <b>{envInfo.isMobile ? (envInfo.isAndroid ? 'Android telefon:' : 'iPhone / iPad:') : 'Brauzer ma’lumoti:'}</b>
                <span style={{ display: 'block', marginTop: 2 }}>{envInfo.tip}</span>
              </div>
            </div>
          )}

          {/* Bluetooth Connection Card */}
          <div style={{
            background: isConnected ? '#f0fdf4' : '#f8fafc',
            border: `1.5px solid ${isConnected ? '#86efac' : '#e2e8f0'}`,
            borderRadius: 14,
            padding: '12px 14px',
            marginBottom: 14
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isConnected ? (
                  <BluetoothConnected size={20} color="#16a34a" />
                ) : connecting ? (
                  <RefreshCw size={20} color={selectedPrinter === 'mht' ? '#0ea5e9' : '#f97316'} className="spin" />
                ) : (
                  <BluetoothOff size={20} color="#64748b" />
                )}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isConnected ? '#166534' : 'var(--navy)' }}>
                    {isConnected ? (currentDeviceName || `${selectedPrinter === 'mht' ? 'MHT-L80G' : 'Detonger'} ulangan`) : connecting ? 'Ulanmoqda...' : 'Printer ulanmagan'}
                  </div>
                  <div style={{ fontSize: 11, color: isConnected ? '#15803d' : 'var(--muted)' }}>
                    {isConnected
                      ? (selectedPrinter === 'mht' ? 'Bluetooth BLE faol (58 × 40 mm lenta)' : 'Bluetooth BLE faol (40 mm lenta)')
                      : (selectedPrinter === 'mht' ? 'MHT-L80G / Milestone L80 termoprinter' : 'Detonger DP23/DP26/DP30/DP30S/P1/P2')}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isConnected ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '6px 10px', fontSize: 11 }}
                      onClick={handleFeed}
                      title="Lenta chiqarish"
                    >
                      Feed 2x
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      style={{ padding: '6px 10px', fontSize: 11 }}
                      onClick={handleDisconnect}
                    >
                      Uzish
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={connecting}
                      onClick={handleConnect}
                      style={{
                        padding: '7px 14px',
                        fontSize: 12,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        background: selectedPrinter === 'mht'
                          ? 'linear-gradient(135deg, #0284c7, #0369a1)'
                          : undefined
                      }}
                    >
                      <Bluetooth size={14} />
                      {connecting ? 'Ulanmoqda…' : 'Bluetooth orqali ulash'}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 32, height: 32 }}
                      onClick={() => setShowSettings(!showSettings)}
                      title="Bluetooth sozlamalari"
                    >
                      <Settings2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Advanced Prefix Selector */}
            {showSettings && !isConnected && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
                <label style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Printer modeli / Bluetooth nomi filtri:
                </label>
                {selectedPrinter === 'mht' ? (
                  <select
                    className="select"
                    value={mhtPrefix}
                    onChange={(e) => setMhtPrefix(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 10px', width: '100%' }}
                  >
                    {MHT_PREFIX_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    className="select"
                    value={detongerPrefix}
                    onChange={(e) => setDetongerPrefix(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 10px', width: '100%' }}
                  >
                    {DETONGER_PREFIX_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                )}
                <small style={{ color: 'var(--muted)', fontSize: 10, marginTop: 4, display: 'block' }}>
                  {selectedPrinter === 'mht'
                    ? "MHT-L80G uchun odatda 'MHT' yoki 'L80' prefiksi mos keladi."
                    : "Standart Detonger printerlar uchun 'P' (P1, P2) yoki 'DP' (DP23, DP30S...) mos keladi."}
                </small>
              </div>
            )}
          </div>

          {/* Success / Error alerts */}
          {successMsg && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#f0fdf4',
              color: '#166534',
              border: '1px solid #bbf7d0',
              padding: '8px 12px',
              borderRadius: 10,
              fontSize: 12,
              marginBottom: 12
            }}>
              <CheckCircle2 size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {error && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#fef2f2',
              color: '#b91c1c',
              border: '1px solid #fecaca',
              padding: '8px 12px',
              borderRadius: 10,
              fontSize: 12,
              marginBottom: 12
            }}>
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}

          {/* Paper Size Selector (Detonger) vs Paper Size Info (MHT-L80G) */}
          {selectedPrinter === 'detonger' ? (
            <div style={{
              background: '#ffffff',
              border: '1.5px solid #e2e8f0',
              borderRadius: 14,
              padding: '10px 14px',
              marginBottom: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10
            }}>
              <div>
                <b style={{ fontSize: 13, display: 'block', color: 'var(--navy)' }}>Detonger qog‘oz o‘lchami</b>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {labelSize === '40x20' ? '40 × 20 mm (Kichik — 60% QR kod, yonida kod, tannarx va sana)' : '40 × 30 mm (Standart — katta markaziy QR kod)'}
                </small>
              </div>
              <div style={{ display: 'flex', gap: 6, background: '#f1f5f9', padding: 3, borderRadius: 10 }}>
                <button
                  type="button"
                  className={`btn ${labelSize === '40x20' ? 'btn-primary' : ''}`}
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 8,
                    border: 'none',
                    background: labelSize === '40x20' ? '#2563eb' : 'transparent',
                    color: labelSize === '40x20' ? '#fff' : '#475569',
                    boxShadow: labelSize === '40x20' ? '0 2px 6px rgba(37,99,235,0.3)' : 'none'
                  }}
                  onClick={() => handleSizeChange('40x20')}
                >
                  40 × 20 mm
                </button>
                <button
                  type="button"
                  className={`btn ${labelSize === '40x30' ? 'btn-primary' : ''}`}
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 8,
                    border: 'none',
                    background: labelSize === '40x30' ? '#2563eb' : 'transparent',
                    color: labelSize === '40x30' ? '#fff' : '#475569',
                    boxShadow: labelSize === '40x30' ? '0 2px 6px rgba(37,99,235,0.3)' : 'none'
                  }}
                  onClick={() => handleSizeChange('40x30')}
                >
                  40 × 30 mm
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              background: '#f0f9ff',
              border: '1.5px solid #bae6fd',
              borderRadius: 14,
              padding: '10px 14px',
              marginBottom: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10
            }}>
              <div>
                <b style={{ fontSize: 13, display: 'block', color: '#0369a1' }}>
                  MHT-L80G qog‘oz o‘lchami: 58 × 40 mm
                </b>
                <small style={{ color: '#0284c7', fontSize: 11 }}>
                  Kattaroq QR kod (252 px), tovar qidiruv kodi, USD tannarx ($ siz) va qabul sanasi
                </small>
              </div>
              <span style={{
                background: '#0284c7',
                color: '#ffffff',
                fontWeight: 800,
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 8,
                letterSpacing: '0.3px',
                boxShadow: '0 2px 6px rgba(2,132,199,0.3)'
              }}>
                58 × 40 mm
              </span>
            </div>
          )}

          {/* Live Canvas Label Preview */}
          <div style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 16,
            padding: 14,
            marginBottom: 14
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--navy)' }}>
                {selectedPrinter === 'mht'
                  ? 'MHT-L80G (58 × 40 mm) Yorliq oldindan ko‘rish'
                  : (labelSize === '40x20' ? 'Detonger (40 × 20 mm) Yorliq oldindan ko‘rish' : 'Detonger (40 × 30 mm) Yorliq oldindan ko‘rish')}
              </div>
              {labels.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 28, height: 28 }}
                    disabled={currentIndex === 0}
                    onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span style={{ fontSize: 11, fontWeight: 700 }}>
                    {currentIndex + 1} / {labels.length}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 28, height: 28 }}
                    disabled={currentIndex === labels.length - 1}
                    onClick={() => setCurrentIndex((prev) => Math.min(labels.length - 1, prev + 1))}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>

            {/* Canvas Container */}
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              padding: '12px 8px',
              background: '#cbd5e1',
              borderRadius: 12,
            }}>
              <div style={{
                background: '#ffffff',
                boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                borderRadius: 4,
                overflow: 'hidden',
                width: selectedPrinter === 'mht'
                  ? 290
                  : (labelSize === '40x20' ? 280 : 260),
                height: selectedPrinter === 'mht'
                  ? 200 // 58:40 aspect ratio (464:320 = 1.45) -> 290 / 1.45 = 200
                  : (labelSize === '40x20' ? 140 : 195),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease'
              }}>
                <canvas
                  ref={previewCanvasRef}
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    imageRendering: 'pixelated'
                  }}
                />
              </div>
            </div>

            {/* Label summary info */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 10,
              padding: '8px 12px',
              background: '#ffffff',
              border: '1.5px solid #e2e8f0',
              borderRadius: 10,
              fontSize: 12,
              gap: 8,
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, color: 'var(--navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {currentItem.title || currentItem.product_name || 'Mahsulot'}
                  {currentItem.color || currentItem.variant_color ? ` (${currentItem.color || currentItem.variant_color})` : ''}
                  {currentItem.quantity ? ` · ${currentItem.quantity} dona` : ''}
                </div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
                  Sana: <b>{currentItem.date || currentItem.received_at || receiptDate || new Date().toLocaleDateString('uz-UZ')}</b>
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <span style={{ display: 'block', fontSize: 9, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>
                  Qidiruv kodi:
                </span>
                <code style={{
                  fontSize: 13,
                  fontWeight: 900,
                  color: '#0f172a',
                  background: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  padding: '2px 8px',
                  borderRadius: 6,
                  letterSpacing: '0.5px',
                  display: 'inline-block'
                }}>
                  {currentItem.code || currentItem.qr_code || '—'}
                </code>
              </div>
            </div>
          </div>

          {/* Scope and Copies Selection */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.2fr 1fr',
            gap: 10,
            marginBottom: 16
          }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>
                Chop etish doirasi:
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${printScope === 'all' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ flex: 1, padding: '6px 8px', fontSize: 11 }}
                  onClick={() => setPrintScope('all')}
                >
                  <Layers size={13} />
                  Barchasi ({labels.length})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${printScope === 'single' ? 'btn-primary' : 'btn-outline'}`}
                  style={{ flex: 1, padding: '6px 8px', fontSize: 11 }}
                  onClick={() => setPrintScope('single')}
                >
                  <Copy size={13} />
                  Faqat bitta (1)
                </button>
              </div>
            </div>

            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>
                {printScope === 'all' ? 'Ko‘paytma (nusxa):' : 'Nusxalar soni:'}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ width: 34, height: 34, padding: 0 }}
                  onClick={() => setCopies((prev) => Math.max(1, prev - 1))}
                  disabled={copies <= 1 || printing}
                >
                  −
                </button>
                <input
                  type="number"
                  min="1"
                  max="999"
                  value={copies}
                  onChange={(e) => setCopies(Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)))}
                  style={{
                    width: 52,
                    height: 34,
                    textAlign: 'center',
                    fontWeight: 800,
                    fontSize: 14,
                    borderRadius: 8,
                    border: '1.5px solid #cbd5e1'
                  }}
                  disabled={printing}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ width: 34, height: 34, padding: 0 }}
                  onClick={() => setCopies((prev) => Math.min(999, prev + 1))}
                  disabled={copies >= 999 || printing}
                >
                  +
                </button>
                <small style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>
                  = {totalPrintCount} dona
                </small>
              </div>
            </div>
          </div>

          {/* Active printing progress */}
          {printing && (
            <div style={{
              background: '#fff7ed',
              border: '1px solid #fdba74',
              borderRadius: 12,
              padding: 12,
              marginBottom: 14
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: selectedPrinter === 'mht' ? '#0369a1' : '#c2410c' }}>
                  Chop etilmoqda ({selectedPrinter === 'mht' ? 'MHT-L80G' : 'Detonger'}): {progress.current} / {progress.total} dona
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: selectedPrinter === 'mht' ? '#0284c7' : '#ea580c' }}>
                  {Math.round((progress.current / Math.max(1, progress.total)) * 100)}%
                </span>
              </div>
              <div style={{ height: 6, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  background: selectedPrinter === 'mht' ? '#0284c7' : '#f97316',
                  width: `${(progress.current / Math.max(1, progress.total)) * 100}%`,
                  transition: 'width 0.2s ease'
                }} />
              </div>
              {progress.label && (
                <div style={{ fontSize: 11, color: '#334155', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Hozirgi: {progress.label.title || progress.label.product_name} ({progress.label.code || progress.label.qr_code})
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={printing || !labels.length}
              onClick={handlePrint}
              style={{
                padding: '12px',
                fontSize: 14,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                background: isConnected
                  ? (selectedPrinter === 'mht'
                      ? 'linear-gradient(135deg, #0284c7, #0369a1)'
                      : 'linear-gradient(135deg, #f97316, #ea580c)')
                  : undefined
              }}
            >
              <Printer size={18} />
              {printing
                ? 'Chop etilmoqda…'
                : isConnected
                ? `${selectedPrinter === 'mht' ? 'MHT-L80G (58x40)' : 'Detonger'} orqali chop etish (${totalPrintCount} dona)`
                : `Bluetooth orqali ulash va chop etish (${totalPrintCount} dona)`}
            </button>

            {onClassicPrint && (
              <button
                type="button"
                className="btn btn-outline btn-block"
                disabled={printing}
                onClick={onClassicPrint}
                style={{ fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <FileText size={14} />
                Kompyuter / Tizim orqali chop etish (Klassik)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Also export alias ThermalPrintModal for consistency
export const ThermalPrintModal = DetongerPrintModal;
