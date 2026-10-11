-- Migration: 20260963040000_admin_manager_cleanup_rpcs.sql
-- Description: Enable managers and admins to delete test/obsolete cashier records, sales, attendance, and orders cleanly.

-- 1. guard_sale_payment_refund_update: allow DELETE when admin_override is set
CREATE OR REPLACE FUNCTION public.guard_sale_payment_refund_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('texnobazar.admin_override', true) = 'allowed' THEN
    IF tg_op = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF tg_op = 'DELETE' OR current_setting('texnobazar.complete_sale_return', true) IS DISTINCT FROM 'allowed'
    OR old.id IS DISTINCT FROM new.id OR old.sale_id IS DISTINCT FROM new.sale_id OR old.payment_method_id IS DISTINCT FROM new.payment_method_id
    OR old.amount IS DISTINCT FROM new.amount OR old.external_reference IS DISTINCT FROM new.external_reference
    OR old.received_by IS DISTINCT FROM new.received_by OR old.paid_at IS DISTINCT FROM new.paid_at
    OR old.metadata IS DISTINCT FROM new.metadata OR old.created_at IS DISTINCT FROM new.created_at
    OR NOT ((old.status = 'paid' AND new.status IN ('partially_refunded', 'refunded'))
      OR (old.status = 'partially_refunded' AND new.status = 'refunded') OR old.status = new.status) THEN
    RAISE EXCEPTION 'Sale payment o‘zgarmas; faqat refund status o‘tishi mumkin' USING errcode = '55000';
  END IF;

  RETURN NEW;
END;
$$;

