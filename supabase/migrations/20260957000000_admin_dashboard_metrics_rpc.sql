-- RPC: get_admin_dashboard_metrics
-- Aggregates all high-level business analytics, supplier debts, monthly expenses,
-- today's attendance, month-over-month comparisons, and inventory valuations in one call.

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics(
  p_from date DEFAULT CURRENT_DATE,
  p_to date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_from date := coalesce(p_from, CURRENT_DATE);
  v_to date := coalesce(p_to, CURRENT_DATE);
  v_today date := (now() at time zone 'Asia/Tashkent')::date;
  v_current_month text := to_char(v_today, 'YYYY-MM');
  v_last_month text := to_char((date_trunc('month', v_today) - interval '1 month')::date, 'YYYY-MM');
  
  -- Overview variables
  v_product_types integer := 0;
  v_total_units integer := 0;
  v_total_cost numeric := 0;
  v_total_retail numeric := 0;
  v_zero_stock integer := 0;
  v_branch_count integer := 0;
  v_warehouse_count integer := 0;
  v_employee_count integer := 0;
  v_courier_count integer := 0;
  v_order_count integer := 0;
  v_online_orders integer := 0;
  
  -- Sales variables
  v_sales_total numeric := 0;
  v_sales_profit numeric := 0;
  v_sales_cost numeric := 0;
  v_sales_count integer := 0;
  v_avg_ticket numeric := 0;
  
  -- Debts variables
  v_supplier_debt_total numeric := 0;
  v_supplier_count integer := 0;
  v_suppliers jsonb := '[]'::jsonb;
  v_customer_debt_total numeric := 0;
  v_customer_debt_count integer := 0;
  v_customer_debts jsonb := '[]'::jsonb;
  
  -- Expenses variables
  v_this_month_exp numeric := 0;
  v_last_month_exp numeric := 0;
  v_exp_categories jsonb := '[]'::jsonb;
  
  -- Attendance variables
  v_today_checked_in integer := 0;
  v_today_working integer := 0;
  v_today_completed integer := 0;
  v_today_attendees jsonb := '[]'::jsonb;
  v_recent_attendees jsonb := '[]'::jsonb;
  
  -- Monthly comparison
  v_monthly_comparison jsonb := '[]'::jsonb;
  
  -- Top/low selling
  v_top_selling jsonb := '[]'::jsonb;
  v_low_selling jsonb := '[]'::jsonb;

BEGIN
  -- Basic admin security check (allow if superadmin/admin or local service)
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator boshqaruv dashboardini ko‘ra oladi.' USING errcode = '42501';
  END IF;

  -- 1. Branches & Locations
  SELECT count(*) INTO v_branch_count FROM public.branches WHERE is_active = true;
  SELECT count(*) INTO v_warehouse_count FROM public.locations WHERE type = 'warehouse' AND is_active = true;

  -- 2. Employees & Couriers
  SELECT count(DISTINCT p.id) INTO v_employee_count
  FROM public.profiles p
  JOIN public.profile_roles pr ON pr.profile_id = p.id
  WHERE p.is_active = true;

  SELECT count(DISTINCT p.id) INTO v_courier_count
  FROM public.profiles p
  JOIN public.profile_roles pr ON pr.profile_id = p.id
  WHERE p.is_active = true AND pr.role = 'courier';

  -- 3. Inventory units & valuation
  SELECT
    count(DISTINCT u.product_id),
    count(u.id),
    coalesce(sum(coalesce(p.cost_price, 0)), 0),
    coalesce(sum(coalesce(p.retail_price, 0)), 0)
  INTO
    v_product_types,
    v_total_units,
    v_total_cost,
    v_total_retail
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  WHERE u.status = 'available';

  -- Zero stock products count
  SELECT count(*) INTO v_zero_stock
  FROM public.products p
  WHERE p.is_published = true
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_units u
      WHERE u.product_id = p.id AND u.status = 'available'
    );

  -- 4. Orders count
  SELECT count(*) INTO v_order_count FROM public.orders;

  -- Online orders in selected period
  SELECT count(*) INTO v_online_orders
  FROM public.orders
  WHERE (created_at at time zone 'Asia/Tashkent')::date >= v_from
    AND (created_at at time zone 'Asia/Tashkent')::date <= v_to;

  -- 5. Sales in selected period
  SELECT
    coalesce(sum(s.total), 0),
    count(s.id),
    coalesce(sum(
      CASE 
        WHEN EXISTS (SELECT 1 FROM public.sale_lines sl WHERE sl.sale_id = s.id)
        THEN (SELECT coalesce(sum(sl.line_total - sl.tax - (sl.unit_cost * sl.quantity)), 0) FROM public.sale_lines sl WHERE sl.sale_id = s.id)
        ELSE s.total * 0.25
      END
    ), 0),
    coalesce(sum(
      CASE 
        WHEN EXISTS (SELECT 1 FROM public.sale_lines sl WHERE sl.sale_id = s.id)
        THEN (SELECT coalesce(sum(sl.unit_cost * sl.quantity), 0) FROM public.sale_lines sl WHERE sl.sale_id = s.id)
        ELSE s.total * 0.75
      END
    ), 0)
  INTO
    v_sales_total,
    v_sales_count,
    v_sales_profit,
    v_sales_cost
  FROM public.sales s
  WHERE s.status <> 'void'
    AND (s.sold_at at time zone 'Asia/Tashkent')::date >= v_from
    AND (s.sold_at at time zone 'Asia/Tashkent')::date <= v_to;

  IF v_sales_count > 0 THEN
    v_avg_ticket := round(v_sales_total / v_sales_count, 2);
  END IF;

  -- 6. Supplier debts
  SELECT
    coalesce(sum(greatest(balance, 0)), 0),
    count(*) filter (where greatest(balance, 0) > 0)
  INTO
    v_supplier_debt_total,
    v_supplier_count
  FROM public.suppliers
  WHERE is_active = true;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'code', s.code,
      'balance', s.balance,
      'phone', s.phone,
      'is_active', s.is_active
    ) ORDER BY s.balance DESC
  ), '[]'::jsonb)
  INTO v_suppliers
  FROM public.suppliers s
  WHERE s.is_active = true
  LIMIT 10;

  -- 7. Customer / Branch debts
  SELECT
    coalesce(sum(remaining_amount), 0),
    count(*)
  INTO
    v_customer_debt_total,
    v_customer_debt_count
  FROM public.branch_debts
  WHERE status = 'open' AND remaining_amount > 0;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'debtor_branch_name', coalesce(db.name, 'Noma’lum filial'),
      'creditor_branch_name', coalesce(cb.name, 'Bosh ofis'),
      'original_amount', d.amount,
      'remaining_amount', d.remaining_amount,
      'due_date', d.due_at,
      'status', d.status,
      'notes', d.notes
    ) ORDER BY d.remaining_amount DESC
  ), '[]'::jsonb)
  INTO v_customer_debts
  FROM public.branch_debts d
  LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
  LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
  WHERE d.status = 'open' AND d.remaining_amount > 0
  LIMIT 10;

  -- 8. Monthly expenses
  -- Current month
  SELECT coalesce(sum(amount), 0)
  INTO v_this_month_exp
  FROM (
    SELECT amount FROM public.finance_transactions
    WHERE type = 'expense' AND to_char(occurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = v_current_month
    UNION ALL
    SELECT amount FROM public.expenses
    WHERE period_month = v_current_month
  ) e;

  -- Last month
  SELECT coalesce(sum(amount), 0)
  INTO v_last_month_exp
  FROM (
    SELECT amount FROM public.finance_transactions
    WHERE type = 'expense' AND to_char(occurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = v_last_month
    UNION ALL
    SELECT amount FROM public.expenses
    WHERE period_month = v_last_month
  ) e;

  -- Expense categories breakdown for this month
  WITH combined_exp AS (
    SELECT category, amount FROM public.finance_transactions
    WHERE type = 'expense' AND to_char(occurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = v_current_month
    UNION ALL
    SELECT category, amount FROM public.expenses
    WHERE period_month = v_current_month
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'category', g.category,
      'total', g.sum_amount,
      'count', g.cnt
    ) ORDER BY g.sum_amount DESC
  ), '[]'::jsonb)
  INTO v_exp_categories
  FROM (
    SELECT coalesce(category, 'other') as category, sum(amount) as sum_amount, count(*) as cnt
    FROM combined_exp
    GROUP BY 1
  ) g;

  -- 9. Today's attendance
  SELECT
    count(*) filter (where check_in_at is not null),
    count(*) filter (where status = 'checked_in'),
    count(*) filter (where status = 'completed')
  INTO
    v_today_checked_in,
    v_today_working,
    v_today_completed
  FROM public.employee_attendance
  WHERE work_date = v_today;

  -- Today's attendees list
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'employee_id', a.employee_id,
      'employee_name', coalesce(p.full_name, 'Xodim'),
      'employee_role', coalesce(pr.role::text, 'xodim'),
      'branch_name', coalesce(b.name, '—'),
      'check_in_at', a.check_in_at,
      'check_out_at', a.check_out_at,
      'worked_minutes', a.worked_minutes,
      'status', a.status
    ) ORDER BY a.check_in_at DESC
  ), '[]'::jsonb)
  INTO v_today_attendees
  FROM public.employee_attendance a
  LEFT JOIN public.profiles p ON p.id = a.employee_id
  LEFT JOIN public.profile_roles pr ON pr.profile_id = p.id
  LEFT JOIN public.branches b ON b.id = a.branch_id
  WHERE a.work_date = v_today;

  -- Recent attendees fallback if today has no attendees yet
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'work_date', a.work_date,
      'employee_name', coalesce(p.full_name, 'Xodim'),
      'employee_role', coalesce(pr.role::text, 'xodim'),
      'branch_name', coalesce(b.name, '—'),
      'check_in_at', a.check_in_at,
      'check_out_at', a.check_out_at,
      'worked_minutes', a.worked_minutes,
      'status', a.status
    ) ORDER BY a.work_date DESC, a.check_in_at DESC
  ), '[]'::jsonb)
  INTO v_recent_attendees
  FROM public.employee_attendance a
  LEFT JOIN public.profiles p ON p.id = a.employee_id
  LEFT JOIN public.profile_roles pr ON pr.profile_id = p.id
  LEFT JOIN public.branches b ON b.id = a.branch_id
  LIMIT 6;

  -- 10. Month-over-month history (Last 6 months)
  WITH months AS (
    SELECT to_char(d, 'YYYY-MM') as ym,
           d::date as m_start,
           (d + interval '1 month - 1 day')::date as m_end
    FROM generate_series(
      date_trunc('month', v_today) - interval '5 months',
      date_trunc('month', v_today),
      interval '1 month'
    ) d
  ),
  s_agg AS (
    SELECT
      to_char(s.sold_at at time zone 'Asia/Tashkent', 'YYYY-MM') as ym,
      coalesce(sum(s.total), 0) as s_total,
      count(s.id) as s_count,
      coalesce(sum(
        CASE 
          WHEN EXISTS (SELECT 1 FROM public.sale_lines sl WHERE sl.sale_id = s.id)
          THEN (SELECT coalesce(sum(sl.line_total - sl.tax - (sl.unit_cost * sl.quantity)), 0) FROM public.sale_lines sl WHERE sl.sale_id = s.id)
          ELSE s.total * 0.25
        END
      ), 0) as s_profit
    FROM public.sales s
    WHERE s.status <> 'void'
    GROUP BY 1
  ),
  e_agg AS (
    SELECT ym, sum(amt) as e_total FROM (
      SELECT to_char(occurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') as ym, amount as amt
      FROM public.finance_transactions WHERE type = 'expense'
      UNION ALL
      SELECT period_month as ym, amount as amt
      FROM public.expenses
    ) x GROUP BY 1
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'month', m.ym,
      'month_label', CASE 
        WHEN substring(m.ym, 6, 2) = '01' THEN 'Yanvar'
        WHEN substring(m.ym, 6, 2) = '02' THEN 'Fevral'
        WHEN substring(m.ym, 6, 2) = '03' THEN 'Mart'
        WHEN substring(m.ym, 6, 2) = '04' THEN 'Aprel'
        WHEN substring(m.ym, 6, 2) = '05' THEN 'May'
        WHEN substring(m.ym, 6, 2) = '06' THEN 'Iyun'
        WHEN substring(m.ym, 6, 2) = '07' THEN 'Iyul'
        WHEN substring(m.ym, 6, 2) = '08' THEN 'Avgust'
        WHEN substring(m.ym, 6, 2) = '09' THEN 'Sentyabr'
        WHEN substring(m.ym, 6, 2) = '10' THEN 'Oktyabr'
        WHEN substring(m.ym, 6, 2) = '11' THEN 'Noyabr'
        ELSE 'Dekabr'
      END || ' ' || substring(m.ym, 1, 4),
      'sales', coalesce(sa.s_total, 0),
      'profit', coalesce(sa.s_profit, 0),
      'expenses', coalesce(ea.e_total, 0),
      'orders_count', coalesce(sa.s_count, 0)
    ) ORDER BY m.ym ASC
  ), '[]'::jsonb)
  INTO v_monthly_comparison
  FROM months m
  LEFT JOIN s_agg sa ON sa.ym = m.ym
  LEFT JOIN e_agg ea ON ea.ym = m.ym;

  -- 11. Top selling & low selling products
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'name', t.name,
      'sku', t.sku,
      'count', t.sold_cnt,
      'retail_price', t.retail_price
    )
  ), '[]'::jsonb)
  INTO v_top_selling
  FROM (
    SELECT p.name, p.sku, p.retail_price, count(u.id) as sold_cnt
    FROM public.inventory_units u
    JOIN public.products p ON p.id = u.product_id
    WHERE u.status = 'sold'
    GROUP BY p.id, p.name, p.sku, p.retail_price
    ORDER BY sold_cnt DESC
    LIMIT 5
  ) t;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'name', t.name,
      'sku', t.sku,
      'count', t.sold_cnt,
      'retail_price', t.retail_price
    )
  ), '[]'::jsonb)
  INTO v_low_selling
  FROM (
    SELECT p.name, p.sku, p.retail_price, count(u.id) as sold_cnt
    FROM public.inventory_units u
    JOIN public.products p ON p.id = u.product_id
    WHERE u.status = 'sold'
    GROUP BY p.id, p.name, p.sku, p.retail_price
    HAVING count(u.id) <= 2
    ORDER BY sold_cnt ASC
    LIMIT 5
  ) t;

  -- Construct final payload
  RETURN jsonb_build_object(
    'period', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'is_today', (v_from = v_today AND v_to = v_today)
    ),
    'overview', jsonb_build_object(
      'product_types', v_product_types,
      'total_units', v_total_units,
      'total_cost', v_total_cost,
      'total_retail', v_total_retail,
      'expected_margin', v_total_retail - v_total_cost,
      'zero_stock_count', v_zero_stock,
      'branch_count', v_branch_count,
      'warehouse_count', v_warehouse_count,
      'employee_count', v_employee_count,
      'courier_count', v_courier_count,
      'order_count', v_order_count,
      'online_orders', v_online_orders
    ),
    'sales_stats', jsonb_build_object(
      'sales_total', v_sales_total,
      'sales_profit', v_sales_profit,
      'sales_cost', v_sales_cost,
      'sales_count', v_sales_count,
      'average_ticket', v_avg_ticket
    ),
    'debts', jsonb_build_object(
      'supplier_debt_total', v_supplier_debt_total,
      'supplier_count', v_supplier_count,
      'suppliers', v_suppliers,
      'customer_debt_total', v_customer_debt_total,
      'customer_debt_count', v_customer_debt_count,
      'customer_debts', v_customer_debts
    ),
    'expenses', jsonb_build_object(
      'this_month_total', v_this_month_exp,
      'last_month_total', v_last_month_exp,
      'change_percent', CASE 
        WHEN v_last_month_exp > 0 THEN round(((v_this_month_exp - v_last_month_exp) / v_last_month_exp) * 100, 1)
        ELSE 0
      END,
      'categories', v_exp_categories
    ),
    'attendance', jsonb_build_object(
      'today_date', v_today,
      'total_employees', v_employee_count,
      'checked_in_count', v_today_checked_in,
      'currently_working', v_today_working,
      'completed_count', v_today_completed,
      'attendance_percent', CASE 
        WHEN v_employee_count > 0 THEN round((v_today_checked_in::numeric / v_employee_count::numeric) * 100)
        ELSE 0 
      END,
      'today_attendees', v_today_attendees,
      'recent_attendees', v_recent_attendees
    ),
    'monthly_comparison', v_monthly_comparison,
    'top_selling', v_top_selling,
    'low_selling', v_low_selling
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_metrics(date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
