-- Migration: Bidirectional Store and Warehouse Delivery Fulfillment
-- Allows deliveries to originate from either the Warehouse OR the Store Showroom.
-- 
-- 1. Adds fulfillment_source column to pos_deliveries ('warehouse', 'store', or 'custom').
-- 2. Upgrades create_pos_delivery with p_fulfillment_source ('warehouse', 'store', 'keep'):
--    - 'warehouse': auto-swaps sold store units to warehouse units (freeing showroom display).
--    - 'store': keeps or swaps units to store showroom (store fulfills the delivery).
--    - 'keep': keeps whatever units were selected at POS sale checkout.
-- 3. Upgrades courier_verify_order_unit with true bidirectional smart swap:
--    - Supports scanning warehouse boxes (freeing store display) OR scanning store boxes (freeing warehouse stock).
--    - Provides accurate contextual messages depending on whether courier picks from store or warehouse.
-- 4. Upgrades get_courier_order_verification with exact pickup location badges.

BEGIN;

-- 1. Add fulfillment_source to pos_deliveries table
ALTER TABLE public.pos_deliveries
ADD COLUMN IF NOT EXISTS fulfillment_source text NOT NULL DEFAULT 'warehouse';

-- 2. Upgrade create_pos_delivery
CREATE OR REPLACE FUNCTION public.create_pos_delivery(
  p_sale_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_delivery_address text,
  p_payment_type text DEFAULT 'cash',
  p_cod_amount numeric DEFAULT 0,
  p_notes text DEFAULT null,
  p_fulfillment_source text DEFAULT 'warehouse'
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
  v_source text := lower(coalesce(nullif(btrim(p_fulfillment_source), ''), 'warehouse'));
  v_sl record;
  v_swap_unit record;
BEGIN
  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sotuv topilmadi: %', p_sale_id USING errcode = 'P0002';
  END IF;

  v_delivery_no := 'DOS-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_del_id::text, 1, 6));

  PERFORM set_config('texnobazar.manager_confirm_sale', 'allowed', true);

  -- CASE A: Cashier chose 'warehouse' fulfillment (courier dispatches from warehouse)
  -- Auto-swap any store showroom units to available warehouse units
  IF v_source = 'warehouse' THEN
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
      SELECT u.id, u.batch_id, u.location_id, coalesce(sb.unit_cost, p.cost_price) AS unit_cost
      INTO v_swap_unit
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

      IF v_swap_unit.id IS NOT NULL THEN
        -- Free store showroom unit back to available
        UPDATE public.inventory_units
        SET status = 'available', sold_sale_id = null, reserved_until = null, version = version + 1
        WHERE id = v_sl.unit_id;

        INSERT INTO public.inventory_movements(
          unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
          quantity, reference_type, reference_id, reason, actor_id
        ) VALUES (
          v_sl.unit_id, v_sl.product_id, null, 'returned', v_sl.location_id, v_sl.location_id,
          1, 'pos_delivery_auto_swap', v_del_id,
          'Dostavka ombordan chiqarilgani sababli do‘kondagi vitrina tovari bo‘shatildi', auth.uid()
        );

        -- Mark warehouse unit as sold
        UPDATE public.inventory_units
        SET status = 'sold', sold_sale_id = v_sale.id, reserved_until = null, version = version + 1
        WHERE id = v_swap_unit.id;

        INSERT INTO public.inventory_movements(
          unit_id, product_id, batch_id, movement_type, from_location_id,
          quantity, unit_cost, reference_type, reference_id, reason, actor_id
        ) VALUES (
          v_swap_unit.id, v_sl.product_id, v_swap_unit.batch_id, 'sold', v_swap_unit.location_id,
          1, v_swap_unit.unit_cost, 'pos_delivery_auto_swap', v_del_id,
          'Dostavka uchun ombordan chiqarildi', auth.uid()
        );

        -- Update sale_line
        UPDATE public.sale_lines
        SET unit_id = v_swap_unit.id,
            unit_cost = coalesce(v_swap_unit.unit_cost, unit_cost)
        WHERE id = v_sl.sale_line_id;
      END IF;
    END LOOP;

  -- CASE B: Cashier explicitly chose 'store' fulfillment (courier delivers goods directly from store)
  -- Auto-swap any warehouse units to available store units (if cashier sold a warehouse unit by mistake)
  ELSIF v_source = 'store' THEN
    FOR v_sl IN
      SELECT sl.id AS sale_line_id, sl.product_id, sl.unit_id, u.location_id, l.type AS location_type,
             coalesce(sb.unit_cost, p.cost_price) AS unit_cost
      FROM public.sale_lines sl
      JOIN public.inventory_units u ON u.id = sl.unit_id
      JOIN public.locations l ON l.id = u.location_id
      JOIN public.products p ON p.id = sl.product_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      WHERE sl.sale_id = v_sale.id AND l.type = 'warehouse'
    LOOP
      SELECT u.id, u.batch_id, u.location_id, coalesce(sb.unit_cost, p.cost_price) AS unit_cost
      INTO v_swap_unit
      FROM public.inventory_units u
      JOIN public.locations l ON l.id = u.location_id
      JOIN public.products p ON p.id = u.product_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      WHERE l.branch_id = v_sale.branch_id
        AND l.type = 'store'
        AND l.is_active
        AND u.status = 'available'
        AND u.product_id = v_sl.product_id
      ORDER BY u.created_at ASC
      LIMIT 1;

      IF v_swap_unit.id IS NOT NULL THEN
        -- Free warehouse unit back to available
        UPDATE public.inventory_units
        SET status = 'available', sold_sale_id = null, reserved_until = null, version = version + 1
        WHERE id = v_sl.unit_id;

        INSERT INTO public.inventory_movements(
          unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
          quantity, reference_type, reference_id, reason, actor_id
        ) VALUES (
          v_sl.unit_id, v_sl.product_id, null, 'returned', v_sl.location_id, v_sl.location_id,
          1, 'pos_delivery_auto_swap', v_del_id,
          'Dostavka do‘kondan qilingani sababli ombordagi tovar bo‘shatildi', auth.uid()
        );

        -- Mark store unit as sold
        UPDATE public.inventory_units
        SET status = 'sold', sold_sale_id = v_sale.id, reserved_until = null, version = version + 1
        WHERE id = v_swap_unit.id;

        INSERT INTO public.inventory_movements(
          unit_id, product_id, batch_id, movement_type, from_location_id,
          quantity, unit_cost, reference_type, reference_id, reason, actor_id
        ) VALUES (
          v_swap_unit.id, v_sl.product_id, v_swap_unit.batch_id, 'sold', v_swap_unit.location_id,
          1, v_swap_unit.unit_cost, 'pos_delivery_auto_swap', v_del_id,
          'Dostavka uchun do‘kondan chiqarildi', auth.uid()
        );

        -- Update sale_line
        UPDATE public.sale_lines
        SET unit_id = v_swap_unit.id,
            unit_cost = coalesce(v_swap_unit.unit_cost, unit_cost)
        WHERE id = v_sl.sale_line_id;
      END IF;
    END LOOP;
  END IF;
  -- If v_source = 'keep', nothing is swapped; units stay exactly as recorded in sale_lines.

  PERFORM set_config('texnobazar.manager_confirm_sale', '', true);

  -- Gather items with batch numbers, QR codes, and product names (reflecting actual dispatch location!)
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

  IF lower(p_payment_type) = 'cod' OR p_cod_amount > 0 THEN
    v_payment_status := 'pending_courier';
  ELSE
    v_payment_status := 'paid';
  END IF;

  INSERT INTO public.pos_deliveries (
    id, branch_id, sale_id, pending_sale_id, delivery_no,
    customer_name, customer_phone, delivery_address,
    items, total_amount, payment_type, payment_status,
    delivery_status, cod_amount, notes, fulfillment_source, created_at, updated_at
  ) VALUES (
    v_del_id, v_sale.branch_id, v_sale.id, v_sale.pending_sale_id, v_delivery_no,
    trim(p_customer_name), trim(p_customer_phone), trim(p_delivery_address),
    coalesce(v_items, '[]'::jsonb), v_sale.total, lower(p_payment_type), v_payment_status,
    'pending', coalesce(p_cod_amount, 0), nullif(trim(p_notes), ''), v_source, now(), now()
  )
  RETURNING * INTO v_row;

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

-- Drop old 7-argument version if exists to avoid ambiguity
DROP FUNCTION IF EXISTS public.create_pos_delivery(uuid, text, text, text, text, numeric, text);

GRANT EXECUTE ON FUNCTION public.create_pos_delivery(uuid, text, text, text, text, numeric, text, text) TO authenticated, service_role;


-- 3. Upgrade courier_verify_order_unit with Full Bidirectional Support:
-- Courier can pick up from WAREHOUSE or STORE.
-- If courier scans a warehouse unit -> confirms warehouse unit (releasing showroom if was store).
-- If courier scans a store unit -> confirms store unit (releasing warehouse if was warehouse).
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
  v_message text;
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

  -- 1) Direct Match: Did courier scan the exact unit currently reserved?
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
        'location_name', coalesce(v_match.location_name, CASE WHEN v_match.location_type = 'store' THEN 'Do‘kon' ELSE 'Ombor' END),
        'location_type', v_match.location_type,
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
      'location_name', coalesce(v_match.location_name, CASE WHEN v_match.location_type = 'store' THEN 'Do‘kon' ELSE 'Ombor' END),
      'location_type', v_match.location_type,
      'confirmed_count', v_confirmed,
      'total_count', v_total,
      'all_confirmed', (v_total > 0 AND v_total = v_confirmed),
      'message', 'Mahsulot tasdiqlandi (' || CASE WHEN v_match.location_type = 'store' THEN 'Do‘kondan' ELSE 'Ombordan' END || ')'
    );
  END IF;

  -- 2) Bidirectional Smart Swap: Courier scanned a different available unit of the same product
  -- (could be a warehouse unit replacing a showroom unit, OR a showroom unit replacing a warehouse unit!)
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

  -- Find an unconfirmed reserved unit in this order for this product.
  -- Preference:
  -- If courier scanned a WAREHOUSE unit -> prefer swapping out a STORE showroom unit.
  -- If courier scanned a STORE unit -> prefer swapping out a WAREHOUSE unit.
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
    CASE
      WHEN v_scanned_unit.location_type = 'warehouse' THEN (CASE WHEN old_l.type = 'store' THEN 0 ELSE 1 END)
      ELSE (CASE WHEN old_l.type = 'warehouse' THEN 0 ELSE 1 END)
    END,
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
  -- A) Free old unit back to available
  UPDATE public.inventory_units
  SET status = 'available', reserved_until = null, version = version + 1
  WHERE id = v_target_res.old_unit_id;

  INSERT INTO public.inventory_movements(
    unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, reference_type, reference_id, reason, actor_id
  )
  SELECT v_target_res.old_unit_id, v_target_res.product_id, batch_id, 'reservation_released',
         location_id, location_id, 1, 'online_order', p_order_id,
         CASE
           WHEN v_scanned_unit.location_type = 'store' THEN 'Kuryer do‘kondan olgani sababli ombordagi tovar bo‘shatildi'
           ELSE 'Kuryer ombordan yangi birlikni olgani sababli do‘kondagi namuna bo‘shatildi'
         END, auth.uid()
  FROM public.inventory_units WHERE id = v_target_res.old_unit_id
  ON CONFLICT DO NOTHING;

  -- B) Reserve the newly scanned unit
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
    CASE
      WHEN v_scanned_unit.location_type = 'store' THEN 'Kuryer do‘kondan yetkazish uchun skanerlab biriktirdi'
      ELSE 'Kuryer ombordan yetkazish uchun skanerlab biriktirdi'
    END, auth.uid()
  )
  ON CONFLICT DO NOTHING;

  -- C) Update reservation record
  UPDATE public.order_reserved_units
  SET unit_id = v_scanned_unit.id,
      courier_confirmed_at = now(),
      courier_confirmed_by = auth.uid()
  WHERE id = v_target_res.reservation_id;

  -- D) Calculate totals
  SELECT count(*), count(*) FILTER (WHERE courier_confirmed_at IS NOT NULL)
  INTO v_total, v_confirmed
  FROM public.order_reserved_units
  WHERE order_id = p_order_id AND released_at IS NULL AND fulfilled_at IS NULL;

  v_all_confirmed := (v_total > 0 AND v_total = v_confirmed);

  -- E) Build contextual message
  IF v_scanned_unit.location_type = 'store' THEN
    v_message := 'Do‘kondagi tovar (' || coalesce(v_scanned_unit.location_name, 'Do‘kon') || ') tasdiqlandi';
    IF v_target_res.old_location_type = 'warehouse' THEN
      v_message := v_message || ' (ombordagi tovar bo‘shatildi)';
    END IF;
  ELSE
    v_message := 'Ombordagi tovar (' || coalesce(v_scanned_unit.location_name, 'Ombor') || ') tasdiqlandi';
    IF v_target_res.old_location_type = 'store' THEN
      v_message := v_message || ' (do‘kondagi namuna bo‘shatildi)';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'matched', true,
    'swapped', true,
    'product_name', v_scanned_unit.product_name,
    'qr_code', v_scanned_unit.qr_code,
    'old_qr_code', v_target_res.old_qr_code,
    'location_name', coalesce(v_scanned_unit.location_name, CASE WHEN v_scanned_unit.location_type = 'store' THEN 'Do‘kon' ELSE 'Ombor' END),
    'location_type', v_scanned_unit.location_type,
    'confirmed_count', v_confirmed,
    'total_count', v_total,
    'all_confirmed', v_all_confirmed,
    'message', v_message
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_verify_order_unit(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
