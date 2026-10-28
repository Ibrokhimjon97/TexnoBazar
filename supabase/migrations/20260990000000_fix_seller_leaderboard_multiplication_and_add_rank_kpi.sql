-- Migration: Fix seller leaderboard multiplication bug and add seller rank to POS sales KPI
-- 1. Fix get_seller_leaderboard to avoid multiplying sales.total by sale_lines count
CREATE OR REPLACE FUNCTION public.get_seller_leaderboard(
  p_branch_id uuid DEFAULT NULL,
  p_period text DEFAULT 'day',
  p_date date DEFAULT CURRENT_DATE
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
  v_target_date date := coalesce(p_date, current_date);
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
    SELECT id INTO v_branch_id FROM public.branches WHERE is_active = true ORDER BY created_at LIMIT 1;
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
      AND s.status NOT IN ('void', 'returned')
      AND s.sold_at >= v_start_ts
      AND s.sold_at < v_end_ts
    GROUP BY s.seller_id
  ),
  lines_agg AS (
    SELECT
      s.seller_id,
      COUNT(sl.id) as units_count,
      COALESCE(SUM(sl.line_total - (coalesce(sl.unit_cost, 0) * sl.quantity)), 0) as gross_profit
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    WHERE s.branch_id = v_branch_id
      AND s.status NOT IN ('void', 'returned')
      AND s.sold_at >= v_start_ts
      AND s.sold_at < v_end_ts
    GROUP BY s.seller_id
  ),
  seller_sales AS (
    SELECT
      sa.seller_id,
      sa.checks_count,
      sa.total_sales,
      COALESCE(la.units_count, 0) as units_count,
      COALESCE(la.gross_profit, 0) as gross_profit
    FROM sales_agg sa
    LEFT JOIN lines_agg la ON la.seller_id = sa.seller_id
  ),
  branch_sellers AS (
    -- Include all active sellers in this branch
    SELECT
      p.id as seller_id,
      p.full_name as seller_name,
      p.phone as seller_phone,
      p.email as seller_email,
      COALESCE(ss.total_sales, 0) as total_sales,
      COALESCE(ss.checks_count, 0) as checks_count,
      COALESCE(ss.units_count, 0) as units_count,
      COALESCE(ss.gross_profit, 0) as gross_profit
    FROM public.profile_roles pr
    JOIN public.profiles p ON p.id = pr.profile_id
    LEFT JOIN seller_sales ss ON ss.seller_id = p.id
    WHERE pr.branch_id = v_branch_id
      AND pr.role = 'seller'
      AND p.is_active = true
  ),
  ranked AS (
    SELECT
      bs.*,
      ROW_NUMBER() OVER (
        ORDER BY bs.total_sales DESC, bs.checks_count DESC, bs.units_count DESC, bs.seller_name ASC
      ) as rank_pos
    FROM branch_sellers bs
  ),
  totals AS (
    SELECT
      COALESCE(SUM(total_sales), 0) as b_total_sales,
      COALESCE(SUM(checks_count), 0) as b_total_checks,
      COALESCE(SUM(units_count), 0) as b_total_units,
      COALESCE(SUM(gross_profit), 0) as b_total_profit,
      COUNT(*) as b_total_sellers
    FROM ranked
  )
  SELECT
    t.b_total_sales,
    t.b_total_checks,
    t.b_total_units,
    t.b_total_sellers,
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'rank', r.rank_pos,
        'is_top3', r.rank_pos <= 3,
        'seller_id', r.seller_id,
        'seller_name', r.seller_name,
        'seller_phone', r.seller_phone,
        'total_sales', r.total_sales,
        'checks_count', r.checks_count,
        'units_count', r.units_count,
        'gross_profit', r.gross_profit,
        'share_percent', CASE WHEN t.b_total_sales > 0 THEN ROUND((r.total_sales / t.b_total_sales) * 100, 1) ELSE 0 END,
        'average_check', CASE WHEN r.checks_count > 0 THEN ROUND(r.total_sales / r.checks_count, 0) ELSE 0 END
      ) ORDER BY r.rank_pos ASC
    ), '[]'::jsonb)
  INTO
    v_branch_total_sales,
    v_branch_total_checks,
    v_branch_total_units,
    v_total_sellers,
    v_items
  FROM ranked r
  CROSS JOIN totals t
  GROUP BY t.b_total_sales, t.b_total_checks, t.b_total_units, t.b_total_sellers;

  RETURN jsonb_build_object(
    'branch_id', v_branch_id,
    'branch_name', v_branch_name,
    'period', v_period,
    'target_date', v_target_date,
    'start_date', v_start_date,
    'end_date', (v_end_date - 1),
    'total_sellers', v_total_sellers,
    'branch_total_sales', v_branch_total_sales,
    'branch_total_checks', v_branch_total_checks,
    'branch_total_units', v_branch_total_units,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_seller_leaderboard(uuid, text, date) TO authenticated, service_role;


-- 2. Update list_my_pos_sales_filtered to calculate seller rank for the selected date
CREATE OR REPLACE FUNCTION public.list_my_pos_sales_filtered(
  p_branch_id uuid,
  p_date date default null,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_total bigint;
  v_date date := coalesce(p_date, current_date);
  v_start timestamptz := public.business_day_start(v_date);
  v_end timestamptz := public.business_day_start(v_date + 1);
  v_query text := nullif(trim(p_query), '');
  v_kpi jsonb;
  v_seller_rank integer := 0;
BEGIN
  if not public.current_user_active() or not public.has_role(array['superadmin','admin','manager','seller']::public.app_role[], p_branch_id) then
    raise exception 'Ruxsat yo‘q' using errcode = '42501';
  end if;

  select count(*)
  into v_total
  from public.sales s
  where s.branch_id = p_branch_id
    and s.seller_id = auth.uid()
    and s.status not in ('void', 'returned')
    and s.sold_at >= v_start and s.sold_at < v_end
    and (
      v_query is null
      or s.sale_no ilike '%' || v_query || '%'
      or exists (
        select 1
        from public.sale_lines x
        join public.products p on p.id = x.product_id
        join public.inventory_units u on u.id = x.unit_id
        where x.sale_id = s.id
          and (
            p.name ilike '%' || v_query || '%'
            or p.sku ilike '%' || v_query || '%'
            or u.qr_code ilike '%' || v_query || '%'
            or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
          )
      )
    );

  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
  into v_items
  from (
    select
      s.id,
      s.sale_no,
      s.status,
      s.sold_at,
      greatest(0, s.total - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as total,
      s.discount,
      s.tax,
      greatest(0, (
        select coalesce(sum(x.line_total - x.tax - x.unit_cost), 0)
        from public.sale_lines x where x.sale_id = s.id
      ) - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as profit,
      c.id as customer_id,
      c.full_name as customer_name,
      c.phone as customer_phone,
      coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0) as refunded_amount,
      case
        when exists (select 1 from public.sale_returns r where r.original_sale_id = s.id and r.status = 'completed') then 'refunded'
        when exists (select 1 from public.sale_returns r where r.original_sale_id = s.id and r.status in ('requested', 'approved')) then 'return_pending'
        else 'normal'
      end as return_status,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', x.id,
          'product_id', x.product_id,
          'product_name', p.name,
          'sku', p.sku,
          'unit_id', x.unit_id,
          'qr_code', u.qr_code,
          'serial_number', u.serial_number,
          'unit_cost', x.unit_cost,
          'unit_price', x.unit_price,
          'line_total', x.line_total,
          'quantity', x.quantity,
          'is_returned', exists(
            select 1 from public.sale_return_lines rl
            join public.sale_returns r on r.id = rl.return_id
            where rl.sale_line_id = x.id and r.status = 'completed'
          )
        )), '[]'::jsonb)
        from public.sale_lines x
        join public.products p on p.id = x.product_id
        join public.inventory_units u on u.id = x.unit_id
        where x.sale_id = s.id
      ) as lines
    from public.sales s
    left join public.customers c on c.id = s.customer_id
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.status not in ('void', 'returned')
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or s.sale_no ilike '%' || v_query || '%'
        or exists (
          select 1
          from public.sale_lines x
          join public.products p on p.id = x.product_id
          join public.inventory_units u on u.id = x.unit_id
          where x.sale_id = s.id
            and (
              p.name ilike '%' || v_query || '%'
              or p.sku ilike '%' || v_query || '%'
              or u.qr_code ilike '%' || v_query || '%'
              or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
            )
        )
      )
    order by s.sold_at desc, s.id
    limit p_limit offset p_offset
  ) q;

  -- Seller rank calculation among branch sellers for date
  SELECT COALESCE((
    SELECT (item->>'rank')::integer
    FROM jsonb_array_elements(
      (public.get_seller_leaderboard(p_branch_id, 'day', v_date)->'items')
    ) as item
    WHERE item->>'seller_id' = auth.uid()::text
  ), 0) INTO v_seller_rank;

  -- KPI hisob-kitobi
  select jsonb_build_object(
    'count', count(*),
    'total', coalesce(sum(q.total), 0),
    'profit', coalesce(sum(q.profit), 0),
    'rank', coalesce(v_seller_rank, 0),
    'discount', coalesce(sum(q.discount), 0)
  )
  into v_kpi
  from (
    select
      greatest(0, s.total - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as total,
      s.discount,
      greatest(0, (
        select coalesce(sum(x.line_total - x.tax - x.unit_cost), 0)
        from public.sale_lines x where x.sale_id = s.id
      ) - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as profit
    from public.sales s
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.status not in ('void', 'returned')
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or s.sale_no ilike '%' || v_query || '%'
      )
  ) q;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'today', v_kpi
  );
end;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_pos_sales_filtered(uuid, date, text, integer, integer) TO authenticated, service_role;
