-- Migration: Modular product components / tarkibiy qismlar system
BEGIN;

-- 1. Create table public.product_components
CREATE TABLE IF NOT EXISTS public.product_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name text NOT NULL,
  color_name text,
  color_hex text,
  cost_price numeric(18,2),
  cost_price_usd numeric(18,2),
  retail_price numeric(18,2),
  retail_price_usd numeric(18,2),
  wholesale_price numeric(18,2),
  wholesale_price_usd numeric(18,2),
  is_default boolean NOT NULL DEFAULT false,
  is_required boolean NOT NULL DEFAULT false,
  can_buy_standalone boolean NOT NULL DEFAULT true,
  image_url text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_components_product_id ON public.product_components(product_id, sort_order);

-- 2. Add selected_components column to order_lines, pos_pending_sale_lines, sale_lines, customer_cart_items
ALTER TABLE public.order_lines ADD COLUMN IF NOT EXISTS selected_components jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.pos_pending_sale_lines ADD COLUMN IF NOT EXISTS selected_components jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.sale_lines ADD COLUMN IF NOT EXISTS selected_components jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.customer_cart_items ADD COLUMN IF NOT EXISTS selected_components jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.customer_cart_items ADD COLUMN IF NOT EXISTS is_standalone_component boolean NOT NULL DEFAULT false;
ALTER TABLE public.customer_cart_items ADD COLUMN IF NOT EXISTS component_id uuid REFERENCES public.product_components(id) ON DELETE SET NULL;

-- 3. RLS on product_components
ALTER TABLE public.product_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone_read_active_components" ON public.product_components;
CREATE POLICY "anyone_read_active_components" ON public.product_components
  FOR SELECT USING (is_active = true OR public.is_any_manager() OR public.has_role(array['superadmin','admin']::public.app_role[], null));

DROP POLICY IF EXISTS "managers_write_components" ON public.product_components;
CREATE POLICY "managers_write_components" ON public.product_components
  FOR ALL TO authenticated
  USING (public.is_any_manager() OR public.has_role(array['superadmin','admin']::public.app_role[], null))
  WITH CHECK (public.is_any_manager() OR public.has_role(array['superadmin','admin']::public.app_role[], null));

GRANT ALL ON public.product_components TO authenticated, service_role;
GRANT SELECT ON public.product_components TO anon;

