-- Migration: Fix column p.username does not exist, p.supplier_id does not exist,
-- and add intelligent sold-unit prioritization and unit_id support in find_sale_return_unit & get_pos_unit_context.

BEGIN;

-- 1. UPDATE find_sale_return_unit
CREATE OR REPLACE FUNCTION public.find_sale_return_unit(p_branch_id uuid, p_code text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_u public.inventory_units%rowtype;
  v_sale public.sales%rowtype;
  v_line public.sale_lines%rowtype;
  v_eligible boolean := true;
  v_reason text;
  v_sale_branch uuid;
  v_sale_branch_name text;
  v_pending jsonb;
  v_provider_count integer := 0;
  v_line_count integer := 0;
  v_warning text;
  v_result jsonb;
  v_days_passed integer := 0;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial talab qilinadi' USING errcode = '22023';
  END IF;
  PERFORM public.require_pos_seller(p_branch_id);

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR yoki seriya raqami talab qilinadi' USING errcode = '22023';
  END IF;

  -- Clean QR code if scanned as URL or has secret cost params
  IF v_code ~* '/qr/' THEN
    v_code := substring(v_code from '/qr/([^/?#\s]+)');
  END IF;
  IF v_code LIKE '%?%' THEN
    v_code := split_part(v_code, '?', 1);
  END IF;
  v_code := nullif(btrim(v_code), '');

  -- Prioritize: direct unit_id lookup > sold unit in current branch within 30 days > sold unit > available unit
  SELECT u.* INTO v_u FROM public.inventory_units u
  LEFT JOIN public.sales s ON s.id = u.sold_sale_id
  WHERE u.id::text = v_code
     OR upper(u.qr_code) = upper(v_code)
     OR upper(coalesce(u.serial_number, '')) = upper(v_code)
  ORDER BY
    CASE WHEN u.id::text = v_code THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'sold' AND s.branch_id = p_branch_id AND s.sold_at >= (now() - interval '30 days') THEN 0
         WHEN u.status = 'sold' AND s.branch_id = p_branch_id THEN 1
         WHEN u.status = 'sold' THEN 2
         ELSE 3 END,
    s.sold_at DESC NULLS LAST,
    u.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QR yoki seriya bo‘yicha birlik topilmadi: %', v_code USING errcode = 'P0002';
  END IF;

  -- Eng oxirgi sotuv qatori
  SELECT sl.* INTO v_line FROM public.sale_lines sl
  JOIN public.sales s ON s.id = sl.sale_id
  WHERE sl.unit_id = v_u.id
  ORDER BY s.sold_at DESC, sl.created_at DESC LIMIT 1;

  IF FOUND THEN
    SELECT * INTO v_sale FROM public.sales WHERE id = v_line.sale_id;
  END IF;

  IF v_sale.id IS NULL THEN
    v_eligible := false;
    v_reason := 'Bu birlik hech qachon sotilmagan — qaytarish uchun sotuv tarixi yo‘q.';
  ELSE
    v_sale_branch := v_sale.branch_id;
    SELECT name INTO v_sale_branch_name FROM public.branches WHERE id = v_sale.branch_id;

    -- 1 oylik (30 kunlik) qoida tekshiruvi
    v_days_passed := extract(day from (now() - v_sale.sold_at))::integer;
    IF v_sale.sold_at < (now() - interval '30 days') THEN
      v_eligible := false;
      v_reason := 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (' || to_char(v_sale.sold_at at time zone 'Asia/Tashkent', 'DD.MM.YYYY') || ', ' || v_days_passed || ' kun oldin). Qaytarish muddati (30 kun) tugagan.';
    ELSIF v_sale_branch IS DISTINCT FROM p_branch_id THEN
      v_eligible := false;
      v_reason := 'Bu birlik boshqa filialda sotilgan: ' || coalesce(v_sale_branch_name, '—') || '. Qaytarishni shu filial bajaradi.';
    ELSIF v_sale.status = 'void' THEN
      v_eligible := false;
      v_reason := 'Asl sotuv bekor qilingan (void) — qaytarish mumkin emas.';
    ELSIF v_u.status <> 'sold' OR v_u.sold_sale_id IS DISTINCT FROM v_sale.id THEN
      v_eligible := false;
      v_reason := 'Birlik hozirda sotilgan holatda emas (holat: ' || v_u.status::text || '). Ehtimol allaqachon qaytarilgan yoki hisobdan chiqarilgan.';
    ELSIF EXISTS (
      SELECT 1 FROM public.sale_return_lines x
      JOIN public.sale_returns r ON r.id = x.return_id
      WHERE x.sale_line_id = v_line.id AND r.status IN ('requested', 'approved', 'completed')
    ) THEN
      v_eligible := false;
      v_reason := 'Bu birlik uchun qaytarish allaqachon mavjud yoki yakunlangan.';
    END IF;
  END IF;

  IF v_sale.id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', r.id,
      'return_no', r.return_no,
      'status', r.status,
      'kind', r.kind,
      'refund_amount', r.refund_amount,
      'created_at', r.created_at
    )
    INTO v_pending FROM public.sale_return_lines x
    JOIN public.sale_returns r ON r.id = x.return_id
    WHERE x.sale_line_id = v_line.id AND r.status IN ('requested', 'approved')
    ORDER BY r.created_at DESC LIMIT 1;

    SELECT count(*) INTO v_line_count FROM public.sale_lines WHERE sale_id = v_sale.id;
    SELECT count(DISTINCT sb.supplier_id) INTO v_provider_count
    FROM public.sale_lines sl2
    LEFT JOIN public.inventory_units u2 ON u2.id = sl2.unit_id
    LEFT JOIN public.stock_batches sb ON sb.id = u2.batch_id
    WHERE sl2.sale_id = v_sale.id AND sb.supplier_id IS NOT NULL;
  END IF;

  IF v_eligible AND v_provider_count > 1 THEN
    v_warning := 'Ushbu chekda bir nechta ta’minotchi tovarlari mavjud (' || v_provider_count || ' ta).';
  END IF;

  v_result := jsonb_build_object(
    'eligible', v_eligible,
    'reason', v_reason,
    'days_passed', v_days_passed,
    'unit', jsonb_build_object(
      'id', v_u.id,
      'qr_code', v_u.qr_code,
      'serial_number', v_u.serial_number,
      'status', v_u.status,
      'location_id', v_u.location_id
    ),
    'product', (
      SELECT jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'sku', p.sku,
        'retail_price', p.retail_price,
        'retail_price_usd', p.retail_price_usd,
        'image', coalesce(
          (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
          null
        )
      ) FROM public.products p WHERE p.id = v_u.product_id
    ),
    'batch', (
      SELECT jsonb_build_object(
        'id', sb.id,
        'reference', sb.reference
      ) FROM public.stock_batches sb WHERE sb.id = v_u.batch_id
    ),
    'sale', CASE WHEN v_sale.id IS NOT NULL THEN jsonb_build_object(
      'id', v_sale.id,
      'sale_no', v_sale.sale_no,
      'sold_at', v_sale.sold_at,
      'total', v_sale.total,
      'seller_name', (SELECT coalesce(p.full_name, p.email::text, '—') FROM public.profiles p WHERE p.id = v_sale.seller_id),
      'customer_name', (SELECT c.full_name FROM public.customers c WHERE c.id = v_sale.customer_id),
      'branch_name', v_sale_branch_name,
      'line_count', v_line_count,
      'provider_count', v_provider_count
    ) ELSE null END,
    'sale_line', CASE WHEN v_line.id IS NOT NULL THEN jsonb_build_object(
      'id', v_line.id,
      'unit_price', v_line.unit_price,
      'discount', v_line.discount,
      'line_total', v_line.line_total
    ) ELSE null END,
    'pending_return', v_pending,
    'warning', v_warning
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_sale_return_unit(uuid, text) TO authenticated, service_role;


-- 2. UPDATE get_pos_unit_context
CREATE OR REPLACE FUNCTION public.get_pos_unit_context(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_target_product_id uuid;
  v_target_variant_id uuid;
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

  -- Clean QR code if scanned as URL or has secret cost params
  IF v_code ~* '/qr/' THEN
    v_code := substring(v_code from '/qr/([^/?#\s]+)');
  END IF;
  IF v_code LIKE '%?%' THEN
    v_code := split_part(v_code, '?', 1);
  END IF;
  v_code := nullif(btrim(v_code), '');

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC
  LIMIT 1;

  -- 1. Kod bo'yicha mahsulot va variantni aniqlash
  SELECT
    u.product_id,
    u.variant_id
  INTO
    v_target_product_id,
    v_target_variant_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  WHERE (
    upper(u.qr_code) = upper(v_code)
    OR upper(coalesce(u.serial_number, '')) = upper(v_code)
    OR (l.branch_id = p_branch_id AND (upper(coalesce(p.barcode, '')) = upper(v_code) OR upper(p.sku) = upper(v_code)))
  )
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    u.created_at DESC
  LIMIT 1;

  IF v_target_product_id IS NULL THEN
    SELECT p.id INTO v_target_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_target_product_id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Filialdagi eng mos birlikni tanlash
  SELECT
    u.id, u.qr_code, u.serial_number, u.status, u.location_id, u.active_transfer_id, u.sold_sale_id,
    u.variant_id,
    pv.color_name as variant_color,
    pv.color_hex as variant_color_hex,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug,
    p.status as product_status, p.is_published,
    p.currency as currency,
    br.name as brand_name,
    coalesce(p.retail_price, pv.retail_price, sb.retail_price) as retail_price,
    coalesce(p.retail_price_usd, pv.retail_price_usd, sb.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(p.retail_price, pv.retail_price, sb.retail_price) / v_rate, 2) ELSE null END) as retail_price_usd,
    coalesce(p.wholesale_price, pv.wholesale_price, sb.wholesale_price) as wholesale_price,
    coalesce(p.wholesale_price_usd, pv.wholesale_price_usd, sb.wholesale_price_usd, CASE WHEN v_rate > 0 AND coalesce(p.wholesale_price, pv.wholesale_price, sb.wholesale_price) IS NOT NULL THEN round(coalesce(p.wholesale_price, pv.wholesale_price, sb.wholesale_price) / v_rate, 2) ELSE null END) as wholesale_price_usd,
    coalesce(p.minimum_sale_price, pv.minimum_sale_price, sb.minimum_sale_price) as minimum_sale_price,
    coalesce(p.minimum_sale_price_usd, pv.minimum_sale_price_usd, sb.minimum_sale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(p.minimum_sale_price, pv.minimum_sale_price, sb.minimum_sale_price) / v_rate, 2) ELSE null END) as minimum_sale_price_usd,
    p.tax_rate,
    coalesce(p.cost_price, pv.cost_price, sb.unit_cost) as unit_cost,
    coalesce(p.cost_price_usd, pv.cost_price_usd, sb.unit_cost_usd, CASE WHEN v_rate > 0 THEN round(coalesce(p.cost_price, pv.cost_price, sb.unit_cost) / v_rate, 2) ELSE null END) as unit_cost_usd,
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
  WHERE u.product_id = v_target_product_id
    AND l.type IN ('store', 'warehouse')
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id AND l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    CASE WHEN v_target_variant_id IS NOT NULL AND u.variant_id = v_target_variant_id THEN 0 ELSE 1 END,
    CASE WHEN l.type = 'store' THEN 0 ELSE 1 END,
    u.created_at ASC,
    u.id ASC
  LIMIT 1;

  IF v_unit.id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot birligi topilmadi' USING errcode = 'P0002';
  END IF;

  -- 3. Filialdagi barcha rang variantlari bo'yicha qoldiqlar yig'indisi
  SELECT
    coalesce(sum(total_qty), 0),
    coalesce(sum(store_qty), 0),
    coalesce(sum(warehouse_qty), 0),
    coalesce(
      jsonb_agg(jsonb_build_object(
        'variant_id', variant_id,
        'color_name', color_name,
        'color_hex', color_hex,
        'total_qty', total_qty,
        'store_qty', store_qty,
        'warehouse_qty', warehouse_qty,
        'is_current', (variant_id IS NOT DISTINCT FROM v_unit.variant_id)
      ) ORDER BY color_name NULLS LAST),
      '[]'::jsonb
    ),
    coalesce(
      string_agg(
        coalesce(color_name, 'Standart') || ': ' || total_qty || ' ta (' || store_qty || ' do‘konda, ' || warehouse_qty || ' omborda)',
        '; ' ORDER BY color_name NULLS LAST
      ),
      'Qoldiq yo‘q'
    )
  INTO
    v_total_product_stock,
    v_total_store_stock,
    v_total_warehouse_stock,
    v_variants_stock,
    v_variants_summary_text
  FROM (
    SELECT
      u.variant_id,
      pv.color_name,
      pv.color_hex,
      count(*) as total_qty,
      count(*) FILTER (WHERE l.type = 'store') as store_qty,
      count(*) FILTER (WHERE l.type = 'warehouse') as warehouse_qty
    FROM public.inventory_units u
    JOIN public.locations l ON l.id = u.location_id
    LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
    WHERE u.product_id = v_target_product_id
      AND l.branch_id = p_branch_id
      AND l.is_active
      AND l.type IN ('store', 'warehouse')
      AND u.status = 'available'
      AND u.active_transfer_id IS NULL
    GROUP BY u.variant_id, pv.color_name, pv.color_hex
  ) sub;

  IF v_unit.status = 'sold' AND v_unit.sold_sale_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'id', s.id,
      'sale_no', s.sale_no,
      'sold_at', s.sold_at,
      'total', s.total,
      'customer_name', c.full_name,
      'seller_name', coalesce(pr.full_name, pr.email::text, '—')
    ) INTO v_sale
    FROM public.sales s
    LEFT JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.profiles pr ON pr.id = s.seller_id
    WHERE s.id = v_unit.sold_sale_id;
  END IF;

  v_result := jsonb_build_object(
    -- 1. Top-level properties expected by PosWorkspace and UnitContextCard
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'location_id', v_unit.location_id,
    'location_name', v_unit.location_name,
    'location_type', v_unit.location_type,
    'unit_branch_id', v_unit.unit_branch_id,
    'unit_branch_name', v_unit.unit_branch_name,
    'unit_branch_code', v_unit.unit_branch_code,
    'requested_branch_id', p_branch_id,
    'in_current_branch', v_unit.in_current_branch,
    'is_sellable', v_unit.is_sellable,
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'product_status', v_unit.product_status,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'brand_name', v_unit.brand_name,
    'image', v_unit.image,
    'storefront_url', CASE WHEN v_unit.product_status = 'active' AND v_unit.is_published AND v_unit.slug IS NOT NULL
      THEN '/product/' || v_unit.slug ELSE NULL END,
    'exchange_rate', v_rate,
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
    'branch_stock', jsonb_build_object(
      'store', v_total_store_stock,
      'warehouse', v_total_warehouse_stock,
      'total', v_total_product_stock
    ),
    'variants_stock', v_variants_stock,
    'variants_summary_text', v_variants_summary_text,
    'other_branches', coalesce((
      SELECT jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', q.qty) ORDER BY q.qty DESC)
      FROM (
        SELECT al.branch_id, count(*) as qty
        FROM public.inventory_units a
        JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = v_unit.product_id AND al.is_active AND al.type IN ('store', 'warehouse')
          AND a.status = 'available' AND a.active_transfer_id IS NULL AND al.branch_id <> v_unit.unit_branch_id
        GROUP BY al.branch_id
      ) q
      JOIN public.branches b ON b.id = q.branch_id
    ), '[]'::jsonb),
    'components', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pc.id,
        'component_name', pc.name,
        'name', pc.name,
        'color', pc.color_name,
        'color_name', pc.color_name,
        'color_hex', pc.color_hex,
        'image_url', pc.image_url,
        'quantity', coalesce(pc.quantity, 1),
        'retail_price', pc.retail_price,
        'retail_price_uzs', pc.retail_price,
        'retail_price_usd', pc.retail_price_usd,
        'cost_price', pc.cost_price,
        'cost_price_uzs', pc.cost_price,
        'cost_price_usd', pc.cost_price_usd,
        'wholesale_price', pc.wholesale_price,
        'wholesale_price_usd', pc.wholesale_price_usd,
        'is_default', pc.is_default,
        'is_required', pc.is_required,
        'can_buy_standalone', pc.can_buy_standalone
      ) ORDER BY pc.sort_order, pc.name)
      FROM public.product_components pc
      WHERE pc.product_id = v_unit.product_id AND pc.is_active
    ), '[]'::jsonb),
    'sale', v_sale,
    'unit_sale', v_sale,

    -- 2. Nested objects expected by find_sale_return_unit / returns
    'unit', jsonb_build_object(
      'id', v_unit.id,
      'qr_code', v_unit.qr_code,
      'serial_number', v_unit.serial_number,
      'status', v_unit.status,
      'status_label', CASE v_unit.status
        WHEN 'available' THEN 'Sotuvga tayyor'
        WHEN 'reserved' THEN 'Band qilingan'
        WHEN 'sold' THEN 'Sotilgan'
        WHEN 'in_transit' THEN 'Yo‘lda'
        WHEN 'returned' THEN 'Qaytarilgan'
        WHEN 'written_off' THEN 'Hisobdan chiqarilgan'
        ELSE v_unit.status::text
      END,
      'location_id', v_unit.location_id,
      'location_name', v_unit.location_name,
      'location_type', v_unit.location_type,
      'unit_cost', v_unit.unit_cost,
      'unit_cost_usd', v_unit.unit_cost_usd,
      'active_transfer_id', v_unit.active_transfer_id,
      'variant_id', v_unit.variant_id,
      'variant_color', v_unit.variant_color,
      'variant_color_hex', v_unit.variant_color_hex
    ),
    'product', jsonb_build_object(
      'id', v_unit.product_id,
      'name', v_unit.product_name,
      'sku', v_unit.sku,
      'barcode', v_unit.barcode,
      'slug', v_unit.slug,
      'brand_name', v_unit.brand_name,
      'status', v_unit.product_status,
      'is_published', v_unit.is_published,
      'currency', v_unit.currency,
      'retail_price', v_unit.retail_price,
      'retail_price_usd', v_unit.retail_price_usd,
      'wholesale_price', v_unit.wholesale_price,
      'wholesale_price_usd', v_unit.wholesale_price_usd,
      'minimum_sale_price', v_unit.minimum_sale_price,
      'minimum_sale_price_usd', v_unit.minimum_sale_price_usd,
      'tax_rate', v_unit.tax_rate,
      'image', v_unit.image
    ),
    'branch', jsonb_build_object(
      'unit_branch_id', v_unit.unit_branch_id,
      'unit_branch_name', v_unit.unit_branch_name,
      'unit_branch_code', v_unit.unit_branch_code,
      'in_current_branch', v_unit.in_current_branch,
      'is_sellable', v_unit.is_sellable
    ),
    'stock', jsonb_build_object(
      'total_product_stock', v_total_product_stock,
      'total_store_stock', v_total_store_stock,
      'total_warehouse_stock', v_total_warehouse_stock,
      'variants', v_variants_stock,
      'summary_text', v_variants_summary_text
    )
  );

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