-- 2. delete_employee_attendance: allow manager role in addition to superadmin/admin
CREATE OR REPLACE FUNCTION public.delete_employee_attendance(p_attendance_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR EXISTS (
      SELECT 1 FROM public.employee_attendance ea
      WHERE ea.id = ANY(p_attendance_ids)
        AND ea.branch_id IS NOT NULL
        AND public.has_role(array['manager']::public.app_role[], ea.branch_id)
    )
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki menejer davomat ma’lumotlarini o‘chira oladi.' USING errcode = '42501';
  END IF;

  DELETE FROM public.employee_attendance
  WHERE id = ANY(p_attendance_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'deleted_count', v_count);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_employee_attendance(uuid[]) TO authenticated, service_role;

-- 3. delete_online_order: allow manager role in addition to superadmin/admin
CREATE OR REPLACE FUNCTION public.delete_online_order(p_order_id uuid, p_restore_stock boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_sale_id uuid;
  v_loc_id uuid;
  v_x record;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyurtma topilmadi.' USING errcode = 'P0002';
  END IF;

  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR (v_order.branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], v_order.branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki menejer buyurtmalarni o‘chira oladi.' USING errcode = '42501';
  END IF;

  PERFORM set_config('texnobazar.admin_override', 'allowed', true);
  PERFORM set_config('texnobazar.payment_gateway', 'allowed', true);

  SELECT id INTO v_sale_id FROM public.sales WHERE order_id = p_order_id LIMIT 1;

  IF p_restore_stock THEN
    -- Restore reserved units
    FOR v_x IN SELECT r.unit_id, u.product_id, u.batch_id, u.location_id
               FROM public.order_reserved_units r
               JOIN public.inventory_units u ON u.id = r.unit_id
               WHERE r.order_id = p_order_id AND u.status = 'reserved'
    LOOP
      UPDATE public.inventory_units
      SET status = 'available', reserved_until = NULL, version = version + 1
      WHERE id = v_x.unit_id;

      INSERT INTO public.inventory_movements(unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id, quantity, reference_type, reference_id, reason, actor_id)
      VALUES (v_x.unit_id, v_x.product_id, v_x.batch_id, 'reservation_released', v_x.location_id, v_x.location_id, 1, 'online_order', p_order_id, 'Buyurtma o‘chirildi va rezerv bekor qilindi', v_caller_id)
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- If sale finalized, return units and delete sale
    IF v_sale_id IS NOT NULL THEN
      FOR v_x IN SELECT sl.unit_id, sl.product_id, u.batch_id, u.location_id, sl.line_total
                 FROM public.sale_lines sl
                 LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
                 WHERE sl.sale_id = v_sale_id
      LOOP
        IF v_x.unit_id IS NOT NULL THEN
          UPDATE public.inventory_units
          SET status = 'available', sold_sale_id = NULL, version = version + 1
          WHERE id = v_x.unit_id;

          INSERT INTO public.inventory_movements(unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id, quantity, reference_type, reference_id, reason, actor_id)
          VALUES (v_x.unit_id, v_x.product_id, v_x.batch_id, 'order_return', v_x.location_id, v_x.location_id, 1, 'online_order', p_order_id, 'Buyurtma o‘chirildi va tovar omborga qaytarildi', v_caller_id)
          ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;

      DELETE FROM public.sale_payments WHERE sale_id = v_sale_id;
      DELETE FROM public.sale_lines WHERE sale_id = v_sale_id;
      DELETE FROM public.sales WHERE id = v_sale_id;
      v_sale_id := NULL;
    ELSE
      IF v_order.branch_id IS NOT NULL THEN
        SELECT id INTO v_loc_id FROM public.locations WHERE branch_id = v_order.branch_id AND is_active = true LIMIT 1;
        IF v_loc_id IS NOT NULL THEN
          FOR v_x IN SELECT product_id, quantity FROM public.order_lines WHERE order_id = p_order_id
          LOOP
            UPDATE public.inventory_balances
            SET on_hand = on_hand + v_x.quantity, updated_at = now()
            WHERE product_id = v_x.product_id AND location_id = v_loc_id;
          END LOOP;
        END IF;
      END IF;
    END IF;
  ELSE
    IF v_sale_id IS NOT NULL THEN
      UPDATE public.sales SET order_id = NULL WHERE id = v_sale_id;
    END IF;
    UPDATE public.inventory_units
    SET status = 'available', reserved_until = NULL, version = version + 1
    WHERE id IN (
      SELECT unit_id FROM public.order_reserved_units WHERE order_id = p_order_id
    ) AND status = 'reserved';
  END IF;

  DELETE FROM public.receipt_delivery_outbox WHERE order_id = p_order_id;
  DELETE FROM public.payment_transactions WHERE order_id = p_order_id;
  DELETE FROM public.courier_cash_handovers WHERE order_id = p_order_id OR delivery_id IN (SELECT id FROM public.deliveries WHERE order_id = p_order_id);
  DELETE FROM public.delivery_attempts WHERE delivery_id IN (SELECT id FROM public.deliveries WHERE order_id = p_order_id) OR order_id = p_order_id;
  DELETE FROM public.deliveries WHERE order_id = p_order_id;
  DELETE FROM public.order_reserved_units WHERE order_id = p_order_id;
  DELETE FROM public.order_status_history WHERE order_id = p_order_id;
  DELETE FROM public.order_lines WHERE order_id = p_order_id;
  DELETE FROM public.orders WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', CASE WHEN p_restore_stock THEN 'Buyurtma o‘chirildi va tovar omborga qaytarildi.'
                    ELSE 'Buyurtma o‘chirildi.' END
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_online_order(uuid, boolean) TO authenticated, service_role;

-- 4. delete_sale: delete a finalized sale and restore units to available
CREATE OR REPLACE FUNCTION public.delete_sale(p_sale_id uuid, p_restore_stock boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_pending_id uuid;
  v_x record;
BEGIN
  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sotuv topilmadi.' USING errcode = 'P0002';
  END IF;

  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR (v_sale.branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], v_sale.branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki menejer sotuvni o‘chira oladi.' USING errcode = '42501';
  END IF;

  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  v_pending_id := v_sale.pending_sale_id;

  -- 1. Restore sold units back to available
  IF p_restore_stock THEN
    FOR v_x IN
      SELECT sl.unit_id, sl.product_id, u.batch_id, u.location_id
      FROM public.sale_lines sl
      LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
      WHERE sl.sale_id = p_sale_id
    LOOP
      IF v_x.unit_id IS NOT NULL THEN
        UPDATE public.inventory_units
        SET status = 'available', sold_sale_id = NULL, version = version + 1
        WHERE id = v_x.unit_id;

        INSERT INTO public.inventory_movements(
          unit_id, product_id, batch_id, movement_type,
          from_location_id, to_location_id, quantity,
          reference_type, reference_id, reason, actor_id
        )
        VALUES (
          v_x.unit_id, v_x.product_id, v_x.batch_id, 'correction',
          v_x.location_id, v_x.location_id, 1,
          'sale', p_sale_id, 'Sotuv o‘chirildi va tovar qaytarildi', v_caller_id
        )
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  ELSE
    -- Unlink units from this sale
    UPDATE public.inventory_units
    SET status = 'available', sold_sale_id = NULL, version = version + 1
    WHERE sold_sale_id = p_sale_id;
  END IF;

  -- 2. Clean dependent records
  DELETE FROM public.receipt_delivery_outbox WHERE sale_id = p_sale_id;
  DELETE FROM public.sale_return_lines WHERE return_id IN (
    SELECT id FROM public.sale_returns WHERE original_sale_id = p_sale_id OR replacement_sale_id = p_sale_id
  );
  DELETE FROM public.sale_returns WHERE original_sale_id = p_sale_id OR replacement_sale_id = p_sale_id;
  DELETE FROM public.exchange_transactions WHERE original_sale_id = p_sale_id OR replacement_sale_id = p_sale_id;
  DELETE FROM public.business_corrections WHERE replacement_sale_id = p_sale_id;
  DELETE FROM public.sale_refunds WHERE sale_id = p_sale_id;
  DELETE FROM public.sale_payments WHERE sale_id = p_sale_id;
  DELETE FROM public.sale_lines WHERE sale_id = p_sale_id;
  DELETE FROM public.inventory_movements WHERE reference_type = 'sale' AND reference_id = p_sale_id;

  -- 3. Delete sale record
  DELETE FROM public.sales WHERE id = p_sale_id;

  -- 4. If linked to pos_pending_sales, clean that up as well
  IF v_pending_id IS NOT NULL THEN
    DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = v_pending_id;
    DELETE FROM public.pos_pending_sale_lines WHERE pending_sale_id = v_pending_id;
    DELETE FROM public.pos_pending_sales WHERE id = v_pending_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Sotuv muvaffaqiyatli o‘chirildi.');
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_sale(uuid, boolean) TO authenticated, service_role;

-- 5. delete_pos_pending_sale: delete a cashier pending or confirmed entry
CREATE OR REPLACE FUNCTION public.delete_pos_pending_sale(p_pending_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_pending public.pos_pending_sales%rowtype;
  v_sale_id uuid;
  v_x record;
BEGIN
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so‘rovi topilmadi.' USING errcode = 'P0002';
  END IF;

  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR (v_pending.branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], v_pending.branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki menejer kassa so‘rovini o‘chira oladi.' USING errcode = '42501';
  END IF;

  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- Check if finalized into a sale
  SELECT id INTO v_sale_id FROM public.sales WHERE pending_sale_id = p_pending_id LIMIT 1;

  IF v_sale_id IS NOT NULL THEN
    -- Call delete_sale which handles restoring stock, deleting payments, lines, and sale
    PERFORM public.delete_sale(v_sale_id, true);
  ELSE
    -- Restore reserved units back to available
    UPDATE public.inventory_units
    SET status = 'available', reserved_until = NULL, version = version + 1
    WHERE id IN (
      SELECT unit_id FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id
    ) AND status = 'reserved';

    -- Remove pos pending lines, payments, and record
    DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id;
    DELETE FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;
    DELETE FROM public.pos_pending_sales WHERE id = p_pending_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Kassa kirimi va unga bog‘liq sotuv o‘chirildi.');
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_pos_pending_sale(uuid) TO authenticated, service_role;
