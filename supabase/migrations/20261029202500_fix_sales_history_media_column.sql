-- Migration: Fix column pm.url does not exist by referencing pm.public_url in get_seller_today_sales_kpi and list_sales_history
-- Date: 2026-10-29

-- 1. Update get_seller_today_sales_kpi
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
            'primary_media_url', coalesce(
              (
                SELECT pm.public_url
                FROM public.product_media pm
                WHERE pm.variant_id = u.variant_id
                ORDER BY pm.is_primary DESC NULLS LAST, pm.sort_order ASC, pm.created_at ASC
                LIMIT 1
              ),
              (
                SELECT pm.public_url
                FROM public.product_media pm
                WHERE pm.product_id = p.id
                ORDER BY pm.is_primary DESC NULLS LAST, pm.sort_order ASC, pm.created_at ASC
                LIMIT 1
              )
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

-- 2. Update list_sales_history
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
      coalesce(
        (
          SELECT pm.public_url
          FROM public.product_media pm
          WHERE pm.variant_id = u.variant_id
          ORDER BY pm.is_primary DESC NULLS LAST, pm.sort_order ASC, pm.created_at ASC
          LIMIT 1
        ),
        (
          SELECT pm.public_url
          FROM public.product_media pm
          WHERE pm.product_id = p.id
          ORDER BY pm.is_primary DESC NULLS LAST, pm.sort_order ASC, pm.created_at ASC
          LIMIT 1
        )
      ) AS primary_media_url,
      u.qr_code,
      u.serial_number,
      u.variant_id,
      pv.color_name AS variant_color,
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
