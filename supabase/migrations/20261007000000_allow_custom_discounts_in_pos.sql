-- Migration: 20261007000000_allow_custom_discounts_in_pos.sql
-- Description: Allow custom and full discounts in POS sales (trade-in, exchange, custom price reductions).

BEGIN;

-- 1. get_pos_references: set seller_max_line_discount_percent to 100%
CREATE OR REPLACE FUNCTION public.get_pos_references(p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_currency text;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  SELECT btrim(currency::text) INTO v_currency FROM public.branches WHERE id=p_branch_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Faol filial topilmadi' USING errcode='P0002'; END IF;
  RETURN jsonb_build_object('branch_id',p_branch_id,'currency',v_currency,
    'store_locations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name) ORDER BY name)
      FROM public.locations WHERE branch_id=p_branch_id AND type='store' AND is_active),'[]'::jsonb),
    'payment_methods',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,
      'is_cash',is_cash,'is_online',is_online) ORDER BY sort_order,code) FROM public.payment_methods
      WHERE is_active AND code<>'cod'),'[]'::jsonb),
    'discount_policy',jsonb_build_object('seller_max_line_discount_percent',100));
END $$;

GRANT EXECUTE ON FUNCTION public.get_pos_references(uuid) TO authenticated, service_role;

-- 2. create_pos_pending_sale: allow custom discount up to unit_price
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

    -- Chegirma tekshiruvi: 0 dan kichik bo'lmasin va narxdan oshmasin (100% gacha ruxsat etiladi)
    IF v_discount < 0 OR v_discount > v_price THEN
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

-- 3. update_pos_pending_sale: allow custom discount up to unit_price
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
SET search_path TO ''
AS $$
DECLARE
  v_pending public.pos_pending_sales%rowtype;
  v_old_unit_ids uuid[];
  v_new_unit_ids uuid[];
  v_removed_unit_ids uuid[];
  v_added_unit_ids uuid[];
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
  v_sel_comps jsonb;
BEGIN
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_pending.status <> 'pending' THEN
    RAISE EXCEPTION 'Faqat kutilayotgan (pending) savdoni tahrirlash mumkin' USING errcode = '22023';
  END IF;

  PERFORM public.require_pos_seller(v_pending.branch_id);

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

    -- Chegirma tekshiruvi: 0 dan kichik bo'lmasin va narxdan oshmasin (100% gacha ruxsat etiladi)
    IF v_discount < 0 OR v_discount > v_price THEN
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

  -- Allow mutation through immutable triggers
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

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

  -- Reset admin override
  PERFORM set_config('texnobazar.admin_override', '', true);

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

COMMIT;
