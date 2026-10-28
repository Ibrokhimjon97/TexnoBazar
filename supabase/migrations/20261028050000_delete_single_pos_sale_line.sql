-- Migration: Allow deleting individual items from a POS sale receipt
-- Function: delete_pos_pending_sale_line(p_pending_id, p_line_id, p_restore_stock)

CREATE OR REPLACE FUNCTION public.delete_pos_pending_sale_line(
  p_pending_id uuid,
  p_line_id uuid,
  p_restore_stock boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_pending public.pos_pending_sales%rowtype;
  v_sale_id uuid;
  v_line public.pos_pending_sale_lines%rowtype;
  v_line_count integer;
  v_new_subtotal numeric(18,2) := 0;
  v_new_discount numeric(18,2) := 0;
  v_new_tax numeric(18,2) := 0;
  v_new_total numeric(18,2) := 0;
  v_line_total numeric(18,2) := 0;
  v_diff numeric(18,2) := 0;
  v_del_items jsonb;
  v_pmt record;
  v_to_reduce numeric(18,2) := 0;
  v_reduced numeric(18,2) := 0;
BEGIN
  -- 1. Find and lock the pending sale
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so‘rovi topilmadi.' USING errcode = 'P0002';
  END IF;

  -- 2. Authorization check
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR (v_pending.branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], v_pending.branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
    OR (v_pending.seller_id = v_caller_id AND v_pending.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'Kassa so‘rovidan mahsulotni faqat administrator yoki menejer o‘chira oladi.' USING errcode = '42501';
  END IF;

  -- 3. Find the specific line
  SELECT * INTO v_line FROM public.pos_pending_sale_lines
  WHERE pending_sale_id = p_pending_id AND id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chek ichida ushbu mahsulot qatori topilmadi.' USING errcode = 'P0002';
  END IF;

  v_line_total := v_line.line_total;

  -- 4. Count remaining lines
  SELECT count(*) INTO v_line_count FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;

  -- If there's only 1 line (or 0), deleting this line deletes the entire sale!
  IF v_line_count <= 1 THEN
    PERFORM public.delete_pos_pending_sale(p_pending_id, p_restore_stock);
    RETURN jsonb_build_object(
      'success', true,
      'deleted_entire_sale', true,
      'remaining_count', 0,
      'message', CASE WHEN p_restore_stock 
        THEN 'Chekning so‘nggi mahsuloti o‘chirildi va butun kassa kirimi bekor qilinib, tovar omborga qaytarildi.'
        ELSE 'Chekning so‘nggi mahsuloti va butun kassa kirimi butunlay o‘chirildi.'
      END
    );
  END IF;

  -- 5. Multiple lines exist: Delete this single line and adjust sale
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- Check if sale is already confirmed in public.sales
  SELECT id INTO v_sale_id FROM public.sales WHERE pending_sale_id = p_pending_id LIMIT 1;

  -- Stock restoration / unlinking
  IF p_restore_stock THEN
    IF v_sale_id IS NOT NULL THEN
      -- Already confirmed sale: restore unit to available and record returned movement
      UPDATE public.inventory_units
      SET status = 'available', sold_sale_id = NULL, reserved_until = NULL, version = version + 1
      WHERE id = v_line.unit_id;

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      SELECT
        u.id, u.product_id, u.batch_id, 'returned',
        u.location_id, u.location_id, 1,
        'sale_line_delete', v_sale_id, 'Chekdan tovar o‘chirildi va omborga qaytarildi', v_caller_id
      FROM public.inventory_units u WHERE u.id = v_line.unit_id
      ON CONFLICT DO NOTHING;
    ELSE
      -- Pending sale: release reservation
      UPDATE public.inventory_units
      SET status = 'available', reserved_until = NULL, version = version + 1
      WHERE id = v_line.unit_id AND status = 'reserved';

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      SELECT
        u.id, u.product_id, u.batch_id, 'reservation_released',
        u.location_id, u.location_id, 1,
        'pos_pending_sale', p_pending_id, 'Chekdan tovar o‘chirildi va rezerv bo‘shatildi', v_caller_id
      FROM public.inventory_units u WHERE u.id = v_line.unit_id
      ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    -- Do not restore: just unlink from sale
    UPDATE public.inventory_units
    SET sold_sale_id = NULL, reserved_until = NULL, version = version + 1
    WHERE id = v_line.unit_id;
  END IF;

  -- Clean 'sold' movement for this specific unit if sale was confirmed
  IF v_sale_id IS NOT NULL THEN
    BEGIN 
      ALTER TABLE public.inventory_movements DISABLE TRIGGER inventory_movements_immutable;
    EXCEPTION WHEN OTHERS THEN NULL; 
    END;
    DELETE FROM public.inventory_movements
    WHERE reference_type = 'sale' AND reference_id = v_sale_id AND unit_id = v_line.unit_id;
    BEGIN 
      ALTER TABLE public.inventory_movements ENABLE TRIGGER inventory_movements_immutable;
    EXCEPTION WHEN OTHERS THEN NULL; 
    END;

    -- Delete from public.sale_lines
    DELETE FROM public.sale_lines WHERE sale_id = v_sale_id AND unit_id = v_line.unit_id;
  END IF;

  -- Delete from public.pos_pending_sale_lines
  DELETE FROM public.pos_pending_sale_lines WHERE id = p_line_id;

  -- 6. Recalculate totals from remaining lines
  SELECT
    coalesce(sum(unit_price), 0),
    coalesce(sum(discount), 0),
    coalesce(sum(tax), 0),
    coalesce(sum(line_total), 0)
  INTO v_new_subtotal, v_new_discount, v_new_tax, v_new_total
  FROM public.pos_pending_sale_lines
  WHERE pending_sale_id = p_pending_id;

  -- Update pos_pending_sales
  UPDATE public.pos_pending_sales
  SET subtotal = v_new_subtotal,
      discount = v_new_discount,
      tax = v_new_tax,
      total = v_new_total,
      updated_at = now()
  WHERE id = p_pending_id;

  -- Update public.sales if confirmed
  IF v_sale_id IS NOT NULL THEN
    UPDATE public.sales
    SET subtotal = v_new_subtotal,
        discount = v_new_discount,
        tax = v_new_tax,
        total = v_new_total,
        updated_at = now()
    WHERE id = v_sale_id;

    -- Adjust sale_payments to match new total
    v_to_reduce := v_line_total;
    FOR v_pmt IN
      SELECT id, amount FROM public.sale_payments
      WHERE sale_id = v_sale_id
      ORDER BY amount DESC, id
      FOR UPDATE
    LOOP
      IF v_to_reduce <= 0 THEN
        EXIT;
      END IF;

      IF v_pmt.amount <= v_to_reduce THEN
        v_reduced := v_pmt.amount;
        v_to_reduce := v_to_reduce - v_reduced;
        DELETE FROM public.sale_payments WHERE id = v_pmt.id;
      ELSE
        UPDATE public.sale_payments
        SET amount = amount - v_to_reduce
        WHERE id = v_pmt.id;
        v_to_reduce := 0;
      END IF;
    END LOOP;

    -- Sanity check: Ensure total paid in sale_payments matches v_new_total exactly
    SELECT coalesce(sum(amount), 0) INTO v_diff FROM public.sale_payments WHERE sale_id = v_sale_id;
    IF v_diff <> v_new_total AND EXISTS(SELECT 1 FROM public.sale_payments WHERE sale_id = v_sale_id) THEN
      UPDATE public.sale_payments
      SET amount = amount + (v_new_total - v_diff)
      WHERE id = (SELECT id FROM public.sale_payments WHERE sale_id = v_sale_id ORDER BY amount DESC LIMIT 1);
    END IF;
  ELSE
    -- If still pending, adjust pos_pending_sale_payments
    v_to_reduce := v_line_total;
    FOR v_pmt IN
      SELECT id, amount FROM public.pos_pending_sale_payments
      WHERE pending_sale_id = p_pending_id
      ORDER BY amount DESC, id
      FOR UPDATE
    LOOP
      IF v_to_reduce <= 0 THEN
        EXIT;
      END IF;

      IF v_pmt.amount <= v_to_reduce THEN
        v_reduced := v_pmt.amount;
        v_to_reduce := v_to_reduce - v_reduced;
        DELETE FROM public.pos_pending_sale_payments WHERE id = v_pmt.id;
      ELSE
        UPDATE public.pos_pending_sale_payments
        SET amount = amount - v_to_reduce
        WHERE id = v_pmt.id;
        v_to_reduce := 0;
      END IF;
    END LOOP;

    SELECT coalesce(sum(amount), 0) INTO v_diff FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id;
    IF v_diff <> v_new_total AND EXISTS(SELECT 1 FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id) THEN
      UPDATE public.pos_pending_sale_payments
      SET amount = amount + (v_new_total - v_diff)
      WHERE id = (SELECT id FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id ORDER BY amount DESC LIMIT 1);
    END IF;
  END IF;

  -- 7. Update pos_deliveries if attached
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'product_name', p.name,
    'unit_price', l.unit_price,
    'line_total', l.line_total,
    'batch_code', coalesce(u.qr_code, ''),
    'qr_code', u.qr_code,
    'quantity', 1
  )), '[]'::jsonb)
  INTO v_del_items
  FROM public.pos_pending_sale_lines l
  JOIN public.products p ON p.id = l.product_id
  JOIN public.inventory_units u ON u.id = l.unit_id
  WHERE l.pending_sale_id = p_pending_id;

  UPDATE public.pos_deliveries
  SET total_amount = v_new_total,
      cod_amount = LEAST(cod_amount, v_new_total),
      items = v_del_items
  WHERE (sale_id = v_sale_id AND v_sale_id IS NOT NULL) OR pending_sale_id = p_pending_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_entire_sale', false,
    'new_total', v_new_total,
    'remaining_count', v_line_count - 1,
    'message', CASE WHEN p_restore_stock 
      THEN 'Mahsulot chekdan muvaffaqiyatli o‘chirildi va omborga qaytarildi.'
      ELSE 'Mahsulot chekdan butunlay o‘chirildi (omborga qaytarilmadi).'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_pos_pending_sale_line(uuid, uuid, boolean) TO authenticated, service_role;
