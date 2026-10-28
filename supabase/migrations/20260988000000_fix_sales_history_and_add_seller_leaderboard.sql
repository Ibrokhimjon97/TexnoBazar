-- =============================================================================
-- Migration: 20260988000000_fix_sales_history_and_add_seller_leaderboard.sql
-- Description:
--   1. Drop obsolete 6-argument overload of list_sales_history to eliminate
--      function ambiguity in PostgreSQL ("Could not choose the best candidate function").
--   2. Update list_sales_history to support manager branch fallback and 90-day lookup
--      when searching by query without explicit date range.
--   3. Update AI reporting RPCs (ai_seller_performance, ai_inventory_valuation,
--      ai_product_performance, ai_expense_report, ai_today_attendance,
--      ai_attendance_summary, ai_debt_report, ai_list_orders) with manager branch fallback.
--   4. Create public.get_seller_leaderboard(p_branch_id, p_period, p_date)
--      for manager and seller apps leaderboard with day/week/month/year periods.
-- =============================================================================

-- 1. Drop obsolete 6-argument overload
DROP FUNCTION IF EXISTS public.list_sales_history(uuid, date, date, text, integer, integer);

-- 1b. Make require_report_access support service_role and direct superuser
CREATE OR REPLACE FUNCTION public.require_report_access(p_branch_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') OR coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' THEN
    RETURN;
  END IF;
  IF p_branch_id IS NULL THEN
    IF NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
      RAISE EXCEPTION 'Global hisobot uchun admin roli talab qilinadi' USING errcode = '42501';
    END IF;
  ELSIF NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null) OR
    public.has_role(array['manager','accountant']::public.app_role[], p_branch_id)
  ) THEN
    RAISE EXCEPTION 'Filial hisoboti uchun ruxsat yo‘q' USING errcode = '42501';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.require_report_access(uuid) TO authenticated, service_role;


-- 2. Update canonical 7-argument list_sales_history
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
    IF p_query IS NOT NULL AND btrim(p_query) <> '' THEN
      -- If query is specified (e.g. searching for a product/QR) without dates, search back 90 days
      v_from := current_date - 90;
      v_to := current_date;
    ELSE
      v_from := current_date;
      v_to := current_date;
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
      (SELECT pm.public_url FROM public.product_media pm
       WHERE pm.product_id = p.id AND pm.is_primary = true
       LIMIT 1) AS primary_media_url,
      u.qr_code,
      u.serial_number,
      coalesce((select sum(r.refund_amount) from public.sale_returns r where r.original_sale_id = s.id and r.status = 'completed'), 0) as total_refunded,
      count(*) OVER () AS total_count
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.branches b ON b.id = s.branch_id
    JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
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
        'total_refunded', f.total_refunded
      )
    ), '[]'::jsonb),
    coalesce(max(f.total_count), 0)
  INTO v_items, v_total
  FROM filtered f;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'from', v_from,
    'to', v_to
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_sales_history(uuid, uuid, date, date, text, integer, integer) TO authenticated, service_role;

