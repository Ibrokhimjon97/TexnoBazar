-- Migration: Add Nasiya (debt) payment method, fix update_pos_pending_sale immutable lines, and update list/confirm RPCs

-- 1. Insert Nasiya payment method
INSERT INTO public.payment_methods (code, name, is_cash, is_online, is_active, sort_order)
VALUES ('nasiya', 'Nasiya', false, false, true, 45)
ON CONFLICT (code) DO UPDATE SET is_active = true, name = 'Nasiya';

-- 2. Fix update_pos_pending_sale: allow mutating pos_pending_sale_lines and pos_pending_sale_payments by setting admin override
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


-- 3. Update manager_confirm_sale: set 'pending' payment status for 'nasiya' and 'cod'
DROP FUNCTION IF EXISTS public.manager_confirm_sale(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.manager_confirm_sale(
  p_pending_sale_id uuid,
  p_payments jsonb DEFAULT null,
  p_customer jsonb DEFAULT null,
  p_notes text DEFAULT null
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_sale uuid;
  v_count integer := 0;
  v_paid numeric(18,2) := 0;
  v_item jsonb;
  v_method public.payment_methods%rowtype;
  v_x record;
  v_is_cod boolean := false;
  v_cust_id uuid;
  v_cust_name text;
  v_cust_phone text;
  v_cust_address text;
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

  IF p_customer IS NOT NULL AND nullif(btrim(p_customer->>'phone'), '') IS NOT NULL THEN
    v_cust_phone := btrim(p_customer->>'phone');
    v_cust_name := nullif(btrim(p_customer->>'full_name'), '');
    v_cust_address := nullif(btrim(p_customer->>'address'), '');

    SELECT id INTO v_cust_id FROM public.customers WHERE phone = v_cust_phone;
    IF v_cust_id IS NULL THEN
      v_cust_id := gen_random_uuid();
      INSERT INTO public.customers (id, branch_id, full_name, phone, address, created_at, updated_at)
      VALUES (v_cust_id, v_s.branch_id, coalesce(v_cust_name, 'Mijoz'), v_cust_phone,
        CASE WHEN v_cust_address IS NOT NULL THEN jsonb_build_object('address', v_cust_address) ELSE '{}'::jsonb END,
        now(), now());
    ELSE
      UPDATE public.customers
      SET full_name = coalesce(v_cust_name, full_name),
          address = CASE WHEN v_cust_address IS NOT NULL THEN jsonb_build_object('address', v_cust_address) ELSE address END,
          updated_at = now()
      WHERE id = v_cust_id;
    END IF;
    v_s.customer_id := v_cust_id;
    UPDATE public.pos_pending_sales SET customer_id = v_cust_id WHERE id = v_s.id;
  END IF;

  IF p_notes IS NOT NULL AND length(btrim(p_notes)) > 0 THEN
    v_s.notes := btrim(p_notes);
    UPDATE public.pos_pending_sales SET notes = v_s.notes WHERE id = v_s.id;
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
    SELECT v_sale, p.payment_method_id, p.amount,
      CASE WHEN pm.code IN ('cod', 'nasiya') THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
      p.external_reference, auth.uid()
    FROM public.pos_pending_sale_payments p
    JOIN public.payment_methods pm ON pm.id = p.payment_method_id
    WHERE p.pending_sale_id = v_s.id ORDER BY p.sort_order;
  ELSE
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
      INSERT INTO public.sale_payments(sale_id, payment_method_id, amount, status, external_reference, received_by)
      VALUES (
        v_sale,
        v_method.id,
        (v_item->>'amount')::numeric(18,2),
        CASE WHEN v_method.code IN ('cod', 'nasiya') THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
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

GRANT EXECUTE ON FUNCTION public.manager_confirm_sale(uuid, jsonb, jsonb, text) TO authenticated, service_role;


-- 4. Update manager_update_sale_payments: handle 'nasiya'
CREATE OR REPLACE FUNCTION public.manager_update_sale_payments(
  p_pending_sale_id uuid,
  p_payments jsonb,
  p_delivery jsonb DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pending public.pos_pending_sales%rowtype;
  v_sale public.sales%rowtype;
  v_item jsonb;
  v_method public.payment_methods%rowtype;
  v_paid numeric(18,2) := 0;
  v_count integer := 0;
  v_cod_amount numeric(18,2) := 0;
  v_del_row public.pos_deliveries%rowtype;
  v_del_id uuid;
  v_delivery_no text;
  v_cust_id uuid;
  v_cust_name text;
  v_cust_phone text;
  v_cust_address text;
  v_fulfillment_source text;
BEGIN
  -- 1. Find pending sale
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS kassa so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Check manager permissions
  PERFORM public.require_pos_manager(v_pending.branch_id);

  -- 3. Set admin override so immutable triggers allow updating payments
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- 4. Find confirmed sale
  SELECT * INTO v_sale FROM public.sales WHERE pending_sale_id = v_pending.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ushbu so‘rov uchun tasdiqlangan sotuv topilmadi' USING errcode = 'P0002';
  END IF;

  -- 5. Validate payments
  IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'To‘lovlar ro‘yxati noto‘g‘ri' USING errcode = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active;
    IF NOT FOUND OR (v_item->>'amount') IS NULL OR (v_item->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'To‘lov usuli yoki summasi noto‘g‘ri: %', v_item->>'method_code' USING errcode = '22023';
    END IF;
    IF v_method.code = 'cod' THEN
      v_cod_amount := v_cod_amount + (v_item->>'amount')::numeric(18,2);
    END IF;
    v_paid := v_paid + (v_item->>'amount')::numeric(18,2);
    v_count := v_count + 1;
  END LOOP;

  IF v_paid <> v_sale.total THEN
    RAISE EXCEPTION 'To‘lovlar jami (%) sotuv summasiga (%) teng bo‘lishi shart', v_paid, v_sale.total USING errcode = '22023';
  END IF;

  -- 6. Delete existing sale_payments and insert new ones
  DELETE FROM public.sale_payments WHERE sale_id = v_sale.id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
    INSERT INTO public.sale_payments(
      id, sale_id, payment_method_id, amount, status, external_reference, received_by, paid_at, metadata, created_at
    ) VALUES (
      gen_random_uuid(),
      v_sale.id,
      v_method.id,
      (v_item->>'amount')::numeric(18,2),
      CASE WHEN v_method.code IN ('cod', 'nasiya') THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
      nullif(btrim(v_item->>'external_reference'), ''),
      auth.uid(),
      now(),
      '{}'::jsonb,
      now()
    );
  END LOOP;

  -- 7. Also sync pos_pending_sale_payments for consistency
  DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = v_pending.id;
  DECLARE
    v_sort integer := 1;
  BEGIN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
      INSERT INTO public.pos_pending_sale_payments(
        id, pending_sale_id, payment_method_id, amount, external_reference, sort_order, created_at
      ) VALUES (
        gen_random_uuid(),
        v_pending.id,
        v_method.id,
        (v_item->>'amount')::numeric(18,2),
        nullif(btrim(v_item->>'external_reference'), ''),
        v_sort,
        now()
      );
      v_sort := v_sort + 1;
    END LOOP;
  END;

  -- 8. Handle pos_deliveries if COD or delivery was specified
  v_cust_name := coalesce(nullif(btrim(p_delivery->>'customer_name'), ''), 'Mijoz');
  v_cust_phone := nullif(btrim(p_delivery->>'customer_phone'), '');
  v_cust_address := nullif(btrim(p_delivery->>'customer_address'), '');
  v_fulfillment_source := coalesce(nullif(btrim(p_delivery->>'fulfillment_source'), ''), 'warehouse');

  IF v_cust_phone IS NOT NULL AND length(v_cust_phone) > 0 THEN
    SELECT id INTO v_cust_id FROM public.customers WHERE phone = v_cust_phone;
    IF v_cust_id IS NULL THEN
      v_cust_id := gen_random_uuid();
      INSERT INTO public.customers (id, branch_id, full_name, phone, address, created_at, updated_at)
      VALUES (v_cust_id, v_pending.branch_id, coalesce(v_cust_name, 'Mijoz'), v_cust_phone,
        CASE WHEN v_cust_address IS NOT NULL THEN jsonb_build_object('address', v_cust_address) ELSE '{}'::jsonb END,
        now(), now());
    ELSE
      UPDATE public.customers
      SET full_name = coalesce(v_cust_name, full_name),
          address = CASE WHEN v_cust_address IS NOT NULL THEN jsonb_build_object('address', v_cust_address) ELSE address END,
          updated_at = now()
      WHERE id = v_cust_id;
    END IF;
    UPDATE public.sales SET customer_id = v_cust_id WHERE id = v_sale.id;
    UPDATE public.pos_pending_sales SET customer_id = v_cust_id WHERE id = v_pending.id;
  END IF;

  IF nullif(btrim(p_delivery->>'notes'), '') IS NOT NULL THEN
    UPDATE public.pos_pending_sales SET notes = btrim(p_delivery->>'notes') WHERE id = v_pending.id;
  END IF;

  SELECT * INTO v_del_row FROM public.pos_deliveries WHERE sale_id = v_sale.id OR pending_sale_id = v_pending.id LIMIT 1 FOR UPDATE;

  IF v_del_row.id IS NOT NULL THEN
    UPDATE public.pos_deliveries
    SET cod_amount = v_cod_amount,
        customer_name = coalesce(v_cust_name, customer_name),
        customer_phone = coalesce(v_cust_phone, customer_phone),
        delivery_address = coalesce(v_cust_address, delivery_address),
        payment_type = CASE WHEN v_cod_amount = v_sale.total THEN 'cod' WHEN v_cod_amount > 0 THEN 'split' ELSE 'cash' END,
        payment_status = CASE WHEN v_cod_amount > 0 THEN 'pending_courier' ELSE 'paid' END,
        updated_at = now()
    WHERE id = v_del_row.id;
  ELSIF v_cod_amount > 0 OR (p_delivery IS NOT NULL AND (p_delivery->>'needed')::boolean = true) THEN
    IF v_cust_phone IS NULL OR v_cust_address IS NULL THEN
      IF v_pending.customer_id IS NOT NULL THEN
        SELECT full_name, phone, coalesce(address->>'address', '') INTO v_cust_name, v_cust_phone, v_cust_address
        FROM public.customers WHERE id = v_pending.customer_id;
      END IF;
    END IF;

    IF v_cust_phone IS NOT NULL AND v_cust_address IS NOT NULL THEN
      v_del_id := gen_random_uuid();
      v_delivery_no := 'DOS-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_del_id::text, 1, 6));

      INSERT INTO public.pos_deliveries(
        id, delivery_no, sale_id, pending_sale_id, branch_id, customer_name, customer_phone,
        delivery_address, payment_type, cod_amount, payment_status, status, fulfillment_source, notes
      ) VALUES (
        v_del_id,
        v_delivery_no,
        v_sale.id,
        v_pending.id,
        v_pending.branch_id,
        v_cust_name,
        v_cust_phone,
        v_cust_address,
        CASE WHEN v_cod_amount = v_sale.total THEN 'cod' WHEN v_cod_amount > 0 THEN 'split' ELSE 'cash' END,
        v_cod_amount,
        CASE WHEN v_cod_amount > 0 THEN 'pending_courier' ELSE 'paid' END,
        'draft',
        v_fulfillment_source,
        nullif(btrim(p_delivery->>'notes'), '')
      );
    END IF;
  END IF;

  -- 9. Update pos_pending_sales updated_at timestamp
  UPDATE public.pos_pending_sales SET updated_at = now() WHERE id = v_pending.id;

  -- Reset admin override
  PERFORM set_config('texnobazar.admin_override', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'sale_id', v_sale.id,
    'pending_sale_id', v_pending.id,
    'total', v_sale.total,
    'paid', v_paid,
    'cod_amount', v_cod_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_update_sale_payments(uuid, jsonb, jsonb) TO authenticated, service_role;


-- 5. Update list_pos_pending_sales: add 'nasiya' filter and summary counts
DROP FUNCTION IF EXISTS public.list_pos_pending_sales(uuid, text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_pos_pending_sales(
  p_branch_id uuid,
  p_status text DEFAULT null,
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
  v_is_cod_filter boolean := (lower(btrim(coalesce(p_status, ''))) = 'cod');
  v_is_nasiya_filter boolean := (lower(btrim(coalesce(p_status, ''))) = 'nasiya');
  v_status_filter text := CASE 
    WHEN p_status IS NULL OR lower(btrim(p_status)) IN ('', 'all', 'cod', 'nasiya') THEN null 
    ELSE lower(btrim(p_status)) 
  END;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  SELECT count(*) INTO v_total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND (v_manager OR s.seller_id = auth.uid())
    AND (
      CASE
        WHEN v_is_cod_filter THEN (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s.id AND pm.code = 'cod' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s.id AND pm.code = 'cod' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
          )
        )
        WHEN v_is_nasiya_filter THEN (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s.id AND pm.code = 'nasiya' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s.id AND pm.code = 'nasiya' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
          )
        )
        WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
        ELSE true
      END
    )
    AND (
      v_q IS NULL 
      OR s.pending_no ILIKE '%' || v_q || '%' 
      OR EXISTS(SELECT 1 FROM public.profiles p WHERE p.id = s.seller_id AND p.full_name ILIKE '%' || v_q || '%')
      OR EXISTS(SELECT 1 FROM public.customers c2 WHERE c2.id = s.customer_id AND (c2.full_name ILIKE '%' || v_q || '%' OR c2.phone ILIKE '%' || v_q || '%'))
    );

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      s.id, s.pending_no, s.status, s.seller_id,
      p.full_name AS seller_name,
      s.store_location_id, l.name AS location_name,
      (SELECT count(*) FROM public.pos_pending_sale_lines x WHERE x.pending_sale_id = s.id) AS unit_count,
      s.total, s.created_at, s.updated_at, s.expires_at, s.notes,
      (s.updated_at > s.created_at + interval '1 second') AS is_edited,
      (
        SELECT jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'address', c.address->>'address')
        FROM public.customers c WHERE c.id = s.customer_id
      ) AS customer,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'code', pmt.method_code,
          'name', pmt.method_name,
          'amount', pmt.amount
        ) ORDER BY pmt.sort_order)
        FROM (
          SELECT pm.code AS method_code, pm.name AS method_name, sp.amount, pm.sort_order
          FROM public.sales sa
          JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
          JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
          UNION ALL
          SELECT pm.code AS method_code, pm.name AS method_name, pp.amount, pp.sort_order
          FROM public.pos_pending_sale_payments pp
          JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND NOT EXISTS (
              SELECT 1 FROM public.sales sa2
              JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id AND sp2.status IN ('paid', 'pending')
              WHERE sa2.pending_sale_id = s.id
            )
          UNION ALL
          SELECT 'cash' AS method_code, 'Naqd' AS method_name, s.total AS amount, 1 AS sort_order
          WHERE s.status = 'confirmed'
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
      ), '[]'::jsonb) AS payments
    FROM public.pos_pending_sales s
    JOIN public.profiles p ON p.id = s.seller_id
    JOIN public.locations l ON l.id = s.store_location_id
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND (
        CASE
          WHEN v_is_cod_filter THEN (
            EXISTS (
              SELECT 1 FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id AND pm.code = 'cod' AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1 FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id AND pm.code = 'cod' AND pp.amount > 0
                AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
            )
          )
          WHEN v_is_nasiya_filter THEN (
            EXISTS (
              SELECT 1 FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id AND pm.code = 'nasiya' AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1 FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id AND pm.code = 'nasiya' AND pp.amount > 0
                AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
            )
          )
          WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
          ELSE true
        END
      )
      AND (
        v_q IS NULL 
        OR s.pending_no ILIKE '%' || v_q || '%' 
        OR p.full_name ILIKE '%' || v_q || '%'
        OR EXISTS (SELECT 1 FROM public.customers c2 WHERE c2.id = s.customer_id AND (c2.full_name ILIKE '%' || v_q || '%' OR c2.phone ILIKE '%' || v_q || '%'))
      )
    ORDER BY s.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  WITH today_confirmed AS (
    SELECT s.id, s.branch_id, s.total
    FROM public.pos_pending_sales s
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND s.status = 'confirmed'
      AND s.confirmed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
  ),
  sale_pmts AS (
    SELECT 
      tc.id AS pending_id,
      pm.code AS method_code,
      sum(sp.amount) AS amount
    FROM today_confirmed tc
    JOIN public.sales sa ON sa.pending_sale_id = tc.id
    JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
    JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
    GROUP BY tc.id, pm.code
  ),
  fallback_pmts AS (
    SELECT 
      tc.id AS pending_id,
      pm.code AS method_code,
      sum(pp.amount) AS amount
    FROM today_confirmed tc
    JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = tc.id
    JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
    WHERE NOT EXISTS (SELECT 1 FROM sale_pmts WHERE sale_pmts.pending_id = tc.id)
    GROUP BY tc.id, pm.code
  ),
  default_cash AS (
    SELECT
      tc.id AS pending_id,
      'cash' AS method_code,
      tc.total AS amount
    FROM today_confirmed tc
    WHERE NOT EXISTS (SELECT 1 FROM sale_pmts WHERE sale_pmts.pending_id = tc.id)
      AND NOT EXISTS (SELECT 1 FROM fallback_pmts WHERE fallback_pmts.pending_id = tc.id)
  ),
  all_today_pmts AS (
    SELECT * FROM sale_pmts
    UNION ALL
    SELECT * FROM fallback_pmts
    UNION ALL
    SELECT * FROM default_cash
  )
  SELECT jsonb_build_object(
    'pending_count', count(*) FILTER (WHERE status = 'pending'),
    'pending_amount', coalesce(sum(total) FILTER (WHERE status = 'pending'), 0),
    'confirmed_today_count', (SELECT count(*) FROM today_confirmed),
    'confirmed_today_amount', (SELECT coalesce(sum(total), 0) FROM today_confirmed),
    'confirmed_today_cash', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code = 'cash'), 0),
    'confirmed_today_card', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code IN ('card', 'terminal', 'click', 'payme', 'uzum')), 0),
    'confirmed_today_cod', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code = 'cod'), 0),
    'confirmed_today_nasiya', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code = 'nasiya'), 0),
    'confirmed_today_other', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code NOT IN ('cash', 'card', 'terminal', 'click', 'payme', 'uzum', 'cod', 'nasiya')), 0),
    'cod_count', (
      SELECT count(*) FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s2.id AND pm.code = 'cod' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s2.id AND pm.code = 'cod' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s2.id)
          )
        )
    ),
    'cod_total_amount', coalesce((
      SELECT sum(sp.amount)
      FROM public.sales sa
      JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
      JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
      JOIN public.pos_pending_sales s2 ON s2.id = sa.pending_sale_id
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND pm.code = 'cod' AND sp.amount > 0
    ), 0),
    'nasiya_count', (
      SELECT count(*) FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s2.id AND pm.code = 'nasiya' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s2.id AND pm.code = 'nasiya' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s2.id)
          )
        )
    ),
    'nasiya_total_amount', coalesce((
      SELECT sum(sp.amount)
      FROM public.sales sa
      JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
      JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
      JOIN public.pos_pending_sales s2 ON s2.id = sa.pending_sale_id
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND pm.code = 'nasiya' AND sp.amount > 0
    ), 0) + coalesce((
      SELECT sum(pp.amount)
      FROM public.pos_pending_sales s2
      JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = s2.id
      JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND s2.status = 'pending'
        AND pm.code = 'nasiya' AND pp.amount > 0
    ), 0)
  )
  INTO v_summary
  FROM public.pos_pending_sales
  WHERE branch_id = p_branch_id AND (v_manager OR seller_id = auth.uid());

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'summary', v_summary);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_pending_sales(uuid, text, text, integer, integer) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
