import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  MapPin,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import { Modal, Status } from '@texnobazar/ui';
import {
  adminManualSetAttendance,
  deleteEmployeeAttendance,
  formatUzDate,
  formatUzTime,
  formatWorkedDuration,
  getAttendanceList,
  getGoogleMapsUrl,
  getUzWeekday,
  listBranchEmployees,
} from '@texnobazar/data';

function toDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function AttendanceWorkspace({ branchId, toast }) {
  const todayStr = useMemo(() => toDateString(new Date()), []);
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [preset, setPreset] = useState('today'); // 'today' | 'week' | 'month' | 'custom'
  const [employeeId, setEmployeeId] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [employees, setEmployees] = useState([]);
  const [data, setData] = useState({ items: [], summary: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Load branch employees for dropdown
  useEffect(() => {
    if (!branchId) return;
    listBranchEmployees(branchId)
      .then(res => setEmployees(res || []))
      .catch(() => {});
  }, [branchId]);

  // Preset handlers
  const handlePresetChange = p => {
    setPreset(p);
    const now = new Date();
    if (p === 'today') {
      const s = toDateString(now);
      setFrom(s);
      setTo(s);
    } else if (p === 'week') {
      const startOfWeek = new Date(now);
      const day = startOfWeek.getDay() || 7;
      startOfWeek.setDate(startOfWeek.getDate() - day + 1);
      setFrom(toDateString(startOfWeek));
      setTo(toDateString(now));
    } else if (p === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      setFrom(toDateString(startOfMonth));
      setTo(toDateString(now));
    }
  };

  // Fetch Attendance List
  const loadData = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      const res = await getAttendanceList({
        branchId,
        employeeId: employeeId || null,
        from,
        to,
        search: debouncedSearch || null,
      });
      setData(res || { items: [], summary: null });
    } catch (e) {
      setError(e?.message || 'Davomat ma’lumotlarini yuklab bo‘lmadi.');
    } finally {
      setLoading(false);
    }
  }, [branchId, employeeId, from, to, debouncedSearch]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Edit / Manual Attendance Modal State
  const [editItem, setEditItem] = useState(null);
  const [editForm, setEditForm] = useState({ checkInTime: '', checkOutTime: '', notes: '' });
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Delete Attendance State
  const [deletingItem, setDeletingItem] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleDeleteAttendance = async () => {
    if (!deletingItem) return;
    setDeleteBusy(true);
    try {
      await deleteEmployeeAttendance([deletingItem.id]);
      toast?.('Davomat muvaffaqiyatli o‘chirildi!');
      setDeletingItem(null);
      loadData();
    } catch (err) {
      toast?.(err?.message || 'Davomatni o‘chirishda xatolik yuz berdi.');
    } finally {
      setDeleteBusy(false);
    }
  };

  const extractTimeStr = iso => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const str = d.toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });
      return str;
    } catch {
      return '';
    }
  };

  const openEditModal = item => {
    setEditItem(item);
    setEditForm({
      checkInTime: extractTimeStr(item.check_in_at) || '09:00',
      checkOutTime: extractTimeStr(item.check_out_at) || (item.status === 'missed_checkout' || (!item.check_out_at && item.work_date < todayStr) ? '18:00' : ''),
      notes: item.notes || '',
    });
  };

  const handleSaveEdit = async e => {
    e?.preventDefault();
    if (!editItem) return;
    if (!editForm.checkOutTime) {
      toast?.('Ketish vaqtini kiritish majburiy!');
      return;
    }
    setEditSubmitting(true);
    try {
      await adminManualSetAttendance({
        attendanceId: editItem.id,
        checkInTime: editForm.checkInTime || null,
        checkOutTime: editForm.checkOutTime || null,
        notes: editForm.notes || null,
      });
      toast?.('Davomat ma’lumotlari muvaffaqiyatli saqlandi!');
      setEditItem(null);
      loadData();
    } catch (err) {
      toast?.(err?.message || 'Davomatni saqlashda xatolik yuz berdi.');
    } finally {
      setEditSubmitting(false);
    }
  };

  // Export to Excel / CSV
  const handleExport = async () => {
    if (!data.items?.length) {
      toast?.('Eksport qilish uchun ma’lumot mavjud emas');
      return;
    }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Texnobazar';
      const ws = wb.addWorksheet('Davomat');

      ws.columns = [
        { header: 'Sana', key: 'work_date', width: 14 },
        { header: 'Xodim', key: 'employee_name', width: 25 },
        { header: 'Roli', key: 'employee_role', width: 15 },
        { header: 'Telefon', key: 'employee_phone', width: 18 },
        { header: 'Kelgan vaqti', key: 'check_in_time', width: 15 },
        { header: 'Kelgan lokatsiya', key: 'check_in_maps', width: 35 },
        { header: 'Ketgan vaqti', key: 'check_out_time', width: 15 },
        { header: 'Ketgan lokatsiya', key: 'check_out_maps', width: 35 },
        { header: 'Ishlagan vaqti', key: 'worked_str', width: 20 },
        { header: 'Holati', key: 'status', width: 15 },
      ];

      data.items.forEach(item => {
        ws.addRow({
          work_date: item.work_date,
          employee_name: item.employee_name || '—',
          employee_role: item.employee_role || '—',
          employee_phone: item.employee_phone || '—',
          check_in_time: item.check_in_at ? new Date(item.check_in_at).toLocaleTimeString('uz-UZ') : '—',
          check_in_maps: item.check_in_lat ? getGoogleMapsUrl(item.check_in_lat, item.check_in_lng) : '—',
          check_out_time: item.check_out_at ? new Date(item.check_out_at).toLocaleTimeString('uz-UZ') : '—',
          check_out_maps: item.check_out_lat ? getGoogleMapsUrl(item.check_out_lat, item.check_out_lng) : '—',
          worked_str: formatWorkedDuration(item.worked_minutes),
          status: item.status === 'completed' ? 'Yakunlangan' : 'Ishda',
        });
      });

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `davomat-${from}-${to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast?.('Davomat hisoboti Excel fayliga yuklab olindi');
    } catch (e) {
      toast?.('Eksportda xatolik yuz berdi');
    }
  };

  const selectedEmployeeObj = useMemo(() => {
    if (!employeeId) return null;
    return employees.find(e => e.id === employeeId) || null;
  }, [employeeId, employees]);

  const summary = data.summary || {};

  return (
    <div className="attendance-workspace" style={{ padding: '4px 0' }}>
      {/* Top Filter Bar */}
      <div className="admin-filterbar" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Preset Buttons */}
        <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 4, borderRadius: 10 }}>
          <button
            type="button"
            className={`btn ${preset === 'today' ? '' : 'secondary'}`}
            style={{ padding: '6px 12px', fontSize: 12, borderRadius: 8 }}
            onClick={() => handlePresetChange('today')}
          >
            Bugun
          </button>
          <button
            type="button"
            className={`btn ${preset === 'week' ? '' : 'secondary'}`}
            style={{ padding: '6px 12px', fontSize: 12, borderRadius: 8 }}
            onClick={() => handlePresetChange('week')}
          >
            Bu hafta
          </button>
          <button
            type="button"
            className={`btn ${preset === 'month' ? '' : 'secondary'}`}
            style={{ padding: '6px 12px', fontSize: 12, borderRadius: 8 }}
            onClick={() => handlePresetChange('month')}
          >
            Bu oy
          </button>
        </div>

        {/* Date Inputs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={16} color="var(--muted)" />
          <input
            type="date"
            className="input"
            value={from}
            onChange={e => {
              setPreset('custom');
              setFrom(e.target.value);
            }}
            style={{ padding: '7px 10px', fontSize: 12 }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
          <input
            type="date"
            className="input"
            value={to}
            onChange={e => {
              setPreset('custom');
              setTo(e.target.value);
            }}
            style={{ padding: '7px 10px', fontSize: 12 }}
          />
        </div>

        {/* Employee Dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <User size={16} color="var(--muted)" />
          <select
            className="select"
            value={employeeId}
            onChange={e => setEmployeeId(e.target.value)}
            style={{ padding: '7px 12px', fontSize: 12, minWidth: 170 }}
          >
            <option value="">Barcha xodimlar</option>
            {employees.map(emp => (
              <option key={emp.id} value={emp.id}>
                {emp.full_name || emp.email} ({emp.role || 'xodim'})
              </option>
            ))}
          </select>
        </div>

        {/* Search Input */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 }}>
          <Search size={16} color="var(--muted)" />
          <input
            type="text"
            className="input"
            placeholder="Xodim ismi yoki tel…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '7px 10px', fontSize: 12 }}
          />
        </label>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button
            type="button"
            className="btn secondary"
            onClick={loadData}
            disabled={loading}
            title="Yangilash"
            style={{ padding: '7px 12px' }}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleExport}
            style={{ padding: '7px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Download size={15} /> Excel
          </button>
        </div>
      </div>

      {/* Selected Single Employee Banner (if viewing 1 employee over 1 month / period) */}
      {selectedEmployeeObj && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            padding: 14,
            background: 'linear-gradient(135deg, #f0fdf4, #e0f2fe)',
            border: '1px solid #bbf7d0',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: '50%',
                background: 'var(--orange)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 700,
                fontSize: 18,
              }}
            >
              {selectedEmployeeObj.full_name?.charAt(0)?.toUpperCase() || 'X'}
            </div>
            <div>
              <b style={{ fontSize: 15, display: 'block' }}>{selectedEmployeeObj.full_name}</b>
              <small style={{ color: 'var(--muted)', fontSize: 12 }}>
                Roli: <strong style={{ textTransform: 'capitalize' }}>{selectedEmployeeObj.role}</strong> | Tel: {selectedEmployeeObj.phone || '—'}
              </small>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Oraliq davomat:</span>
              <b style={{ fontSize: 15, color: '#16a34a' }}>
                {summary.total_records || 0} kun
              </b>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)', display: 'block' }}>Jami ishlangan:</span>
              <b style={{ fontSize: 15, color: 'var(--orange)' }}>
                {formatWorkedDuration(summary.total_worked_minutes)}
              </b>
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, var(--line, #e2e8f0))', borderRadius: 14, padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--orange-soft, #ffedd5)', display: 'grid', placeItems: 'center', color: 'var(--orange, #f97316)', flexShrink: 0 }}>
            <Users size={22} />
          </div>
          <div>
            <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, display: 'block' }}>Xodimlar soni</small>
            <b style={{ fontSize: 17, color: 'var(--navy, #0f172a)', display: 'block' }}>{summary.unique_employees || 0} kishi</b>
          </div>
        </div>

        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, var(--line, #e2e8f0))', borderRadius: 14, padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: '#dcfce7', display: 'grid', placeItems: 'center', color: '#16a34a', flexShrink: 0 }}>
            <CheckCircle2 size={22} />
          </div>
          <div>
            <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, display: 'block' }}>Davomat qaydlari</small>
            <b style={{ fontSize: 17, color: '#16a34a', display: 'block' }}>{summary.total_records || 0} ta</b>
          </div>
        </div>

        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, var(--line, #e2e8f0))', borderRadius: 14, padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: '#e0f2fe', display: 'grid', placeItems: 'center', color: '#0284c7', flexShrink: 0 }}>
            <Clock size={22} />
          </div>
          <div>
            <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, display: 'block' }}>Hozir ishda</small>
            <b style={{ fontSize: 17, color: '#0284c7', display: 'block' }}>{summary.currently_working || 0} kishi</b>
          </div>
        </div>

        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, var(--line, #e2e8f0))', borderRadius: 14, padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: '#f1f5f9', display: 'grid', placeItems: 'center', color: '#64748b', flexShrink: 0 }}>
            <CheckCircle2 size={22} />
          </div>
          <div>
            <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, display: 'block' }}>Yakunlangan smenalar</small>
            <b style={{ fontSize: 17, color: 'var(--navy, #0f172a)', display: 'block' }}>{summary.completed_shifts || 0} ta</b>
          </div>
        </div>

        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border, var(--line, #e2e8f0))', borderRadius: 14, padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: '#fff7ed', display: 'grid', placeItems: 'center', color: 'var(--orange, #f97316)', flexShrink: 0 }}>
            <Clock size={22} />
          </div>
          <div>
            <small style={{ color: 'var(--muted, #64748b)', fontSize: 11, display: 'block' }}>Jami ishlangan vaqt</small>
            <b style={{ fontSize: 17, color: 'var(--orange, #f97316)', display: 'block' }}>{formatWorkedDuration(summary.total_worked_minutes)}</b>
          </div>
        </div>
      </div>

      {/* Main Table */}
      {error ? (
        <div className="admin-workspace-state error"><p>{error}</p></div>
      ) : loading ? (
        <div className="admin-workspace-state"><p>Davomat yuklanmoqda…</p></div>
      ) : data.items?.length === 0 ? (
        <div className="admin-inline-empty">Belgilangan oraliqda davomat yozuvlari topilmadi.</div>
      ) : (
        <div className="table-wrap card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', minWidth: 800 }}>
            <thead>
              <tr>
                <th>Sana</th>
                <th>Xodim</th>
                <th>Roli</th>
                <th>Kelgan vaqti & Lokatsiya</th>
                <th>Ketgan vaqti & Lokatsiya</th>
                <th>Ishlagan vaqti</th>
                <th>Holati</th>
                <th>Amallar</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(row => {
                const checkInUrl = getGoogleMapsUrl(row.check_in_lat, row.check_in_lng);
                const checkOutUrl = getGoogleMapsUrl(row.check_out_lat, row.check_out_lng);
                const isWorking = row.status === 'checked_in';
                const isMissed = row.status === 'missed_checkout' || (!row.check_out_at && row.work_date < todayStr);

                return (
                  <tr key={row.id}>
                    <td>
                      <b style={{ fontSize: 13 }}>{formatUzDate(row.work_date, { day: true, month: 'long', year: true })}</b>
                      <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11, fontWeight: 500 }}>
                        {getUzWeekday(row.work_date, { short: false })}
                      </small>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            background: '#ffedd5',
                            color: '#ea580c',
                            display: 'grid',
                            placeItems: 'center',
                            fontSize: 13,
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          {row.employee_name?.charAt(0)?.toUpperCase() || 'X'}
                        </div>
                        <div>
                          <b style={{ fontSize: 13, display: 'block' }}>{row.employee_name}</b>
                          <small style={{ color: 'var(--muted)', fontSize: 11 }}>{row.employee_phone || row.employee_email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: 11,
                          padding: '3px 8px',
                          background: '#f1f5f9',
                          borderRadius: 6,
                          fontWeight: 600,
                          textTransform: 'capitalize',
                        }}
                      >
                        {row.employee_role || 'xodim'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <b style={{ fontSize: 13 }}>
                          {row.check_in_at ? formatUzTime(row.check_in_at) : '—'}
                        </b>
                        {checkInUrl ? (
                          <a
                            href={checkInUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              color: '#2563eb',
                              fontSize: 11,
                              textDecoration: 'none',
                              background: '#eff6ff',
                              padding: '3px 7px',
                              borderRadius: 6,
                              fontWeight: 600,
                            }}
                          >
                            <MapPin size={12} /> Xarita <ExternalLink size={10} />
                          </a>
                        ) : (
                          <small style={{ color: 'var(--muted)', fontSize: 10 }}>Lokatsiya yo‘q</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <b style={{ fontSize: 13 }}>
                          {row.check_out_at ? formatUzTime(row.check_out_at) : '—'}
                        </b>
                        {checkOutUrl ? (
                          <a
                            href={checkOutUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              color: '#2563eb',
                              fontSize: 11,
                              textDecoration: 'none',
                              background: '#eff6ff',
                              padding: '3px 7px',
                              borderRadius: 6,
                              fontWeight: 600,
                            }}
                          >
                            <MapPin size={12} /> Xarita <ExternalLink size={10} />
                          </a>
                        ) : (
                          <small style={{ color: 'var(--muted)', fontSize: 10 }}>{isWorking ? 'Ishda' : '—'}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <b style={{ color: 'var(--orange)', fontSize: 13 }}>
                        {formatWorkedDuration(row.worked_minutes)}
                      </b>
                    </td>
                    <td>
                      {isMissed ? (
                        <Status type="red">⚠️ Ketish kiritilmagan</Status>
                      ) : isWorking ? (
                        <Status type="green">● Ishda</Status>
                      ) : (
                        <Status type="gray">✓ Yakunlangan</Status>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          type="button"
                          className="btn secondary"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '4px 8px',
                            fontSize: 11,
                            borderRadius: 7,
                            background: isMissed ? '#fff1f2' : '#f8fafc',
                            borderColor: isMissed ? '#fecdd3' : '#e2e8f0',
                            color: isMissed ? '#e11d48' : '#334155',
                            fontWeight: 600,
                          }}
                          onClick={() => openEditModal(row)}
                        >
                          <Pencil size={11} />
                          {isMissed ? 'Vaqt kiritish' : 'Tahrirlash'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 8px',
                            fontSize: 11,
                            borderRadius: 7,
                            background: '#fff1f2',
                            borderColor: '#fecdd3',
                            color: '#e11d48',
                            fontWeight: 600,
                          }}
                          onClick={() => setDeletingItem(row)}
                          title="Davomatni o‘chirish"
                        >
                          <Trash2 size={11} />
                          O‘chirish
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / Set Attendance Modal for Manager */}
      <Modal
        open={Boolean(editItem)}
        onClose={() => setEditItem(null)}
        title="Davomat vaqtini kiritish / tahrirlash"
      >
        {editItem && (
          <form onSubmit={handleSaveEdit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
              <b style={{ fontSize: 13, display: 'block', color: 'var(--navy)' }}>{editItem.employee_name}</b>
              <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                {formatUzDate(editItem.work_date, { day: true, month: 'long', year: true, weekday: 'long' })}
              </small>
            </div>

            {(editItem.status === 'missed_checkout' || (!editItem.check_out_at && editItem.work_date < todayStr)) && (
              <div style={{ padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecdd3', borderRadius: 10, color: '#991b1b', fontSize: 12, lineHeight: 1.5 }}>
                ⚠️ Xodim ketish tugmasini bosishni unutgan (kechasi 00:00 da smena yopilgan). Ketish vaqtini kiritsangiz, umumiy ishlangan vaqt avtomatik hisoblanadi.
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Kelgan vaqti:
                </label>
                <input
                  type="time"
                  className="input"
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13 }}
                  value={editForm.checkInTime}
                  onChange={e => setEditForm(prev => ({ ...prev, checkInTime: e.target.value }))}
                  required
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Ketgan vaqti:
                </label>
                <input
                  type="time"
                  className="input"
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13 }}
                  value={editForm.checkOutTime}
                  onChange={e => setEditForm(prev => ({ ...prev, checkOutTime: e.target.value }))}
                  required
                />
              </div>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Izoh / Sababi:
              </label>
              <textarea
                className="input"
                rows={2}
                placeholder="Masalan: Xodim 18:00 gacha ishlagan, tizimda tugmani bosishni unutgan"
                style={{ width: '100%', padding: '8px 10px', fontSize: 12, resize: 'vertical' }}
                value={editForm.notes}
                onChange={e => setEditForm(prev => ({ ...prev, notes: e.target.value }))}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setEditItem(null)}
                disabled={editSubmitting}
              >
                Bekor qilish
              </button>
              <button
                type="submit"
                className="btn"
                disabled={editSubmitting}
                style={{ background: 'var(--orange)', borderColor: 'var(--orange)', color: '#fff' }}
              >
                {editSubmitting ? 'Saqlanmoqda…' : 'Saqlash'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Delete Attendance Confirmation Modal */}
      <Modal
        open={Boolean(deletingItem)}
        onClose={() => !deleteBusy && setDeletingItem(null)}
        title="Davomatni o‘chirish"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--navy)' }}>
            Haqiqatan ham <b>{deletingItem?.employee_name}</b> xodimining{' '}
            <b>{deletingItem?.work_date ? formatUzDate(deletingItem.work_date) : ''}</b> kungi davomat yozuvini o‘chirmoqchimisiz?
          </p>
          <div
            style={{
              padding: '10px 14px',
              background: '#fff1f2',
              border: '1px solid #fecdd3',
              borderRadius: 8,
              fontSize: 13,
              color: '#be123c',
            }}
          >
            Ushbu yozuv o‘chirilgandan so‘ng xodimning o‘z profilida ham davomat bekor qilinadi va u shu kuni kelmagan hisoblanadi.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button
              type="button"
              className="btn secondary"
              disabled={deleteBusy}
              onClick={() => setDeletingItem(null)}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="btn"
              disabled={deleteBusy}
              style={{ background: '#e11d48', borderColor: '#e11d48', color: '#fff', fontWeight: 600 }}
              onClick={handleDeleteAttendance}
            >
              {deleteBusy ? 'O‘chirilmoqda…' : 'Ha, o‘chirish'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
