-- Migration: 20260963090000_receipts_full_aggregates.sql
-- Return total_units, total_cost, total_min_price, batch_count, inv_count in list_stock_receipts
-- so that pagination does not truncate summary totals.

CREATE OR REPLACE FUNCTION public.list_stock_receipts(
  p_branch_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_location_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_total_units bigint := 0;
  v_total_cost numeric := 0;
  v_total_min_price numeric := 0;
  v_total_retail numeric := 0;
  v_batch_count bigint := 0;
  v_inv_count bigint := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto''g''ri';
  END IF;

  -- 1. Full aggregation across ALL matching receipts
  WITH matched_receipts AS (
    SELECT r.id, r.receipt_no
    FROM public.stock_receipts r
    WHERE public.can_access_branch(r.branch_id)
      AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)
      AND (p_location_id IS NULL OR r.receiving_location_id = p_location_id)
      AND (
        p_query IS NULL
        OR r.receipt_no ILIKE '%' || btrim(p_query) || '%'
        OR coalesce(r.invoice_number, '') ILIKE '%' || btrim(p_query) || '%'
        OR EXISTS (
          SELECT 1 FROM public.suppliers sup
          WHERE sup.id = r.supplier_id AND sup.name ILIKE '%' || btrim(p_query) || '%'
        )
        OR EXISTS (
          SELECT 1 FROM public.stock_batches sb_q
          JOIN public.products sp_q ON sp_q.id = sb_q.product_id
          LEFT JOIN public.product_variants sv_q ON sv_q.id = sb_q.variant_id
          WHERE sb_q.receipt_id = r.id
            AND (
              sp_q.name ILIKE '%' || btrim(p_query) || '%'
              OR coalesce(sp_q.sku, '') ILIKE '%' || btrim(p_query) || '%'
              OR coalesce(sv_q.color_name, '') ILIKE '%' || btrim(p_query) || '%'
              OR (sp_q.name || ' ' || coalesce(sv_q.color_name, '')) ILIKE '%' || btrim(p_query) || '%'
            )
        )
      )
  ),
  receipt_sums AS (
    SELECT
      mr.id,
      mr.receipt_no,
      coalesce(sum(b.quantity), 0) AS units,
      coalesce(sum(b.quantity * CASE WHEN b.unit_cost > 0 THEN b.unit_cost ELSE coalesce(p.cost_price, 0) END), 0) AS cost,
      coalesce(sum(b.quantity * coalesce(p.minimum_sale_price, p.retail_price, 0)), 0) AS min_price,
      coalesce(sum(b.quantity * coalesce(p.retail_price, 0)), 0) AS retail_price
    FROM matched_receipts mr
    LEFT JOIN public.stock_batches b ON b.receipt_id = mr.id
    LEFT JOIN public.products p ON p.id = b.product_id
    GROUP BY mr.id, mr.receipt_no
  )
  SELECT
    count(*),
    coalesce(sum(units), 0),
    coalesce(sum(cost), 0),
    coalesce(sum(min_price), 0),
    coalesce(sum(retail_price), 0),
    count(*) FILTER (WHERE receipt_no NOT LIKE 'INV-%'),
    count(*) FILTER (WHERE receipt_no LIKE 'INV-%')
  INTO
    v_total,
    v_total_units,
    v_total_cost,
    v_total_min_price,
    v_total_retail,
    v_batch_count,
    v_inv_count
  FROM receipt_sums;

  -- 2. Paged items
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.receipt_no DESC), '[]'::jsonb) INTO v_items FROM (
    SELECT
      r.id, r.receipt_no, r.branch_id, br.name AS branch_name,
      r.supplier_id, coalesce(s.name, CASE WHEN r.receipt_no LIKE 'INV-%' THEN 'Inventarizatsiya' ELSE 'Ta’minotchi ko‘rsatilmagan' END) AS supplier_name,
      r.receiving_location_id, l.name AS location_name, l.type AS location_type,
      r.invoice_number, r.currency, r.payment_status, r.received_at, r.created_at,
      count(b.id) AS line_count,
      coalesce(sum(b.quantity), 0) AS unit_count,
      coalesce(sum(b.quantity * CASE WHEN b.unit_cost > 0 THEN b.unit_cost ELSE coalesce(p.cost_price, 0) END), 0) AS total_cost,
      coalesce(sum(b.quantity * coalesce(p.retail_price, 0)), 0) AS total_retail,
      coalesce(sum(b.quantity * coalesce(p.minimum_sale_price, p.retail_price, 0)), 0) AS total_min_price,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'batch_id', sb.id,
          'product_id', sb.product_id,
          'product_name', sp.name,
          'sku', sp.sku,
          'variant_id', sb.variant_id,
          'variant_color', sv.color_name,
          'quantity', sb.quantity,
          'unit_cost', sb.unit_cost,
          'unit_cost_usd', coalesce(sb.unit_cost_usd, sp.cost_price_usd),
          'image_url', coalesce((SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = sp.id ORDER BY pm.is_primary DESC, pm.sort_order ASC LIMIT 1), sp.seo_image_url)
        ) ORDER BY sb.line_no)
        FROM public.stock_batches sb
        JOIN public.products sp ON sp.id = sb.product_id
        LEFT JOIN public.product_variants sv ON sv.id = sb.variant_id
        WHERE sb.receipt_id = r.id
      ), '[]'::jsonb) AS items
    FROM public.stock_receipts r
    JOIN public.branches br ON br.id = r.branch_id
    LEFT JOIN public.suppliers s ON s.id = r.supplier_id
    JOIN public.locations l ON l.id = r.receiving_location_id
    LEFT JOIN public.stock_batches b ON b.receipt_id = r.id
    LEFT JOIN public.products p ON p.id = b.product_id
    WHERE public.can_access_branch(r.branch_id)
      AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)
      AND (p_location_id IS NULL OR r.receiving_location_id = p_location_id)
      AND (
        p_query IS NULL
        OR r.receipt_no ILIKE '%' || btrim(p_query) || '%'
        OR coalesce(r.invoice_number, '') ILIKE '%' || btrim(p_query) || '%'
        OR EXISTS (
          SELECT 1 FROM public.suppliers sup
          WHERE sup.id = r.supplier_id AND sup.name ILIKE '%' || btrim(p_query) || '%'
        )
        OR EXISTS (
          SELECT 1 FROM public.stock_batches sb_q
          JOIN public.products sp_q ON sp_q.id = sb_q.product_id
          LEFT JOIN public.product_variants sv_q ON sv_q.id = sb_q.variant_id
          WHERE sb_q.receipt_id = r.id
            AND (
              sp_q.name ILIKE '%' || btrim(p_query) || '%'
              OR coalesce(sp_q.sku, '') ILIKE '%' || btrim(p_query) || '%'
              OR coalesce(sv_q.color_name, '') ILIKE '%' || btrim(p_query) || '%'
              OR (sp_q.name || ' ' || coalesce(sv_q.color_name, '')) ILIKE '%' || btrim(p_query) || '%'
            )
        )
      )
    GROUP BY r.id, br.name, s.name, l.name, l.type
    ORDER BY r.created_at DESC, r.receipt_no DESC
    LIMIT p_limit OFFSET p_offset
  ) x;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_units', v_total_units,
    'total_cost', v_total_cost,
    'total_min_price', v_total_min_price,
    'total_retail', v_total_retail,
    'batch_count', v_batch_count,
    'inv_count', v_inv_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_stock_receipts(uuid, text, integer, integer, uuid) TO authenticated, service_role;
