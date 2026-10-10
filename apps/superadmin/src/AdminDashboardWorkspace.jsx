import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Award,
  BarChart3,
  Boxes,
  Building,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  Layers,
  MapPin,
  Package,
  PieChart as PieIcon,
  RefreshCw,
  ShoppingCart,
  Store,
  TrendingDown,
  TrendingUp,
  Truck,
  UserCheck,
  Users,
  Wallet,
  Warehouse,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DualPrice, Status, formatDualMoney, useExchangeRate } from '@texnobazar/ui';
import {
  formatUzDate,
  formatUzTime,
  formatWorkedDuration,
  getAdminDashboardMetrics,
} from '@texnobazar/data';

const toDateStr = d => d.toISOString().split('T')[0];
const todayStr = () => toDateStr(new Date());

const weekAgoStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return toDateStr(d);
};

const monthAgoStr = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return toDateStr(d);
};

const yearAgoStr = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return toDateStr(d);
};

const CHART_COLORS = ['#f97316', '#2563eb', '#16a34a', '#8b5cf6', '#eab308', '#dc2626', '#0891b2', '#ec4899'];

const EXPENSE_CATEGORY_NAMES = {
  rent: 'Ijara',
  salary: 'Xodimlar oyligi',
  tax: 'Soliqlar',
  electricity: 'Elektr energiyasi',
  water: 'Suv ta’minoti',
  gas: 'Gaz ta’minoti',
  transport: 'Transport / Yetkazib berish',
  marketing: 'Marketing va reklama',
  office: 'Ofis va xo‘jalik',
  other: 'Boshqa operatsion',
};

