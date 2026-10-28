-- ==============================================================================
-- Migration: 20261029010000_standardize_tashkent_timezone_and_release_stale_reservations.sql
-- Description:
-- 1. Create public.tashkent_today() helper to standardize Asia/Tashkent (UTC+5)
--    date handling across PostgreSQL functions, preventing UTC midnight shifts (00:00 - 05:00).
-- 2. Update get_admin_dashboard_metrics, get_seller_leaderboard, get_seller_today_sales_kpi,
--    and list_sales_history to use public.tashkent_today() as default date.
-- 3. Add public.release_stale_pos_reservations() RPC to safely release abandoned
--    POS pending sales (default older than 24 hours) back to available inventory.
-- ==============================================================================

BEGIN;

-- 1. Standardize Tashkent Today helper
CREATE OR REPLACE FUNCTION public.tashkent_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date;
$$;

GRANT EXECUTE ON FUNCTION public.tashkent_today() TO anon, authenticated, service_role;

-- 2. Release Stale POS Reservations RPC
CREATE OR REPLACE FUNCTION public.release_stale_pos_reservations(
  p_branch_id uuid DEFAULT NULL,
  p_hours integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer := 0;
  v_unit_count integer := 0;
  v_pending record;
  v_freed_in_sale integer;
BEGIN
  -- Permission check: superadmin, admin or manager of the target branch (or service_role/direct db connection)
  IF auth.uid() IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin']::public.app_role[], null)
    OR (p_branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], p_branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki filial menejeri kassa bandliklarini bo‘shata oladi' USING errcode = '42501';
  END IF;

  FOR v_pending IN
    SELECT id, branch_id, pending_no, notes
    FROM public.pos_pending_sales
    WHERE status = 'pending'
      AND (p_branch_id IS NULL OR branch_id = p_branch_id)
      AND created_at < (now() - (coalesce(p_hours, 24) || ' hours')::interval)
    FOR UPDATE
  LOOP
    -- Restore reserved inventory units belonging to this pending sale
    WITH freed AS (
      UPDATE public.inventory_units
      SET status = 'available', reserved_until = NULL, version = version + 1
      WHERE id IN (
        SELECT unit_id FROM public.pos_pending_sale_lines WHERE pending_sale_id = v_pending.id
      ) AND status = 'reserved'
      RETURNING id
    )
    SELECT count(*) INTO v_freed_in_sale FROM freed;
    v_unit_count := v_unit_count + coalesce(v_freed_in_sale, 0);

    -- Mark pending sale as cancelled
    UPDATE public.pos_pending_sales
    SET status = 'cancelled',
        notes = btrim(coalesce(notes, '') || ' [Tashlab ketilgan kassa so‘rovi tizim tomonidan bekor qilindi]')
    WHERE id = v_pending.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'cancelled_sales_count', v_count,
    'released_units_count', v_unit_count,
    'message', format('%s ta tashlab ketilgan kassa so‘rovi bekor qilindi va %s ta tovar omborga qaytarildi.', v_count, v_unit_count)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_stale_pos_reservations(uuid, integer) TO authenticated, service_role;

-- 3. Update get_admin_dashboard_metrics with public.tashkent_today()
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_today date := public.tashkent_today();
  v_from date := coalesce(p_from, v_today);
  v_to date := coalesce(p_to, v_today);
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

  -- 3. Inventory overview
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
  WHERE s.status = 'completed'
    AND (s.sold_at at time zone 'Asia/Tashkent')::date >= v_from
    AND (s.sold_at at time zone 'Asia/Tashkent')::date <= v_to;

  IF v_sales_count > 0 THEN
    v_avg_ticket := round(v_sales_total / v_sales_count, 2);
  END IF;

  -- 6. Supplier debts
  SELECT
    coalesce(sum(greatest(s.current_balance, 0)), 0),
    count(CASE WHEN s.current_balance > 0 THEN 1 END)
  INTO
    v_supplier_debt_total,
    v_supplier_count
  FROM public.suppliers s;

  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_suppliers
  FROM (
    SELECT id, name, phone, current_balance, currency
    FROM public.suppliers
    WHERE current_balance > 0
    ORDER BY current_balance DESC
    LIMIT 10
  ) sub;

  -- 7. Customer debts
  SELECT
    coalesce(sum(cd.balance), 0),
    count(DISTINCT cd.customer_id)
  INTO
    v_customer_debt_total,
    v_customer_debt_count
  FROM public.customer_debts cd
  WHERE cd.status IN ('open', 'overdue');

  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_customer_debts
  FROM (
    SELECT cd.id, c.full_name as customer_name, c.phone as customer_phone, cd.balance, cd.due_date, cd.status
    FROM public.customer_debts cd
    JOIN public.customers c ON c.id = cd.customer_id
    WHERE cd.status IN ('open', 'overdue')
    ORDER BY cd.balance DESC
    LIMIT 10
  ) sub;

  -- 8. Expenses
  SELECT coalesce(sum(amount), 0) INTO v_this_month_exp
  FROM public.expenses
  WHERE to_char(incurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = v_current_month;

  SELECT coalesce(sum(amount), 0) INTO v_last_month_exp
  FROM public.expenses
  WHERE to_char(incurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = v_last_month;

  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_exp_categories
  FROM (
    SELECT category, sum(amount) as total
    FROM public.expenses
    WHERE to_char(incurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = v_current_month
    GROUP BY category
    ORDER BY total DESC
  ) sub;

  -- 9. Attendance today
  SELECT
    count(DISTINCT profile_id),
    count(DISTINCT CASE WHEN status = 'working' THEN profile_id END),
    count(DISTINCT CASE WHEN status = 'completed' THEN profile_id END)
  INTO
    v_today_checked_in,
    v_today_working,
    v_today_completed
  FROM public.attendance_logs
  WHERE work_date = v_today;

  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_today_attendees
  FROM (
    SELECT DISTINCT ON (a.profile_id)
      a.id, a.profile_id, p.full_name, p.avatar_url, a.check_in_time, a.check_out_time, a.status, b.name as branch_name
    FROM public.attendance_logs a
    JOIN public.profiles p ON p.id = a.profile_id
    LEFT JOIN public.branches b ON b.id = a.branch_id
    WHERE a.work_date = v_today
    ORDER BY a.profile_id, a.check_in_time DESC
  ) sub;

  -- Recent attendees for live feed
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_recent_attendees
  FROM (
    SELECT a.id, a.profile_id, p.full_name, p.avatar_url, a.check_in_time, a.check_out_time, a.status, b.name as branch_name
    FROM public.attendance_logs a
    JOIN public.profiles p ON p.id = a.profile_id
    LEFT JOIN public.branches b ON b.id = a.branch_id
    ORDER BY a.created_at DESC
    LIMIT 8
  ) sub;

  -- 10. Month-over-month comparisons (Last 6 months)
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_monthly_comparison
  FROM (
    SELECT
      to_char(d, 'YYYY-MM') as month,
      coalesce((
        SELECT sum(s.total) 
        FROM public.sales s 
        WHERE s.status = 'completed' 
          AND to_char(s.sold_at at time zone 'Asia/Tashkent', 'YYYY-MM') = to_char(d, 'YYYY-MM')
      ), 0) as sales,
      coalesce((
        SELECT sum(e.amount) 
        FROM public.expenses e 
        WHERE to_char(e.incurred_at at time zone 'Asia/Tashkent', 'YYYY-MM') = to_char(d, 'YYYY-MM')
      ), 0) as expenses
    FROM generate_series(
      date_trunc('month', v_today) - interval '5 months',
      date_trunc('month', v_today),
      interval '1 month'
    ) d
    ORDER BY d ASC
  ) sub;

  -- 11. Top Selling Products in Period
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_top_selling
  FROM (
    SELECT p.id, p.name, p.sku, count(sl.id) as sold_count, sum(sl.line_total) as total_revenue
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.products p ON p.id = sl.product_id
    WHERE s.status = 'completed'
      AND (s.sold_at at time zone 'Asia/Tashkent')::date >= v_from
      AND (s.sold_at at time zone 'Asia/Tashkent')::date <= v_to
    GROUP BY p.id, p.name, p.sku
    ORDER BY sold_count DESC
    LIMIT 6
  ) sub;

  -- 12. Low Selling / Stagnant Products (in stock but 0 sales in selected period)
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb) INTO v_low_selling
  FROM (
    SELECT p.id, p.name, p.sku, count(u.id) as in_stock
    FROM public.products p
    JOIN public.inventory_units u ON u.product_id = p.id AND u.status = 'available'
    WHERE p.is_published = true
      AND NOT EXISTS (
        SELECT 1 FROM public.sale_lines sl
        JOIN public.sales s ON s.id = sl.sale_id
        WHERE sl.product_id = p.id
          AND s.status = 'completed'
          AND (s.sold_at at time zone 'Asia/Tashkent')::date >= v_from
          AND (s.sold_at at time zone 'Asia/Tashkent')::date <= v_to
      )
    GROUP BY p.id, p.name, p.sku
    ORDER BY in_stock DESC
    LIMIT 6
  ) sub;

  -- Final output assembly
  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'today', v_today),
    'overview', jsonb_build_object(
      'product_types', v_product_types,
      'total_units', v_total_units,
      'total_cost', v_total_cost,
      'total_retail', v_total_retail,
      'zero_stock', v_zero_stock,
      'branches', v_branch_count,
      'warehouses', v_warehouse_count,
      'employees', v_employee_count,
      'couriers', v_courier_count,
      'total_orders', v_order_count,
      'online_orders', v_online_orders
    ),
    'sales', jsonb_build_object(
      'total', v_sales_total,
      'profit', v_sales_profit,
      'cost', v_sales_cost,
      'count', v_sales_count,
      'avg_ticket', v_avg_ticket
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
      'this_month', v_this_month_exp,
      'last_month', v_last_month_exp,
      'categories', v_exp_categories
    ),
    'attendance', jsonb_build_object(
      'checked_in', v_today_checked_in,
      'working', v_today_working,
      'completed', v_today_completed,
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

-- 4. Update get_seller_leaderboard with public.tashkent_today()
CREATE OR REPLACE FUNCTION public.get_seller_leaderboard(
  p_branch_id uuid DEFAULT NULL,
  p_period text DEFAULT 'day',
  p_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_branch_id uuid := p_branch_id;
  v_period text := lower(coalesce(p_period, 'day'));
  v_target_date date := coalesce(p_date, public.tashkent_today());
  v_start_date date;
  v_end_date date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_branch_name text;
  v_total_sellers integer;
  v_branch_total_sales numeric(18,2) := 0;
  v_branch_total_checks bigint := 0;
  v_branch_total_units bigint := 0;
  v_branch_total_profit numeric(18,2) := 0;
  v_items jsonb;
BEGIN
  -- Fallback branch for manager, seller, accountant if not explicitly provided
  IF v_branch_id IS NULL THEN
    SELECT r.branch_id INTO v_branch_id
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid()
    ORDER BY CASE WHEN r.role = 'manager' THEN 1 WHEN r.role = 'seller' THEN 2 ELSE 3 END
    LIMIT 1;
  END IF;

  -- If still null, pick first active branch
  IF v_branch_id IS NULL THEN
    SELECT id INTO v_branch_id FROM public.branches WHERE is_active = true ORDER BY name LIMIT 1;
  END IF;

  SELECT name INTO v_branch_name FROM public.branches WHERE id = v_branch_id;

  -- Calculate start and end dates based on period
  IF v_period = 'week' THEN
    v_start_date := date_trunc('week', v_target_date::timestamp)::date;
    v_end_date := v_start_date + 7;
  ELSIF v_period = 'month' THEN
    v_start_date := date_trunc('month', v_target_date::timestamp)::date;
    v_end_date := (date_trunc('month', v_target_date::timestamp) + interval '1 month')::date;
  ELSIF v_period = 'year' THEN
    v_start_date := date_trunc('year', v_target_date::timestamp)::date;
    v_end_date := (date_trunc('year', v_target_date::timestamp) + interval '1 year')::date;
  ELSE
    -- 'day'
    v_period := 'day';
    v_start_date := v_target_date;
    v_end_date := v_target_date + 1;
  END IF;

  v_start_ts := public.business_day_start(v_start_date);
  v_end_ts := public.business_day_start(v_end_date);

  -- Correctly aggregate sales directly from sales table (WITHOUT multiplying by sale_lines)
  WITH sales_agg AS (
    SELECT
      s.seller_id,
      COUNT(s.id) as checks_count,
      COALESCE(SUM(s.total - coalesce((
        select sum(r.refund_amount)
        from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)), 0) as total_sales
    FROM public.sales s
    WHERE s.branch_id = v_branch_id
      AND s.status = 'completed'
      AND s.sold_at >= v_start_ts
      AND s.sold_at < v_end_ts
      AND s.seller_id IS NOT NULL
    GROUP BY s.seller_id
  ),
  lines_agg AS (
    SELECT
      s.seller_id,
      COUNT(sl.id) as units_count,
      COALESCE(SUM(sl.line_total - (coalesce(sl.unit_cost, 0) * coalesce(sl.quantity, 1))), 0) as total_profit
    FROM public.sales s
    JOIN public.sale_lines sl ON sl.sale_id = s.id
    WHERE s.branch_id = v_branch_id
      AND s.status = 'completed'
      AND s.sold_at >= v_start_ts
      AND s.sold_at < v_end_ts
      AND s.seller_id IS NOT NULL
    GROUP BY s.seller_id
  ),
  branch_sellers AS (
    SELECT DISTINCT p.id as seller_id, p.full_name as seller_name, p.avatar_url
    FROM public.profiles p
    JOIN public.profile_roles pr ON pr.profile_id = p.id
    WHERE pr.role = 'seller'
      AND pr.branch_id = v_branch_id
      AND p.is_active = true
  ),
  ranked AS (
    SELECT
      bs.seller_id,
      bs.seller_name,
      bs.avatar_url,
      COALESCE(sa.checks_count, 0) as checks_count,
      COALESCE(la.units_count, 0) as units_count,
      COALESCE(sa.total_sales, 0) as total_sales,
      COALESCE(la.total_profit, 0) as total_profit,
      CASE
        WHEN COALESCE(sa.checks_count, 0) > 0
        THEN ROUND(COALESCE(sa.total_sales, 0) / sa.checks_count, 2)
        ELSE 0
      END as avg_check_amount,
      RANK() OVER (ORDER BY COALESCE(sa.total_sales, 0) DESC, COALESCE(sa.checks_count, 0) DESC) as rank
    FROM branch_sellers bs
    LEFT JOIN sales_agg sa ON sa.seller_id = bs.seller_id
    LEFT JOIN lines_agg la ON la.seller_id = bs.seller_id
  )
  SELECT
    COUNT(*),
    COALESCE(SUM(r.total_sales), 0),
    COALESCE(SUM(r.checks_count), 0),
    COALESCE(SUM(r.units_count), 0),
    COALESCE(SUM(r.total_profit), 0),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'rank', r.rank,
        'seller_id', r.seller_id,
        'seller_name', r.seller_name,
        'avatar_url', r.avatar_url,
        'checks_count', r.checks_count,
        'units_count', r.units_count,
        'total_sales', r.total_sales,
        'total_profit', r.total_profit,
        'avg_check_amount', r.avg_check_amount
      ) ORDER BY r.rank, r.total_sales DESC
    ), '[]'::jsonb)
  INTO
    v_total_sellers,
    v_branch_total_sales,
    v_branch_total_checks,
    v_branch_total_units,
    v_branch_total_profit,
    v_items
  FROM ranked r;

  RETURN jsonb_build_object(
    'branch_id', v_branch_id,
    'branch_name', v_branch_name,
    'period', v_period,
    'target_date', v_target_date,
    'start_date', v_start_date,
    'end_date', v_end_date,
    'total_sellers', coalesce(v_total_sellers, 0),
    'branch_summary', jsonb_build_object(
      'total_sales', coalesce(v_branch_total_sales, 0),
      'checks_count', coalesce(v_branch_total_checks, 0),
      'units_count', coalesce(v_branch_total_units, 0),
      'total_profit', coalesce(v_branch_total_profit, 0),
      'avg_check_amount', CASE WHEN v_branch_total_checks > 0 THEN round(v_branch_total_sales / v_branch_total_checks, 2) ELSE 0 END
    ),
    'items', coalesce(v_items, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_seller_leaderboard(uuid, text, date) TO authenticated, service_role;

-- 5. Update get_seller_today_sales_kpi with public.tashkent_today()
CREATE OR REPLACE FUNCTION public.get_seller_today_sales_kpi(
  p_branch_id uuid,
  p_date date DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_date date := coalesce(p_date, public.tashkent_today());
  v_start timestamptz := public.business_day_start(v_date);
  v_end timestamptz := public.business_day_start(v_date + 1);
  v_query text := nullif(trim(p_query), '');
  v_kpi jsonb;
  v_seller_rank integer := 0;
BEGIN
  IF NOT public.current_user_active() OR NOT public.has_role(array['superadmin','admin','manager','seller']::public.app_role[], p_branch_id) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  SELECT count(*)
  INTO v_total
  FROM public.sales s
  WHERE s.branch_id = p_branch_id
    AND s.sold_at >= v_start
    AND s.sold_at < v_end
    AND s.status <> 'void'
    AND s.seller_id = auth.uid()
    AND (
      v_query IS NULL
      OR s.sale_no ILIKE ('%' || v_query || '%')
      OR EXISTS (
        SELECT 1
        FROM public.sale_lines sl
        JOIN public.products p ON p.id = sl.product_id
        LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
        WHERE sl.sale_id = s.id
          AND (
            p.name ILIKE ('%' || v_query || '%')
            OR p.sku ILIKE ('%' || v_query || '%')
            OR coalesce(u.qr_code, '') ILIKE ('%' || v_query || '%')
            OR coalesce(u.serial_number, '') ILIKE ('%' || v_query || '%')
          )
      )
    );

  SELECT coalesce(jsonb_agg(item), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      s.id,
      s.sale_no,
      s.branch_id,
      s.seller_id,
      seller.full_name AS seller_name,
      s.manager_id,
      manager.full_name AS manager_name,
      s.status,
      s.subtotal,
      s.discount,
      s.tax,
      s.total,
      s.sold_at,
      s.created_at,
      coalesce((
        SELECT jsonb_agg(
          jsonb_build_object(
            'line_id', sl.id,
            'product_id', sl.product_id,
            'product_name', p.name,
            'sku', p.sku,
            'unit_id', sl.unit_id,
            'qr_code', u.qr_code,
            'serial_number', u.serial_number,
            'unit_price', sl.unit_price,
            'discount', sl.discount,
            'tax', sl.tax,
            'line_total', sl.line_total,
            'primary_media_url', (
              SELECT pm.url
              FROM public.product_media pm
              WHERE pm.product_id = p.id
              ORDER BY pm.is_primary DESC, pm.sort_order ASC, pm.created_at ASC
              LIMIT 1
            )
          )
          ORDER BY sl.id ASC
        )
        FROM public.sale_lines sl
        JOIN public.products p ON p.id = sl.product_id
        LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
        WHERE sl.sale_id = s.id
      ), '[]'::jsonb) AS lines
    FROM public.sales s
    JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    WHERE s.branch_id = p_branch_id
      AND s.sold_at >= v_start
      AND s.sold_at < v_end
      AND s.status <> 'void'
      AND s.seller_id = auth.uid()
      AND (
        v_query IS NULL
        OR s.sale_no ILIKE ('%' || v_query || '%')
        OR EXISTS (
          SELECT 1
          FROM public.sale_lines sl
          JOIN public.products p ON p.id = sl.product_id
          LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
          WHERE sl.sale_id = s.id
            AND (
              p.name ILIKE ('%' || v_query || '%')
              OR p.sku ILIKE ('%' || v_query || '%')
              OR coalesce(u.qr_code, '') ILIKE ('%' || v_query || '%')
              OR coalesce(u.serial_number, '') ILIKE ('%' || v_query || '%')
            )
        )
      )
    ORDER BY s.sold_at DESC, s.created_at DESC
    LIMIT greatest(least(coalesce(p_limit, 50), 200), 1)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  ) item;

  -- Seller rank from leaderboard ranking
  SELECT coalesce(
    (
      SELECT (elem->>'rank')::integer
      FROM jsonb_array_elements(
        coalesce((public.get_seller_leaderboard(p_branch_id, 'day', v_date))->'items', '[]'::jsonb)
      ) elem
      WHERE (elem->>'seller_id')::uuid = auth.uid()
      LIMIT 1
    ),
    0
  ) INTO v_seller_rank;

  -- KPI Calculation
  SELECT jsonb_build_object(
    'total_sales_amount', coalesce(sum(s.total), 0),
    'checks_count', count(s.id),
    'units_count', coalesce((
      SELECT count(sl.id)
      FROM public.sale_lines sl
      JOIN public.sales s2 ON s2.id = sl.sale_id
      WHERE s2.branch_id = p_branch_id
        AND s2.sold_at >= v_start
        AND s2.sold_at < v_end
        AND s2.status <> 'void'
        AND s2.seller_id = auth.uid()
    ), 0),
    'avg_check_amount', CASE WHEN count(s.id) > 0 THEN round(coalesce(sum(s.total), 0) / count(s.id), 2) ELSE 0 END,
    'seller_rank', coalesce(v_seller_rank, 0)
  )
  INTO v_kpi
  FROM public.sales s
  WHERE s.branch_id = p_branch_id
    AND s.sold_at >= v_start
    AND s.sold_at < v_end
    AND s.status <> 'void'
    AND s.seller_id = auth.uid();

  RETURN jsonb_build_object(
    'kpi', coalesce(v_kpi, jsonb_build_object(
      'total_sales_amount', 0,
      'checks_count', 0,
      'units_count', 0,
      'avg_check_amount', 0,
      'seller_rank', 0
    )),
    'items', coalesce(v_items, '[]'::jsonb),
    'total', coalesce(v_total, 0),
    'date', v_date
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_seller_today_sales_kpi(uuid, date, text, integer, integer) TO authenticated, service_role;

-- 6. Update list_sales_history with public.tashkent_today()
CREATE OR REPLACE FUNCTION public.list_sales_history(
  p_branch_id uuid DEFAULT NULL,
  p_seller_id uuid DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_from date := p_from;
  v_to date := p_to;
  v_tmp date;
  v_branch_id uuid := p_branch_id;
  v_today date := public.tashkent_today();
BEGIN
  -- If manager/accountant calls without branch_id, fallback to user's assigned branch
  IF v_branch_id IS NULL AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
    SELECT r.branch_id INTO v_branch_id
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid() AND r.role IN ('manager','accountant')
    LIMIT 1;
  END IF;

  PERFORM public.require_report_access(v_branch_id);

  IF v_from IS NULL AND v_to IS NULL THEN
    IF (p_query IS NOT NULL AND btrim(p_query) <> '') OR p_seller_id IS NOT NULL THEN
      -- If query or seller is specified without dates, search back 180 days
      v_from := v_today - 180;
      v_to := v_today;
    ELSE
      v_from := v_today;
      v_to := v_today;
    END IF;
  ELSIF v_from IS NULL THEN
    v_from := v_to;
  ELSIF v_to IS NULL THEN
    v_to := v_from;
  END IF;

  IF v_to < v_from THEN
    v_tmp := v_from;
    v_from := v_to;
    v_to := v_tmp;
  END IF;

  WITH filtered AS (
    SELECT
      sl.id AS line_id,
      sl.unit_id,
      sl.product_id,
      sl.unit_price,
      sl.discount,
      sl.tax,
      sl.line_total,
      sl.unit_cost,
      s.id AS sale_id,
      s.sale_no,
      s.sold_at,
      s.status::text AS sale_status,
      s.branch_id,
      b.name AS branch_name,
      b.code AS branch_code,
      seller.full_name AS seller_name,
      s.seller_id,
      manager.full_name AS manager_name,
      p.name AS product_name,
      p.sku,
      p.slug AS product_slug,
      p.is_published,
      (
        SELECT pm.url
        FROM public.product_media pm
        WHERE pm.product_id = p.id
        ORDER BY pm.is_primary DESC, pm.sort_order ASC, pm.created_at ASC
        LIMIT 1
      ) AS primary_media_url,
      u.qr_code,
      u.serial_number,
      u.variant_id,
      pv.color AS variant_color,
      count(*) OVER() AS full_count
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.branches b ON b.id = s.branch_id
    JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
    LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
    WHERE s.sold_at >= public.business_day_start(v_from)
      AND s.sold_at < public.business_day_start(v_to + 1)
      AND (v_branch_id IS NULL OR s.branch_id = v_branch_id)
      AND (p_seller_id IS NULL OR s.seller_id = p_seller_id)
      AND s.status <> 'void'
      AND (
        p_query IS NULL OR btrim(p_query) = '' OR
        p.name ILIKE '%' || btrim(p_query) || '%' OR
        p.sku ILIKE '%' || btrim(p_query) || '%' OR
        s.sale_no ILIKE '%' || btrim(p_query) || '%' OR
        seller.full_name ILIKE '%' || btrim(p_query) || '%' OR
        u.qr_code ILIKE '%' || btrim(p_query) || '%' OR
        u.serial_number ILIKE '%' || btrim(p_query) || '%'
      )
    ORDER BY s.sold_at DESC, sl.id DESC
    LIMIT greatest(least(coalesce(p_limit, 50), 200), 1)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  )
  SELECT
    coalesce(jsonb_agg(
      jsonb_build_object(
        'line_id', f.line_id,
        'unit_id', f.unit_id,
        'product_id', f.product_id,
        'unit_price', f.unit_price,
        'discount', f.discount,
        'tax', f.tax,
        'line_total', f.line_total,
        'unit_cost', f.unit_cost,
        'sale_id', f.sale_id,
        'sale_no', f.sale_no,
        'sold_at', f.sold_at,
        'sale_status', f.sale_status,
        'branch_id', f.branch_id,
        'branch_name', f.branch_name,
        'branch_code', f.branch_code,
        'seller_name', f.seller_name,
        'seller_id', f.seller_id,
        'manager_name', f.manager_name,
        'product_name', f.product_name,
        'sku', f.sku,
        'product_slug', f.product_slug,
        'is_published', f.is_published,
        'primary_media_url', f.primary_media_url,
        'qr_code', f.qr_code,
        'serial_number', f.serial_number,
        'variant_id', f.variant_id,
        'variant_color', f.variant_color
      )
    ), '[]'::jsonb),
    coalesce(max(f.full_count), 0)
  INTO v_items, v_total
  FROM filtered f;

  RETURN jsonb_build_object(
    'items', coalesce(v_items, '[]'::jsonb),
    'total', coalesce(v_total, 0),
    'from', v_from,
    'to', v_to
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_sales_history(uuid, uuid, date, date, text, integer, integer) TO authenticated, service_role;

-- 7. Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
