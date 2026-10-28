-- Migration: 20260994000000_low_stock_and_product_analytics_and_image_filter.sql
-- 1. Add p_has_image and p_sort_by to list_inventory_balances
-- 2. Add get_low_stock_products RPC for Manager dashboard
-- 3. Add get_product_sales_analytics RPC for Top 50 profitable/selling products analysis

-- 1. list_inventory_balances with image filter and sorting
CREATE OR REPLACE FUNCTION public.list_inventory_balances(
  p_branch_id uuid DEFAULT NULL::uuid,
  p_location_id uuid DEFAULT NULL::uuid,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_category_id uuid DEFAULT NULL::uuid,
  p_min_price numeric DEFAULT NULL::numeric,
  p_max_price numeric DEFAULT NULL::numeric,
  p_availability text DEFAULT NULL::text,
  p_has_image text DEFAULT NULL::text,
  p_sort_by text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
declare
  v_items jsonb;
  v_total bigint;
  v_total_on_hand numeric;
  v_total_reserved numeric;
  v_total_value numeric;
  v_total_cost numeric;
  v_target_branch uuid;
  v_default_loc record;
begin
  if p_limit not between 1 and 5000 or p_offset < 0 then
    raise exception 'Sahifalash noto''g''ri';
  end if;

  v_target_branch := coalesce(p_branch_id, (select id from public.branches limit 1));

  select l.id, l.name, l.type, br.name as branch_name into v_default_loc
  from public.locations l
  join public.branches br on br.id = l.branch_id
  where l.branch_id = v_target_branch
  order by case when l.type = 'warehouse' then 1 else 2 end, l.created_at
  limit 1;

  with combined as (
    -- 1. Products that have explicit entries in inventory_balances
    select
      ib.location_id,
      l.name as location_name,
      l.type as location_type,
      l.branch_id,
      br.name as branch_name,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      ib.on_hand,
      ib.reserved,
      (ib.on_hand - ib.reserved) as available,
      ib.updated_at,
      p.created_at
    from public.inventory_balances ib
    join public.locations l on l.id = ib.location_id
    join public.branches br on br.id = l.branch_id
    join public.products p on p.id = ib.product_id
    where public.can_access_branch(l.branch_id)
      and (v_target_branch is null or l.branch_id = v_target_branch)
      and (p_location_id is null or l.id = p_location_id)
      and p.status <> 'archived'

    union all

    -- 2. Products in catalog that have NO balance in this branch yet
    select
      v_default_loc.id as location_id,
      coalesce(v_default_loc.name, 'Asosiy ombor') as location_name,
      coalesce(v_default_loc.type, 'warehouse') as location_type,
      v_target_branch as branch_id,
      coalesce(v_default_loc.branch_name, 'Filial') as branch_name,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      0::numeric as on_hand,
      0::numeric as reserved,
      0::numeric as available,
      p.updated_at,
      p.created_at
    from public.products p
    where p.status <> 'archived'
      and (p_location_id is null or p_location_id = v_default_loc.id)
      and not exists (
        select 1
        from public.inventory_balances ib2
        join public.locations l2 on l2.id = ib2.location_id
        where ib2.product_id = p.id
          and (v_target_branch is null or l2.branch_id = v_target_branch)
      )
  ),
  filtered as (
    select c.*,
      (select m.public_url from public.product_media m where m.product_id = c.product_id order by m.is_primary desc, m.sort_order limit 1) as image
    from combined c
    where (p_query is null or c.product_name ilike '%'||btrim(p_query)||'%' or c.sku ilike '%'||btrim(p_query)||'%')
      and (p_category_id is null or c.category_id = p_category_id)
      and (p_min_price is null or c.retail_price >= p_min_price)
      and (p_max_price is null or c.retail_price <= p_max_price)
      and (p_availability is null
        or (p_availability in ('in_stock', 'available') and c.available > 0)
        or (p_availability in ('out_of_stock', 'empty') and c.available <= 0))
  ),
  with_image_filter as (
    select f.*
    from filtered f
    where (
      p_has_image is null or p_has_image = '' or p_has_image = 'all'
      or (p_has_image in ('with_image', 'true', 'has_image') and f.image is not null)
      or (p_has_image in ('without_image', 'false', 'no_image') and f.image is null)
    )
  ),
  aggregates as (
    select
      count(*)::bigint as cnt,
      coalesce(sum(on_hand), 0)::numeric as total_on_hand,
      coalesce(sum(reserved), 0)::numeric as total_reserved,
      coalesce(sum(on_hand * retail_price), 0)::numeric as total_value,
      coalesce(sum(on_hand * coalesce(cost_price, 0)), 0)::numeric as total_cost
    from with_image_filter
  ),
  paged as (
    select *
    from with_image_filter
    order by
      case when p_sort_by = 'image_first' then (case when image is not null then 0 else 1 end) end asc,
      case when p_sort_by = 'no_image_first' then (case when image is null then 0 else 1 end) end asc,
      case when p_sort_by = 'price_desc' then retail_price end desc,
      case when p_sort_by = 'price_asc' then retail_price end asc,
      case when p_sort_by = 'qty_desc' then available end desc,
      case when p_sort_by = 'qty_asc' then available end asc,
      case when p_sort_by = 'name_asc' then product_name end asc,
      created_at desc,
      product_name asc
    limit p_limit offset p_offset
  )
  select
    coalesce((select cnt from aggregates), 0),
    coalesce((select total_on_hand from aggregates), 0),
    coalesce((select total_reserved from aggregates), 0),
    coalesce((select total_value from aggregates), 0),
    coalesce((select total_cost from aggregates), 0),
    coalesce((select jsonb_agg(to_jsonb(p)) from paged p), '[]'::jsonb)
  into v_total, v_total_on_hand, v_total_reserved, v_total_value, v_total_cost, v_items;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_on_hand', v_total_on_hand,
    'total_reserved', v_total_reserved,
    'total_value', v_total_value,
    'total_cost', v_total_cost
  );
