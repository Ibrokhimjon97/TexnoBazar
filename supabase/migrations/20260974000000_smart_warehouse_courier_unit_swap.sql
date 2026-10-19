-- Migration: Smart Warehouse Courier Unit Swap & POS Fulfillment
-- Addresses the scenario where a seller in the store showroom scans a store display unit QR code,
-- but the delivery must be fulfilled and dispatched from the warehouse (omborxona).
-- 
-- 1. Upgrades courier_verify_order_unit with Smart Unit Swap:
--    If courier scans a warehouse box QR code (different from showroom unit), system verifies it belongs
--    to the same product/branch and automatically swaps the reservation: showroom unit is freed back
--    to 'available', warehouse unit is reserved & confirmed for the order.
-- 2. Upgrades get_courier_order_verification to return location name & batch details.
-- 3. Upgrades create_pos_delivery with auto-fulfillment from warehouse:
--    When POS delivery is created, any sold store unit is automatically swapped to an available warehouse
--    unit so the showroom display is never depleted, and the printed sticker has the exact warehouse QR/batch.
-- 4. Introduces pos_delivery_swap_unit RPC for manual warehouse unit swap by manager/cashier.
-- 5. Upgrades get_pos_batch_units to support p_prefer_location ('warehouse' or 'store').

BEGIN;

