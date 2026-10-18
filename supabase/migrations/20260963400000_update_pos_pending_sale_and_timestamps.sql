-- Migration: 20260963400000_update_pos_pending_sale_and_timestamps.sql
-- Enables full editing of pending sales by sellers and managers,
-- allows sellers to cancel/delete their own pending sales,
-- and exposes both created_at and updated_at to admin and seller.

-- 1. Create update_pos_pending_sale RPC
CREATE OR REPLACE FUNCTION public.update_pos_pending_sale(
  p_pending_id uuid,
  p_lines jsonb,
  p_payments jsonb,
  p_notes text DEFAULT null,
  p_customer jsonb DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_pending public.pos_pending_sales%rowtype;
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
  v_method public.payment_methods%rowtype;
  v_sort integer := 0;
  v_is_seller boolean;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_phone text;
  v_customer_address text;
  v_old_unit_ids uuid[];
  v_new_unit_ids uuid[];
  v_removed_unit_ids uuid[];
  v_added_unit_ids uuid[];
  v_minutes integer := 15;
  v_sel_comps jsonb;
BEGIN
  -- 1. Lock pending sale
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so‘rovi topilmadi: %', p_pending_id USING errcode = 'P0002';
  END IF;

  IF v_pending.status <> 'pending' THEN
    RAISE EXCEPTION 'Faqat kutilayotgan (pending) kassa so‘rovini tahrirlash mumkin. Ushbu so‘rov holati: %', v_pending.status USING errcode = 'P0001';
  END IF;

  -- 2. Verify permission: seller who created it OR manager/admin
  IF NOT (
    (v_pending.seller_id = auth.uid() AND public.has_role(array['seller']::public.app_role[], v_pending.branch_id))
    OR public.has_role(array['superadmin', 'admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_pending.branch_id)
  ) THEN
    RAISE EXCEPTION 'Faqat sotuvchi yoki menejer ushbu kassa so‘rovini tahrirlay oladi' USING errcode = '42501';
  END IF;

  -- 3. Validate input arrays
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
    OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50
    OR p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array'
    OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'POS qatorlari yoki to‘lovlari noto‘g‘ri' USING errcode = '22023';
  END IF;

  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) e GROUP BY (e->>'unit_id')::uuid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Mahsulot birliklari takrorlanmasligi kerak' USING errcode = '22023';
  END IF;

  -- 4. Get old reserved unit IDs
  SELECT coalesce(array_agg(unit_id), ARRAY[]::uuid[]) INTO v_old_unit_ids
  FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;

  -- Get new unit IDs
  SELECT coalesce(array_agg((e->>'unit_id')::uuid), ARRAY[]::uuid[]) INTO v_new_unit_ids
  FROM jsonb_array_elements(p_lines) e;

  -- Units removed from sale: return to 'available'
  SELECT coalesce(array_agg(u), ARRAY[]::uuid[]) INTO v_removed_unit_ids
  FROM unnest(v_old_unit_ids) u WHERE u != ALL(v_new_unit_ids);

  IF array_length(v_removed_unit_ids, 1) > 0 THEN
    UPDATE public.inventory_units
    SET status = 'available', reserved_until = NULL, version = version + 1
    WHERE id = ANY(v_removed_unit_ids) AND status = 'reserved';
  END IF;

  -- Units newly added to sale: lock and verify
  SELECT coalesce(array_agg(u), ARRAY[]::uuid[]) INTO v_added_unit_ids
  FROM unnest(v_new_unit_ids) u WHERE u != ALL(v_old_unit_ids);

  IF array_length(v_added_unit_ids, 1) > 0 THEN
    PERFORM 1 FROM public.inventory_units WHERE id = ANY(v_added_unit_ids) ORDER BY id FOR UPDATE;
  END IF;

  v_is_seller := public.has_role(array['seller']::public.app_role[], v_pending.branch_id)
    AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], v_pending.branch_id));

  -- 5. Customer handling
  v_customer_id := v_pending.customer_id;
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

  -- 6. Validate each line
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

    IF v_p.branch_id <> v_pending.branch_id OR v_p.location_type NOT IN ('store','warehouse') OR NOT v_p.location_active THEN
      RAISE EXCEPTION 'Mahsulot POS uchun erkin emas: %', v_unit_id USING errcode = 'P0001';
    END IF;

    -- If this is a newly added unit, it must be available
    IF v_unit_id = ANY(v_added_unit_ids) THEN
      IF v_u.status <> 'available' OR v_u.active_transfer_id IS NOT NULL THEN
        RAISE EXCEPTION 'Yangi qo‘shilgan mahsulot mavjud emas yoki band: %', v_unit_id USING errcode = 'P0001';
      END IF;
      UPDATE public.inventory_units SET status = 'reserved', version = version + 1 WHERE id = v_unit_id;
    ELSE
      IF v_u.status <> 'reserved' AND v_u.status <> 'available' THEN
        RAISE EXCEPTION 'Mahsulot holati noto‘g‘ri: %', v_unit_id USING errcode = 'P0001';
      END IF;
    END IF;

    IF v_p.status <> 'active' THEN
      RAISE EXCEPTION 'Mahsulot faol emas: %', v_unit_id USING errcode = 'P0001';
    END IF;

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

  v_total := v_subtotal - v_discount_total + v_tax_total;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'POS jami summasi musbat bo‘lishi kerak' USING errcode = '22023';
  END IF;

  -- 7. Validate payments
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

  -- 8. Delete old lines & payments
  DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id;
  DELETE FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;

  -- 9. Insert new lines
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'unit_id')::uuid LOOP
    v_unit_id := (v_item->>'unit_id')::uuid;
    v_price := (v_item->>'unit_price')::numeric(18,2);
    v_discount := coalesce((v_item->>'discount')::numeric(18,2), 0);
    v_sel_comps := coalesce(v_item->'selected_components', '[]'::jsonb);

    SELECT * INTO v_u FROM public.inventory_units WHERE id = v_unit_id;
    SELECT p.* INTO v_p FROM public.products p WHERE p.id = v_u.product_id;

    v_tax := round((v_price - v_discount) * v_p.tax_rate / 100, 2);
    v_line_total := v_price - v_discount + v_tax;

    INSERT INTO public.pos_pending_sale_lines(
      pending_sale_id, product_id, unit_id, quantity, unit_price, discount, tax, line_total, selected_components
    ) VALUES (
      p_pending_id, v_u.product_id, v_unit_id, 1, v_price, v_discount, v_tax, v_line_total, v_sel_comps
    );
  END LOOP;

  -- 10. Insert new payments
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active AND code <> 'cod';
    INSERT INTO public.pos_pending_sale_payments(
      pending_sale_id, payment_method_id, amount, external_reference, sort_order
    ) VALUES (
      p_pending_id, v_method.id, (v_item->>'amount')::numeric(18,2), nullif(btrim(v_item->>'external_reference'), ''), v_sort
    );
  END LOOP;

  -- 11. Update pending sale header with timestamps
  UPDATE public.pos_pending_sales SET
    customer_id = v_customer_id,
    subtotal = v_subtotal,
    discount = v_discount_total,
    tax = v_tax_total,
    total = v_total,
    notes = nullif(btrim(p_notes), ''),
    expires_at = now() + (v_minutes || ' minutes')::interval,
    updated_at = now()
  WHERE id = p_pending_id;

  RETURN public.get_pos_pending_sale(p_pending_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_pos_pending_sale(uuid, jsonb, jsonb, text, jsonb) TO authenticated, service_role;


-- 2. Allow seller to cancel their own pending sale via delete_pos_pending_sale
CREATE OR REPLACE FUNCTION public.delete_pos_pending_sale(p_pending_id uuid, p_restore_stock boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_pending public.pos_pending_sales%rowtype;
  v_sale_id uuid;
BEGIN
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so‘rovi topilmadi.' USING errcode = 'P0002';
  END IF;

  -- Allowed if admin, manager, OR the seller who created it when still pending
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR (v_pending.branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], v_pending.branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
    OR (v_pending.seller_id = v_caller_id AND v_pending.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'Kassa so‘rovini faqat administrator, menejer yoki uni yaratgan sotuvchi bekor qila oladi.' USING errcode = '42501';
  END IF;

  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  SELECT id INTO v_sale_id FROM public.sales WHERE pending_sale_id = p_pending_id LIMIT 1;

  IF v_sale_id IS NOT NULL THEN
    PERFORM public.delete_sale(v_sale_id, p_restore_stock);
  ELSE
    IF p_restore_stock THEN
      UPDATE public.inventory_units
      SET status = 'available', reserved_until = NULL, version = version + 1
      WHERE id IN (
        SELECT unit_id FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id
      ) AND status = 'reserved';
    END IF;

    DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id;
    DELETE FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;
    DELETE FROM public.pos_pending_sales WHERE id = p_pending_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 
    'message', 
    CASE WHEN p_restore_stock 
      THEN 'Kassa kirimi o‘chirildi va tovar omborga qaytarildi.'
      ELSE 'Kassa kirimi butunlay o‘chirildi (tovar omborga qaytarilmadi).'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_pos_pending_sale(uuid, boolean) TO authenticated, service_role;


-- 3. Enhance get_pos_pending_sale to return customer details and updated_at
CREATE OR REPLACE FUNCTION public.get_pos_pending_sale(p_pending_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_result jsonb;
  v_manager boolean;
BEGIN
  SELECT * INTO v_s FROM public.pos_pending_sales WHERE id = p_pending_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_s.branch_id);

  IF NOT v_manager AND NOT (v_s.seller_id = auth.uid() AND public.has_role(array['seller']::public.app_role[], v_s.branch_id)) THEN
    RAISE EXCEPTION 'POS so‘rovi uchun ruxsat yo‘q' USING errcode = '42501';
  END IF;

  IF v_s.status = 'pending' AND v_s.expires_at <= now() THEN
    PERFORM public.release_pos_reservation(v_s.id, 'expired', 'Rezerv muddati tugadi', auth.uid());
  END IF;

  SELECT to_jsonb(s) || jsonb_build_object(
    'seller_name', seller.full_name,
    'location_name', loc.name,
    'customer', (
      SELECT jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'address', c.address->>'address')
      FROM public.customers c WHERE c.id = s.customer_id
    ),
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', x.id,
        'unit_id', x.unit_id,
        'product_id', x.product_id,
        'product_name', p.name,
        'sku', p.sku,
        'qr_code', u.qr_code,
        'serial_number', u.serial_number,
        'image', (SELECT url FROM public.product_media WHERE product_id = p.id AND is_primary LIMIT 1),
        'unit_price', x.unit_price,
        'discount', x.discount,
        'tax', x.tax,
        'line_total', x.line_total,
        'retail_price', p.retail_price,
        'minimum_sale_price', p.minimum_sale_price,
        'unit_cost', coalesce(sb.unit_cost, p.cost_price),
        'profit', x.line_total - x.tax - coalesce(sb.unit_cost, p.cost_price),
        'selected_components', coalesce(x.selected_components, '[]'::jsonb)
      ) ORDER BY x.created_at, x.id)
      FROM public.pos_pending_sale_lines x
      JOIN public.products p ON p.id = x.product_id
      JOIN public.inventory_units u ON u.id = x.unit_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      WHERE x.pending_sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'method_id', pm.id,
        'method_code', pm.code,
        'method_name', pm.name,
        'amount', pp.amount,
        'external_reference', pp.external_reference,
        'sort_order', pp.sort_order
      ) ORDER BY pp.sort_order)
      FROM public.pos_pending_sale_payments pp
      JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
      WHERE pp.pending_sale_id = s.id
    ), '[]'::jsonb),
    'can_confirm', s.status = 'pending' AND s.expires_at > now() AND v_manager,
    'can_reject', s.status = 'pending' AND v_manager,
    'remaining_seconds', greatest(0, floor(extract(epoch FROM (s.expires_at - now())))::integer)
  )
  INTO v_result
  FROM public.pos_pending_sales s
  JOIN public.profiles seller ON seller.id = s.seller_id
  JOIN public.locations loc ON loc.id = s.store_location_id
  WHERE s.id = p_pending_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_pending_sale(uuid) TO authenticated, service_role;