end;
$$;

GRANT EXECUTE ON FUNCTION public.list_inventory_balances(uuid, uuid, text, integer, integer, uuid, numeric, numeric, text, text, text) TO authenticated, service_role;


-- 2. get_low_stock_products RPC
CREATE OR REPLACE FUNCTION public.get_low_stock_products(
  p_branch_id uuid DEFAULT NULL,
  p_threshold integer DEFAULT 5,
  p_location_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_branch_id uuid := p_branch_id;
  v_items jsonb;
BEGIN
  IF v_branch_id IS NULL AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
    SELECT r.branch_id INTO v_branch_id
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid() AND r.role IN ('manager','accountant')
    LIMIT 1;
  END IF;

  WITH low_stock AS (
    SELECT
      ib.product_id,
      p.name AS product_name,
      p.sku,
      ib.location_id,
      l.name AS location_name,
      l.type AS location_type,
      ib.on_hand,
      ib.reserved,
      (ib.on_hand - ib.reserved) AS available,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      (SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = p.id AND pm.is_primary = true LIMIT 1) AS image,
      cat.name AS category_name
    FROM public.inventory_balances ib
    JOIN public.locations l ON l.id = ib.location_id
    JOIN public.products p ON p.id = ib.product_id
    LEFT JOIN public.categories cat ON cat.id = p.category_id
    WHERE (v_branch_id IS NULL OR l.branch_id = v_branch_id)
      AND (p_location_id IS NULL OR l.id = p_location_id)
      AND (ib.on_hand - ib.reserved) <= coalesce(p_threshold, 5)
      AND (ib.on_hand - ib.reserved) >= 0
      AND p.status <> 'archived'
    ORDER BY (ib.on_hand - ib.reserved) ASC, p.name ASC
    LIMIT greatest(least(coalesce(p_limit, 100), 500), 1)
  )
  SELECT coalesce(jsonb_agg(to_jsonb(ls)), '[]'::jsonb)
  INTO v_items
  FROM low_stock ls;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', jsonb_array_length(v_items),
    'threshold', coalesce(p_threshold, 5)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_low_stock_products(uuid, integer, uuid, integer) TO authenticated, service_role;


-- 3. get_product_sales_analytics RPC
CREATE OR REPLACE FUNCTION public.get_product_sales_analytics(
  p_branch_id uuid DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_branch_id uuid := p_branch_id;
  v_top_profit jsonb;
  v_top_sold jsonb;
  v_least_sold jsonb;
  v_from date := p_from;
  v_to date := p_to;
BEGIN
  IF v_branch_id IS NULL AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
    SELECT r.branch_id INTO v_branch_id
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid() AND r.role IN ('manager','accountant')
    LIMIT 1;
  END IF;

  -- Default date range: last 90 days if not specified
  IF v_from IS NULL THEN
    v_from := current_date - 90;
  END IF;
  IF v_to IS NULL THEN
    v_to := current_date;
  END IF;

  -- 1. Top profitable products
  WITH stats AS (
    SELECT
      sl.product_id,
      p.name AS product_name,
      p.sku,
      count(sl.id) AS sold_count,
      sum(sl.line_total) AS total_revenue,
      sum(sl.unit_cost) AS total_cost,
      sum(sl.line_total - coalesce(sl.tax, 0) - coalesce(sl.unit_cost, 0)) AS gross_profit,
      (SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = p.id AND pm.is_primary = true LIMIT 1) AS image,
      cat.name AS category_name
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.categories cat ON cat.id = p.category_id
    WHERE s.status <> 'void'
      AND (v_branch_id IS NULL OR s.branch_id = v_branch_id)
      AND s.sold_at >= public.business_day_start(v_from)
      AND s.sold_at < public.business_day_start(v_to + 1)
    GROUP BY sl.product_id, p.name, p.sku, cat.name, p.id
  )
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb)
  INTO v_top_profit
  FROM (
    SELECT * FROM stats
    ORDER BY gross_profit DESC
    LIMIT coalesce(p_limit, 50)
  ) sub;

  -- 2. Top sold products by quantity
  WITH stats AS (
    SELECT
      sl.product_id,
      p.name AS product_name,
      p.sku,
      count(sl.id) AS sold_count,
      sum(sl.line_total) AS total_revenue,
      sum(sl.unit_cost) AS total_cost,
      sum(sl.line_total - coalesce(sl.tax, 0) - coalesce(sl.unit_cost, 0)) AS gross_profit,
      (SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = p.id AND pm.is_primary = true LIMIT 1) AS image,
      cat.name AS category_name
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.categories cat ON cat.id = p.category_id
    WHERE s.status <> 'void'
      AND (v_branch_id IS NULL OR s.branch_id = v_branch_id)
      AND s.sold_at >= public.business_day_start(v_from)
      AND s.sold_at < public.business_day_start(v_to + 1)
    GROUP BY sl.product_id, p.name, p.sku, cat.name, p.id
  )
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb)
  INTO v_top_sold
  FROM (
    SELECT * FROM stats
    ORDER BY sold_count DESC, gross_profit DESC
    LIMIT coalesce(p_limit, 50)
  ) sub;

  -- 3. Least sold products
  WITH stats AS (
    SELECT
      sl.product_id,
      p.name AS product_name,
      p.sku,
      count(sl.id) AS sold_count,
      sum(sl.line_total) AS total_revenue,
      sum(sl.unit_cost) AS total_cost,
      sum(sl.line_total - coalesce(sl.tax, 0) - coalesce(sl.unit_cost, 0)) AS gross_profit,
      (SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = p.id AND pm.is_primary = true LIMIT 1) AS image,
      cat.name AS category_name
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.categories cat ON cat.id = p.category_id
    WHERE s.status <> 'void'
      AND (v_branch_id IS NULL OR s.branch_id = v_branch_id)
      AND s.sold_at >= public.business_day_start(v_from)
      AND s.sold_at < public.business_day_start(v_to + 1)
    GROUP BY sl.product_id, p.name, p.sku, cat.name, p.id
  )
  SELECT coalesce(jsonb_agg(sub), '[]'::jsonb)
  INTO v_least_sold
  FROM (
    SELECT * FROM stats
    ORDER BY sold_count ASC, gross_profit ASC
    LIMIT coalesce(p_limit, 50)
  ) sub;

  RETURN jsonb_build_object(
    'top_profit', v_top_profit,
    'top_sold', v_top_sold,
    'least_sold', v_least_sold,
    'from', v_from,
    'to', v_to
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_product_sales_analytics(uuid, date, date, integer) TO authenticated, service_role;
