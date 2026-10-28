-- ==============================================================================
-- Migration: 20261025000000_smart_fuzzy_and_normalized_product_search.sql
-- Description:
-- 1. Enable pg_trgm extension for typo-tolerant fuzzy matching.
-- 2. Create public.normalize_search_text(text) helper to ignore hyphens, spaces, etc.
-- 3. Update public.list_inventory_balances with 3-tier smart search:
--    - Tier 1: Exact / substring match
--    - Tier 2: Normalized alphanumeric match (e.g. 'mg001' or 'mg 001' -> 'mg-001')
--    - Tier 3: Fuzzy similarity match (e.g. 'mg01' -> 'mg-001')
--    Returns match_rank, match_similarity, is_fuzzy, has_fuzzy_only, suggested_name.
-- 4. Update public.list_pos_units with normalized & fuzzy product search for POS scanner.
-- ==============================================================================

BEGIN;

-- 1. ENABLE EXTENSION
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. HELPER FUNCTION: NORMALIZE SEARCH TEXT (remove hyphens, spaces, symbols)
CREATE OR REPLACE FUNCTION public.normalize_search_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9а-яё]', '', 'g');
$$;

GRANT EXECUTE ON FUNCTION public.normalize_search_text(text) TO authenticated, service_role, anon;

-- 3. DROP OBSOLETE OVERLOAD OF list_inventory_balances
DROP FUNCTION IF EXISTS public.list_inventory_balances(uuid, uuid, text, integer, integer, uuid, numeric, numeric, text);

