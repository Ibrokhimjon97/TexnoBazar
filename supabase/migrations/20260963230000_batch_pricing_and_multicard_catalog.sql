-- Migration: 20260963230000_batch_pricing_and_multicard_catalog.sql
-- Enables batch-specific pricing so each inventory receipt retains its own retail and cost prices.
-- When a product has multiple active price tiers in stock, the storefront catalog outputs separate cards
-- for each distinct price level, with its own stock and direct add-to-cart capability.
-- Zero data loss: strictly preserves all existing products, stock batches, receipts, and units.

BEGIN;

-- 1. resolve_qr_for_storefront: return batch-specific retail price and batch_id
CREATE OR REPLACE FUNCTION public.resolve_qr_for_storefront(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'slug', p.slug,
    'name', p.name,
    'product_id', p.id,
    'variant_id', u.variant_id,
    'sku', p.sku,
    'brand_name', br.name,
    'image', coalesce(
      (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id and m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
      p.seo_image_url
    ),
    'retail_price', coalesce(sb.retail_price, p.retail_price),
    'retail_price_usd', coalesce(sb.retail_price_usd, p.retail_price_usd),
    'batch_id', u.batch_id,
    'status', p.status,
    'is_published', p.is_published
  )
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
  WHERE (upper(u.qr_code) = upper(btrim(p_code))
    OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
    AND p.status = 'active'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_qr_for_storefront(text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_qr_for_storefront(text) TO anon, authenticated, service_role;

-- 2. storefront_product_detail: include price_tiers array for multi-batch stock
CREATE OR REPLACE FUNCTION public.storefront_product_detail(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
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
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', pv.id, 'color_name', pv.color_name, 'color_hex', pv.color_hex,
          'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, p.retail_price),
          'retail_price', coalesce(pv.retail_price, p.retail_price),
          'compare_at_price', coalesce(pv.compare_at_price, p.compare_at_price),
          'cost_price', coalesce(pv.cost_price, p.cost_price),
          'image', (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1),
          'stock', (SELECT count(*) FROM public.inventory_units u JOIN public.locations l ON l.id = u.location_id WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL AND l.is_active AND l.type IN ('store', 'warehouse')),
          'media', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) ORDER BY m.is_primary DESC, m.sort_order, m.id) FROM public.product_media m WHERE m.variant_id = pv.id), '[]'::jsonb)
        ) ORDER BY pv.sort_order, pv.created_at), '[]'::jsonb)
        FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active) AS variants
    FROM public.products p
    JOIN public.categories c ON c.id = p.category_id AND c.is_active
    LEFT JOIN public.brands br ON br.id = p.brand_id
    WHERE p.slug = p_slug AND p.status = 'active' AND p.is_published AND (p.brand_id IS NULL OR br.is_active)
  ) x;
$function$;

-- 3. storefront_catalog: multi-card generation for distinct active batch prices
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
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', pv.id, 'color_name', pv.color_name, 'color_hex', pv.color_hex,
          'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, coalesce(apt.tier_price, p.retail_price)),
          'image', (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1)
        ) ORDER BY pv.sort_order, pv.created_at), '[]'::jsonb)
        FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active) AS variants
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

