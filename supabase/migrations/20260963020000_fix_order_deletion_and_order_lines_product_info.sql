-- Fix order deletion trigger blocking and enrich order lines with product info (slug, image, variant_color)

-- 1. guard_receipt_delivery_outbox: allow DELETE when admin_override is set
CREATE OR REPLACE FUNCTION public.guard_receipt_delivery_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('texnobazar.admin_override', true) = 'allowed' THEN
    IF tg_op = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'Elektron chek outbox yozuvi o‘chirilmaydi' USING errcode = '55000';
  END IF;

  IF old.id IS DISTINCT FROM new.id OR old.sale_id IS DISTINCT FROM new.sale_id OR old.order_id IS DISTINCT FROM new.order_id
    OR old.channel IS DISTINCT FROM new.channel OR old.recipient_email IS DISTINCT FROM new.recipient_email
    OR old.receipt_payload IS DISTINCT FROM new.receipt_payload OR old.idempotency_key IS DISTINCT FROM new.idempotency_key
    OR old.request_hash IS DISTINCT FROM new.request_hash OR old.requested_by IS DISTINCT FROM new.requested_by
    OR old.requested_at IS DISTINCT FROM new.requested_at THEN
    RAISE EXCEPTION 'Elektron chek snapshoti o‘zgarmas' USING errcode = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- 2. guard_payment_transaction_update: allow DELETE when admin_override is set
CREATE OR REPLACE FUNCTION public.guard_payment_transaction_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('texnobazar.admin_override', true) = 'allowed' THEN
    IF tg_op = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF tg_op = 'DELETE' OR current_setting('texnobazar.payment_gateway', true) IS DISTINCT FROM 'allowed'
    OR old.id IS DISTINCT FROM new.id OR old.merchant_sequence IS DISTINCT FROM new.merchant_sequence
    OR old.order_id IS DISTINCT FROM new.order_id OR old.provider IS DISTINCT FROM new.provider
    OR old.amount_minor IS DISTINCT FROM new.amount_minor OR old.currency IS DISTINCT FROM new.currency
    OR old.idempotency_key IS DISTINCT FROM new.idempotency_key OR old.request_hash IS DISTINCT FROM new.request_hash
    OR old.created_at IS DISTINCT FROM new.created_at
    OR (old.provider_transaction_id IS NOT NULL AND old.provider_transaction_id IS DISTINCT FROM new.provider_transaction_id)
    OR (old.provider_payment_id IS NOT NULL AND old.provider_payment_id IS DISTINCT FROM new.provider_payment_id)
    OR (old.provider_prepare_id IS NOT NULL AND old.provider_prepare_id IS DISTINCT FROM new.provider_prepare_id)
    OR (old.sale_payment_id IS NOT NULL AND old.sale_payment_id IS DISTINCT FROM new.sale_payment_id)
    OR NOT((old.state = 'initiated' AND new.state IN ('initiated', 'prepared', 'paid', 'cancelled', 'failed', 'ambiguous'))
      OR (old.state = 'prepared' AND new.state IN ('prepared', 'paid', 'cancelled', 'failed', 'ambiguous'))
      OR (old.state = 'ambiguous' AND new.state IN ('ambiguous', 'prepared', 'paid', 'cancelled', 'failed'))
      OR (old.state = 'paid' AND new.state IN ('paid', 'cancelled_after_paid', 'refunded'))
      OR (old.state = 'cancelled_after_paid' AND new.state IN ('cancelled_after_paid', 'refunded'))
      OR old.state = new.state) THEN
    RAISE EXCEPTION 'Payment transaction mutatsiyasi taqiqlangan' USING errcode = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. guard_order_reserved_unit: allow DELETE when admin_override is set
CREATE OR REPLACE FUNCTION public.guard_order_reserved_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('texnobazar.admin_override', true) = 'allowed' THEN
    IF tg_op = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF tg_op = 'DELETE' OR old.order_id IS DISTINCT FROM new.order_id OR old.order_line_id IS DISTINCT FROM new.order_line_id
    OR old.unit_id IS DISTINCT FROM new.unit_id OR old.reserved_by IS DISTINCT FROM new.reserved_by
    OR old.reserved_at IS DISTINCT FROM new.reserved_at OR old.created_at IS DISTINCT FROM new.created_at
    OR (old.released_at IS NOT NULL AND (new.released_at IS DISTINCT FROM old.released_at OR new.released_by IS DISTINCT FROM old.released_by))
    OR (old.fulfilled_at IS NOT NULL AND new.fulfilled_at IS DISTINCT FROM old.fulfilled_at)
    OR (new.released_at IS NOT NULL AND new.fulfilled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Order rezerv ledgeri o‘zgarmas' USING errcode = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- 4. reject_mutation: allow DELETE when admin_override is set
CREATE OR REPLACE FUNCTION public.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('texnobazar.admin_override', true) = 'allowed' THEN
    IF tg_op = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is immutable', tg_table_name USING errcode = '55000';
END;
$$;

-- 5. delete_online_order: robust deletion with admin override
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
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator buyurtmalarni o‘chira oladi.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyurtma topilmadi.' USING errcode = 'P0002';
  END IF;

  -- Set session overrides so trigger guards allow deleting test / legacy order records
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);
  PERFORM set_config('texnobazar.payment_gateway', 'allowed', true);

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
    -- If there were reserved units held, unlock them to available
    UPDATE public.inventory_units
    SET status = 'available', reserved_until = NULL, version = version + 1
    WHERE id IN (
      SELECT unit_id FROM public.order_reserved_units WHERE order_id = p_order_id
    ) AND status = 'reserved';
  END IF;

  -- 3. Delete dependent order records in safe order
  DELETE FROM public.receipt_delivery_outbox WHERE order_id = p_order_id;
  DELETE FROM public.payment_transactions WHERE order_id = p_order_id;
  DELETE FROM public.courier_cash_handovers WHERE order_id = p_order_id OR delivery_id IN (SELECT id FROM public.deliveries WHERE order_id = p_order_id);
  DELETE FROM public.delivery_attempts WHERE delivery_id IN (SELECT id FROM public.deliveries WHERE order_id = p_order_id) OR order_id = p_order_id;
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

