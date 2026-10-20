-- Migration 20260978000000: Fix bulk_update_batch_prices and get_all_batch_prices_for_excel to strictly preserve minimum_sale_price = 0
-- Prevents minimum_sale_price from reverting to retail_price when 0 is entered or exported.

-- 1. Fix get_all_batch_prices_for_excel: never fall back to retail_price when minimum_sale_price is 0 or NULL
CREATE OR REPLACE FUNCTION public.get_all_batch_prices_for_excel(
  p_branch_id uuid DEFAULT NULL,
  p_currency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res jsonb;
  v_curr text;
BEGIN
  IF p_branch_id IS NOT NULL THEN
    PERFORM public.require_inventory_operator(p_branch_id);
  END IF;

  v_curr := NULLIF(upper(btrim(p_currency)), '');

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'batch_id', sb.id,
      'receipt_id', sr.id,
      'receipt_no', sr.receipt_no,
      'currency', sr.currency,
      'product_id', sb.product_id,
      'product_name', p.name,
      'sku', p.sku,
      'variant_id', sb.variant_id,
      'variant_color', sv.color_name,
      'quantity', sb.quantity,
      'unit_cost', coalesce(sb.unit_cost, p.cost_price, 0),
      'unit_cost_usd', coalesce(sb.unit_cost_usd, p.cost_price_usd, 0),
      'retail_price', coalesce(sb.retail_price, p.retail_price, 0),
      'retail_price_usd', coalesce(sb.retail_price_usd, p.retail_price_usd, 0),
      'wholesale_price', coalesce(sb.wholesale_price, p.wholesale_price, 0),
      'wholesale_price_usd', coalesce(sb.wholesale_price_usd, p.wholesale_price_usd, 0),
      'minimum_sale_price', coalesce(sb.minimum_sale_price, p.minimum_sale_price, 0),
      'minimum_sale_price_usd', coalesce(sb.minimum_sale_price_usd, p.minimum_sale_price_usd, 0),
      'qr_code', coalesce((SELECT iu.qr_code FROM public.inventory_units iu WHERE iu.batch_id = sb.id LIMIT 1), '')
    )
    ORDER BY sr.created_at DESC, sb.line_no ASC
  ), '[]'::jsonb)
  INTO v_res
  FROM public.stock_batches sb
  JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
  JOIN public.products p ON p.id = sb.product_id
  LEFT JOIN public.product_variants sv ON sv.id = sb.variant_id
  WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
    AND (v_curr IS NULL OR sr.currency = v_curr);

  RETURN v_res;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_all_batch_prices_for_excel(uuid, text) TO authenticated, service_role;


