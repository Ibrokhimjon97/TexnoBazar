-- Migration: Disable POS sale expiration completely and restore all expired sales to pending
-- Sales remain in pending indefinitely until manager confirms or rejects them.

-- 1. Restore all currently expired pos_pending_sales back to pending and re-reserve their inventory units
UPDATE public.inventory_units u
SET status = 'reserved',
    reserved_until = '9999-12-31 23:59:59+00'::timestamptz,
    version = version + 1
FROM public.pos_pending_sale_lines sl
JOIN public.pos_pending_sales ps ON ps.id = sl.pending_sale_id
WHERE ps.status = 'expired'
  AND u.id = sl.unit_id
  AND u.status = 'available';

UPDATE public.pos_pending_sales
SET status = 'pending',
    expires_at = '9999-12-31 23:59:59+00'::timestamptz,
    updated_at = now()
WHERE status = 'expired';

UPDATE public.pos_pending_sales
SET expires_at = '9999-12-31 23:59:59+00'::timestamptz
WHERE status = 'pending' AND expires_at < '9999-01-01'::timestamptz;

UPDATE public.inventory_units
SET reserved_until = '9999-12-31 23:59:59+00'::timestamptz
WHERE status = 'reserved' AND (reserved_until IS NULL OR reserved_until < '9999-01-01'::timestamptz);

-- 2. Make release_expired_pos_sales a no-op
CREATE OR REPLACE FUNCTION public.release_expired_pos_sales(p_branch_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- Automatic expiration is disabled: POS sales stay pending until manager confirms or rejects
  RETURN 0;
END;
$$;
GRANT EXECUTE ON FUNCTION public.release_expired_pos_sales(uuid) TO authenticated, service_role;

-- 3. Update get_pos_pending_sale without auto-expiration
CREATE OR REPLACE FUNCTION public.get_pos_pending_sale(p_pending_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_manager boolean;
  v_result jsonb;
  v_sale record;
BEGIN
  SELECT * INTO v_s FROM public.pos_pending_sales WHERE id = p_pending_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  IF auth.uid() IS NULL THEN
    v_manager := true;
  ELSE
    v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], v_s.branch_id);

    IF NOT v_manager AND NOT (v_s.seller_id = auth.uid() AND public.has_role(array['seller']::public.app_role[], v_s.branch_id)) THEN
      RAISE EXCEPTION 'POS so‘rovi uchun ruxsat yo‘q' USING errcode = '42501';
    END IF;
  END IF;

  SELECT to_jsonb(s) || jsonb_build_object(
    'seller_name', seller.full_name,
    'location_name', loc.name,
    'customer', (
      SELECT jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'address', c.address->>'address')
      FROM public.customers c WHERE c.id = s.customer_id
    ),
    'delivery', (
      SELECT jsonb_build_object(
        'id', d.id,
        'delivery_no', d.delivery_no,
        'customer_name', d.customer_name,
        'customer_phone', d.customer_phone,
        'delivery_address', d.delivery_address,
        'cod_amount', d.cod_amount,
        'payment_status', d.payment_status,
        'delivery_status', d.delivery_status,
        'fulfillment_source', d.fulfillment_source,
        'notes', d.notes
      )
      FROM public.pos_deliveries d
      WHERE d.pending_sale_id = s.id OR d.sale_id = (SELECT id FROM public.sales WHERE pending_sale_id = s.id LIMIT 1)
      LIMIT 1
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
        'image', coalesce(
          (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order ASC LIMIT 1),
          (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order ASC LIMIT 1),
          p.seo_image_url
        ),
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
        'method_id', pmt.method_id,
        'method_code', pmt.method_code,
        'method_name', pmt.method_name,
        'amount', pmt.amount,
        'external_reference', pmt.external_reference,
        'sort_order', pmt.sort_order
      ) ORDER BY pmt.sort_order)
      FROM (
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, sp.amount, sp.external_reference, pm.sort_order
        FROM public.sales sa
        JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
        JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
        WHERE sa.pending_sale_id = s.id
        UNION ALL
        SELECT pm.id AS method_code, pm.code AS method_code, pm.name AS method_name, pp.amount, pp.external_reference, pp.sort_order
        FROM public.pos_pending_sale_payments pp
        JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
        WHERE pp.pending_sale_id = s.id
          AND NOT EXISTS (
            SELECT 1 FROM public.sales sa2
            JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id AND sp2.status IN ('paid', 'pending')
            WHERE sa2.pending_sale_id = s.id
          )
        UNION ALL
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, s.total AS amount, null AS external_reference, 1 AS sort_order
        FROM public.payment_methods pm
        WHERE pm.code = 'cash' AND s.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM public.sales sa3
            JOIN public.sale_payments sp3 ON sp3.sale_id = sa3.id AND sp3.status IN ('paid', 'pending')
            WHERE sa3.pending_sale_id = s.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp3
            WHERE pp3.pending_sale_id = s.id
          )
      ) pmt
    ), '[]'::jsonb),
    'can_confirm', s.status = 'pending' AND v_manager,
    'can_reject', s.status = 'pending' AND v_manager,
    'remaining_seconds', null
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