-- 6. list_admin_orders: enrich order_lines with product slug, image, color variant
CREATE OR REPLACE FUNCTION public.list_admin_orders(
  p_branch_id uuid DEFAULT NULL::uuid,
  p_status text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare v_items jsonb; v_total bigint;
begin
  if not public.current_user_active() or not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Global administrator roli talab qilinadi' using errcode='42501';
  end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi noto‘g‘ri' using errcode='22023';
  end if;
  select count(*) into v_total from public.orders o where (p_branch_id is null or o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
    and (nullif(p_status,'') is null or o.status::text=p_status)
    and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.placed_at desc,q.id),'[]'::jsonb) into v_items from(
    select o.id,o.order_no,o.branch_id,b.code branch_code,b.name branch_name,o.status,o.customer_name,o.customer_phone,o.shipping_address,o.notes,
      o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_status,o.placed_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', l.id,
          'product_id', l.product_id,
          'product_name', coalesce(l.product_name, p.name, 'Noma''lum tovar'),
          'sku', coalesce(l.sku, p.sku, '-'),
          'slug', p.slug,
          'variant_color', l.variant_color,
          'image', coalesce(p.seo_image_url, (select pm.public_url from public.product_media pm where pm.product_id = p.id order by pm.is_primary desc, pm.created_at asc limit 1)),
          'quantity', l.quantity,
          'unit_price', l.unit_price,
          'discount', l.discount,
          'line_total', l.line_total
        ) order by l.id)
        from public.order_lines l
        left join public.products p on p.id = l.product_id
        where l.order_id = o.id
      ),'[]'::jsonb) order_lines,
      (select jsonb_build_object('id',d.id,'courier_id',d.courier_id,'status',d.status,'tracking_code',d.tracking_code,
        'assigned_at',d.assigned_at,'picked_up_at',d.picked_up_at,'delivered_at',d.delivered_at,'proof_url',d.proof_url)
        from public.deliveries d where d.order_id=o.id) delivery
    from public.orders o left join public.branches b on b.id=o.branch_id
    where (p_branch_id is null or o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
      and (nullif(p_status,'') is null or o.status::text=p_status)
      and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%')
    order by o.placed_at desc,o.id limit p_limit offset p_offset
  )q;
  return jsonb_build_object('items',v_items,'total',v_total);
end;
$$;

-- 7. list_manager_orders: enrich order_lines with product slug, image, color variant
CREATE OR REPLACE FUNCTION public.list_manager_orders(
  p_branch_id uuid,
  p_status text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare v_items jsonb; v_total bigint;
begin
  if p_branch_id is null or not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501';
  end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto''g''ri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi noto''g''ri' using errcode='22023';
  end if;
  select count(*) into v_total from public.orders o where (o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
    and (nullif(p_status,'') is null or o.status::text=p_status)
    and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.placed_at desc,q.id),'[]'::jsonb) into v_items from(
    select o.id,o.order_no,o.branch_id,o.status,o.customer_name,o.customer_phone,o.shipping_address,o.notes,
      o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_status,o.placed_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', l.id,
          'product_id', l.product_id,
          'product_name', coalesce(l.product_name, p.name, 'Noma''lum tovar'),
          'sku', coalesce(l.sku, p.sku, '-'),
          'slug', p.slug,
          'variant_color', l.variant_color,
          'image', coalesce(p.seo_image_url, (select pm.public_url from public.product_media pm where pm.product_id = p.id order by pm.is_primary desc, pm.created_at asc limit 1)),
          'quantity', l.quantity,
          'unit_price', l.unit_price,
          'discount', l.discount,
          'line_total', l.line_total
        ) order by l.id)
        from public.order_lines l
        left join public.products p on p.id = l.product_id
        where l.order_id = o.id
      ),'[]'::jsonb) order_lines,
      (select jsonb_build_object('id',d.id,'courier_id',d.courier_id,'status',d.status,'tracking_code',d.tracking_code,
        'assigned_at',d.assigned_at,'picked_up_at',d.picked_up_at,'delivered_at',d.delivered_at)
        from public.deliveries d where d.order_id=o.id) delivery
    from public.orders o where (o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
      and (nullif(p_status,'') is null or o.status::text=p_status)
      and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%')
    order by o.placed_at desc,o.id limit p_limit offset p_offset
  )q;
  return jsonb_build_object('items',v_items,'total',v_total);
end;
$$;
