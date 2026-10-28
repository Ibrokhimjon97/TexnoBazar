-- Migration: 20261027000000_pos_returns_cheaper_exchange_and_qr_clean.sql
-- Description:
-- 1. In find_sale_return_unit and get_pos_unit_context: automatically sanitize and strip URLs and query parameters (?c=...) from scanned QR codes so replacement scanning never fails.
-- 2. In create_pos_exchange_upgrade: allow exchanging for cheaper products, automatically refund the difference to the customer, and record the payout as today's expense (chiqim) in the branch kassa (with payment method: cash or card).

BEGIN;

-- 1. UPDATE find_sale_return_unit: Sanitize QR code inputs
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

  SELECT * INTO v_u FROM public.inventory_units
  WHERE upper(qr_code) = upper(v_code) OR upper(coalesce(serial_number, '')) = upper(v_code)
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
    SELECT count(DISTINCT p.supplier_id) INTO v_provider_count
    FROM public.sale_lines sl2
    JOIN public.products p ON p.id = sl2.product_id
    WHERE sl2.sale_id = v_sale.id AND p.supplier_id IS NOT NULL;
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
      'seller_name', (SELECT coalesce(p.full_name, p.username) FROM public.profiles p WHERE p.id = v_sale.seller_id),
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


-- 2. UPDATE get_pos_unit_context: Sanitize QR code inputs so URLs/query parameters match
CREATE OR REPLACE FUNCTION public.get_pos_unit_context(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
      'seller_name', coalesce(pr.full_name, pr.username)
    ) INTO v_sale
    FROM public.sales s
    LEFT JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.profiles pr ON pr.id = s.seller_id
    WHERE s.id = v_unit.sold_sale_id;
  END IF;

  v_result := jsonb_build_object(
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
    ),
    'sale', v_sale
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;


