import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  Search,
  Download,
  Trash2,
  Database,
  RefreshCw,
  CheckCircle2,
  ShieldCheck,
  HardDrive,
} from 'lucide-react';
import { Modal } from '@texnobazar/ui';
import { queryAuditLog, getAuditStats, pruneOldAuditLogs, downloadCsv } from '@texnobazar/data';

export default function AuditWorkspace() {
  const [filters, setFilters] = useState({ table: '', entityId: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ items: [], total: 0 });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Storage Stats & Maintenance state
  const [stats, setStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [pruneModalOpen, setPruneModalOpen] = useState(false);
  const [pruneDays, setPruneDays] = useState(1);
  const [pruning, setPruning] = useState(false);
  const [pruneSuccess, setPruneSuccess] = useState('');
  const [exporting, setExporting] = useState(false);

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const data = await getAuditStats();
      setStats(data);
    } catch (e) {
      console.warn('Stats yuklanmadi:', e);
    } finally {
      setLoadingStats(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const to = filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : null;
      const data = await queryAuditLog({
        table: filters.table || null,
        entityId: filters.entityId || null,
        from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : null,
        to,
        page,
        pageSize: 50,
      });
      setResult(data);
    } catch (e) {
      setError(e.message || 'Audit jurnali yuklanmadi.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadStats();
  }, [page]);

  const submit = (e) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  const handlePrune = async () => {
    setPruning(true);
    setPruneSuccess('');
    setError('');
    try {
      const res = await pruneOldAuditLogs(Number(pruneDays));
      setPruneSuccess(
        `${res.deleted_count || 0} ta eski yozuv tozalandi. Qolgan audit yozuvlari: ${res.remaining_count || 0} ta.`
      );
      await loadStats();
      await load();
      setTimeout(() => {
        setPruneModalOpen(false);
        setPruneSuccess('');
      }, 3000);
    } catch (e) {
      alert(e.message || 'Tozalashda xatolik yuz berdi');
    } finally {
      setPruning(false);
    }
  };

  const handleExportFiltered = () => {
    if (!result.items || !result.items.length) {
      alert('Yuklab olish uchun yozuv mavjud emas');
      return;
    }
    const cleanRows = result.items.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      action: row.action,
      entity_table: row.entity_table,
      entity_id: row.entity_id,
      actor_id: row.actor_id,
      request_id: row.request_id,
      old_data: JSON.stringify(row.old_data || {}),
      new_data: JSON.stringify(row.new_data || {}),
    }));
    downloadCsv(`audit_log_export_${new Date().toISOString().slice(0, 10)}.csv`, cleanRows);
  };

  const handleDownloadJson = () => {
    if (!result.items || !result.items.length) {
      alert('Yuklab olish uchun yozuv mavjud emas');
      return;
    }
    const blob = new Blob([JSON.stringify(result.items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_log_page_${page}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const pages = Math.max(1, Math.ceil(Number(result.total || 0) / 50));

  return (
    <>
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2>Audit jurnali</h2>
          <p>Serverda qayd etilgan muhim o‘zgarishlar va tizim xavfsizlik arxivi.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handleDownloadJson} title="Joriy sahifadagi auditlarni JSON yuklash">
            <Download size={16} /> JSON yuklab olish
          </button>
          <button className="btn btn-secondary" onClick={handleExportFiltered} title="Joriy sahifadagi auditlarni CSV yuklash">
            <Download size={16} /> CSV yuklab olish
          </button>
          <button
            className="btn btn-danger"
            onClick={() => setPruneModalOpen(true)}
            style={{ background: '#dc2626', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <Trash2 size={16} /> Eski auditlarni tozalash
          </button>
        </div>
      </div>

      {/* Storage & Database Quota Stats Banner */}
      {stats && (
        <div
          className="card"
          style={{
            marginBottom: '1.25rem',
            padding: '1.25rem',
            background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.8) 100%)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '12px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <HardDrive size={20} color="#38bdf8" />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Supabase Xotira va Limit Holati</h3>
            </div>
            <button
              className="btn btn-secondary"
              onClick={loadStats}
              disabled={loadingStats}
              style={{ fontSize: '0.8rem', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <RefreshCw size={14} className={loadingStats ? 'spin' : ''} /> Yangilash
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '1rem',
            }}
          >
            <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.04)', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>Jami DB hajmi (Limit: 500 MB)</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#38bdf8' }}>{stats.db_size || '—'}</div>
              <div style={{ fontSize: '0.72rem', color: '#10b981', marginTop: '2px' }}>Free tarif me’yorida (&lt; 20%)</div>
            </div>

            <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.04)', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>Audit jurnali hajmi</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f59e0b' }}>{stats.audit_size || '—'}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '2px' }}>Jami yozuvlar: {Number(stats.total_rows || 0).toLocaleString()} ta</div>
            </div>

            <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.04)', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>1 kundan eski yozuvlar</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: Number(stats.older_1d || 0) > 0 ? '#ef4444' : '#10b981' }}>
                {Number(stats.older_1d || 0).toLocaleString()} ta
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '2px' }}>7 kundan eski: {Number(stats.older_7d || 0).toLocaleString()} ta</div>
            </div>

            <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.04)', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '4px' }}>Ma’lumotlar xavfsizligi</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.95rem', fontWeight: 600, color: '#10b981', marginTop: '4px' }}>
                <ShieldCheck size={18} /> Asosiy bazaga ta’sir qilmaydi
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '4px' }}>Tovarlar, narxlar, sotuvlar daxlsiz</div>
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <form className="admin-filterbar" onSubmit={submit}>
        <label>
          <Search />
          <input
            className="input"
            value={filters.table}
            onChange={(e) => setFilters({ ...filters, table: e.target.value })}
            placeholder="Jadval nomi (masalan: products)"
          />
        </label>
        <input
          className="input"
          value={filters.entityId}
          onChange={(e) => setFilters({ ...filters, entityId: e.target.value })}
          placeholder="Entity ID"
        />
        <input
          className="input"
          type="date"
          value={filters.from}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          title="Boshlanish sanasi"
        />
        <input
          className="input"
          type="date"
          value={filters.to}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          title="Tugash sanasi"
        />
        <button className="btn btn-primary">Qidirish</button>
      </form>

      {/* Table view */}
      {loading ? (
        <State text="Audit yuklanmoqda…" />
      ) : error ? (
        <State text={error} error retry={load} />
      ) : (
        <div className="card data-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sana</th>
                  <th>Jadval</th>
                  <th>Amal</th>
                  <th>Entity ID</th>
                  <th>Actor (Foydalanuvchi)</th>
                  <th>Request ID</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(result.items || []).map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString('uz-UZ')}</td>
                    <td>
                      <b>
                        {row.entity_schema}.{row.entity_table}
                      </b>
                    </td>
                    <td>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          backgroundColor:
                            row.action === 'INSERT'
                              ? 'rgba(16, 185, 129, 0.2)'
                              : row.action === 'UPDATE'
                              ? 'rgba(59, 130, 246, 0.2)'
                              : row.action === 'DELETE'
                              ? 'rgba(239, 68, 68, 0.2)'
                              : 'rgba(156, 163, 175, 0.2)',
                          color:
                            row.action === 'INSERT'
                              ? '#10b981'
                              : row.action === 'UPDATE'
                              ? '#3b82f6'
                              : row.action === 'DELETE'
                              ? '#ef4444'
                              : 'inherit',
                        }}
                      >
                        {row.action}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{row.entity_id || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{row.actor_id ? row.actor_id.slice(0, 8) + '…' : 'Tizim'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--muted)' }}>
                      {row.request_id ? row.request_id.slice(0, 8) + '…' : '—'}
                    </td>
                    <td>
                      <button className="icon-btn" onClick={() => setSelected(row)} title="Batafsil ko'rish">
                        <Eye />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!(result.items || []).length && <p className="admin-inline-empty">Audit yozuvi topilmadi.</p>}
          <div className="admin-pagination">
            <span>
              {result.total || 0} ta yozuv · {page}/{pages}
            </span>
            <div>
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft />
              </button>
              <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title="Audit tafsiloti">
        {selected && (
          <div className="audit-detail">
            <p>
              <b>{selected.entity_table}</b> · {selected.action} · {new Date(selected.created_at).toLocaleString('uz-UZ')}
            </p>
            <h4>Oldingi qiymat</h4>
            <pre>{JSON.stringify(selected.old_data, null, 2) || 'null'}</pre>
            <h4>Yangi qiymat</h4>
            <pre>{JSON.stringify(selected.new_data, null, 2) || 'null'}</pre>
            <h4>Texnik ma’lumot</h4>
            <pre>
              {JSON.stringify(
                {
                  actor_id: selected.actor_id,
                  request_id: selected.request_id,
                  ip: selected.ip,
                  user_agent: selected.user_agent,
                },
                null,
                2
              )}
            </pre>
          </div>
        )}
      </Modal>

      {/* Pruning Modal */}
      <Modal open={pruneModalOpen} onClose={() => !pruning && setPruneModalOpen(false)} title="Eski audit jurnallarini tozalash">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem 0' }}>
          <div
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              borderRadius: '8px',
              fontSize: '0.85rem',
              lineHeight: '1.4',
            }}
          >
            <p style={{ margin: 0, fontWeight: 600, color: '#60a5fa', marginBottom: '4px' }}>
              ℹ️ Muhim ma’lumot:
            </p>
            <p style={{ margin: 0 }}>
              Audit jurnali faqat o'tmishdagi harakatlar (kim qachon qaysi tovar yoki narxni o'zgartirgan) hisobotidir.
              Uni tozalash orqali <b>tovarlar, narxlar, qoldiqlar, sotuvlar yoki qarzdorliklarga zarracha ziyon yetmaydi</b>!
            </p>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.85rem', fontWeight: 600 }}>
              Qaysi muddatdan eski yozuvlar o‘chirilsin?
            </label>
            <select
              className="input"
              value={pruneDays}
              onChange={(e) => setPruneDays(Number(e.target.value))}
              disabled={pruning}
              style={{ width: '100%' }}
            >
              <option value={1}>1 kundan eski yozuvlar ({Number(stats?.older_1d || 0).toLocaleString()} ta)</option>
              <option value={3}>3 kundan eski yozuvlar ({Number(stats?.older_3d || 0).toLocaleString()} ta)</option>
              <option value={7}>7 kundan eski yozuvlar ({Number(stats?.older_7d || 0).toLocaleString()} ta)</option>
              <option value={14}>14 kundan eski yozuvlar ({Number(stats?.older_14d || 0).toLocaleString()} ta)</option>
              <option value={30}>30 kundan eski yozuvlar ({Number(stats?.older_30d || 0).toLocaleString()} ta)</option>
            </select>
          </div>

          {pruneSuccess && (
            <div
              style={{
                padding: '0.75rem',
                backgroundColor: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid #10b981',
                borderRadius: '8px',
                color: '#10b981',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.88rem',
              }}
            >
              <CheckCircle2 size={18} />
              <span>{pruneSuccess}</span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button className="btn btn-secondary" onClick={() => setPruneModalOpen(false)} disabled={pruning}>
              Bekor qilish
            </button>
            <button
              className="btn btn-danger"
              onClick={handlePrune}
              disabled={pruning}
              style={{ background: '#dc2626', color: '#fff' }}
            >
              {pruning ? 'Tozalanmoqda…' : 'Tozalashni tasdiqlash'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function State({ text, error, retry }) {
  return (
    <div className={'admin-workspace-state ' + (error ? 'error' : '')}>
      {error ? <AlertTriangle /> : <History />}
      <b>{text}</b>
      {retry && (
        <button className="btn" onClick={retry}>
          Qayta urinish
        </button>
      )}
    </div>
  );
}