-- 1. Upgrade courier_verify_order_unit
CREATE OR REPLACE FUNCTION public.courier_verify_order_unit(p_order_id uuid, p_qr_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.deliveries%rowtype;
  v_order public.orders%rowtype;
  v_code text := nullif(btrim(p_qr_code), '');
  v_match record;
  v_scanned_unit record;
  v_target_res record;
  v_all_confirmed boolean;
  v_total integer;
  v_confirmed integer;
BEGIN
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR kod talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyurtma topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT * INTO v_delivery FROM public.deliveries WHERE order_id = p_order_id;
  IF v_delivery.id IS NULL OR (
    v_delivery.courier_id <> auth.uid()
    AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null)
    AND NOT public.has_role(array['manager']::public.app_role[], v_order.branch_id)
  ) THEN
    RAISE EXCEPTION 'Sizga biriktirilgan yetkazish topilmadi' USING errcode = '42501';
  END IF;

  -- 1) Direct Match: Check if the scanned QR code matches an active reservation for this order
  SELECT r.id AS reservation_id, r.unit_id, u.qr_code, ol.product_name, r.courier_confirmed_at,
         l.name AS location_name, l.type AS location_type
  INTO v_match
  FROM public.order_reserved_units r
  JOIN public.inventory_units u ON u.id = r.unit_id
  JOIN public.order_lines ol ON ol.id = r.order_line_id
  LEFT JOIN public.locations l ON l.id = u.location_id
  WHERE r.order_id = p_order_id
    AND r.released_at IS NULL
    AND r.fulfilled_at IS NULL
    AND (upper(u.qr_code) = upper(v_code) OR upper(coalesce(u.serial_number, '')) = upper(v_code))
  LIMIT 1;

  IF v_match.reservation_id IS NOT NULL THEN
    -- If already confirmed
    IF v_match.courier_confirmed_at IS NOT NULL THEN
      SELECT count(*), count(*) FILTER (WHERE courier_confirmed_at IS NOT NULL)
      INTO v_total, v_confirmed
      FROM public.order_reserved_units
      WHERE order_id = p_order_id AND released_at IS NULL AND fulfilled_at IS NULL;

      RETURN jsonb_build_object(
        'matched', true,
        'already_confirmed', true,
        'swapped', false,
        'product_name', v_match.product_name,
        'qr_code', v_match.qr_code,
        'location_name', coalesce(v_match.location_name, 'Do‘kon'),
        'confirmed_count', v_confirmed,
        'total_count', v_total,
        'all_confirmed', (v_total > 0 AND v_total = v_confirmed),
        'message', 'Ushbu tovar allaqachon tasdiqlangan'
      );
    END IF;

    -- Confirm direct match
    UPDATE public.order_reserved_units
    SET courier_confirmed_at = now(), courier_confirmed_by = auth.uid()
    WHERE id = v_match.reservation_id;

    SELECT count(*), count(*) FILTER (WHERE courier_confirmed_at IS NOT NULL)
    INTO v_total, v_confirmed
    FROM public.order_reserved_units
    WHERE order_id = p_order_id AND released_at IS NULL AND fulfilled_at IS NULL;

    RETURN jsonb_build_object(
      'matched', true,
      'swapped', false,
      'product_name', v_match.product_name,
      'qr_code', v_match.qr_code,
      'location_name', coalesce(v_match.location_name, 'Do‘kon'),
      'confirmed_count', v_confirmed,
      'total_count', v_total,
      'all_confirmed', (v_total > 0 AND v_total = v_confirmed),
      'message', 'Mahsulot tasdiqlandi'
    );
  END IF;

  -- 2) Smart Swap: Scanned QR code belongs to a warehouse/branch unit of the same product
  SELECT u.id, u.product_id, u.variant_id, u.batch_id, u.status, u.location_id,
         u.qr_code, u.serial_number, l.branch_id, l.name AS location_name, l.type AS location_type,
         p.name AS product_name, p.sku
  INTO v_scanned_unit
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  WHERE (upper(u.qr_code) = upper(v_code) OR upper(coalesce(u.serial_number, '')) = upper(v_code))
  LIMIT 1;

  IF v_scanned_unit.id IS NULL THEN
    RETURN jsonb_build_object(
      'matched', false,
      'message', 'Bu QR kod yoki seriya raqamli tovar tizimda topilmadi.'
    );
  END IF;

  IF v_scanned_unit.branch_id <> v_order.branch_id THEN
    RETURN jsonb_build_object(
      'matched', false,
      'message', 'Skanerlangan tovar boshqa filialga tegishli.'
    );
  END IF;

  IF v_scanned_unit.status <> 'available' THEN
    RETURN jsonb_build_object(
      'matched', false,
      'message', 'Ushbu tovar hozir bo‘sh (available) emas: holati "' || v_scanned_unit.status || '".'
    );
  END IF;

  -- Find an unconfirmed reserved unit in this order for this product (preferring store display unit to swap out)
  SELECT r.id AS reservation_id, r.order_line_id, r.unit_id AS old_unit_id,
         ol.product_id, ol.variant_id, ol.product_name, ol.sku,
         old_u.qr_code AS old_qr_code, old_l.name AS old_location_name,
         old_l.type AS old_location_type
  INTO v_target_res
  FROM public.order_reserved_units r
  JOIN public.order_lines ol ON ol.id = r.order_line_id
  JOIN public.inventory_units old_u ON old_u.id = r.unit_id
  LEFT JOIN public.locations old_l ON old_l.id = old_u.location_id
  WHERE r.order_id = p_order_id
    AND r.released_at IS NULL
    AND r.fulfilled_at IS NULL
    AND r.courier_confirmed_at IS NULL
    AND ol.product_id = v_scanned_unit.product_id
    AND (ol.variant_id IS NULL OR v_scanned_unit.variant_id IS NULL OR ol.variant_id = v_scanned_unit.variant_id)
  ORDER BY
    -- Free store display unit first
    CASE WHEN old_l.type = 'store' THEN 0 ELSE 1 END,
    r.created_at ASC
  LIMIT 1;

  IF v_target_res.reservation_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.order_lines ol
      WHERE ol.order_id = p_order_id AND ol.product_id = v_scanned_unit.product_id
    ) THEN
      RETURN jsonb_build_object(
        'matched', false,
        'message', 'Buyurtmadagi barcha "' || v_scanned_unit.product_name || '" tovarlari allaqachon tasdiqlangan.'
      );
    ELSE
      RETURN jsonb_build_object(
        'matched', false,
        'message', 'Bu tovar ("' || v_scanned_unit.product_name || '") ushbu buyurtmaga tegishli emas.'
      );
    END IF;
  END IF;

  -- Execute Swap:
  -- A) Free old showroom unit back to available
  UPDATE public.inventory_units
  SET status = 'available', reserved_until = null, version = version + 1
  WHERE id = v_target_res.old_unit_id;

  INSERT INTO public.inventory_movements(
    unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, reference_type, reference_id, reason, actor_id
  )
  SELECT v_target_res.old_unit_id, v_target_res.product_id, batch_id, 'reservation_released',
         location_id, location_id, 1, 'online_order', p_order_id,
         'Kuryer ombordan yangi birlikni skanerlagani sababli do‘kondagi namuna bo‘shatildi', auth.uid()
  FROM public.inventory_units WHERE id = v_target_res.old_unit_id
  ON CONFLICT DO NOTHING;

  -- B) Reserve the newly scanned warehouse unit
  UPDATE public.inventory_units
  SET status = 'reserved', reserved_until = null, version = version + 1
  WHERE id = v_scanned_unit.id;

  INSERT INTO public.inventory_movements(
    unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, reference_type, reference_id, reason, actor_id
  )
  VALUES (
    v_scanned_unit.id, v_scanned_unit.product_id, v_scanned_unit.batch_id, 'reserved',
    v_scanned_unit.location_id, v_scanned_unit.location_id, 1, 'online_order', p_order_id,
    'Kuryer ombordan yetkazish uchun skanerlab biriktirdi', auth.uid()
  )
  ON CONFLICT DO NOTHING;

  -- C) Update reservation record to point to the new unit
  UPDATE public.order_reserved_units
  SET unit_id = v_scanned_unit.id,
      courier_confirmed_at = now(),
      courier_confirmed_by = auth.uid()
  WHERE id = v_target_res.reservation_id;

  -- D) Calculate new totals
  SELECT count(*), count(*) FILTER (WHERE courier_confirmed_at IS NOT NULL)
  INTO v_total, v_confirmed
  FROM public.order_reserved_units
  WHERE order_id = p_order_id AND released_at IS NULL AND fulfilled_at IS NULL;

  v_all_confirmed := (v_total > 0 AND v_total = v_confirmed);

  RETURN jsonb_build_object(
    'matched', true,
    'swapped', true,
    'product_name', v_scanned_unit.product_name,
    'qr_code', v_scanned_unit.qr_code,
    'old_qr_code', v_target_res.old_qr_code,
    'location_name', coalesce(v_scanned_unit.location_name, 'Ombor'),
    'confirmed_count', v_confirmed,
    'total_count', v_total,
    'all_confirmed', v_all_confirmed,
    'message', 'Ombordagi tovar (' || coalesce(v_scanned_unit.location_name, 'Ombor') || ') tasdiqlandi (doʻkondagi namuna boʻshatildi)'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_verify_order_unit(uuid, text) TO authenticated, service_role;


-- 2. Upgrade get_courier_order_verification to return richer unit & location details
CREATE OR REPLACE FUNCTION public.get_courier_order_verification(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.deliveries%rowtype;
  v_items jsonb;
BEGIN
  SELECT * INTO v_delivery FROM public.deliveries WHERE order_id = p_order_id;
  IF v_delivery.id IS NULL OR (
    v_delivery.courier_id <> auth.uid()
    AND NOT public.has_role(array['superadmin','admin']::public.app_role[], null)
    AND NOT public.has_role(array['manager']::public.app_role[], (SELECT branch_id FROM public.orders WHERE id = p_order_id))
  ) THEN
    RAISE EXCEPTION 'Sizga biriktirilgan yetkazish topilmadi' USING errcode = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      ol.product_name,
      ol.sku,
      (r.courier_confirmed_at IS NOT NULL) AS confirmed,
      u.qr_code,
      u.serial_number,
      coalesce(l.name, 'Ombor') AS location_name,
      l.type AS location_type,
      coalesce(sb.reference, 'PRT-' || substr(coalesce(u.batch_id::text, '00000000'), 1, 8)) AS batch_code
    FROM public.order_lines ol
    JOIN public.order_reserved_units r ON r.order_line_id = ol.id AND r.released_at IS NULL AND r.fulfilled_at IS NULL
    JOIN public.inventory_units u ON u.id = r.unit_id
    LEFT JOIN public.locations l ON l.id = u.location_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE ol.order_id = p_order_id
    ORDER BY r.created_at ASC
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'all_confirmed', NOT EXISTS (
      SELECT 1 FROM public.order_lines ol
      JOIN public.order_reserved_units r ON r.order_line_id = ol.id AND r.released_at IS NULL AND r.fulfilled_at IS NULL
      WHERE ol.order_id = p_order_id AND r.courier_confirmed_at IS NULL
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_courier_order_verification(uuid) TO authenticated, service_role;


-- 3. Upgrade create_pos_delivery with Auto-Fulfillment from Warehouse:
-- If any unit in the sale is from 'store' showroom, but this sale is for delivery,
-- check if an available warehouse unit exists for that product.
-- If yes, swap the sale_line to the warehouse unit and release the showroom display unit!
CREATE OR REPLACE FUNCTION public.create_pos_delivery(
  p_sale_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_delivery_address text,
  p_payment_type text DEFAULT 'cash',
  p_cod_amount numeric DEFAULT 0,
  p_notes text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sale public.sales%rowtype;
  v_items jsonb;
  v_delivery_no text;
  v_payment_status text;
  v_del_id uuid := gen_random_uuid();
  v_row public.pos_deliveries%rowtype;
  v_sl record;
  v_wh_unit record;
BEGIN
  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sotuv topilmadi: %', p_sale_id USING errcode = 'P0002';
  END IF;

  v_delivery_no := 'DOS-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_del_id::text, 1, 6));

  -- Auto-swap: If any sale unit is currently from a store location, check if warehouse has available stock.
  -- Swap it to warehouse so showroom display unit stays available in store.
  PERFORM set_config('texnobazar.manager_confirm_sale', 'allowed', true);

  FOR v_sl IN
    SELECT sl.id AS sale_line_id, sl.product_id, sl.unit_id, u.location_id, l.type AS location_type,
           coalesce(sb.unit_cost, p.cost_price) AS unit_cost
    FROM public.sale_lines sl
    JOIN public.inventory_units u ON u.id = sl.unit_id
    JOIN public.locations l ON l.id = u.location_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE sl.sale_id = v_sale.id AND l.type = 'store'
  LOOP
    -- Look for an available unit in warehouse of the same branch
    SELECT u.id, u.batch_id, u.location_id, coalesce(sb.unit_cost, p.cost_price) AS unit_cost
    INTO v_wh_unit
    FROM public.inventory_units u
    JOIN public.locations l ON l.id = u.location_id
    JOIN public.products p ON p.id = u.product_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE l.branch_id = v_sale.branch_id
      AND l.type = 'warehouse'
      AND l.is_active
      AND u.status = 'available'
      AND u.product_id = v_sl.product_id
    ORDER BY u.created_at ASC
    LIMIT 1;

    IF v_wh_unit.id IS NOT NULL THEN
      -- Free store display unit back to 'available'
      UPDATE public.inventory_units
      SET status = 'available', sold_sale_id = null, reserved_until = null, version = version + 1
      WHERE id = v_sl.unit_id;

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
        quantity, reference_type, reference_id, reason, actor_id
      ) VALUES (
        v_sl.unit_id, v_sl.product_id, null, 'returned', v_sl.location_id, v_sl.location_id,
        1, 'pos_delivery_auto_swap', v_del_id,
        'Dostavka ombordan chiqarilgani sababli do‘kondagi namuna bo‘shatildi', auth.uid()
      );

      -- Mark warehouse unit as 'sold'
      UPDATE public.inventory_units
      SET status = 'sold', sold_sale_id = v_sale.id, reserved_until = null, version = version + 1
      WHERE id = v_wh_unit.id;

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type, from_location_id,
        quantity, unit_cost, reference_type, reference_id, reason, actor_id
      ) VALUES (
        v_wh_unit.id, v_sl.product_id, v_wh_unit.batch_id, 'sold', v_wh_unit.location_id,
        1, v_wh_unit.unit_cost, 'pos_delivery_auto_swap', v_del_id,
        'Dostavka uchun ombordan chiqarildi', auth.uid()
      );

      -- Update sale_line to point to the warehouse unit
      UPDATE public.sale_lines
      SET unit_id = v_wh_unit.id,
          unit_cost = coalesce(v_wh_unit.unit_cost, unit_cost)
      WHERE id = v_sl.sale_line_id;
    END IF;
  END LOOP;

  PERFORM set_config('texnobazar.manager_confirm_sale', '', true);

  -- Gather items with batch numbers, QR codes, and product names (reflecting any swapped warehouse units!)
  SELECT jsonb_agg(jsonb_build_object(
    'product_id', sl.product_id,
    'product_name', p.name,
    'sku', p.sku,
    'quantity', sl.quantity,
    'unit_price', sl.unit_price,
    'line_total', sl.line_total,
    'qr_code', u.qr_code,
    'serial_number', u.serial_number,
    'location_name', coalesce(l.name, 'Ombor'),
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

  IF lower(p_payment_type) = 'cod' OR p_cod_amount > 0 THEN
    v_payment_status := 'pending_courier';
  ELSE
    v_payment_status := 'paid';
  END IF;

  INSERT INTO public.pos_deliveries (
    id, branch_id, sale_id, pending_sale_id, delivery_no,
    customer_name, customer_phone, delivery_address,
    items, total_amount, payment_type, payment_status,
    delivery_status, cod_amount, notes, created_at, updated_at
  ) VALUES (
    v_del_id, v_sale.branch_id, v_sale.id, v_sale.pending_sale_id, v_delivery_no,
    trim(p_customer_name), trim(p_customer_phone), trim(p_delivery_address),
    coalesce(v_items, '[]'::jsonb), v_sale.total, lower(p_payment_type), v_payment_status,
    'pending', coalesce(p_cod_amount, 0), nullif(trim(p_notes), ''), now(), now()
  )
  RETURNING * INTO v_row;

  -- Also update customer record if phone is provided
  IF trim(p_customer_phone) <> '' THEN
    UPDATE public.customers
    SET full_name = coalesce(nullif(trim(p_customer_name), ''), full_name),
        address = jsonb_build_object('address', trim(p_delivery_address)),
        updated_at = now()
    WHERE phone = trim(p_customer_phone);
  END IF;

  RETURN to_jsonb(v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_pos_delivery(uuid, text, text, text, text, numeric, text) TO authenticated, service_role;


-- 4. RPC to manually swap a unit in POS delivery (e.g., manager or courier scans warehouse unit)
CREATE OR REPLACE FUNCTION public.pos_delivery_swap_unit(
  p_delivery_id uuid,
  p_old_qr text,
  p_new_qr text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
  v_old_line record;
  v_new_unit record;
  v_old_code text := nullif(btrim(p_old_qr), '');
  v_new_code text := nullif(btrim(p_new_qr), '');
  v_updated_items jsonb;
BEGIN
  IF v_old_code IS NULL OR v_new_code IS NULL THEN
    RAISE EXCEPTION 'Eski va yangi QR kodlar talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka yozuvi topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager','courier']::public.app_role[], v_del.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Find the sale line matching the old unit
  SELECT sl.id AS sale_line_id, sl.product_id, sl.unit_id, u.location_id, u.qr_code, u.serial_number
  INTO v_old_line
  FROM public.sale_lines sl
  JOIN public.inventory_units u ON u.id = sl.unit_id
  WHERE sl.sale_id = v_del.sale_id
    AND (upper(u.qr_code) = upper(v_old_code) OR upper(coalesce(u.serial_number, '')) = upper(v_old_code))
  LIMIT 1;

  IF v_old_line.sale_line_id IS NULL THEN
    RAISE EXCEPTION 'Ushbu dostavkada "%" kodli tovar topilmadi', v_old_code USING errcode = 'P0002';
  END IF;

  -- Find the new unit
  SELECT u.id, u.product_id, u.batch_id, u.status, u.location_id, u.qr_code, u.serial_number,
         l.branch_id, l.name AS location_name, l.type AS location_type,
         p.name AS product_name, p.sku,
         coalesce(sb.unit_cost, p.cost_price) AS unit_cost,
         coalesce(sb.reference, 'PRT-' || substr(coalesce(u.batch_id::text, '00000000'), 1, 8)) AS batch_code
  INTO v_new_unit
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  WHERE (upper(u.qr_code) = upper(v_new_code) OR upper(coalesce(u.serial_number, '')) = upper(v_new_code))
  LIMIT 1;

  IF v_new_unit.id IS NULL THEN
    RAISE EXCEPTION 'Yangi QR kod bo‘yicha tovar topilmadi: %', v_new_code USING errcode = 'P0002';
  END IF;

  IF v_new_unit.branch_id <> v_del.branch_id THEN
    RAISE EXCEPTION 'Yangi tovar boshqa filialga tegishli' USING errcode = 'P0001';
  END IF;

  IF v_new_unit.product_id <> v_old_line.product_id THEN
    RAISE EXCEPTION 'Yangi tovar mahsulot turiga to‘g‘ri kelmaydi' USING errcode = 'P0001';
  END IF;

  IF v_new_unit.status <> 'available' THEN
    RAISE EXCEPTION 'Yangi tovar hozir bo‘sh (available) emas: holati "%"', v_new_unit.status USING errcode = 'P0001';
  END IF;

  PERFORM set_config('texnobazar.manager_confirm_sale', 'allowed', true);

  -- 1) Free old unit
  UPDATE public.inventory_units
  SET status = 'available', sold_sale_id = null, reserved_until = null, version = version + 1
  WHERE id = v_old_line.unit_id;

  INSERT INTO public.inventory_movements(
    unit_id, product_id, movement_type, from_location_id, to_location_id,
    quantity, reference_type, reference_id, reason, actor_id
  ) VALUES (
    v_old_line.unit_id, v_old_line.product_id, 'returned', v_old_line.location_id, v_old_line.location_id,
    1, 'pos_delivery_manual_swap', v_del.id,
    'Dostavka uchun ombor tovari bilan almashtirildi', auth.uid()
  );

  -- 2) Mark new unit as sold
  UPDATE public.inventory_units
  SET status = 'sold', sold_sale_id = v_del.sale_id, reserved_until = null, version = version + 1
  WHERE id = v_new_unit.id;

  INSERT INTO public.inventory_movements(
    unit_id, product_id, batch_id, movement_type, from_location_id,
    quantity, unit_cost, reference_type, reference_id, reason, actor_id
  ) VALUES (
    v_new_unit.id, v_new_unit.product_id, v_new_unit.batch_id, 'sold', v_new_unit.location_id,
    1, v_new_unit.unit_cost, 'pos_delivery_manual_swap', v_del.id,
    'Dostavka uchun ombordan chiqarildi', auth.uid()
  );

  -- 3) Update sale line
  UPDATE public.sale_lines
  SET unit_id = v_new_unit.id,
      unit_cost = coalesce(v_new_unit.unit_cost, unit_cost)
  WHERE id = v_old_line.sale_line_id;

  PERFORM set_config('texnobazar.manager_confirm_sale', '', true);

  -- 4) Update pos_deliveries items JSON
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN upper(item->>'qr_code') = upper(v_old_line.qr_code) OR upper(coalesce(item->>'serial_number','')) = upper(coalesce(v_old_line.serial_number,'')) THEN
        jsonb_build_object(
          'product_id', v_new_unit.product_id,
          'product_name', v_new_unit.product_name,
          'sku', v_new_unit.sku,
          'quantity', coalesce((item->>'quantity')::integer, 1),
          'unit_price', (item->>'unit_price')::numeric,
          'line_total', (item->>'line_total')::numeric,
          'qr_code', v_new_unit.qr_code,
          'serial_number', v_new_unit.serial_number,
          'location_name', coalesce(v_new_unit.location_name, 'Ombor'),
          'location_type', v_new_unit.location_type,
          'batch_code', v_new_unit.batch_code,
          'selected_components', coalesce(item->'selected_components', '[]'::jsonb)
        )
      ELSE item
    END
  ), '[]'::jsonb)
  INTO v_updated_items
  FROM jsonb_array_elements(v_del.items) item;

  UPDATE public.pos_deliveries
  SET items = v_updated_items,
      updated_at = now()
  WHERE id = p_delivery_id;

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'old_qr', v_old_line.qr_code,
    'new_qr', v_new_unit.qr_code,
    'batch_code', v_new_unit.batch_code,
    'product_name', v_new_unit.product_name,
    'location_name', v_new_unit.location_name,
    'message', 'Dostavka tovari muvaffaqiyatli ombor birligiga almashtirildi'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_delivery_swap_unit(uuid, text, text) TO authenticated, service_role;


