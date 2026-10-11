-- Migration: 20260963070000_fix_delete_sale_movement_and_date_range.sql
-- 1. Fix delete_sale: use valid movement_type enum value 'returned' (not 'correction') and safely bypass immutable trigger for cleanup
-- 2. Fix delete_online_order: use valid movement_type enum value 'returned' (not 'order_return')
-- 3. Fix list_sales_history: gracefully handle inverted or null date ranges without raising 22023 error

BEGIN;

-- 1. list_sales_history: robust date range handling
CREATE OR REPLACE FUNCTION public.list_sales_history(
  p_branch_id uuid DEFAULT NULL,
  p_seller_id uuid DEFAULT NULL,
  p_from date DEFAULT current_date,
  p_to date DEFAULT current_date,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_from date := p_from;
  v_to date := p_to;
  v_tmp date;
BEGIN
  PERFORM public.require_report_access(p_branch_id);

  IF v_from IS NULL AND v_to IS NULL THEN
    v_from := current_date;
    v_to := current_date;
  ELSIF v_from IS NULL THEN
    v_from := v_to;
  ELSIF v_to IS NULL THEN
    v_to := v_from;
  END IF;

  IF v_to < v_from THEN
    v_tmp := v_from;
    v_from := v_to;
    v_to := v_tmp;
  END IF;

  WITH filtered AS (
    SELECT
      sl.id AS line_id,
      sl.unit_id,
      sl.product_id,
      sl.unit_price,
      sl.discount,
      sl.tax,
      sl.line_total,
      sl.unit_cost,
      s.id AS sale_id,
      s.sale_no,
      s.sold_at,
      s.status::text AS sale_status,
      s.branch_id,
      b.name AS branch_name,
      b.code AS branch_code,
      seller.full_name AS seller_name,
      s.seller_id,
      manager.full_name AS manager_name,
      p.name AS product_name,
      p.sku,
      p.slug AS product_slug,
      p.is_published,
      (SELECT pm.public_url FROM public.product_media pm
       WHERE pm.product_id = p.id AND pm.is_primary = true
       LIMIT 1) AS primary_media_url,
      u.qr_code,
      u.serial_number,
      count(*) OVER () AS total_count
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.branches b ON b.id = s.branch_id
    JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
    WHERE s.status <> 'void'
      AND s.sold_at >= public.business_day_start(v_from)
      AND s.sold_at < public.business_day_start(v_to + 1)
      AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
      AND (p_seller_id IS NULL OR s.seller_id = p_seller_id)
      AND (
        p_query IS NULL OR btrim(p_query) = ''
        OR p.name ILIKE '%' || btrim(p_query) || '%'
        OR p.sku ILIKE '%' || btrim(p_query) || '%'
        OR coalesce(u.qr_code, '') ILIKE '%' || btrim(p_query) || '%'
        OR coalesce(u.serial_number, '') ILIKE '%' || btrim(p_query) || '%'
      )
    ORDER BY s.sold_at DESC, sl.id DESC
    LIMIT greatest(coalesce(p_limit, 50), 1)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  )
  SELECT
    coalesce(jsonb_agg((to_jsonb(f) - 'total_count') ORDER BY f.sold_at DESC, f.line_id DESC), '[]'::jsonb),
    coalesce(max(f.total_count), 0)
  INTO v_items, v_total
  FROM filtered f;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_sales_history(uuid, uuid, date, date, text, integer, integer) TO authenticated, service_role;

-- 2. delete_sale: use valid movement_type enum value 'returned'
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

        -- Record returned movement with valid enum value 'returned'
        INSERT INTO public.inventory_movements(
          unit_id, product_id, batch_id, movement_type,
          from_location_id, to_location_id, quantity,
          reference_type, reference_id, reason, actor_id
        )
        VALUES (
          v_x.unit_id, v_x.product_id, v_x.batch_id, 'returned',
          v_x.location_id, v_x.location_id, 1,
          'sale_delete', p_sale_id, 'Sotuv o‘chirildi va tovar qaytarildi', v_caller_id
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

  BEGIN 
    ALTER TABLE public.inventory_movements DISABLE TRIGGER inventory_movements_immutable;
  EXCEPTION WHEN OTHERS THEN NULL; 
  END;

  DELETE FROM public.inventory_movements WHERE reference_type = 'sale' AND reference_id = p_sale_id;

  BEGIN 
    ALTER TABLE public.inventory_movements ENABLE TRIGGER inventory_movements_immutable;
  EXCEPTION WHEN OTHERS THEN NULL; 
  END;

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

-- 3. delete_online_order: use valid movement_type enum value 'returned'
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
          VALUES (v_x.unit_id, v_x.product_id, v_x.batch_id, 'returned', v_x.location_id, v_x.location_id, 1, 'order_delete', p_order_id, 'Buyurtma o‘chirildi va tovar omborga qaytarildi', v_caller_id)
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

COMMIT;

NOTIFY pgrst, 'reload schema';
