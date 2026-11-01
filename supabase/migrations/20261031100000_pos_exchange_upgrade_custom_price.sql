-- 2-Opsiya almashtirishda yangi berilayotgan tovarga seller tomonidan kiritilgan sotish narxini qo'llash
-- VA qaytarilayotgan tovarni do'kon balansiga (+1 dona) to'liq kirim qilish, yangi tovarni esa hisobdan chiqarish
BEGIN;

DROP FUNCTION IF EXISTS public.create_pos_exchange_upgrade(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.create_pos_exchange_upgrade(uuid, uuid, uuid, text, text, numeric);

CREATE OR REPLACE FUNCTION public.create_pos_exchange_upgrade(
  p_branch_id uuid,
  p_returned_unit_id uuid,
  p_new_unit_id uuid,
  p_reason text DEFAULT '2-opsiya: Boshqa / analog tovarga almashtirish',
  p_refund_method text DEFAULT 'cash',
  p_custom_price numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_u public.inventory_units%rowtype;
  v_new_u public.inventory_units%rowtype;
  v_line public.sale_lines%rowtype;
  v_sale public.sales%rowtype;
  v_new_prod public.products%rowtype;
  v_returned_price numeric(18,2);
  v_new_price numeric(18,2);
  v_diff numeric(18,2);
  v_refund_diff numeric(18,2);
  v_pending_id uuid := gen_random_uuid();
  v_pending_no text;
  v_pending_row public.pos_pending_sales%rowtype;
  v_dest uuid;
  v_pay_method text;
  v_pay_label text;
  v_ret_id uuid := gen_random_uuid();
  v_ret_no text;
BEGIN
  IF p_branch_id IS NULL OR p_returned_unit_id IS NULL OR p_new_unit_id IS NULL THEN
    RAISE EXCEPTION 'Filial, qaytarilayotgan tovar va yangi tovar talab qilinadi' USING errcode = '22023';
  END IF;
  PERFORM public.require_pos_seller(p_branch_id);

  SELECT * INTO v_u FROM public.inventory_units WHERE id = p_returned_unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Qaytariladigan birlik topilmadi' USING errcode = 'P0002'; END IF;

  SELECT sl.* INTO v_line FROM public.sale_lines sl
  JOIN public.sales s ON s.id = sl.sale_id
  WHERE sl.unit_id = v_u.id
  ORDER BY s.sold_at DESC, sl.created_at DESC LIMIT 1;

  IF NOT FOUND THEN RAISE EXCEPTION 'Sotuv tarixi topilmadi' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_sale FROM public.sales WHERE id = v_line.sale_id;

  IF v_sale.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'Bu birlik boshqa filialda sotilgan' USING errcode = 'P0001';
  END IF;
  IF v_sale.sold_at < (now() - interval '30 days') THEN
    RAISE EXCEPTION 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (30 kunlik muddat tugagan)' USING errcode = '22023';
  END IF;
  IF v_u.status <> 'sold' OR v_u.sold_sale_id IS DISTINCT FROM v_sale.id THEN
    RAISE EXCEPTION 'Birlik sotilgan holatda emas (holat: %)', v_u.status::text USING errcode = 'P0001';
  END IF;

  -- Yangi tanlangan tovar
  SELECT * INTO v_new_u FROM public.inventory_units WHERE id = p_new_unit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Almashtiriladigan yangi tovar birligi topilmadi' USING errcode = 'P0002'; END IF;
  IF v_new_u.status <> 'available' THEN
    RAISE EXCEPTION 'Yangi birlik erkin sotuvda emas (holat: %)', v_new_u.status::text USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_new_prod FROM public.products WHERE id = v_new_u.product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Yangi tovar mahsulot yozuvi topilmadi' USING errcode = 'P0002'; END IF;

  v_returned_price := round(v_line.line_total, 2);

  -- Seller tomonidan kiritilgan maxsus sotish narxi (agar kiritilgan bo'lsa)
  IF p_custom_price IS NOT NULL THEN
    IF p_custom_price <= 0 THEN
      RAISE EXCEPTION 'Yangi tovar sotish narxi musbat bo‘lishi shart' USING errcode = '22023';
    END IF;
    v_new_price := round(p_custom_price, 2);
  ELSE
    v_new_price := round(v_new_prod.retail_price, 2);
  END IF;

  v_diff := v_new_price - v_returned_price;
  v_ret_no := 'RET-EX-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(v_ret_id::text, 1, 6));

  -- Resell joylashuv (do'kon zaxirasi)
  SELECT id INTO v_dest FROM public.locations
  WHERE branch_id = p_branch_id AND is_active AND type = 'store'
  ORDER BY name LIMIT 1;
  IF v_dest IS NULL THEN
    SELECT id INTO v_dest FROM public.locations
    WHERE branch_id = p_branch_id AND is_active
    ORDER BY name LIMIT 1;
  END IF;
  IF v_dest IS NULL THEN
    v_dest := v_u.location_id;
  END IF;

  -- 1) NARX TENG BO'LSA (0 so'm farq): darhol to'g'ridan-to'g'ri almashtirish!
  IF v_diff = 0 THEN
    -- A) Qaytarilgan tovar do'kon balansiga qaytadi (+1 dona)
    UPDATE public.inventory_units
    SET status = 'available', location_id = v_dest, sold_sale_id = null, version = version + 1
    WHERE id = v_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
      1, v_line.unit_cost, 'sale_return', v_ret_id, '2-opsiya: Teng narxli tovar almashtirish (qaytarildi)', auth.uid(),
      jsonb_build_object('kind', 'equal_value_exchange', 'original_sale_no', v_sale.sale_no, 'custom_price', v_new_price)
    );

    -- B) O'rniga berilgan yangi tovar do'kon balansidan chiqadi (-1 dona)
    UPDATE public.inventory_units
    SET status = 'sold', sold_sale_id = v_sale.id, version = version + 1
    WHERE id = v_new_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_new_u.id, v_new_u.product_id, v_new_u.batch_id, 'sold', v_new_u.location_id, v_new_u.location_id,
      1, v_new_prod.cost_price, 'sale_replacement', v_ret_id, '2-opsiya: Teng narxli yangi tovar (chiqdi)', auth.uid(),
      jsonb_build_object('replaced_unit_id', v_u.id, 'original_sale_no', v_sale.sale_no, 'custom_price', v_new_price)
    );

    INSERT INTO public.sale_returns(
      id, return_no, original_sale_id, kind, status, branch_id, customer_id, reason, refund_amount, requested_by, completed_at
    ) VALUES (
      v_ret_id, v_ret_no, v_sale.id, 'exchange', 'completed', p_branch_id, v_sale.customer_id,
      '2-opsiya almashtirish (teng narx): ' || v_new_prod.name || ' (Farq: 0 so‘m)',
      0, auth.uid(), now()
    );

    INSERT INTO public.sale_return_lines(
      return_id, sale_line_id, unit_id, quantity, condition, refund_amount
    ) VALUES (
      v_ret_id, v_line.id, v_u.id, 1, 'resellable', 0
    );

    RETURN jsonb_build_object(
      'success', true,
      'difference', 0,
      'is_paid', true,
      'new_price', v_new_price,
      'returned_price', v_returned_price,
      'message', 'Tovar teng qiymatli boshqa tovarga muvaffaqiyatli almashtirildi (farq: 0 so‘m). Qoldiq yangilandi.'
    );
  END IF;

  -- 2) ARZONROQ TOVAR ALINGANDA (farq < 0, masalan qaytarilgan: 600 000, yangi: 400 000, qoldiq: 200 000 so'm):
  IF v_new_price < v_returned_price THEN
    v_refund_diff := v_returned_price - v_new_price;

    -- A) Qaytarilgan tovar birligini do'konga qaytarish (+1 dona)
    UPDATE public.inventory_units
    SET status = 'available', location_id = v_dest, sold_sale_id = null, version = version + 1
    WHERE id = v_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
      1, v_line.unit_cost, 'sale_return', v_ret_id, '2-opsiya: Arzonroq tovarga almashtirildi (qaytarildi)', auth.uid(),
      jsonb_build_object('kind', 'cheaper_exchange', 'original_sale_no', v_sale.sale_no, 'new_unit_id', v_new_u.id, 'custom_price', v_new_price)
    );

    -- B) Yangi tanlangan tovar birligini sotilgan deb belgilash (-1 dona)
    UPDATE public.inventory_units
    SET status = 'sold', sold_sale_id = v_sale.id, version = version + 1
    WHERE id = v_new_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_new_u.id, v_new_u.product_id, v_new_u.batch_id, 'sold', v_new_u.location_id, v_new_u.location_id,
      1, v_new_prod.cost_price, 'sale_replacement', v_ret_id, '2-opsiya: Arzonroq yangi tovar (chiqdi)', auth.uid(),
      jsonb_build_object('replaced_unit_id', v_u.id, 'original_sale_no', v_sale.sale_no, 'custom_price', v_new_price)
    );

    -- C) To'lov usuli (cash yoki card)
    IF lower(btrim(coalesce(p_refund_method, 'cash'))) IN ('card', 'terminal', 'plastik') THEN
      v_pay_method := 'card';
      v_pay_label := 'Plastik karta';
    ELSE
      v_pay_method := 'cash';
      v_pay_label := 'Naqd pul';
    END IF;

    -- D) Kassadan qaytarilgan qoldiq pulni bugungi chiqim (harajat) ro'yxatiga yozish
    INSERT INTO public.expenses(
      branch_id, category, title, amount, paid_amount, currency, period_month, paid_at, note, payment_method, created_by, created_at, updated_at
    ) VALUES (
      p_branch_id,
      'other',
      'Tovar almashtirish (qoldiq qaytarildi - ' || v_pay_label || ')',
      v_refund_diff,
      v_refund_diff,
      'UZS',
      to_char((now() AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM'),
      now(),
      'Mijoz ' || v_u.qr_code || ' (' || to_char(v_returned_price, 'FM999,999,999') || ' so‘m) ni arzonroq ' || v_new_prod.name || ' (' || to_char(v_new_price, 'FM999,999,999') || ' so‘m) ga almashtirdi. Qolgan ' || to_char(v_refund_diff, 'FM999,999,999') || ' so‘m kassadan qaytarildi (' || v_pay_label || '). ' || coalesce(p_reason, ''),
      v_pay_method,
      auth.uid(),
      now(),
      now()
    );

    -- E) Qaytarish tarixiga yakunlangan deb yozish
    INSERT INTO public.sale_returns(
      id, return_no, original_sale_id, kind, status, branch_id, customer_id, reason, refund_amount, requested_by, completed_at
    ) VALUES (
      v_ret_id, v_ret_no, v_sale.id, 'exchange', 'completed', p_branch_id, v_sale.customer_id,
      '2-opsiya almashtirish (arzonroq): ' || v_new_prod.name || ' (Qaytarildi: ' || to_char(v_refund_diff, 'FM999,999,999') || ' so‘m, ' || v_pay_label || ')',
      v_refund_diff, auth.uid(), now()
    );

    INSERT INTO public.sale_return_lines(
      return_id, sale_line_id, unit_id, quantity, condition, refund_amount
    ) VALUES (
      v_ret_id, v_line.id, v_u.id, 1, 'resellable', v_refund_diff
    );

    RETURN jsonb_build_object(
      'success', true,
      'difference', -v_refund_diff,
      'refund_amount', v_refund_diff,
      'refund_method', v_pay_label,
      'is_refund', true,
      'returned_price', v_returned_price,
      'new_price', v_new_price,
      'message', 'Tovar muvaffaqiyatli almashtirildi! Qoldiq ' || to_char(v_refund_diff, 'FM999,999,999') || ' so‘m mijozga qaytarildi va bugungi kassa chiqimi (xarajati) sifatida yozildi.'
    );
  END IF;

  -- 3) NARXI QIMMATROQ BO'LSA (farq > 0): Chek kassaga yo'naltiriladi
  v_pending_no := 'POS-EX-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(v_pending_id::text, 1, 6));

  -- A) Qaytarilgan tovar birligini do'kon balansiga qaytarish (+1 dona erkin zaxiraga kiradi!)
  UPDATE public.inventory_units
  SET status = 'available', location_id = v_dest, sold_sale_id = null, version = version + 1
  WHERE id = v_u.id;

  INSERT INTO public.inventory_movements(
    unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
  ) VALUES (
    v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
    1, v_line.unit_cost, 'sale_return', v_ret_id, '2-opsiya: Qimmatroq tovarga almashtirildi (eski tovar do‘konga qaytarildi)', auth.uid(),
    jsonb_build_object('kind', 'upgrade_exchange', 'original_sale_no', v_sale.sale_no, 'new_unit_id', v_new_u.id, 'pending_sale_id', v_pending_id, 'custom_price', v_new_price)
  );

  -- B) Yangi tanlangan tovarni rezerv qilish (kassa to'lovi amalga oshgach, manager_confirm_sale orqali avtomatik sold bo'ladi)
  UPDATE public.inventory_units
  SET status = 'reserved',
      reserved_until = now() + interval '30 minutes',
      version = version + 1
  WHERE id = v_new_u.id;

  INSERT INTO public.pos_pending_sales(
    id, pending_no, branch_id, seller_id, customer_id, subtotal, discount, tax, total,
    status, expires_at, created_at, updated_at
  ) VALUES (
    v_pending_id, v_pending_no, p_branch_id, auth.uid(), v_sale.customer_id,
    v_new_price, v_returned_price, 0, v_diff,
    'pending', now() + interval '30 minutes', now(), now()
  ) RETURNING * INTO v_pending_row;

  INSERT INTO public.pos_pending_sale_lines(
    pending_sale_id, unit_id, product_id, unit_price, discount, tax_rate, line_total, unit_cost
  ) VALUES (
    v_pending_id, v_new_u.id, v_new_prod.id, v_new_price, v_returned_price, 0, v_diff, v_new_prod.cost_price
  );

  INSERT INTO public.sale_returns(
    id, return_no, original_sale_id, kind, status, branch_id, customer_id, reason, refund_amount, requested_by, completed_at
  ) VALUES (
    v_ret_id, v_ret_no, v_sale.id, 'exchange', 'completed', p_branch_id, v_sale.customer_id,
    '2-opsiya almashtirish: Yangi tovar ' || v_new_prod.name || ' (Chek farqi: ' || to_char(v_diff, 'FM999,999,999') || ' so‘m)',
    0, auth.uid(), now()
  );

  INSERT INTO public.sale_return_lines(
    return_id, sale_line_id, unit_id, quantity, condition, refund_amount
  ) VALUES (
    v_ret_id, v_line.id, v_u.id, 1, 'resellable', 0
  );

  RETURN jsonb_build_object(
    'success', true,
    'pending_sale_id', v_pending_id,
    'pending_no', v_pending_no,
    'returned_price', v_returned_price,
    'new_price', v_new_price,
    'difference', v_diff,
    'is_refund', false,
    'message', 'Eski tovar do‘kon balansiga qaytarildi. Yangi tovar uchun ' || to_char(v_diff, 'FM999,999,999') || ' so‘m farq cheki kassaga yo‘naltirildi.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_pos_exchange_upgrade(uuid, uuid, uuid, text, text, numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_pos_exchange_upgrade(uuid, uuid, uuid, text, text, numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';

COMMIT;
