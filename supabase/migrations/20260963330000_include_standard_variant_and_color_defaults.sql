-- Migration: 20260963330000_include_standard_variant_and_color_defaults.sql
-- Description:
-- 1. Adds public.resolve_color_hex helper to auto-derive hex colors for color names if color_hex is null.
-- 2. Backfills product_variants.color_hex and adds a trigger to ensure new variants get default color_hex.
-- 3. Updates storefront_product_detail, storefront_catalog, storefront_catalog_faceted, and storefront_products_by_ids
--    to include the 'Standart' variant when a product has units with variant_id IS NULL and also has defined color variants.
-- 4. Updates create_online_order to handle 'standard' / 'default' variant_id safely without UUID cast errors and record 'Standart' variant_color.

-- 1. Helper function to resolve color hex from name
CREATE OR REPLACE FUNCTION public.resolve_color_hex(p_name text, p_hex text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_hex IS NOT NULL AND btrim(p_hex) <> '' THEN btrim(p_hex)
    WHEN lower(coalesce(p_name, '')) ~ 'qora|black' THEN '#111827'
    WHEN lower(coalesce(p_name, '')) ~ 'kulrang|seriy|gray|grey' THEN '#6B7280'
    WHEN lower(coalesce(p_name, '')) ~ 'alyuminiy|kumush|silver' THEN '#94A3B8'
    WHEN lower(coalesce(p_name, '')) ~ 'oq|white' THEN '#FFFFFF'
    WHEN lower(coalesce(p_name, '')) ~ 'qizil|red' THEN '#EF4444'
    WHEN lower(coalesce(p_name, '')) ~ 'ko‘k|ko''k|kok|blue' THEN '#2563EB'
    WHEN lower(coalesce(p_name, '')) ~ 'havorang|moviy' THEN '#38BDF8'
    WHEN lower(coalesce(p_name, '')) ~ 'yashil|green' THEN '#10B981'
    WHEN lower(coalesce(p_name, '')) ~ 'sariq|yellow' THEN '#F59E0B'
    WHEN lower(coalesce(p_name, '')) ~ 'tilla|oltin|gold' THEN '#D97706'
    WHEN lower(coalesce(p_name, '')) ~ 'jigarrang|brown' THEN '#78350F'
    WHEN lower(coalesce(p_name, '')) ~ 'pushti|pink' THEN '#EC4899'
    WHEN lower(coalesce(p_name, '')) ~ 'siyohrang|binafsha|purple' THEN '#8B5CF6'
    WHEN lower(coalesce(p_name, '')) ~ 'zangori|firuza' THEN '#06B6D4'
    WHEN lower(coalesce(p_name, '')) ~ 'standart|standard|default' THEN '#94A3B8'
    ELSE '#94A3B8'
  END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_color_hex(text, text) TO anon, authenticated, service_role;

-- 2. Trigger on product_variants to ensure color_hex is never null
CREATE OR REPLACE FUNCTION public.auto_set_variant_color_hex()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.color_hex IS NULL OR btrim(NEW.color_hex) = '' THEN
    NEW.color_hex := public.resolve_color_hex(NEW.color_name, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_set_variant_color_hex ON public.product_variants;
CREATE TRIGGER trg_auto_set_variant_color_hex
BEFORE INSERT OR UPDATE ON public.product_variants
FOR EACH ROW
EXECUTE FUNCTION public.auto_set_variant_color_hex();

-- Backfill existing variants
UPDATE public.product_variants
SET color_hex = public.resolve_color_hex(color_name, color_hex)
WHERE color_hex IS NULL OR btrim(color_hex) = '';

-- 3. Update storefront_product_detail
CREATE OR REPLACE FUNCTION public.storefront_product_detail(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT to_jsonb(x) FROM (
    SELECT p.id, p.id AS product_id, p.sku, p.barcode, p.category_id, p.brand_id, br.name AS brand_name, p.name, p.slug,
      p.description, p.description_blocks, p.video_url,
      p.seo_title, p.seo_description, p.seo_image_url,
      coalesce(
        (SELECT min(coalesce(sb.retail_price, p.retail_price))
         FROM public.inventory_units u
         JOIN public.locations l ON l.id = u.location_id AND l.is_active AND l.type IN ('store', 'warehouse')
         LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
         WHERE u.product_id = p.id AND u.status = 'available' AND u.active_transfer_id IS NULL),
        p.retail_price
      ) AS retail_price,
      p.compare_at_price, p.promotion_price, p.tax_rate, p.created_at,
      coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1),
        p.seo_image_url
      ) AS primary_media_url,
      coalesce(
        nullif((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) ORDER BY m.is_primary DESC, m.sort_order, m.id) FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL), '[]'::jsonb),
        CASE WHEN p.seo_image_url IS NOT NULL THEN jsonb_build_array(jsonb_build_object('id', p.id, 'url', p.seo_image_url, 'alt', p.name)) ELSE '[]'::jsonb END
      ) AS media,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value, 'is_filterable', a.is_filterable) ORDER BY a.sort_order, a.code), '[]'::jsonb) FROM public.product_attribute_values v JOIN public.attribute_definitions a ON a.id = v.attribute_id WHERE v.product_id = p.id) AS attributes,
      (SELECT count(*) FROM public.inventory_units u JOIN public.locations l ON l.id = u.location_id WHERE u.product_id = p.id AND u.status = 'available' AND u.active_transfer_id IS NULL AND l.is_active AND l.type IN ('store', 'warehouse')) AS available_stock,
      (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', CASE WHEN tier.tier_count > 1 THEN p.id::text || '_' || round(tier.price)::bigint::text ELSE p.id::text END,
              'product_id', p.id,
              'price', tier.price,
              'price_usd', tier.price_usd,
              'stock', tier.stock,
              'batch_id', tier.batch_id,
              'receipt_no', tier.receipt_no
            ) ORDER BY tier.price
          ),
          '[]'::jsonb
        )
        FROM (
          SELECT
            coalesce(sb.retail_price, p.retail_price) AS price,
            coalesce(sb.retail_price_usd, p.retail_price_usd) AS price_usd,
            count(u.id) AS stock,
            count(*) over() AS tier_count,
            (array_agg(sb.id))[1] AS batch_id,
            string_agg(distinct sr.receipt_no, ', ') AS receipt_no
          FROM public.inventory_units u
          JOIN public.locations l ON l.id = u.location_id AND l.is_active AND l.type IN ('store', 'warehouse')
          LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
          LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
          WHERE u.product_id = p.id AND u.status = 'available' AND u.active_transfer_id IS NULL
          GROUP BY coalesce(sb.retail_price, p.retail_price), coalesce(sb.retail_price_usd, p.retail_price_usd)
          HAVING count(u.id) > 0
        ) tier
      ) AS price_tiers,
      (
        SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.sort_order, v.id), '[]'::jsonb)
        FROM (
          -- 1. Standart variant: tovarning product_variants jadvalida boshqa ranglari bo'lsa va variant_id IS NULL bo'lgan birliklari mavjud bo'lsa
          SELECT
            'standard'::text AS id,
            'Standart'::text AS color_name,
            '#94A3B8'::text AS color_hex,
            coalesce(p.promotion_price, p.retail_price) AS price,
            p.retail_price,
            p.compare_at_price,
            p.cost_price,
            coalesce((SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1), p.seo_image_url) AS image,
            (SELECT count(*) FROM public.inventory_units u JOIN public.locations l ON l.id = u.location_id WHERE u.product_id = p.id AND u.variant_id IS NULL AND u.status = 'available' AND u.active_transfer_id IS NULL AND l.is_active AND l.type IN ('store', 'warehouse')) AS stock,
            coalesce(
              nullif((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) ORDER BY m.is_primary DESC, m.sort_order, m.id) FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL), '[]'::jsonb),
              CASE WHEN p.seo_image_url IS NOT NULL THEN jsonb_build_array(jsonb_build_object('id', p.id, 'url', p.seo_image_url, 'alt', p.name)) ELSE '[]'::jsonb END
            ) AS media,
            0 AS sort_order
          WHERE EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active)
            AND EXISTS (SELECT 1 FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy'))

          UNION ALL

          -- 2. Qo'shilgan rang variantlari
          SELECT
            pv.id::text AS id,
            pv.color_name,
            public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
            coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, p.retail_price) AS price,
            coalesce(pv.retail_price, p.retail_price) AS retail_price,
            coalesce(pv.compare_at_price, p.compare_at_price) AS compare_at_price,
            coalesce(pv.cost_price, p.cost_price) AS cost_price,
            (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1) AS image,
            (SELECT count(*) FROM public.inventory_units u JOIN public.locations l ON l.id = u.location_id WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL AND l.is_active AND l.type IN ('store', 'warehouse')) AS stock,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) ORDER BY m.is_primary DESC, m.sort_order, m.id) FROM public.product_media m WHERE m.variant_id = pv.id), '[]'::jsonb) AS media,
            pv.sort_order + 1 AS sort_order
          FROM public.product_variants pv
          WHERE pv.product_id = p.id AND pv.is_active
        ) v
      ) AS variants,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', pc.id,
          'name', pc.name,
          'color_name', pc.color_name,
          'color_hex', pc.color_hex,
          'retail_price', pc.retail_price,
          'retail_price_usd', pc.retail_price_usd,
          'cost_price', pc.cost_price,
          'cost_price_usd', pc.cost_price_usd,
          'wholesale_price', pc.wholesale_price,
          'wholesale_price_usd', pc.wholesale_price_usd,
          'is_default', pc.is_default,
          'is_required', pc.is_required,
          'can_buy_standalone', pc.can_buy_standalone,
          'image_url', pc.image_url,
          'sort_order', pc.sort_order
        ) ORDER BY pc.sort_order, pc.created_at), '[]'::jsonb)
        FROM public.product_components pc WHERE pc.product_id = p.id AND pc.is_active = true) AS components
    FROM public.products p
    JOIN public.categories c ON c.id = p.category_id AND c.is_active
    LEFT JOIN public.brands br ON br.id = p.brand_id
    WHERE p.slug = p_slug AND p.status = 'active' AND p.is_published AND (p.brand_id IS NULL OR br.is_active)
  ) x;
