-- Migration: Fix "sale_payments is immutable" when manager accepts courier delivery cash
-- Setting texnobazar.admin_override to 'allowed' allows updating pending sale_payments to 'paid'

CREATE OR REPLACE FUNCTION public.manager_accept_delivery_cash(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
  v_account_id uuid;
  v_tx_id uuid;
BEGIN
  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka yozuvi topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_del.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  IF v_del.payment_status = 'collected' THEN
    RETURN to_jsonb(v_del);
  END IF;

  -- Allow mutation of immutable tables (sale_payments)
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- 1. Book income transaction in branch cash account
  IF coalesce(v_del.cod_amount, 0) > 0 THEN
    SELECT id INTO v_account_id FROM public.finance_accounts WHERE branch_id = v_del.branch_id AND is_active LIMIT 1;
    IF v_account_id IS NULL THEN
      INSERT INTO public.finance_accounts (branch_id, code, name, currency)
      VALUES (v_del.branch_id, 'CASH-' || left(v_del.branch_id::text, 8), 'Kassa', 'UZS')
      RETURNING id INTO v_account_id;
    END IF;

    INSERT INTO public.finance_transactions (
      account_id, branch_id, type, category, amount, description, reference_type, reference_id, created_by
    ) VALUES (
      v_account_id, v_del.branch_id, 'income', 'delivery_cod_cash', v_del.cod_amount,
      'Dostavka kuryer puli qabul qilindi: ' || v_del.delivery_no || ' (' || v_del.customer_name || ')',
      'pos_delivery', v_del.id, auth.uid()
    )
    RETURNING id INTO v_tx_id;
  END IF;

  -- 2. Update sale_payments to paid if sale exists
  IF v_del.sale_id IS NOT NULL THEN
    UPDATE public.sale_payments
    SET status = 'paid'::public.payment_status,
        received_by = coalesce(auth.uid(), received_by),
        paid_at = now()
    WHERE sale_id = v_del.sale_id AND status = 'pending'::public.payment_status;
  END IF;

  -- 3. Update pos_deliveries
  UPDATE public.pos_deliveries
  SET payment_status = 'collected',
      delivery_status = 'delivered',
      paid_at = now(),
      paid_received_by = coalesce(auth.uid(), paid_received_by),
      delivered_at = coalesce(delivered_at, now()),
      updated_at = now()
  WHERE id = p_delivery_id
  RETURNING * INTO v_del;

  RETURN to_jsonb(v_del);
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_accept_delivery_cash(uuid) TO authenticated, service_role;

-- Also harden reject_courier_delivery to prevent immutable error when voiding/failing sale_payments
CREATE OR REPLACE FUNCTION public.reject_courier_delivery(
  p_handover_id uuid,
  p_reason text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_h public.courier_cash_handovers%rowtype;
  v_o public.orders%rowtype;
  v_sale public.sales%rowtype;
  v_unit record;
  v_res record;
  v_note text;
  v_branch_id uuid;
  v_default_loc uuid;
BEGIN
  SELECT * INTO v_h FROM public.courier_cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kuryer topshiruvi topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_h.status = 'cancelled' THEN
    RETURN to_jsonb(v_h);
  END IF;

  IF v_h.status <> 'pending' THEN
    RAISE EXCEPTION 'Faqat kutilayotgan (pending) topshiruvni bekor qilish mumkin. Joriy holat: %', v_h.status USING errcode = 'P0001';
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_h.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Allow mutation of immutable tables (sale_payments)
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  v_note := coalesce(nullif(btrim(p_reason), ''), 'Mijoz tovardan voz kechdi / Dostavka qaytdi');
  v_branch_id := v_h.branch_id;

  -- Default active location for this branch
  SELECT id INTO v_default_loc
  FROM public.locations
  WHERE branch_id = v_branch_id AND is_active AND type IN ('warehouse', 'store')
  ORDER BY CASE WHEN type = 'warehouse' THEN 1 ELSE 2 END
  LIMIT 1;

  -- 1. Mark handover as cancelled
  UPDATE public.courier_cash_handovers
  SET status = 'cancelled',
      received_by = auth.uid(),
      received_at = now(),
      cancel_reason = v_note
  WHERE id = p_handover_id;

  -- 2. Fetch order
  SELECT * INTO v_o FROM public.orders WHERE id = v_h.order_id FOR UPDATE;

  -- 3. If there is a sales record created for this order, void it and restore inventory units
  SELECT * INTO v_sale FROM public.sales WHERE order_id = v_h.order_id FOR UPDATE;
  IF v_sale.id IS NOT NULL THEN
    -- A. Update sales status to 'void' so it is not counted in sales / profit
    UPDATE public.sales
    SET status = 'void',
        updated_at = now()
    WHERE id = v_sale.id;

    -- B. Update sale_payments status
    UPDATE public.sale_payments
    SET status = 'failed'
    WHERE sale_id = v_sale.id;

    -- C. Revert sold inventory units back to 'available'
    FOR v_unit IN
      SELECT u.id, u.product_id, u.batch_id, coalesce(u.location_id, v_default_loc) AS location_id
      FROM public.inventory_units u
      WHERE u.sold_sale_id = v_sale.id
      FOR UPDATE OF u
    LOOP
      UPDATE public.inventory_units
      SET status = 'available',
          sold_sale_id = null,
          reserved_until = null,
          location_id = v_unit.location_id,
          version = version + 1
      WHERE id = v_unit.id;

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      VALUES (
        v_unit.id, v_unit.product_id, v_unit.batch_id, 'returned',
        v_unit.location_id, v_unit.location_id, 1,
        'courier_return', v_h.id, v_note, auth.uid()
      );
    END LOOP;
  END IF;

  -- 4. Update delivery status
  UPDATE public.deliveries
  SET status = 'failed',
      notes = coalesce(notes || E'\n', '') || 'Yetkazilmadi: ' || v_note,
      updated_at = now()
  WHERE id = v_h.delivery_id;

  -- 5. Update order status
  IF v_o.id IS NOT NULL THEN
    UPDATE public.orders
    SET status = 'returned',
        payment_status = 'failed',
        notes = coalesce(notes || E'\n', '') || 'Kuryer topshira olmadi: ' || v_note,
        updated_at = now()
    WHERE id = v_o.id;
  END IF;

  -- 6. Notify courier
  INSERT INTO public.notifications (recipient_id, channel, title, body, data, sent_at)
  VALUES (
    v_h.courier_id, 'in_app',
    'Dostavka bekor qilindi',
    'Dostavka bekor qilindi va tovar omborga qaytarildi: ' || coalesce(v_o.order_no, ''),
    jsonb_build_object('handover_id', v_h.id, 'order_id', v_h.order_id, 'reason', v_note),
    now()
  );

  SELECT to_jsonb(h) INTO v_h FROM public.courier_cash_handovers h WHERE h.id = p_handover_id;
  RETURN to_jsonb(v_h);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_courier_delivery(uuid, text) TO authenticated, service_role;

-- Also harden cancel_undelivered_order
CREATE OR REPLACE FUNCTION public.cancel_undelivered_order(
  p_order_id uuid,
  p_reason text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_o public.orders%rowtype;
  v_del public.deliveries%rowtype;
  v_sale public.sales%rowtype;
  v_unit record;
  v_note text;
  v_default_loc uuid;
  v_handover_id uuid;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyurtma topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_o.status IN ('cancelled', 'returned') THEN
    RETURN to_jsonb(v_o);
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_o.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Allow mutation of immutable tables (sale_payments)
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  v_note := coalesce(nullif(btrim(p_reason), ''), 'Buyurtma bekor qilindi / qaytarildi');

  -- If order has a received courier cash handover, money was already accepted into branch cash!
  IF EXISTS (SELECT 1 FROM public.courier_cash_handovers WHERE order_id = p_order_id AND status = 'received') THEN
    RAISE EXCEPTION 'Ushbu buyurtma uchun naqd pul kassaga qabul qilingan. Uni tovar qaytarish (returns) bo‘limi orqali rasmiylashtiring' USING errcode = 'P0001';
  END IF;

  -- If there is a pending courier cash handover, delegate to reject_courier_delivery!
  SELECT id INTO v_handover_id
  FROM public.courier_cash_handovers
  WHERE order_id = p_order_id AND status = 'pending'
  LIMIT 1;

  IF v_handover_id IS NOT NULL THEN
    PERFORM public.reject_courier_delivery(v_handover_id, p_reason);
    SELECT * INTO v_o FROM public.orders WHERE id = p_order_id;
    RETURN to_jsonb(v_o);
  END IF;

  -- Default location for branch
  SELECT id INTO v_default_loc
  FROM public.locations
  WHERE branch_id = v_o.branch_id AND is_active AND type IN ('warehouse', 'store')
  ORDER BY CASE WHEN type = 'warehouse' THEN 1 ELSE 2 END
  LIMIT 1;

  -- Void sale if one exists
  SELECT * INTO v_sale FROM public.sales WHERE order_id = p_order_id FOR UPDATE;
  IF v_sale.id IS NOT NULL THEN
    UPDATE public.sales SET status = 'void', updated_at = now() WHERE id = v_sale.id;
    UPDATE public.sale_payments SET status = 'failed' WHERE sale_id = v_sale.id;

    FOR v_unit IN
      SELECT u.id, u.product_id, u.batch_id, coalesce(u.location_id, v_default_loc) AS location_id
      FROM public.inventory_units u
      WHERE u.sold_sale_id = v_sale.id
      FOR UPDATE OF u
    LOOP
      UPDATE public.inventory_units
      SET status = 'available',
          sold_sale_id = null,
          reserved_until = null,
          location_id = v_unit.location_id,
          version = version + 1
      WHERE id = v_unit.id;

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      VALUES (
        v_unit.id, v_unit.product_id, v_unit.batch_id, 'returned',
        v_unit.location_id, v_unit.location_id, 1,
        'online_order_cancel', p_order_id, v_note, auth.uid()
      ) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- Cancel delivery
  UPDATE public.deliveries
  SET status = 'failed',
      notes = coalesce(notes || E'\n', '') || 'Buyurtma bekor qilindi: ' || v_note,
      updated_at = now()
  WHERE order_id = p_order_id AND status NOT IN ('delivered', 'failed');

  -- Update order
  UPDATE public.orders
  SET status = 'cancelled',
      payment_status = 'failed',
      notes = coalesce(notes || E'\n', '') || 'Bekor qilindi: ' || v_note,
      updated_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_o;

  RETURN to_jsonb(v_o);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_undelivered_order(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