-- 4. UPDATE list_inventory_balances WITH SMART NORMALIZED & FUZZY SEARCH
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
DECLARE
  v_items jsonb;
  v_total bigint;
  v_total_on_hand numeric;
  v_total_reserved numeric;
  v_total_value numeric;
  v_total_cost numeric;
  v_target_branch uuid;
  v_default_loc record;
  v_q text := nullif(btrim(p_query), '');
  v_norm_q text := public.normalize_search_text(v_q);
  v_has_fuzzy_only boolean := false;
  v_exact_count bigint := 0;
  v_fuzzy_count bigint := 0;
  v_suggested_name text := null;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5000 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto''g''ri';
  END IF;

  v_target_branch := coalesce(p_branch_id, (SELECT id FROM public.branches LIMIT 1));

  SELECT l.id, l.name, l.type, br.name AS branch_name INTO v_default_loc
  FROM public.locations l
  JOIN public.branches br ON br.id = l.branch_id
  WHERE l.branch_id = v_target_branch
  ORDER BY CASE WHEN l.type = 'warehouse' THEN 1 ELSE 2 END, l.created_at
  LIMIT 1;

  WITH combined AS (
    -- 1. Products that have explicit entries in inventory_balances
    SELECT
      ib.location_id,
      l.name AS location_name,
      l.type AS location_type,
      l.branch_id,
      br.name AS branch_name,
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      p.barcode,
      p.retail_price,
      p.cost_price,
      p.cost_price_updated_at,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      c.name AS category_name,
      ib.on_hand,
      ib.reserved,
      (ib.on_hand - ib.reserved) AS available,
      ib.updated_at,
      p.created_at
    FROM public.inventory_balances ib
    JOIN public.locations l ON l.id = ib.location_id
    JOIN public.branches br ON br.id = l.branch_id
    JOIN public.products p ON p.id = ib.product_id
    LEFT JOIN public.categories c ON c.id = p.category_id
    WHERE public.can_access_branch(l.branch_id)
      AND (v_target_branch IS NULL OR l.branch_id = v_target_branch)
      AND (p_location_id IS NULL OR l.id = p_location_id)
      AND p.status <> 'archived'

    UNION ALL

    -- 2. Products in catalog that have NO balance in this branch yet
    SELECT
      v_default_loc.id AS location_id,
      coalesce(v_default_loc.name, 'Asosiy ombor') AS location_name,
      coalesce(v_default_loc.type, 'warehouse') AS location_type,
      v_target_branch AS branch_id,
      coalesce(v_default_loc.branch_name, 'Filial') AS branch_name,
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      p.barcode,
      p.retail_price,
      p.cost_price,
      p.cost_price_updated_at,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      c.name AS category_name,
      0::numeric AS on_hand,
      0::numeric AS reserved,
      0::numeric AS available,
      p.updated_at,
      p.created_at
    FROM public.products p
    LEFT JOIN public.categories c ON c.id = p.category_id
    WHERE p.status <> 'archived'
      AND (p_location_id IS NULL OR p_location_id = v_default_loc.id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.inventory_balances ib2
        JOIN public.locations l2 ON l2.id = ib2.location_id
        WHERE ib2.product_id = p.id
          AND (v_target_branch IS NULL OR l2.branch_id = v_target_branch)
      )
  ),
  filtered AS (
    SELECT c.*,
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = c.product_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) AS image,
      CASE
        WHEN v_q IS NULL THEN 1
        -- Tier 1: Substring / exact match
        WHEN c.product_name ILIKE '%'||v_q||'%' OR c.sku ILIKE '%'||v_q||'%' OR coalesce(c.barcode, '') ILIKE '%'||v_q||'%' THEN 1
        -- Tier 2: Normalized alphanumeric match (handles mg001 or mg 001 for mg-001)
        WHEN length(v_norm_q) >= 2 AND (
          public.normalize_search_text(c.product_name) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(c.sku) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(c.barcode) LIKE '%'||v_norm_q||'%'
        ) THEN 2
        -- Tier 3: Fuzzy similarity (handles typos, missing characters like mg01 for mg-001)
        ELSE 3
      END AS match_rank,
      CASE
        WHEN v_q IS NULL THEN 1.0::numeric
        ELSE round(greatest(
          public.word_similarity(v_norm_q, public.normalize_search_text(c.product_name)),
          public.word_similarity(lower(v_q), lower(c.product_name)),
          public.similarity(v_norm_q, public.normalize_search_text(c.product_name)),
          public.similarity(lower(v_q), lower(c.product_name)),
          public.word_similarity(v_norm_q, public.normalize_search_text(c.sku))
        )::numeric, 2)
      END AS match_similarity,
      CASE
        WHEN v_q IS NULL THEN false
        WHEN c.product_name ILIKE '%'||v_q||'%' OR c.sku ILIKE '%'||v_q||'%' OR coalesce(c.barcode, '') ILIKE '%'||v_q||'%' THEN false
        WHEN length(v_norm_q) >= 2 AND (
          public.normalize_search_text(c.product_name) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(c.sku) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(c.barcode) LIKE '%'||v_norm_q||'%'
        ) THEN false
        ELSE true
      END AS is_fuzzy
    FROM combined c
    WHERE (
      v_q IS NULL
      OR c.product_name ILIKE '%'||v_q||'%'
      OR c.sku ILIKE '%'||v_q||'%'
      OR coalesce(c.barcode, '') ILIKE '%'||v_q||'%'
      OR (
        length(v_norm_q) >= 2 AND (
          public.normalize_search_text(c.product_name) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(c.sku) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(c.barcode) LIKE '%'||v_norm_q||'%'
        )
      )
      OR (
        length(v_norm_q) >= 2 AND (
          public.word_similarity(v_norm_q, public.normalize_search_text(c.product_name)) >= 0.38
          OR public.word_similarity(lower(v_q), lower(c.product_name)) >= 0.38
          OR public.similarity(v_norm_q, public.normalize_search_text(c.product_name)) >= 0.22
          OR public.word_similarity(v_norm_q, public.normalize_search_text(c.sku)) >= 0.38
        )
      )
    )
    AND (p_category_id IS NULL OR c.category_id = p_category_id)
    AND (p_min_price IS NULL OR c.retail_price >= p_min_price)
    AND (p_max_price IS NULL OR c.retail_price <= p_max_price)
    AND (p_availability IS NULL
      OR (p_availability IN ('in_stock', 'available') AND c.available > 0)
      OR (p_availability IN ('out_of_stock', 'empty') AND c.available <= 0))
  ),
  with_image_filter AS (
    SELECT f.*
    FROM filtered f
    WHERE (
      p_has_image IS NULL OR p_has_image = '' OR p_has_image = 'all'
      OR (p_has_image IN ('with_image', 'true', 'has_image') AND f.image IS NOT NULL)
      OR (p_has_image IN ('without_image', 'false', 'no_image') AND f.image IS NULL)
    )
  ),
  aggregates AS (
    SELECT
      count(*)::bigint AS cnt,
      coalesce(sum(on_hand), 0)::numeric AS total_on_hand,
      coalesce(sum(reserved), 0)::numeric AS total_reserved,
      coalesce(sum(on_hand * retail_price), 0)::numeric AS total_value,
      coalesce(sum(on_hand * coalesce(cost_price, 0)), 0)::numeric AS total_cost,
      count(*) FILTER (WHERE match_rank IN (1, 2))::bigint AS exact_cnt,
      count(*) FILTER (WHERE match_rank = 3)::bigint AS fuzzy_cnt
    FROM with_image_filter
  ),
  paged AS (
    SELECT *
    FROM with_image_filter
    ORDER BY
      CASE WHEN v_q IS NOT NULL THEN match_rank END ASC,
      CASE WHEN v_q IS NOT NULL AND p_sort_by IS NULL THEN match_similarity END DESC,
      CASE WHEN p_sort_by = 'image_first' THEN (CASE WHEN image IS NOT NULL THEN 0 ELSE 1 END) END ASC,
      CASE WHEN p_sort_by = 'no_image_first' THEN (CASE WHEN image IS NULL THEN 0 ELSE 1 END) END ASC,
      CASE WHEN p_sort_by = 'price_desc' THEN retail_price END DESC,
      CASE WHEN p_sort_by = 'price_asc' THEN retail_price END ASC,
      CASE WHEN p_sort_by = 'qty_desc' THEN available END DESC,
      CASE WHEN p_sort_by = 'qty_asc' THEN available END ASC,
      CASE WHEN p_sort_by = 'name_asc' THEN product_name END ASC,
      CASE WHEN v_q IS NOT NULL THEN available END DESC,
      created_at DESC,
      product_name ASC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    coalesce((SELECT cnt FROM aggregates), 0),
    coalesce((SELECT total_on_hand FROM aggregates), 0),
    coalesce((SELECT total_reserved FROM aggregates), 0),
    coalesce((SELECT total_value FROM aggregates), 0),
    coalesce((SELECT total_cost FROM aggregates), 0),
    coalesce((SELECT exact_cnt FROM aggregates), 0),
    coalesce((SELECT fuzzy_cnt FROM aggregates), 0),
    (SELECT product_name FROM with_image_filter WHERE match_rank = 3 ORDER BY match_similarity DESC LIMIT 1),
    coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM paged p), '[]'::jsonb)
  INTO v_total, v_total_on_hand, v_total_reserved, v_total_value, v_total_cost, v_exact_count, v_fuzzy_count, v_suggested_name, v_items;

  v_has_fuzzy_only := (v_total > 0 AND v_exact_count = 0);

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_on_hand', v_total_on_hand,
    'total_reserved', v_total_reserved,
    'total_value', v_total_value,
    'total_cost', v_total_cost,
    'has_fuzzy_only', v_has_fuzzy_only,
    'exact_count', v_exact_count,
    'fuzzy_count', v_fuzzy_count,
    'suggested_name', v_suggested_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_inventory_balances(uuid, uuid, text, integer, integer, uuid, numeric, numeric, text, text, text) TO authenticated, service_role;