$function$;

-- 4. Update storefront_catalog
CREATE OR REPLACE FUNCTION public.storefront_catalog(p_query text default null::text, p_category_id uuid default null::uuid, p_limit integer default 24, p_offset integer default 0)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH active_price_tiers AS (
    SELECT
      u.product_id,
      coalesce(sb.retail_price, p.retail_price) AS tier_price,
      coalesce(sb.retail_price_usd, p.retail_price_usd) AS tier_price_usd,
      count(u.id) AS tier_stock,
      (array_agg(sb.id))[1] AS tier_batch_id,
      string_agg(distinct sr.receipt_no, ', ') AS tier_receipt_no
    FROM public.inventory_units u
    JOIN public.locations l ON l.id = u.location_id AND l.is_active AND l.type IN ('store', 'warehouse')
    JOIN public.products p ON p.id = u.product_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
    WHERE u.status = 'available' AND u.active_transfer_id IS NULL
    GROUP BY u.product_id, coalesce(sb.retail_price, p.retail_price), coalesce(sb.retail_price_usd, p.retail_price_usd)
    HAVING count(u.id) > 0
  ),
  product_tier_counts AS (
    SELECT product_id, count(*) AS tier_count
    FROM active_price_tiers
    GROUP BY product_id
  ),
  base AS (
    SELECT
      CASE
        WHEN coalesce(ptc.tier_count, 0) > 1
          THEN p.id::text || '_' || round(apt.tier_price)::bigint::text
        ELSE p.id::text
      END AS id,
      p.id AS product_id,
      apt.tier_batch_id AS batch_id,
      apt.tier_receipt_no AS receipt_no,
      p.sku, p.barcode, p.category_id, p.brand_id, br.name AS brand_name, p.name, p.slug,
      p.description, p.video_url, p.seo_title, p.seo_description, p.seo_image_url,
      coalesce(apt.tier_price, p.retail_price) AS retail_price,
      p.compare_at_price,
      CASE
        WHEN p.promotion_price IS NOT NULL AND p.promotion_price < coalesce(apt.tier_price, p.retail_price)
          THEN p.promotion_price
        ELSE null
      END AS promotion_price,
      coalesce(
        CASE
          WHEN p.promotion_price IS NOT NULL AND p.promotion_price < coalesce(apt.tier_price, p.retail_price)
            THEN p.promotion_price
          ELSE null
        END,
        coalesce(apt.tier_price, p.retail_price)
      ) AS effective_price,
      p.tax_rate, p.created_at,
      coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1),
        p.seo_image_url
      ) AS primary_media_url,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value) ORDER BY a.sort_order, a.code), '[]'::jsonb)
       FROM public.product_attribute_values v JOIN public.attribute_definitions a ON a.id = v.attribute_id WHERE v.product_id = p.id) AS attributes,
      coalesce(apt.tier_stock, 0) AS available_stock,
      (
        SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.sort_order, v.id), '[]'::jsonb)
        FROM (
          SELECT
            'standard'::text AS id,
            'Standart'::text AS color_name,
            '#94A3B8'::text AS color_hex,
            coalesce(p.promotion_price, coalesce(apt.tier_price, p.retail_price)) AS price,
            (SELECT count(*) FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL AND u.status = 'available' AND u.active_transfer_id IS NULL) AS stock,
            coalesce((SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1), p.seo_image_url) AS image,
            0 AS sort_order
          WHERE EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active)
            AND EXISTS (SELECT 1 FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy'))

          UNION ALL

          SELECT
            pv.id::text AS id,
            pv.color_name,
            public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
            coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, coalesce(apt.tier_price, p.retail_price)) AS price,
            (SELECT count(*) FROM public.inventory_units u WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL) AS stock,
            (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1) AS image,
            pv.sort_order + 1 AS sort_order
          FROM public.product_variants pv
          WHERE pv.product_id = p.id AND pv.is_active
        ) v
      ) AS variants
    FROM public.products p
    JOIN public.categories c ON c.id = p.category_id AND c.is_active
    LEFT JOIN public.brands br ON br.id = p.brand_id
    LEFT JOIN active_price_tiers apt ON apt.product_id = p.id
    LEFT JOIN product_tier_counts ptc ON ptc.product_id = p.id
    WHERE p.status = 'active' AND p.is_published AND (p.brand_id IS NULL OR br.is_active)
      AND (p_category_id IS NULL OR p.category_id = p_category_id)
      AND (nullif(btrim(p_query),'') IS NULL OR p.name ilike '%'||btrim(p_query)||'%' OR p.sku ilike '%'||btrim(p_query)||'%' OR coalesce(p.barcode,'') ilike '%'||btrim(p_query)||'%')
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.name, x.retail_price, x.id) FROM (SELECT * FROM base ORDER BY name, retail_price, id LIMIT greatest(1, least(p_limit, 100)) OFFSET greatest(p_offset, 0)) x), '[]'::jsonb), 'total', (SELECT count(*) FROM base));
$function$;

