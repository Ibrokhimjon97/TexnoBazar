import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Boxes,
  CheckCircle2,
  FileArchive,
  HardDriveDownload,
  HardDriveUpload,
  Image as ImageIcon,
  Layers,
  Loader2,
  Package,
  QrCode,
  RefreshCw,
  ShieldAlert,
  UploadCloud,
} from 'lucide-react';
import { Modal } from '@texnobazar/ui';
import {
  exportBackupArchive,
  getBackupSummary,
  inspectBackupArchive,
  restoreBackupArchive,
} from '@texnobazar/data';

export default function ManagerBackupWorkspace({ branchId, toast }) {
  const [summary, setSummary] = useState(null);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(null);

  // Restore state
  const [selectedFile, setSelectedFile] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [archiveInfo, setArchiveInfo] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(null);
  const [restoreResult, setRestoreResult] = useState(null);
  const [confirmModal, setConfirmModal] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const sum = await getBackupSummary(branchId || null);
      setSummary(sum);
    } catch (err) {
      setError(err.message || 'Ma’lumotlar yuklanmadi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [branchId]);

  const handleExport = async () => {
    setExporting(true);
    setExportProgress({ stage: 'start', percent: 5, message: 'Tayyorlanmoqda…' });
    try {
      const res = await exportBackupArchive({
        branchId: branchId || null,
        includeMedia,
        onProgress: setExportProgress,
      });
      toast?.(`Zahira muvaffaqiyatli yuklab olindi (${(res.size / (1024 * 1024)).toFixed(2)} MB)`);
    } catch (err) {
      setError(err.message || 'Zahira olishda xatolik yuz berdi');
      toast?.('Zahira olishda xatolik yuz berdi');
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  const handleFileSelect = async file => {
    if (!file) return;
    if (!file.name.endsWith('.zip')) {
      setError('Faqat .zip formatidagi zahira fayllarini tanlang.');
      return;
    }
    setSelectedFile(file);
    setArchiveInfo(null);
    setRestoreResult(null);
    setError('');
    setInspecting(true);
    try {
      const info = await inspectBackupArchive(file);
      setArchiveInfo(info);
    } catch (err) {
      setError(err.message || 'ZIP faylni o‘qib bo‘lmadi.');
    } finally {
      setInspecting(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedFile) return;
    setConfirmModal(false);
    setRestoring(true);
    setRestoreProgress({ stage: 'start', percent: 5, message: 'Tiklash boshlanmoqda…' });
    setError('');
    try {
      const res = await restoreBackupArchive(selectedFile, {
        onProgress: setRestoreProgress,
      });
      setRestoreResult(res);
      toast?.('Barcha tovarlar va rasmlar 100% muvaffaqiyatli tiklandi!');
      await load();
    } catch (err) {
      setError(err.message || 'Tiklash jarayonida xatolik yuz berdi');
      toast?.('Tiklashda xatolik yuz berdi');
    } finally {
      setRestoring(false);
      setRestoreProgress(null);
    }
  };

  return (
    <section className="backup-workspace">
      <div className="page-head between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Filial Zahira va Qayta Tiklash</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--muted, #64748b)', fontSize: 13 }}>
            Filial tovarlari, partiyalari, narxlari, QR kodlari va rasmlarini ZIP arxivga olish hamda 100% qayta tiklash
          </p>
        </div>
        <button className="btn btn-outline" onClick={load} disabled={loading} title="Yangilash">
          <RefreshCw className={loading ? 'spin' : ''} size={16} /> Yangilash
        </button>
      </div>

      {error && (
        <div className="catalog-error" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, background: '#fee2e2', color: '#991b1b' }}>
          <AlertTriangle size={18} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-sm" onClick={() => setError('')}>Yopish</button>
        </div>
      )}

      {/* Tizimdagi joriy filial ko'rsatkichlari */}
      <div className="mini-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Package style={{ color: '#2563eb' }} />
          <span>
            <b style={{ display: 'block', fontSize: 18 }}>{summary?.products || 0} ta</b>
            <small style={{ color: '#64748b', fontSize: 12 }}>Tovarlar</small>
          </span>
        </div>
        <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Layers style={{ color: '#7c3aed' }} />
          <span>
            <b style={{ display: 'block', fontSize: 18 }}>{summary?.variants || 0} ta</b>
            <small style={{ color: '#64748b', fontSize: 12 }}>Variantlar</small>
          </span>
        </div>
        <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <ImageIcon style={{ color: '#059669' }} />
          <span>
            <b style={{ display: 'block', fontSize: 18 }}>{summary?.media || 0} ta</b>
            <small style={{ color: '#64748b', fontSize: 12 }}>R2 rasmlari</small>
          </span>
        </div>
        <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <QrCode style={{ color: '#ea580c' }} />
          <span>
            <b style={{ display: 'block', fontSize: 18 }}>{summary?.units || 0} ta</b>
            <small style={{ color: '#64748b', fontSize: 12 }}>QR donalar</small>
          </span>
        </div>
        <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Boxes style={{ color: '#0891b2' }} />
          <span>
            <b style={{ display: 'block', fontSize: 18 }}>{summary?.batches || 0} ta</b>
            <small style={{ color: '#64748b', fontSize: 12 }}>Partiyalar</small>
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
        {/* 1. ZAHIRA YUKLAB OLISH (EKSPORT) */}
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: 'rgba(59, 130, 246, 0.1)',
                color: '#2563eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <HardDriveDownload size={24} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 18 }}>Zahira Nusxa Yuklab Olish</h3>
              <small style={{ color: '#64748b' }}>Filial tovarlari va rasmlarini ZIP arxivga olish</small>
            </div>
          </div>

          <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.5, marginBottom: 16 }}>
            Ushbu amal filialdagi barcha tovarlar, partiyalar, narxlar, rang variantlari,
            individual <b>TNB1-...</b> QR kodlari va Cloudflare R2 bulutidagi fotosuratlarni yagona ZIP
            faylga yuklab beradi.
          </p>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeMedia}
                onChange={e => setIncludeMedia(e.target.checked)}
                disabled={exporting}
              />
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                Cloudflare R2 dagi barcha tovar rasmlarini ham ZIP ichiga qo'shish (100% tiklash uchun)
              </span>
            </label>
          </div>

          {exportProgress && (
            <div style={{ background: '#f1f5f9', padding: 14, borderRadius: 10, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
                <span>{exportProgress.message}</span>
                <span>{exportProgress.percent}%</span>
              </div>
              <div style={{ width: '100%', height: 6, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${exportProgress.percent}%`,
                    height: '100%',
                    background: '#2563eb',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={exporting || loading}
            style={{ width: '100%', padding: '12px 18px', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            {exporting ? (
              <>
                <Loader2 className="spin" size={16} /> Zahira yaratilmoqda…
              </>
            ) : (
              <>
                <ArrowDownToLine size={16} /> ZIP Zahirasini Yuklab Olish
              </>
            )}
          </button>
        </div>

        {/* 2. ZAHIRADAN TIKLASH (IMPORT) */}
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: 'rgba(16, 185, 129, 0.1)',
                color: '#059669',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <HardDriveUpload size={24} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 18 }}>Zahiradan 100% Qayta Tiklash</h3>
              <small style={{ color: '#64748b' }}>ZIP arxivdan barcha tovar va rasmlarni tiklash</small>
            </div>
          </div>

          <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.5, marginBottom: 16 }}>
            Mabodo tovarlar, partiyalar yoki Cloudflare R2 dagi rasmlar o'chib ketsa, avval olingan
            ZIP faylni yuklab, barcha ma'lumotlarni o'z joyiga 100% to'liq tiklashingiz mumkin.
          </p>

          {/* File Upload Area */}
          <div
            style={{
              border: '2px dashed var(--line, #cbd5e1)',
              borderRadius: 12,
              padding: '24px 16px',
              textAlign: 'center',
              background: selectedFile ? '#f8fafc' : '#fff',
              cursor: 'pointer',
              marginBottom: 16,
              transition: 'border 0.2s',
            }}
            onClick={() => document.getElementById('manager-backup-file-input')?.click()}
          >
            <input
              id="manager-backup-file-input"
              type="file"
              accept=".zip"
              hidden
              onChange={e => handleFileSelect(e.target.files?.[0])}
              disabled={restoring}
            />
            <FileArchive size={36} style={{ color: selectedFile ? '#059669' : '#94a3b8', margin: '0 auto 8px' }} />
            {selectedFile ? (
              <div>
                <b style={{ color: '#0f172a', display: 'block', fontSize: 14 }}>{selectedFile.name}</b>
                <small style={{ color: '#64748b' }}>{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · Boshqa fayl tanlash uchun bosing</small>
              </div>
            ) : (
              <div>
                <b style={{ color: '#334155', display: 'block', fontSize: 14 }}>ZIP zahira faylini tanlang</b>
                <small style={{ color: '#64748b' }}>Faylni tanlash uchun bu yerga bosing</small>
              </div>
            )}
          </div>

          {inspecting && (
            <div style={{ textAlign: 'center', padding: 12, fontSize: 13, color: '#64748b' }}>
              <Loader2 className="spin" size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              ZIP arxiv tekshirilmoqda…
            </div>
          )}

          {archiveInfo && (
            <div
              style={{
                background: 'rgba(16, 185, 129, 0.05)',
                border: '1px solid rgba(16, 185, 129, 0.2)',
                borderRadius: 10,
                padding: 14,
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#059669', fontWeight: 600, marginBottom: 8 }}>
                <CheckCircle2 size={16} /> Zahira tekshirildi — tiklashga tayyor:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#334155', lineHeight: 1.6 }}>
                <li><b>{archiveInfo.counts.products} ta</b> mahsulot</li>
                <li><b>{archiveInfo.counts.variants} ta</b> rang varianti</li>
                <li><b>{archiveInfo.counts.mediaFilesCount} ta</b> Cloudflare R2 rasmlari</li>
                <li><b>{archiveInfo.counts.units} ta</b> QR kodli tovar birligi</li>
                <li><b>{archiveInfo.counts.batches} ta</b> partiya kirimi</li>
              </ul>
            </div>
          )}

          {restoreProgress && (
            <div style={{ background: '#f1f5f9', padding: 14, borderRadius: 10, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
                <span>{restoreProgress.message}</span>
                <span>{restoreProgress.percent}%</span>
              </div>
              <div style={{ width: '100%', height: 6, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${restoreProgress.percent}%`,
                    height: '100%',
                    background: '#059669',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          )}

          {restoreResult && (
            <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', padding: 14, borderRadius: 10, marginBottom: 16 }}>
              <b style={{ color: '#065f46', display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={18} /> Barcha ma'lumotlar muvaffaqiyatli tiklandi!
              </b>
              <small style={{ color: '#047857', display: 'block', marginTop: 4 }}>
                {restoreResult.result?.products_restored || 0} ta tovar, {restoreResult.result?.units_restored || 0} ta QR dona va {restoreResult.mediaRestored || 0} ta rasm o'z joyiga qaytarildi.
              </small>
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={() => setConfirmModal(true)}
            disabled={!archiveInfo || restoring}
            style={{
              width: '100%',
              padding: '12px 18px',
              fontSize: 14,
              fontWeight: 600,
              background: '#059669',
              borderColor: '#059669',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {restoring ? (
              <>
                <Loader2 className="spin" size={16} /> Tiklanmoqda…
              </>
            ) : (
              <>
                <UploadCloud size={16} /> Zahiradan 100% Tiklash
              </>
            )}
          </button>
        </div>
      </div>

      {/* Confirmation Modal */}
      <Modal open={confirmModal} onClose={() => setConfirmModal(false)} title="Zahiradan Tiklashni Tasdiqlash">
        <div style={{ padding: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', color: '#b45309', marginBottom: 14 }}>
            <ShieldAlert size={24} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <b style={{ fontSize: 14 }}>Haqiqatan ham ushbu zahirani tiklamoqchimisiz?</b>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: '#475467', lineHeight: 1.5 }}>
                Bu jarayonda ZIP arxiv ichidagi barcha mahsulotlar, narxlar, rang variantlari,
                QR kodlari hamda fotosuratlar Supabase ma'lumotlar bazasi va Cloudflare R2 bulutiga qayta tiklanadi.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <button className="btn btn-outline" onClick={() => setConfirmModal(false)}>
              Bekor qilish
            </button>
            <button
              className="btn btn-primary"
              style={{ background: '#059669', borderColor: '#059669' }}
              onClick={handleRestore}
            >
              Ha, 100% Tiklashni Boshlash
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
