-- Migration: 20260995000000_unify_product_qr_codes_across_batches.sql
-- Description: Qr kodlar partiyalar o'rtasida birlashtirildi: qaysi partiya QR kodi skaner qilinishidan qat'i nazar,
-- tovar turi bir xil bo'lsa, umumiy tovar qoldig'idan ayiriladi va barcha QR kodlar tovar qoldig'i tugaguncha amal qiladi.

BEGIN;

-- 1. get_pos_unit_context: Skanerlangan QR kod qaysi partiyaga tegishli bo'lishidan qat'i nazar,
-- agar ushbu mahsulotning filialda erkin qoldig'i (boshqa partiyalarda ham) mavjud bo'lsa,
-- do'kondagi yoki ombordagi erkin birlikni qaytaradi va sotuvga ruxsat beradi.
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

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC
  LIMIT 1;

  -- 1. Kod bo'yicha mahsulot va variantni aniqlash (QR kod, seriya raqami, barcode yoki SKU)
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

  -- Agar inventory_units dan topilmasa, to'g'ridan-to'g'ri products jadvalidan izlash
  IF v_target_product_id IS NULL THEN
    SELECT p.id INTO v_target_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_target_product_id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Filialdagi eng mos birlikni tanlash:
  -- Agar filialda ushbu tovarning biror erkin qoldig'i bo'lsa (qaysi partiyadan bo'lishidan qat'i nazar),
  -- o'sha erkin birlik tanlanadi va sotuvga ruxsat beriladi!
  SELECT
    u.id, u.qr_code, u.serial_number, u.status, u.location_id, u.active_transfer_id, u.sold_sale_id,
    u.variant_id,
    pv.color_name as variant_color,
    pv.color_hex as variant_color_hex,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug,
    p.status as product_status, p.is_published,
    p.currency as currency,
    br.name as brand_name,
    coalesce(pv.retail_price, sb.retail_price, p.retail_price) as retail_price,
    coalesce(pv.retail_price_usd, sb.retail_price_usd, p.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.retail_price, sb.retail_price, p.retail_price) / v_rate, 2) ELSE null END) as retail_price_usd,
    coalesce(pv.wholesale_price, sb.wholesale_price, p.wholesale_price) as wholesale_price,
    coalesce(pv.wholesale_price_usd, sb.wholesale_price_usd, p.wholesale_price_usd, CASE WHEN v_rate > 0 AND coalesce(pv.wholesale_price, sb.wholesale_price, p.wholesale_price) IS NOT NULL THEN round(coalesce(pv.wholesale_price, sb.wholesale_price, p.wholesale_price) / v_rate, 2) ELSE null END) as wholesale_price_usd,
    coalesce(pv.minimum_sale_price, sb.minimum_sale_price, p.minimum_sale_price) as minimum_sale_price,
    coalesce(pv.minimum_sale_price_usd, sb.minimum_sale_price_usd, p.minimum_sale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.minimum_sale_price, sb.minimum_sale_price, p.minimum_sale_price) / v_rate, 2) ELSE null END) as minimum_sale_price_usd,
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
  WHERE u.product_id = v_target_product_id
    AND l.type IN ('store', 'warehouse')
  ORDER BY
    -- Priority 1: Shu filialda mavjud erkin birliklar birinchi o'rinda
    CASE WHEN l.branch_id = p_branch_id AND l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    -- Priority 2: Shu filialga tegishli birliklar (agar sotilgan bo'lsa ham boshqa filialdan oldin turadi)
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    -- Priority 3: Boshqa filialda bo'lsa ham erkin turgan birliklar
    CASE WHEN l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    -- Priority 4: Skaner qilingan aniq QR kodga ega bo'lgan birlik
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    -- Priority 5: Aniq variant/rang mosligi
    CASE WHEN v_target_variant_id IS NOT NULL AND u.variant_id = v_target_variant_id THEN 0 ELSE 1 END,
    -- Priority 6: Sotish uchun do'kondagi birlik ombordagidan oldin tavsiya etiladi
    CASE WHEN l.type = 'store' THEN 0 ELSE 1 END,
    -- Priority 7: FIFO - birinchi kirgan partiya birinchi chiqadi
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

  -- Faqat filialda umumiy qoldiq 0 bo'lganda va birlik oldin sotilgan bo'lsa sotuv tafsilotlari yuklanadi
  IF v_total_product_stock = 0 AND v_unit.sold_sale_id IS NOT NULL THEN
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
    'scanned_code', v_code,
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
    -- Jami filialdagi mahsulot qoldig'i (barcha partiyalar va ranglar bilan)
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

REVOKE ALL ON FUNCTION public.get_pos_unit_context(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;


-- 2. get_pos_batch_units: Bir nechta tovar yoki butun partiya qo'shilganda ham,
-- barcha mavjud partiyalardagi birliklarni qamrab oladi
DROP FUNCTION IF EXISTS public.get_pos_batch_units(uuid, text, integer, uuid[]);

CREATE OR REPLACE FUNCTION public.get_pos_batch_units(
  p_branch_id uuid,
  p_code text,
  p_count integer DEFAULT 1,
  p_exclude_ids uuid[] DEFAULT '{}'::uuid[],
  p_prefer_location text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  qr_code text,
  serial_number text,
  location_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_product_id uuid;
  v_variant_id uuid;
  v_exclude uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  v_limit integer := greatest(1, least(50, coalesce(p_count, 1)));
  v_prefer text := lower(coalesce(nullif(btrim(p_prefer_location), ''), 'store'));
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Kod talab qilinadi' USING errcode = '22023';
  END IF;

  -- 1. Kod bo'yicha mahsulotni aniqlash
  SELECT u.product_id, u.variant_id INTO v_product_id, v_variant_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE (
    upper(u.qr_code) = upper(v_code)
    OR upper(coalesce(u.serial_number, '')) = upper(v_code)
  )
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    u.created_at DESC
  LIMIT 1;

  IF v_product_id IS NULL THEN
    SELECT p.id INTO v_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Filialdagi ushbu mahsulotning barcha erkin birliklarini tanlash
  RETURN QUERY
  SELECT
    u.id,
    u.qr_code,
    u.serial_number,
    l.type::text AS location_type
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  WHERE l.branch_id = p_branch_id
    AND l.is_active
    AND l.type IN ('store', 'warehouse')
    AND u.status = 'available'
    AND u.active_transfer_id IS NULL
    AND p.status = 'active'
    AND u.product_id = v_product_id
    AND NOT (u.id = ANY(v_exclude))
  ORDER BY
    -- Skaner qilingan aniq QR kod birligi birinchi tanlanadi
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    -- Variant mosligi
    CASE WHEN v_variant_id IS NOT NULL AND u.variant_id = v_variant_id THEN 0 ELSE 1 END,
    -- Joylashuv ustuvorligi (do'kon yoki ombor)
    CASE
      WHEN v_prefer = 'warehouse' THEN (CASE WHEN l.type = 'warehouse' THEN 0 ELSE 1 END)
      ELSE (CASE WHEN l.type = 'store' THEN 0 ELSE 1 END)
    END,
    u.created_at ASC,
    u.id ASC
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_batch_units(uuid, text, integer, uuid[], text) TO authenticated, service_role;


-- 3. find_pos_unit: Barcha mavjud partiyalardagi tovar birliklariga ruxsat berish
CREATE OR REPLACE FUNCTION public.find_pos_unit(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_product_id uuid;
  v_variant_id uuid;
  v_result jsonb;
BEGIN
  IF NOT public.can_access_branch(p_branch_id) THEN
    RAISE EXCEPTION 'Filialga ruxsat yo''q' USING errcode = '42501';
  END IF;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Kod talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT u.product_id, u.variant_id INTO v_product_id, v_variant_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE (
    upper(u.qr_code) = upper(v_code)
    OR upper(coalesce(u.serial_number, '')) = upper(v_code)
  )
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    u.created_at DESC
  LIMIT 1;

  IF v_product_id IS NULL THEN
    SELECT p.id INTO v_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Mahsulot topilmadi yoki sotuvga tayyor emas' USING errcode = 'P0002';
  END IF;

  SELECT jsonb_build_object(
    'id', u.id, 'qr_code', u.qr_code, 'scanned_code', v_code, 'serial_number', u.serial_number, 'status', u.status,
    'product_id', p.id, 'product_name', p.name, 'sku', p.sku, 'brand_name', br.name,
    'retail_price', coalesce(pv.retail_price, b.retail_price, p.retail_price),
    'wholesale_price', coalesce(pv.wholesale_price, b.wholesale_price, p.wholesale_price),
    'minimum_sale_price', coalesce(pv.minimum_sale_price, b.minimum_sale_price, p.minimum_sale_price),
    'cost_price', p.cost_price, 'unit_cost', coalesce(pv.cost_price, b.unit_cost, p.cost_price), 'tax_rate', p.tax_rate,
    'batch_retail_price', b.retail_price,
    'product_retail_price', p.retail_price,
    'image', (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
    'available_branch_count', (
      SELECT count(*) FROM public.inventory_units iu
      JOIN public.locations il ON il.id = iu.location_id
      WHERE iu.product_id = p.id AND il.branch_id = p_branch_id AND il.is_active AND iu.status = 'available' AND iu.active_transfer_id IS NULL
    )
  )
  INTO v_result
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  JOIN public.locations l ON l.id = u.location_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches b ON b.id = u.batch_id
  LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
  WHERE l.branch_id = p_branch_id
    AND l.is_active
    AND l.type IN ('store', 'warehouse')
    AND u.status = 'available'
    AND u.active_transfer_id IS NULL
    AND p.status = 'active'
    AND u.product_id = v_product_id
  ORDER BY
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    CASE WHEN v_variant_id IS NOT NULL AND u.variant_id = v_variant_id THEN 0 ELSE 1 END,
    CASE WHEN l.type = 'store' THEN 0 ELSE 1 END,
    u.created_at ASC,
    u.id ASC
  LIMIT 1;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Mahsulot topilmadi yoki sotuvga tayyor emas' USING errcode = 'P0002';
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_pos_unit(uuid, text) TO authenticated, service_role;


-- 4. find_transfer_unit: Joylar va filiallar o'rtasida ko'chirishda barcha partiyalarga ruxsat berish
CREATE OR REPLACE FUNCTION public.find_transfer_unit(p_branch_id uuid, p_from_location_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_product_id uuid;
  v_result jsonb;
  v_rate numeric;
  v_rate_date date;
BEGIN
  PERFORM public.require_source_shipper(p_branch_id);
  IF NOT EXISTS(SELECT 1 FROM public.locations WHERE id = p_from_location_id AND branch_id = p_branch_id AND is_active AND type IN ('store','warehouse')) THEN
    RAISE EXCEPTION 'Faol jo''natish joyi topilmadi' USING errcode = 'P0002';
  END IF;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR yoki seriya raqami talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT r.rate, r.rate_date INTO v_rate, v_rate_date
  FROM public.exchange_rates r
  WHERE r.currency_from = 'USD' AND r.currency_to = 'UZS'
  ORDER BY r.rate_date DESC
  LIMIT 1;

  IF v_rate IS NULL OR v_rate <= 0 OR v_rate_date IS NULL THEN
    v_rate := 11850;
    v_rate_date := current_date;
  END IF;

  -- Mahsulotni aniqlash
  SELECT u.product_id INTO v_product_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE (
    upper(u.qr_code) = upper(v_code)
    OR upper(coalesce(u.serial_number, '')) = upper(v_code)
  )
  ORDER BY
    CASE WHEN l.id = p_from_location_id AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    u.created_at DESC
  LIMIT 1;

  IF v_product_id IS NULL THEN
    SELECT p.id INTO v_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Erkin mahsulot birligi topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT jsonb_build_object(
    'id', u.id,
    'qr_code', u.qr_code,
    'scanned_code', v_code,
    'serial_number', u.serial_number,
    'location_id', u.location_id,
    'product_id', p.id,
    'product_name', p.name,
    'sku', p.sku,
    'cost_price', coalesce(b.unit_cost, p.cost_price),
    'wholesale_price', coalesce(round(nullif(coalesce(b.wholesale_price, p.wholesale_price), 0) / v_rate, 2), round(coalesce(b.unit_cost, p.cost_price, p.retail_price, 0) / v_rate, 2), 0),
    'currency', 'USD',
    'wholesale_exchange_rate', v_rate,
    'wholesale_rate_date', v_rate_date,
    'available_count', (
      SELECT count(*) FROM public.inventory_units iu
      WHERE iu.product_id = p.id AND iu.location_id = p_from_location_id AND iu.status = 'available' AND iu.active_transfer_id IS NULL
    ),
    'latest_batch_price', coalesce(round(
      (SELECT lb.wholesale_price FROM public.stock_batches lb JOIN public.stock_receipts lr ON lr.id = lb.receipt_id
        WHERE lb.product_id = p.id AND lb.wholesale_price IS NOT NULL AND lb.wholesale_price > 0
        ORDER BY lr.received_at DESC LIMIT 1) / v_rate, 2),
      round(nullif(coalesce(b.wholesale_price, p.wholesale_price), 0) / v_rate, 2),
      round(coalesce(b.unit_cost, p.cost_price, p.retail_price, 0) / v_rate, 2), 0),
    'latest_batch_date', (
      SELECT lr.received_at::date FROM public.stock_batches lb JOIN public.stock_receipts lr ON lr.id = lb.receipt_id
      WHERE lb.product_id = p.id AND lb.wholesale_price IS NOT NULL AND lb.wholesale_price > 0
      ORDER BY lr.received_at DESC LIMIT 1
    ),
    'image', (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
  )
  INTO v_result
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.stock_batches b ON b.id = u.batch_id
  WHERE u.location_id = p_from_location_id
    AND u.status = 'available'
    AND u.active_transfer_id IS NULL
    AND u.product_id = v_product_id
  ORDER BY
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    u.created_at ASC,
    u.id ASC
  LIMIT 1;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Erkin mahsulot birligi topilmadi' USING errcode = 'P0002';
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_transfer_unit(uuid, uuid, text) TO authenticated, service_role;


-- 5. count_inventory_unit: Inventarizatsiyada bir xil QR kod takror skaner qilinganda
-- o'sha partiyadagi yoki shu mahsulotning keyingi sanalmagan birligini hisobga oladi
CREATE OR REPLACE FUNCTION public.count_inventory_unit(p_count_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count public.inventory_counts%rowtype;
  v_unit public.inventory_units%rowtype;
  v_branch uuid;
  v_line uuid;
  v_target_product_id uuid;
BEGIN
  SELECT * INTO v_count FROM public.inventory_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventarizatsiya topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT branch_id INTO v_branch FROM public.locations WHERE id = v_count.location_id;
  PERFORM public.require_inventory_operator(v_branch);

  IF v_count.status <> 'counting' THEN
    RAISE EXCEPTION 'Hisob counting holatida emas' USING errcode = 'P0001';
  END IF;

  IF nullif(btrim(p_code), '') IS NULL THEN
    RAISE EXCEPTION 'QR yoki seriya talab qilinadi' USING errcode = '22023';
  END IF;

  -- 1. Avval aynan shu QR kodga ega hali sanalmagan birlikni qidiramiz
  SELECT u.* INTO v_unit
  FROM public.inventory_units u
  WHERE (upper(u.qr_code) = upper(btrim(p_code)) OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
    AND u.status NOT IN ('sold', 'written_off', 'in_transit')
    AND u.active_transfer_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_count_lines icl
      WHERE icl.inventory_count_id = p_count_id AND icl.unit_id = u.id AND icl.counted_quantity > 0
    )
  ORDER BY
    CASE WHEN u.location_id = v_count.location_id THEN 0 ELSE 1 END,
    u.created_at ASC,
    u.id ASC
  FOR UPDATE OF u
  LIMIT 1;

  -- 2. Agar aynan shu QR kodli barcha donalar sanalgan bo'lsa,
  -- lekin foydalanuvchi yana shu tovardan skaner qilsa, shu tovarning sanalmagan boshqa birligini olamiz
  IF v_unit.id IS NULL THEN
    SELECT u.product_id INTO v_target_product_id
    FROM public.inventory_units u
    WHERE upper(u.qr_code) = upper(btrim(p_code)) OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code))
    LIMIT 1;

    IF v_target_product_id IS NOT NULL THEN
      SELECT u.* INTO v_unit
      FROM public.inventory_units u
      WHERE u.product_id = v_target_product_id
        AND u.status NOT IN ('sold', 'written_off', 'in_transit')
        AND u.active_transfer_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.inventory_count_lines icl
          WHERE icl.inventory_count_id = p_count_id AND icl.unit_id = u.id AND icl.counted_quantity > 0
        )
      ORDER BY
        CASE WHEN u.location_id = v_count.location_id THEN 0 ELSE 1 END,
        u.created_at ASC,
        u.id ASC
      FOR UPDATE OF u
      LIMIT 1;
    END IF;
  END IF;

  -- Agar umuman sanalmagan birlik qolmagan bo'lsa, xatolik beramiz
  IF v_unit.id IS NULL THEN
    RAISE EXCEPTION 'Ushbu tovarning barcha birliklari allaqachon sanalgan yoki mavjud emas' USING errcode = 'P0002';
  END IF;

  IF coalesce(v_count.scope->>'mode','full') = 'scoped' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_count.scope->'product_ids') e
    WHERE (e.value#>>'{}')::uuid = v_unit.product_id
  ) THEN
    RAISE EXCEPTION 'Mahsulot hisob scope iga kirmaydi' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.inventory_count_lines(
    inventory_count_id, product_id, unit_id, expected_quantity, counted_quantity, counted_by, counted_at, expected_unit_version
  ) VALUES (
    p_count_id, v_unit.product_id, v_unit.id,
    CASE WHEN v_unit.location_id = v_count.location_id THEN 1 ELSE 0 END,
    1, auth.uid(), now(), v_unit.version
  )
  ON CONFLICT (inventory_count_id, unit_id) DO UPDATE
    SET counted_quantity = 1, counted_by = auth.uid(), counted_at = now()
  RETURNING id INTO v_line;

  RETURN jsonb_build_object(
    'line_id', v_line,
    'unit_id', v_unit.id,
    'product_id', v_unit.product_id,
    'expected_location_id', v_unit.location_id,
    'count_location_id', v_count.location_id,
    'counted', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.count_inventory_unit(uuid, text) TO authenticated, service_role;


-- 6. courier_verify_product_unit_qr: Kuryer tovarlarni tekshirganda, qaysi partiya QR kodi
-- bo'lishidan qat'i nazar, mahsulot turi to'g'ri bo'lsa qabul qiladi
CREATE OR REPLACE FUNCTION public.courier_verify_product_unit_qr(
  p_delivery_id uuid,
  p_scanned_code text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
  v_clean_code text := trim(p_scanned_code);
  v_item jsonb;
  v_unit record;
  v_matched boolean := false;
  v_exact_unit boolean := false;
  v_matched_item jsonb := null;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka topilmadi' USING errcode = 'P0002';
  END IF;

  -- 1. Check if scanned code directly matches an item's qr_code, batch_code, or sku
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_del.items) LOOP
    IF lower(coalesce(v_item->>'qr_code', '')) = lower(v_clean_code)
       OR lower(coalesce(v_item->>'batch_code', '')) = lower(v_clean_code)
       OR lower(coalesce(v_item->>'sku', '')) = lower(v_clean_code) THEN
      v_matched := true;
      v_exact_unit := (lower(coalesce(v_item->>'qr_code', '')) = lower(v_clean_code));
      v_matched_item := v_item;
      EXIT;
    END IF;
  END LOOP;

  IF v_matched THEN
    RETURN jsonb_build_object(
      'matched', true,
      'exact_unit', v_exact_unit,
      'product_id', v_matched_item->>'product_id',
      'product_name', v_matched_item->>'product_name',
      'sku', v_matched_item->>'sku',
      'message', CASE
        WHEN v_exact_unit THEN 'Aynan biriktirilgan tovar birligi (' || v_clean_code || ') tasdiqlandi!'
        ELSE 'To‘g‘ri tovar tanlandi: ' || (v_matched_item->>'product_name')
      END
    );
  END IF;

  -- 2. Check if scanned code belongs to any inventory unit or product in the database
  SELECT u.*, p.name AS product_name, p.sku AS product_sku
  INTO v_unit
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  WHERE lower(u.qr_code) = lower(v_clean_code)
     OR lower(coalesce(u.serial_number, '')) = lower(v_clean_code)
  LIMIT 1;

  IF FOUND THEN
    -- Check if this unit's product_id is in this delivery's items
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_del.items) LOOP
      IF (v_item->>'product_id')::uuid = v_unit.product_id THEN
        RETURN jsonb_build_object(
          'matched', true,
          'exact_unit', false,
          'product_id', v_unit.product_id,
          'product_name', v_unit.product_name,
          'sku', v_unit.product_sku,
          'message', 'Tovar turi to‘g‘ri (' || v_unit.product_name || '). Ombordan boshqa to‘g‘ri partiya birligi tanlandi.'
        );
      END IF;
    END LOOP;

    -- Scanned existing unit, but it belongs to a completely different product!
    RETURN jsonb_build_object(
      'matched', false,
      'exact_unit', false,
      'product_name', v_unit.product_name,
      'sku', v_unit.product_sku,
      'message', 'Xato tovar! Siz skanerlagan tovar (' || v_unit.product_name || ') ushbu buyurtmaga tegishli emas.'
    );
  END IF;

  -- 3. Check by SKU directly in products table
  SELECT * INTO v_unit FROM public.products WHERE lower(sku) = lower(v_clean_code) LIMIT 1;
  IF FOUND THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_del.items) LOOP
      IF (v_item->>'product_id')::uuid = v_unit.id THEN
        RETURN jsonb_build_object(
          'matched', true,
          'exact_unit', false,
          'product_id', v_unit.id,
          'product_name', v_unit.name,
          'sku', v_unit.sku,
          'message', 'Tovar SKU orqali tasdiqlandi: ' || v_unit.name
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'matched', false,
    'exact_unit', false,
    'message', 'Bunday QR kodli tovar topilmadi (' || v_clean_code || ')'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_verify_product_unit_qr(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