-- 5. Update storefront_catalog_faceted
CREATE OR REPLACE FUNCTION public.storefront_catalog_faceted(p_filters jsonb default '{}'::jsonb, p_limit integer default 24, p_offset integer default 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
WITH input AS (
  SELECT public.validate_storefront_catalog_filters(p_filters) f
),
active_price_tiers AS (
  SELECT
    u.product_id,
    coalesce(sb.retail_price, p.retail_price) AS tier_price,
    coalesce(sb.retail_price_usd, p.retail_price_usd) AS tier_price_usd,
    count(u.id) AS tier_stock,
    (array_agg(sb.id))[1] AS tier_batch_id,
    string_agg(distinct sr.receipt_no, ', ') AS tier_receipt_no
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id AND l.is_active AND l.type IN ('store', 'warehouse')
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
  WHERE u.status = 'available' AND u.active_transfer_id IS NULL
  GROUP BY u.product_id, coalesce(sb.retail_price, p.retail_price), coalesce(sb.retail_price_usd, p.retail_price_usd)
  HAVING count(u.id) > 0
),
product_tier_counts AS (
  SELECT product_id, count(*) AS tier_count
  FROM active_price_tiers
  GROUP BY product_id
),
base AS (
  SELECT
    CASE
      WHEN coalesce(ptc.tier_count, 0) > 1
        THEN p.id::text || '_' || round(apt.tier_price)::bigint::text
      ELSE p.id::text
    END AS id,
    p.id AS product_id,
    apt.tier_batch_id AS batch_id,
    apt.tier_receipt_no AS receipt_no,
    p.sku, p.barcode, p.category_id, p.brand_id, p.name, p.slug, p.description,
    coalesce(apt.tier_price, p.retail_price) AS retail_price,
    p.compare_at_price,
    CASE
      WHEN p.promotion_price IS NOT NULL AND p.promotion_price < coalesce(apt.tier_price, p.retail_price)
        THEN p.promotion_price
      ELSE null
    END AS promotion_price,
    coalesce(
      CASE
        WHEN p.promotion_price IS NOT NULL AND p.promotion_price < coalesce(apt.tier_price, p.retail_price)
          THEN p.promotion_price
        ELSE null
      END,
      coalesce(apt.tier_price, p.retail_price)
    ) AS effective_price,
    p.tax_rate, p.created_at,
    coalesce(
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1),
      p.seo_image_url
    ) AS primary_media_url,
    (
      SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value, 'is_filterable', a.is_filterable) ORDER BY a.sort_order, a.code), '[]'::jsonb)
      FROM public.product_attribute_values v
      JOIN public.attribute_definitions a ON a.id = v.attribute_id
      WHERE v.product_id = p.id
    ) AS attributes,
    coalesce(apt.tier_stock, 0) AS available_stock,
    (SELECT round(avg(r.rating), 1) FROM public.product_reviews r WHERE r.product_id = p.id AND r.is_visible) AS avg_rating,
    (SELECT count(*) FROM public.product_reviews r WHERE r.product_id = p.id AND r.is_visible) AS review_count,
    (
      SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.sort_order, v.id), '[]'::jsonb)
      FROM (
        SELECT
          'standard'::text AS id,
          'Standart'::text AS color_name,
          '#94A3B8'::text AS color_hex,
          coalesce(p.promotion_price, coalesce(apt.tier_price, p.retail_price)) AS price,
          (SELECT count(*) FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL AND u.status = 'available' AND u.active_transfer_id IS NULL) AS stock,
          coalesce((SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1), p.seo_image_url) AS image,
          0 AS sort_order
        WHERE EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active)
          AND EXISTS (SELECT 1 FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy'))

        UNION ALL

        SELECT
          pv.id::text AS id,
          pv.color_name,
          public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
          coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, coalesce(apt.tier_price, p.retail_price)) AS price,
          (SELECT count(*) FROM public.inventory_units u WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL) AS stock,
          (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1) AS image,
          pv.sort_order + 1 AS sort_order
        FROM public.product_variants pv
        WHERE pv.product_id = p.id AND pv.is_active
      ) v
    ) AS variants
  FROM public.products p
  JOIN public.categories c ON c.id = p.category_id AND c.is_active
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN active_price_tiers apt ON apt.product_id = p.id
  LEFT JOIN product_tier_counts ptc ON ptc.product_id = p.id
  WHERE p.status = 'active' AND p.is_published AND (p.brand_id IS NULL OR br.is_active)
),
searched AS (
  SELECT b.* FROM base b CROSS JOIN input i WHERE
    (nullif(btrim(i.f->>'query'),'') IS NULL OR concat_ws(' ',b.name,b.sku,b.barcode,b.description,b.attributes::text) ilike '%'||btrim(i.f->>'query')||'%')
    AND (coalesce((i.f->>'in_stock')::boolean,false)=false OR b.available_stock>0)
),
priced AS (
  SELECT s.* FROM searched s CROSS JOIN input i WHERE
    (nullif(i.f->>'min_price','') IS NULL OR s.effective_price>=(i.f->>'min_price')::numeric)
    AND (nullif(i.f->>'max_price','') IS NULL OR s.effective_price<=(i.f->>'max_price')::numeric)
),
category_scope AS (
  SELECT s.* FROM priced s CROSS JOIN input i WHERE coalesce(jsonb_array_length(i.f->'category_ids'),0)=0
    OR s.category_id::text IN (SELECT jsonb_array_elements_text(i.f->'category_ids'))
),
brand_scope AS (
  SELECT s.* FROM priced s CROSS JOIN input i WHERE coalesce(jsonb_array_length(i.f->'brand_ids'),0)=0
    OR s.brand_id::text IN (SELECT jsonb_array_elements_text(i.f->'brand_ids'))
),
selected_dimensions AS (
  SELECT s.* FROM category_scope s CROSS JOIN input i WHERE coalesce(jsonb_array_length(i.f->'brand_ids'),0)=0
    OR s.brand_id::text IN (SELECT jsonb_array_elements_text(i.f->'brand_ids'))
),
filtered AS (
  SELECT s.* FROM selected_dimensions s CROSS JOIN input i WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wanted_filter WHERE NOT EXISTS (
      SELECT 1 FROM public.product_attribute_values pav JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = s.product_id AND ad.code = wanted_filter.key AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wanted_filter.value)='array' THEN wanted_filter.value ELSE jsonb_build_array(wanted_filter.value) END) wanted
        WHERE pav.value = wanted.value OR (jsonb_typeof(pav.value)='array' AND pav.value @> jsonb_build_array(wanted.value))
      )
    )
  )
),
category_facet_source AS (
  SELECT s.* FROM brand_scope s CROSS JOIN input i WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wanted_filter WHERE NOT EXISTS (
      SELECT 1 FROM public.product_attribute_values pav JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = s.product_id AND ad.code = wanted_filter.key AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wanted_filter.value)='array' THEN wanted_filter.value ELSE jsonb_build_array(wanted_filter.value) END) wanted
        WHERE pav.value = wanted.value OR (jsonb_typeof(pav.value)='array' AND pav.value @> jsonb_build_array(wanted.value))
      )
    )
  )
),
brand_facet_source AS (
  SELECT s.* FROM category_scope s CROSS JOIN input i WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wanted_filter WHERE NOT EXISTS (
      SELECT 1 FROM public.product_attribute_values pav JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = s.product_id AND ad.code = wanted_filter.key AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wanted_filter.value)='array' THEN wanted_filter.value ELSE jsonb_build_array(wanted_filter.value) END) wanted
        WHERE pav.value = wanted.value OR (jsonb_typeof(pav.value)='array' AND pav.value @> jsonb_build_array(wanted.value))
      )
    )
  )
),
ordered AS (
  SELECT f.* FROM filtered f CROSS JOIN input i ORDER BY
    CASE WHEN coalesce(i.f->>'sort','featured')='price_asc' THEN f.effective_price END ASC NULLS LAST,
    CASE WHEN coalesce(i.f->>'sort','featured')='price_desc' THEN f.effective_price END DESC NULLS LAST,
    CASE WHEN coalesce(i.f->>'sort','featured')='rating_desc' THEN f.avg_rating END DESC NULLS LAST,
    CASE WHEN coalesce(i.f->>'sort','featured')='created_desc' THEN f.created_at END DESC NULLS LAST,
    f.name ASC, f.id ASC
),
page_items AS (
  SELECT * FROM ordered LIMIT greatest(1, least(p_limit, 100)) OFFSET greatest(p_offset, 0)
)
SELECT jsonb_build_object(
  'items', coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page_items p), '[]'::jsonb),
  'total', (SELECT count(*) FROM ordered),
  'facets', jsonb_build_object(
    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'count', c.item_count) ORDER BY c.item_count DESC, c.name)
      FROM (
        SELECT cat.id, cat.name, cat.slug, count(s.id) AS item_count
        FROM public.categories cat
        JOIN category_facet_source s ON s.category_id = cat.id
        WHERE cat.is_active
        GROUP BY cat.id, cat.name, cat.slug
      ) c
    ), '[]'::jsonb),
    'brands', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'count', b.item_count) ORDER BY b.item_count DESC, b.name)
      FROM (
        SELECT br.id, br.name, count(s.id) AS item_count
        FROM public.brands br
        JOIN brand_facet_source s ON s.brand_id = br.id
        WHERE br.is_active
        GROUP BY br.id, br.name
      ) b
    ), '[]'::jsonb),
    'attributes', coalesce((
      SELECT jsonb_object_agg(attr.code, attr.vals)
      FROM (
        SELECT ad.code, jsonb_agg(jsonb_build_object('value', val_count.val, 'count', val_count.cnt) ORDER BY val_count.cnt DESC, val_count.val) AS vals
        FROM (
          SELECT pav.attribute_id, pav.value AS val, count(distinct s.product_id) AS cnt
          FROM selected_dimensions s
          JOIN public.product_attribute_values pav ON pav.product_id = s.product_id
          GROUP BY pav.attribute_id, pav.value
        ) val_count
        JOIN public.attribute_definitions ad ON ad.id = val_count.attribute_id
        WHERE ad.is_filterable
        GROUP BY ad.code
      ) attr
    ), '{}'::jsonb),
    'price', jsonb_build_object(
      'min', coalesce((SELECT min(s.effective_price) FROM selected_dimensions s), 0),
      'max', coalesce((SELECT max(s.effective_price) FROM selected_dimensions s), 0)
    )
  )
);
$$;