-- 3. UPDATE create_pos_exchange_upgrade:
-- Allows exchanging for cheaper products, refunds the difference, and logs expense to today's kassa
DROP FUNCTION IF EXISTS public.create_pos_exchange_upgrade(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.create_pos_exchange_upgrade(uuid, uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.create_pos_exchange_upgrade(
  p_branch_id uuid,
  p_returned_unit_id uuid,
  p_new_unit_id uuid,
  p_reason text DEFAULT '2-opsiya: Boshqa / analog tovarga almashtirish',
  p_refund_method text DEFAULT 'cash'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_u public.inventory_units%rowtype;
  v_new_u public.inventory_units%rowtype;
  v_line public.sale_lines%rowtype;
  v_sale public.sales%rowtype;
  v_new_prod public.products%rowtype;
  v_returned_price numeric(18,2);
  v_new_price numeric(18,2);
  v_diff numeric(18,2);
  v_refund_diff numeric(18,2);
  v_pending_id uuid := gen_random_uuid();
  v_pending_no text;
  v_pending_row public.pos_pending_sales%rowtype;
  v_dest uuid;
  v_pay_method text;
  v_pay_label text;
BEGIN
  IF p_branch_id IS NULL OR p_returned_unit_id IS NULL OR p_new_unit_id IS NULL THEN
    RAISE EXCEPTION 'Filial, qaytarilayotgan tovar va yangi tovar talab qilinadi' USING errcode = '22023';
  END IF;
  PERFORM public.require_pos_seller(p_branch_id);

  SELECT * INTO v_u FROM public.inventory_units WHERE id = p_returned_unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Qaytariladigan birlik topilmadi' USING errcode = 'P0002'; END IF;

  SELECT sl.* INTO v_line FROM public.sale_lines sl
  JOIN public.sales s ON s.id = sl.sale_id
  WHERE sl.unit_id = v_u.id
  ORDER BY s.sold_at DESC, sl.created_at DESC LIMIT 1;

  IF NOT FOUND THEN RAISE EXCEPTION 'Sotuv tarixi topilmadi' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_sale FROM public.sales WHERE id = v_line.sale_id;

  IF v_sale.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Bu birlik boshqa filialda sotilgan' USING errcode = 'P0001';
  END IF;
  IF v_sale.sold_at < (now() - interval '30 days') THEN
    RAISE EXCEPTION 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (30 kunlik muddat tugagan)' USING errcode = '22023';
  END IF;
  IF v_u.status <> 'sold' OR v_u.sold_sale_id IS DISTINCT FROM v_sale.id THEN
    RAISE EXCEPTION 'Birlik sotilgan holatda emas (holat: %)', v_u.status::text USING errcode = 'P0001';
  END IF;

  -- Yangi tanlangan tovar
  SELECT * INTO v_new_u FROM public.inventory_units WHERE id = p_new_unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Almashtiriladigan yangi tovar birligi topilmadi' USING errcode = 'P0002'; END IF;
  IF v_new_u.status <> 'available' THEN
    RAISE EXCEPTION 'Yangi birlik erkin sotuvda emas (holat: %)', v_new_u.status::text USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_new_prod FROM public.products WHERE id = v_new_u.product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Yangi tovar mahsulot yozuvi topilmadi' USING errcode = 'P0002'; END IF;

  v_returned_price := round(v_line.line_total, 2);
  v_new_price := round(v_new_prod.retail_price, 2);
  v_diff := v_new_price - v_returned_price;

  -- Resell joylashuv
  SELECT id INTO v_dest FROM public.locations
  WHERE branch_id = p_branch_id AND is_active AND type = 'store'
  ORDER BY name LIMIT 1;

  -- 1) NARX TENG BO'LSA (0 so'm farq): darhol to'g'ridan-to'g'ri almashtirish!
  IF v_diff = 0 THEN
    UPDATE public.inventory_units
    SET status = 'available', location_id = v_dest, sold_sale_id = null, version = version + 1
    WHERE id = v_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
      1, v_line.unit_cost, 'sale_return', null, '2-opsiya: Teng narxli tovar almashtirish', auth.uid(),
      jsonb_build_object('kind', 'equal_value_exchange', 'original_sale_no', v_sale.sale_no)
    );

    UPDATE public.inventory_units
    SET status = 'sold', sold_sale_id = v_sale.id, version = version + 1
    WHERE id = v_new_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_new_u.id, v_new_u.product_id, v_new_u.batch_id, 'sold', v_new_u.location_id, v_new_u.location_id,
      1, v_new_prod.cost_price, 'sale_replacement', null, '2-opsiya: Teng narxli yangi tovar', auth.uid(),
      jsonb_build_object('replaced_unit_id', v_u.id, 'original_sale_no', v_sale.sale_no)
    );

    RETURN jsonb_build_object(
      'success', true,
      'difference', 0,
      'is_paid', true,
      'message', 'Tovar teng qiymatli boshqa tovarga muvaffaqiyatli almashtirildi (farq: 0 so‘m). Qoldiq yangilandi.'
    );
  END IF;

  -- 2) ARZONROQ TOVAR ALINGANDA (farq < 0, masalan qaytarilgan: 500 000, yangi: 300 000, qoldiq: 200 000 so'm):
  -- "bu holatda qolgani kassadan qaytariladi va kassada bugun uchun chiqim sifatida yoziladi (plastikka yoki naqd orqali)"
  IF v_new_price < v_returned_price THEN
    v_refund_diff := v_returned_price - v_new_price;

    -- A) Qaytarilgan tovar birligini do'konga qaytarish
    UPDATE public.inventory_units
    SET status = 'available', location_id = v_dest, sold_sale_id = null, version = version + 1
    WHERE id = v_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
      1, v_line.unit_cost, 'sale_return', null, '2-opsiya: Arzonroq tovarga almashtirildi', auth.uid(),
      jsonb_build_object('kind', 'cheaper_exchange', 'original_sale_no', v_sale.sale_no, 'new_unit_id', v_new_u.id)
    );

    -- B) Yangi tanlangan tovar birligini sotilgan deb belgilash
    UPDATE public.inventory_units
    SET status = 'sold', sold_sale_id = v_sale.id, version = version + 1
    WHERE id = v_new_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_new_u.id, v_new_u.product_id, v_new_u.batch_id, 'sold', v_new_u.location_id, v_new_u.location_id,
      1, v_new_prod.cost_price, 'sale_replacement', null, '2-opsiya: Arzonroq yangi tovar', auth.uid(),
      jsonb_build_object('replaced_unit_id', v_u.id, 'original_sale_no', v_sale.sale_no)
    );

    -- C) To'lov usuli (cash yoki card)
    IF lower(btrim(coalesce(p_refund_method, 'cash'))) IN ('card', 'terminal', 'plastik') THEN
      v_pay_method := 'card';
      v_pay_label := 'Plastik karta';
    ELSE
      v_pay_method := 'cash';
      v_pay_label := 'Naqd pul';
    END IF;

    -- D) Kassadan qaytarilgan qoldiq pulni bugungi chiqim (harajat) ro'yxatiga yozish
    INSERT INTO public.expenses(
      branch_id, category, title, amount, paid_amount, currency, period_month, paid_at, note, payment_method, created_by, created_at, updated_at
    ) VALUES (
      p_branch_id,
      'other',
      'Tovar almashtirish (qoldiq qaytarildi - ' || v_pay_label || ')',
      v_refund_diff,
      v_refund_diff,
      'UZS',
      to_char((now() AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM'),
      now(),
      'Mijoz ' || v_u.qr_code || ' (' || to_char(v_returned_price, 'FM999,999,999') || ' so‘m) ni arzonroq ' || v_new_prod.name || ' (' || to_char(v_new_price, 'FM999,999,999') || ' so‘m) ga almashtirdi. Qolgan ' || to_char(v_refund_diff, 'FM999,999,999') || ' so‘m kassadan qaytarildi (' || v_pay_label || '). ' || coalesce(p_reason, ''),
      v_pay_method,
      auth.uid(),
      now(),
      now()
    );

    -- E) Qaytarish tarixiga yakunlangan deb yozish
    INSERT INTO public.sale_returns(
      original_sale_id, kind, status, branch_id, customer_id, reason, refund_amount, requested_by
    ) VALUES (
      v_sale.id, 'exchange', 'completed', p_branch_id, v_sale.customer_id,
      '2-opsiya almashtirish (arzonroq): ' || v_new_prod.name || ' (Qaytarildi: ' || to_char(v_refund_diff, 'FM999,999,999') || ' so‘m, ' || v_pay_label || ')',
      v_refund_diff, auth.uid()
    );

    RETURN jsonb_build_object(
      'success', true,
      'difference', -v_refund_diff,
      'refund_amount', v_refund_diff,
      'refund_method', v_pay_label,
      'is_refund', true,
      'returned_price', v_returned_price,
      'new_price', v_new_price,
      'message', 'Tovar muvaffaqiyatli almashtirildi! Qoldiq ' || to_char(v_refund_diff, 'FM999,999,999') || ' so‘m mijozga qaytarildi va bugungi kassa chiqimi (xarajati) sifatida yozildi.'
    );
  END IF;

  -- 3) NARXI QIMMATROQ BO'LSA (farq > 0): Chek kassaga yo'naltiriladi
  v_pending_no := 'POS-EX-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(v_pending_id::text, 1, 6));

  -- Yangi tovarni rezerv qilish
  UPDATE public.inventory_units
  SET status = 'reserved',
      reserved_until = now() + interval '30 minutes',
      version = version + 1
  WHERE id = v_new_u.id;

  INSERT INTO public.pos_pending_sales(
    id, pending_no, branch_id, seller_id, customer_id, subtotal, discount, tax, total,
    status, expires_at, created_at, updated_at
  ) VALUES (
    v_pending_id, v_pending_no, p_branch_id, auth.uid(), v_sale.customer_id,
    v_new_price, v_returned_price, 0, v_diff,
    'pending', now() + interval '30 minutes', now(), now()
  ) RETURNING * INTO v_pending_row;

  INSERT INTO public.pos_pending_sale_lines(
    pending_sale_id, unit_id, product_id, unit_price, discount, tax_rate, line_total, unit_cost
  ) VALUES (
    v_pending_id, v_new_u.id, v_new_prod.id, v_new_price, v_returned_price, 0, v_diff, v_new_prod.cost_price
  );

  INSERT INTO public.sale_returns(
    original_sale_id, kind, status, branch_id, customer_id, reason, refund_amount, requested_by
  ) VALUES (
    v_sale.id, 'exchange', 'requested', p_branch_id, v_sale.customer_id,
    '2-opsiya almashtirish: Yangi tovar ' || v_new_prod.name || ' (Chek farqi: ' || to_char(v_diff, 'FM999,999,999') || ' so‘m)',
    v_returned_price, auth.uid()
  );

  RETURN jsonb_build_object(
    'success', true,
    'pending_sale_id', v_pending_id,
    'pending_no', v_pending_no,
    'returned_price', v_returned_price,
    'new_price', v_new_price,
    'difference', v_diff,
    'is_refund', false,
    'message', 'Mijoz hisobiga ' || to_char(v_diff, 'FM999,999,999') || ' so‘m farq yozildi va chek kassaga yo‘naltirildi.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_pos_exchange_upgrade(uuid, uuid, uuid, text, text) TO authenticated, service_role;

COMMIT;