-- 5. Upgrade get_pos_batch_units to support p_prefer_location ('warehouse' or 'store')
CREATE OR REPLACE FUNCTION public.get_pos_batch_units(
  p_branch_id uuid,
  p_code text,
  p_count integer DEFAULT 1,
  p_exclude_ids uuid[] DEFAULT '{}'::uuid[],
  p_prefer_location text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  qr_code text,
  serial_number text,
  location_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_product_id uuid;
  v_variant_id uuid;
  v_exclude uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  v_limit integer := greatest(1, least(50, coalesce(p_count, 1)));
  v_prefer text := lower(coalesce(nullif(btrim(p_prefer_location), ''), 'store'));
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Kod talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT u.product_id, u.variant_id INTO v_product_id, v_variant_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE l.branch_id = p_branch_id
    AND (
      upper(u.qr_code) = upper(v_code)
      OR upper(coalesce(u.serial_number, '')) = upper(v_code)
    )
  LIMIT 1;

  IF v_product_id IS NULL THEN
    SELECT p.id INTO v_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.qr_code,
    u.serial_number,
    l.type::text AS location_type
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  WHERE l.branch_id = p_branch_id
    AND l.is_active
    AND l.type IN ('store', 'warehouse')
    AND u.status = 'available'
    AND u.active_transfer_id IS NULL
    AND p.status = 'active'
    AND u.product_id = v_product_id
    AND (v_variant_id IS NULL OR u.variant_id = v_variant_id OR upper(u.qr_code) = upper(v_code))
    AND NOT (u.id = ANY(v_exclude))
  ORDER BY
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    -- Prefer requested location (warehouse or store)
    CASE
      WHEN v_prefer = 'warehouse' THEN (CASE WHEN l.type = 'warehouse' THEN 0 ELSE 1 END)
      ELSE (CASE WHEN l.type = 'store' THEN 0 ELSE 1 END)
    END,
    u.created_at ASC,
    u.id ASC
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_batch_units(uuid, text, integer, uuid[], text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
