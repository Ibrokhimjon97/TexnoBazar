-- Migration: admin_deletions_feature.sql
-- 1. delete_online_order with optional stock return and revenue deduction
-- 2. delete_employee_attendance (bulk / single)
-- 3. delete_report_rows (bulk / single for sales, finance, debts, counts)

-- 1. Online order delete
CREATE OR REPLACE FUNCTION delete_online_order(
  p_order_id uuid,
  p_restore_stock boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_sale_id uuid;
  v_loc_id uuid;
  v_x record;
BEGIN
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator buyurtmalarni o‘chira oladi.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyurtma topilmadi.' USING errcode = 'P0002';
  END IF;

  SELECT id INTO v_sale_id FROM public.sales WHERE order_id = p_order_id LIMIT 1;

  IF p_restore_stock THEN
    -- 1. Restore reserved units
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

    -- 2. If a sale was finalized, return sold units back to available and delete sale (deducting income)
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

      -- Remove sale payments, lines and the sale record itself (reverses income/sales)
      DELETE FROM public.sale_payments WHERE sale_id = v_sale_id;
      DELETE FROM public.sale_lines WHERE sale_id = v_sale_id;
      DELETE FROM public.sales WHERE id = v_sale_id;
      v_sale_id := NULL;
    ELSE
      -- If order was completed without sale record, increment balances
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
    -- Do not restore stock, just unlink sale if present
    IF v_sale_id IS NOT NULL THEN
      UPDATE public.sales SET order_id = NULL WHERE id = v_sale_id;
    END IF;
  END IF;

  -- 3. Delete dependent order records
  DELETE FROM public.receipt_delivery_outbox WHERE order_id = p_order_id;
  DELETE FROM public.payment_transactions WHERE order_id = p_order_id;
  DELETE FROM public.courier_cash_handovers WHERE order_id = p_order_id;
  DELETE FROM public.delivery_attempts WHERE delivery_id IN (SELECT id FROM public.deliveries WHERE order_id = p_order_id);
  DELETE FROM public.deliveries WHERE order_id = p_order_id;
  DELETE FROM public.order_reserved_units WHERE order_id = p_order_id;
  DELETE FROM public.order_status_history WHERE order_id = p_order_id;
  DELETE FROM public.order_lines WHERE order_id = p_order_id;

  -- 4. Delete the order
  DELETE FROM public.orders WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', CASE WHEN p_restore_stock THEN 'Buyurtma o‘chirildi, tovar omborga qaytarildi va hisoblangan mablag‘ balansdan ayirildi.'
                    ELSE 'Buyurtma o‘chirildi.' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION delete_online_order(uuid, boolean) TO authenticated, service_role;

-- 2. Attendance deletion
CREATE OR REPLACE FUNCTION delete_employee_attendance(p_attendance_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator davomat ma’lumotlarini o‘chira oladi.' USING errcode = '42501';
  END IF;

  DELETE FROM public.employee_attendance
  WHERE id = ANY(p_attendance_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'deleted_count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION delete_employee_attendance(uuid[]) TO authenticated, service_role;

-- 3. Report rows deletion
CREATE OR REPLACE FUNCTION delete_report_rows(
  p_type text,
  p_identifiers text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_deleted integer := 0;
  v_x record;
BEGIN
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator hisobot qatorlarini o‘chira oladi.' USING errcode = '42501';
  END IF;

  IF p_type = 'sales' THEN
    -- Unset sold status on units back to available
    FOR v_x IN SELECT u.id, u.product_id, u.batch_id, u.location_id
               FROM public.inventory_units u
               WHERE u.sold_sale_id IN (
                 SELECT id FROM public.sales WHERE sale_no = ANY(p_identifiers) OR id::text = ANY(p_identifiers)
               )
    LOOP
      UPDATE public.inventory_units
      SET status = 'available', sold_sale_id = NULL, version = version + 1
      WHERE id = v_x.id;

      INSERT INTO public.inventory_movements(unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id, quantity, reference_type, reference_id, reason, actor_id)
      VALUES (v_x.id, v_x.product_id, v_x.batch_id, 'sale_cancelled', v_x.location_id, v_x.location_id, 1, 'sale_deletion', v_x.id, 'Savdo hisoboti o‘chirildi va tovar qaytarildi', v_caller_id)
      ON CONFLICT DO NOTHING;
    END LOOP;

    -- Delete payments and lines
    DELETE FROM public.sale_payments
    WHERE sale_id IN (
      SELECT id FROM public.sales WHERE sale_no = ANY(p_identifiers) OR id::text = ANY(p_identifiers)
    );

    DELETE FROM public.sale_lines
    WHERE sale_id IN (
      SELECT id FROM public.sales WHERE sale_no = ANY(p_identifiers) OR id::text = ANY(p_identifiers)
    );

    DELETE FROM public.sales
    WHERE sale_no = ANY(p_identifiers) OR id::text = ANY(p_identifiers);

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

  ELSIF p_type = 'debts' THEN
    DELETE FROM public.debt_payments
    WHERE debt_id IN (
      SELECT id FROM public.branch_debts WHERE id::text = ANY(p_identifiers)
    );
    DELETE FROM public.branch_debts
    WHERE id::text = ANY(p_identifiers);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

  ELSIF p_type IN ('finance', 'expenses') THEN
    DELETE FROM public.finance_transactions
    WHERE id::text = ANY(p_identifiers);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

  ELSIF p_type = 'counts' THEN
    DELETE FROM public.inventory_count_lines
    WHERE count_id IN (
      SELECT id FROM public.inventory_counts WHERE id::text = ANY(p_identifiers) OR count_no = ANY(p_identifiers)
    );
    DELETE FROM public.inventory_counts
    WHERE id::text = ANY(p_identifiers) OR count_no = ANY(p_identifiers);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

  ELSE
    RAISE EXCEPTION 'Noma’lum hisobot turi: %', p_type;
  END IF;

  RETURN jsonb_build_object('success', true, 'deleted_count', v_deleted);
END;
$$;

GRANT EXECUTE ON FUNCTION delete_report_rows(text, text[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