-- 4. storefront_catalog_faceted: multi-card faceted catalog with accurate pricing and counts
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
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', pv.id, 'color_name', pv.color_name, 'color_hex', pv.color_hex,
        'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, coalesce(apt.tier_price, p.retail_price)),
        'stock', (SELECT count(*) FROM public.inventory_units u WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL),
        'image', (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1)
      ) ORDER BY pv.sort_order, pv.created_at), '[]'::jsonb)
      FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active
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
    SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wf WHERE NOT EXISTS (
      SELECT 1 FROM public.product_attribute_values pav JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = s.product_id AND ad.code = wf.key AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wf.value)='array' THEN wf.value ELSE jsonb_build_array(wf.value) END) w
        WHERE pav.value = w.value OR (jsonb_typeof(pav.value)='array' AND pav.value @> jsonb_build_array(w.value))
      )
    )
  )
),
brand_facet_source AS (
  SELECT s.* FROM category_scope s CROSS JOIN input i WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wf WHERE NOT EXISTS (
      SELECT 1 FROM public.product_attribute_values pav JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = s.product_id AND ad.code = wf.key AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wf.value)='array' THEN wf.value ELSE jsonb_build_array(wf.value) END) w
        WHERE pav.value = w.value OR (jsonb_typeof(pav.value)='array' AND pav.value @> jsonb_build_array(w.value))
      )
    )
  )
),
price_dimensions AS (
  SELECT s.* FROM searched s CROSS JOIN input i WHERE
    (coalesce(jsonb_array_length(i.f->'category_ids'),0)=0 OR s.category_id::text IN (SELECT jsonb_array_elements_text(i.f->'category_ids')))
    AND (coalesce(jsonb_array_length(i.f->'brand_ids'),0)=0 OR s.brand_id::text IN (SELECT jsonb_array_elements_text(i.f->'brand_ids')))
),
price_facet_source AS (
  SELECT s.* FROM price_dimensions s CROSS JOIN input i WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wf WHERE NOT EXISTS (
      SELECT 1 FROM public.product_attribute_values pav JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = s.product_id AND ad.code = wf.key AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wf.value)='array' THEN wf.value ELSE jsonb_build_array(wf.value) END) w
        WHERE pav.value = w.value OR (jsonb_typeof(pav.value)='array' AND pav.value @> jsonb_build_array(w.value))
      )
    )
  )
),
ordered AS (
  SELECT s.* FROM filtered s CROSS JOIN input i ORDER BY
    CASE WHEN i.f->>'sort'='cheap' THEN effective_price END ASC,
    CASE WHEN i.f->>'sort'='expensive' THEN effective_price END DESC,
    CASE WHEN i.f->>'sort'='new' THEN created_at END DESC,
    name, retail_price, id
)
SELECT jsonb_build_object(
  'items', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM ordered LIMIT greatest(1, least(p_limit, 100)) OFFSET greatest(p_offset, 0)) x), '[]'::jsonb),
  'total', (SELECT count(*) FROM filtered),
  'facets', jsonb_build_object(
    'categories', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.name) FROM (SELECT c.id, c.name, count(distinct f.id) count FROM category_facet_source f JOIN public.categories c ON c.id = f.category_id GROUP BY c.id, c.name) x), '[]'::jsonb),
    'brands', coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.name) FROM (SELECT br.id, br.name, count(distinct f.id) count FROM brand_facet_source f JOIN public.brands br ON br.id = f.brand_id GROUP BY br.id, br.name) x), '[]'::jsonb),
    'attributes', coalesce((SELECT jsonb_object_agg(code, values) FROM (
      SELECT code, jsonb_agg(jsonb_build_object('value', value_json, 'count', match_count) ORDER BY value_text) values FROM (
        SELECT candidate.code, candidate.value_json, candidate.value_text, (
          SELECT count(distinct candidate_product.id)
          FROM selected_dimensions candidate_product CROSS JOIN input i
          WHERE EXISTS (
            SELECT 1 FROM public.product_attribute_values cpv JOIN public.attribute_definitions cad ON cad.id = cpv.attribute_id
            WHERE cpv.product_id = candidate_product.product_id AND cad.code = candidate.code
              AND (cpv.value = candidate.value_json OR (jsonb_typeof(cpv.value)='array' AND cpv.value @> jsonb_build_array(candidate.value_json)))
          ) AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) selected_filter
            WHERE selected_filter.key <> candidate.code AND NOT EXISTS (
              SELECT 1 FROM public.product_attribute_values opv JOIN public.attribute_definitions oad ON oad.id = opv.attribute_id
              WHERE opv.product_id = candidate_product.product_id AND oad.code = selected_filter.key AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(selected_filter.value)='array' THEN selected_filter.value ELSE jsonb_build_array(selected_filter.value) END) wanted
                WHERE opv.value = wanted.value OR (jsonb_typeof(opv.value)='array' AND opv.value @> jsonb_build_array(wanted.value))
              )
            )
          )
        ) match_count FROM (
          SELECT distinct ad.code, pav.value value_json, pav.value::text value_text
          FROM selected_dimensions candidate_product
          JOIN public.product_attribute_values pav ON pav.product_id = candidate_product.product_id
          JOIN public.attribute_definitions ad ON ad.id = pav.attribute_id AND ad.is_filterable
        ) candidate
      ) attr_matches WHERE match_count > 0 GROUP BY code
    ) x), '{}'::jsonb),
    'price', coalesce((SELECT jsonb_build_object('min', min(effective_price), 'max', max(effective_price)) FROM price_facet_source), jsonb_build_object('min', 0, 'max', 0))
  )
);
$$;

-- 5. storefront_products_by_ids: return card entries for multi-tier batches
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
    WHERE u.status = 'available' AND u.active_transfer_id IS NULL
      AND p.id = any(coalesce(p_product_ids, '{}'::uuid[]))
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
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', pv.id, 'color_name', pv.color_name, 'color_hex', pv.color_hex,
          'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, coalesce(apt.tier_price, p.retail_price)),
          'stock', (SELECT count(*) FROM public.inventory_units u WHERE u.variant_id = pv.id AND u.status = 'available' AND u.active_transfer_id IS NULL),
          'image', (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = pv.id ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1)
        ) ORDER BY pv.sort_order, pv.created_at), '[]'::jsonb)
        FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active) AS variants
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

-- 6. create_online_order: honor batch_id when specified
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
    'lines',(SELECT jsonb_agg(jsonb_build_object('product_id',(e->>'product_id')::uuid,'variant_id',nullif(e->>'variant_id','')::uuid,'batch_id',nullif(e->>'batch_id','')::uuid,'quantity',(e->>'quantity')::integer)
      ORDER BY (e->>'product_id')::uuid,nullif(e->>'variant_id','')::uuid,nullif(e->>'batch_id','')::uuid) FROM jsonb_array_elements(p_lines) e),'payment_method_code',lower(btrim(p_payment_method_code)),
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

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'product_id')::uuid,nullif(value->>'variant_id','')::uuid LOOP
    v_qty := (v_line->>'quantity')::integer;
    v_variant_id := nullif(v_line->>'variant_id','')::uuid;
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

GRANT EXECUTE ON FUNCTION public.storefront_catalog(text,uuid,integer,integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.storefront_catalog_faceted(jsonb,integer,integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.storefront_product_detail(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.storefront_products_by_ids(uuid[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_online_order(jsonb,jsonb,jsonb,text,text,text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
