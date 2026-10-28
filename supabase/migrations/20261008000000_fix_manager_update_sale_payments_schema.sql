-- Migration: 20261008000000_fix_manager_update_sale_payments_schema.sql
-- Description: Fix manager_update_sale_payments delivery_status column and schema cache

BEGIN;

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
  v_cust_id uuid;
  v_cust_name text;
  v_cust_phone text;
  v_cust_address text;
  v_fulfillment_source text;
BEGIN
  -- 1. Find pending sale (either by pos_pending_sales.id OR by sales.id / sales.pending_sale_id)
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_sale FROM public.sales WHERE id = p_pending_sale_id FOR UPDATE;
    IF FOUND AND v_sale.pending_sale_id IS NOT NULL THEN
      SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = v_sale.pending_sale_id FOR UPDATE;
    END IF;
  END IF;

  IF v_pending.id IS NULL THEN
    RAISE EXCEPTION 'POS kassa so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Check manager permissions
  PERFORM public.require_pos_manager(v_pending.branch_id);

  -- 3. Set admin override so immutable triggers allow updating payments
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- 4. Find confirmed sale if not already found
  IF v_sale.id IS NULL THEN
    SELECT * INTO v_sale FROM public.sales WHERE pending_sale_id = v_pending.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ushbu so‘rov uchun tasdiqlangan sotuv topilmadi' USING errcode = 'P0002';
    END IF;
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

  IF round(v_paid, 2) <> round(v_sale.total, 2) THEN
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
      INSERT INTO public.customers (id, full_name, phone, address, created_at, updated_at)
      VALUES (v_cust_id, coalesce(v_cust_name, 'Mijoz'), v_cust_phone,
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
        notes = coalesce(nullif(btrim(p_delivery->>'notes'), ''), notes),
        fulfillment_source = coalesce(v_fulfillment_source, fulfillment_source),
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

      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'product_id', sl.product_id,
        'product_name', p.name,
        'sku', p.sku,
        'quantity', sl.quantity,
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'unit_id', sl.unit_id
      )), '[]'::jsonb) INTO v_items
      FROM public.sale_lines sl
      JOIN public.products p ON p.id = sl.product_id
      WHERE sl.sale_id = v_sale.id;

      INSERT INTO public.pos_deliveries(
        id, delivery_no, sale_id, pending_sale_id, branch_id, customer_name, customer_phone,
        delivery_address, items, total_amount, payment_type, cod_amount, payment_status, delivery_status, fulfillment_source, notes, created_at, updated_at
      ) VALUES (
        v_del_id,
        v_delivery_no,
        v_sale.id,
        v_pending.id,
        v_pending.branch_id,
        coalesce(v_cust_name, 'Mijoz'),
        v_cust_phone,
        v_cust_address,
        coalesce(v_items, '[]'::jsonb),
        v_sale.total,
        CASE WHEN v_cod_amount = v_sale.total THEN 'cod' WHEN v_cod_amount > 0 THEN 'split' ELSE 'cash' END,
        v_cod_amount,
        CASE WHEN v_cod_amount > 0 THEN 'pending_courier' ELSE 'paid' END,
        'pending',
        v_fulfillment_source,
        nullif(btrim(p_delivery->>'notes'), ''),
        now(),
        now()
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

COMMIT;
