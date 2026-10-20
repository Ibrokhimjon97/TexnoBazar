-- Migration: Fix sale_payments is immutable in manager_update_sale_payments
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
  v_items jsonb;
  v_del_id uuid;
  v_delivery_no text;
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
      CASE WHEN v_method.code = 'cod' THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
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

  -- Check if delivery record already exists for this sale
  SELECT * INTO v_del_row FROM public.pos_deliveries WHERE sale_id = v_sale.id OR pending_sale_id = v_pending.id LIMIT 1 FOR UPDATE;

  IF v_del_row.id IS NOT NULL THEN
    -- Delivery exists, update it!
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
    -- Delivery does not exist yet, but COD > 0 or delivery is needed! Create it!
    IF v_cust_phone IS NULL OR v_cust_address IS NULL THEN
      -- Try to get customer info from customer table if available
      IF v_pending.customer_id IS NOT NULL THEN
        SELECT full_name, phone, coalesce(address->>'address', '') INTO v_cust_name, v_cust_phone, v_cust_address
        FROM public.customers WHERE id = v_pending.customer_id;
      END IF;
    END IF;

    IF v_cust_phone IS NULL OR v_cust_address IS NULL THEN
      RAISE EXCEPTION 'Kuryer to‘lovi yoki dostavka uchun mijoz telefoni va yetkazish manzili kiritilishi shart' USING errcode = '22023';
    END IF;

    v_del_id := gen_random_uuid();
    v_delivery_no := 'DOS-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_del_id::text, 1, 6));

    SELECT jsonb_agg(jsonb_build_object(
      'product_id', sl.product_id,
      'product_name', p.name,
      'sku', p.sku,
      'quantity', sl.quantity,
      'unit_price', sl.unit_price,
      'line_total', sl.line_total,
      'qr_code', u.qr_code,
      'serial_number', u.serial_number,
      'location_name', coalesce(l.name, CASE WHEN l.type = 'store' THEN 'Do‘kon' ELSE 'Ombor' END),
      'location_type', l.type,
      'batch_code', coalesce(sb.reference, 'PRT-' || substr(coalesce(u.batch_id::text, '00000000'), 1, 8)),
      'selected_components', coalesce(sl.selected_components, '[]'::jsonb)
    ))
    INTO v_items
    FROM public.sale_lines sl
    JOIN public.products p ON p.id = sl.product_id
    JOIN public.inventory_units u ON u.id = sl.unit_id
    LEFT JOIN public.locations l ON l.id = u.location_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE sl.sale_id = v_sale.id;

    INSERT INTO public.pos_deliveries (
      id, branch_id, sale_id, pending_sale_id, delivery_no,
      customer_name, customer_phone, delivery_address,
      items, total_amount, payment_type, payment_status,
      delivery_status, cod_amount, notes, fulfillment_source, created_at, updated_at
    ) VALUES (
      v_del_id, v_sale.branch_id, v_sale.id, v_pending.id, v_delivery_no,
      v_cust_name, v_cust_phone, v_cust_address,
      coalesce(v_items, '[]'::jsonb), v_sale.total,
      CASE WHEN v_cod_amount = v_sale.total THEN 'cod' WHEN v_cod_amount > 0 THEN 'split' ELSE 'cash' END,
      CASE WHEN v_cod_amount > 0 THEN 'pending_courier' ELSE 'paid' END,
      'pending', v_cod_amount, nullif(btrim(p_delivery->>'notes'), ''), v_fulfillment_source, now(), now()
    );
  END IF;

  UPDATE public.pos_pending_sales
  SET updated_at = now()
  WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'success', true,
    'sale_id', v_sale.id,
    'pending_id', v_pending.id,
    'cod_amount', v_cod_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_update_sale_payments(uuid, jsonb, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