const formatCompactMoney = val => {
  const num = Number(val) || 0;
  if (Math.abs(num) >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)} mlrd`;
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(1)} mln`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(0)} ming`;
  return `${num}`;
};

export default function AdminDashboardWorkspace({ go }) {
  const rate = useExchangeRate();
  const [period, setPeriod] = useState('month'); // default to 'month' so current month stats are visible immediately
  const [from, setFrom] = useState(monthAgoStr());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Month-over-month comparison interactive controls
  const [chartType, setChartType] = useState('bar'); // 'bar' | 'area' | 'line'
  const [chartMetric, setChartMetric] = useState('all'); // 'all' | 'sales' | 'profit' | 'expenses'
  const [compareMonthA, setCompareMonthA] = useState('');
  const [compareMonthB, setCompareMonthB] = useState('');

  // Handle period presets
  const handlePeriodChange = p => {
    setPeriod(p);
    const now = new Date();
    if (p === 'today') {
      const s = todayStr();
      setFrom(s);
      setTo(s);
    } else if (p === 'week') {
      setFrom(weekAgoStr());
      setTo(todayStr());
    } else if (p === 'month') {
      // Current month from 1st day to today
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      setFrom(toDateStr(firstDay));
      setTo(todayStr());
    } else if (p === 'last_month') {
      const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      setFrom(toDateStr(firstDayLastMonth));
      setTo(toDateStr(lastDayLastMonth));
    } else if (p === 'year') {
      setFrom(yearAgoStr());
      setTo(todayStr());
    }
  };

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getAdminDashboardMetrics({ from, to });
      setData(res);
      // Initialize comparison months with current month and previous month
      if (res?.monthly_comparison?.length >= 2) {
        const lastIdx = res.monthly_comparison.length - 1;
        setCompareMonthA(res.monthly_comparison[lastIdx].month);
        setCompareMonthB(res.monthly_comparison[lastIdx - 1].month);
      }
    } catch (err) {
      console.error('Boshqaruv dashboardini yuklashda xatolik:', err);
      setError(err?.message || 'Dashboard ma’lumotlarini yuklab bo‘lmadi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [from, to]);

  // Calculations for Side-by-Side Month Comparison
  const monthAData = useMemo(() => {
    if (!data?.monthly_comparison?.length || !compareMonthA) return null;
    return data.monthly_comparison.find(m => m.month === compareMonthA) || null;
  }, [data, compareMonthA]);

  const monthBData = useMemo(() => {
    if (!data?.monthly_comparison?.length || !compareMonthB) return null;
    return data.monthly_comparison.find(m => m.month === compareMonthB) || null;
  }, [data, compareMonthB]);

  const monthDiff = useMemo(() => {
    if (!monthAData || !monthBData) return null;
    const calcDiff = (curr, prev) => {
      const diffVal = Number(curr) - Number(prev);
      const percent = prev > 0 ? (diffVal / prev) * 100 : curr > 0 ? 100 : 0;
      return { diffVal, percent };
    };

    return {
      sales: calcDiff(monthAData.sales, monthBData.sales),
      profit: calcDiff(monthAData.profit, monthBData.profit),
      expenses: calcDiff(monthAData.expenses, monthBData.expenses),
      orders: calcDiff(monthAData.orders_count, monthBData.orders_count),
    };
  }, [monthAData, monthBData]);

  // Expenses categories donut data
  const expensesChartData = useMemo(() => {
    const list = data?.expenses?.categories || [];
    return list.map((item, idx) => ({
      name: EXPENSE_CATEGORY_NAMES[item.category] || item.category,
      value: Number(item.total) || 0,
      count: item.count,
      color: CHART_COLORS[idx % CHART_COLORS.length],
    }));
  }, [data]);

  return (
    <div
      style={{
        overflowY: 'auto',
        maxHeight: 'calc(100vh - 84px)',
        paddingRight: 6,
        paddingBottom: 40,
      }}
    >
      {/* Page Header and Controls */}
      <div
        className="page-head between"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Asosiy Boshqaruv Paneli</h2>
          <p style={{ margin: '3px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Biznes ko‘rsatkichlari, savdo, xarajatlar, qarzlar va davomat monitoringi
          </p>
        </div>

        {/* Period Selector Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="period-selector" style={{ display: 'inline-flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 10 }}>
            <button className={period === 'today' ? 'active' : ''} onClick={() => handlePeriodChange('today')}>
              Bugun
            </button>
            <button className={period === 'week' ? 'active' : ''} onClick={() => handlePeriodChange('week')}>
              Hafta
            </button>
            <button className={period === 'month' ? 'active' : ''} onClick={() => handlePeriodChange('month')}>
              Bu oy
            </button>
            <button className={period === 'last_month' ? 'active' : ''} onClick={() => handlePeriodChange('last_month')}>
              O‘tgan oy
            </button>
            <button className={period === 'year' ? 'active' : ''} onClick={() => handlePeriodChange('year')}>
              Yil
            </button>
            <button className={period === 'custom' ? 'active' : ''} onClick={() => setPeriod('custom')}>
              Tanlash
            </button>
          </div>

          <button
            type="button"
            className="btn btn-outline"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13 }}
            onClick={loadData}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            Yangilash
          </button>
        </div>
      </div>

      {/* Custom Date Range Picker */}
      {period === 'custom' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 16,
            padding: 12,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            flexWrap: 'wrap',
          }}
        >
          <Calendar size={16} color="var(--primary)" />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Sana oralig‘i:</span>
          <input
            type="date"
            className="input"
            value={from}
            max={to}
            onChange={e => setFrom(e.target.value)}
            style={{ maxWidth: 160, padding: '6px 10px', fontSize: 13 }}
          />
          <span>—</span>
          <input
            type="date"
            className="input"
            value={to}
            min={from}
            onChange={e => setTo(e.target.value)}
            style={{ maxWidth: 160, padding: '6px 10px', fontSize: 13 }}
          />
        </div>
      )}

      {/* Loading or Error States */}
      {loading && !data ? (
        <div className="admin-workspace-state" style={{ minHeight: 300 }}>
          <RefreshCw size={32} className="spin" color="var(--primary)" />
          <b>Boshqaruv statistikasi hisoblanmoqda…</b>
        </div>
      ) : error && !data ? (
        <div className="admin-workspace-state error" style={{ minHeight: 300 }}>
          <AlertTriangle size={36} />
          <b>{error}</b>
          <button className="btn btn-outline" onClick={loadData}>
            Qayta urinish
          </button>
        </div>
      ) : (
        <>
          {/* SECTION 1: TOP EXECUTIVE FINANCIAL & OPERATIONAL KPIs */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 14,
              marginBottom: 20,
            }}
          >
            {/* 1. Savdo aylanmasi */}
            <div className="stat-card" style={{ borderLeft: '4px solid #16a34a' }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: '#dcfce7',
                  color: '#16a34a',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <TrendingUp size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="stat-label" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Savdo summasi ({period === 'today' ? 'Bugun' : period === 'month' ? 'Bu oy' : 'Davr'})
                </span>
                <span className="stat-value" style={{ fontSize: 18, fontWeight: 800 }}>
                  <DualPrice value={data.sales_stats.sales_total} rate={rate} />
                </span>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {data.sales_stats.sales_count} ta chek · O‘rtacha: {formatCompactMoney(data.sales_stats.average_ticket)} so‘m
                </small>
              </div>
            </div>

            {/* 2. Sof foyda */}
            <div className="stat-card" style={{ borderLeft: '4px solid #2563eb' }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: '#dbeafe',
                  color: '#2563eb',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Wallet size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="stat-label" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Sof foyda (Kutilayotgan)
                </span>
                <span className="stat-value" style={{ fontSize: 18, fontWeight: 800, color: '#2563eb' }}>
                  <DualPrice value={data.sales_stats.sales_profit} rate={rate} />
                </span>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  Tannarx: {formatCompactMoney(data.sales_stats.sales_cost)} so‘m
                </small>
              </div>
            </div>

            {/* 3. Bu oydagi xarajatlar */}
            <div
              className="stat-card"
              style={{ borderLeft: '4px solid #e11d48', cursor: 'pointer' }}
              onClick={() => go?.('expenses')}
              title="Xarajatlar bo‘limiga o‘tish"
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: '#ffe4e6',
                  color: '#e11d48',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <TrendingDown size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="stat-label" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Bu oydagi xarajatlar
                </span>
                <span className="stat-value" style={{ fontSize: 18, fontWeight: 800, color: '#e11d48' }}>
                  <DualPrice value={data.expenses.this_month_total} rate={rate} />
                </span>
                <small style={{ color: data.expenses.change_percent > 0 ? '#e11d48' : '#16a34a', fontSize: 11, fontWeight: 600 }}>
                  {data.expenses.last_month_total > 0
                    ? `O‘tgan oyga nisbatan: ${data.expenses.change_percent > 0 ? '+' : ''}${data.expenses.change_percent}%`
                    : 'Joriy oy xarajatlari'}
                </small>
              </div>
            </div>

            {/* 4. Ta'minotchidan qarzlar (Supplier Debts) */}
            <div
              className="stat-card"
              style={{
                borderLeft: data.debts.supplier_debt_total > 0 ? '4px solid #f97316' : '4px solid #16a34a',
                cursor: 'pointer',
              }}
              onClick={() => go?.('reports')}
              title="Qarzlar hisobotiga o‘tish"
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: data.debts.supplier_debt_total > 0 ? '#ffedd5' : '#dcfce7',
                  color: data.debts.supplier_debt_total > 0 ? '#f97316' : '#16a34a',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Layers size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="stat-label" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Ta’minotchidan qarzimiz
                </span>
                <span
                  className="stat-value"
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    color: data.debts.supplier_debt_total > 0 ? '#f97316' : '#16a34a',
                  }}
                >
                  <DualPrice value={data.debts.supplier_debt_total} rate={rate} />
                </span>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {data.debts.supplier_count > 0
                    ? `${data.debts.supplier_count} ta ta’minotchidan qarz bor`
                    : 'Ta’minotchilardan qarz yo‘q'}
                </small>
              </div>
            </div>

            {/* 5. Bugun kelgan xodimlar davomati */}
            <div
              className="stat-card"
              style={{ borderLeft: '4px solid #8b5cf6', cursor: 'pointer' }}
              onClick={() => go?.('attendance')}
              title="Davomat bo‘limiga o‘tish"
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: '#ede9fe',
                  color: '#8b5cf6',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <UserCheck size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="stat-label" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Bugun kelgan xodimlar
                </span>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span className="stat-value" style={{ fontSize: 18, fontWeight: 800 }}>
                    {data.attendance.checked_in_count} / {data.attendance.total_employees}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: data.attendance.attendance_percent >= 80 ? '#16a34a' : '#f97316',
                    }}
                  >
                    ({data.attendance.attendance_percent}%)
                  </span>
                </div>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  Ishda: {data.attendance.currently_working} ta · Ketgan: {data.attendance.completed_count} ta
                </small>
              </div>
            </div>

            {/* 6. Ombor qiymati (Tannarxi va Sotish narxi) */}
            <div
              className="stat-card"
              style={{ borderLeft: '4px solid #0891b2', cursor: 'pointer' }}
              onClick={() => go?.('inventory')}
              title="Tovarlar bo‘limiga o‘tish"
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: '#cffafe',
                  color: '#0891b2',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Boxes size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="stat-label" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Ombordagi jami tovarlar
                </span>
                <span className="stat-value" style={{ fontSize: 18, fontWeight: 800 }}>
                  {data.overview.total_units.toLocaleString('uz-UZ')} ta
                </span>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  Tannarx: {formatCompactMoney(data.overview.total_cost)} so‘m · Sotish: {formatCompactMoney(data.overview.total_retail)} so‘m
                </small>
              </div>
            </div>
          </div>

          {/* SECONDARY ROW: QUICK STATS COUNTERS */}
          <div
            className="stats-cards"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 10,
              marginBottom: 20,
            }}
          >
            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <Package size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.product_types}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Tovar turlari</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <ShoppingCart size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.order_count}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Barcha buyurtmalar</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <Store size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.online_orders}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Sayt buyurtmalari</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <Building size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.branch_count}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Filiallar</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <Warehouse size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.warehouse_count}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Omborlar</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <Users size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.employee_count}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Xodimlar</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <Truck size={18} color="var(--primary)" />
              <div>
                <span className="stat-value" style={{ fontSize: 16 }}>{data.overview.courier_count}</span>
                <span className="stat-label" style={{ fontSize: 11 }}>Kuryerlar</span>
              </div>
            </div>

            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <AlertTriangle size={18} color={data.overview.zero_stock_count > 0 ? '#ef4444' : 'var(--muted)'} />
              <div>
                <span className="stat-value" style={{ fontSize: 16, color: data.overview.zero_stock_count > 0 ? '#ef4444' : undefined }}>
                  {data.overview.zero_stock_count}
                </span>
                <span className="stat-label" style={{ fontSize: 11 }}>Qoldiqsiz tovarlar</span>
              </div>
            </div>
          </div>

          {/* SECTION 2: MONTH-OVER-MONTH COMPARISON WITH RICH CHARTS */}
          <div className="card" style={{ padding: 20, marginBottom: 20 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12,
                borderBottom: '1px solid var(--line)',
                paddingBottom: 14,
                marginBottom: 16,
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <BarChart3 size={20} color="var(--primary)" />
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                    Oylik Statistikani Avvalgi Oylar Bilan Taqqoslash
                  </h3>
                </div>
                <small style={{ color: 'var(--muted)', fontSize: 12, display: 'block', marginTop: 2 }}>
                  So‘nggi 6 oylik savdo tushumi, sof foyda va operatsion xarajatlar dinamikasi
                </small>
              </div>

              {/* Chart Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {/* Metric filter buttons */}
                <div style={{ display: 'inline-flex', background: 'var(--surface-2)', padding: 3, borderRadius: 8, fontSize: 12 }}>
                  <button
                    type="button"
                    className={`btn-subtle ${chartMetric === 'all' ? 'active' : ''}`}
                    onClick={() => setChartMetric('all')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: chartMetric === 'all' ? 'var(--orange)' : 'transparent',
                      color: chartMetric === 'all' ? '#fff' : 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Barchasi
                  </button>
                  <button
                    type="button"
                    className={`btn-subtle ${chartMetric === 'sales' ? 'active' : ''}`}
                    onClick={() => setChartMetric('sales')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: chartMetric === 'sales' ? 'var(--orange)' : 'transparent',
                      color: chartMetric === 'sales' ? '#fff' : 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Savdo
                  </button>
                  <button
                    type="button"
                    className={`btn-subtle ${chartMetric === 'profit' ? 'active' : ''}`}
                    onClick={() => setChartMetric('profit')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: chartMetric === 'profit' ? 'var(--orange)' : 'transparent',
                      color: chartMetric === 'profit' ? '#fff' : 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Foyda
                  </button>
                  <button
                    type="button"
                    className={`btn-subtle ${chartMetric === 'expenses' ? 'active' : ''}`}
                    onClick={() => setChartMetric('expenses')}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: chartMetric === 'expenses' ? 'var(--orange)' : 'transparent',
                      color: chartMetric === 'expenses' ? '#fff' : 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Xarajat
                  </button>
                </div>

                {/* Chart type buttons */}
                <div style={{ display: 'inline-flex', background: 'var(--surface-2)', padding: 3, borderRadius: 8 }}>
                  <button
                    type="button"
                    onClick={() => setChartType('bar')}
                    style={{
                      padding: '4px 10px',
                      fontSize: 12,
                      borderRadius: 6,
                      border: 'none',
                      background: chartType === 'bar' ? 'var(--surface)' : 'transparent',
                      color: 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Ustun
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartType('area')}
                    style={{
                      padding: '4px 10px',
                      fontSize: 12,
                      borderRadius: 6,
                      border: 'none',
                      background: chartType === 'area' ? 'var(--surface)' : 'transparent',
                      color: 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Soha
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartType('line')}
                    style={{
                      padding: '4px 10px',
                      fontSize: 12,
                      borderRadius: 6,
                      border: 'none',
                      background: chartType === 'line' ? 'var(--surface)' : 'transparent',
                      color: 'inherit',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Chiziq
                  </button>
                </div>
              </div>
            </div>

            {/* Recharts Graphical Chart */}
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                {chartType === 'bar' ? (
                  <BarChart data={data.monthly_comparison} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                    <XAxis dataKey="month_label" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={formatCompactMoney} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={val => formatDualMoney(Number(val), rate)} />
                    <Legend wrapperStyle={{ paddingTop: 10, fontSize: 12 }} />
                    {(chartMetric === 'all' || chartMetric === 'sales') && (
                      <Bar dataKey="sales" name="Savdo summasi" fill="#f97316" radius={[6, 6, 0, 0]} />
                    )}
                    {(chartMetric === 'all' || chartMetric === 'profit') && (
                      <Bar dataKey="profit" name="Sof foyda" fill="#2563eb" radius={[6, 6, 0, 0]} />
                    )}
                    {(chartMetric === 'all' || chartMetric === 'expenses') && (
                      <Bar dataKey="expenses" name="Xarajatlar" fill="#ef4444" radius={[6, 6, 0, 0]} />
                    )}
                  </BarChart>
                ) : chartType === 'area' ? (
                  <AreaChart data={data.monthly_comparison} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                    <XAxis dataKey="month_label" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={formatCompactMoney} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={val => formatDualMoney(Number(val), rate)} />
                    <Legend wrapperStyle={{ paddingTop: 10, fontSize: 12 }} />
                    {(chartMetric === 'all' || chartMetric === 'sales') && (
                      <Area type="monotone" dataKey="sales" name="Savdo summasi" stroke="#f97316" fill="#ffedd5" fillOpacity={0.6} />
                    )}
                    {(chartMetric === 'all' || chartMetric === 'profit') && (
                      <Area type="monotone" dataKey="profit" name="Sof foyda" stroke="#2563eb" fill="#dbeafe" fillOpacity={0.6} />
                    )}
                    {(chartMetric === 'all' || chartMetric === 'expenses') && (
                      <Area type="monotone" dataKey="expenses" name="Xarajatlar" stroke="#ef4444" fill="#fee2e2" fillOpacity={0.6} />
                    )}
                  </AreaChart>
                ) : (
                  <LineChart data={data.monthly_comparison} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                    <XAxis dataKey="month_label" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={formatCompactMoney} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={val => formatDualMoney(Number(val), rate)} />
                    <Legend wrapperStyle={{ paddingTop: 10, fontSize: 12 }} />
                    {(chartMetric === 'all' || chartMetric === 'sales') && (
                      <Line type="monotone" dataKey="sales" name="Savdo summasi" stroke="#f97316" strokeWidth={3} dot={{ r: 4 }} />
                    )}
                    {(chartMetric === 'all' || chartMetric === 'profit') && (
                      <Line type="monotone" dataKey="profit" name="Sof foyda" stroke="#2563eb" strokeWidth={3} dot={{ r: 4 }} />
                    )}
                    {(chartMetric === 'all' || chartMetric === 'expenses') && (
                      <Line type="monotone" dataKey="expenses" name="Xarajatlar" stroke="#ef4444" strokeWidth={3} dot={{ r: 4 }} />
                    )}
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>

            {/* Interactive Month-over-Month Direct Comparison Box */}
            <div
              style={{
                marginTop: 20,
                padding: 16,
                background: 'var(--surface-2)',
                borderRadius: 12,
                border: '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
                <b style={{ fontSize: 14 }}>Oylararo To‘g‘ridan-to‘g‘ri Solishtirish (Month A vs Month B):</b>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <small style={{ color: 'var(--muted)', fontWeight: 600 }}>Oy 1:</small>
                    <select
                      className="select"
                      style={{ padding: '4px 8px', fontSize: 12 }}
                      value={compareMonthA}
                      onChange={e => setCompareMonthA(e.target.value)}
                    >
                      {data.monthly_comparison.map(m => (
                        <option key={m.month} value={m.month}>
                          {m.month_label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <span style={{ fontWeight: 800 }}>vs</span>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <small style={{ color: 'var(--muted)', fontWeight: 600 }}>Oy 2:</small>
                    <select
                      className="select"
                      style={{ padding: '4px 8px', fontSize: 12 }}
                      value={compareMonthB}
                      onChange={e => setCompareMonthB(e.target.value)}
                    >
                      {data.monthly_comparison.map(m => (
                        <option key={m.month} value={m.month}>
                          {m.month_label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {monthDiff && monthAData && monthBData && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                  {/* Sales Diff Card */}
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 10, border: '1px solid var(--line)' }}>
                    <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Savdo Tushumi Farqi</small>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
                      <b style={{ fontSize: 15 }}>
                        {formatCompactMoney(monthAData.sales)} so‘m
                      </b>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>vs {formatCompactMoney(monthBData.sales)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {monthDiff.sales.diffVal >= 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', color: '#16a34a', fontSize: 12, fontWeight: 700 }}>
                          <ArrowUpRight size={14} /> +{monthDiff.sales.percent.toFixed(1)}% (+{formatCompactMoney(monthDiff.sales.diffVal)})
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', color: '#dc2626', fontSize: 12, fontWeight: 700 }}>
                          <ArrowDownRight size={14} /> {monthDiff.sales.percent.toFixed(1)}% ({formatCompactMoney(monthDiff.sales.diffVal)})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Profit Diff Card */}
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 10, border: '1px solid var(--line)' }}>
                    <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Sof Foyda Farqi</small>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
                      <b style={{ fontSize: 15, color: '#2563eb' }}>
                        {formatCompactMoney(monthAData.profit)} so‘m
                      </b>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>vs {formatCompactMoney(monthBData.profit)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {monthDiff.profit.diffVal >= 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', color: '#16a34a', fontSize: 12, fontWeight: 700 }}>
                          <ArrowUpRight size={14} /> +{monthDiff.profit.percent.toFixed(1)}% (+{formatCompactMoney(monthDiff.profit.diffVal)})
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', color: '#dc2626', fontSize: 12, fontWeight: 700 }}>
                          <ArrowDownRight size={14} /> {monthDiff.profit.percent.toFixed(1)}% ({formatCompactMoney(monthDiff.profit.diffVal)})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Expenses Diff Card */}
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 10, border: '1px solid var(--line)' }}>
                    <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Xarajatlar Farqi</small>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
                      <b style={{ fontSize: 15, color: '#e11d48' }}>
                        {formatCompactMoney(monthAData.expenses)} so‘m
                      </b>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>vs {formatCompactMoney(monthBData.expenses)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {monthDiff.expenses.diffVal <= 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', color: '#16a34a', fontSize: 12, fontWeight: 700 }}>
                          <ArrowDownRight size={14} /> {monthDiff.expenses.percent.toFixed(1)}% (Kamaydi)
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', color: '#dc2626', fontSize: 12, fontWeight: 700 }}>
                          <ArrowUpRight size={14} /> +{monthDiff.expenses.percent.toFixed(1)}% (Oshdi)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Orders Diff Card */}
                  <div style={{ background: 'var(--surface)', padding: 12, borderRadius: 10, border: '1px solid var(--line)' }}>
                    <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Cheklar Soni Farqi</small>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
                      <b style={{ fontSize: 15 }}>
                        {monthAData.orders_count} ta
                      </b>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>vs {monthBData.orders_count} ta</span>
                    </div>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: monthDiff.orders.diffVal >= 0 ? '#16a34a' : '#dc2626' }}>
                        {monthDiff.orders.diffVal >= 0 ? `+${monthDiff.orders.diffVal} ta buyurtma` : `${monthDiff.orders.diffVal} ta buyurtma`}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SECTION 3: TWO-COLUMN SECTION (SUPPLIER DEBTS & MONTHLY EXPENSES BREAKDOWN) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 18,
              marginBottom: 20,
            }}
          >
            {/* COLUMN 1: SUPPLIER DEBTS & LIABILITIES */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Layers size={18} color="var(--primary)" />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Ta’minotchilardan Qarzlarimiz</h3>
                </div>
                <button
                  type="button"
                  className="link"
                  style={{ fontSize: 12, fontWeight: 600 }}
                  onClick={() => go?.('master-data')}
                >
                  Barcha ta’minotchilar <ExternalLink size={11} />
                </button>
              </div>

              {/* Debt overview box */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 14,
                  background: data.debts.supplier_debt_total > 0 ? '#fff7ed' : '#f0fdf4',
                  borderRadius: 10,
                  border: data.debts.supplier_debt_total > 0 ? '1px solid #ffedd5' : '1px solid #dcfce7',
                  marginBottom: 14,
                }}
              >
                <div>
                  <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Jami qarz balansi:</small>
                  <b style={{ fontSize: 18, color: data.debts.supplier_debt_total > 0 ? '#ea580c' : '#16a34a' }}>
                    <DualPrice value={data.debts.supplier_debt_total} rate={rate} />
                  </b>
                </div>
                <div>
                  {data.debts.supplier_debt_total > 0 ? (
                    <Status type="orange">⚠️ {data.debts.supplier_count} ta qarz mavjud</Status>
                  ) : (
                    <Status type="green">✓ Barcha hisoblar yopilgan</Status>
                  )}
                </div>
              </div>

              {/* Suppliers List */}
              {data.debts.suppliers.length === 0 ? (
                <div className="admin-inline-empty" style={{ padding: 20, fontSize: 13 }}>
                  Ta’minotchilar ro‘yxati bo‘sh.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Ta’minotchi</th>
                        <th>Kodi</th>
                        <th style={{ textAlign: 'right' }}>Qarz Summasi</th>
                        <th style={{ textAlign: 'center' }}>Holati</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.debts.suppliers.map(s => {
                        const hasDebt = Number(s.balance) > 0;
                        return (
                          <tr key={s.id}>
                            <td>
                              <b style={{ fontSize: 13, display: 'block' }}>{s.name}</b>
                              {s.phone && <small style={{ color: 'var(--muted)', fontSize: 11 }}>{s.phone}</small>}
                            </td>
                            <td>
                              <span style={{ fontSize: 11, background: '#f1f5f9', padding: '2px 6px', borderRadius: 5 }}>
                                {s.code || '—'}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <b style={{ color: hasDebt ? '#ea580c' : 'inherit', fontSize: 13 }}>
                                <DualPrice value={s.balance} rate={rate} />
                              </b>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              {hasDebt ? (
                                <span style={{ fontSize: 11, color: '#ea580c', fontWeight: 600 }}>Qarz</span>
                              ) : (
                                <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>To‘langan</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* COLUMN 2: CURRENT MONTH EXPENSES BREAKDOWN */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <PieIcon size={18} color="var(--primary)" />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Bu Oydagi Xarajatlar Statistikasi</h3>
                </div>
                <button
                  type="button"
                  className="link"
                  style={{ fontSize: 12, fontWeight: 600 }}
                  onClick={() => go?.('expenses')}
                >
                  Xarajatlar bo‘limi <ExternalLink size={11} />
                </button>
              </div>

              {/* Total Expenses Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 14,
                  background: '#fff1f2',
                  borderRadius: 10,
                  border: '1px solid #fecdd3',
                  marginBottom: 14,
                }}
              >
                <div>
                  <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Bu oy jami sarflandi:</small>
                  <b style={{ fontSize: 18, color: '#e11d48' }}>
                    <DualPrice value={data.expenses.this_month_total} rate={rate} />
                  </b>
                </div>
                <div>
                  <span
                    style={{
                      fontSize: 12,
                      padding: '4px 8px',
                      borderRadius: 6,
                      background: '#ffe4e6',
                      color: '#e11d48',
                      fontWeight: 700,
                    }}
                  >
                    {expensesChartData.length} ta toifa
                  </span>
                </div>
              </div>

              {/* Expenses chart or empty state */}
              {expensesChartData.length === 0 ? (
                <div className="admin-inline-empty" style={{ padding: '30px 20px', textAlign: 'center' }}>
                  <TrendingDown size={28} color="var(--muted)" style={{ marginBottom: 6 }} />
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                    Bu oyda hali xarajatlar yozilmagan.
                  </p>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ marginTop: 10, fontSize: 12, padding: '5px 12px' }}
                    onClick={() => go?.('expenses')}
                  >
                    + Xarajat qo‘shish
                  </button>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'center' }}>
                  <div style={{ height: 190 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={expensesChartData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={75}
                          paddingAngle={3}
                        >
                          {expensesChartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={val => formatDualMoney(Number(val), rate)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Legend list */}
                  <div style={{ maxHeight: 190, overflowY: 'auto', paddingRight: 4 }}>
                    {expensesChartData.map(item => (
                      <div
                        key={item.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '5px 0',
                          borderBottom: '1px solid var(--line)',
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color }} />
                          <span>{item.name}</span>
                        </div>
                        <b style={{ fontSize: 12 }}>{formatCompactMoney(item.value)} so‘m</b>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SECTION 4: TODAY'S ATTENDANCE DETAIL & TOP SELLING PRODUCTS */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 18,
            }}
          >
            {/* ATTENDANCE SECTION */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Clock size={18} color="var(--primary)" />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Bugun Kelgan Xodimlar Davomati</h3>
                </div>
                <button
                  type="button"
                  className="link"
                  style={{ fontSize: 12, fontWeight: 600 }}
                  onClick={() => go?.('attendance')}
                >
                  Barcha davomat <ExternalLink size={11} />
                </button>
              </div>

              {/* Attendance quick bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 12,
                  background: 'var(--surface-2)',
                  borderRadius: 10,
                  marginBottom: 12,
                }}
              >
                <div>
                  <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Bugungi sana:</small>
                  <b style={{ fontSize: 13 }}>
                    {formatUzDate(data.attendance.today_date, { day: true, month: 'long', year: true })}
                  </b>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <small style={{ color: 'var(--muted)', display: 'block', fontSize: 11 }}>Qatnashish darajasi:</small>
                  <b style={{ fontSize: 15, color: data.attendance.attendance_percent >= 80 ? '#16a34a' : '#f97316' }}>
                    {data.attendance.checked_in_count} / {data.attendance.total_employees} ({data.attendance.attendance_percent}%)
                  </b>
                </div>
              </div>

              {/* Attendance list: today's attendees or recent fallback */}
              {data.attendance.today_attendees.length > 0 ? (
                <div className="table-wrap">
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Xodim</th>
                        <th>Filial</th>
                        <th>Kelgan Vaqti</th>
                        <th>Holati</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.attendance.today_attendees.map(a => (
                        <tr key={a.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: '50%',
                                  background: '#e0e7ff',
                                  color: '#4338ca',
                                  display: 'grid',
                                  placeItems: 'center',
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                              >
                                {a.employee_name?.charAt(0) || 'X'}
                              </div>
                              <div>
                                <b style={{ fontSize: 12, display: 'block' }}>{a.employee_name}</b>
                                <small style={{ color: 'var(--muted)', fontSize: 10 }}>{a.employee_role}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span style={{ fontSize: 11 }}>{a.branch_name}</span>
                          </td>
                          <td>
                            <b style={{ fontSize: 12 }}>{a.check_in_at ? formatUzTime(a.check_in_at) : '—'}</b>
                            {a.worked_minutes > 0 && (
                              <small style={{ color: 'var(--muted)', display: 'block', fontSize: 10 }}>
                                {formatWorkedDuration(a.worked_minutes)}
                              </small>
                            )}
                          </td>
                          <td>
                            {a.status === 'checked_in' ? (
                              <Status type="green">● Ishda</Status>
                            ) : (
                              <Status type="gray">✓ Yakunlangan</Status>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      padding: '12px 14px',
                      background: '#fffbeb',
                      border: '1px solid #fef3c7',
                      borderRadius: 8,
                      marginBottom: 12,
                      fontSize: 12,
                      color: '#92400e',
                    }}
                  >
                    ℹ️ Bugun hali xodimlar ishga kelishni (Clock In) qayd etishmadi. Quyida so‘nggi davomat yozuvlari keltirilgan:
                  </div>

                  {data.attendance.recent_attendees.length > 0 && (
                    <div className="table-wrap">
                      <table className="table" style={{ width: '100%' }}>
                        <thead>
                          <tr>
                            <th>Xodim</th>
                            <th>Sana</th>
                            <th>Vaqt</th>
                            <th>Holati</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.attendance.recent_attendees.map(a => (
                            <tr key={a.id}>
                              <td>
                                <b style={{ fontSize: 12, display: 'block' }}>{a.employee_name}</b>
                                <small style={{ color: 'var(--muted)', fontSize: 10 }}>{a.branch_name}</small>
                              </td>
                              <td>
                                <span style={{ fontSize: 11 }}>
                                  {formatUzDate(a.work_date, { day: true, month: 'short' })}
                                </span>
                              </td>
                              <td>
                                <b style={{ fontSize: 12 }}>{a.check_in_at ? formatUzTime(a.check_in_at) : '—'}</b>
                              </td>
                              <td>
                                <Status type="gray">{a.status === 'checked_in' ? 'Ishda' : 'Yakunlangan'}</Status>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* TOP SELLING PRODUCTS & ZERO STOCK WARNING */}
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Award size={18} color="var(--primary)" />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Eng Ko‘p Sotilgan Tovarlar</h3>
                </div>
                <button
                  type="button"
                  className="link"
                  style={{ fontSize: 12, fontWeight: 600 }}
                  onClick={() => go?.('inventory')}
                >
                  Katalogga o‘tish <ExternalLink size={11} />
                </button>
              </div>

              {data.top_selling.length === 0 ? (
                <div className="admin-inline-empty" style={{ padding: 20, fontSize: 13 }}>
                  Sotuvlar tarixi bo‘yicha ma’lumotlar topilmadi.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Mahsulot</th>
                        <th>Artikul</th>
                        <th style={{ textAlign: 'right' }}>Sotilgan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_selling.map((p, idx) => (
                        <tr key={idx}>
                          <td>
                            <b style={{ fontSize: 13 }}>{p.name}</b>
                          </td>
                          <td>
                            <span style={{ fontSize: 11, background: '#f1f5f9', padding: '2px 6px', borderRadius: 5 }}>
                              {p.sku || '—'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <b style={{ color: 'var(--primary)', fontSize: 14 }}>{p.count} ta</b>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Zero stock alert footer */}
              {data.overview.zero_stock_count > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 14,
                    padding: '10px 14px',
                    background: '#fef2f2',
                    border: '1px solid #fee2e2',
                    borderRadius: 8,
                    fontSize: 12,
                    color: '#991b1b',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={15} color="#ef4444" />
                    <span>
                      <b>{data.overview.zero_stock_count} ta</b> tovar qoldig‘i 0 ga tushgan (qoldiqsiz).
                    </span>
                  </div>
                  <button
                    type="button"
                    className="link"
                    style={{ fontSize: 12, color: '#ef4444', fontWeight: 700 }}
                    onClick={() => go?.('inventory')}
                  >
                    Keltirish
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