-- 3. AI Reporting RPCs manager branch fallback
CREATE OR REPLACE FUNCTION public.ai_seller_performance(
  p_from date default current_date,
  p_to date default current_date,
  p_branch_id uuid default null,
  p_employee_query text default null,
  p_limit integer default 5
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rate numeric;
  v_items jsonb;
  v_totals jsonb;
  v_q text := nullif(btrim(p_employee_query), '');
  v_branch_id uuid := p_branch_id;
begin
  IF v_branch_id IS NULL AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
    SELECT r.branch_id INTO v_branch_id
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid() AND r.role IN ('manager','accountant')
    LIMIT 1;
  END IF;

  perform public.require_report_access(v_branch_id);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Sana oralig''i noto''g''ri' using errcode = '22023';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  with lines as (
    select s.seller_id, pr.full_name, s.branch_id, b.name as branch_name, s.id as sale_id,
      sl.unit_cost, sl.line_total, sl.tax, sl.discount
    from public.sales s
    join public.sale_lines sl on sl.sale_id = s.id
    join public.profiles pr on pr.id = s.seller_id
    join public.branches b on b.id = s.branch_id
    where s.status <> 'void'
      and s.sold_at >= public.business_day_start(p_from)
      and s.sold_at < public.business_day_start(p_to + 1)
      and (v_branch_id is null or s.branch_id = v_branch_id)
      and (v_q is null or pr.full_name ilike '%' || v_q || '%')
  ), agg as (
    select seller_id, full_name, branch_name,
      count(distinct sale_id) as sale_count,
      count(*) as unit_count,
      sum(unit_cost) as total_cost,
      sum(line_total - tax) as revenue_net,
      sum(discount) as total_discount,
      sum(line_total - tax - unit_cost) as profit
    from lines group by seller_id, full_name, branch_name
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'seller_id', a.seller_id, 'full_name', a.full_name, 'branch_name', a.branch_name,
      'sale_count', a.sale_count, 'unit_count', a.unit_count,
      'total_cost_uzs', a.total_cost, 'revenue_net_uzs', a.revenue_net,
      'total_discount_uzs', a.total_discount, 'profit_uzs', a.profit)
      order by a.revenue_net desc), '[]'::jsonb),
    jsonb_build_object(
      'seller_count', count(*),
      'sale_count', coalesce(sum(sale_count), 0),
      'unit_count', coalesce(sum(unit_count), 0),
      'total_cost_uzs', coalesce(sum(total_cost), 0),
      'revenue_net_uzs', coalesce(sum(revenue_net), 0),
      'total_discount_uzs', coalesce(sum(total_discount), 0),
      'profit_uzs', coalesce(sum(profit), 0))
  into v_items, v_totals
  from (select * from agg order by revenue_net desc limit greatest(least(coalesce(p_limit, 5), 50), 1)) a;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'exchange_rate_usd_uzs', v_rate,
    'totals', v_totals,
    'top_sellers', v_items
  );
end $$;

GRANT EXECUTE ON FUNCTION public.ai_seller_performance(date, date, uuid, text, integer) TO authenticated, service_role;

