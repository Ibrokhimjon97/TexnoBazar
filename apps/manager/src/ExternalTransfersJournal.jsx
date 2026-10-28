import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  Edit3,
  Eye,
  FileText,
  Filter,
  Layers,
  MapPin,
  Package,
  Plus,
  Printer,
  QrCode,
  RotateCcw,
  Search,
  Store,
  Tag,
  Trash2,
  Truck,
  User,
  Warehouse,
  X
} from 'lucide-react';
import {
  DualPrice,
  Empty,
  Modal,
  Status,
  formatDualMoney,
  useExchangeRate
} from '@texnobazar/ui';
import {
  listExternalBranchTransfers,
  getExternalBranchTransfer,
  cancelExternalBranchTransfer,
  deleteExternalBranchTransfer,
  updateExternalBranchTransfer
} from '@texnobazar/data';

const msg = e => String(e?.message || 'Amalni bajarib bo‘lmadi.');

export default function ExternalTransfersJournal({ branchId, toast, rate, onCreateNew }) {
  const [data, setData] = useState({
    items: [],
    total_count: 0,
    total_value_uzs: 0,
    total_value_usd: 0,
    total_items_count: 0,
    page: 1,
    page_size: 30
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters & Search
  const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [priceMode, setPriceMode] = useState('all');
  const [page, setPage] = useState(1);

  // Selected Transfer Detail
  const [detailId, setDetailId] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Edit Modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    id: '',
    transfer_no: '',
    targetBranchName: '',
    targetManagerName: '',
    notes: ''
  });

  const [actionBusy, setActionBusy] = useState(false);

  // Load transfers list
  const loadTransfers = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listExternalBranchTransfers({
        branchId: branchId || null,
        query: query.trim() || null,
        fromDate: fromDate || null,
        toDate: toDate || null,
        priceMode: priceMode === 'all' ? null : priceMode,
        page,
        pageSize: 30
      });
      setData(res || { items: [], total_count: 0, total_value_uzs: 0, total_value_usd: 0, total_items_count: 0 });
    } catch (err) {
      setError(msg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(loadTransfers, query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [branchId, query, fromDate, toDate, priceMode, page]);

  // Load transfer detail
  const openDetail = async id => {
    setDetailId(id);
    setDetailLoading(true);
    try {
      const res = await getExternalBranchTransfer(id);
      setDetailData(res);
    } catch (err) {
      toast?.(msg(err));
      setDetailId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  // Open Edit Dialog
  const openEditModal = (transfer, e) => {
    e?.stopPropagation?.();
    setEditForm({
      id: transfer.id,
      transfer_no: transfer.transfer_no,
      targetBranchName: transfer.target_branch_name || '',
      targetManagerName: transfer.target_manager_name || '',
      notes: transfer.notes || ''
    });
    setEditModalOpen(true);
  };

  // Save Edit
  const handleSaveEdit = async e => {
    e.preventDefault();
    if (!editForm.targetBranchName.trim()) {
      toast?.('Qabul qiluvchi filial nomini kiriting');
      return;
    }
    if (!editForm.targetManagerName.trim()) {
      toast?.('Filial boshlig‘i ismini kiriting');
      return;
    }

    setActionBusy(true);
    try {
      await updateExternalBranchTransfer({
        transferId: editForm.id,
        targetBranchName: editForm.targetBranchName.trim(),
        targetManagerName: editForm.targetManagerName.trim(),
        notes: editForm.notes.trim()
      });

      toast?.('Transfer ma’lumotlari muvaffaqiyatli yangilandi!');
      setEditModalOpen(false);

      // Refresh detail data if open
      if (detailId === editForm.id) {
        const updated = await getExternalBranchTransfer(editForm.id);
        setDetailData(updated);
      }
      loadTransfers();
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // Cancel Transfer and Restore Goods
  const handleCancelTransfer = async (transfer, e) => {
    e?.stopPropagation?.();
    const confirmed = window.confirm(
      `Haqiqatan ham #${transfer.transfer_no} raqamli transferni bekor qilmoqchimisiz?\n\n` +
      `DIQQAT: Ushbu transferdagi ${transfer.total_items_count} dona tovar darhol do‘kon/ombor hisobiga QAYTARILADI!`
    );
    if (!confirmed) return;

    setActionBusy(true);
    try {
      const res = await cancelExternalBranchTransfer(transfer.id, 'Menejer tomonidan bekor qilindi');
      toast?.(`Transfer bekor qilindi! ${res?.returned_units_count || transfer.total_items_count} dona tovar ombor/do‘kon balansiga qaytarildi.`);

      if (detailId === transfer.id) {
        const updated = await getExternalBranchTransfer(transfer.id);
        setDetailData(updated);
      }
      loadTransfers();
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // Delete Transfer
  const handleDeleteTransfer = async (transfer, e) => {
    e?.stopPropagation?.();
    const confirmed = window.confirm(
      `Haqiqatan ham #${transfer.transfer_no} transferini butunlay o‘chirmoqchimisiz?\n\n` +
      `Eslatma: Agar tovarlar hali omborga qaytarilmagan bo‘lsa, ular ham avtomatik ravishda do‘konga qaytariladi.`
    );
    if (!confirmed) return;

    setActionBusy(true);
    try {
      await deleteExternalBranchTransfer(transfer.id);
      toast?.(`#${transfer.transfer_no} transferi o‘chirildi va tovarlar do‘konga qaytarildi.`);
      if (detailId === transfer.id) {
        setDetailId(null);
        setDetailData(null);
      }
      loadTransfers();
    } catch (err) {
      toast?.(msg(err));
    } finally {
      setActionBusy(false);
    }
  };

  // Date shortcuts
  const applyDatePreset = preset => {
    const today = new Date();
    const format = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (preset === 'today') {
      const f = format(today);
      setFromDate(f);
      setToDate(f);
    } else if (preset === 'week') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      setFromDate(format(d));
      setToDate(format(today));
    } else if (preset === 'month') {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      setFromDate(format(d));
      setToDate(format(today));
    } else {
      setFromDate('');
      setToDate('');
    }
    setPage(1);
  };

  const handlePrintReceipt = transfer => {
    if (!transfer) return;
    const printWindow = window.open('', '_blank', 'width=650,height=750');
    if (!printWindow) {
      toast?.('Chop etish oynasini ochib bo‘lmadi');
      return;
    }

    const t = transfer;
    const isCancelled = t.status === 'cancelled';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>Transfer Cheki #${t.transfer_no}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; font-size: 13px; color: #111; }
          .header { text-align: center; border-bottom: 2px dashed #444; padding-bottom: 12px; margin-bottom: 14px; }
          .title { font-size: 18px; font-weight: 800; text-transform: uppercase; margin: 0; }
          .cancelled-badge { display: inline-block; background: #dc2626; color: #fff; padding: 4px 10px; border-radius: 4px; font-weight: 700; margin-top: 6px; }
          .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
          .meta-table td { padding: 4px 0; }
          .lines-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
          .lines-table th, .lines-table td { border-bottom: 1px solid #ddd; padding: 8px 4px; text-align: left; }
          .lines-table th:last-child, .lines-table td:last-child { text-align: right; }
          .total-box { border-top: 2px solid #111; padding-top: 10px; text-align: right; font-size: 16px; font-weight: 800; }
          .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #666; border-top: 1px dashed #aaa; padding-top: 10px; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="header">
          <h2 class="title">FILIALGA TRANSFER HUJJATI</h2>
          <p style="margin: 4px 0;"><b>Hujjat:</b> #${t.transfer_no}</p>
          <p style="margin: 0; font-size: 11px;">Sana: ${new Date(t.created_at).toLocaleString('uz-UZ')}</p>
          ${isCancelled ? '<div class="cancelled-badge">BEKOR QILINGAN (TOVARLAR DO‘KONGA QAYTARILGAN)</div>' : ''}
        </div>
        <table class="meta-table">
          <tr><td><b>Jo‘natuvchi:</b></td><td>${t.branch_name} (${t.from_location_name})</td></tr>
          <tr><td><b>Mas’ul xodim:</b></td><td>${t.seller_name}</td></tr>
          <tr><td><b>Qabul qiluvchi filial:</b></td><td><b>${t.target_branch_name}</b></td></tr>
          <tr><td><b>Filial boshlig‘i:</b></td><td><b>${t.target_manager_name}</b></td></tr>
          <tr><td><b>Narx tartibi:</b></td><td>${t.price_mode === 'cost' ? 'O‘z tannarxi bo‘yicha' : t.price_mode === 'markup' ? 'Tannarxga ustama qo‘yilgan' : t.price_mode === 'wholesale' ? 'Ulgurji narxda' : 'Erkin narx'}</td></tr>
          ${t.notes ? `<tr><td><b>Izoh:</b></td><td>${t.notes}</td></tr>` : ''}
        </table>
        <table class="lines-table">
          <thead>
            <tr>
              <th>№</th>
              <th>Tovar nomi</th>
              <th style="text-align: center;">Soni</th>
              <th style="text-align: right;">Transfer narxi</th>
              <th>Jami summa</th>
            </tr>
          </thead>
          <tbody>
            ${t.lines?.map((line, idx) => `
              <tr>
                <td>${idx + 1}</td>
                <td><b>${line.product_name}</b><br/><small style="color:#666">${line.sku || ''}</small></td>
                <td style="text-align: center;">${line.quantity} ta</td>
                <td style="text-align: right;">
                  ${new Intl.NumberFormat('uz-UZ').format(line.unit_price)} so‘m
                  ${line.unit_price_usd > 0 ? `<br/><small style="color:#555;">($${line.unit_price_usd})</small>` : ''}
                </td>
                <td style="text-align: right;">
                  ${new Intl.NumberFormat('uz-UZ').format(line.total_price)} so‘m
                  ${line.total_price_usd > 0 ? `<br/><small style="color:#555;">($${line.total_price_usd})</small>` : ''}
                </td>
              </tr>
            `).join('') || ''}
          </tbody>
        </table>
        <div class="total-box">
          Jami summa: ${new Intl.NumberFormat('uz-UZ').format(t.total_amount)} so‘m
          ${t.total_amount_usd > 0 ? ` ≈ $${t.total_amount_usd} USD` : ''}
          <div style="font-size: 12px; font-weight: normal; color: #555; margin-top: 3px;">
            (${t.total_items_count} dona tovar)
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top: 40px; padding: 0 10px;">
          <div>Topshirdi: ____________ (${t.seller_name})</div>
          <div>Qabul qildi: ____________ (${t.target_manager_name})</div>
        </div>
        <div class="footer">
          Texnobazar savdo va ombor boshqaruv tizimi
        </div>
        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
      </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
  };

  return (
    <div className="ext-transfers-workspace">
      {/* Top Banner / Actions */}
      <div className="ext-top-bar between">
        <div>
          <h2>Filiallarga tarqatish jurnali</h2>
          <p>Boshqa filiallarga o‘tkazilgan tovarlar, ulgurji/tannarx hisoboti va qaytarish</p>
        </div>
        {onCreateNew && (
          <button type="button" className="btn btn-primary" onClick={onCreateNew}>
            <Plus size={16} /> Yangi filialga transfer
          </button>
        )}
      </div>

      {/* KPI Cards */}
      <div className="ext-kpi-grid">
        <div className="card ext-kpi-card">
          <div className="ext-kpi-icon"><Truck size={22} /></div>
          <div className="ext-kpi-body">
            <small>Jami transferlar</small>
            <b>{data.total_count} ta transfer</b>
          </div>
        </div>

        <div className="card ext-kpi-card">
          <div className="ext-kpi-icon orange"><Boxes size={22} /></div>
          <div className="ext-kpi-body">
            <small>O‘tkazilgan tovarlar</small>
            <b>{data.total_items_count} dona</b>
          </div>
        </div>

        <div className="card ext-kpi-card">
          <div className="ext-kpi-icon green"><Layers size={22} /></div>
          <div className="ext-kpi-body">
            <small>Jami transfer qiymati</small>
            <b>{new Intl.NumberFormat('uz-UZ').format(data.total_value_uzs || 0)} so‘m</b>
            {rate > 0 && <span className="ext-usd-sub">≈ ${(data.total_value_usd || 0).toFixed(2)} USD</span>}
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="card ext-filter-card">
        <div className="ext-search-row">
          <div className="ext-search-input-wrap">
            <Search size={18} className="search-icon" />
            <input
              type="text"
              className="input ext-search-input"
              placeholder="Hujjat raqami, filial nomi, rahbar ismi yoki tovar nomi bo‘yicha qidiring..."
              value={query}
              onChange={e => { setQuery(e.target.value); setPage(1); }}
            />
            {query && (
              <button type="button" className="btn-clear" onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="ext-filter-controls">
          <div className="ext-date-presets">
            <button
              type="button"
              className={`btn btn-sm ${!fromDate && !toDate ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => applyDatePreset('all')}
            >
              Hammasi
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => applyDatePreset('today')}
            >
              Bugun
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => applyDatePreset('week')}
            >
              7 kun
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => applyDatePreset('month')}
            >
              Bu oy
            </button>
          </div>

          <div className="ext-date-inputs">
            <input
              type="date"
              className="input ext-date-input"
              value={fromDate}
              onChange={e => { setFromDate(e.target.value); setPage(1); }}
              title="Boshlanish sanasi"
            />
            <span>—</span>
            <input
              type="date"
              className="input ext-date-input"
              value={toDate}
              onChange={e => { setToDate(e.target.value); setPage(1); }}
              title="Tugash sanasi"
            />
          </div>

          <div className="ext-select-wrap">
            <select
              className="select"
              value={priceMode}
              onChange={e => { setPriceMode(e.target.value); setPage(1); }}
            >
              <option value="all">Barcha narx turlari</option>
              <option value="cost">🏷️ Tannarxi bo‘yicha</option>
              <option value="markup">📈 Tannarxga ustama</option>
              <option value="wholesale">💎 Ulgurji narxda</option>
              <option value="custom">✏️ Erkin / Boshqa narx</option>
            </select>
          </div>

          {(query || fromDate || toDate || priceMode !== 'all') && (
            <button
              type="button"
              className="btn btn-ghost btn-sm ext-reset-btn"
              onClick={() => {
                setQuery('');
                setFromDate('');
                setToDate('');
                setPriceMode('all');
                setPage(1);
              }}
            >
              <RotateCcw size={13} /> Filtrlarni tozalash
            </button>
          )}
        </div>
      </div>

      {/* Main Journal Content */}
      {loading ? (
        <div className="ext-state-box">Transferlar jurnali yuklanmoqda…</div>
      ) : error ? (
        <div className="ext-state-box error">
          <AlertTriangle size={24} />
          <b>Xatolik yuz berdi</b>
          <p>{error}</p>
          <button type="button" className="btn btn-outline" onClick={loadTransfers}>
            Qayta urinish
          </button>
        </div>
      ) : data.items.length === 0 ? (
        <Empty
          title="Transferlar topilmadi"
          text="Belgilangan qidiruv yoki filtr bo‘yicha filialga transferlar mavjud emas."
        />
      ) : (
        <div className="ext-transfers-list">
          {data.items.map(row => {
            const isCancelled = row.status === 'cancelled';
            return (
              <div
                key={row.id}
                className={`card ext-transfer-card ${isCancelled ? 'ext-card-cancelled' : ''}`}
                onClick={() => openDetail(row.id)}
              >
                <div className="ext-card-header between">
                  <div className="ext-doc-badge">
                    <Truck size={17} />
                    <b>{row.transfer_no}</b>
                    {isCancelled ? (
                      <Status type="red">Bekor qilingan (Tovarlar qaytarilgan)</Status>
                    ) : (
                      <Status type="green">Bajarilgan</Status>
                    )}
                  </div>
                  <div className="ext-doc-date">
                    <Clock size={13} />
                    <span>{new Date(row.created_at).toLocaleString('uz-UZ')}</span>
                  </div>
                </div>

                <div className="ext-card-body">
                  <div className="ext-route-box">
                    <div className="ext-party from">
                      <small>Jo‘natilgan joy</small>
                      <b>{row.from_location_name}</b>
                      <em>{row.branch_name}</em>
                    </div>
                    <div className="ext-arrow">→</div>
                    <div className="ext-party to">
                      <small>Qabul qiluvchi filial</small>
                      <b>{row.target_branch_name}</b>
                      <em>Filial boshlig‘i: {row.target_manager_name}</em>
                    </div>
                  </div>

                  <div className="ext-card-meta-grid">
                    <div>
                      <small>Mas’ul xodim:</small>
                      <span><User size={13} /> {row.seller_name}</span>
                    </div>
                    <div>
                      <small>Narx hisobi:</small>
                      <span className={`ext-mode-badge ${row.price_mode}`}>
                        {row.price_mode === 'cost' ? '🏷️ Tannarx bo‘yicha'
                          : row.price_mode === 'markup' ? '📈 Tannarxga ustama'
                          : row.price_mode === 'wholesale' ? '💎 Ulgurji narx'
                          : '✏️ Erkin narx'}
                      </span>
                    </div>
                    <div>
                      <small>Tovarlar miqdori:</small>
                      <b>{row.total_items_count} dona tovar ({row.lines?.length || 0} xil)</b>
                    </div>
                    <div className="ext-total-side">
                      <small>Umumiy qiymati:</small>
                      <b className="ext-total-amount">
                        <DualPrice value={Number(row.total_amount)} rate={rate} />
                      </b>
                    </div>
                  </div>

                  {/* Preview of top products */}
                  {row.lines?.length > 0 && (
                    <div className="ext-lines-preview">
                      {row.lines.slice(0, 4).map((line, idx) => (
                        <span key={line.id || idx} className="ext-line-chip">
                          {line.product_name} <b>({line.quantity} ta)</b>
                        </span>
                      ))}
                      {row.lines.length > 4 && (
                        <span className="ext-line-chip more">
                          +{row.lines.length - 4} ta boshqa mahsulot
                        </span>
                      )}
                    </div>
                  )}

                  {row.notes && (
                    <div className={`ext-card-notes ${isCancelled ? 'cancelled' : ''}`}>
                      <b>Izoh:</b> {row.notes}
                    </div>
                  )}
                </div>

                <div className="ext-card-footer between">
                  <div className="ext-card-actions-quick" onClick={e => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={e => openEditModal(row, e)}
                    >
                      <Edit3 size={13} /> Tahrirlash
                    </button>
                    {!isCancelled && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline text-danger"
                        onClick={e => handleCancelTransfer(row, e)}
                      >
                        <RotateCcw size={13} /> Bekor qilish (Tovarni qaytarish)
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost text-danger"
                      onClick={e => handleDeleteTransfer(row, e)}
                    >
                      <Trash2 size={13} /> O‘chirish
                    </button>
                  </div>
                  <div className="flex-gap">
                    <span className="ext-click-hint">Batafsil / Chek</span>
                    <ChevronRight size={18} className="chevron" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      <Modal
        open={Boolean(detailId)}
        onClose={() => { setDetailId(null); setDetailData(null); }}
        title={detailData ? `Transfer: #${detailData.transfer_no}` : 'Transfer tafsilotlari'}
        wide
      >
        {detailLoading ? (
          <div className="ext-state-box">Tafsilotlar yuklanmoqda…</div>
        ) : detailData ? (
          <div className="ext-detail-modal">
            {/* Top Info Banner */}
            <div className="ext-detail-header-card card">
              <div className="between">
                <div>
                  <h3 className="ext-detail-title">#{detailData.transfer_no}</h3>
                  <p className="ext-detail-sub">
                    {new Date(detailData.created_at).toLocaleString('uz-UZ')} · Status:{' '}
                    {detailData.status === 'cancelled' ? (
                      <Status type="red">Bekor qilingan (Tovarlar do‘konga qaytarilgan)</Status>
                    ) : (
                      <Status type="green">Bajarilgan</Status>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => handlePrintReceipt(detailData)}
                >
                  <Printer size={16} /> Chekni chop etish
                </button>
              </div>

              <div className="ext-detail-parties-grid">
                <div>
                  <small>Jo‘natuvchi joy:</small>
                  <b>{detailData.from_location_name}</b>
                  <span>{detailData.branch_name}</span>
                </div>
                <div>
                  <small>Qabul qiluvchi filial:</small>
                  <b>{detailData.target_branch_name}</b>
                  <span>Rahbar: {detailData.target_manager_name}</span>
                </div>
                <div>
                  <small>Mas’ul xodim:</small>
                  <b>{detailData.seller_name}</b>
                </div>
                <div>
                  <small>Narx rejimi:</small>
                  <b className="capitalize">
                    {detailData.price_mode === 'cost' ? '🏷️ Tannarxi bo‘yicha'
                      : detailData.price_mode === 'markup' ? '📈 Tannarxga ustama'
                      : detailData.price_mode === 'wholesale' ? '💎 Ulgurji narx'
                      : '✏️ Erkin narx'}
                  </b>
                </div>
              </div>

              {detailData.notes && (
                <div className={`ext-detail-notes ${detailData.status === 'cancelled' ? 'cancelled' : ''}`}>
                  <b>Izoh:</b> {detailData.notes}
                </div>
              )}
            </div>

            {/* Transferred Goods Lines */}
            <div className="ext-detail-lines-box">
              <div className="between ext-lines-title">
                <h4>O‘tkazilgan tovarlar ({detailData.lines?.length || 0} xil mahsulot, {detailData.total_items_count} dona)</h4>
                <b>Jami qiymat: <DualPrice value={Number(detailData.total_amount)} rate={rate} /></b>
              </div>

              <div className="ext-detail-table-wrap">
                <table className="ext-detail-table">
                  <thead>
                    <tr>
                      <th>№</th>
                      <th>Tovar</th>
                      <th style={{ textAlign: 'center' }}>Soni</th>
                      <th style={{ textAlign: 'right' }}>1 dona narxi</th>
                      <th style={{ textAlign: 'right' }}>Jami summa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailData.lines?.map((line, idx) => (
                      <tr key={line.id || idx}>
                        <td className="text-muted">{idx + 1}</td>
                        <td>
                          <div className="ext-table-prod">
                            {line.image ? (
                              <img src={line.image} alt="" className="ext-table-thumb" />
                            ) : (
                              <div className="ext-table-thumb fallback"><Package size={16} /></div>
                            )}
                            <div>
                              <b>{line.product_name}</b>
                              <small>{line.sku || 'SKU yo‘q'}</small>
                              {line.qr_codes?.length > 0 && (
                                <details className="ext-qr-collapse">
                                  <summary>{line.qr_codes.length} ta QR kod</summary>
                                  <div className="ext-qr-chips">
                                    {line.qr_codes.map(qr => (
                                      <span key={qr} className="ext-qr-code-pill">{qr}</span>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <b>{line.quantity} dona</b>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <DualPrice value={Number(line.unit_price)} rate={rate} />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <b><DualPrice value={Number(line.total_price)} rate={rate} /></b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Bottom Actions */}
            <div className="ext-modal-footer between">
              <div className="ext-modal-footer-left">
                {detailData.status !== 'cancelled' && (
                  <button
                    type="button"
                    className="btn btn-outline text-danger"
                    disabled={actionBusy}
                    onClick={() => handleCancelTransfer(detailData)}
                  >
                    <RotateCcw size={15} /> Transferni bekor qilish (Tovarlarni qaytarish)
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost text-danger"
                  disabled={actionBusy}
                  onClick={() => handleDeleteTransfer(detailData)}
                >
                  <Trash2 size={15} /> O‘chirish
                </button>
              </div>

              <div className="ext-modal-footer-right">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => openEditModal(detailData)}
                >
                  <Edit3 size={15} /> Tahrirlash
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => { setDetailId(null); setDetailData(null); }}
                >
                  Yopish
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handlePrintReceipt(detailData)}
                >
                  <Printer size={16} /> Hujjatni chop etish
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Edit Transfer Modal */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={`Transferni tahrirlash #${editForm.transfer_no}`}
      >
        <form onSubmit={handleSaveEdit} className="ext-edit-modal-form">
          <div className="ext-form-field">
            <label>Qabul qiluvchi do‘kon/filial nomi *</label>
            <input
              type="text"
              className="input"
              value={editForm.targetBranchName}
              onChange={e => setEditForm({ ...editForm, targetBranchName: e.target.value })}
              required
              disabled={actionBusy}
            />
          </div>

          <div className="ext-form-field">
            <label>Filial boshlig‘i (mas’ul shaxs) ismi *</label>
            <input
              type="text"
              className="input"
              value={editForm.targetManagerName}
              onChange={e => setEditForm({ ...editForm, targetManagerName: e.target.value })}
              required
              disabled={actionBusy}
            />
          </div>

          <div className="ext-form-field">
            <label>Izoh</label>
            <textarea
              className="textarea"
              rows="3"
              value={editForm.notes}
              onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
              placeholder="Qo‘shimcha eslatma..."
              disabled={actionBusy}
            />
          </div>

          <div className="ext-edit-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setEditModalOpen(false)}
              disabled={actionBusy}
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={actionBusy}
            >
              {actionBusy ? 'Saqlanmoqda…' : 'O‘zgarishlarni saqlash'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