-- 5. UPDATE list_pos_units FOR POS SCANNER SEARCH
CREATE OR REPLACE FUNCTION public.list_pos_units(p_branch_id uuid, p_query text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_q text := nullif(btrim(p_query), '');
  v_norm_q text := public.normalize_search_text(v_q);
  v_rate numeric;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC
  LIMIT 1;

  SELECT count(*) INTO v_total
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  WHERE l.branch_id = p_branch_id AND l.type IN ('store', 'warehouse') AND l.is_active
    AND u.status = 'available' AND u.active_transfer_id IS NULL AND p.status = 'active'
    AND (
      v_q IS NULL
      OR p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%'
      OR coalesce(p.barcode, '') ILIKE '%'||v_q||'%'
      OR u.qr_code ILIKE '%'||v_q||'%' OR coalesce(u.serial_number, '') ILIKE '%'||v_q||'%'
      OR (
        length(v_norm_q) >= 2 AND (
          public.normalize_search_text(p.name) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(p.sku) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(p.barcode) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(u.qr_code) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(u.serial_number) LIKE '%'||v_norm_q||'%'
        )
      )
      OR (
        length(v_norm_q) >= 2 AND (
          public.word_similarity(v_norm_q, public.normalize_search_text(p.name)) >= 0.38
          OR public.word_similarity(lower(v_q), lower(p.name)) >= 0.38
          OR public.similarity(v_norm_q, public.normalize_search_text(p.name)) >= 0.22
          OR public.word_similarity(v_norm_q, public.normalize_search_text(p.sku)) >= 0.38
        )
      )
    );

  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT u.id, u.qr_code, u.serial_number, u.location_id, l.name AS location_name, l.type AS location_type,
      p.id AS product_id, p.name AS product_name, p.sku, p.barcode, br.name AS brand_name,
      coalesce(p.retail_price, pv.retail_price) AS retail_price,
      coalesce(p.retail_price_usd, pv.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(p.retail_price, pv.retail_price) / v_rate, 2) ELSE null END) AS retail_price_usd,
      coalesce(p.minimum_sale_price, pv.minimum_sale_price) AS minimum_sale_price,
      coalesce(p.minimum_sale_price_usd, pv.minimum_sale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(p.minimum_sale_price, pv.minimum_sale_price) / v_rate, 2) ELSE null END) AS minimum_sale_price_usd,
      p.tax_rate,
      coalesce(p.cost_price, pv.cost_price, sb.unit_cost) AS unit_cost,
      coalesce(p.cost_price_usd, pv.cost_price_usd, sb.unit_cost_usd, CASE WHEN v_rate > 0 THEN round(coalesce(p.cost_price, pv.cost_price, sb.unit_cost) / v_rate, 2) ELSE null END) AS unit_cost_usd,
      coalesce(p.cost_price_usd, pv.cost_price_usd, sb.unit_cost_usd) AS cost_price_usd,
      coalesce(p.currency, 'USD') AS currency,
      coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
      ) AS image,
      (SELECT count(*) FROM public.inventory_units a JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = p.id AND al.branch_id = p_branch_id AND al.type IN ('store', 'warehouse')
          AND al.is_active AND a.status = 'available' AND a.active_transfer_id IS NULL) AS available_branch_count,
      CASE
        WHEN v_q IS NULL THEN 1
        WHEN p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%' OR u.qr_code ILIKE '%'||v_q||'%' THEN 1
        WHEN length(v_norm_q) >= 2 AND (
          public.normalize_search_text(p.name) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(p.sku) LIKE '%'||v_norm_q||'%'
        ) THEN 2
        ELSE 3
      END AS match_rank,
      CASE
        WHEN v_q IS NULL THEN false
        WHEN p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%' OR u.qr_code ILIKE '%'||v_q||'%' THEN false
        WHEN length(v_norm_q) >= 2 AND (
          public.normalize_search_text(p.name) LIKE '%'||v_norm_q||'%'
          OR public.normalize_search_text(p.sku) LIKE '%'||v_norm_q||'%'
        ) THEN false
        ELSE true
      END AS is_fuzzy
    FROM public.inventory_units u
    JOIN public.locations l ON l.id = u.location_id
    JOIN public.products p ON p.id = u.product_id
    LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
    LEFT JOIN public.brands br ON br.id = p.brand_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE l.branch_id = p_branch_id AND l.type IN ('store', 'warehouse') AND l.is_active
      AND u.status = 'available' AND u.active_transfer_id IS NULL AND p.status = 'active'
      AND (
        v_q IS NULL
        OR p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%'
        OR coalesce(p.barcode, '') ILIKE '%'||v_q||'%'
        OR u.qr_code ILIKE '%'||v_q||'%' OR coalesce(u.serial_number, '') ILIKE '%'||v_q||'%'
        OR (
          length(v_norm_q) >= 2 AND (
            public.normalize_search_text(p.name) LIKE '%'||v_norm_q||'%'
            OR public.normalize_search_text(p.sku) LIKE '%'||v_norm_q||'%'
            OR public.normalize_search_text(p.barcode) LIKE '%'||v_norm_q||'%'
            OR public.normalize_search_text(u.qr_code) LIKE '%'||v_norm_q||'%'
            OR public.normalize_search_text(u.serial_number) LIKE '%'||v_norm_q||'%'
          )
        )
        OR (
          length(v_norm_q) >= 2 AND (
            public.word_similarity(v_norm_q, public.normalize_search_text(p.name)) >= 0.38
            OR public.word_similarity(lower(v_q), lower(p.name)) >= 0.38
            OR public.similarity(v_norm_q, public.normalize_search_text(p.name)) >= 0.22
            OR public.word_similarity(v_norm_q, public.normalize_search_text(p.sku)) >= 0.38
          )
        )
      )
    ORDER BY
      CASE WHEN v_q IS NOT NULL THEN
        CASE
          WHEN p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%' OR u.qr_code ILIKE '%'||v_q||'%' THEN 1
          WHEN length(v_norm_q) >= 2 AND (
            public.normalize_search_text(p.name) LIKE '%'||v_norm_q||'%'
            OR public.normalize_search_text(p.sku) LIKE '%'||v_norm_q||'%'
          ) THEN 2
          ELSE 3
        END
      END ASC,
      p.name, u.id
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'limit', p_limit,
    'offset', p_offset
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_units(uuid, text, integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';

COMMIT;
