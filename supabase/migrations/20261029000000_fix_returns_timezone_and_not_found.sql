-- =============================================================================
-- Migration: 20261029000000_fix_returns_timezone_and_not_found.sql
-- Description:
-- 1. Fix list_branch_sold_units_by_date: use branch local date (now() at time zone v_timezone)::date
--    instead of UTC current_date so Uzbekistan past-midnight queries (00:00 - 05:00) do not throw 400.
-- 2. Fix find_sale_return_unit: return clean { eligible: false, reason: '...' } when a QR/serial
--    is not found instead of throwing unhandled P0002 which PostgREST translates into HTTP 500 error.
-- =============================================================================

-- 1. FIX list_branch_sold_units_by_date
CREATE OR REPLACE FUNCTION public.list_branch_sold_units_by_date(
  p_branch_id uuid,
  p_date date,
  p_query text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_timezone text;
  v_today date;
  v_start timestamptz;
  v_end timestamptz;
  v_query text := nullif(btrim(p_query), '');
  v_items jsonb;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial talab qilinadi' USING errcode = '22023';
  END IF;
  PERFORM public.require_pos_seller(p_branch_id);

  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Sana ko‘rsatilishi shart' USING errcode = '22023';
  END IF;

  SELECT coalesce(b.timezone, 'Asia/Tashkent') INTO v_timezone
  FROM public.branches b WHERE b.id = p_branch_id;
  IF v_timezone IS NULL THEN v_timezone := 'Asia/Tashkent'; END IF;

  -- Filial vaqti bo'yicha joriy sana
  v_today := (now() AT TIME ZONE v_timezone)::date;

  -- 30 kunlik tekshiruv (filial vaqt mintaqasi bo'yicha)
  IF p_date < (v_today - 31) THEN
    RAISE EXCEPTION 'Tanlangan sana 1 oydan (30 kundan) ortiq eski. Qaytarish faqat 1 oygacha bo‘lgan savdolarga amal qiladi.' USING errcode = '22023';
  END IF;
  IF p_date > v_today THEN
    RAISE EXCEPTION 'Kelgusi sanani tanlab bo‘lmaydi' USING errcode = '22023';
  END IF;

  v_start := p_date::timestamp AT TIME ZONE v_timezone;
  v_end := (p_date + 1)::timestamp AT TIME ZONE v_timezone;

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.sold_at DESC, q.sale_line_id DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      u.id AS unit_id,
      u.qr_code,
      u.serial_number,
      u.status AS unit_status,
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      (SELECT pm.public_url FROM public.product_media pm WHERE pm.product_id = p.id ORDER BY pm.is_primary DESC, pm.sort_order LIMIT 1) AS image,
      b.reference AS batch_reference,
      b.id AS batch_id,
      s.id AS sale_id,
      s.sale_no,
      s.sold_at,
      sl.id AS sale_line_id,
      sl.unit_price,
      sl.discount,
      sl.tax,
      sl.line_total,
      seller.full_name AS seller_name,
      cust.full_name AS customer_name,
      cust.phone AS customer_phone,
      (
        u.status = 'sold'
        AND s.status <> 'void'
        AND NOT EXISTS (
          SELECT 1 FROM public.sale_return_lines x
          JOIN public.sale_returns r ON r.id = x.return_id
          WHERE x.unit_id = u.id AND r.status IN ('requested', 'approved', 'completed')
        )
      ) AS is_returnable
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.inventory_units u ON u.id = sl.unit_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.stock_batches b ON b.id = u.batch_id
    JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.customers cust ON cust.id = s.customer_id
    WHERE s.branch_id = p_branch_id
      AND s.status <> 'void'
      AND s.sold_at >= v_start AND s.sold_at < v_end
      AND (
        v_query IS NULL
        OR p.name ILIKE '%' || v_query || '%'
        OR p.sku ILIKE '%' || v_query || '%'
        OR u.qr_code ILIKE '%' || v_query || '%'
        OR coalesce(u.serial_number, '') ILIKE '%' || v_query || '%'
        OR s.sale_no ILIKE '%' || v_query || '%'
        OR coalesce(cust.full_name, '') ILIKE '%' || v_query || '%'
        OR coalesce(cust.phone, '') ILIKE '%' || v_query || '%'
      )
    ORDER BY s.sold_at DESC, sl.created_at DESC
    LIMIT 200
  ) q;

  RETURN v_items;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_branch_sold_units_by_date(uuid, date, text) TO authenticated, service_role;

-- 2. FIX find_sale_return_unit
CREATE OR REPLACE FUNCTION public.find_sale_return_unit(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
    RETURN jsonb_build_object(
      'eligible', false,
      'not_found', true,
      'reason', 'QR yoki seriya raqami kiritilmadi.'
    );
  END IF;

  -- Clean QR code if scanned as URL or has secret cost params
  IF v_code ~* '/qr/' THEN
    v_code := substring(v_code from '/qr/([^/?#\s]+)');
  END IF;
  IF v_code LIKE '%?%' THEN
    v_code := split_part(v_code, '?', 1);
  END IF;
  v_code := nullif(btrim(v_code), '');

  IF v_code IS NULL THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'not_found', true,
      'reason', 'QR yoki seriya raqami kiritilmadi.'
    );
  END IF;

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

  IF NOT FOUND OR v_u.id IS NULL THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'not_found', true,
      'reason', 'QR yoki seriya raqami bo‘yicha tovar topilmadi (' || v_code || '). QR yoki seriya raqamini tekshirib qayta kiriting.'
    );
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
      v_reason := 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (' || to_char(v_sale.sold_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM.YYYY') || ', ' || v_days_passed || ' kun oldin). Qaytarish muddati (30 kun) tugagan.';
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