-- ai_inventory_valuation with manager branch fallback
CREATE OR REPLACE FUNCTION public.ai_inventory_valuation(
  p_branch_id uuid default null,
  p_location_type text default null,
  p_top_limit integer default 10
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rate numeric;
  v_summary jsonb;
  v_by_location jsonb;
  v_top jsonb;
  v_branch_id uuid := p_branch_id;
begin
  IF v_branch_id IS NULL AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
    SELECT r.branch_id INTO v_branch_id
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid() AND r.role IN ('manager','accountant')
    LIMIT 1;
  END IF;

  perform public.require_report_access(v_branch_id);
  if p_location_type is not null and p_location_type not in ('store','warehouse') then
    raise exception 'location_type faqat store yoki warehouse bo''lishi mumkin' using errcode = '22023';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  with scoped as (
    select u.id, u.product_id, l.branch_id, b.name as branch_name, l.id as location_id,
      l.name as location_name, l.type::text as location_type,
      coalesce(sb.unit_cost, p.cost_price) as unit_cost,
      coalesce(sb.minimum_sale_price, p.minimum_sale_price, p.retail_price) as min_price,
      coalesce(sb.wholesale_price, p.wholesale_price, p.retail_price) as wholesale_price,
      coalesce(sb.retail_price, p.retail_price) as retail_price,
      p.name as product_name, p.sku
    from public.inventory_units u
    join public.locations l on l.id = u.location_id
    join public.branches b on b.id = l.branch_id
    join public.products p on p.id = u.product_id
    left join public.stock_batches sb on sb.id = u.batch_id
    where u.status in ('available','reserved','returned')
      and l.is_active and l.type in ('store','warehouse')
      and (v_branch_id is null or l.branch_id = v_branch_id)
      and (p_location_type is null or l.type::text = p_location_type)
  )
  select
    jsonb_build_object(
      'unit_count', count(*),
      'product_type_count', count(distinct product_id),
      'total_cost_uzs', coalesce(sum(unit_cost), 0),
      'total_at_minimum_uzs', coalesce(sum(min_price), 0),
      'total_at_wholesale_uzs', coalesce(sum(wholesale_price), 0),
      'total_at_retail_uzs', coalesce(sum(retail_price), 0),
      'profit_at_minimum_uzs', coalesce(sum(min_price) - sum(unit_cost), 0),
      'profit_at_wholesale_uzs', coalesce(sum(wholesale_price) - sum(unit_cost), 0),
      'profit_at_retail_uzs', coalesce(sum(retail_price) - sum(unit_cost), 0)
    ),
    coalesce((select jsonb_agg(jsonb_build_object(
        'branch_name', g.branch_name, 'location_name', g.location_name, 'location_type', g.location_type,
        'unit_count', g.unit_count, 'product_type_count', g.product_type_count,
        'total_cost_uzs', g.total_cost, 'total_at_minimum_uzs', g.total_min,
        'total_at_wholesale_uzs', g.total_wholesale, 'total_at_retail_uzs', g.total_retail,
        'profit_at_minimum_uzs', g.total_min - g.total_cost,
        'profit_at_wholesale_uzs', g.total_wholesale - g.total_cost)
      order by g.total_cost desc)
      from (select branch_name, location_name, location_type, count(*) as unit_count,
              count(distinct product_id) as product_type_count, sum(unit_cost) as total_cost,
              sum(min_price) as total_min, sum(wholesale_price) as total_wholesale, sum(retail_price) as total_retail
            from scoped group by branch_name, location_name, location_type) g), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
        'product_name', t.product_name, 'sku', t.sku, 'unit_count', t.unit_count,
        'total_cost_uzs', t.total_cost, 'total_at_retail_uzs', t.total_retail)
      order by t.total_cost desc)
      from (select product_name, sku, count(*) as unit_count, sum(unit_cost) as total_cost, sum(retail_price) as total_retail
            from scoped group by product_name, sku
            order by sum(unit_cost) desc
            limit greatest(least(coalesce(p_top_limit, 10), 50), 1)) t), '[]'::jsonb)
  into v_summary, v_by_location, v_top
  from scoped;

  return jsonb_build_object(
    'exchange_rate_usd_uzs', v_rate,
    'summary', v_summary,
    'by_location', v_by_location,
    'top_products_by_cost', v_top,
    'note', 'Barcha summalar UZS da. USD uchun exchange_rate_usd_uzs ga bo''ling.'
  );
end $$;

GRANT EXECUTE ON FUNCTION public.ai_inventory_valuation(uuid, text, integer) TO authenticated, service_role;

-- 4. Create public.get_seller_leaderboard(p_branch_id, p_period, p_date)
CREATE OR REPLACE FUNCTION public.get_seller_leaderboard(
  p_branch_id uuid DEFAULT NULL,
  p_period text DEFAULT 'day',
  p_date date DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_branch_id uuid := p_branch_id;
  v_period text := lower(coalesce(nullif(btrim(p_period), ''), 'day'));
  v_target_date date := coalesce(p_date, (now() at time zone 'Asia/Tashkent')::date);
  v_start_date date;
  v_end_date date;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_branch_name text;
  v_total_sellers integer;
  v_branch_total_sales numeric(18,2) := 0;
  v_branch_total_checks bigint := 0;
  v_branch_total_units bigint := 0;
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

  -- Aggregate sales within range
  WITH seller_sales AS (
    SELECT
      s.seller_id,
      COUNT(DISTINCT s.id) as checks_count,
      COUNT(sl.id) as units_count,
      COALESCE(SUM(s.total - coalesce((select sum(r.refund_amount) from public.sale_returns r where r.original_sale_id = s.id and r.status = 'completed'), 0)), 0) as total_sales
    FROM public.sales s
    LEFT JOIN public.sale_lines sl ON sl.sale_id = s.id
    WHERE s.branch_id = v_branch_id
      AND s.status = 'completed'
      AND s.sold_at >= v_start_ts
      AND s.sold_at < v_end_ts
    GROUP BY s.seller_id
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
      COALESCE(ss.units_count, 0) as units_count
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