-- 4. Include updated_at in list_pos_pending_sales and list_my_pos_pending_sales_by_date
CREATE OR REPLACE FUNCTION public.list_pos_pending_sales(
  p_branch_id uuid,
  p_status public.pending_sale_status DEFAULT null,
  p_query text DEFAULT null,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_manager boolean;
  v_items jsonb;
  v_total bigint;
  v_summary jsonb;
  v_q text := nullif(btrim(p_query), '');
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  PERFORM public.release_expired_pos_sales(p_branch_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  SELECT count(*) INTO v_total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND (v_manager OR s.seller_id = auth.uid())
    AND (p_status IS NULL OR s.status = p_status)
    AND (v_q IS NULL OR s.pending_no ILIKE '%' || v_q || '%' OR EXISTS(
      SELECT 1 FROM public.profiles p WHERE p.id = s.seller_id AND p.full_name ILIKE '%' || v_q || '%'
    ));

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      s.id, s.pending_no, s.status, s.seller_id,
      p.full_name AS seller_name,
      s.store_location_id, l.name AS location_name,
      (SELECT count(*) FROM public.pos_pending_sale_lines x WHERE x.pending_sale_id = s.id) AS unit_count,
      s.total, s.created_at, s.updated_at, s.expires_at, s.notes,
      (s.updated_at > s.created_at + interval '1 second') AS is_edited
    FROM public.pos_pending_sales s
    JOIN public.profiles p ON p.id = s.seller_id
    JOIN public.locations l ON l.id = s.store_location_id
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND (p_status IS NULL OR s.status = p_status)
      AND (v_q IS NULL OR s.pending_no ILIKE '%' || v_q || '%' OR p.full_name ILIKE '%' || v_q || '%')
    ORDER BY s.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  SELECT jsonb_build_object(
    'pending_count', count(*) FILTER (WHERE status = 'pending'),
    'pending_amount', coalesce(sum(total) FILTER (WHERE status = 'pending'), 0),
    'confirmed_today_count', count(*) FILTER (WHERE status = 'confirmed' AND confirmed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'),
    'confirmed_today_amount', coalesce(sum(total) FILTER (WHERE status = 'confirmed' AND confirmed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'), 0)
  )
  INTO v_summary
  FROM public.pos_pending_sales
  WHERE branch_id = p_branch_id AND (v_manager OR seller_id = auth.uid());

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'summary', v_summary);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_pending_sales(uuid, public.pending_sale_status, text, integer, integer) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.list_my_pos_pending_sales_by_date(
  p_branch_id uuid,
  p_date date,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_timezone text;
  v_date date;
  v_start timestamptz;
  v_end timestamptz;
  v_items jsonb;
  v_total bigint;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  PERFORM public.release_expired_pos_sales(p_branch_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  SELECT coalesce(b.timezone, 'Asia/Tashkent') INTO v_timezone
  FROM public.branches b WHERE b.id = p_branch_id;
  IF v_timezone IS NULL THEN
    RAISE EXCEPTION 'Filial topilmadi' USING errcode = 'P0002';
  END IF;

  v_date := coalesce(p_date, (now() AT TIME ZONE v_timezone)::date);
  v_start := v_date::timestamp AT TIME ZONE v_timezone;
  v_end := (v_date + 1)::timestamp AT TIME ZONE v_timezone;

  SELECT count(*) INTO v_total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND s.seller_id = auth.uid()
    AND s.created_at >= v_start AND s.created_at < v_end;

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC, q.id), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      s.id, s.pending_no, s.status, s.seller_id,
      p.full_name AS seller_name,
      s.store_location_id, l.name AS location_name,
      (SELECT count(*) FROM public.pos_pending_sale_lines x WHERE x.pending_sale_id = s.id) AS unit_count,
      s.total, s.created_at, s.updated_at, s.expires_at, s.notes,
      (s.updated_at > s.created_at + interval '1 second') AS is_edited
    FROM public.pos_pending_sales s
    JOIN public.profiles p ON p.id = s.seller_id
    JOIN public.locations l ON l.id = s.store_location_id
    WHERE s.branch_id = p_branch_id
      AND s.seller_id = auth.uid()
      AND s.created_at >= v_start AND s.created_at < v_end
    ORDER BY s.created_at DESC, s.id
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'date', v_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_pos_pending_sales_by_date(uuid, date, integer, integer) TO authenticated, service_role;
