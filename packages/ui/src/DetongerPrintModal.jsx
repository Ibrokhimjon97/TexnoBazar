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
  FileText
} from 'lucide-react';
import {
  detongerClient,
  isWebBluetoothSupported,
  getBluetoothEnvironmentInfo,
  renderDetongerLabelCanvas,
  DETONGER_PREFIX_PRESETS,
  CANVAS_WIDTH_PX,
  CANVAS_HEIGHT_PX,
} from './detongerBluetooth';

export function DetongerPrintModal({
  open,
  onClose,
  labels = [],
  batchTitle = '',
  receiptDate = '',
  onClassicPrint,
}) {
  const [envInfo, setEnvInfo] = useState(() => getBluetoothEnvironmentInfo());
  const [status, setStatus] = useState(() => detongerClient.getStatus());
  const [deviceName, setDeviceName] = useState(() => detongerClient.getDeviceName());
  const [connecting, setConnecting] = useState(false);
  const [prefix, setPrefix] = useState('P');
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

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

  // Sync Bluetooth client status
  useEffect(() => {
    setEnvInfo(getBluetoothEnvironmentInfo());
    setStatus(detongerClient.getStatus());
    setDeviceName(detongerClient.getDeviceName());

    const unsubscribe = detongerClient.subscribe((event) => {
      if (event.type === 'status') {
        setStatus(event.status);
        if (event.deviceName) setDeviceName(event.deviceName);
        if (event.error) setError(event.error);
      } else if (event.type === 'connected') {
        setStatus('connected');
        setDeviceName(event.deviceName);
        setError('');
        setSuccessMsg(`"${event.deviceName}" ga muvaffaqiyatli ulandi!`);
      } else if (event.type === 'progress') {
        setProgress({ current: event.current, total: event.total, label: event.item });
      } else if (event.type === 'print_complete') {
        setPrinting(false);
        setSuccessMsg(`${event.total} ta yorliq muvaffaqiyatli chop etildi!`);
      } else if (event.type === 'error') {
        setError(event.error);
        setPrinting(false);
      }
    });

    return () => unsubscribe();
  }, [open]);

  // Update canvas preview when currentIndex or labels change
  useEffect(() => {
    if (!open || !labels.length) return;
    const item = labels[currentIndex] || labels[0];
    if (!item) return;

    let isMounted = true;
    const title = item.title || item.product_name || 'Mahsulot';
    const color = item.color || item.variant_color || '';
    const date = item.date || item.received_at || receiptDate || new Date().toLocaleDateString('uz-UZ');
    const code = item.code || item.qr_code || '';
    const qrPayload = item.qrPayload || '';

    renderDetongerLabelCanvas({
      title,
      color,
      date,
      code,
      qrPayload,
      width: CANVAS_WIDTH_PX,
      height: CANVAS_HEIGHT_PX,
    }).then((canvas) => {
      if (!isMounted || !previewCanvasRef.current) return;
      const targetCanvas = previewCanvasRef.current;
      targetCanvas.width = CANVAS_WIDTH_PX;
      targetCanvas.height = CANVAS_HEIGHT_PX;
      const ctx = targetCanvas.getContext('2d');
      ctx.clearRect(0, 0, CANVAS_WIDTH_PX, CANVAS_HEIGHT_PX);
      ctx.drawImage(canvas, 0, 0);
    }).catch((err) => {
      console.error("Preview render error:", err);
    });

    return () => { isMounted = false; };
  }, [open, currentIndex, labels, receiptDate]);

  if (!open) return null;

  const currentItem = labels[currentIndex] || labels[0] || {};
  const isConnected = status === 'connected';

  // Handle Bluetooth connect
  const handleConnect = async () => {
    setError('');
    setSuccessMsg('');
    setConnecting(true);
    try {
      await detongerClient.connect(prefix);
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
    await detongerClient.disconnect();
  };

  const totalPrintCount = printScope === 'all'
    ? labels.reduce((acc, l) => acc + (Math.max(1, Number(l.quantity) || 1) * copies), 0)
    : copies;

  // Handle printing
  const handlePrint = async () => {
    setError('');
    setSuccessMsg('');

    if (!isConnected) {
      setError("Avval printerni Bluetooth orqali ulang.");
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
      await detongerClient.printLabels(targets, {
        copies: 1,
        onProgress: (current, total, label) => {
          setProgress({ current, total, label });
        }
      });
    } catch (err) {
      setError(err.message || 'Chop etish jarayonida xatolik yuz berdi.');
    } finally {
      setPrinting(false);
    }
  };

  // Test feed line
  const handleFeed = async () => {
    try {
      await detongerClient.feedLines(2);
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
              background: 'linear-gradient(135deg, #f97316, #ea580c)',
              display: 'grid',
              placeItems: 'center',
              boxShadow: '0 4px 12px rgba(249,115,22,0.4)'
            }}>
              <Printer size={20} color="#fff" />
            </div>
            <div>
              <b style={{ fontSize: 15, display: 'block', lineHeight: 1.2 }}>Detonger Bluetooth Chop Etish</b>
              <small style={{ color: '#94a3b8', fontSize: 11 }}>Termoprinter yorliqlari (40 × 30 mm)</small>
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
                  <RefreshCw size={20} color="#f97316" className="spin" />
                ) : (
                  <BluetoothOff size={20} color="#64748b" />
                )}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isConnected ? '#166534' : 'var(--navy)' }}>
                    {isConnected ? (deviceName || 'Detonger ulangan') : connecting ? 'Ulanmoqda...' : 'Printer ulanmagan'}
                  </div>
                  <div style={{ fontSize: 11, color: isConnected ? '#15803d' : 'var(--muted)' }}>
                    {isConnected ? 'Bluetooth BLE faol (40 mm lenta)' : 'Detonger DP23/DP26/DP30/DP30S/P1/P2'}
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
                      style={{ padding: '7px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
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
                  Printer modeli / Bluetooth nomi prefiksi:
                </label>
                <select
                  className="select"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  style={{ fontSize: 12, padding: '6px 10px' }}
                >
                  {DETONGER_PREFIX_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <small style={{ color: 'var(--muted)', fontSize: 10, marginTop: 4, display: 'block' }}>
                  Standart Detonger printerlar uchun 'P' (P1, P2) yoki 'DP' (DP23, DP30S...) mos keladi.
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

          {/* Live 40x30 mm Canvas Label Preview */}
          <div style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 16,
            padding: 14,
            marginBottom: 14
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--navy)' }}>
                40 × 30 mm Yorliq oldindan ko‘rish
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
                width: 260,
                height: 195, // 4:3 aspect ratio matching 320x240
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
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
                <span style={{ fontSize: 12, fontWeight: 700, color: '#c2410c' }}>
                  Chop etilmoqda: {progress.current} / {progress.total} dona
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: '#ea580c' }}>
                  {Math.round((progress.current / Math.max(1, progress.total)) * 100)}%
                </span>
              </div>
              <div style={{ height: 6, background: '#fed7aa', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  background: '#f97316',
                  width: `${(progress.current / Math.max(1, progress.total)) * 100}%`,
                  transition: 'width 0.2s ease'
                }} />
              </div>
              {progress.label && (
                <div style={{ fontSize: 11, color: '#7c2d12', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                background: isConnected ? 'linear-gradient(135deg, #f97316, #ea580c)' : undefined
              }}
            >
              <Printer size={18} />
              {printing
                ? 'Chop etilmoqda…'
                : isConnected
                ? `Detonger orqali chop etish (${totalPrintCount} dona)`
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