-- 6. Update storefront_products_by_ids
CREATE OR REPLACE FUNCTION public.storefront_products_by_ids(p_product_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  WITH active_price_tiers AS (
    SELECT
      u.product_id,
      coalesce(sb.retail_price, p.retail_price) AS tier_price,
      coalesce(sb.retail_price_usd, p.retail_price_usd) AS tier_price_usd,
      count(u.id) AS tier_stock,
      (array_agg(sb.id))[1] AS tier_batch_id,
      string_agg(distinct sr.receipt_no, ', ') AS tier_receipt_no
    FROM public.inventory_units u
    JOIN public.locations l ON l.id = u.location_id AND l.is_active AND l.type IN ('store', 'warehouse')
    JOIN public.products p ON p.id = u.product_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
    WHERE u.product_id = any(coalesce(p_product_ids, '{}'::uuid[]))
      AND u.status = 'available' AND u.active_transfer_id IS NULL
    GROUP BY u.product_id, coalesce(sb.retail_price, p.retail_price), coalesce(sb.retail_price_usd, p.retail_price_usd)
    HAVING count(u.id) > 0
  ),
  product_tier_counts AS (
    SELECT product_id, count(*) AS tier_count
    FROM active_price_tiers
    GROUP BY product_id
  ),
  base AS (
    SELECT
      CASE
        WHEN coalesce(ptc.tier_count, 0) > 1
          THEN p.id::text || '_' || round(apt.tier_price)::bigint::text
        ELSE p.id::text
      END AS id,
      p.id AS product_id,
      apt.tier_batch_id AS batch_id,
      apt.tier_receipt_no AS receipt_no,
      p.sku, p.barcode, p.category_id, p.brand_id, p.name, p.slug, p.description,
      coalesce(apt.tier_price, p.retail_price) AS retail_price,
      p.compare_at_price, p.promotion_price, p.tax_rate, p.created_at,
      coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1),
        p.seo_image_url
      ) AS primary_media_url,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value, 'is_filterable', a.is_filterable) ORDER BY a.sort_order, a.code), '[]'::jsonb) FROM public.product_attribute_values v JOIN public.attribute_definitions a ON a.id = v.attribute_id WHERE v.product_id = p.id) AS attributes,
      coalesce(apt.tier_stock, 0) AS available_stock,
      (SELECT round(avg(r.rating), 1) FROM public.product_reviews r WHERE r.product_id = p.id AND r.is_visible) AS avg_rating,
      (SELECT count(*) FROM public.product_reviews r WHERE r.product_id = p.id AND r.is_visible) AS review_count,
      (
        SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.sort_order, v.id), '[]'::jsonb)
        FROM (
          SELECT
            'standard'::text AS id,
            'Standart'::text AS color_name,
            '#94A3B8'::text AS color_hex,
            coalesce(p.promotion_price, coalesce(apt.tier_price, p.retail_price)) AS price,
            (SELECT count(*) FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL AND u.status = 'available' AND u.active_transfer_id IS NULL) AS stock,
            coalesce((SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1), p.seo_image_url) AS image,
            0 AS sort_order
          WHERE EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active)
            AND EXISTS (SELECT 1 FROM public.inventory_units u WHERE u.product_id = p.id AND u.variant_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = p.id AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy'))

          UNION ALL

          SELECT
            pv.id::text AS id,
            pv.color_name,
            public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
            coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, coalesce(apt.tier_price, p.retail_price)) AS price,
            (SELECT count(*) FROM public.inventory_units u WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL) AS stock,
            (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1) AS image,
            pv.sort_order + 1 AS sort_order
          FROM public.product_variants pv
          WHERE pv.product_id = p.id AND pv.is_active
        ) v
      ) AS variants
    FROM public.products p
    JOIN public.categories c ON c.id = p.category_id AND c.is_active
    LEFT JOIN public.brands br ON br.id = p.brand_id
    LEFT JOIN active_price_tiers apt ON apt.product_id = p.id
    LEFT JOIN product_tier_counts ptc ON ptc.product_id = p.id
    WHERE p.id = any(coalesce(p_product_ids, '{}'::uuid[]))
      AND cardinality(coalesce(p_product_ids, '{}'::uuid[])) between 1 and 100
      AND p.status = 'active' AND p.is_published AND (p.brand_id IS NULL OR br.is_active)
  )
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.name, x.retail_price, x.id), '[]'::jsonb) FROM base x;
$$;