-- 4. Update manager_confirm_sale without expiration checks
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
  v_is_cod boolean := false;
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

  PERFORM 1 FROM public.inventory_units u
  JOIN public.pos_pending_sale_lines x ON x.unit_id = u.id
  WHERE x.pending_sale_id = v_s.id ORDER BY u.id FOR UPDATE OF u;

  IF EXISTS(
    SELECT 1 FROM public.inventory_units u
    JOIN public.pos_pending_sale_lines x ON x.unit_id = u.id
    JOIN public.locations l ON l.id = u.location_id
    WHERE x.pending_sale_id = v_s.id AND (
      u.status <> 'reserved' OR u.sold_sale_id IS NOT NULL
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
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active;
      IF NOT FOUND OR (v_item->>'amount') IS NULL OR (v_item->>'amount')::numeric <= 0 THEN
        RAISE EXCEPTION 'POS to‘lov usuli yoki summasi noto‘g‘ri' USING errcode = '22023';
      END IF;
      IF v_method.code = 'cod' THEN
        v_is_cod := true;
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
      VALUES (
        v_sale,
        v_method.id,
        (v_item->>'amount')::numeric(18,2),
        CASE WHEN v_method.code = 'cod' THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
        nullif(btrim(v_item->>'external_reference'), ''),
        auth.uid()
      );
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

-- 5. Update create_pos_pending_sale: set far future expiration
CREATE OR REPLACE FUNCTION public.create_pos_pending_sale(
  p_branch_id uuid,
  p_lines jsonb,
  p_payments jsonb,
  p_idempotency_key uuid,
  p_notes text DEFAULT NULL::text,
  p_customer jsonb DEFAULT NULL::jsonb
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

  INSERT INTO public.pos_pending_sales(
    id, pending_no, branch_id, store_location_id, seller_id, customer_id, status, subtotal, discount, tax, total,
    expires_at, idempotency_key, request_hash, notes
  ) VALUES (
    v_id, 'POS-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(v_id::text, 1, 8)),
    p_branch_id, v_store, auth.uid(), v_customer_id, 'pending', v_subtotal, v_discount_total, v_tax_total, v_total,
    '9999-12-31 23:59:59+00'::timestamptz, p_idempotency_key, v_hash, nullif(btrim(p_notes), '')
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
    SET status = 'reserved', reserved_until = '9999-12-31 23:59:59+00'::timestamptz, version = version + 1
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

-- 6. Update update_pos_pending_sale: set far future expiration
CREATE OR REPLACE FUNCTION public.update_pos_pending_sale(
  p_pending_id uuid,
  p_lines jsonb,
  p_payments jsonb,
  p_notes text DEFAULT NULL::text,
  p_customer jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  v_sel_comps jsonb;
BEGIN
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so‘rovi topilmadi: %', p_pending_id USING errcode = 'P0002';
  END IF;

  IF v_pending.status <> 'pending' THEN
    RAISE EXCEPTION 'Faqat kutilayotgan (pending) kassa so‘rovini tahrirlash mumkin. Ushbu so‘rov holati: %', v_pending.status USING errcode = 'P0001';
  END IF;

  IF NOT (
    (v_pending.seller_id = auth.uid() AND public.has_role(array['seller']::public.app_role[], v_pending.branch_id))
    OR public.has_role(array['superadmin', 'admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_pending.branch_id)
  ) THEN
    RAISE EXCEPTION 'Faqat sotuvchi yoki menejer ushbu kassa so‘rovini tahrirlay oladi' USING errcode = '42501';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
    OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50
    OR p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array'
    OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'POS qatorlari yoki to‘lovlari noto‘g‘ri' USING errcode = '22023';
  END IF;

  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) e GROUP BY (e->>'unit_id')::uuid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Mahsulot birliklari takrorlanmasligi kerak' USING errcode = '22023';
  END IF;

  SELECT coalesce(array_agg(unit_id), ARRAY[]::uuid[]) INTO v_old_unit_ids
  FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;

  SELECT coalesce(array_agg((e->>'unit_id')::uuid), ARRAY[]::uuid[]) INTO v_new_unit_ids
  FROM jsonb_array_elements(p_lines) e;

  SELECT coalesce(array_agg(u), ARRAY[]::uuid[]) INTO v_removed_unit_ids
  FROM unnest(v_old_unit_ids) u WHERE u != ALL(v_new_unit_ids);

  IF array_length(v_removed_unit_ids, 1) > 0 THEN
    UPDATE public.inventory_units
    SET status = 'available', reserved_until = NULL, version = version + 1
    WHERE id = ANY(v_removed_unit_ids) AND status = 'reserved';
  END IF;

  SELECT coalesce(array_agg(u), ARRAY[]::uuid[]) INTO v_added_unit_ids
  FROM unnest(v_new_unit_ids) u WHERE u != ALL(v_old_unit_ids);

  IF array_length(v_added_unit_ids, 1) > 0 THEN
    PERFORM 1 FROM public.inventory_units WHERE id = ANY(v_added_unit_ids) ORDER BY id FOR UPDATE;
  END IF;

  v_is_seller := public.has_role(array['seller']::public.app_role[], v_pending.branch_id)
    AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], v_pending.branch_id));

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

    IF v_unit_id = ANY(v_added_unit_ids) THEN
      IF v_u.status <> 'available' OR v_u.active_transfer_id IS NOT NULL THEN
        RAISE EXCEPTION 'Yangi qo‘shilgan mahsulot mavjud emas yoki band: %', v_unit_id USING errcode = 'P0001';
      END IF;
      UPDATE public.inventory_units SET status = 'reserved', reserved_until = '9999-12-31 23:59:59+00'::timestamptz, version = version + 1 WHERE id = v_unit_id;
    ELSE
      IF v_u.status <> 'reserved' AND v_u.status <> 'available' THEN
        RAISE EXCEPTION 'Mahsulot holati noto‘g‘ri: %', v_unit_id USING errcode = 'P0001';
      END IF;
      UPDATE public.inventory_units SET reserved_until = '9999-12-31 23:59:59+00'::timestamptz WHERE id = v_unit_id;
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

  DELETE FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;
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
      p_pending_id, v_u.product_id, v_u.id, v_price, v_discount, v_tax, v_price - v_discount + v_tax, v_sel_comps
    );
  END LOOP;

  DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
    INSERT INTO public.pos_pending_sale_payments(
      pending_sale_id, payment_method_id, amount, external_reference, sort_order
    ) VALUES (
      p_pending_id, v_method.id, (v_item->>'amount')::numeric(18,2), nullif(btrim(v_item->>'external_reference'), ''), v_sort
    );
  END LOOP;

  UPDATE public.pos_pending_sales SET
    customer_id = v_customer_id,
    subtotal = v_subtotal,
    discount = v_discount_total,
    tax = v_tax_total,
    total = v_total,
    notes = nullif(btrim(p_notes), ''),
    expires_at = '9999-12-31 23:59:59+00'::timestamptz,
    updated_at = now()
  WHERE id = p_pending_id;

  RETURN public.get_pos_pending_sale(p_pending_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_pos_pending_sale(uuid, jsonb, jsonb, text, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
