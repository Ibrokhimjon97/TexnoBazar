-- Migration: Add quantity to product_components and update related RPCs
BEGIN;

-- 1. Add quantity column to product_components (default 1)
ALTER TABLE public.product_components ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

-- 2. Update save_product_components to handle quantity
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
  v_qty integer;
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

    v_qty := coalesce(nullif(v_item->>'quantity', '')::integer, 1);
    IF v_qty < 1 THEN
      v_qty := 1;
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
        image_url, sort_order, is_active, quantity
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
        coalesce((v_item->>'is_active')::boolean, true),
        v_qty
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
        quantity = v_qty,
        updated_at = now()
      WHERE id = v_id AND product_id = p_product_id;
    END IF;

    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
  END LOOP;

  -- Soft delete removed components
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

-- 3. Update get_pos_unit_context to include quantity
CREATE OR REPLACE FUNCTION public.get_pos_unit_context(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_unit public.inventory_units%rowtype;
  v_result jsonb;
  v_clean text := upper(btrim(p_code));
  v_latest_sale record;
  v_sold_seller_name text;
  v_sold_manager_name text;
  v_details_visible boolean := false;
  v_role public.app_role;
  v_operator_branch uuid;
BEGIN
  SELECT * INTO v_unit
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE (upper(btrim(u.qr_code)) = v_clean OR upper(btrim(coalesce(u.serial_number, ''))) = v_clean)
    AND l.branch_id = p_branch_id
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_unit
    FROM public.inventory_units u
    WHERE upper(btrim(u.qr_code)) = v_clean OR upper(btrim(coalesce(u.serial_number, ''))) = v_clean
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT role, branch_id INTO v_role, v_operator_branch
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_unit.status = 'sold' THEN
    SELECT s.id AS sale_id, s.sale_no, s.sold_at, s.seller_id, s.manager_id,
           sl.unit_price, sl.discount, sl.tax, sl.line_total, sl.branch_id,
           b.name AS branch_name,
           c.full_name AS customer_name, c.phone AS customer_phone
    INTO v_latest_sale
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.branches b ON b.id = sl.branch_id
    LEFT JOIN public.customers c ON c.id = s.customer_id
    WHERE sl.unit_id = v_unit.id
    ORDER BY s.sold_at DESC
    LIMIT 1;

    IF FOUND THEN
      v_details_visible := (
        v_role IN ('superadmin', 'admin')
        OR (v_role = 'manager' AND v_operator_branch = v_latest_sale.branch_id)
        OR (v_role = 'seller' AND v_operator_branch = v_latest_sale.branch_id AND v_latest_sale.seller_id = auth.uid())
      );

      IF v_details_visible THEN
        SELECT full_name INTO v_sold_seller_name FROM public.profiles WHERE id = v_latest_sale.seller_id;
        SELECT full_name INTO v_sold_manager_name FROM public.profiles WHERE id = v_latest_sale.manager_id;
      END IF;
    END IF;
  END IF;

  SELECT jsonb_build_object(
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'product_id', p.id,
    'product_name', p.name,
    'sku', p.sku,
    'brand_name', b.name,
    'category_name', c.name,
    'image', coalesce(pv.image_url, p.seo_image_url, (SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = p.id AND pm.is_primary LIMIT 1)),
    'variant_id', v_unit.variant_id,
    'variant_color', pv.color_name,
    'variant_hex', pv.color_hex,
    'location_id', l.id,
    'location_name', l.name,
    'location_type', l.type,
    'branch_id', l.branch_id,
    'prices', jsonb_build_object(
      'retail_price_uzs', coalesce(pv.retail_price, p.retail_price),
      'retail_price_usd', coalesce(pv.retail_price_usd, p.retail_price_usd),
      'wholesale_price_uzs', coalesce(pv.wholesale_price, p.wholesale_price),
      'wholesale_price_usd', coalesce(pv.wholesale_price_usd, p.wholesale_price_usd),
      'minimum_sale_price_uzs', coalesce(pv.minimum_sale_price, p.minimum_sale_price),
      'minimum_sale_price_usd', coalesce(pv.minimum_sale_price_usd, p.minimum_sale_price_usd),
      'unit_cost_uzs', coalesce(pv.cost_price, p.cost_price),
      'unit_cost_usd', coalesce(pv.cost_price_usd, p.cost_price_usd),
      'tax_rate', coalesce(p.tax_rate, 0)
    ),
    'components', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pc.id,
        'name', pc.name,
        'color_name', pc.color_name,
        'color_hex', pc.color_hex,
        'retail_price', pc.retail_price,
        'retail_price_usd', pc.retail_price_usd,
        'retail_price_uzs', pc.retail_price,
        'cost_price', pc.cost_price,
        'cost_price_usd', pc.cost_price_usd,
        'cost_price_uzs', pc.cost_price,
        'wholesale_price', pc.wholesale_price,
        'wholesale_price_usd', pc.wholesale_price_usd,
        'is_default', pc.is_default,
        'is_required', pc.is_required,
        'can_buy_standalone', pc.can_buy_standalone,
        'image_url', pc.image_url,
        'sort_order', pc.sort_order,
        'quantity', coalesce(pc.quantity, 1)
      ) ORDER BY pc.sort_order, pc.created_at)
      FROM public.product_components pc
      WHERE pc.product_id = v_unit.product_id AND pc.is_active = true
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.products p
  LEFT JOIN public.brands b ON b.id = p.brand_id
  LEFT JOIN public.categories c ON c.id = p.category_id
  JOIN public.locations l ON l.id = v_unit.location_id
  LEFT JOIN public.product_variants pv ON pv.id = v_unit.variant_id
  WHERE p.id = v_unit.product_id;

  RETURN v_result;
END;
$$;

COMMIT;