-- 2. Fix bulk_update_batch_prices: preserve minimum_sale_price = 0 (do NOT use nullif(v_min, 0))
CREATE OR REPLACE FUNCTION public.bulk_update_batch_prices(
  p_branch_id uuid DEFAULT NULL,
  p_currency text DEFAULT 'UZS',
  p_items jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rate numeric;
  v_updated_batches integer := 0;
  v_updated_products integer := 0;
  v_updated_variants integer := 0;
  v_not_found jsonb := '[]'::jsonb;
  v_seen_products uuid[] := '{}';
  v_seen_variants uuid[] := '{}';
  v_affected_receipts uuid[] := '{}';

  v_item jsonb;
  v_receipt_no text;
  v_qr_code text;
  v_prod_name text;
  v_curr text;

  v_batch_id uuid;
  v_batch_rec record;

  v_raw_cost numeric;
  v_raw_retail numeric;
  v_raw_wholesale numeric;
  v_raw_min numeric;

  v_cost_uzs numeric;
  v_cost_usd numeric;
  v_retail_uzs numeric;
  v_retail_usd numeric;
  v_wholesale_uzs numeric;
  v_wholesale_usd numeric;
  v_min_uzs numeric;
  v_min_usd numeric;
BEGIN
  IF current_user <> 'postgres' 
     AND coalesce(current_setting('role', true), '') <> 'service_role'
     AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Narxlarni yangilash uchun ruxsat berilmagan' USING errcode = '42501';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'updated_batches', 0, 'not_found_count', 0);
  END IF;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_receipt_no := nullif(btrim(v_item->>'receipt_no'), '');
    v_qr_code := nullif(btrim(v_item->>'qr_code'), '');
    v_prod_name := nullif(btrim(v_item->>'product_name'), '');

    v_batch_id := NULL;

    -- Match 1 (Primary): qr_code alone via inventory_units (Partiya umumiy kodi)
    IF v_qr_code IS NOT NULL THEN
      SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
      INTO v_batch_rec
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      JOIN public.inventory_units iu ON iu.batch_id = sb.id
      WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND upper(btrim(iu.qr_code)) = upper(v_qr_code)
      LIMIT 1;

      IF NOT FOUND THEN
        SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
        INTO v_batch_rec
        FROM public.stock_batches sb
        JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
        JOIN public.inventory_units iu ON iu.batch_id = sb.id
        WHERE upper(btrim(iu.qr_code)) = upper(v_qr_code)
        LIMIT 1;
      END IF;

      IF FOUND THEN
        v_batch_id := v_batch_rec.id;
      END IF;
    END IF;

    -- Match 2 (Fallback): receipt_no and qr_code
    IF v_batch_id IS NULL AND v_qr_code IS NOT NULL AND v_receipt_no IS NOT NULL THEN
      SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
      INTO v_batch_rec
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      JOIN public.inventory_units iu ON iu.batch_id = sb.id
      WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND upper(btrim(iu.qr_code)) = upper(v_qr_code)
        AND upper(btrim(sr.receipt_no)) = upper(v_receipt_no)
      LIMIT 1;

      IF FOUND THEN
        v_batch_id := v_batch_rec.id;
      END IF;
    END IF;

    -- Match 3 (Fallback): receipt_no and product name
    IF v_batch_id IS NULL AND v_receipt_no IS NOT NULL AND v_prod_name IS NOT NULL THEN
      SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
      INTO v_batch_rec
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      JOIN public.products p ON p.id = sb.product_id
      WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND upper(btrim(sr.receipt_no)) = upper(v_receipt_no)
        AND (
          upper(btrim(p.name)) = upper(v_prod_name)
          OR upper(v_prod_name) LIKE '%' || upper(btrim(p.name)) || '%'
          OR upper(btrim(p.name)) LIKE '%' || upper(v_prod_name) || '%'
        )
      LIMIT 1;

      IF FOUND THEN
        v_batch_id := v_batch_rec.id;
      END IF;
    END IF;

    -- If not found, add to not_found array
    IF v_batch_id IS NULL THEN
      v_not_found := v_not_found || jsonb_build_object(
        'receipt_no', coalesce(v_receipt_no, ''),
        'qr_code', coalesce(v_qr_code, ''),
        'product_name', coalesce(v_prod_name, '')
      );
      CONTINUE;
    END IF;

    -- Currency: check item-level currency, then fallback to p_currency, default to 'UZS'
    v_curr := upper(coalesce(nullif(btrim(v_item->>'currency'), ''), p_currency, 'UZS'));
    IF v_curr NOT IN ('UZS', 'USD') THEN
      v_curr := 'UZS';
    END IF;

    v_raw_cost := (v_item->>'unit_cost')::numeric;
    v_raw_retail := (v_item->>'retail_price')::numeric;
    v_raw_wholesale := nullif(v_item->>'wholesale_price', '')::numeric;
    v_raw_min := nullif(v_item->>'minimum_sale_price', '')::numeric;

    IF v_curr = 'UZS' THEN
      v_cost_uzs := round(coalesce(v_raw_cost, 0));
      v_cost_usd := CASE WHEN v_cost_uzs > 0 AND v_rate > 0 THEN round(v_cost_uzs / v_rate, 2) ELSE 0 END;

      v_retail_uzs := round(coalesce(v_raw_retail, 0));
      v_retail_usd := CASE WHEN v_retail_uzs > 0 AND v_rate > 0 THEN round(v_retail_uzs / v_rate, 2) ELSE 0 END;

      v_wholesale_uzs := CASE WHEN v_raw_wholesale IS NOT NULL AND v_raw_wholesale > 0 THEN round(v_raw_wholesale) ELSE 0 END;
      v_wholesale_usd := CASE WHEN v_wholesale_uzs > 0 AND v_rate > 0 THEN round(v_wholesale_uzs / v_rate, 2) ELSE 0 END;

      -- If v_raw_min is provided (even if 0), preserve it strictly!
      v_min_uzs := CASE WHEN v_raw_min IS NOT NULL AND v_raw_min >= 0 THEN round(v_raw_min) ELSE 0 END;
      v_min_usd := CASE WHEN v_min_uzs > 0 AND v_rate > 0 THEN round(v_min_uzs / v_rate, 2) ELSE 0 END;
    ELSE
      -- USD
      v_cost_usd := round(coalesce(v_raw_cost, 0), 2);
      v_cost_uzs := round(v_cost_usd * v_rate);

      v_retail_usd := round(coalesce(v_raw_retail, 0), 2);
      v_retail_uzs := round(v_retail_usd * v_rate);

      v_wholesale_usd := CASE WHEN v_raw_wholesale IS NOT NULL AND v_raw_wholesale > 0 THEN round(v_raw_wholesale, 2) ELSE 0 END;
      v_wholesale_uzs := round(v_wholesale_usd * v_rate);

      -- If v_raw_min is provided (even if 0), preserve it strictly!
      v_min_usd := CASE WHEN v_raw_min IS NOT NULL AND v_raw_min >= 0 THEN round(v_raw_min, 2) ELSE 0 END;
      v_min_uzs := round(v_min_usd * v_rate);
    END IF;

    -- Update stock_batches: do NOT replace 0 with retail_price!
    UPDATE public.stock_batches
    SET unit_cost = v_cost_uzs,
        unit_cost_usd = v_cost_usd,
        retail_price = v_retail_uzs,
        retail_price_usd = v_retail_usd,
        wholesale_price = v_wholesale_uzs,
        wholesale_price_usd = v_wholesale_usd,
        minimum_sale_price = CASE 
          WHEN v_raw_min IS NOT NULL THEN v_min_uzs 
          ELSE coalesce(minimum_sale_price, 0) 
        END,
        minimum_sale_price_usd = CASE 
          WHEN v_raw_min IS NOT NULL THEN v_min_usd 
          ELSE coalesce(minimum_sale_price_usd, 0) 
        END,
        currency = v_curr
    WHERE id = v_batch_rec.id;

    v_updated_batches := v_updated_batches + 1;

    -- Update products: strictly observe products_minimum_sale_price_chk (0 <= minimum <= retail)
    UPDATE public.products
    SET cost_price = v_cost_uzs,
        cost_price_usd = v_cost_usd,
        retail_price = v_retail_uzs,
        retail_price_usd = v_retail_usd,
        wholesale_price = v_wholesale_uzs,
        wholesale_price_usd = v_wholesale_usd,
        minimum_sale_price = CASE 
          WHEN v_raw_min IS NOT NULL THEN 
            CASE WHEN v_retail_uzs > 0 THEN LEAST(v_min_uzs, v_retail_uzs) ELSE 0 END
          ELSE coalesce(minimum_sale_price, 0) 
        END,
        minimum_sale_price_usd = CASE 
          WHEN v_raw_min IS NOT NULL THEN 
            CASE WHEN v_retail_usd > 0 THEN LEAST(v_min_usd, v_retail_usd) ELSE 0 END
          ELSE coalesce(minimum_sale_price_usd, 0) 
        END,
        currency = v_curr,
        updated_at = now()
    WHERE id = v_batch_rec.product_id;

    IF NOT (v_batch_rec.product_id = ANY(v_seen_products)) THEN
      v_seen_products := array_append(v_seen_products, v_batch_rec.product_id);
      v_updated_products := v_updated_products + 1;
    END IF;

    -- Update product_variants if variant_id is present
    IF v_batch_rec.variant_id IS NOT NULL THEN
      UPDATE public.product_variants
      SET cost_price = v_cost_uzs,
          cost_price_usd = v_cost_usd,
          retail_price = v_retail_uzs,
          retail_price_usd = v_retail_usd,
          wholesale_price = v_wholesale_uzs,
          wholesale_price_usd = v_wholesale_usd,
          minimum_sale_price = CASE 
            WHEN v_raw_min IS NOT NULL THEN 
              CASE WHEN v_retail_uzs > 0 THEN LEAST(v_min_uzs, v_retail_uzs) ELSE 0 END
            ELSE coalesce(minimum_sale_price, 0) 
          END,
          minimum_sale_price_usd = CASE 
            WHEN v_raw_min IS NOT NULL THEN 
              CASE WHEN v_retail_usd > 0 THEN LEAST(v_min_usd, v_retail_usd) ELSE 0 END
            ELSE coalesce(minimum_sale_price_usd, 0) 
          END,
          updated_at = now()
      WHERE id = v_batch_rec.variant_id;

      IF NOT (v_batch_rec.variant_id = ANY(v_seen_variants)) THEN
        v_seen_variants := array_append(v_seen_variants, v_batch_rec.variant_id);
        v_updated_variants := v_updated_variants + 1;
      END IF;
    END IF;

    -- Track affected receipt
    IF v_batch_rec.receipt_id IS NOT NULL AND NOT (v_batch_rec.receipt_id = ANY(v_affected_receipts)) THEN
      v_affected_receipts := array_append(v_affected_receipts, v_batch_rec.receipt_id);
    END IF;
  END LOOP;

  -- 4. If any receipts had currency matching the updated items, sync the receipt-level currency
  IF array_length(v_affected_receipts, 1) > 0 THEN
    UPDATE public.stock_receipts
    SET currency = p_currency
    WHERE id = ANY(v_affected_receipts)
      AND (currency IS NULL OR currency <> p_currency);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'rate', v_rate,
    'currency', p_currency,
    'updated_batches', v_updated_batches,
    'updated_products', v_updated_products,
    'updated_variants', v_updated_variants,
    'not_found_count', jsonb_array_length(v_not_found),
    'not_found', v_not_found
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_batch_prices(uuid, text, jsonb) TO authenticated, service_role, anon;


-- 3. Fix list_stock_receipts to include minimum_sale_price_usd and not fall back to retail_price
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
  v_is_global_admin boolean;
  v_allowed_branch_ids uuid[];
BEGIN
  IF p_limit NOT BETWEEN 1 AND 2000 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto''g''ri';
  END IF;

  v_is_global_admin := (
    current_user = 'postgres'
    OR coalesce(current_setting('role', true), '') = 'service_role'
    OR public.has_role(array['superadmin','admin']::public.app_role[], null)
  );

  IF NOT v_is_global_admin THEN
    SELECT coalesce(array_agg(branch_id), '{}')
    INTO v_allowed_branch_ids
    FROM public.branch_members
    WHERE user_id = auth.uid() AND is_active = true;
  END IF;

  -- QR URL tozalash
  v_clean_query := btrim(coalesce(p_query, ''));
  IF v_clean_query LIKE '%/qr/%' THEN
    v_clean_query := split_part(split_part(split_part(v_clean_query, '/qr/', 2), '?', 1), '&', 1);
  END IF;
  IF v_clean_query = '' THEN
    v_clean_query := NULL;
  END IF;

  -- 1. Filialdagi barcha partiya va inventarizatsiya sanalari
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

  -- 2. Matched receipts and aggregations
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
      coalesce(sum(b.quantity * coalesce(b.minimum_sale_price, p.minimum_sale_price, 0)), 0) AS min_price,
      coalesce(sum(b.quantity * coalesce(b.retail_price, p.retail_price, 0)), 0) AS retail_price
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

  -- 3. Items list with pagination
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      r.id, r.receipt_no, r.branch_id, br.name AS branch_name,
      r.supplier_id, coalesce(s.name, CASE WHEN r.receipt_no LIKE 'INV-%' THEN 'Inventarizatsiya' ELSE 'Ta’minotchi ko‘rsatilmagan' END) AS supplier_name,
      r.receiving_location_id, l.name AS location_name, l.type AS location_type,
      r.invoice_number, r.currency, r.payment_status, r.received_at, r.created_at,
      count(b.id) AS line_count,
      coalesce(sum(b.quantity), 0) AS unit_count,
      coalesce(sum(b.quantity * CASE WHEN b.unit_cost > 0 THEN b.unit_cost ELSE coalesce(p.cost_price, 0) END), 0) AS total_cost,
      coalesce(sum(b.quantity * coalesce(b.retail_price, p.retail_price, 0)), 0) AS total_retail,
      coalesce(sum(b.quantity * coalesce(b.minimum_sale_price, p.minimum_sale_price, 0)), 0) AS total_min_price,
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
          'retail_price_usd', coalesce(sb.retail_price_usd, sp.retail_price_usd, 0),
          'wholesale_price', coalesce(sb.wholesale_price, sp.wholesale_price, 0),
          'wholesale_price_usd', coalesce(sb.wholesale_price_usd, sp.wholesale_price_usd, 0),
          'minimum_sale_price', coalesce(sb.minimum_sale_price, sp.minimum_sale_price, 0),
          'minimum_sale_price_usd', coalesce(sb.minimum_sale_price_usd, sp.minimum_sale_price_usd, 0),
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
    FROM public.stock_receipts r
    JOIN public.branches br ON br.id = r.branch_id
    LEFT JOIN public.suppliers s ON s.id = r.supplier_id
    JOIN public.locations l ON l.id = r.receiving_location_id
    LEFT JOIN public.stock_batches b ON b.receipt_id = r.id
    LEFT JOIN public.products p ON p.id = b.product_id
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
    'inv_count', v_inv_count,
    'batch_dates', v_batch_dates
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_stock_receipts(uuid, text, integer, integer, uuid, text) TO authenticated, service_role, anon;
