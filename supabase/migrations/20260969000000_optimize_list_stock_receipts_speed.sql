-- Migration: 20260969000000_optimize_list_stock_receipts_speed.sql
-- Optimizes list_stock_receipts to prevent statement timeout during search.
-- 1. Evaluates user branch permissions once at function startup instead of per-row on all historical receipts.
-- 2. Optimizes pagination so items subqueries only run for the paginated page limit.
-- 3. Adds supporting indexes on stock_batches and stock_receipts.

CREATE INDEX IF NOT EXISTS stock_batches_receipt_id_idx ON public.stock_batches(receipt_id);
CREATE INDEX IF NOT EXISTS stock_receipts_location_id_idx ON public.stock_receipts(receiving_location_id);

CREATE OR REPLACE FUNCTION public.list_stock_receipts(
  p_branch_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 500,
  p_offset integer DEFAULT 0,
  p_location_id uuid DEFAULT NULL,
  p_date text DEFAULT NULL
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
  v_batch_dates jsonb;
  v_clean_query text;
  v_is_global_admin boolean := false;
  v_allowed_branch_ids uuid[];
BEGIN
  IF p_limit NOT BETWEEN 1 AND 2000 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto''g''ri';
  END IF;

  -- 1. Security & Branch Access Scope (evaluated ONCE at start, NOT per row!)
  v_is_global_admin := public.has_role(array['superadmin','admin']::public.app_role[], null);

  IF NOT v_is_global_admin THEN
    SELECT array_agg(DISTINCT r.branch_id)
    INTO v_allowed_branch_ids
    FROM public.profile_roles r
    WHERE r.profile_id = auth.uid()
      AND r.role = ANY(array['manager','seller','warehouse','accountant']::public.app_role[])
      AND r.branch_id IS NOT NULL;

    IF v_allowed_branch_ids IS NULL OR array_length(v_allowed_branch_ids, 1) = 0 THEN
      RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
    END IF;

    IF p_branch_id IS NOT NULL AND NOT (p_branch_id = ANY(v_allowed_branch_ids)) THEN
      RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
    END IF;
  END IF;

  -- QR URL tozalash
  v_clean_query := btrim(coalesce(p_query, ''));
  IF v_clean_query LIKE '%/qr/%' THEN
    v_clean_query := split_part(split_part(split_part(v_clean_query, '/qr/', 2), '?', 1), '&', 1);
  END IF;
  IF v_clean_query = '' THEN
    v_clean_query := NULL;
  END IF;

  -- 2. Filialdagi barcha partiya va inventarizatsiya sanalari (kalendar uchun)
  SELECT coalesce(jsonb_agg(d.day_str ORDER BY d.day_str DESC), '[]'::jsonb)
  INTO v_batch_dates
  FROM (
    SELECT DISTINCT to_char(r.received_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day_str
    FROM public.stock_receipts r
    WHERE (v_is_global_admin OR r.branch_id = ANY(v_allowed_branch_ids))
      AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)
      AND (p_location_id IS NULL OR r.receiving_location_id = p_location_id)
      AND r.received_at IS NOT NULL
  ) d;

  -- 3. Matched receipts and aggregations
  WITH matched_receipts AS (
    SELECT r.id, r.receipt_no, r.created_at
    FROM public.stock_receipts r
    WHERE (v_is_global_admin OR r.branch_id = ANY(v_allowed_branch_ids))
      AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)
      AND (p_location_id IS NULL OR r.receiving_location_id = p_location_id)
      AND (
        p_date IS NULL
        OR btrim(p_date) = ''
        OR to_char(r.received_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') = btrim(p_date)
        OR to_char(r.received_at, 'YYYY-MM-DD') = btrim(p_date)
        OR to_char(r.created_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') = btrim(p_date)
      )
      AND (
        v_clean_query IS NULL
        OR r.receipt_no ILIKE '%' || v_clean_query || '%'
        OR coalesce(r.invoice_number, '') ILIKE '%' || v_clean_query || '%'
        OR EXISTS (
          SELECT 1 FROM public.suppliers sup
          WHERE sup.id = r.supplier_id AND sup.name ILIKE '%' || v_clean_query || '%'
        )
        OR EXISTS (
          SELECT 1 FROM public.stock_batches sb_q
          JOIN public.products sp_q ON sp_q.id = sb_q.product_id
          LEFT JOIN public.product_variants sv_q ON sv_q.id = sb_q.variant_id
          WHERE sb_q.receipt_id = r.id
            AND (
              sp_q.name ILIKE '%' || v_clean_query || '%'
              OR coalesce(sp_q.sku, '') ILIKE '%' || v_clean_query || '%'
              OR coalesce(sv_q.color_name, '') ILIKE '%' || v_clean_query || '%'
              OR (sp_q.name || ' ' || coalesce(sv_q.color_name, '')) ILIKE '%' || v_clean_query || '%'
              OR coalesce(sb_q.reference, '') ILIKE '%' || v_clean_query || '%'
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.stock_batches sb_qr
          JOIN public.inventory_units iu_qr ON iu_qr.batch_id = sb_qr.id
          WHERE sb_qr.receipt_id = r.id
            AND (
              upper(iu_qr.qr_code) = upper(v_clean_query)
              OR iu_qr.qr_code ILIKE '%' || v_clean_query || '%'
              OR upper(coalesce(iu_qr.serial_number, '')) = upper(v_clean_query)
              OR coalesce(iu_qr.serial_number, '') ILIKE '%' || v_clean_query || '%'
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

  -- 4. Paged items: ONLY for matched receipts (no re-evaluating the entire search filter!)
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.receipt_no DESC), '[]'::jsonb) INTO v_items FROM (
    WITH matched_receipts AS (
      SELECT r.id, r.receipt_no, r.created_at
      FROM public.stock_receipts r
      WHERE (v_is_global_admin OR r.branch_id = ANY(v_allowed_branch_ids))
        AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)
        AND (p_location_id IS NULL OR r.receiving_location_id = p_location_id)
        AND (
          p_date IS NULL
          OR btrim(p_date) = ''
          OR to_char(r.received_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') = btrim(p_date)
          OR to_char(r.received_at, 'YYYY-MM-DD') = btrim(p_date)
          OR to_char(r.created_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') = btrim(p_date)
        )
        AND (
          v_clean_query IS NULL
          OR r.receipt_no ILIKE '%' || v_clean_query || '%'
          OR coalesce(r.invoice_number, '') ILIKE '%' || v_clean_query || '%'
          OR EXISTS (
            SELECT 1 FROM public.suppliers sup
            WHERE sup.id = r.supplier_id AND sup.name ILIKE '%' || v_clean_query || '%'
          )
          OR EXISTS (
            SELECT 1 FROM public.stock_batches sb_q
            JOIN public.products sp_q ON sp_q.id = sb_q.product_id
            LEFT JOIN public.product_variants sv_q ON sv_q.id = sb_q.variant_id
            WHERE sb_q.receipt_id = r.id
              AND (
                sp_q.name ILIKE '%' || v_clean_query || '%'
                OR coalesce(sp_q.sku, '') ILIKE '%' || v_clean_query || '%'
                OR coalesce(sv_q.color_name, '') ILIKE '%' || v_clean_query || '%'
                OR (sp_q.name || ' ' || coalesce(sv_q.color_name, '')) ILIKE '%' || v_clean_query || '%'
                OR coalesce(sb_q.reference, '') ILIKE '%' || v_clean_query || '%'
              )
          )
          OR EXISTS (
            SELECT 1 FROM public.stock_batches sb_qr
            JOIN public.inventory_units iu_qr ON iu_qr.batch_id = sb_qr.id
            WHERE sb_qr.receipt_id = r.id
              AND (
                upper(iu_qr.qr_code) = upper(v_clean_query)
                OR iu_qr.qr_code ILIKE '%' || v_clean_query || '%'
                OR upper(coalesce(iu_qr.serial_number, '')) = upper(v_clean_query)
                OR coalesce(iu_qr.serial_number, '') ILIKE '%' || v_clean_query || '%'
              )
          )
        )
    )
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
          'category_name', coalesce(cat.name, '—'),
          'brand_name', coalesce(b_brand.name, '—'),
          'variant_id', sb.variant_id,
          'variant_color', sv.color_name,
          'quantity', sb.quantity,
          'unit_cost', CASE WHEN sb.unit_cost > 0 THEN sb.unit_cost ELSE coalesce(sp.cost_price, 0) END,
          'unit_cost_usd', coalesce(sb.unit_cost_usd, sp.cost_price_usd),
          'retail_price', coalesce(sb.retail_price, sp.retail_price, 0),
          'wholesale_price', coalesce(sb.wholesale_price, sp.wholesale_price, 0),
          'minimum_sale_price', coalesce(sp.minimum_sale_price, sp.retail_price, 0),
          'qr_code', (SELECT iu_one.qr_code FROM public.inventory_units iu_one WHERE iu_one.batch_id = sb.id LIMIT 1),
          'image_url', coalesce((SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = sp.id ORDER BY pm.is_primary DESC, pm.sort_order ASC LIMIT 1), sp.seo_image_url)
        ) ORDER BY sb.line_no)
        FROM public.stock_batches sb
        JOIN public.products sp ON sp.id = sb.product_id
        LEFT JOIN public.categories cat ON cat.id = sp.category_id
        LEFT JOIN public.brands b_brand ON b_brand.id = sp.brand_id
        LEFT JOIN public.product_variants sv ON sv.id = sb.variant_id
        WHERE sb.receipt_id = r.id
      ), '[]'::jsonb) AS items
    FROM (
      SELECT mr.id
      FROM matched_receipts mr
      ORDER BY mr.created_at DESC, mr.receipt_no DESC
      LIMIT p_limit OFFSET p_offset
    ) paged_mr
    JOIN public.stock_receipts r ON r.id = paged_mr.id
    JOIN public.branches br ON br.id = r.branch_id
    LEFT JOIN public.suppliers s ON s.id = r.supplier_id
    JOIN public.locations l ON l.id = r.receiving_location_id
    LEFT JOIN public.stock_batches b ON b.receipt_id = r.id
    LEFT JOIN public.products p ON p.id = b.product_id
    GROUP BY r.id, br.name, s.name, l.name, l.type
    ORDER BY r.created_at DESC, r.receipt_no DESC
  ) x;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_units', v_total_units,
    'total_cost', v_total_cost,
    'total_min_price', v_total_min_price,
    'total_retail', v_total_retail,
    'batch_count', v_batch_count,
    'inv_count', v_inv_count,
    'batch_dates', v_batch_dates
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_stock_receipts(uuid, text, integer, integer, uuid, text) TO authenticated, service_role;
