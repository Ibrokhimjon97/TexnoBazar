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

-- 3. Update get_pos_unit_context to include quantity and full POS context
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
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_unit_context(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

