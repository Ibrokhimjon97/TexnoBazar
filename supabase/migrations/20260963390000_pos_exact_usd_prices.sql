-- Migration: Exact USD prices in get_pos_unit_context and list_pos_units
BEGIN;

-- 1. Update get_pos_unit_context to return exact USD prices (unit_cost_usd, retail_price_usd, etc.)
CREATE OR REPLACE FUNCTION public.get_pos_unit_context(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_unit record;
  v_rate numeric;
  v_sale jsonb := null;
  v_result jsonb;
  v_total_product_stock integer := 0;
  v_total_store_stock integer := 0;
  v_total_warehouse_stock integer := 0;
  v_variants_stock jsonb := '[]'::jsonb;
  v_variants_summary_text text := '';
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC
  LIMIT 1;

  SELECT
    u.id, u.qr_code, u.serial_number, u.status, u.location_id, u.active_transfer_id, u.sold_sale_id,
    u.variant_id,
    pv.color_name as variant_color,
    pv.color_hex as variant_color_hex,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug,
    p.status as product_status, p.is_published,
    p.currency as currency,
    br.name as brand_name,
    coalesce(pv.retail_price, p.retail_price) as retail_price,
    coalesce(pv.retail_price_usd, p.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.retail_price, p.retail_price) / v_rate, 2) ELSE null END) as retail_price_usd,
    coalesce(pv.wholesale_price, p.wholesale_price) as wholesale_price,
    coalesce(pv.wholesale_price_usd, p.wholesale_price_usd, CASE WHEN v_rate > 0 AND coalesce(pv.wholesale_price, p.wholesale_price) IS NOT NULL THEN round(coalesce(pv.wholesale_price, p.wholesale_price) / v_rate, 2) ELSE null END) as wholesale_price_usd,
    coalesce(pv.minimum_sale_price, p.minimum_sale_price) as minimum_sale_price,
    coalesce(pv.minimum_sale_price_usd, p.minimum_sale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.minimum_sale_price, p.minimum_sale_price) / v_rate, 2) ELSE null END) as minimum_sale_price_usd,
    p.tax_rate,
    coalesce(pv.cost_price, sb.unit_cost, p.cost_price) as unit_cost,
    coalesce(pv.cost_price_usd, sb.unit_cost_usd, p.cost_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.cost_price, sb.unit_cost, p.cost_price) / v_rate, 2) ELSE null END) as unit_cost_usd,
    l.name as location_name, l.type as location_type, l.is_active as location_active,
    l.branch_id as unit_branch_id,
    ub.name as unit_branch_name,
    ub.code as unit_branch_code,
    (l.branch_id = p_branch_id) as in_current_branch,
    (l.branch_id = p_branch_id and l.is_active and l.type in ('store','warehouse')
      and u.status = 'available' and u.active_transfer_id is null and p.status = 'active') as is_sellable,
    coalesce(
      (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
    ) as image
  INTO v_unit
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.branches ub ON ub.id = l.branch_id AND ub.is_active
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
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

  -- Filialdagi barcha rang variantlari bo'yicha qoldiqlar yig'indisi
  SELECT
    coalesce(sum(total_qty), 0),
    coalesce(sum(store_qty), 0),
    coalesce(sum(warehouse_qty), 0),
    coalesce(
      jsonb_agg(jsonb_build_object(
        'variant_id', variant_id,
        'color_name', color_name,
        'color_hex', color_hex,
        'is_current', (variant_id IS NOT DISTINCT FROM v_unit.variant_id),
        'total_quantity', total_qty,
        'store_quantity', store_qty,
        'warehouse_quantity', warehouse_qty
      )),
      '[]'::jsonb
    ),
    coalesce(string_agg(total_qty || ' donasi ' || color_name, ', '), '')
  INTO
    v_total_product_stock,
    v_total_store_stock,
    v_total_warehouse_stock,
    v_variants_stock,
    v_variants_summary_text
  FROM (
    SELECT
      count_u.variant_id,
      coalesce(count_pv.color_name, 'Standart') as color_name,
      count_pv.color_hex,
      count(count_u.id) as total_qty,
      count(count_u.id) FILTER (WHERE count_l.type = 'store') as store_qty,
      count(count_u.id) FILTER (WHERE count_l.type = 'warehouse') as warehouse_qty
    FROM public.inventory_units count_u
    JOIN public.locations count_l ON count_l.id = count_u.location_id
    LEFT JOIN public.product_variants count_pv ON count_pv.id = count_u.variant_id
    WHERE count_u.product_id = v_unit.product_id
      AND count_l.branch_id = v_unit.unit_branch_id
      AND count_l.is_active = true
      AND count_u.status = 'available'
      AND count_u.active_transfer_id IS NULL
    GROUP BY count_u.variant_id, count_pv.color_name, count_pv.color_hex, count_pv.sort_order
    ORDER BY coalesce(count_pv.sort_order, 999), count_pv.color_name
  ) s;

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
    'variant_id', v_unit.variant_id,
    'variant_color', v_unit.variant_color,
    'variant_color_hex', v_unit.variant_color_hex,
    'variant_stock_count', (
      SELECT count(*) FROM public.inventory_units iu
      JOIN public.locations il ON il.id = iu.location_id
      WHERE iu.product_id = v_unit.product_id
        AND il.branch_id = v_unit.unit_branch_id
        AND il.is_active
        AND iu.status = 'available'
        AND iu.active_transfer_id IS NULL
        AND (iu.variant_id IS NOT DISTINCT FROM v_unit.variant_id)
    ),
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
    'currency', coalesce(v_unit.currency, 'USD'),
    'cost_price', v_unit.unit_cost,
    'cost_price_usd', v_unit.unit_cost_usd,
    'unit_cost', v_unit.unit_cost,
    'unit_cost_usd', v_unit.unit_cost_usd,
    'retail_price', v_unit.retail_price,
    'retail_price_usd', v_unit.retail_price_usd,
    'wholesale_price', v_unit.wholesale_price,
    'wholesale_price_usd', v_unit.wholesale_price_usd,
    'minimum_sale_price', v_unit.minimum_sale_price,
    'minimum_sale_price_usd', v_unit.minimum_sale_price_usd,
    'prices', jsonb_build_object(
      'retail_price_uzs', v_unit.retail_price,
      'retail_price_usd', v_unit.retail_price_usd,
      'wholesale_price_uzs', v_unit.wholesale_price,
      'wholesale_price_usd', v_unit.wholesale_price_usd,
      'minimum_sale_price_uzs', v_unit.minimum_sale_price,
      'minimum_sale_price_usd', v_unit.minimum_sale_price_usd,
      'unit_cost_uzs', v_unit.unit_cost,
      'unit_cost_usd', v_unit.unit_cost_usd,
      'tax_rate', v_unit.tax_rate
    ),
    -- Jami filialdagi mahsulot qoldig'i (barcha ranglar bilan)
    'branch_stock', jsonb_build_object(
      'store', v_total_store_stock,
      'warehouse', v_total_warehouse_stock,
      'total', v_total_product_stock
    ),
    -- Aynan ushbu rang bo'yicha qoldiq
    'variant_branch_stock', jsonb_build_object(
      'store', (
        SELECT count(*) FROM public.inventory_units iu
        JOIN public.locations il ON il.id = iu.location_id
        WHERE iu.product_id = v_unit.product_id
          AND il.branch_id = v_unit.unit_branch_id
          AND il.type = 'store'
          AND il.is_active
          AND iu.status = 'available'
          AND iu.active_transfer_id IS NULL
          AND (iu.variant_id IS NOT DISTINCT FROM v_unit.variant_id)
      ),
      'warehouse', (
        SELECT count(*) FROM public.inventory_units iu
        JOIN public.locations il ON il.id = iu.location_id
        WHERE iu.product_id = v_unit.product_id
          AND il.branch_id = v_unit.unit_branch_id
          AND il.type = 'warehouse'
          AND il.is_active
          AND iu.status = 'available'
          AND iu.active_transfer_id IS NULL
          AND (iu.variant_id IS NOT DISTINCT FROM v_unit.variant_id)
      )
    ),
    -- Ranglar bo'yicha to'liq qoldiqlar ro'yxati va matnli xulosa
    'variants_stock', v_variants_stock,
    'variants_summary_text', v_variants_summary_text,
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

-- 2. Update list_pos_units to return USD prices and currency
CREATE OR REPLACE FUNCTION public.list_pos_units(p_branch_id uuid, p_query text, p_limit integer default 30, p_offset integer default 0)
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
    AND (v_q IS NULL OR p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%'
      OR coalesce(p.barcode, '') ILIKE '%'||v_q||'%'
      OR u.qr_code ILIKE '%'||v_q||'%' OR coalesce(u.serial_number, '') ILIKE '%'||v_q||'%');

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.product_name, q.id), '[]'::jsonb) INTO v_items
  FROM (
    SELECT u.id, u.qr_code, u.serial_number, u.location_id, l.name as location_name, l.type as location_type,
      p.id as product_id, p.name as product_name, p.sku, p.barcode, br.name as brand_name,
      coalesce(pv.retail_price, p.retail_price) as retail_price,
      coalesce(pv.retail_price_usd, p.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.retail_price, p.retail_price) / v_rate, 2) ELSE null END) as retail_price_usd,
      coalesce(pv.minimum_sale_price, p.minimum_sale_price) as minimum_sale_price,
      coalesce(pv.minimum_sale_price_usd, p.minimum_sale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.minimum_sale_price, p.minimum_sale_price) / v_rate, 2) ELSE null END) as minimum_sale_price_usd,
      p.tax_rate,
      coalesce(pv.cost_price, sb.unit_cost, p.cost_price) as unit_cost,
      coalesce(pv.cost_price_usd, sb.unit_cost_usd, p.cost_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.cost_price, sb.unit_cost, p.cost_price) / v_rate, 2) ELSE null END) as unit_cost_usd,
      coalesce(pv.cost_price_usd, sb.unit_cost_usd, p.cost_price_usd) as cost_price_usd,
      coalesce(p.currency, 'USD') as currency,
      coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
      ) as image,
      (SELECT count(*) FROM public.inventory_units a JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = p.id AND al.branch_id = p_branch_id AND al.type IN ('store', 'warehouse')
          AND al.is_active AND a.status = 'available' AND a.active_transfer_id IS NULL) as available_branch_count
    FROM public.inventory_units u
    JOIN public.locations l ON l.id = u.location_id
    JOIN public.products p ON p.id = u.product_id
    LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
    LEFT JOIN public.brands br ON br.id = p.brand_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE l.branch_id = p_branch_id AND l.type IN ('store', 'warehouse') AND l.is_active
      AND u.status = 'available' AND u.active_transfer_id IS NULL AND p.status = 'active'
      AND (v_q IS NULL OR p.name ILIKE '%'||v_q||'%' OR p.sku ILIKE '%'||v_q||'%'
        OR coalesce(p.barcode, '') ILIKE '%'||v_q||'%'
        OR u.qr_code ILIKE '%'||v_q||'%' OR coalesce(u.serial_number, '') ILIKE '%'||v_q||'%')
    ORDER BY p.name, u.id
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_unit_context(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.list_pos_units(uuid, text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_units(uuid, text, integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