-- 4. RPC save_product_components
CREATE OR REPLACE FUNCTION public.save_product_components(p_product_id uuid, p_components jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_item jsonb;
  v_id uuid;
  v_keep uuid[] := '{}';
  v_sort integer := 0;
  v_rate numeric;
  v_cost_uzs numeric;
  v_cost_usd numeric;
  v_ret_uzs numeric;
  v_ret_usd numeric;
  v_whl_uzs numeric;
  v_whl_usd numeric;
BEGIN
  IF NOT (public.is_any_manager() OR public.has_role(array['superadmin','admin']::public.app_role[], null)) THEN
    RAISE EXCEPTION 'Tarkibiy qismlarni saqlash uchun admin yoki menejer roli talab qilinadi' USING errcode = '42501';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'Mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  IF jsonb_typeof(p_components) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Tarkibiy qismlar massiv bo‘lishi kerak' USING errcode = '22023';
  END IF;

  IF jsonb_array_length(p_components) > 50 THEN
    RAISE EXCEPTION 'Bir mahsulotda 50 tadan ortiq tarkibiy qism bo‘lishi mumkin emas' USING errcode = '22023';
  END IF;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    IF nullif(btrim(v_item->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Tarkibiy qism nomi kiritilishi shart' USING errcode = '22023';
    END IF;

    v_cost_uzs := nullif(v_item->>'cost_price', '')::numeric;
    v_cost_usd := nullif(v_item->>'cost_price_usd', '')::numeric;
    IF v_cost_uzs IS NOT NULL AND v_cost_usd IS NULL AND v_rate > 0 THEN
      v_cost_usd := round(v_cost_uzs / v_rate, 2);
    ELSIF v_cost_usd IS NOT NULL AND v_cost_uzs IS NULL AND v_rate > 0 THEN
      v_cost_uzs := round(v_cost_usd * v_rate);
    END IF;

    v_ret_uzs := nullif(v_item->>'retail_price', '')::numeric;
    v_ret_usd := nullif(v_item->>'retail_price_usd', '')::numeric;
    IF v_ret_uzs IS NOT NULL AND v_ret_usd IS NULL AND v_rate > 0 THEN
      v_ret_usd := round(v_ret_uzs / v_rate, 2);
    ELSIF v_ret_usd IS NOT NULL AND v_ret_uzs IS NULL AND v_rate > 0 THEN
      v_ret_uzs := round(v_ret_usd * v_rate);
    END IF;

    v_whl_uzs := nullif(v_item->>'wholesale_price', '')::numeric;
    v_whl_usd := nullif(v_item->>'wholesale_price_usd', '')::numeric;
    IF v_whl_uzs IS NOT NULL AND v_whl_usd IS NULL AND v_rate > 0 THEN
      v_whl_usd := round(v_whl_uzs / v_rate, 2);
    ELSIF v_whl_usd IS NOT NULL AND v_whl_uzs IS NULL AND v_rate > 0 THEN
      v_whl_uzs := round(v_whl_usd * v_rate);
    END IF;

    v_id := nullif(v_item->>'id', '')::uuid;
    IF v_id IS NULL THEN
      INSERT INTO public.product_components (
        product_id, name, color_name, color_hex,
        cost_price, cost_price_usd,
        retail_price, retail_price_usd,
        wholesale_price, wholesale_price_usd,
        is_default, is_required, can_buy_standalone,
        image_url, sort_order, is_active
      ) VALUES (
        p_product_id,
        btrim(v_item->>'name'),
        nullif(btrim(v_item->>'color_name'), ''),
        nullif(btrim(v_item->>'color_hex'), ''),
        v_cost_uzs, v_cost_usd,
        v_ret_uzs, v_ret_usd,
        v_whl_uzs, v_whl_usd,
        coalesce((v_item->>'is_default')::boolean, false),
        coalesce((v_item->>'is_required')::boolean, false),
        coalesce((v_item->>'can_buy_standalone')::boolean, true),
        nullif(btrim(v_item->>'image_url'), ''),
        v_sort,
        coalesce((v_item->>'is_active')::boolean, true)
      ) RETURNING id INTO v_id;
    ELSE
      UPDATE public.product_components SET
        name = btrim(v_item->>'name'),
        color_name = nullif(btrim(v_item->>'color_name'), ''),
        color_hex = nullif(btrim(v_item->>'color_hex'), ''),
        cost_price = v_cost_uzs,
        cost_price_usd = v_cost_usd,
        retail_price = v_ret_uzs,
        retail_price_usd = v_ret_usd,
        wholesale_price = v_whl_uzs,
        wholesale_price_usd = v_whl_usd,
        is_default = coalesce((v_item->>'is_default')::boolean, false),
        is_required = coalesce((v_item->>'is_required')::boolean, false),
        can_buy_standalone = coalesce((v_item->>'can_buy_standalone')::boolean, true),
        image_url = nullif(btrim(v_item->>'image_url'), ''),
        sort_order = v_sort,
        is_active = coalesce((v_item->>'is_active')::boolean, true),
        updated_at = now()
      WHERE id = v_id AND product_id = p_product_id;
    END IF;

    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
  END LOOP;

  -- Soft delete / hard delete components removed from list
  UPDATE public.product_components
  SET is_active = false, updated_at = now()
  WHERE product_id = p_product_id
    AND NOT (id = ANY(v_keep))
    AND is_active = true;

  RETURN coalesce(
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sort_order, c.created_at)
     FROM public.product_components c
     WHERE c.product_id = p_product_id AND c.is_active = true),
    '[]'::jsonb
  );
END;
$function$;

-- 5. RPC get_product_components
CREATE OR REPLACE FUNCTION public.get_product_components(p_product_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(
    (SELECT jsonb_agg(to_jsonb(pc) ORDER BY pc.sort_order, pc.created_at)
     FROM public.product_components pc
     WHERE pc.product_id = p_product_id AND pc.is_active = true),
    '[]'::jsonb
  );
$function$;

GRANT EXECUTE ON FUNCTION public.save_product_components(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_components(uuid) TO anon, authenticated, service_role;

-- 6. Update get_catalog_product to include components
CREATE OR REPLACE FUNCTION public.get_catalog_product(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.require_catalog_admin();
  SELECT to_jsonb(p) || jsonb_build_object(
    'category_name', c.name,
    'brand_name', b.name,
    'media', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.is_primary DESC, m.sort_order, m.created_at) FROM public.product_media m WHERE m.product_id = p.id), '[]'::jsonb),
    'attributes', coalesce((SELECT jsonb_agg(jsonb_build_object('attribute_id', v.attribute_id, 'value', v.value)) FROM public.product_attribute_values v WHERE v.product_id = p.id), '[]'::jsonb),
    'variants', coalesce((
      SELECT jsonb_agg(to_jsonb(pv) || jsonb_build_object(
        'stock', (SELECT count(*) FROM public.inventory_units u WHERE u.variant_id = pv.id AND u.status = 'available'),
        'media', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.is_primary DESC, m.sort_order, m.created_at) FROM public.product_media m WHERE m.variant_id = pv.id), '[]'::jsonb)
      ) ORDER BY pv.sort_order, pv.created_at)
      FROM public.product_variants pv WHERE pv.product_id = p.id
    ), '[]'::jsonb),
    'components', coalesce((
      SELECT jsonb_agg(to_jsonb(pc) ORDER BY pc.sort_order, pc.created_at)
      FROM public.product_components pc
      WHERE pc.product_id = p.id AND pc.is_active = true
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.products p
  LEFT JOIN public.categories c ON c.id = p.category_id
  LEFT JOIN public.brands b ON b.id = p.brand_id
  WHERE p.id = p_product_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Mahsulot topilmadi' USING errcode = 'P0002';
  END IF;
  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_catalog_product(uuid) TO authenticated, service_role;

-- 7. Update storefront_product_detail to include components
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
        FROM public.product_variants pv WHERE pv.product_id = p.id AND pv.is_active) AS variants,
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

GRANT EXECUTE ON FUNCTION public.storefront_product_detail(text) TO anon, authenticated, service_role;

-- 8. Update get_pos_unit_context to include components
CREATE OR REPLACE FUNCTION public.get_pos_unit_context(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_unit record;
  v_rate numeric;
  v_sale jsonb := null;
  v_result jsonb;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT
    u.id, u.qr_code, u.serial_number, u.status, u.location_id, u.active_transfer_id, u.sold_sale_id,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug,
    p.status as product_status, p.is_published,
    br.name as brand_name,
    p.retail_price, p.wholesale_price, p.minimum_sale_price, p.tax_rate,
    coalesce(sb.unit_cost, p.cost_price) as unit_cost,
    l.name as location_name, l.type as location_type, l.is_active as location_active,
    l.branch_id as unit_branch_id,
    ub.name as unit_branch_name,
    ub.code as unit_branch_code,
    (l.branch_id = p_branch_id) as in_current_branch,
    (l.branch_id = p_branch_id and l.is_active and l.type in ('store','warehouse')
      and u.status = 'available' and u.active_transfer_id is null and p.status = 'active') as is_sellable,
    (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) as image
  INTO v_unit
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.branches ub ON ub.id = l.branch_id AND ub.is_active
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  WHERE l.type IN ('store', 'warehouse')
    AND (
      upper(u.qr_code) = upper(v_code)
      OR upper(coalesce(u.serial_number, '')) = upper(v_code)
      OR (l.branch_id = p_branch_id AND l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL
        AND (upper(coalesce(p.barcode, '')) = upper(v_code) OR upper(p.sku) = upper(v_code)))
    )
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0
         WHEN upper(coalesce(u.serial_number, '')) = upper(v_code) THEN 1
         ELSE 2 END,
    u.id
  LIMIT 1;

  IF v_unit.id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot birligi topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_unit.sold_sale_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'sale_id', s.id,
      'sale_no', s.sale_no,
      'sold_at', s.sold_at,
      'status', s.status,
      'branch_id', s.branch_id,
      'branch_name', b.name,
      'in_current_branch', s.branch_id = p_branch_id,
      'details_visible', s.branch_id = p_branch_id,
      'seller_name', CASE WHEN s.branch_id = p_branch_id THEN seller.full_name END,
      'manager_name', CASE WHEN s.branch_id = p_branch_id THEN manager.full_name END,
      'customer_name', CASE WHEN s.branch_id = p_branch_id THEN c.full_name END,
      'customer_phone', CASE WHEN s.branch_id = p_branch_id THEN c.phone END,
      'unit_price', CASE WHEN s.branch_id = p_branch_id THEN x.unit_price END,
      'discount', CASE WHEN s.branch_id = p_branch_id THEN x.discount END,
      'tax', CASE WHEN s.branch_id = p_branch_id THEN x.tax END,
      'line_total', CASE WHEN s.branch_id = p_branch_id THEN x.line_total END,
      'sale_total', CASE WHEN s.branch_id = p_branch_id THEN s.total END,
      'payments', CASE WHEN s.branch_id = p_branch_id THEN coalesce((
        SELECT jsonb_agg(jsonb_build_object('method_name', pm.name, 'amount', sp.amount) ORDER BY sp.paid_at, sp.id)
        FROM public.sale_payments sp JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
        WHERE sp.sale_id = s.id), '[]'::jsonb) END
    )
    INTO v_sale
    FROM public.sales s
    JOIN public.branches b ON b.id = s.branch_id
    LEFT JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    LEFT JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.sale_lines x ON x.sale_id = s.id AND x.unit_id = v_unit.id
    WHERE s.id = v_unit.sold_sale_id;
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC
  LIMIT 1;

  SELECT jsonb_build_object(
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'is_sellable', v_unit.is_sellable,
    'location_id', v_unit.location_id,
    'location_name', v_unit.location_name,
    'location_type', v_unit.location_type,
    'location_active', v_unit.location_active,
    'unit_branch_id', v_unit.unit_branch_id,
    'unit_branch_name', v_unit.unit_branch_name,
    'unit_branch_code', v_unit.unit_branch_code,
    'requested_branch_id', p_branch_id,
    'in_current_branch', v_unit.in_current_branch,
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'product_status', v_unit.product_status,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'brand_name', v_unit.brand_name,
    'image', v_unit.image,
    'storefront_url', CASE WHEN v_unit.product_status = 'active' AND v_unit.is_published AND v_unit.slug IS NOT NULL
      THEN '/product/' || v_unit.slug ELSE null END,
    'sale', v_sale,
    'exchange_rate', v_rate,
    'prices', jsonb_build_object(
      'retail_price_uzs', v_unit.retail_price,
      'retail_price_usd', CASE WHEN v_rate > 0 THEN round(v_unit.retail_price / v_rate, 2) ELSE null END,
      'wholesale_price_uzs', v_unit.wholesale_price,
      'wholesale_price_usd', CASE WHEN v_rate > 0 AND v_unit.wholesale_price IS NOT NULL THEN round(v_unit.wholesale_price / v_rate, 2) ELSE null END,
      'minimum_sale_price_uzs', v_unit.minimum_sale_price,
      'minimum_sale_price_usd', CASE WHEN v_rate > 0 THEN round(v_unit.minimum_sale_price / v_rate, 2) ELSE null END,
      'unit_cost_uzs', v_unit.unit_cost,
      'tax_rate', v_unit.tax_rate
    ),
    'branch_stock', jsonb_build_object(
      'store', (SELECT count(*) FROM public.inventory_units a JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = v_unit.product_id AND al.branch_id = v_unit.unit_branch_id AND al.type = 'store'
          AND al.is_active AND a.status = 'available' AND a.active_transfer_id IS NULL),
      'warehouse', (SELECT count(*) FROM public.inventory_units a JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = v_unit.product_id AND al.branch_id = v_unit.unit_branch_id AND al.type = 'warehouse'
          AND al.is_active AND a.status = 'available' AND a.active_transfer_id IS NULL)
    ),
    'other_branches', coalesce((
      SELECT jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', q.qty) ORDER BY q.qty DESC)
      FROM (
        SELECT al.branch_id, count(*) as qty
        FROM public.inventory_units a
        JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = v_unit.product_id AND al.is_active AND al.type in ('store', 'warehouse')
          AND a.status = 'available' AND a.active_transfer_id is null AND al.branch_id <> v_unit.unit_branch_id
        GROUP BY al.branch_id
      ) q
      JOIN public.branches b ON b.id = q.branch_id
    ), '[]'::jsonb),
    'components', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
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
      ) ORDER BY pc.sort_order, pc.created_at)
      FROM public.product_components pc
      WHERE pc.product_id = v_unit.product_id AND pc.is_active = true
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;

