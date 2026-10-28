-- 20260993000000_sales_history_seller_fallback_date.sql
-- Update list_sales_history so that when seller_id is passed without date range,
-- it searches back 180 days (same as p_query) instead of locking to current_date.

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
    IF (p_query IS NOT NULL AND btrim(p_query) <> '') OR p_seller_id IS NOT NULL THEN
      -- If query or seller is specified without dates, search back 180 days
      v_from := current_date - 180;
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