-- 7. Update create_online_order to safely handle 'standard' / 'default' variant_id
CREATE OR REPLACE FUNCTION public.create_online_order(
  p_customer jsonb,
  p_shipping_address jsonb,
  p_lines jsonb,
  p_payment_method_code text,
  p_idempotency_key text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order uuid := gen_random_uuid();
  v_line jsonb;
  v_product record;
  v_variant record;
  v_variant_id uuid;
  v_batch_id uuid;
  v_batch_price numeric(18,2);
  v_color text;
  v_sale_price numeric(18,2);
  v_subtotal numeric(18,2) := 0;
  v_qty integer;
  v_method uuid;
  v_existing public.orders%rowtype;
  v_hash text;
  v_customer_id uuid;
BEGIN
  IF nullif(btrim(p_idempotency_key),'') IS NULL OR jsonb_typeof(p_customer)<>'object' OR jsonb_typeof(p_shipping_address)<>'object'
    OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Buyurtma payload yoki idempotency key noto‘g‘ri' USING errcode='22023';
  END IF;

  IF nullif(btrim(p_customer->>'name'),'') IS NULL OR nullif(btrim(p_customer->>'phone'),'') IS NULL THEN
    RAISE EXCEPTION 'Mijoz ismi va telefoni talab qilinadi' USING errcode='22023';
  END IF;

  SELECT id INTO v_method FROM public.payment_methods WHERE code=lower(btrim(p_payment_method_code)) AND is_active AND (is_online OR is_cash OR code='cod');
  IF v_method IS NULL THEN
    RAISE EXCEPTION 'Faol to‘lov usuli topilmadi' USING errcode='P0002';
  END IF;

  BEGIN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) e WHERE (e->>'quantity')::numeric <> trunc((e->>'quantity')::numeric)
      OR (e->>'quantity')::integer NOT BETWEEN 1 AND 100) THEN
      RAISE EXCEPTION 'Online buyurtma miqdori 1..100 butun son bo‘lishi kerak' USING errcode='22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Buyurtma miqdori noto‘g‘ri' USING errcode='22023';
  END;

  v_hash := encode(extensions.digest(convert_to(jsonb_build_object('customer',p_customer,'shipping_address',p_shipping_address,
    'lines',(SELECT jsonb_agg(jsonb_build_object(
      'product_id',(e->>'product_id')::uuid,
      'variant_id',CASE WHEN nullif(e->>'variant_id','') IN ('standard', 'default') THEN NULL ELSE nullif(e->>'variant_id','')::uuid END,
      'batch_id',nullif(e->>'batch_id','')::uuid,
      'quantity',(e->>'quantity')::integer)
      ORDER BY (e->>'product_id')::uuid,CASE WHEN nullif(e->>'variant_id','') IN ('standard', 'default') THEN NULL ELSE nullif(e->>'variant_id','')::uuid END,nullif(e->>'batch_id','')::uuid) FROM jsonb_array_elements(p_lines) e),'payment_method_code',lower(btrim(p_payment_method_code)),
    'notes',nullif(btrim(p_notes),''))::text,'UTF8'),'sha256'),'hex');

  SELECT * INTO v_existing FROM public.orders WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash OR v_existing.customer_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Takroriy kalit boshqa buyurtmaga tegishli' USING errcode='22023';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM public.customers WHERE auth_user_id=auth.uid();
  END IF;

  INSERT INTO public.orders(id,order_no,customer_id,customer_user_id,status,customer_name,customer_phone,customer_email,
    shipping_address,notes,subtotal,total,payment_method_id,idempotency_key,request_hash)
  VALUES(v_order,'ORD-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_order::text,1,8)),v_customer_id,
    auth.uid(),'new',btrim(p_customer->>'name'),btrim(p_customer->>'phone'),nullif(btrim(p_customer->>'email'),'')::extensions.citext,
    p_shipping_address,nullif(btrim(p_notes),''),0,0,v_method,p_idempotency_key,v_hash);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'product_id')::uuid,CASE WHEN nullif(value->>'variant_id','') IN ('standard', 'default') THEN NULL ELSE nullif(value->>'variant_id','')::uuid END LOOP
    v_qty := (v_line->>'quantity')::integer;
    v_variant_id := CASE WHEN nullif(v_line->>'variant_id','') IN ('standard', 'default') THEN NULL ELSE nullif(v_line->>'variant_id','')::uuid END;
    v_batch_id := nullif(v_line->>'batch_id','')::uuid;
    v_color := NULL;

    SELECT id,name,sku,coalesce(promotion_price,retail_price) sale_price INTO v_product FROM public.products
      WHERE id=(v_line->>'product_id')::uuid AND status='active' AND is_published FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot mavjud emas' USING errcode='P0002';
    END IF;

    v_sale_price := v_product.sale_price;

    -- If a specific batch was ordered, use the batch's retail price
    IF v_batch_id IS NOT NULL THEN
      SELECT sb.retail_price INTO v_batch_price
      FROM public.stock_batches sb
      WHERE sb.id = v_batch_id AND sb.product_id = v_product.id;
      IF v_batch_price IS NOT NULL AND v_batch_price > 0 THEN
        v_sale_price := v_batch_price;
      END IF;
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT id,color_name,coalesce(promotion_price,retail_price) sale_price INTO v_variant FROM public.product_variants
        WHERE id=v_variant_id AND product_id=v_product.id AND is_active FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Rang varianti mavjud emas' USING errcode='P0002';
      END IF;
      IF v_variant.sale_price IS NOT NULL THEN
        v_sale_price := v_variant.sale_price;
      END IF;
      v_color := v_variant.color_name;
    ELSE
      v_color := coalesce(
        nullif(btrim(v_line->>'variant_color'), ''),
        nullif(btrim(v_line->>'color_name'), ''),
        CASE WHEN EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = v_product.id AND pv.is_active) THEN 'Standart' ELSE NULL END
      );
    END IF;

    INSERT INTO public.order_lines(order_id,product_id,variant_id,product_name,sku,variant_color,quantity,unit_price,discount,line_total)
    VALUES(v_order,v_product.id,v_variant_id,v_product.name,v_product.sku,v_color,v_qty,v_sale_price,0,round(v_qty*v_sale_price,2));

    v_subtotal := v_subtotal + round(v_qty*v_sale_price,2);
  END LOOP;

  UPDATE public.orders SET subtotal=v_subtotal,total=v_subtotal WHERE id=v_order;
  INSERT INTO public.order_status_history(order_id,to_status,note,actor_id) VALUES(v_order,'new','Online buyurtma yaratildi',auth.uid());
  PERFORM public.enqueue_order_notification(v_order,'Buyurtma qabul qilindi','Buyurtmangiz qabul qilindi',jsonb_build_object('status','new'));

  RETURN v_order;
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.orders WHERE idempotency_key=p_idempotency_key;
  IF FOUND AND v_existing.request_hash=v_hash AND v_existing.customer_user_id IS NOT DISTINCT FROM auth.uid() THEN
    RETURN v_existing.id;
  END IF;
  RAISE;
END;
$$;

-- 8. Grants
GRANT EXECUTE ON FUNCTION public.storefront_catalog(text,uuid,integer,integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.storefront_catalog_faceted(jsonb,integer,integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.storefront_product_detail(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.storefront_products_by_ids(uuid[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_online_order(jsonb,jsonb,jsonb,text,text,text) TO anon, authenticated, service_role;