-- 9. Update create_pos_pending_sale to save selected_components
CREATE OR REPLACE FUNCTION public.create_pos_pending_sale(
  p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_idempotency_key uuid,
  p_notes text default null, p_customer jsonb default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_existing public.pos_pending_sales%rowtype;
  v_item jsonb;
  v_u public.inventory_units%rowtype;
  v_p record;
  v_unit_id uuid;
  v_price numeric(18,2);
  v_discount numeric(18,2);
  v_tax numeric(18,2);
  v_line_total numeric(18,2);
  v_subtotal numeric(18,2) := 0;
  v_discount_total numeric(18,2) := 0;
  v_tax_total numeric(18,2) := 0;
  v_total numeric(18,2);
  v_paid numeric(18,2) := 0;
  v_store uuid;
  v_first_location uuid;
  v_method public.payment_methods%rowtype;
  v_norm_lines jsonb;
  v_norm_payments jsonb;
  v_hash text;
  v_minutes integer := 15;
  v_sort integer := 0;
  v_is_seller boolean;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_phone text;
  v_customer_address text;
  v_sel_comps jsonb;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF p_idempotency_key IS NULL OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
    OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50 OR p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array'
    OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'POS qatorlari yoki to‘lovlari noto‘g‘ri' USING errcode = '22023';
  END IF;

  BEGIN
    SELECT jsonb_agg(jsonb_build_object('unit_id', q.unit_id::text, 'unit_price', q.unit_price, 'discount', q.discount, 'selected_components', q.selected_components) ORDER BY q.unit_id)
      INTO v_norm_lines FROM (
        SELECT (e->>'unit_id')::uuid unit_id, (e->>'unit_price')::numeric(18,2) unit_price,
          coalesce((e->>'discount')::numeric(18,2), 0) discount,
          coalesce(e->'selected_components', '[]'::jsonb) selected_components
        FROM jsonb_array_elements(p_lines) e
      ) q;

    SELECT jsonb_agg(jsonb_build_object('method_code', q.method_code, 'amount', q.amount, 'external_reference', q.external_reference)
      ORDER BY q.method_code, q.amount, q.external_reference nulls first)
      INTO v_norm_payments FROM (
        SELECT lower(btrim(e->>'method_code')) method_code, (e->>'amount')::numeric(18,2) amount,
          nullif(btrim(e->>'external_reference'), '') external_reference
        FROM jsonb_array_elements(p_payments) e
      ) q;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'POS identifikatori yoki summasi noto‘g‘ri' USING errcode = '22023';
  END;

  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) e GROUP BY (e->>'unit_id')::uuid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Mahsulot birliklari takrorlanmasligi kerak' USING errcode = '22023';
  END IF;

  v_customer_name := nullif(btrim(p_customer->>'full_name'), '');
  v_customer_phone := nullif(btrim(p_customer->>'phone'), '');
  v_customer_address := nullif(btrim(p_customer->>'address'), '');
  IF v_customer_phone IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM public.customers WHERE phone = v_customer_phone;
    IF v_customer_id IS NULL THEN
      INSERT INTO public.customers(full_name, phone, address)
      VALUES(coalesce(v_customer_name, v_customer_phone), v_customer_phone,
        CASE WHEN v_customer_address IS NOT NULL THEN jsonb_build_object('address', v_customer_address) ELSE '{}'::jsonb END)
      RETURNING id INTO v_customer_id;
    ELSIF v_customer_name IS NOT NULL OR v_customer_address IS NOT NULL THEN
      UPDATE public.customers SET
        full_name = coalesce(v_customer_name, full_name),
        address = CASE WHEN v_customer_address IS NOT NULL THEN jsonb_build_object('address', v_customer_address) ELSE address END,
        updated_at = now()
      WHERE id = v_customer_id;
    END IF;
  END IF;

  v_hash := encode(extensions.digest(convert_to(jsonb_build_object('branch_id', p_branch_id::text, 'notes', nullif(btrim(p_notes), ''),
    'lines', v_norm_lines, 'payments', v_norm_payments, 'customer_phone', v_customer_phone)::text, 'UTF8'), 'sha256'), 'hex');

  SELECT * INTO v_existing FROM public.pos_pending_sales WHERE seller_id = auth.uid() AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'Takroriy kalit boshqa POS mazmuni bilan yuborildi' USING errcode = '22023';
    END IF;
    RETURN public.get_pos_pending_sale(v_existing.id);
  END IF;

  PERFORM 1 FROM public.inventory_units u WHERE u.id IN (SELECT (e->>'unit_id')::uuid FROM jsonb_array_elements(p_lines) e)
    ORDER BY u.id FOR UPDATE;

  v_is_seller := public.has_role(array['seller']::public.app_role[], p_branch_id)
    AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], p_branch_id));

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'unit_id')::uuid LOOP
    v_unit_id := (v_item->>'unit_id')::uuid;
    v_price := (v_item->>'unit_price')::numeric(18,2);
    v_discount := coalesce((v_item->>'discount')::numeric(18,2), 0);

    SELECT * INTO v_u FROM public.inventory_units WHERE id = v_unit_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot birligi topilmadi: %', v_unit_id USING errcode = 'P0002';
    END IF;

    SELECT p.*, l.branch_id, l.type location_type, l.is_active location_active
    INTO v_p FROM public.products p
    JOIN public.locations l ON l.id = v_u.location_id WHERE p.id = v_u.product_id;

    IF v_p.branch_id <> p_branch_id OR v_p.location_type NOT IN ('store','warehouse') OR NOT v_p.location_active
      OR v_u.status <> 'available' OR v_u.active_transfer_id IS NOT NULL THEN
      RAISE EXCEPTION 'Mahsulot POS uchun erkin emas: %', v_unit_id USING errcode = 'P0001';
    END IF;

    IF v_p.status <> 'active' THEN
      RAISE EXCEPTION 'Mahsulot faol emas: %', v_unit_id USING errcode = 'P0001';
    END IF;

    IF v_first_location IS NULL THEN v_first_location := v_u.location_id; END IF;
    IF v_store IS NULL AND v_p.location_type = 'store' THEN v_store := v_u.location_id; END IF;

    IF v_price IS NULL OR v_discount IS NULL OR v_price <= 0 OR v_price > (v_p.retail_price * 5) THEN
      RAISE EXCEPTION 'Sotuv narxi ruxsat etilgan chegaradan tashqarida' USING errcode = '22023';
    END IF;

    IF v_discount < 0 OR v_discount > v_price OR (v_is_seller AND v_discount > round(v_price * 0.20, 2)) THEN
      RAISE EXCEPTION 'Chegirma ruxsat etilgan chegaradan oshdi' USING errcode = '22023';
    END IF;

    v_tax := round((v_price - v_discount) * v_p.tax_rate / 100, 2);
    v_line_total := v_price - v_discount + v_tax;
    v_subtotal := v_subtotal + v_price;
    v_discount_total := v_discount_total + v_discount;
    v_tax_total := v_tax_total + v_tax;
  END LOOP;

  IF v_store IS NULL THEN
    SELECT id INTO v_store FROM public.locations
    WHERE branch_id = p_branch_id AND type = 'store' AND is_active ORDER BY created_at LIMIT 1;
  END IF;
  v_store := coalesce(v_store, v_first_location);
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'POS joylashuvi topilmadi' USING errcode = 'P0002';
  END IF;

  v_total := v_subtotal - v_discount_total + v_tax_total;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'POS jami summasi musbat bo‘lishi kerak' USING errcode = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active AND code <> 'cod';
    IF NOT FOUND OR nullif(btrim(v_item->>'method_code'), '') IS NULL OR (v_item->>'amount') IS NULL OR (v_item->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'Faol POS to‘lov usuli yoki summa noto‘g‘ri' USING errcode = '22023';
    END IF;
    v_paid := v_paid + (v_item->>'amount')::numeric(18,2);
  END LOOP;

  IF v_paid <> v_total THEN
    RAISE EXCEPTION 'To‘lovlar jami sotuv summasiga teng emas' USING errcode = '22023';
  END IF;

  BEGIN
    SELECT greatest(1, least(120, (value#>>'{}')::integer)) INTO v_minutes FROM public.system_settings WHERE key = 'pos.reservation_minutes';
  EXCEPTION WHEN others THEN
    v_minutes := 15;
  END;

  INSERT INTO public.pos_pending_sales(
    id, pending_no, branch_id, store_location_id, seller_id, customer_id, status, subtotal, discount, tax, total,
    expires_at, idempotency_key, request_hash, notes
  ) VALUES (
    v_id, 'POS-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(v_id::text, 1, 8)),
    p_branch_id, v_store, auth.uid(), v_customer_id, 'pending', v_subtotal, v_discount_total, v_tax_total, v_total,
    now() + make_interval(mins => v_minutes), p_idempotency_key, v_hash, nullif(btrim(p_notes), '')
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'unit_id')::uuid LOOP
    v_unit_id := (v_item->>'unit_id')::uuid;
    v_price := (v_item->>'unit_price')::numeric(18,2);
    v_discount := coalesce((v_item->>'discount')::numeric(18,2), 0);
    v_sel_comps := coalesce(v_item->'selected_components', '[]'::jsonb);

    SELECT * INTO v_u FROM public.inventory_units WHERE id = v_unit_id;
    v_tax := round((v_price - v_discount) * (SELECT tax_rate FROM public.products WHERE id = v_u.product_id) / 100, 2);

    INSERT INTO public.pos_pending_sale_lines(
      pending_sale_id, product_id, unit_id, unit_price, discount, tax, line_total, selected_components
    ) VALUES (
      v_id, v_u.product_id, v_u.id, v_price, v_discount, v_tax, v_price - v_discount + v_tax, v_sel_comps
    );

    UPDATE public.inventory_units
    SET status = 'reserved', reserved_until = now() + make_interval(mins => v_minutes), version = version + 1
    WHERE id = v_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, reference_type, reference_id, actor_id
    ) VALUES (
      v_u.id, v_u.product_id, v_u.batch_id, 'reserved', v_u.location_id, v_u.location_id, 1, 'pos_pending_sale', v_id, auth.uid()
    );
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
    INSERT INTO public.pos_pending_sale_payments(pending_sale_id, payment_method_id, amount, external_reference, sort_order)
    VALUES (v_id, v_method.id, (v_item->>'amount')::numeric(18,2), nullif(btrim(v_item->>'external_reference'), ''), v_sort);
  END LOOP;

  RETURN public.get_pos_pending_sale(v_id);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.pos_pending_sales WHERE seller_id = auth.uid() AND idempotency_key = p_idempotency_key;
  IF FOUND AND v_existing.request_hash = v_hash THEN RETURN public.get_pos_pending_sale(v_existing.id); END IF;
  IF FOUND THEN RAISE EXCEPTION 'Takroriy kalit boshqa POS mazmuni bilan yuborildi' USING errcode = '22023'; END IF;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_pos_pending_sale(uuid, jsonb, jsonb, uuid, text, jsonb) TO authenticated, service_role;

-- 10. Update manager_confirm_sale to forward selected_components to sale_lines
CREATE OR REPLACE FUNCTION public.manager_confirm_sale(p_pending_sale_id uuid, p_payments jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_sale uuid;
  v_x record;
  v_item jsonb;
  v_method public.payment_methods%rowtype;
  v_paid numeric(18,2) := 0;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_s FROM public.pos_pending_sales WHERE id = p_pending_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  PERFORM public.require_pos_manager(v_s.branch_id);
  IF v_s.status = 'confirmed' THEN
    SELECT id INTO v_sale FROM public.sales WHERE pending_sale_id = v_s.id;
    IF v_sale IS NULL THEN
      RAISE EXCEPTION 'Tasdiqlangan POS so‘rovi uchun sotuv topilmadi' USING errcode = 'P0001';
    END IF;
    RETURN v_sale;
  END IF;

  IF v_s.status <> 'pending' THEN
    RAISE EXCEPTION 'Faqat kutilayotgan POS so‘rovi tasdiqlanadi' USING errcode = 'P0001';
  END IF;

  IF v_s.expires_at <= now() THEN
    PERFORM public.release_pos_reservation(v_s.id, 'expired', 'Rezerv muddati tugadi', auth.uid());
    RETURN null;
  END IF;

  PERFORM 1 FROM public.inventory_units u
  JOIN public.pos_pending_sale_lines x ON x.unit_id = u.id
  WHERE x.pending_sale_id = v_s.id ORDER BY u.id FOR UPDATE OF u;

  IF EXISTS(
    SELECT 1 FROM public.inventory_units u
    JOIN public.pos_pending_sale_lines x ON x.unit_id = u.id
    JOIN public.locations l ON l.id = u.location_id
    WHERE x.pending_sale_id = v_s.id AND (
      u.status <> 'reserved' OR u.reserved_until <= now() OR u.sold_sale_id IS NOT NULL
      OR u.active_transfer_id IS NOT NULL OR l.branch_id <> v_s.branch_id OR NOT l.is_active
      OR l.type NOT IN ('store','warehouse')
    )
  ) THEN
    RAISE EXCEPTION 'Rezervdagi mahsulot holati buzilgan' USING errcode = 'P0001';
  END IF;

  IF p_payments IS NULL THEN
    SELECT count(*), coalesce(sum(amount), 0) INTO v_count, v_paid FROM public.pos_pending_sale_payments WHERE pending_sale_id = v_s.id;
  ELSE
    IF jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION 'To‘lovlar ro‘yxati noto‘g‘ri' USING errcode = '22023';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active AND code <> 'cod';
      IF NOT FOUND OR (v_item->>'amount') IS NULL OR (v_item->>'amount')::numeric <= 0 THEN
        RAISE EXCEPTION 'POS to‘lov usuli yoki summasi noto‘g‘ri' USING errcode = '22023';
      END IF;
      v_paid := v_paid + (v_item->>'amount')::numeric(18,2);
      v_count := v_count + 1;
    END LOOP;
  END IF;

  IF v_count NOT BETWEEN 1 AND 10 OR v_paid <> v_s.total THEN
    RAISE EXCEPTION 'To‘lovlar jami sotuv summasiga teng emas' USING errcode = '22023';
  END IF;

  v_sale := gen_random_uuid();
  INSERT INTO public.sales(
    id, sale_no, branch_id, seller_id, manager_id, customer_id, pending_sale_id, status, subtotal, discount, tax, total
  ) VALUES (
    v_sale, 'SAL-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(v_sale::text, 1, 8)),
    v_s.branch_id, v_s.seller_id, auth.uid(), v_s.customer_id, v_s.id, 'completed', v_s.subtotal, v_s.discount, v_s.tax, v_s.total
  );

  PERFORM set_config('texnobazar.manager_confirm_sale', 'allowed', true);

  FOR v_x IN
    SELECT x.*, u.batch_id, u.location_id, coalesce(sb.unit_cost, p.cost_price) as unit_cost
    FROM public.pos_pending_sale_lines x
    JOIN public.inventory_units u ON u.id = x.unit_id
    JOIN public.products p ON p.id = x.product_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE x.pending_sale_id = v_s.id ORDER BY u.id
  LOOP
    INSERT INTO public.sale_lines(
      sale_id, product_id, unit_id, quantity, unit_cost, unit_price, discount, tax, line_total, selected_components
    ) VALUES (
      v_sale, v_x.product_id, v_x.unit_id, 1, v_x.unit_cost, v_x.unit_price, v_x.discount, v_x.tax, v_x.line_total,
      coalesce(v_x.selected_components, '[]'::jsonb)
    );

    UPDATE public.inventory_units
    SET status = 'sold', sold_sale_id = v_sale, reserved_until = null, version = version + 1
    WHERE id = v_x.unit_id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, quantity, unit_cost, reference_type, reference_id, actor_id
    ) VALUES (
      v_x.unit_id, v_x.product_id, v_x.batch_id, 'sold', v_x.location_id, 1, v_x.unit_cost, 'sale', v_sale, auth.uid()
    );
  END LOOP;

  PERFORM set_config('texnobazar.manager_confirm_sale', '', true);

  IF p_payments IS NULL THEN
    INSERT INTO public.sale_payments(sale_id, payment_method_id, amount, status, external_reference, received_by)
    SELECT v_sale, payment_method_id, amount, 'paid', external_reference, auth.uid()
    FROM public.pos_pending_sale_payments
    WHERE pending_sale_id = v_s.id ORDER BY sort_order;
  ELSE
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
      INSERT INTO public.sale_payments(sale_id, payment_method_id, amount, status, external_reference, received_by)
      VALUES (v_sale, v_method.id, (v_item->>'amount')::numeric(18,2), 'paid', nullif(btrim(v_item->>'external_reference'), ''), auth.uid());
    END LOOP;
  END IF;

  UPDATE public.pos_pending_sales
  SET status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
  WHERE id = v_s.id;

  RETURN v_sale;
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO v_sale FROM public.sales WHERE pending_sale_id = p_pending_sale_id;
  IF v_sale IS NOT NULL THEN RETURN v_sale; END IF;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_confirm_sale(uuid, jsonb) TO authenticated, service_role;

-- 11. Update create_online_order to support selected_components and standalone components
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
  v_is_standalone boolean;
  v_component_id uuid;
  v_comp record;
  v_selected_comps jsonb;
  v_comp_sum numeric(18,2);
  v_line_name text;
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
      'variant_id',nullif(e->>'variant_id','')::uuid,
      'batch_id',nullif(e->>'batch_id','')::uuid,
      'is_standalone_component',coalesce((e->>'is_standalone_component')::boolean, false),
      'component_id',nullif(e->>'component_id','')::uuid,
      'selected_components',coalesce(e->'selected_components','[]'::jsonb),
      'quantity',(e->>'quantity')::integer
    )
      ORDER BY (e->>'product_id')::uuid,nullif(e->>'variant_id','')::uuid,nullif(e->>'batch_id','')::uuid,nullif(e->>'component_id','')::uuid) FROM jsonb_array_elements(p_lines) e),'payment_method_code',lower(btrim(p_payment_method_code)),
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
    v_is_standalone := coalesce((v_line->>'is_standalone_component')::boolean, false);
    v_component_id := nullif(v_line->>'component_id','')::uuid;
    v_selected_comps := coalesce(v_line->'selected_components', '[]'::jsonb);
    v_color := NULL;

    SELECT id,name,sku,coalesce(promotion_price,retail_price) sale_price INTO v_product FROM public.products
      WHERE id=(v_line->>'product_id')::uuid AND status='active' AND is_published FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot mavjud emas' USING errcode='P0002';
    END IF;

    v_line_name := v_product.name;
    v_sale_price := v_product.sale_price;

    IF v_is_standalone AND v_component_id IS NOT NULL THEN
      SELECT * INTO v_comp FROM public.product_components
        WHERE id = v_component_id AND product_id = v_product.id AND is_active = true FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarkibiy qism topilmadi: %', v_component_id USING errcode='P0002';
      END IF;
      v_sale_price := coalesce(v_comp.retail_price, 0);
      v_line_name := v_product.name || ' — ' || v_comp.name || coalesce(' (' || v_comp.color_name || ')', '');
      v_selected_comps := jsonb_build_array(to_jsonb(v_comp));
    ELSE
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

      -- Add selected components price
      IF jsonb_typeof(v_selected_comps) = 'array' AND jsonb_array_length(v_selected_comps) > 0 THEN
        SELECT coalesce(sum(coalesce((c->>'retail_price')::numeric, (c->>'price')::numeric, 0)), 0)
        INTO v_comp_sum
        FROM jsonb_array_elements(v_selected_comps) c;
        v_sale_price := v_sale_price + v_comp_sum;
      END IF;
    END IF;

    INSERT INTO public.order_lines(
      order_id, product_id, variant_id, product_name, sku, variant_color, quantity, unit_price, discount, line_total, selected_components
    ) VALUES (
      v_order, v_product.id, v_variant_id, v_line_name, v_product.sku, v_color, v_qty, v_sale_price, 0, round(v_qty*v_sale_price, 2), v_selected_comps
    );

    v_subtotal := v_subtotal + round(v_qty*v_sale_price, 2);
  END LOOP;

  UPDATE public.orders SET subtotal=v_subtotal, total=v_subtotal WHERE id=v_order;
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

GRANT EXECUTE ON FUNCTION public.create_online_order(jsonb,jsonb,jsonb,text,text,text) TO anon, authenticated, service_role;

COMMIT;
